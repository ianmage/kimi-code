import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ModelAlias, Session } from '@moonshot-ai/kimi-code-sdk';
import { BROWSER_COOKIE_NAME, type ReceiptReport, type UplinkFrame } from '@moonshot-ai/forum-link';

import type { AppState } from '#/tui/types';
import { DEFAULT_NOTIFICATIONS_CONFIG, DEFAULT_UPGRADE_PREFERENCES } from '#/tui/config';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { ForumLinkController } from '#/tui/controllers/forum-link';
import { ApprovalController } from '#/tui/reverse-rpc/approval/controller';
import { QuestionController } from '#/tui/reverse-rpc/question/controller';
import type { ApprovalPanelData, DiffDisplayBlock, QuestionPanelData } from '#/tui/reverse-rpc/types';

const TEST_TIMING = {
  heartbeatTimeoutMs: 5_000,
  backoffBaseMs: 10,
  backoffCapMs: 40,
  batchIntervalMs: 5,
};

const APPROVAL_CHOICES: ApprovalPanelData['choices'] = [
  { label: 'Approve once', response: 'approved' },
  { label: 'Approve for this session', response: 'approved_for_session' },
  { label: 'Reject', response: 'rejected' },
];

function approvalData(id: string, overrides: Partial<ApprovalPanelData> = {}): ApprovalPanelData {
  return {
    id,
    tool_call_id: id,
    tool_name: 'Bash',
    action: 'run a command',
    description: '',
    display: [],
    choices: APPROVAL_CHOICES,
    ...overrides,
  };
}

function planReviewData(id: string): ApprovalPanelData {
  const diff: DiffDisplayBlock = {
    type: 'diff',
    path: 'src/a.ts',
    old_text: 'line1\nline2',
    new_text: 'line1\nline2 changed',
  } as unknown as DiffDisplayBlock;
  return approvalData(id, {
    tool_name: 'ExitPlanMode',
    action: 'review plan',
    display: [diff],
  });
}

function questionData(id: string): QuestionPanelData {
  return {
    id,
    tool_call_id: id,
    questions: [{ question: 'Pick one?', multi_select: false, options: [{ label: 'A' }, { label: 'B' }] }],
  };
}

function makeSession(id: string): Session {
  return { id, onEvent: () => () => {} } as never as Session;
}

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

class PublishFakeHub {
  readonly requests: RecordedRequest[] = [];
  readonly registerSnapshots: unknown[] = [];
  readonly unregisterBodies: unknown[] = [];
  readonly receiptBodies: unknown[] = [];
  readonly batches: { frames: UplinkFrame[] }[] = [];
  private server: Server | undefined;
  private readonly streamControllers = new Set<{ write: (chunk: string) => void; close: () => void }>();

  get url(): string {
    const address = this.server?.address();
    if (address === undefined || address === null || typeof address === 'string') {
      throw new Error('hub not listening');
    }
    return `http://127.0.0.1:${address.port}`;
  }

  get registerCount(): number {
    return this.requests.filter((request) => request.path === '/api/worker/register').length;
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

  pushOp(opId: string, sessionId: string, intent: unknown): void {
    const payload = `event: op\ndata: ${JSON.stringify({ opId, sessionId, intent })}`;
    for (const controller of this.streamControllers) controller.write(`${payload}\n\n`);
  }

  timelineEntries(): { seq: number; kind: string; [key: string]: unknown }[] {
    const entries: { seq: number; kind: string; [key: string]: unknown }[] = [];
    for (const batch of this.batches) {
      for (const frame of batch.frames) {
        if (frame.kind !== 'timeline') continue;
        entries.push(...(frame.entries as never as { seq: number; kind: string }[]));
      }
    }
    return entries;
  }

  private async handle(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const body = await readBody(req);
    this.requests.push({ method: req.method ?? '', path, body });
    if (req.method === 'GET' && path === '/api/worker/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': connected\n\n');
      const controller = {
        write: (chunk: string) => res.write(chunk),
        close: () => res.destroy(),
      };
      this.streamControllers.add(controller);
      res.on('close', () => {
        this.streamControllers.delete(controller);
      });
      return;
    }
    if (req.method === 'POST' && path === '/api/worker/register') {
      this.registerSnapshots.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ workerId: 'w1', threads: [] }));
      return;
    }
    if (req.method === 'POST' && path === '/api/worker/batch') {
      this.batches.push(body as { frames: UplinkFrame[] });
    }
    if (req.method === 'POST' && path === '/api/worker/receipt') {
      this.receiptBodies.push(body);
    }
    if (req.method === 'POST' && path === '/api/worker/unregister') {
      this.unregisterBodies.push(body);
    }
    res.writeHead(204);
    res.end();
  }
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

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface PublishFixture {
  controller: ForumLinkController;
  approvalController: ApprovalController;
  questionController: ApprovalController extends never ? never : QuestionController;
  showApproval(payload: ApprovalPanelData): void;
  hideApproval(): void;
  showQuestion(payload: QuestionPanelData): void;
  hideQuestion(): void;
  planContent: string | null;
}

function makeCapturingSession(id: string): { session: Session; fireIdle(): void } {
  const listeners: ((event: { type: string }) => void)[] = [];
  return {
    session: {
      id,
      onEvent: (handler: (event: { type: string }) => void) => {
        listeners.push(handler);
        return () => {};
      },
      cancel: async () => {},
      cancelCompaction: async () => {},
    } as never as Session,
    fireIdle: () => {
      for (const listener of listeners) listener({ type: 'turn.ended' });
    },
  };
}

interface MakeControllerOptions {
  appState?: Partial<AppState>;
  endSessionTiming?: { idleWaitTimeoutMs?: number };
  createNewSession?: () => Promise<void>;
}

