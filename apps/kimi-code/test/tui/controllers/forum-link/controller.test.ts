import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { Session, SessionPlan } from '@moonshot-ai/kimi-code-sdk';

import { ForumLinkController, wrapUiHooksForForumLink } from '#/tui/controllers/forum-link';
import { resolveEndSessionMode } from '#/tui/controllers/forum-link/end-session';
import { ApprovalController } from '#/tui/reverse-rpc/approval/controller';
import { QuestionController } from '#/tui/reverse-rpc/question/controller';
import type { ApprovalPanelData, QuestionPanelData } from '#/tui/reverse-rpc/types';
import type { ReverseRPCUIHooks } from '#/tui/reverse-rpc/index';

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

interface ControllerFixture {
  controller: ForumLinkController;
  approvalController: ApprovalController;
  questionController: QuestionController;
  showApproval(payload: ApprovalPanelData): void;
  hideApproval(): void;
  showQuestion(payload: QuestionPanelData): void;
  hideQuestion(): void;
  hooks: ReverseRPCUIHooks;
}

function makeController(
  options: {
    overviewIntervalMs?: number;
    newCardId?: () => string;
    getPlan?: () => Promise<SessionPlan | null>;
  } = {},
): ControllerFixture {
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
      getPlan: options.getPlan ?? (async () => null),
      cancelForeground: () => {},
      session: () => undefined,
      workDir: () => '/tmp/proj',
      sessionTitle: () => null,
    },
    newCardId: options.newCardId ?? (() => `uuid-${Math.random().toString(36).slice(2, 10)}`),
    overviewIntervalMs: options.overviewIntervalMs,
  });
  const hooks = wrapUiHooksForForumLink(
    {
      showApprovalPanel: () => {},
      hideApprovalPanel: () => {},
      showQuestionDialog: () => {},
      hideQuestionDialog: () => {},
    },
    controller,
  );
  return {
    controller,
    approvalController,
    questionController,
    showApproval: (payload) => {
      hooks.showApprovalPanel(payload);
    },
    hideApproval: () => {
      hooks.hideApprovalPanel();
    },
    showQuestion: (payload) => {
      hooks.showQuestionDialog(payload);
    },
    hideQuestion: () => {
      hooks.hideQuestionDialog();
    },
    hooks,
  };
}

describe('M4-A1 card id stability and unique panel mapping', () => {
  it('keeps the card id stable while open and maps to exactly one local panel', () => {
    const fixture = makeController();
    fixture.showApproval(approvalData('a-1'));
    const first = fixture.controller.openCards;
    expect(first).toHaveLength(1);
    const cardId = first[0]!.cardId;
    expect(cardId.startsWith('approval_')).toBe(true);

    fixture.controller.onAppStateChanged();
    fixture.controller.onAppStateChanged();
    expect(fixture.controller.openCards).toEqual(first);

    const view = fixture.controller.getOpenCardView(cardId);
    expect(view).toBeDefined();
    expect(view!.kind).toBe('approval');
    expect(view!.approval!.id).toBe('a-1');
    expect(fixture.controller.isCurrentPanelCard(cardId)).toBe(true);
    expect(fixture.controller.getOpenCardView('unknown-card')).toBeUndefined();
    expect(fixture.controller.isCurrentPanelCard('unknown-card')).toBe(false);
  });

  it('mints question cards with the question_ prefix and kind-correct views', () => {
    const fixture = makeController();
    fixture.showQuestion(questionData('q-1'));
    const cardId = fixture.controller.openCards[0]!.cardId;
    expect(cardId.startsWith('question_')).toBe(true);
    const view = fixture.controller.getOpenCardView(cardId);
    expect(view!.kind).toBe('question');
    expect(view!.question!.id).toBe('q-1');
  });
});

