import { createServer, type Server } from 'node:http';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Link, parseSseStream } from '#/tui/controllers/forum-link/link';
import type { DownlinkOp } from '#/tui/controllers/forum-link/link';
import type {
  Descriptor,
  OpIntent,
  ReceiptReport,
  TimelineEntry,
  UplinkFrame,
} from '@moonshot-ai/forum-link';

const TEST_TIMING = {
  heartbeatTimeoutMs: 5_000,
  backoffBaseMs: 10,
  backoffCapMs: 40,
  batchIntervalMs: 5,
};

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
  at: number;
}

interface RecordedBatch {
  frames: UplinkFrame[];
  startedAt: number;
  endedAt: number;
}

type QueueResponse =
  | { status: number; body?: unknown }
  | { networkError: true }
  | { delayMs: number; status: number; body?: unknown };

class FakeHub {
  readonly requests: RecordedRequest[] = [];
  readonly batches: RecordedBatch[] = [];
  readonly registerSnapshots: unknown[] = [];
  readonly unregisterBodies: unknown[] = [];
  readonly receiptBodies: unknown[] = [];
  private server: Server | undefined;
  private readonly handlers = new Map<string, QueueResponse[]>();
  private readonly streamControllers = new Set<{
    write: (chunk: string) => void;
    close: () => void;
  }>();
  private workerSeq = 0;
  private streamOpens = 0;

  get url(): string {
    const address = this.server?.address();
    if (address === undefined || address === null || typeof address === 'string') {
      throw new Error('hub not listening');
    }
    return `http://127.0.0.1:${address.port}`;
  }

  get openStreams(): number {
    return this.streamControllers.size;
  }

  get totalStreamOpens(): number {
    return this.streamOpens;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', resolve);
    });
  }

  async close(): Promise<void> {
    for (const controller of this.streamControllers) controller.close();
    this.streamControllers.clear();
    await new Promise<void>((resolve) => {
      this.server!.close(() => {
        resolve();
      });
      this.server!.closeAllConnections?.();
    });
  }

  queueResponse(path: string, response: QueueResponse): void {
    const list = this.handlers.get(path) ?? [];
    list.push(response);
    this.handlers.set(path, list);
  }

  nextResponseFor(path: string): QueueResponse {
    const list = this.handlers.get(path);
    if (list === undefined || list.length === 0) return { status: 200 };
    if (list.length === 1) return list[0]!;
    return list.shift()!;
  }

  clearResponses(): void {
    this.handlers.clear();
  }

  pushToStreams(text: string): void {
    for (const controller of this.streamControllers) controller.write(`${text}\n\n`);
  }

  closeStreams(): void {
    for (const controller of this.streamControllers) controller.close();
    this.streamControllers.clear();
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const body = await readBody(req);
    this.requests.push({ method: req.method ?? '', path, body, at: this.requests.length });
    if (req.method === 'GET' && path === '/api/worker/stream') {
      this.openWorkerStream(res);
      return;
    }
    if (req.method === 'POST' && path === '/api/worker/register') {
      this.registerSnapshots.push(body);
    }
    if (req.method === 'POST' && path === '/api/worker/batch') {
      const frames = (body as { frames?: UplinkFrame[] }).frames ?? [];
      const batch: RecordedBatch = {
        frames,
        startedAt: this.batches.length,
        endedAt: -1,
      };
      this.batches.push(batch);
      const response = this.nextResponseFor(path);
      if ('delayMs' in response) {
        setTimeout(() => {
          batch.endedAt = this.batches.length;
          sendJson(res, response.status, response.body);
        }, response.delayMs);
        return;
      }
      batch.endedAt = this.batches.length;
      this.respond(res, path, response);
      return;
    }
    if (req.method === 'POST' && path === '/api/worker/receipt') {
      this.receiptBodies.push(body);
    }
    if (req.method === 'POST' && path === '/api/worker/unregister') {
      this.unregisterBodies.push(body);
    }
    this.respond(res, path, this.nextResponseFor(path));
  }

  private respond(res: import('node:http').ServerResponse, path: string, response: QueueResponse): void {
    if ('networkError' in response) {
      res.destroy();
      return;
    }
    sendJson(res, response.status, response.body);
  }

  private openWorkerStream(res: import('node:http').ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': connected\n\n');
    const controller = {
      write: (chunk: string) => res.write(chunk),
      close: () => res.destroy(),
    };
    this.streamControllers.add(controller);
    this.streamOpens += 1;
    res.on('close', () => {
      this.streamControllers.delete(controller);
    });
  }

  freshWorkerId(): string {
    this.workerSeq += 1;
    return `w${this.workerSeq}`;
  }
}

