import { createServer, type Server } from 'node:http';

import { describe, expect, it } from 'vitest';

import type { Session } from '@moonshot-ai/kimi-code-sdk';
import type { ReceiptReport, UplinkFrame } from '@moonshot-ai/forum-link';

import { ForumLinkController } from '#/tui/controllers/forum-link';
import { ApprovalController } from '#/tui/reverse-rpc/approval/controller';
import { QuestionController } from '#/tui/reverse-rpc/question/controller';
import type { ApprovalPanelData, QuestionPanelData } from '#/tui/reverse-rpc/types';

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

function approvalData(id: string, action = 'run a command'): ApprovalPanelData {
  return {
    id,
    tool_call_id: id,
    tool_name: 'Bash',
    action,
    description: '',
    display: [],
    choices: APPROVAL_CHOICES,
  };
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

class OrchestrationFakeHub {
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

  pushToStreams(text: string): void {
    for (const controller of this.streamControllers) controller.write(`${text}\n\n`);
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

interface OrchestrationFixture {
  controller: ForumLinkController;
  approvalController: ApprovalController;
  questionController: QuestionController;
  showApproval(payload: ApprovalPanelData): void;
  hideApproval(): void;
  showQuestion(payload: QuestionPanelData): void;
  hideQuestion(): void;
}

function makeController(): OrchestrationFixture {
  const approvalController = new ApprovalController();
  const questionController = new QuestionController();
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
        }) as never,
      approvalController,
      questionController,
      sendNormalUserInput: async () => {},
      createNewSession: async () => {},
      showStatus: () => {},
      steerMessage: () => {},
      slashHost: {} as never,
      getTodos: () => [],
      getPlan: async () => null,
      cancelForeground: () => {},
      session: () => undefined,
      workDir: () => '/tmp/proj',
      sessionTitle: () => null,
    },
    linkTiming: TEST_TIMING,
    overviewIntervalMs: 20,
  });
  const hooks = {
    showApprovalPanel: (payload: ApprovalPanelData) => {
      controller.onCardOpened('approval', payload.id, payload);
    },
    hideApprovalPanel: () => {
      controller.onCardClosed('approval', lastApprovalId());
    },
    showQuestionDialog: (payload: QuestionPanelData) => {
      controller.onCardOpened('question', payload.id, payload);
    },
    hideQuestionDialog: () => {
      controller.onCardClosed('question', lastQuestionId());
    },
  };
  let approvalId: string | undefined;
  let questionId: string | undefined;
  function lastApprovalId(): string {
    const id = approvalId;
    approvalId = undefined;
    return id ?? '';
  }
  function lastQuestionId(): string {
    const id = questionId;
    questionId = undefined;
    return id ?? '';
  }
  const originalShowApproval = hooks.showApprovalPanel;
  const originalShowQuestion = hooks.showQuestionDialog;
  return {
    controller,
    approvalController,
    questionController,
    showApproval: (payload) => {
      approvalId = payload.id;
      originalShowApproval(payload);
    },
    hideApproval: hooks.hideApprovalPanel,
    showQuestion: (payload) => {
      questionId = payload.id;
      originalShowQuestion(payload);
    },
    hideQuestion: hooks.hideQuestionDialog,
  };
}

