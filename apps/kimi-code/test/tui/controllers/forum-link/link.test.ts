import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { ActionFrame, Descriptor, Entry, UplinkFrame } from '@moonshot-ai/forum-link';

import { Link, parseSseStream, type LinkState, type SseMessage } from '#/tui/controllers/forum-link/link';

const DESCRIPTOR: Descriptor = {
  sessionId: 'session-1',
  machineName: 'machine',
  projectName: 'project',
  title: 'title',
  status: 'idle',
};

function messageEntry(text: string): Entry {
  return { kind: 'message', role: 'assistant', text };
}

function entryFrame(text: string): UplinkFrame {
  return { type: 'entry', entry: messageEntry(text) };
}

function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function textStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return byteStream(chunks.map((chunk) => encoder.encode(chunk)));
}

async function collect(stream: ReadableStream<Uint8Array>, onComment?: () => void): Promise<SseMessage[]> {
  const messages: SseMessage[] = [];
  for await (const message of parseSseStream(stream, onComment)) messages.push(message);
  return messages;
}

async function until(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('parseSseStream', () => {
  it('splits frames across chunk boundaries', async () => {
    const messages = await collect(textStream(['data: {"a":1}\n\nda', 'ta: {"b":2}\n\n']));
    expect(messages).toEqual([{ data: '{"a":1}' }, { data: '{"b":2}' }]);
  });

  it('joins multi-line data fields with newlines', async () => {
    const messages = await collect(textStream(['data: line1\ndata: line2\n\n']));
    expect(messages).toEqual([{ data: 'line1\nline2' }]);
  });

  it('drops comment frames but notifies onComment', async () => {
    let comments = 0;
    const messages = await collect(textStream([': heartbeat\n\n']), () => {
      comments += 1;
    });
    expect(messages).toEqual([]);
    expect(comments).toBe(1);
  });

  it('accepts crlf line endings including across chunks', async () => {
    const whole = await collect(textStream(['data: x\r\n\r\n']));
    expect(whole).toEqual([{ data: 'x' }]);
    const split = await collect(textStream(['data: y\r', '\n\r\n']));
    expect(split).toEqual([{ data: 'y' }]);
  });

  it('captures the event field and strips one optional space after the colon', async () => {
    const messages = await collect(textStream(['event: action\ndata: {"x":1}\n\ndata:tight\n\n']));
    expect(messages).toEqual([{ event: 'action', data: '{"x":1}' }, { data: 'tight' }]);
  });

  it('decodes multibyte characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('data: café\n\n');
    const cut = bytes.indexOf(0xc3) + 1;
    const messages = await collect(byteStream([bytes.slice(0, cut), bytes.slice(cut)]));
    expect(messages).toEqual([{ data: 'café' }]);
  });
});

type RegisterStep = { kind: 'ok'; id: string } | { kind: 'status'; status: number } | { kind: 'destroy' };