function sendJson(res: import('node:http').ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function makeDescriptor(sessionId: string): Descriptor {
  return {
    sessionId,
    machine: { tokenName: 't', hostname: 'h' },
    project: 'p',
    title: 'title',
    kind: 'interactive',
    capabilities: ['send'],
  };
}

function makeSnapshot(sessionIds: string[], workerId: string) {
  return {
    workerId,
    threads: sessionIds.map((sessionId) => ({
      descriptor: makeDescriptor(sessionId),
      overview: makeOverview(1),
      timeline: [] as TimelineEntry[],
      openCards: [],
    })),
  };
}

function makeOverview(rev: number) {
  return {
    rev,
    phase: 'idle',
    isCompacting: false,
    model: 'm',
    thinkingEffort: 'low',
    permissionMode: 'default',
    planMode: false,
    contextUsage: 0,
    goal: null,
    todos: [],
    subagents: [],
    backgroundTasks: [],
    models: [],
    lastLine: '',
    sampledAt: 0,
  };
}

function timelineFrame(sessionId: string, seq: number): UplinkFrame {
  return {
    sessionId,
    kind: 'timeline',
    entries: [{ seq, at: 0, kind: 'status', phase: 'running' }],
  };
}

function overviewFrame(sessionId: string, rev: number): UplinkFrame {
  return { sessionId, kind: 'overview', overview: makeOverview(rev) };
}

async function waitFor(condition: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const closedHubs: FakeHub[] = [];

afterAll(async () => {
  for (const hub of closedHubs) await hub.close();
});

let activeHub: FakeHub = new FakeHub();

beforeEach(async () => {
  activeHub = new FakeHub();
  await activeHub.start();
  closedHubs.push(activeHub);
});

afterEach(async () => {
  await activeHub.close();
});

function makeLink(overrides: Partial<ConstructorParameters<typeof Link>[0]> = {}) {
  const workerId = activeHub.freshWorkerId();
  const ops: DownlinkOp[] = [];
  const fatalMessages: string[] = [];
  const states: string[] = [];
  let sessionIds = ['s1'];
  const link = new Link({
    url: activeHub.url,
    token: 'token',
    getSnapshot: () => makeSnapshot(sessionIds, workerId),
    onOp: (op) => ops.push(op),
    onFatal: (message) => fatalMessages.push(message),
    onStateChange: (state) => states.push(state),
    timing: TEST_TIMING,
    ...overrides,
  });
  return {
    link,
    ops,
    fatalMessages,
    states,
    setSessionIds: (ids: string[]) => {
      sessionIds = ids;
    },
    get workerId() {
      return workerId;
    },
  };
}

async function startAndWaitForPublished(
  harness: ReturnType<typeof makeLink>,
): Promise<void> {
  harness.link.start();
  await waitFor(() => harness.link.state === 'published');
}

describe('link worker session workflow', () => {

  it('reaches published, registers with a snapshot, and opens the stream', async () => {
    const harness = makeLink();
    await startAndWaitForPublished(harness);
    expect(activeHub.registerSnapshots.length).toBeGreaterThanOrEqual(1);
    const snapshot = activeHub.registerSnapshots[0] as { workerId: string; recentReceipts: unknown[] };
    expect(snapshot.workerId).toBe(harness.workerId);
    expect(snapshot.recentReceipts).toEqual([]);
    expect(activeHub.openStreams).toBe(1);
    await harness.link.stop();
    expect(harness.link.state).toBe('detached');
    expect(activeHub.unregisterBodies.length).toBe(1);
  });

  it('delivers sse op events to onOp', async () => {
    const harness = makeLink();
    await startAndWaitForPublished(harness);
    const intent: OpIntent = { type: 'send', sessionId: 's1', text: 'hello' };
    activeHub.pushToStreams(
      `event: op\ndata: ${JSON.stringify({ opId: 'op1', sessionId: 's1', intent })}`,
    );
    await waitFor(() => harness.ops.length === 1);
    expect(harness.ops[0]).toEqual({ opId: 'op1', sessionId: 's1', intent });
    await harness.link.stop();
  });

  it('M1-A1: at most one batch in flight even while enqueueing rapidly', async () => {
    const harness = makeLink();
    activeHub.queueResponse('/api/worker/batch', { delayMs: 60, status: 200 });
    await startAndWaitForPublished(harness);
    for (let i = 0; i < 10; i += 1) harness.link.enqueue(timelineFrame('s1', i + 1));
    await waitFor(() => activeHub.batches.length > 0);
    for (let i = 0; i < 10; i += 1) harness.link.enqueue(timelineFrame('s1', i + 100));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const overlapping = activeHub.batches.filter((batch) => batch.endedAt === -1);
    expect(overlapping.length).toBeLessThanOrEqual(1);
    const concurrent = activeHub.batches.filter((batch) => batch.endedAt === -1).length;
    expect(concurrent).toBeLessThanOrEqual(1);
    await waitFor(() => activeHub.batches.every((batch) => batch.endedAt !== -1));
    await harness.link.stop();
  });

  it('M1-A2: after a failed batch the next request is register and the snapshot covers the failed frames', async () => {
    const harness = makeLink();
    await startAndWaitForPublished(harness);
    activeHub.queueResponse('/api/worker/batch', { networkError: true });
    harness.link.enqueue(timelineFrame('s1', 1));
    harness.link.enqueue(timelineFrame('s1', 2));
    await waitFor(() => activeHub.batches.length === 1);
    await waitFor(() => harness.link.state === 'backoff');
    const registerCount = () =>
      activeHub.requests.filter((r) => r.path === '/api/worker/register').length;
    const registerCountBefore = registerCount();
    await waitFor(() => registerCount() > registerCountBefore);
    const failedBatchIndex = activeHub.requests.findIndex(
      (request, index) =>
        request.path === '/api/worker/batch' &&
        activeHub.requests
          .slice(index + 1)
          .some((later) => later.path === '/api/worker/register'),
    );
    expect(failedBatchIndex).toBeGreaterThanOrEqual(0);
    const nextRequest = activeHub.requests[failedBatchIndex + 1]!;
    expect(nextRequest.path).toBe('/api/worker/register');
    const snapshot = nextRequest.body as {
      threads: { timeline: TimelineEntry[] }[];
    };
    const seqs = snapshot.threads[0]!.timeline.map((entry) => entry.seq);
    expect(seqs).toEqual(expect.arrayContaining([1, 2]));
    await waitFor(() => harness.link.state === 'published');
    await harness.link.stop();
  });

  it('M1-A3: after 401 no further requests are made and state is detached with onFatal', async () => {
    const harness = makeLink();
    await startAndWaitForPublished(harness);
    activeHub.queueResponse('/api/worker/batch', { status: 401 });
    harness.link.enqueue(timelineFrame('s1', 1));
    await waitFor(() => harness.fatalMessages.length === 1);
    expect(harness.link.state).toBe('detached');
    const requestCount = activeHub.requests.length;
    harness.link.enqueue(timelineFrame('s1', 2));
    harness.link.reportReceipt({ opId: 'opX', state: 'delivered' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(activeHub.requests.length).toBe(requestCount);
    await harness.link.stop();
    expect(activeHub.requests.length).toBe(requestCount);
  });

  it('M1-A5: receipts recorded during re-registration appear in the next register snapshot exactly once', async () => {
    const harness = makeLink();
    await startAndWaitForPublished(harness);
    activeHub.queueResponse('/api/worker/batch', { networkError: true });
    harness.link.enqueue(timelineFrame('s1', 1));
    await waitFor(() => activeHub.batches.length === 1);
    await waitFor(() => harness.link.state === 'backoff');
    harness.link.reportReceipt({ opId: 'opA', state: 'applied' });
    await waitFor(() => harness.link.state === 'published');
    await waitFor(() => {
      const receiptPosts = activeHub.receiptBodies as { receipts: ReceiptReport[] }[];
      return receiptPosts.some((body) => body.receipts.some((r) => r.opId === 'opA'));
    });
    const registers = activeHub.registerSnapshots as { recentReceipts: ReceiptReport[] }[];
    const withReceipt = registers.filter((snap) =>
      snap.recentReceipts.some((r) => r.opId === 'opA'),
    );
    expect(withReceipt.length).toBeGreaterThanOrEqual(1);
    const receiptPosts = activeHub.receiptBodies as { receipts: ReceiptReport[] }[];
    const opAPosts = receiptPosts.filter((body) =>
      body.receipts.some((r) => r.opId === 'opA'),
    );
    expect(opAPosts.length).toBeGreaterThanOrEqual(1);
    const totalOpAOccurrences = opAPosts.reduce(
      (count, body) => count + body.receipts.filter((r) => r.opId === 'opA').length,
      0,
    );
    expect(totalOpAOccurrences).toBe(1);
    await harness.link.stop();
  });

  it('M1-A5: unsent receipts recorded before stop appear in unregister finalReceipts', async () => {
    const harness = makeLink();
    await startAndWaitForPublished(harness);
    activeHub.queueResponse('/api/worker/receipt', { status: 500 });
    harness.link.reportReceipt({ opId: 'opB', state: 'delivered' });
    await waitFor(() => activeHub.receiptBodies.length === 1);
    await harness.link.stop();
    expect(activeHub.unregisterBodies.length).toBe(1);
    const body = activeHub.unregisterBodies[0] as { finalReceipts: ReceiptReport[] };
    expect(body.finalReceipts).toEqual([{ opId: 'opB', state: 'delivered' }]);
  });

  it('session switch resyncs straight back to connecting without backoff', async () => {
    const harness = makeLink();
    await startAndWaitForPublished(harness);
    const statesBefore = [...harness.states];
    harness.setSessionIds(['s2']);
    harness.link.resync();
    expect(harness.link.state).toBe('connecting');
    await waitFor(() => harness.link.state === 'published');
    expect(harness.states.slice(statesBefore.length)).toContain('connecting');
    expect(harness.states.slice(statesBefore.length)).not.toContain('backoff');
    const lastRegister = activeHub.registerSnapshots.at(-1) as {
      threads: { descriptor: Descriptor }[];
    };
    expect(lastRegister.threads.map((t) => t.descriptor.sessionId)).toEqual(['s2']);
    await harness.link.stop();
  });

  it('heartbeat silence timeout treats the downlink as broken and reconnects', async () => {
    const harness = makeLink({ timing: { ...TEST_TIMING, heartbeatTimeoutMs: 50 } });
    await startAndWaitForPublished(harness);
    expect(activeHub.totalStreamOpens).toBe(1);
    activeHub.closeStreams();
    await waitFor(() => activeHub.totalStreamOpens === 2, 2500);
    expect(harness.link.state).toBe('published');
    await harness.link.stop();
  });

  it('silence without any bytes also reconnects via the timeout window', async () => {
    const harness = makeLink({ timing: { ...TEST_TIMING, heartbeatTimeoutMs: 60 } });
    await startAndWaitForPublished(harness);
    const registersBefore = activeHub.requests.filter((r) => r.path === '/api/worker/register').length;
    await waitFor(
      () =>
        activeHub.requests.filter((r) => r.path === '/api/worker/register').length >
        registersBefore,
      2500,
    );
    expect(harness.link.state).toBe('published');
    await harness.link.stop();
  });

  it('409 on batch triggers re-registration without backoff state lingering', async () => {
    const harness = makeLink();
    await startAndWaitForPublished(harness);
    activeHub.queueResponse('/api/worker/batch', { status: 409, body: { error: 'resync-required' } });
    harness.link.enqueue(timelineFrame('s1', 1));
    await waitFor(() => activeHub.batches.length === 1);
    await waitFor(() => harness.link.state === 'connecting');
    await waitFor(() => harness.link.state === 'published');
    const snapshot = activeHub.registerSnapshots.at(-1) as {
      threads: { timeline: TimelineEntry[] }[];
    };
    expect(
      snapshot.threads[0]!.timeline.map((entry) => entry.seq),
    ).toEqual(expect.arrayContaining([1]));
    await harness.link.stop();
  });

  it('queued overview frames for the same session collapse to the last one', async () => {
    const harness = makeLink();
    await startAndWaitForPublished(harness);
    for (let rev = 1; rev <= 5; rev += 1) harness.link.enqueue(overviewFrame('s1', rev));
    await waitFor(() => activeHub.batches.length > 0);
    const batch = activeHub.batches[0]!;
    const overviews = batch.frames.filter((frame) => frame.kind === 'overview');
    expect(overviews).toEqual([overviewFrame('s1', 5)]);
    await harness.link.stop();
  });

  it('stop while connecting still unregisters and detaches', async () => {
    const harness = makeLink();
    harness.link.start();
    await harness.link.stop();
    expect(harness.link.state).toBe('detached');
    expect(activeHub.unregisterBodies.length).toBe(1);
  });

  it('M1-A4: injected timing keeps every case well under 1s of waits', () => {
    expect(TEST_TIMING.backoffBaseMs).toBeLessThan(100);
    expect(TEST_TIMING.batchIntervalMs).toBeLessThan(50);
    expect(TEST_TIMING.heartbeatTimeoutMs).toBeLessThan(10_000);
  });
});

describe('parseSseStream', () => {
  it('decodes frames and reports comments as liveness', async () => {
    const encoder = new TextEncoder();
    const comments: number[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': ping\n\n'));
        controller.enqueue(encoder.encode('event: op\ndata: {"a":1}\n\n'));
        controller.close();
      },
    });
    const messages = [];
    for await (const message of parseSseStream(stream, () => {
      comments.push(1);
    })) {
      messages.push(message);
    }
    expect(messages).toEqual([{ event: 'op', data: '{"a":1}' }]);
    expect(comments).toHaveLength(1);
  });
});