describe('M4-A2 local answer settles the card and uplinks a settlement entry', () => {
  it('hide after a local answer removes the card from the open set and the snapshot', async () => {
    const fixture = makeController();
    const shown = fixture.approvalController.show(approvalData('a-1'));
    fixture.showApproval(approvalData('a-1'));
    const cardId = fixture.controller.openCards[0]!.cardId;

    fixture.approvalController.respond({ decision: 'rejected' });
    await expect(shown).resolves.toEqual({ decision: 'rejected' });
    fixture.hideApproval();

    expect(fixture.controller.openCards).toEqual([]);
    expect(fixture.controller.getOpenCardView(cardId)).toBeUndefined();
    const snapshot = fixture.controller.getSnapshot();
    expect(snapshot.threads[0]!.openCards).toEqual([]);
    const settled = snapshot.threads[0]!.timeline.filter((entry) => entry.kind === 'card-settled');
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ cardId, outcome: 'approved' });
  });
});

describe('M4-A3 session switch resyncs and cancels old open cards locally', () => {
  it('settles old open cards and triggers one re-registration via resync', async () => {
    const fixture = makeController();
    const resync = vi.fn();
    const link = fixture.controller as unknown as { link?: { resync(): void } };
    fixture.controller.onSessionChanged({ id: 's1', onEvent: () => () => {} } as never as Session);
    fixture.showApproval(approvalData('a-1'));
    const cardId = fixture.controller.openCards[0]!.cardId;

    const start = fixture.controller.start({ url: 'http://127.0.0.1:1', token: 't' });
    await start;
    const enqueued: { sessionId: string; entries: { kind: string; cardId?: string; outcome?: string }[] }[] = [];
    Object.defineProperty(fixture.controller, 'link', {
      get: () => ({
        resync,
        enqueue: (frame: { kind: string; sessionId?: string }) => {
          if (frame.kind === 'timeline') enqueued.push(frame as never);
        },
      }),
      configurable: true,
    });
    void link;

    fixture.controller.onSessionChanged({ id: 's2', onEvent: () => () => {} } as never as Session);

    expect(resync).toHaveBeenCalledTimes(1);
    expect(fixture.controller.openCards).toEqual([]);
    const snapshot = fixture.controller.getSnapshot();
    expect(snapshot.threads[0]!.openCards).toEqual([]);
    expect(snapshot.threads[0]!.descriptor.sessionId).toBe('s2');
    expect(snapshot.threads[0]!.timeline).toEqual([]);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ sessionId: 's1', kind: 'timeline' });
    expect(enqueued[0]!.entries).toHaveLength(1);
    expect(enqueued[0]!.entries[0]).toMatchObject({
      kind: 'card-settled',
      cardId,
      outcome: 'cancelled',
    });
  });
});

describe('P1 show→show settles the superseded card first', () => {
  it('settles the replaced card before opening the next one without an intervening hide', () => {
    const fixture = makeController();
    fixture.showApproval(approvalData('a-1'));
    const first = fixture.controller.openCards[0]!.cardId;

    fixture.showApproval(approvalData('a-2'));

    expect(fixture.controller.openCards).toHaveLength(1);
    const second = fixture.controller.openCards[0]!.cardId;
    expect(second).not.toBe(first);
    const snapshot = fixture.controller.getSnapshot();
    const settled = snapshot.threads[0]!.timeline.filter((entry) => entry.kind === 'card-settled');
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ cardId: first });
  });

  it('settles per kind: an approval does not settle an open question card', () => {
    const fixture = makeController();
    fixture.showQuestion(questionData('q-1'));
    fixture.showApproval(approvalData('a-1'));
    expect(fixture.controller.openCards).toHaveLength(2);
    const snapshot = fixture.controller.getSnapshot();
    expect(snapshot.threads[0]!.timeline.filter((entry) => entry.kind === 'card-settled')).toEqual([]);
  });
});