function makeController(options: MakeControllerOptions = {}): PublishFixture {
  const approvalController = new ApprovalController();
  const questionController = new QuestionController();
  let planContent: string | null = '# The plan\n\n1. Do the thing.';
  const controller = new ForumLinkController({
    host: {
      appState: () =>
        ({
          streamingPhase: 'idle',
          isCompacting: false,
          model: 'k2',
          thinkingEffort: 'high',
          permissionMode: 'auto',
          planMode: false,
          contextUsage: 0,
          goal: null,
          availableModels: {},
          ...options.appState,
        }) as never,
      approvalController,
      questionController,
      sendNormalUserInput: async () => {},
      createNewSession: async () => {
        await options.createNewSession?.();
      },
      showStatus: () => {},
      steerMessage: () => {},
      slashHost: {} as never,
      getTodos: () => [],
      getPlan: async () =>
        planContent === null ? null : { id: 'p1', content: planContent, path: 'plan.md' },
      cancelForeground: () => {},
      session: () => undefined,
      workDir: () => '/tmp/proj',
      sessionTitle: () => null,
    },
    linkTiming: TEST_TIMING,
    overviewIntervalMs: 20,
    endSessionTiming: options.endSessionTiming,
  });
  let approvalId: string | undefined;
  let questionId: string | undefined;
  return {
    controller,
    approvalController,
    questionController,
    get planContent() {
      return planContent;
    },
    set planContent(value: string | null) {
      planContent = value;
    },
    showApproval: (payload) => {
      approvalId = payload.id;
      controller.onCardOpened('approval', payload.id, payload);
    },
    hideApproval: () => {
      const id = approvalId;
      approvalId = undefined;
      if (id !== undefined) controller.onCardClosed('approval', id);
    },
    showQuestion: (payload) => {
      questionId = payload.id;
      controller.onCardOpened('question', payload.id, payload);
    },
    hideQuestion: () => {
      const id = questionId;
      questionId = undefined;
      if (id !== undefined) controller.onCardClosed('question', id);
    },
  };
}