interface StubHub {
  baseUrl: string;
  readonly registerBodies: string[];
  readonly entryBodies: string[];
  readonly entryTargets: string[];
  readonly sseOpened: number;
  readonly sseClosed: number;
  readonly heartbeatCount: number;
  setRegisterPlan(plan: RegisterStep[], exhausted?: RegisterStep): void;
  writeSse(chunk: string): void;
  destroySse(): void;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

async function startStubHub(): Promise<StubHub> {
  const registerBodies: string[] = [];
  const entryBodies: string[] = [];
  const entryTargets: string[] = [];
  let heartbeatCount = 0;
  let sseOpened = 0;
  let sseClosed = 0;
  let plan: RegisterStep[] = [];
  let exhausted: RegisterStep = { kind: 'destroy' };
  const sseResponses = new Set<ServerResponse>();
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://stub.local');
    if (req.method === 'POST' && url.pathname === '/api/register') {
      registerBodies.push(await readBody(req));
      const step = plan.shift() ?? exhausted;
      if (step.kind === 'destroy') {
        res.socket?.destroy();
        return;
      }
      if (step.kind === 'status') {
        res.writeHead(step.status, { 'content-type': 'application/json' });
        res.end('{"error":"stub"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: step.id }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/entry') {
      entryBodies.push(await readBody(req));
      entryTargets.push(url.searchParams.get('target') ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ seq: entryBodies.length }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/heartbeat') {
      await readBody(req);
      heartbeatCount += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    const streamMatch = /^\/api\/stream\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && streamMatch !== null) {
      sseOpened += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.flushHeaders();
      sseResponses.add(res);
      res.on('close', () => {
        sseResponses.delete(res);
        sseClosed += 1;
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  };
  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => res.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub has no address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    registerBodies,
    entryBodies,
    entryTargets,
    get sseOpened() {
      return sseOpened;
    },
    get sseClosed() {
      return sseClosed;
    },
    get heartbeatCount() {
      return heartbeatCount;
    },
    setRegisterPlan(next, fallback) {
      plan = next;
      exhausted = fallback ?? { kind: 'destroy' };
    },
    writeSse(chunk) {
      for (const res of sseResponses) res.write(chunk);
    },
    destroySse() {
      for (const res of sseResponses) res.socket?.destroy();
    },
    close() {
      server.closeAllConnections();
      return new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

describe('Link over a stub hub', () => {
  const activeLinks: Link[] = [];
  const activeStubs: StubHub[] = [];

  afterEach(async () => {
    for (const link of activeLinks.splice(0)) link.close('test teardown');
    for (const stub of activeStubs.splice(0)) await stub.close();
  });

  function recordTransitions(): { states: LinkState[]; times: number[]; onStateChange: (state: LinkState) => void } {
    const states: LinkState[] = [];
    const times: number[] = [];
    return {
      states,
      times,
      onStateChange: (state) => {
        states.push(state);
        times.push(Date.now());
      },
    };
  }

  it('retries register with exponential backoff, resets the attempt after success, and republishes under a new thread id', async () => {
    const stub = await startStubHub();
    activeStubs.push(stub);
    stub.setRegisterPlan([
      { kind: 'destroy' },
      { kind: 'destroy' },
      { kind: 'destroy' },
      { kind: 'ok', id: 't-9' },
      { kind: 'ok', id: 't-10' },
    ]);
    const transitions = recordTransitions();
    const link = new Link({
      timing: { backoffBaseMs: 20, backoffCapMs: 400, heartbeatIntervalMs: 5000, heartbeatTimeoutMs: 5000 },
      onStateChange: transitions.onStateChange,
    });
    activeLinks.push(link);
    await link.connect({ url: stub.baseUrl, password: 'pw' }, DESCRIPTOR);
    expect(link.state).toBe('published');
    expect(link.threadId).toBe('t-9');
    link.send(entryFrame('first'));
    await until(() => stub.entryBodies.length === 1);
    expect(stub.entryTargets[0]).toBe('t-9');
    stub.destroySse();
    await until(() => link.state === 'published' && link.threadId === 't-10');
    link.send(entryFrame('second'));
    await until(() => stub.entryBodies.length === 2);
    expect(stub.entryTargets[1]).toBe('t-10');
    expect(stub.registerBodies.every((body) => body === JSON.stringify(DESCRIPTOR))).toBe(true);
    const gaps: number[] = [];
    for (let i = 1; i < transitions.states.length; i++) {
      if (transitions.states[i] === 'connecting' && transitions.states[i - 1] === 'backoff') {
        gaps.push(transitions.times[i]! - transitions.times[i - 1]!);
      }
    }
    expect(gaps).toHaveLength(4);
    expect(gaps[0]).toBeGreaterThanOrEqual(15);
    expect(gaps[0]).toBeLessThanOrEqual(60);
    expect(gaps[1]).toBeGreaterThanOrEqual(30);
    expect(gaps[1]).toBeLessThanOrEqual(95);
    expect(gaps[2]).toBeGreaterThanOrEqual(60);
    expect(gaps[2]).toBeLessThanOrEqual(180);
    expect(gaps[3]).toBeGreaterThanOrEqual(15);
    expect(gaps[3]).toBeLessThanOrEqual(60);
  });

  it('treats a 401 register response as fatal and stops retrying', async () => {
    const stub = await startStubHub();
    activeStubs.push(stub);
    stub.setRegisterPlan([{ kind: 'status', status: 401 }]);
    const transitions = recordTransitions();
    const link = new Link({
      timing: { backoffBaseMs: 20, backoffCapMs: 100, heartbeatIntervalMs: 5000, heartbeatTimeoutMs: 5000 },
      onStateChange: transitions.onStateChange,
    });
    activeLinks.push(link);
    await expect(link.connect({ url: stub.baseUrl, password: 'wrong' }, DESCRIPTOR)).rejects.toThrow('unauthorized');
    expect(link.state).toBe('detached');
    expect(transitions.states).toEqual(['connecting', 'detached']);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(stub.registerBodies).toHaveLength(1);
    expect(stub.sseOpened).toBe(0);
  });

  it('drops send frames while backing off and settles a pending connect on close', async () => {
    const stub = await startStubHub();
    activeStubs.push(stub);
    stub.setRegisterPlan([{ kind: 'destroy' }], { kind: 'destroy' });
    const link = new Link({
      timing: { backoffBaseMs: 20, backoffCapMs: 50, heartbeatIntervalMs: 5000, heartbeatTimeoutMs: 5000 },
    });
    activeLinks.push(link);
    const connectPromise = link.connect({ url: stub.baseUrl, password: 'pw' }, DESCRIPTOR);
    await until(() => link.state === 'backoff');
    link.send(entryFrame('dropped-1'));
    link.send(entryFrame('dropped-2'));
    link.send(entryFrame('dropped-3'));
    expect(stub.entryBodies).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(stub.entryBodies).toHaveLength(0);
    link.close('user request');
    await expect(connectPromise).rejects.toThrow('user request');
    expect(link.state).toBe('detached');
    expect(link.threadId).toBeUndefined();
  });

  it('keeps memory flat across a long backoff: 50 dropped frames, then only the fresh frame after republish', async () => {
    const stub = await startStubHub();
    activeStubs.push(stub);
    stub.setRegisterPlan([{ kind: 'destroy' }], { kind: 'ok', id: 't-after-backoff' });
    const link = new Link({
      timing: { backoffBaseMs: 200, backoffCapMs: 400, heartbeatIntervalMs: 5000, heartbeatTimeoutMs: 5000 },
    });
    activeLinks.push(link);
    const connectPromise = link.connect({ url: stub.baseUrl, password: 'pw' }, DESCRIPTOR);
    await until(() => link.state === 'backoff');
    for (let i = 0; i < 50; i += 1) {
      link.send(entryFrame(`during-backoff-${i}`));
    }
    expect(stub.entryBodies).toHaveLength(0);
    await connectPromise;
    expect(link.state).toBe('published');
    link.send(entryFrame('after-backoff'));
    await until(() => stub.entryBodies.length === 1);
    expect(stub.entryBodies).toHaveLength(1);
    expect(JSON.parse(stub.entryBodies[0]!).entry.text).toBe('after-backoff');
    expect(stub.entryBodies.some((body) => body.includes('during-backoff'))).toBe(false);
  });

  it('declares the link lost when the sse stream stays silent past the timeout', async () => {
    const stub = await startStubHub();
    activeStubs.push(stub);
    stub.setRegisterPlan([{ kind: 'ok', id: 't-quiet' }]);
    const transitions = recordTransitions();
    const link = new Link({
      timing: { backoffBaseMs: 20, backoffCapMs: 100, heartbeatIntervalMs: 30, heartbeatTimeoutMs: 100 },
      now: () => Date.now(),
      onStateChange: transitions.onStateChange,
    });
    activeLinks.push(link);
    await link.connect({ url: stub.baseUrl, password: 'pw' }, DESCRIPTOR);
    const publishedAt = transitions.times[transitions.states.indexOf('published')]!;
    await until(() => link.state === 'backoff', 500);
    const backoffAt = transitions.times[transitions.states.indexOf('backoff')]!;
    const elapsed = backoffAt - publishedAt;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThanOrEqual(300);
    await until(() => stub.sseClosed >= 1, 500);
    expect(stub.heartbeatCount).toBeGreaterThanOrEqual(1);
  });

  it('dispatches validated downlink action frames and silently drops everything else', async () => {
    const stub = await startStubHub();
    activeStubs.push(stub);
    stub.setRegisterPlan([{ kind: 'ok', id: 't-act' }]);
    const actions: ActionFrame[] = [];
    const link = new Link({
      timing: { backoffBaseMs: 20, backoffCapMs: 100, heartbeatIntervalMs: 5000, heartbeatTimeoutMs: 2000 },
      onAction: (frame) => actions.push(frame),
    });
    activeLinks.push(link);
    await link.connect({ url: stub.baseUrl, password: 'pw' }, DESCRIPTOR);
    stub.writeSse('data: {"action":{"type":"pause","target":"t1"}}\n\n');
    await until(() => actions.length === 1);
    expect(actions[0]).toEqual({ type: 'pause', target: 't1' });
    stub.writeSse('data: {"action":{"type":"bogus"}}\n\n');
    stub.writeSse('data: {"seq":1,"entry":{"kind":"message","role":"user","text":"x"}}\n\n');
    stub.writeSse('data: not-json\n\n');
    stub.writeSse('data: {"reset":true}\n\n');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(actions).toHaveLength(1);
    expect(link.state).toBe('published');
  });

  it('closes idempotently, aborting the sse stream and stopping the heartbeat timer', async () => {
    const stub = await startStubHub();
    activeStubs.push(stub);
    stub.setRegisterPlan([{ kind: 'ok', id: 't-close' }]);
    const link = new Link({
      timing: { backoffBaseMs: 20, backoffCapMs: 100, heartbeatIntervalMs: 30, heartbeatTimeoutMs: 5000 },
    });
    activeLinks.push(link);
    await link.connect({ url: stub.baseUrl, password: 'pw' }, DESCRIPTOR);
    await until(() => stub.heartbeatCount >= 2);
    expect(stub.sseOpened).toBe(1);
    link.close('user request');
    expect(link.state).toBe('detached');
    expect(link.threadId).toBeUndefined();
    await until(() => stub.sseClosed === 1);
    const beats = stub.heartbeatCount;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(stub.heartbeatCount).toBe(beats);
    expect(stub.registerBodies).toHaveLength(1);
    link.close('again');
    link.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stub.sseClosed).toBe(1);
  });
});

const HUB_MJS = fileURLToPath(new URL('../../../../../../packages/forum-link/dist/hub.mjs', import.meta.url));
const LINK_SOURCE = fileURLToPath(new URL('../../../../src/tui/controllers/forum-link/link.ts', import.meta.url));

describe('Link source shape', () => {
  it('keeps send a fire-and-forget with no frame buffering', () => {
    const code = readFileSync(LINK_SOURCE, 'utf8');
    const send = code.slice(code.indexOf('  send(frame: UplinkFrame): void {'), code.indexOf('  close('));
    expect(send).toMatch(/^  send\(frame: UplinkFrame\): void \{\n    const threadId = this\.currentThreadId;\n    const credential = this\.credential;\n    if \(this\.currentState !== 'published' \|\| threadId === undefined \|\| credential === undefined\) return;\n    void this\.postJson\(/);
    expect(send).not.toMatch(/\.push\(|\.unshift\(|queue/i);
  });
});

describe('Link against a real hub process', () => {
  it.skipIf(!existsSync(HUB_MJS))('publishes, uplinks entries, and receives downlink actions', async () => {
    const child = spawn(
      process.execPath,
      [HUB_MJS, '--port', '0', '--password', 'secret', '--heartbeat-interval-ms', '200'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      output += chunk;
    });
    const deadline = Date.now() + 5000;
    let baseUrl = '';
    for (;;) {
      const match = /listening on http:\/\/(\S+):(\d+)/.exec(output);
      if (match !== null) {
        baseUrl = `http://127.0.0.1:${match[2]}`;
        break;
      }
      if (child.exitCode !== null || Date.now() > deadline) {
        child.kill();
        throw new Error(`hub process failed to start: ${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const actions: ActionFrame[] = [];
    const link = new Link({
      timing: { backoffBaseMs: 50, backoffCapMs: 200, heartbeatIntervalMs: 500, heartbeatTimeoutMs: 5000 },
      onAction: (frame) => actions.push(frame),
    });
    try {
      await link.connect({ url: baseUrl, password: 'secret' }, DESCRIPTOR);
      expect(link.state).toBe('published');
      expect(typeof link.threadId).toBe('string');
      const threadId = link.threadId!;
      link.send(entryFrame('from link'));
      const headers = { Authorization: 'Bearer secret' };
      let sawEntry = false;
      for (let i = 0; i < 50 && !sawEntry; i++) {
        const res = await fetch(`${baseUrl}/api/threads/${threadId}/snapshot`, { headers });
        if (res.status === 200) {
          const body = (await res.json()) as { entries: { entry: Entry }[] };
          sawEntry = body.entries.some(
            (snapshotEntry) =>
              snapshotEntry.entry.kind === 'message' && snapshotEntry.entry.text === 'from link',
          );
        }
        if (!sawEntry) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(sawEntry).toBe(true);
      const actionRes = await fetch(`${baseUrl}/api/action`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'pause', target: threadId }),
      });
      expect(actionRes.status).toBe(200);
      await until(() => actions.length === 1, 2000);
      expect(actions[0]).toEqual({ type: 'pause', target: threadId });
    } finally {
      link.close('test teardown');
      child.kill();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => {
          resolve();
        });
        setTimeout(resolve, 3000);
      });
    }
  }, 15000);
});