describe('M5-A1 overview dirty merging', () => {
  it('multiple triggers within one interval produce exactly one sample', async () => {
    const fixture = makeController({ overviewIntervalMs: 30 });
    const session = { id: 's1', onEvent: () => () => {} } as never as Session;
    fixture.controller.onSessionChanged(session);
    await fixture.controller.start({ url: 'http://127.0.0.1:1', token: 't' });
    fixture.controller.onSessionEvent({ type: 'tool.result' } as never);
    fixture.controller.onSessionEvent({ type: 'tool.result' } as never);
    fixture.controller.onAppStateChanged();
    fixture.controller.onAppStateChanged();
    fixture.controller.onAppStateChanged();

    const enqueued = collectEnqueuedFrames(fixture.controller);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const overviewFrames = enqueued.filter((frame) => frame.kind === 'overview');
    expect(overviewFrames).toHaveLength(1);
    await fixture.controller.stop();
  });

  it('after the interval a new trigger schedules the next sample', async () => {
    const fixture = makeController({ overviewIntervalMs: 20 });
    const session = { id: 's1', onEvent: () => () => {} } as never as Session;
    fixture.controller.onSessionChanged(session);
    await fixture.controller.start({ url: 'http://127.0.0.1:1', token: 't' });
    const enqueued = collectEnqueuedFrames(fixture.controller);

    fixture.controller.onAppStateChanged();
    await new Promise((resolve) => setTimeout(resolve, 50));
    fixture.controller.onAppStateChanged();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(enqueued.filter((frame) => frame.kind === 'overview').length).toBeGreaterThanOrEqual(2);
    await fixture.controller.stop();
  });
});

describe('M5-A2 no trigger means no frames', () => {
  it('produces no overview frame without a dirty trigger', async () => {
    const fixture = makeController({ overviewIntervalMs: 20 });
    const session = { id: 's1', onEvent: () => () => {} } as never as Session;
    fixture.controller.onSessionChanged(session);
    await fixture.controller.start({ url: 'http://127.0.0.1:1', token: 't' });
    const enqueued = collectEnqueuedFrames(fixture.controller);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(enqueued).toEqual([]);
    await fixture.controller.stop();
  });
});

describe('M5-Contract unpublished means no scheduling', () => {
  it('does not schedule overview sampling while detached', async () => {
    const fixture = makeController({ overviewIntervalMs: 20 });
    fixture.controller.onAppStateChanged();
    fixture.controller.onAppStateChanged();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const snapshot = fixture.controller.getSnapshot();
    expect(snapshot.threads[0]!.overview.rev).toBe(1);
  });
});

function makeSession(id: string): Session {
  return { id, onEvent: () => () => {} } as never as Session;
}

describe('P6-6.1: session switch rebuilds projector so the next snapshot starts empty', () => {
  it('first snapshot after onSessionChanged(S2) contains only new-session entries with seq from 1', () => {
    const fixture = makeController();
    fixture.controller.onSessionChanged(makeSession('s1'));
    fixture.controller.onTranscriptEntry({ id: 'u1', kind: 'user', renderMode: 'plain', content: 'old session message' });
    fixture.controller.onSessionEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, agentId: 'main', sessionId: 's1' } as never);
    fixture.controller.onSessionEvent({ type: 'assistant.delta', turnId: 1, delta: 'old assistant text\nlast line of s1', agentId: 'main', sessionId: 's1' } as never);
    fixture.controller.onSessionEvent({ type: 'turn.ended', turnId: 1, reason: 'completed', agentId: 'main', sessionId: 's1' } as never);
    fixture.controller.onSessionEvent({ type: 'subagent.spawned', agentId: 'sub-1', sessionId: 's1' } as never);
    fixture.controller.onSessionEvent({ type: 'background.task.started', agentId: 'main', sessionId: 's1' } as never);
    expect(fixture.controller.getSnapshot().threads[0]!.timeline.length).toBeGreaterThanOrEqual(2);

    fixture.controller.onSessionChanged(makeSession('s2'));

    const snapshot = fixture.controller.getSnapshot();
    expect(snapshot.threads[0]!.timeline).toEqual([]);
    expect(snapshot.threads[0]!.descriptor.sessionId).toBe('s2');
    expect(snapshot.threads[0]!.overview.subagents).toEqual([]);
    expect(snapshot.threads[0]!.overview.backgroundTasks).toEqual([]);

    fixture.controller.onTranscriptEntry({ id: 'u2', kind: 'user', renderMode: 'plain', content: 'new session message' });
    const after = fixture.controller.getSnapshot().threads[0]!.timeline;
    expect(after.map((entry) => entry.seq)).toEqual([1]);
    expect(after[0]).toMatchObject({ kind: 'user-message', text: 'new session message' });
  });

  it('lastAssistantLine, pendingPlanBodies and fold state do not leak into the new session overview', () => {
    const fixture = makeController();
    fixture.controller.onSessionChanged(makeSession('s1'));
    fixture.controller.onSessionEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, agentId: 'main', sessionId: 's1' } as never);
    fixture.controller.onSessionEvent({ type: 'assistant.delta', turnId: 1, delta: 's1 answer line', agentId: 'main', sessionId: 's1' } as never);
    fixture.controller.onSessionEvent({ type: 'turn.ended', turnId: 1, reason: 'completed', agentId: 'main', sessionId: 's1' } as never);
    const before = fixture.controller.getSnapshot();
    expect(before.threads[0]!.overview.lastLine).toBe('s1 answer line');

    fixture.controller.onSessionChanged(makeSession('s2'));

    expect(fixture.controller.getSnapshot().threads[0]!.overview.lastLine).toBe('');
  });
});