describe('layer4 publish full chain (real controller + fake hub)', () => {
  it('publish → thread appears → card opens with extras → local answer → card-settled uplink', async () => {
    const hub = new PublishFakeHub();
    await hub.start();
    try {
      const fixture = makeController();
      fixture.controller.onSessionChanged(makeSession('s1'));
      const started = await fixture.controller.start({ url: hub.url, token: 't' });
      expect(started.ok).toBe(true);
      await waitFor(() => fixture.controller.state === 'published');
      expect(hub.registerSnapshots).toHaveLength(1);

      const shown = fixture.approvalController.show(planReviewData('plan-1'));
      fixture.showApproval(planReviewData('plan-1'));
      const cardId = fixture.controller.openCards[0]!.cardId;
      expect(cardId.startsWith('approval_')).toBe(true);

      await waitFor(() =>
        hub.registerSnapshots.some((snapshot) =>
          (snapshot as { threads?: { openCards?: { cardId: string }[]; timeline?: { kind: string }[] }[] })
            .threads?.some(
              (thread) =>
                thread.openCards?.some((card) => card.cardId === cardId) === true ||
                thread.timeline?.some((entry) => entry.kind === 'card-opened') === true,
            ),
        ),
      );

      await waitFor(() => {
        const snapshot = fixture.controller.getSnapshot();
        const card = snapshot.threads[0]!.openCards.find((open) => open.cardId === cardId);
        const blocks = (card?.['approval'] as { display?: unknown[] } | undefined)?.display ?? [];
        return blocks.some((block) => (block as { type?: string })?.type === 'plan_body');
      });
      const snapshot = fixture.controller.getSnapshot();
      const openedCard = snapshot.threads[0]!.openCards.find((card) => card.cardId === cardId);
      expect(openedCard).toBeDefined();
      const approval = openedCard!['approval'] as { display?: unknown[] } | undefined;
      const display = approval?.display ?? [];
      const planBlock = display.find(
        (block) => (block as { type?: string })?.type === 'plan_body',
      ) as { text: string } | undefined;
      expect(planBlock?.text).toContain('# The plan');
      const diffBlock = display.find(
        (block) => (block as { type?: string })?.type === 'diff',
      ) as { lines?: unknown[] } | undefined;
      expect(Array.isArray(diffBlock?.lines)).toBe(true);
      expect((diffBlock?.lines ?? []).length).toBeGreaterThan(0);

      fixture.approvalController.respond({ decision: 'approved' });
      await expect(shown).resolves.toEqual({ decision: 'approved' });
      fixture.hideApproval();

      await waitFor(() =>
        hub.registerSnapshots.some((snapshot) =>
          (snapshot as { threads?: { timeline?: { kind: string; cardId?: string }[] }[] })
            .threads?.some((thread) =>
              thread.timeline?.some(
                (entry) => entry.kind === 'card-settled' && entry.cardId === cardId,
              ),
            ),
        ),
      );
      const finalSnapshot = fixture.controller.getSnapshot();
      expect(finalSnapshot.threads[0]!.openCards).toEqual([]);
      await fixture.controller.stop();
      expect(hub.unregisterBodies).toHaveLength(1);
    } finally {
      await hub.close();
    }
  });

  it('remote answer over the downlink resolves the local panel and reports receipts', async () => {
    const hub = new PublishFakeHub();
    await hub.start();
    try {
      const fixture = makeController();
      fixture.controller.onSessionChanged(makeSession('s1'));
      await fixture.controller.start({ url: hub.url, token: 't' });
      await waitFor(() => fixture.controller.state === 'published');

      const shown = fixture.questionController.show(questionData('q-1'));
      fixture.showQuestion(questionData('q-1'));
      const cardId = fixture.controller.openCards[0]!.cardId;
      await waitFor(() => fixture.controller.getSnapshot().threads[0]!.openCards.length === 1);
      await waitFor(() => fixture.controller.state === 'published');

      hub.pushOp('op1', 's1', {
        type: 'answer',
        sessionId: 's1',
        cardId,
        answers: [{ selected: [0] }],
      });

      await expect(shown).resolves.toEqual({ answers: ['A'], method: 'enter' });
      await waitFor(() => {
        const posts = hub.receiptBodies as { receipts: ReceiptReport[] }[];
        return posts.some((body) =>
          body.receipts.some((report) => report.opId === 'op1' && report.state === 'applied'),
        );
      });
      await fixture.controller.stop();
    } finally {
      await hub.close();
    }
  });

  it('remote end-session (immediate) ends the session, keeps the link published, and reports applied', async () => {
    const hub = new PublishFakeHub();
    await hub.start();
    try {
      const order: string[] = [];
      const first = makeCapturingSession('s1');
      const second = makeCapturingSession('s2');
      const fixture = makeController({
        createNewSession: async () => {
          order.push('createNewSession');
          fixture.controller.onSessionChanged(second.session);
        },
      });
      fixture.controller.onSessionChanged(first.session);
      await fixture.controller.start({ url: hub.url, token: 't' });
      await waitFor(() => fixture.controller.state === 'published');
      const link = (fixture.controller as unknown as { link?: { reportReceipt(report: ReceiptReport): void } })
        .link!;
      const originalReport = link.reportReceipt;
      link.reportReceipt = (report) => {
        if (report.opId === 'opEnd' && report.state === 'applied') order.push('receipt-applied');
        originalReport.call(link, report);
      };

      const registerCountBefore = hub.registerSnapshots.length;
      hub.pushOp('opEnd', 's1', { type: 'end-session', sessionId: 's1' });

      await waitFor(() => order.includes('createNewSession'));
      expect(order).toEqual(['receipt-applied', 'createNewSession']);
      await waitFor(() => {
        const posts = hub.receiptBodies as { receipts: ReceiptReport[] }[];
        return posts.some((body) =>
          body.receipts.some((report) => report.opId === 'opEnd' && report.state === 'applied'),
        );
      });
      await waitFor(() => hub.registerSnapshots.length > registerCountBefore);
      expect(hub.registerSnapshots.length).toBeGreaterThan(registerCountBefore);
      const lastRegister = hub.registerSnapshots.at(-1) as {
        threads: { descriptor: { sessionId: string } }[];
        recentReceipts: ReceiptReport[];
      };
      expect(lastRegister.threads.map((thread) => thread.descriptor.sessionId)).toEqual(['s2']);
      expect(lastRegister.recentReceipts).toContainEqual({ opId: 'opEnd', state: 'applied' });
      expect(fixture.controller.session?.id).toBe('s2');
      expect(hub.unregisterBodies).toHaveLength(0);
      await waitFor(() => fixture.controller.state === 'published');
      await fixture.controller.stop();
      expect(hub.unregisterBodies).toHaveLength(1);
    } finally {
      await hub.close();
    }
  });

  it('remote end-session (turn mode) waits for the idle event before creating the new session', async () => {
    const hub = new PublishFakeHub();
    await hub.start();
    try {
      const order: string[] = [];
      const first = makeCapturingSession('s1');
      const second = makeCapturingSession('s2');
      const fixture = makeController({
        appState: { streamingPhase: 'thinking' },
        createNewSession: async () => {
          order.push('createNewSession');
          fixture.controller.onSessionChanged(second.session);
        },
      });
      fixture.controller.onSessionChanged(first.session);
      await fixture.controller.start({ url: hub.url, token: 't' });
      await waitFor(() => fixture.controller.state === 'published');
      const link = (fixture.controller as unknown as { link?: { reportReceipt(report: ReceiptReport): void } })
        .link!;
      const originalReport = link.reportReceipt;
      link.reportReceipt = (report) => {
        if (report.opId === 'opEnd' && report.state === 'applied') order.push('receipt-applied');
        originalReport.call(link, report);
      };

      hub.pushOp('opEnd', 's1', { type: 'end-session', sessionId: 's1' });
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(order).toEqual(['receipt-applied']);

      first.fireIdle();

      await waitFor(() => order.includes('createNewSession'));
      expect(order).toEqual(['receipt-applied', 'createNewSession']);
      await waitFor(() => {
        const posts = hub.receiptBodies as { receipts: ReceiptReport[] }[];
        return posts.some((body) =>
          body.receipts.some((report) => report.opId === 'opEnd' && report.state === 'applied'),
        );
      });
      expect(fixture.controller.session?.id).toBe('s2');
      expect(hub.unregisterBodies).toHaveLength(0);
      await waitFor(() => fixture.controller.state === 'published');
      await fixture.controller.stop();
      expect(hub.unregisterBodies).toHaveLength(1);
    } finally {
      await hub.close();
    }
  });

  it('remote end-session timeout keeps the link attached without creating a new session', async () => {
    const hub = new PublishFakeHub();
    await hub.start();
    try {
      const order: string[] = [];
      const first = makeCapturingSession('s1');
      const fixture = makeController({
        appState: { streamingPhase: 'thinking' },
        endSessionTiming: { idleWaitTimeoutMs: 50 },
        createNewSession: async () => {
          order.push('createNewSession');
        },
      });
      fixture.controller.onSessionChanged(first.session);
      await fixture.controller.start({ url: hub.url, token: 't' });
      await waitFor(() => fixture.controller.state === 'published');

      hub.pushOp('opEnd', 's1', { type: 'end-session', sessionId: 's1' });

      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
      expect(order).toEqual([]);
      expect(fixture.controller.state).not.toBe('detached');
      await waitFor(() => fixture.controller.state === 'published');
      await waitFor(() => {
        const posts = hub.receiptBodies as { receipts: ReceiptReport[] }[];
        return posts.some((body) =>
          body.receipts.some((report) => report.opId === 'opEnd' && report.state === 'applied'),
        );
      });
      expect(hub.unregisterBodies).toHaveLength(0);
      await fixture.controller.stop();
    } finally {
      await hub.close();
    }
  });

  it('start/stop lifecycle keeps the detached invariant without a hub', async () => {
    const controller = new ForumLinkController({});
    controller.onSessionChanged(makeSession('s1'));
    const started = await controller.start({ url: 'http://127.0.0.1:1', token: 't' });
    expect(started.ok).toBe(true);
    await controller.stop();
    expect(controller.state).toBe('detached');
  });
});