describe('controller orchestration', () => {
  it('start reports no-session before any session is wired', async () => {
    const controller = new ForumLinkController({});
    const result = await controller.start({ url: 'http://127.0.0.1:8787', token: 't' });
    expect(result).toEqual({ ok: false, reason: 'no-session' });
  });

  it('start reports already-active when not detached', async () => {
    const controller = new ForumLinkController({});
    controller.onSessionChanged(makeSession('s1'));
    await controller.start({ url: 'http://127.0.0.1:1', token: 't' });
    const again = await controller.start({ url: 'http://127.0.0.1:1', token: 't' });
    expect(again).toEqual({ ok: false, reason: 'already-active' });
    await controller.stop();
  });

  it('publishes over a fake hub, registers once, and unregisters on stop', async () => {
    const hub = new OrchestrationFakeHub();
    await hub.start();
    try {
      const fixture = makeController();
      fixture.controller.onSessionChanged(makeSession('s1'));
      const started = await fixture.controller.start({ url: hub.url, token: 't' });
      expect(started.ok).toBe(true);
      await waitFor(() => fixture.controller.state === 'published');
      expect(hub.registerSnapshots).toHaveLength(1);
      const snapshot = hub.registerSnapshots[0] as {
        workerId: string;
        threads: { descriptor: { sessionId: string; kind: string } }[];
      };
      expect(snapshot.threads).toHaveLength(1);
      expect(snapshot.threads[0]!.descriptor.sessionId).toBe('s1');
      expect(snapshot.threads[0]!.descriptor.kind).toBe('interactive');

      await fixture.controller.stop();
      expect(fixture.controller.state).toBe('detached');
      expect(hub.unregisterBodies).toHaveLength(1);
    } finally {
      await hub.close();
    }
  });

  it('M4-A3: session switch triggers exactly one re-registration with only the new session', async () => {
    const hub = new OrchestrationFakeHub();
    await hub.start();
    try {
      const fixture = makeController();
      fixture.controller.onSessionChanged(makeSession('s1'));
      await fixture.controller.start({ url: hub.url, token: 't' });
      await waitFor(() => fixture.controller.state === 'published');
      const registersBefore = hub.registerCount;

      fixture.controller.onSessionChanged(makeSession('s2'));

      await waitFor(() => hub.registerCount === registersBefore + 1);
      await waitFor(() => fixture.controller.state === 'published');
      expect(hub.registerCount).toBe(registersBefore + 1);
      const lastRegister = hub.registerSnapshots.at(-1) as {
        threads: { descriptor: { sessionId: string } }[];
      };
      expect(lastRegister.threads.map((thread) => thread.descriptor.sessionId)).toEqual(['s2']);
      await fixture.controller.stop();
    } finally {
      await hub.close();
    }
  });

  it('M4-A2: local answer uplinks a card-settled entry the hub receives as a batch frame', async () => {
    const hub = new OrchestrationFakeHub();
    await hub.start();
    try {
      const fixture = makeController();
      fixture.controller.onSessionChanged(makeSession('s1'));
      await fixture.controller.start({ url: hub.url, token: 't' });
      await waitFor(() => fixture.controller.state === 'published');

      const shown = fixture.approvalController.show(approvalData('a-1'));
      fixture.showApproval(approvalData('a-1'));
      const cardId = fixture.controller.openCards[0]!.cardId;
      await waitFor(() =>
        hub.registerSnapshots.some((snapshot) =>
          (snapshot as { threads?: { timeline?: { kind: string }[] }[] })
            .threads?.some((thread) =>
              thread.timeline?.some((entry) => entry.kind === 'card-opened'),
            ),
        ),
      );

      fixture.approvalController.respond({ decision: 'rejected' });
      await expect(shown).resolves.toEqual({ decision: 'rejected' });
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
      const lastRegister = hub.registerSnapshots.at(-1) as {
        threads: { openCards: { cardId: string }[] }[];
      };
      expect(lastRegister.threads[0]!.openCards.map((card) => card.cardId)).toEqual([]);
      await fixture.controller.stop();
    } finally {
      await hub.close();
    }
  });

  it('M1/V2: timeline entries stream up as batch frames without waiting for card events', async () => {
    const hub = new OrchestrationFakeHub();
    await hub.start();
    try {
      const fixture = makeController();
      fixture.controller.onSessionChanged(makeSession('s1'));
      await fixture.controller.start({ url: hub.url, token: 't' });
      await waitFor(() => fixture.controller.state === 'published');

      fixture.controller.onTranscriptEntry({ id: 'u1', kind: 'user', renderMode: 'plain', content: 'run the deploy' });
      fixture.controller.onSessionEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, agentId: 'main', sessionId: 's1' } as never);
      fixture.controller.onSessionEvent({ type: 'assistant.delta', turnId: 1, delta: 'deploying', agentId: 'main', sessionId: 's1' } as never);
      fixture.controller.onSessionEvent({ type: 'turn.ended', turnId: 1, reason: 'completed', agentId: 'main', sessionId: 's1' } as never);
      fixture.controller.onSessionEvent({ type: 'tool.call.started', turnId: 1, toolCallId: 'tc1', name: 'Bash', args: { command: 'ls' }, agentId: 'main', sessionId: 's1' } as never);

      await waitFor(() => {
        const entries = hub.batches.flatMap((batch) =>
          batch.frames.filter((frame) => frame.kind === 'timeline').flatMap((frame) => (frame as { entries: { kind: string; seq: number }[] }).entries),
        );
        return entries.length >= 3;
      });
      const entries = hub.batches.flatMap((batch) =>
        batch.frames.filter((frame) => frame.kind === 'timeline').flatMap((frame) => (frame as { entries: { kind: string; seq: number }[] }).entries),
      );
      expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
      expect(entries.map((entry) => entry.kind)).toEqual(['user-message', 'assistant-turn', 'tool-call']);
      for (const batch of hub.batches) {
        for (const frame of batch.frames) {
          if (frame.kind !== 'timeline') continue;
          expect(frame.sessionId).toBe('s1');
        }
      }
      await fixture.controller.stop();
    } finally {
      await hub.close();
    }
  });

  it('V2: incremental uplink + mid-flight resync + continued increments stay hole-free', async () => {
    const hub = new OrchestrationFakeHub();
    await hub.start();
    try {
      const fixture = makeController();
      fixture.controller.onSessionChanged(makeSession('s1'));
      await fixture.controller.start({ url: hub.url, token: 't' });
      await waitFor(() => fixture.controller.state === 'published');

      const uplinkedSeqs = (): number[] =>
        hub.batches.flatMap((batch) =>
          batch.frames
            .filter((frame) => frame.kind === 'timeline')
            .flatMap((frame) => (frame as { entries: { seq: number }[] }).entries.map((entry) => entry.seq)),
        );
      const emitUser = (index: number) => {
        fixture.controller.onTranscriptEntry({ id: `u${index}`, kind: 'user', renderMode: 'plain', content: `m${index}` });
      };

      emitUser(1);
      emitUser(2);
      await waitFor(() => uplinkedSeqs().length === 2);
      expect(uplinkedSeqs()).toEqual([1, 2]);

      const registersBefore = hub.registerCount;
      (fixture.controller as unknown as { link?: { resync(): void } }).link!.resync();
      await waitFor(() => hub.registerCount === registersBefore + 1);
      const midRegister = hub.registerSnapshots.at(-1) as {
        threads: { timeline: { seq: number }[] }[];
      };
      const midSeqs = midRegister.threads[0]!.timeline.map((entry) => entry.seq);
      expect(midSeqs).toEqual([1, 2]);

      emitUser(3);
      emitUser(4);
      await waitFor(() => uplinkedSeqs().length === 4);
      const allUplinked = uplinkedSeqs();
      expect(allUplinked).toEqual([1, 2, 3, 4]);
      expect(new Set(allUplinked).size).toBe(allUplinked.length);

      const finalSnapshot = fixture.controller.getSnapshot();
      expect(finalSnapshot.threads[0]!.timeline.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
      await fixture.controller.stop();
    } finally {
      await hub.close();
    }
  });

  it('P6-6.3: attached switch settles S cards into S and registers S2 with a fresh snapshot', async () => {
    const hub = new OrchestrationFakeHub();
    await hub.start();
    try {
      const fixture = makeController();
      fixture.controller.onSessionChanged(makeSession('s1'));
      await fixture.controller.start({ url: hub.url, token: 't' });
      await waitFor(() => fixture.controller.state === 'published');

      fixture.showApproval(approvalData('a-1'));
      const cardId = fixture.controller.openCards[0]!.cardId;
      fixture.controller.onTranscriptEntry({ id: 'u1', kind: 'user', renderMode: 'plain', content: 'message of s1' });
      await waitFor(() =>
        hub.registerSnapshots.some((snapshot) =>
          (snapshot as { threads?: { timeline?: { kind: string; card?: { cardId?: string } }[] }[] })
            .threads?.some((thread) =>
              thread.timeline?.some(
                (entry) => entry.kind === 'card-opened' && entry.card?.cardId === cardId,
              ),
            ),
        ),
      );

      const settledFrames: { sessionId: string; entries: { kind: string; cardId?: string; outcome?: string }[] }[] = [];
      const realLink = (fixture.controller as unknown as {
        link?: { enqueue(frame: unknown): void; resync(): void; stop(): Promise<void> };
      }).link;
      expect(realLink).toBeDefined();
      (fixture.controller as unknown as { link?: unknown }).link = {
        enqueue: (frame: { kind: string; sessionId?: string }) => {
          if (frame.kind === 'timeline') {
            settledFrames.push(
              frame as unknown as { sessionId: string; entries: { kind: string; cardId?: string; outcome?: string }[] },
            );
          }
        },
        resync: () => {
          realLink!.resync();
        },
        stop: () => {
          void realLink!.stop();
        },
      };

      fixture.controller.onSessionChanged(makeSession('s2'));

      expect(settledFrames).toHaveLength(1);
      expect(settledFrames[0]!.sessionId).toBe('s1');
      expect(settledFrames[0]!.entries).toHaveLength(1);
      expect(settledFrames[0]!.entries[0]).toMatchObject({
        kind: 'card-settled',
        cardId,
        outcome: 'cancelled',
      });
      expect(fixture.controller.openCards).toEqual([]);

      await waitFor(() =>
        hub.registerSnapshots.some((snapshot) =>
          (snapshot as { threads?: { descriptor?: { sessionId: string }; timeline?: { kind: string; seq?: number }[] }[] })
            .threads?.some((thread) => thread.descriptor?.sessionId === 's2'),
        ),
      );
      const s2Register = hub.registerSnapshots
        .map((snapshot) => snapshot as { threads: { descriptor: { sessionId: string }; timeline: { kind: string; seq: number; text?: string }[] }[] })
        .find((snapshot) => snapshot.threads.some((thread) => thread.descriptor.sessionId === 's2'))!;
      const s2Thread = s2Register.threads.find((thread) => thread.descriptor.sessionId === 's2')!;
      expect(s2Thread.timeline).toEqual([]);
      expect(hub.registerSnapshots.every((snapshot) =>
        (snapshot as { threads: { descriptor: { sessionId: string }; timeline: { kind: string; seq: number }[] }[] })
          .threads.every((thread) =>
            thread.descriptor.sessionId !== 's2' ||
            thread.timeline.every((entry) => entry.kind !== 'card-settled'),
          ),
      )).toBe(true);
      await waitFor(() => fixture.controller.state === 'published');
      await fixture.controller.stop();
    } finally {
      await hub.close();
    }
  });

  it('remote approve via the downlink resolves the panel and reports the receipt through the link', async () => {
    const hub = new OrchestrationFakeHub();
    await hub.start();
    try {
      const fixture = makeController();
      fixture.controller.onSessionChanged(makeSession('s1'));
      await fixture.controller.start({ url: hub.url, token: 't' });
      await waitFor(() => fixture.controller.state === 'published');

      const shown = fixture.approvalController.show(approvalData('a-1'));
      fixture.showApproval(approvalData('a-1'));
      const cardId = fixture.controller.openCards[0]!.cardId;
      await waitFor(() => fixture.controller.getSnapshot().threads[0]!.openCards.length === 1);
      await waitFor(() => fixture.controller.state === 'published');

      hub.pushToStreams(
        `event: op\ndata: ${JSON.stringify({
          opId: 'opA',
          sessionId: 's1',
          intent: { type: 'approve', sessionId: 's1', cardId, optionIndex: 0 },
        })}`,
      );

      await expect(shown).resolves.toEqual({ decision: 'approved' });
      await waitFor(() => {
        const posts = hub.receiptBodies as { receipts: ReceiptReport[] }[];
        return posts.some((body) =>
          body.receipts.some((report) => report.opId === 'opA' && report.state === 'applied'),
        );
      });
      fixture.hideApproval();
      await fixture.controller.stop();
    } finally {
      await hub.close();
    }
  });
});