describe('P6-6.2: session switch clears the overview cache and dirty flag', () => {
  it('a cached overview from S1 is not served for S2, and pending dirty state is dropped', async () => {
    const fixture = makeController({ overviewIntervalMs: 30 });
    fixture.controller.onSessionChanged(makeSession('s1'));
    await fixture.controller.start({ url: 'http://127.0.0.1:1', token: 't' });
    const enqueued = collectEnqueuedFrames(fixture.controller);
    fixture.controller.onAppStateChanged();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(enqueued.filter((frame) => frame.kind === 'overview')).toHaveLength(1);
    const cachedOverview = fixture.controller.getSnapshot().threads[0]!.overview;

    fixture.controller.onAppStateChanged();
    fixture.controller.onSessionChanged(makeSession('s2'));

    await new Promise((resolve) => setTimeout(resolve, 80));
    const next = fixture.controller.getSnapshot().threads[0]!.overview;
    expect(next).not.toBe(cachedOverview);
    expect(enqueued.filter((frame) => frame.kind === 'overview')).toHaveLength(1);
    await fixture.controller.stop();
  });

  it('an approval card opened before the switch carries no stale plan body afterwards', async () => {
    let planContent: string | null = 'PLAN BODY OF S1';
    const fixture = makeController({
      newCardId: () => 'fixed',
      getPlan: async () =>
        planContent === null ? null : { id: 'p1', content: planContent, path: 'plan.md' },
    });
    fixture.controller.onSessionChanged(makeSession('s1'));
    fixture.showApproval({ ...approvalData('a-1'), tool_name: 'ExitPlanMode' });
    const cardId = fixture.controller.openCards[0]!.cardId;
    fixture.controller.getSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const before = fixture.controller.getSnapshot().threads[0]!.openCards[0] as {
      approval?: { display?: unknown[] };
    };
    expect(before.approval!.display).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'plan_body', text: 'PLAN BODY OF S1' })]),
    );

    fixture.controller.onSessionChanged(makeSession('s2'));
    planContent = null;

    expect(fixture.controller.openCards).toEqual([]);
    expect(fixture.controller.getOpenCardView(cardId)).toBeUndefined();
    const snapshot = fixture.controller.getSnapshot();
    expect(snapshot.threads[0]!.openCards).toEqual([]);
    expect(snapshot.threads[0]!.timeline).toEqual([]);

    fixture.showApproval({ ...approvalData('a-2'), tool_name: 'ExitPlanMode' });
    const reopenedId = fixture.controller.openCards[0]!.cardId;
    expect(reopenedId).toBe(cardId);
    fixture.controller.getSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const after = fixture.controller.getSnapshot().threads[0]!.openCards[0] as {
      approval?: { display?: unknown[] };
    };
    expect(after.approval!.display).toEqual([]);
    expect(JSON.stringify(fixture.controller.getSnapshot()).includes('PLAN BODY OF S1')).toBe(false);
  });
});