const HUB_MJS = fileURLToPath(
  new URL('../../../../../../packages/forum-link/dist/hub.mjs', import.meta.url),
);
const E2E_TIMEOUT_MS = 30_000;

let hubBuilt = false;

function ensureHubBuilt(): void {
  if (hubBuilt || existsSync(HUB_MJS)) {
    hubBuilt = true;
    return;
  }
  const result = spawnSync('pnpm', ['-F', '@moonshot-ai/forum-link', 'build'], {
    cwd: fileURLToPath(new URL('../../../../../', import.meta.url)),
    stdio: 'ignore',
    shell: true,
    timeout: 120_000,
  });
  if (result.status !== 0) throw new Error('forum-link hub build failed');
  hubBuilt = true;
}

interface SpawnedHub {
  child: ChildProcess;
  baseUrl: string;
  stop(): Promise<void>;
}

async function spawnHub(dataDir: string, extraArgs: string[] = []): Promise<SpawnedHub> {
  ensureHubBuilt();
  const child = spawn(process.execPath, [HUB_MJS, 'serve', '--data-dir', dataDir, '--port', '0', ...extraArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    output += chunk;
  });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const deadline = Date.now() + 8000;
    const poll = () => {
      const match = /listening on http:\/\/\S+:(\d+)/.exec(output);
      if (match !== null) {
        resolve(`http://127.0.0.1:${match[1]}`);
        return;
      }
      if (child.exitCode !== null || Date.now() > deadline) {
        child.kill();
        reject(new Error(`hub failed to start: ${output}`));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
  return {
    child,
    baseUrl,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      await new Promise<void>((resolve) => {
        child.once('exit', () => {
          resolve();
        });
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5000).unref?.();
      });
    },
  };
}

async function issueTokens(
  baseUrl: string,
  dataDir: string,
): Promise<{ machineSecret: string; deviceSecret: string; device2Secret: string }> {
  const adminKey = readFileSync(join(dataDir, 'admin.key'), 'utf8').trim();
  const issue = async (role: 'machine' | 'device', name: string): Promise<string> => {
    const response = await fetch(`${baseUrl}/api/admin/tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ role, name }),
    });
    if (response.status !== 200) throw new Error(`token issue failed: ${response.status}`);
    const body = (await response.json()) as { secret: string };
    return body.secret;
  };
  return {
    machineSecret: await issue('machine', 'laptop'),
    deviceSecret: await issue('device', 'phone-1'),
    device2Secret: await issue('device', 'phone-2'),
  };
}

interface SseLineStream {
  lines: string[];
  close(): void;
  closed: Promise<void>;
}

async function openBrowserStream(baseUrl: string, cookie: string): Promise<SseLineStream> {
  const response = await fetch(`${baseUrl}/api/browser/stream`, { headers: { cookie } });
  if (response.status !== 200 || response.body === null) {
    throw new Error(`browser stream failed: ${response.status}`);
  }
  const lines: string[] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let closedResolve: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        lines.push(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
    closedResolve();
  })();
  void pump.catch(() => {
    closedResolve();
  });
  return {
    lines,
    close() {
      void reader.cancel().catch(() => {});
    },
    closed,
  };
}

function streamEvents(stream: SseLineStream): { event: string; data: unknown }[] {
  const events: { event: string; data: unknown }[] = [];
  for (let i = 0; i < stream.lines.length - 1; i += 1) {
    if (!stream.lines[i]!.startsWith('event: ')) continue;
    const dataLine = stream.lines[i + 1]!;
    if (!dataLine.startsWith('data: ')) continue;
    events.push({ event: stream.lines[i]!.slice(7), data: JSON.parse(dataLine.slice(6)) as unknown });
  }
  return events;
}

class BrowserClient {
  readonly cookie: string;
  constructor(
    readonly baseUrl: string,
    deviceSecret: string,
  ) {
    this.cookie = `${BROWSER_COOKIE_NAME}=${deviceSecret}`;
  }

  get(path: string): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, { headers: { cookie: this.cookie } });
  }

  async postOps(sessionId: string, intent: Record<string, unknown>): Promise<{ opId: string; state: string; reason?: string }> {
    const response = await fetch(`${this.baseUrl}/api/browser/ops`, {
      method: 'POST',
      headers: { cookie: this.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, intent }),
    });
    if (response.status !== 202) throw new Error(`ops failed: ${response.status}`);
    return (await response.json()) as { opId: string; state: string; reason?: string };
  }

  openStream(): Promise<SseLineStream> {
    return openBrowserStream(this.baseUrl, this.cookie);
  }
}

async function waitForAsync(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

function e2eModel(): ModelAlias {
  return {
    provider: 'test',
    model: 'k2',
    maxContextSize: 200_000,
    displayName: 'k2',
    supportEfforts: ['low', 'high'],
    defaultEffort: 'high',
    capabilities: ['thinking'],
  } as unknown as ModelAlias;
}

interface E2EGoal {
  goalId: string;
  objective: string;
  status: string;
}

interface E2ESessionState {
  session: Session;
}

function makeE2ESession(id: string, goalStore: { value: E2EGoal | null }): Session {
  return {
    id,
    onEvent: () => () => {},
    getGoal: async () => ({ goal: goalStore.value }),
    createGoal: async (input: { objective: string }) => {
      goalStore.value = { goalId: `goal-${id}`, objective: input.objective, status: 'active' };
    },
    setPermission: async () => {},
    setModel: async () => {},
    setThinking: async () => {},
    pauseGoal: async () => {},
    resumeGoal: async () => {},
    cancelGoal: async () => {},
    cancel: async () => {},
    cancelCompaction: async () => {},
    steer: async () => {},
  } as never as Session;
}

interface E2EFixture {
  controller: ForumLinkController;
  approvalController: ApprovalController;
  questionController: QuestionController;
  appState: AppState;
  sent: string[];
  setStreamingPhase(phase: AppState['streamingPhase']): void;
  setGoal(goal: E2EGoal | null): void;
  showApproval(payload: ApprovalPanelData): Promise<{ decision: string; scope?: string }>;
}

function makeE2EController(): E2EFixture {
  const approvalController = new ApprovalController();
  const questionController = new QuestionController();
  const mutableGoal = { value: null as E2EGoal | null };
  const sessionState: E2ESessionState = { session: makeE2ESession('s1', mutableGoal) };
  const sent: string[] = [];
  const appState: AppState = {
    model: 'k2',
    workDir: '/workspace/proj',
    additionalDirs: [],
    thinkingEffort: 'high',
    permissionMode: 'auto',
    planMode: false,
    inputMode: 'prompt',
    swarmMode: false,
    towerMode: false,
    streamingPhase: 'idle',
    isCompacting: false,
    isReplaying: false,
    sessionId: 's1',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    cumulativeTokens: 0,
    streamingStartTime: 0,
    stepRetry: null,
    theme: 'dark',
    version: 'test',
    editorCommand: null,
    notifications: DEFAULT_NOTIFICATIONS_CONFIG,
    upgrade: DEFAULT_UPGRADE_PREFERENCES,
    sessionTitle: null,
    goal: null,
    mcpServersSummary: null,
    availableModels: { k2: e2eModel() },
    availableProviders: {},
  };
  let controller!: ForumLinkController;
  const slashHost = {
    state: {
      appState,
      editor: { getText: () => '' },
      transcriptContainer: { addChild: () => {} },
      transcriptEntries: [],
      ui: { requestRender: () => {} },
    },
    get session(): Session {
      return sessionState.session;
    },
    requireSession: () => sessionState.session,
    setAppState: (patch: Record<string, unknown>) => Object.assign(appState, patch),
    showError: () => {},
    showStatus: () => {},
    showNotice: () => {},
    mountEditorReplacement: () => {},
    restoreEditor: () => {},
    restoreInputText: () => {},
    sendNormalUserInput: (text: string) => {
      sent.push(text);
    },
    waitForLazyCreation: async () => {},
    track: () => {},
    harness: {
      getConfig: async () => ({}),
      setConfig: async () => {},
    },
    authFlow: {
      activateModelAfterLogin: async () => {},
      refreshOAuthProviderModels: async () => undefined,
    },
  } as unknown as SlashCommandHost;
  let nextSessionNumber = 2;
  controller = new ForumLinkController({
    host: {
      appState: () => appState,
      approvalController,
      questionController,
      sendNormalUserInput: async (text) => {
        sent.push(text);
      },
      createNewSession: async () => {
        sessionState.session = makeE2ESession(`s${nextSessionNumber}`, mutableGoal);
        nextSessionNumber += 1;
        controller.onSessionChanged(sessionState.session);
      },
      showStatus: () => {},
      steerMessage: () => {},
      slashHost,
      getTodos: () => [],
      getPlan: async () => null,
      cancelForeground: () => {},
      session: () => sessionState.session,
      workDir: () => '/workspace/proj',
      sessionTitle: () => null,
    },
    linkTiming: TEST_TIMING,
    overviewIntervalMs: 30,
  });
  controller.onSessionChanged(sessionState.session);
  let approvalShownId: string | undefined;
  let questionShownId: string | undefined;
  approvalController.setUIHooks({
    showPanel: (payload) => {
      if (approvalShownId !== undefined && approvalShownId !== payload.id) {
        controller.onCardClosed('approval', approvalShownId);
      }
      approvalShownId = payload.id;
      controller.onCardOpened('approval', payload.id, payload);
    },
    hidePanel: () => {
      const id = approvalShownId;
      approvalShownId = undefined;
      if (id !== undefined) controller.onCardClosed('approval', id);
    },
  });
  questionController.setUIHooks({
    showPanel: (payload) => {
      if (questionShownId !== undefined && questionShownId !== payload.id) {
        controller.onCardClosed('question', questionShownId);
      }
      questionShownId = payload.id;
      controller.onCardOpened('question', payload.id, payload);
    },
    hidePanel: () => {
      const id = questionShownId;
      questionShownId = undefined;
      if (id !== undefined) controller.onCardClosed('question', id);
    },
  });
  return {
    controller,
    approvalController,
    questionController,
    appState,
    sent,
    setStreamingPhase: (phase) => {
      appState.streamingPhase = phase;
    },
    setGoal: (goal) => {
      mutableGoal.value = goal;
      appState.goal = goal as never;
      controller.onAppStateChanged();
    },
    showApproval: (payload) => approvalController.show(payload),
  };
}

function shellApprovalData(id: string, action: string): ApprovalPanelData {
  const diff: DiffDisplayBlock = {
    type: 'diff',
    path: 'src/a.ts',
    old_text: 'line1\nline2',
    new_text: 'line1\nline2 changed',
  } as unknown as DiffDisplayBlock;
  return {
    id,
    tool_call_id: id,
    tool_name: 'Bash',
    action,
    description: '',
    display: [
      { type: 'shell', language: 'bash', command: 'rm -rf build && echo done', cwd: '/workspace/proj' },
      diff,
    ],
    choices: APPROVAL_CHOICES,
  };
}

interface ThreadView {
  descriptor: { sessionId: string };
  online: boolean;
  timeline: { seq: number; kind: string; cardId?: string }[];
  openCards: { cardId: string; kind: string; approval?: { display?: { type?: string; command?: string; lines?: unknown[] }[] } }[];
  receipts: { opId: string; state: string; reason?: string }[];
}

async function readThread(client: BrowserClient, sessionId: string): Promise<ThreadView | undefined> {
  const response = await client.get(`/api/browser/threads/${sessionId}`);
  if (response.status !== 200) return undefined;
  return (await response.json()) as ThreadView;
}

describe('layer4 E2E (spawned hub + real controller + browser clients)', () => {
  it(
    'G-A1: session-scoped remote approval carries full payload and auto-resolves the queued request',
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'forum-link-e2e-a1-'));
      const hub = await spawnHub(dataDir);
      try {
        const tokens = await issueTokens(hub.baseUrl, dataDir);
        const fixture = makeE2EController();
        await fixture.controller.start({ url: hub.baseUrl, token: tokens.machineSecret });
        await waitFor(() => fixture.controller.state === 'published');
        const client = new BrowserClient(hub.baseUrl, tokens.deviceSecret);
        const stream = await client.openStream();

        const payload = shellApprovalData('a-1', 'run a command');
        const first = fixture.approvalController.show(payload);
        const second = fixture.approvalController.show(shellApprovalData('a-2', 'run a command'));

        await waitForAsync(async () => {
          const thread = await readThread(client, 's1');
          return thread?.openCards.length === 1;
        }, 'card payload visible on the hub');
        const thread = (await readThread(client, 's1'))!;
        const card = thread.openCards[0]!;
        const display = card.approval?.display ?? [];
        const shell = display.find((block) => block.type === 'shell');
        expect(shell?.command).toBe('rm -rf build && echo done');
        const diff = display.find((block) => block.type === 'diff');
        expect(Array.isArray(diff?.lines)).toBe(true);
        expect((diff?.lines ?? []).length).toBeGreaterThan(0);

        const receipt = await client.postOps('s1', {
          type: 'approve',
          sessionId: 's1',
          cardId: card.cardId,
          optionIndex: 1,
        });
        expect(receipt.state).toBe('accepted');

        await expect(first).resolves.toEqual({ decision: 'approved', scope: 'session' });
        await expect(second).resolves.toEqual({ decision: 'approved', scope: 'session' });

        await waitForAsync(async () => {
          const view = await readThread(client, 's1');
          return view?.receipts.some((entry) => entry.opId === receipt.opId && entry.state === "applied") === true;
        }, 'applied receipt on the thread');
        await waitForAsync(
          () => streamEvents(stream).some((event) => event.event === 'card.settled'),
          'card.settled fanout',
        );
        await waitForAsync(async () => {
          const view = await readThread(client, 's1');
          return view !== undefined && view.openCards.length === 0;
        }, 'no remote card remains after the queue auto-resolve');
        stream.close();
        await fixture.controller.stop();
      } finally {
        await hub.stop();
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'G-A3: card settlement syncs to both clients and closed cards reject further ops',
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'forum-link-e2e-a3-'));
      const hub = await spawnHub(dataDir);
      try {
        const tokens = await issueTokens(hub.baseUrl, dataDir);
        const fixture = makeE2EController();
        await fixture.controller.start({ url: hub.baseUrl, token: tokens.machineSecret });
        await waitFor(() => fixture.controller.state === 'published');
        const client1 = new BrowserClient(hub.baseUrl, tokens.deviceSecret);
        const client2 = new BrowserClient(hub.baseUrl, tokens.device2Secret);
        const stream1 = await client1.openStream();
        const stream2 = await client2.openStream();

        const shownLocal = fixture.showApproval(shellApprovalData('local-1', 'run a command'));
        await waitForAsync(async () => {
          const thread = await readThread(client1, 's1');
          return thread?.openCards.length === 1;
        }, 'local card visible');
        const localCardId = (await readThread(client1, 's1'))!.openCards[0]!.cardId;

        fixture.approvalController.respond({ decision: 'approved' });
        await expect(shownLocal).resolves.toEqual({ decision: 'approved' });
        await waitForAsync(
          () => streamEvents(stream1).some((event) => event.event === 'card.settled'),
          'client1 card.settled after local answer',
        );
        await waitForAsync(
          () => streamEvents(stream2).some((event) => event.event === 'card.settled'),
          'client2 card.settled after local answer',
        );

        const shownRemote = fixture.showApproval(shellApprovalData('remote-1', 'run a command'));
        await waitForAsync(async () => {
          const thread = await readThread(client1, 's1');
          return thread?.openCards.some((card) => card.cardId !== localCardId) === true;
        }, 'remote card visible');
        const remoteCardId = (await readThread(client1, 's1'))!.openCards.find(
          (card) => card.cardId !== localCardId,
        )!.cardId;

        await client1.postOps('s1', {
          type: 'approve',
          sessionId: 's1',
          cardId: remoteCardId,
          optionIndex: 0,
        });
        await expect(shownRemote).resolves.toEqual({ decision: 'approved' });
        await waitForAsync(async () => {
          const thread = await readThread(client1, 's1');
          return thread !== undefined && thread.openCards.length === 0;
        }, 'local panel closed after remote answer');
        await waitForAsync(
          () => streamEvents(stream2).some((event) => event.event === 'card.settled'),
          'client2 card.settled after remote answer',
        );

        const stale = await client2.postOps('s1', {
          type: 'approve',
          sessionId: 's1',
          cardId: remoteCardId,
          optionIndex: 0,
        });
        await waitForAsync(async () => {
          const thread = await readThread(client1, 's1');
          return (
            thread?.receipts.some(
              (entry) => entry.opId === stale.opId && entry.state === 'rejected' && entry.reason === 'card-closed',
            ) === true
          );
        }, 'stale op rejected as card-closed');

        stream1.close();
        stream2.close();
        await fixture.controller.stop();
      } finally {
        await hub.stop();
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'V3-A1: worker-driven timeline entries fan out to the browser stream as timeline.append',
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'forum-link-e2e-v3a1-'));
      const hub = await spawnHub(dataDir);
      try {
        const tokens = await issueTokens(hub.baseUrl, dataDir);
        const fixture = makeE2EController();
        await fixture.controller.start({ url: hub.baseUrl, token: tokens.machineSecret });
        await waitFor(() => fixture.controller.state === 'published');
        const client = new BrowserClient(hub.baseUrl, tokens.deviceSecret);
        const stream = await client.openStream();
        await waitForAsync(async () => {
          const thread = await readThread(client, 's1');
          return thread?.descriptor.sessionId === 's1';
        }, 'initial thread visible');

        fixture.controller.onTranscriptEntry({
          id: 'u1',
          kind: 'user',
          renderMode: 'plain',
          content: 'timeline via batch frames',
        });
        fixture.controller.onSessionEvent({
          type: 'turn.started',
          turnId: 1,
          origin: { kind: 'user' },
          agentId: 'main',
          sessionId: 's1',
        } as never);
        fixture.controller.onSessionEvent({
          type: 'assistant.delta',
          turnId: 1,
          delta: 'answer line',
          agentId: 'main',
          sessionId: 's1',
        } as never);
        fixture.controller.onSessionEvent({
          type: 'turn.ended',
          turnId: 1,
          reason: 'completed',
          agentId: 'main',
          sessionId: 's1',
        } as never);

        await waitForAsync(
          () =>
            streamEvents(stream).some(
              (event) =>
                event.event === 'timeline.append' &&
                (event.data as { entries?: { kind: string }[] }).entries?.some(
                  (entry) => entry.kind === 'user-message',
                ) === true,
            ),
          'timeline.append with the user message',
        );
        await waitForAsync(async () => {
          const thread = await readThread(client, 's1');
          const kinds = thread?.timeline.map((entry) => entry.kind) ?? [];
          return kinds.includes('user-message') && kinds.includes('assistant-turn');
        }, 'thread timeline carries the entries');
        const thread = await readThread(client, 's1');
        expect(thread?.timeline.map((entry) => entry.seq)).toEqual([1, 2]);
        stream.close();
        await fixture.controller.stop();
      } finally {
        await hub.stop();
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'G-A4: hub restart reconciles browser state with the TUI and ntfy is not re-notified',
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'forum-link-e2e-a4-'));
      const hubPort = await new Promise<number>((resolve) => {
        const probe = createServer();
        probe.listen(0, '127.0.0.1', () => {
          const port = (probe.address() as { port: number }).port;
          probe.close(() => {
            resolve(port);
          });
        });
      });
      const fixedPortArgs = ['--port', String(hubPort)];
      const ntfyRequests: unknown[] = [];
      const ntfyServer = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          ntfyRequests.push(req.url);
          res.writeHead(200);
          res.end();
        });
      });
      await new Promise<void>((resolve) => {
        ntfyServer.listen(0, '127.0.0.1', resolve);
      });
      const ntfyPort = (ntfyServer.address() as { port: number }).port;
      const ntfyArgs = ['--ntfy-url', `http://127.0.0.1:${ntfyPort}`, '--ntfy-topic', 'e2e-a4'];
      try {
        const hub = await spawnHub(dataDir, [...fixedPortArgs, ...ntfyArgs]);
        const tokens = await issueTokens(hub.baseUrl, dataDir);
        const fixture = makeE2EController();
        await fixture.controller.start({ url: hub.baseUrl, token: tokens.machineSecret });
        await waitFor(() => fixture.controller.state === 'published');
        const client = new BrowserClient(hub.baseUrl, tokens.deviceSecret);

        const shown = fixture.showApproval(shellApprovalData('restart-1', 'run a command'));
        await waitForAsync(async () => {
          const thread = await readThread(client, 's1');
          return thread?.openCards.length === 1;
        }, 'card visible before restart');
        const openReceipt = await client.postOps('s1', {
          type: 'send',
          sessionId: 's1',
          text: 'ping before restart',
        });
        await waitForAsync(async () => {
          const thread = await readThread(client, 's1');
          return (
            thread?.receipts.some(
              (entry) => entry.opId === openReceipt.opId && (entry.state === 'delivered' || entry.state === 'applied'),
            ) === true
          );
        }, 'receipt delivered before restart');
        await waitForAsync(() => ntfyRequests.length === 1, 'ntfy notified once');
        await waitForAsync(
          () => existsSync(join(dataDir, 'state.json')) && (() => {
            try {
              const persisted = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as {
                threads: { openCards: unknown[] }[];
                receipts: { opId: string }[];
              };
              return (
                persisted.threads.length === 1 &&
                persisted.threads[0]!.openCards.length === 1 &&
                persisted.receipts.some((entry) => entry.opId === openReceipt.opId)
              );
            } catch {
              return false;
            }
          })(),
          'state persisted before restart',
        );

        await hub.stop();
        await waitFor(() => fixture.controller.state === 'backoff' || fixture.controller.state === 'connecting', 9000);

        const revived = await spawnHub(dataDir, [...fixedPortArgs, ...ntfyArgs]);
        const revivedClient = new BrowserClient(revived.baseUrl, tokens.deviceSecret);
        try {
          await waitForAsync(async () => {
            const thread = await readThread(revivedClient, 's1');
            return thread !== undefined && !thread.online && thread.openCards.length === 1;
          }, 'thread visible offline after restart');
          const offline = (await readThread(revivedClient, 's1'))!;
          expect(offline.receipts.some((entry) => entry.opId === openReceipt.opId)).toBe(true);

          await waitFor(() => fixture.controller.state === 'published');
          await waitForAsync(async () => {
            const thread = await readThread(revivedClient, 's1');
            return thread?.online === true;
          }, 'thread back online after re-registration');

          const tuiSnapshot = fixture.controller.getSnapshot();
          const tuiThread = tuiSnapshot.threads[0]!;
          const browserThread = (await readThread(revivedClient, 's1'))!;
          expect(browserThread.openCards.map((card) => card.cardId)).toEqual(
            tuiThread.openCards.map((card) => card.cardId),
          );
          expect(browserThread.timeline.map((entry) => entry.kind)).toEqual(
            tuiThread.timeline.map((entry) => entry.kind),
          );

          fixture.approvalController.respond({ decision: 'approved' });
          await expect(shown).resolves.toEqual({ decision: 'approved' });
          await waitForAsync(async () => {
            const thread = await readThread(revivedClient, 's1');
            return thread !== undefined && thread.openCards.length === 0;
          }, 'card settled after restart');

          await new Promise((resolve) => {
            setTimeout(resolve, 300);
          });
          expect(ntfyRequests).toHaveLength(1);
          await fixture.controller.stop();
        } finally {
          await revived.stop();
        }
      } finally {
        ntfyServer.close();
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'G-A6: remote new-session and goal-set update the inbox; busy and stale-thread semantics hold',
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'forum-link-e2e-a6-'));
      const hub = await spawnHub(dataDir);
      try {
        const tokens = await issueTokens(hub.baseUrl, dataDir);
        const fixture = makeE2EController();
        await fixture.controller.start({ url: hub.baseUrl, token: tokens.machineSecret });
        await waitFor(() => fixture.controller.state === 'published');
        const client = new BrowserClient(hub.baseUrl, tokens.deviceSecret);
        const stream = await client.openStream();
        await waitForAsync(async () => {
          const thread = await readThread(client, 's1');
          return thread?.descriptor.sessionId === 's1';
        }, 'initial thread visible');

        const newSessionReceipt = await client.postOps('s1', { type: 'new-session', sessionId: 's1' });
        expect(newSessionReceipt.state).toBe('accepted');
        await waitForAsync(async () => {
          const thread = await readThread(client, 's2');
          return thread !== undefined;
        }, 'new thread appears');
        await waitForAsync(async () => {
          const thread = await readThread(client, 's1');
          return thread === undefined;
        }, 'old thread removed');
        await waitForAsync(
          () =>
            streamEvents(stream).some(
              (event) =>
                event.event === 'receipt' &&
                (event.data as { receipt?: { opId?: string; state?: string } }).receipt?.opId ===
                  newSessionReceipt.opId &&
                (event.data as { receipt?: { state?: string } }).receipt?.state === 'applied',
            ),
          'new-session receipt applied after thread removal',
        );

        const goalObjective = 'Ship the remote decision feature';
        const goalReceipt = await client.postOps('s2', {
          type: 'goal-set',
          sessionId: 's2',
          objective: goalObjective,
          replace: false,
        });
        expect(goalReceipt.state).toBe('accepted');
        await waitForAsync(async () => {
          const thread = await readThread(client, 's2');
          return thread?.receipts.some((entry) => entry.opId === goalReceipt.opId && entry.state === "applied") === true;
        }, 'goal-set applied');
        expect(fixture.sent).toContain(goalObjective);

        fixture.setGoal({ goalId: 'g1', objective: goalObjective, status: 'active' });
        await waitForAsync(async () => {
          const thread = await readThread(client, 's2');
          const overview = (thread as unknown as { overview?: { goal?: { objective: string } | null } }).overview;
          return overview?.goal?.objective === goalObjective;
        }, 'goal overview sampled to the inbox');

        fixture.setStreamingPhase('thinking');
        const busyReceipt = await client.postOps('s2', { type: 'new-session', sessionId: 's2' });
        await waitForAsync(async () => {
          const thread = await readThread(client, 's2');
          return (
            thread?.receipts.some(
              (entry) => entry.opId === busyReceipt.opId && entry.state === 'rejected' && entry.reason === 'session-busy',
            ) === true
          );
        }, 'busy new-session rejected');
        fixture.setStreamingPhase('idle');

        stream.close();
        await fixture.controller.stop();
      } finally {
        await hub.stop();
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  );
});