describe('P6-6.4: detached session switch still rebuilds the projector', () => {
  it('state accumulated before a detached switch is empty after start()', async () => {
    const fixture = makeController();
    fixture.controller.onSessionChanged(makeSession('s1'));
    fixture.controller.onTranscriptEntry({ id: 'u1', kind: 'user', renderMode: 'plain', content: 'old session message' });
    fixture.controller.onSessionEvent({ type: 'subagent.spawned', agentId: 'sub-1', sessionId: 's1' } as never);
    fixture.showApproval(approvalData('a-1'));
    expect(fixture.controller.openCards).toHaveLength(1);

    fixture.controller.onSessionChanged(makeSession('s2'));

    expect(fixture.controller.state).toBe('detached');
    expect(fixture.controller.openCards).toEqual([]);
    await fixture.controller.start({ url: 'http://127.0.0.1:1', token: 't' });
    const snapshot = fixture.controller.getSnapshot();
    expect(snapshot.threads[0]!.descriptor.sessionId).toBe('s2');
    expect(snapshot.threads[0]!.timeline).toEqual([]);
    expect(snapshot.threads[0]!.overview.subagents).toEqual([]);
    await fixture.controller.stop();
  });
});

describe('P6-6.5: projector construction site is unique (static)', () => {
  it('start() and onSessionChanged share resetProjector; no reset method added to Projector', () => {
    const source = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'src', 'tui', 'controllers', 'forum-link', 'controller.ts'),
      'utf8',
    );
    const constructorSites = source.match(/new Projector\(/g) ?? [];
    expect(constructorSites).toHaveLength(1);
    expect(source).toMatch(/private resetProjector\(\): void \{\s*this\.projector = new Projector\(/);
    expect(source).toMatch(/onSessionChanged\(session: Session\): void \{[\s\S]*?this\.resetProjector\(\);/);
    expect(source).not.toMatch(/projector\.reset\(/);
    const projectorSource = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'src', 'tui', 'controllers', 'forum-link', 'projector.ts'),
      'utf8',
    );
    expect(projectorSource).not.toMatch(/\breset\s*\(/);
  });
});

function collectEnqueuedFrames(
  controller: ForumLinkController,
): { kind: string; [key: string]: unknown }[] {
  const frames: { kind: string; [key: string]: unknown }[] = [];
  const target = {
    enqueue: (frame: { kind: string }) => frames.push(frame),
    stop: async () => {},
    resync: () => {},
    reportReceipt: () => {},
  };
  Object.defineProperty(controller, 'link', {
    get: () => target,
    set: () => {},
    configurable: true,
  });
  return frames;
}

describe('controller skeleton smoke', () => {
  it('constructs, stays detached, and seams are safe no-ops without a host', async () => {
    const controller = new ForumLinkController({});
    expect(controller.state).toBe('detached');
    controller.onTranscriptEntry({} as never);
    controller.onSessionChanged({ id: 's1', onEvent: () => () => {} } as never);
    controller.onAppStateChanged();
    controller.onCardOpened('approval', 'up-1', {} as never);
    controller.onCardClosed('approval', 'up-1');
    expect(controller.openCards).toEqual([]);
    await controller.stop();
    expect(controller.state).toBe('detached');
    expect(resolveEndSessionMode(undefined)).toBe('immediate');
  });

  it('wrapUiHooksForForumLink passes through without a controller', () => {
    const calls: string[] = [];
    const hooks = wrapUiHooksForForumLink(
      {
        showApprovalPanel: () => {
          calls.push('show-approval');
        },
        hideApprovalPanel: () => {
          calls.push('hide-approval');
        },
        showQuestionDialog: () => {
          calls.push('show-question');
        },
        hideQuestionDialog: () => {
          calls.push('hide-question');
        },
      },
      undefined,
    );
    hooks.showApprovalPanel({ id: 'a1' } as never);
    hooks.hideApprovalPanel();
    hooks.showQuestionDialog({ id: 'q1' } as never);
    hooks.hideQuestionDialog();
    expect(calls).toEqual(['show-approval', 'hide-approval', 'show-question', 'hide-question']);
  });
});
