import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import type { ThreadSnapshot, ThreadSummary } from '#/contract/browser';
import { parseOpIntent } from '#/contract/shared';
import type { Descriptor, Receipt } from '#/contract/shared';
import type { Card, Overview, TimelineEntry } from '#/contract/worker';
import { PageStore, appendTimeline, displayState, goalProgress, sortInbox } from '#/page/store';

const PAGE_HTML = readFileSync(fileURLToPath(new URL('../src/page/index.html', import.meta.url)), 'utf8');

interface ForumView {
  parseRoute(hash: unknown): { name: string; sessionId?: string; cardId?: string };
  classifyBlock(block: unknown): string;
  blockSummary(block: unknown): string;
  blockFields(block: unknown): [string, string][];
  actionBarActions(capabilities: unknown, online: unknown): {
    enabled: boolean;
    send: boolean;
    steer: boolean;
    pause: boolean;
    endSession: boolean;
    permissionMode: boolean;
    switchModel: boolean;
    newSession: boolean;
    goalSet: boolean;
    goalPause: boolean;
    goalResume: boolean;
    goalCancel: boolean;
  };
  buildApprovalIntent(
    sessionId: string,
    cardId: string,
    card: unknown,
    optionIndex: unknown,
    feedback?: unknown,
  ): { ok: true; intent: Record<string, unknown> } | { ok: false; reason: string };
  buildApprovalCancelIntent(sessionId: string, cardId: string): Record<string, unknown>;
  newAnswerDrafts(card: unknown): { selected: number[]; freeText: string }[];
  answerDraftReady(card: unknown, drafts: unknown): boolean;
  answerSummary(card: unknown, drafts: unknown): { question: string; answer: string }[];
  buildAnswerIntent(
    sessionId: string,
    cardId: string,
    card: unknown,
    drafts: unknown,
  ): { ok: true; intent: Record<string, unknown> } | { ok: false; reason: string };
  buildAnswerCancelIntent(sessionId: string, cardId: string): Record<string, unknown>;
  buildGoalSetIntent(
    sessionId: string,
    objective: unknown,
    replace: unknown,
    startMode?: unknown,
  ): { ok: true; intent: Record<string, unknown> } | { ok: false; reason: string };
  receiptBadge(receipt: unknown): { label: string; reason: string; text: string };
  settledOutcomeOf(timeline: unknown, cardId: string): string | undefined;
  deepLinkCardView(openCards: unknown, timeline: unknown, cardId: string): { status: string; outcome?: string };
  loginErrorText(status: unknown): string;
  buildLoginRequest(token: unknown): { ok: true; body: string } | { ok: false; reason: string };
  deviceRows(devices: unknown): { tokenId: string; name: string; role: string; createdAt: number }[];
  deviceCreatedAtText(createdAt: unknown): string;
  buildRevokeRequest(tokenId: unknown): { method: string; path: string } | null;
  buildThreadRemoveRequest(sessionId: unknown): { method: string; path: string } | null;
  showThreadRemove(current: unknown): boolean;
}

function loadForumView(): ForumView {
  const match = /<script id="forum-view">([\s\S]*?)<\/script>/.exec(PAGE_HTML);
  expect(match, 'index.html must contain the forum-view script block').not.toBeNull();
  runInThisContext(match![1]!, { filename: 'page/index.html#forum-view' });
  const view = (globalThis as { FORUM_VIEW?: ForumView }).FORUM_VIEW;
  expect(view, 'forum-view script must publish FORUM_VIEW').toBeDefined();
  return view!;
}

let clock = 1000;

function overviewOf(overrides: Partial<Overview> = {}): Overview {
  clock += 10;
  return {
    rev: 1,
    phase: 'idle',
    isCompacting: false,
    model: 'kimi',
    thinkingEffort: 'high',
    permissionMode: 'default',
    planMode: false,
    contextUsage: 0,
    goal: null,
    todos: [],
    subagents: [],
    backgroundTasks: [],
    models: [],
    lastLine: '',
    sampledAt: clock,
    ...overrides,
  };
}

function descriptorOf(sessionId: string, machine: { tokenName: string; hostname: string }): Descriptor {
  return {
    sessionId,
    machine,
    project: 'proj',
    title: `title-${sessionId}`,
    kind: 'interactive',
    capabilities: ['send'],
  };
}

function openCardOf(cardId: string, openedAt: number): ThreadSummary['openCards'][number] {
  return { cardId, kind: 'approval', openedAt };
}

function summaryOf(input: {
  sessionId: string;
  tokenName?: string;
  hostname?: string;
  openCards?: ThreadSummary['openCards'];
  lastActivityAt?: number;
  overview?: Partial<Overview>;
}): ThreadSummary {
  return {
    descriptor: descriptorOf(input.sessionId, {
      tokenName: input.tokenName ?? 'machine-a',
      hostname: input.hostname ?? 'host-a',
    }),
    overview: overviewOf(input.overview),
    online: true,
    openCards: input.openCards ?? [],
    lastActivityAt: input.lastActivityAt ?? clock,
  };
}

function snapshotOf(sessionId: string, overrides: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return {
    descriptor: descriptorOf(sessionId, { tokenName: 'machine-a', hostname: 'host-a' }),
    overview: overviewOf(),
    online: true,
    timeline: [],
    openCards: [],
    receipts: [],
    ...overrides,
  };
}

function entryOf(seq: number, at = clock): TimelineEntry {
  return { seq, at, kind: 'user-message', text: `m${seq}` };
}

function receiptOf(opId: string, sessionId: string, at = clock): Receipt {
  return { opId, sessionId, opType: 'send', state: 'accepted', at };
}

function idsOf(threads: readonly ThreadSummary[]): string[] {
  return threads.map((thread) => thread.descriptor.sessionId);
}

describe('sortInbox', () => {
  it('pins threads with open cards first, ordered by earliest open card ascending', () => {
    const later = summaryOf({ sessionId: 'pinned-later', openCards: [openCardOf('c1', 3000)], lastActivityAt: 9000 });
    const earlier = summaryOf({ sessionId: 'pinned-earlier', openCards: [openCardOf('c2', 2000)], lastActivityAt: 1000 });
    const idle = summaryOf({ sessionId: 'idle', lastActivityAt: 5000 });
    expect(idsOf(sortInbox([later, idle, earlier]))).toEqual(['pinned-earlier', 'pinned-later', 'idle']);
  });

  it('uses the earliest open card time when a thread has several open cards', () => {
    const multi = summaryOf({
      sessionId: 'multi',
      openCards: [openCardOf('c1', 4000), openCardOf('c2', 1500)],
    });
    const single = summaryOf({ sessionId: 'single', openCards: [openCardOf('c3', 2000)] });
    expect(idsOf(sortInbox([multi, single]))).toEqual(['multi', 'single']);
  });

  it('groups non-pinned threads by tokenName with groups and members ordered by recent activity descending', () => {
    const a1 = summaryOf({ sessionId: 'a1', tokenName: 'alpha', lastActivityAt: 100 });
    const a2 = summaryOf({ sessionId: 'a2', tokenName: 'alpha', lastActivityAt: 300 });
    const b1 = summaryOf({ sessionId: 'b1', tokenName: 'beta', lastActivityAt: 500 });
    const b2 = summaryOf({ sessionId: 'b2', tokenName: 'beta', lastActivityAt: 200 });
    expect(idsOf(sortInbox([a1, b1, a2, b2]))).toEqual(['b1', 'b2', 'a2', 'a1']);
  });

  it('groups by tokenName, not hostname', () => {
    const sameNameHost1 = summaryOf({ sessionId: 's1', tokenName: 'laptop', hostname: 'box-one', lastActivityAt: 100 });
    const sameNameHost2 = summaryOf({ sessionId: 's2', tokenName: 'laptop', hostname: 'box-two', lastActivityAt: 200 });
    const other = summaryOf({ sessionId: 's3', tokenName: 'server', hostname: 'box-two', lastActivityAt: 300 });
    expect(idsOf(sortInbox([sameNameHost1, other, sameNameHost2]))).toEqual(['s3', 's2', 's1']);
  });

  it('breaks ties deterministically by sessionId', () => {
    const x = summaryOf({ sessionId: 'x', lastActivityAt: 100 });
    const y = summaryOf({ sessionId: 'y', lastActivityAt: 100 });
    const first = idsOf(sortInbox([y, x]));
    const second = idsOf(sortInbox([x, y]));
    expect(first).toEqual(['x', 'y']);
    expect(second).toEqual(first);
  });
});

describe('displayState', () => {
  const cases: { name: string; summary: ThreadSummary; expected: string }[] = [
    { name: 'idle online', summary: summaryOf({ sessionId: 's' }), expected: 'idle' },
    {
      name: 'idle offline',
      summary: { ...summaryOf({ sessionId: 's' }), online: false },
      expected: 'idle (offline)',
    },
    {
      name: 'waiting',
      summary: summaryOf({ sessionId: 's', overview: { phase: 'waiting' } }),
      expected: 'waiting',
    },
    {
      name: 'thinking offline',
      summary: { ...summaryOf({ sessionId: 's', overview: { phase: 'thinking' } }), online: false },
      expected: 'thinking (offline)',
    },
    {
      name: 'composing',
      summary: summaryOf({ sessionId: 's', overview: { phase: 'composing' } }),
      expected: 'composing',
    },
    {
      name: 'shell',
      summary: summaryOf({ sessionId: 's', overview: { phase: 'shell' } }),
      expected: 'shell',
    },
    {
      name: 'compacting beats running phase',
      summary: summaryOf({ sessionId: 's', overview: { phase: 'thinking', isCompacting: true } }),
      expected: 'compacting',
    },
    {
      name: 'pending beats compacting',
      summary: summaryOf({
        sessionId: 's',
        openCards: [openCardOf('c1', 100)],
        overview: { isCompacting: true },
      }),
      expected: 'pending',
    },
    {
      name: 'pending offline',
      summary: {
        ...summaryOf({ sessionId: 's', openCards: [openCardOf('c1', 100)] }),
        online: false,
      },
      expected: 'pending (offline)',
    },
  ];

  it.each(cases)('$name', ({ summary, expected }) => {
    expect(displayState(summary)).toBe(expected);
  });
});

describe('goalProgress', () => {
  it('returns empty string without a goal', () => {
    expect(goalProgress(overviewOf(), 10_000)).toBe('');
  });

  it('shows only elapsed time when no wall-clock budget is set', () => {
    const overview = overviewOf({
      goal: { goalId: 'g1', objective: 'o', status: 'paused', wallClockMs: 65_000 },
    });
    expect(goalProgress(overview, overview.sampledAt + 5000)).toBe('1m 5s');
  });

  it('shows elapsed / budget when a wall-clock budget is set', () => {
    const overview = overviewOf({
      goal: {
        goalId: 'g1',
        objective: 'o',
        status: 'paused',
        wallClockMs: 65_000,
        budget: { wallClockBudgetMs: 3_600_000 },
      },
    });
    expect(goalProgress(overview, overview.sampledAt + 5000)).toBe('1m 5s / 1h');
  });

  it('adds time since the sample for an active goal', () => {
    const overview = overviewOf({
      goal: { goalId: 'g1', objective: 'o', status: 'active', wallClockMs: 30_000 },
    });
    expect(goalProgress(overview, overview.sampledAt + 40_000)).toBe('1m 10s');
  });

  it('does not add time since the sample for a non-active goal', () => {
    const overview = overviewOf({
      goal: { goalId: 'g1', objective: 'o', status: 'complete', wallClockMs: 30_000 },
    });
    expect(goalProgress(overview, overview.sampledAt + 40_000)).toBe('30s');
  });
});

describe('appendTimeline', () => {
  it('appends contiguous entries and skips already-seen sequence numbers', () => {
    const base = [entryOf(1), entryOf(2)];
    const result = appendTimeline(base, [entryOf(2), entryOf(3)]);
    expect(result.gap).toBe(false);
    expect(result.timeline.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(base).toHaveLength(2);
  });

  it('reports a gap and keeps the timeline unchanged when sequence numbers skip', () => {
    const base = [entryOf(1), entryOf(2)];
    const result = appendTimeline(base, [entryOf(4)]);
    expect(result.gap).toBe(true);
    expect(result.timeline).toEqual(base);
  });
});

describe('PageStore', () => {
  it('applies inbox and thread snapshots deterministically', () => {
    const summaries = [summaryOf({ sessionId: 's1' }), summaryOf({ sessionId: 's2', tokenName: 'other' })];
    const snapshot = snapshotOf('s1', { timeline: [entryOf(1), entryOf(2)] });
    const build = () => {
      const store = new PageStore();
      store.applyInbox(summaries);
      store.applyThreadSnapshot(snapshot);
      return store;
    };
    const first = build();
    const second = build();
    expect(first.inbox).toEqual(second.inbox);
    expect(first.currentThread).toEqual(second.currentThread);
    expect(idsOf(first.inbox).toSorted()).toEqual(['s1', 's2']);
    expect(first.currentThread?.timeline.map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it('derives the inbox summary from a thread snapshot', () => {
    const store = new PageStore();
    store.applyThreadSnapshot(
      snapshotOf('s1', {
        overview: overviewOf({ sampledAt: 100 }),
        openCards: [{ cardId: 'c1', kind: 'approval', openedAt: 500, approval: {} }],
        timeline: [entryOf(1, 700)],
      }),
    );
    const summary = store.inbox.find((thread) => thread.descriptor.sessionId === 's1');
    expect(summary?.openCards).toEqual([{ cardId: 'c1', kind: 'approval', openedAt: 500 }]);
    expect(summary?.lastActivityAt).toBe(700);
  });

  it('appends contiguous timeline events to the current thread and updates activity', () => {
    const store = new PageStore();
    store.applyThreadSnapshot(snapshotOf('s1', { overview: overviewOf({ sampledAt: 50 }), timeline: [entryOf(1, 100)] }));
    store.applyEvent({ type: 'timeline.append', sessionId: 's1', entries: [entryOf(2, 200)] });
    expect(store.currentThread?.timeline.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(store.inbox.find((thread) => thread.descriptor.sessionId === 's1')?.lastActivityAt).toBe(200);
  });

  it('refetches the thread on a sequence gap and keeps the timeline unchanged', () => {
    const refetched: string[] = [];
    const store = new PageStore({ refetchThread: (sessionId) => refetched.push(sessionId) });
    store.applyThreadSnapshot(snapshotOf('s1', { timeline: [entryOf(1)] }));
    store.applyEvent({ type: 'timeline.append', sessionId: 's1', entries: [entryOf(3)] });
    expect(refetched).toEqual(['s1']);
    expect(store.currentThread?.timeline.map((entry) => entry.seq)).toEqual([1]);
  });

  it('refetches the thread on thread.reset when it is the current thread', () => {
    const refetched: string[] = [];
    const store = new PageStore({ refetchThread: (sessionId) => refetched.push(sessionId) });
    store.applyThreadSnapshot(snapshotOf('s1'));
    store.applyEvent({ type: 'thread.reset', sessionId: 'other' });
    expect(refetched).toEqual([]);
    store.applyEvent({ type: 'thread.reset', sessionId: 's1' });
    expect(refetched).toEqual(['s1']);
  });

  it('refetches inbox and current thread on every stream connection', () => {
    const inboxFetches: number[] = [];
    const refetched: string[] = [];
    const store = new PageStore({
      refetchInbox: () => inboxFetches.push(1),
      refetchThread: (sessionId) => refetched.push(sessionId),
    });
    store.noteStreamConnected();
    expect(inboxFetches).toHaveLength(1);
    expect(refetched).toEqual([]);
    store.applyThreadSnapshot(snapshotOf('s1'));
    store.noteStreamConnected();
    expect(inboxFetches).toHaveLength(2);
    expect(refetched).toEqual(['s1']);
  });

  it('accepts overview events only with a higher rev', () => {
    const store = new PageStore();
    store.applyThreadSnapshot(snapshotOf('s1'));
    const before = store.currentThread?.overview;
    store.applyEvent({ type: 'overview', sessionId: 's1', overview: overviewOf({ rev: 1 }) });
    expect(store.currentThread?.overview).toBe(before);
    store.applyEvent({ type: 'overview', sessionId: 's1', overview: overviewOf({ rev: 5 }) });
    expect(store.currentThread?.overview.rev).toBe(5);
  });

  it('tracks opened and settled cards across inbox and current thread', () => {
    const store = new PageStore();
    store.applyThreadSnapshot(snapshotOf('s1'));
    const card: Card = { cardId: 'c1', kind: 'question', openedAt: 900, question: {} };
    store.applyEvent({ type: 'card.opened', sessionId: 's1', card });
    expect(store.currentThread?.openCards).toEqual([card]);
    expect(store.inbox.find((thread) => thread.descriptor.sessionId === 's1')?.openCards).toEqual([
      { cardId: 'c1', kind: 'question', openedAt: 900 },
    ]);
    store.applyEvent({ type: 'card.opened', sessionId: 's1', card });
    expect(store.currentThread?.openCards).toHaveLength(1);
    store.applyEvent({ type: 'card.settled', sessionId: 's1', cardId: 'c1', outcome: 'approved' });
    expect(store.currentThread?.openCards).toEqual([]);
    expect(store.inbox.find((thread) => thread.descriptor.sessionId === 's1')?.openCards).toEqual([]);
  });

  it('applies upsert and removed events to the thread table', () => {
    const store = new PageStore();
    store.applyInbox([summaryOf({ sessionId: 's1' })]);
    store.applyEvent({
      type: 'thread.upsert',
      summary: summaryOf({ sessionId: 's2', tokenName: 'other', lastActivityAt: 50 }),
    });
    expect(idsOf(store.inbox).toSorted()).toEqual(['s1', 's2']);
    store.applyEvent({ type: 'thread.removed', sessionId: 's1' });
    expect(idsOf(store.inbox)).toEqual(['s2']);
  });

  it('clears the current thread when it is removed', () => {
    const store = new PageStore();
    store.applyThreadSnapshot(snapshotOf('s1'));
    store.applyEvent({ type: 'thread.removed', sessionId: 's1' });
    expect(store.currentThread).toBeUndefined();
  });

  it('merges receipts into the current thread sorted by time', () => {
    const store = new PageStore();
    store.applyThreadSnapshot(snapshotOf('s1'));
    store.applyEvent({ type: 'receipt', receipt: receiptOf('op2', 's1', 200) });
    store.applyEvent({ type: 'receipt', receipt: receiptOf('op1', 's1', 100) });
    store.applyEvent({ type: 'receipt', receipt: receiptOf('op1', 's1', 100) });
    expect(store.currentThread?.receipts.map((receipt) => receipt.opId)).toEqual(['op1', 'op2']);
  });

  it('ignores receipts for other sessions', () => {
    const store = new PageStore();
    store.applyThreadSnapshot(snapshotOf('s1'));
    store.applyEvent({ type: 'receipt', receipt: receiptOf('op1', 'other') });
    expect(store.currentThread?.receipts).toEqual([]);
  });

  it('signals unauthorized through the callback', () => {
    let unauthorized = 0;
    const store = new PageStore({ onUnauthorized: () => (unauthorized += 1) });
    store.noteUnauthorized();
    expect(unauthorized).toBe(1);
  });
});

describe('page index.html static safety', () => {
  it('contains no innerHTML or insertAdjacentHTML writes', () => {
    expect(PAGE_HTML).not.toMatch(/\.innerHTML\s*=/);
    expect(PAGE_HTML).not.toMatch(/insertAdjacentHTML/);
    expect(PAGE_HTML).not.toMatch(/document\.write/);
  });

  it('contains no web-storage credential access (K4-A1)', () => {
    expect(PAGE_HTML).not.toMatch(/localStorage/);
    expect(PAGE_HTML).not.toMatch(/sessionStorage/);
  });

  it('contains the view skeleton served at GET /', () => {
    expect(PAGE_HTML).toContain('id="view-login"');
    expect(PAGE_HTML).toContain('id="view-inbox"');
    expect(PAGE_HTML).toContain('id="view-devices"');
    expect(PAGE_HTML).toContain('id="view-thread"');
    expect(PAGE_HTML).toContain('id="open-cards"');
    expect(PAGE_HTML).toContain('id="timeline"');
    expect(PAGE_HTML).toContain('id="receipts"');
    expect(PAGE_HTML).toContain('id="action-bar"');
  });
});

describe('forum-view parseRoute', () => {
  const view = loadForumView();

  it('routes the inbox for empty and unknown hashes', () => {
    expect(view.parseRoute('')).toEqual({ name: 'inbox' });
    expect(view.parseRoute('#/')).toEqual({ name: 'inbox' });
    expect(view.parseRoute('#/unknown')).toEqual({ name: 'inbox' });
  });

  it('parses thread routes with and without a deep-link card', () => {
    expect(view.parseRoute('#/thread/s1')).toEqual({ name: 'thread', sessionId: 's1' });
    expect(view.parseRoute('#/thread/s%2F1')).toEqual({ name: 'thread', sessionId: 's/1' });
    expect(view.parseRoute('#/thread/s1?card=c1')).toEqual({ name: 'thread', sessionId: 's1', cardId: 'c1' });
    expect(view.parseRoute('#/thread/s1?card=c%3A2')).toEqual({ name: 'thread', sessionId: 's1', cardId: 'c:2' });
  });

  it('parses the devices and login routes', () => {
    expect(view.parseRoute('#/devices')).toEqual({ name: 'devices' });
    expect(view.parseRoute('#/login')).toEqual({ name: 'login' });
    expect(view.parseRoute(42)).toEqual({ name: 'inbox' });
  });
});

describe('forum-view display block fallback (K2-A3)', () => {
  const view = loadForumView();

  it('classifies known blocks and falls back to unknown', () => {
    expect(view.classifyBlock({ type: 'shell', command: 'ls' })).toBe('shell');
    expect(view.classifyBlock({ type: 'diff', path: 'a' })).toBe('diff');
    expect(view.classifyBlock({ type: 'file_content', path: 'a' })).toBe('file_content');
    expect(view.classifyBlock({ type: 'brief', text: 't' })).toBe('brief');
    expect(view.classifyBlock({ type: 'plan_body', text: 't' })).toBe('plan_body');
    expect(view.classifyBlock({ type: 'mcp_invocation', server: 'x' })).toBe('unknown');
    expect(view.classifyBlock(null)).toBe('unknown');
    expect(view.classifyBlock(42)).toBe('unknown');
  });

  it('summarizes unknown blocks by type and lists raw fields', () => {
    expect(view.blockSummary({ type: 'mcp_invocation', server: 'x' })).toBe('mcp_invocation');
    expect(view.blockSummary(null)).toBe('未知内容');
    expect(view.blockSummary({})).toBe('未知内容');
    const fields = view.blockFields({ type: 'mcp_invocation', server: 'x', count: 2 });
    expect(fields).toEqual([
      ['type', 'mcp_invocation'],
      ['server', 'x'],
      ['count', '2'],
    ]);
  });
});

describe('forum-view actionBarActions (K2-UI)', () => {
  const view = loadForumView();

  it('shows actions only for capabilities in the descriptor', () => {
    const acts = view.actionBarActions(
      ['send', 'steer', 'pause', 'new-session', 'goal-set', 'goal-cancel'],
      true,
    );
    expect(acts.send).toBe(true);
    expect(acts.steer).toBe(true);
    expect(acts.pause).toBe(true);
    expect(acts.newSession).toBe(true);
    expect(acts.goalSet).toBe(true);
    expect(acts.goalCancel).toBe(true);
    expect(acts.endSession).toBe(false);
    expect(acts.permissionMode).toBe(false);
    expect(acts.switchModel).toBe(false);
    expect(acts.goalPause).toBe(false);
    expect(acts.goalResume).toBe(false);
  });

  it('disables every action when the thread is offline', () => {
    const acts = view.actionBarActions(
      ['send', 'steer', 'pause', 'end-session', 'set-permission-mode', 'switch-model', 'new-session', 'goal-set', 'goal-pause', 'goal-resume', 'goal-cancel'],
      false,
    );
    expect(acts.send).toBe(true);
    expect(acts.goalSet).toBe(true);
    expect(acts.enabled).toBe(false);
  });

  it('treats non-array capabilities and non-boolean online safely', () => {
    const acts = view.actionBarActions(undefined, 'yes');
    expect(acts.send).toBe(false);
    expect(acts.enabled).toBe(false);
  });
});

describe('forum-view approval card intents', () => {
  const view = loadForumView();
  const card = {
    cardId: 'approval_1',
    kind: 'approval',
    openedAt: 1,
    approval: {
      tool_name: 'Bash',
      action: 'run',
      description: 'd',
      display: [],
      choices: [
        { label: '允许', response: 'approved' },
        { label: '本会话允许', response: 'approved_for_session' },
        { label: '拒绝', response: 'rejected', requires_feedback: true },
      ],
    },
  };

  it('builds an approve intent with an in-range option index', () => {
    const result = view.buildApprovalIntent('s1', 'approval_1', card, 0);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.intent).toEqual({ type: 'approve', sessionId: 's1', cardId: 'approval_1', optionIndex: 0 });
  });

  it('attaches trimmed feedback when provided', () => {
    const result = view.buildApprovalIntent('s1', 'approval_1', card, 0, '  note  ');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.intent['feedback']).toBe('note');
  });

  it('rejects out-of-range indexes and missing feedback for requires_feedback options', () => {
    expect(view.buildApprovalIntent('s1', 'approval_1', card, 3).ok).toBe(false);
    expect(view.buildApprovalIntent('s1', 'approval_1', card, -1).ok).toBe(false);
    expect(view.buildApprovalIntent('s1', 'approval_1', card, 2).ok).toBe(false);
    expect(view.buildApprovalIntent('s1', 'approval_1', card, 2, '  ').ok).toBe(false);
    expect(view.buildApprovalIntent('s1', 'approval_1', card, 2, 'reason').ok).toBe(true);
  });

  it('rejects malformed cards without throwing', () => {
    expect(view.buildApprovalIntent('s1', 'approval_1', {}, 0).ok).toBe(false);
    expect(view.buildApprovalIntent('s1', 'approval_1', null, 0).ok).toBe(false);
  });

  it('builds the cancel (= Esc) intent', () => {
    expect(view.buildApprovalCancelIntent('s1', 'approval_1')).toEqual({
      type: 'approve-cancel',
      sessionId: 's1',
      cardId: 'approval_1',
    });
  });

  it('produces intents that satisfy the shared op contract', () => {
    const ok = view.buildApprovalIntent('s1', 'approval_1', card, 2, 'why');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(parseOpIntent(ok.intent).ok).toBe(true);
    expect(parseOpIntent(view.buildApprovalCancelIntent('s1', 'approval_1')).ok).toBe(true);
  });
});

describe('forum-view question card intents', () => {
  const view = loadForumView();
  const card = {
    cardId: 'question_1',
    kind: 'question',
    openedAt: 1,
    question: {
      questions: [
        {
          question: '选一个',
          multi_select: false,
          options: [{ label: '甲' }, { label: '乙' }],
        },
        {
          question: '选多个',
          multi_select: true,
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ],
    },
  };

  it('creates empty drafts with one entry per question', () => {
    expect(view.newAnswerDrafts(card)).toEqual([
      { selected: [], freeText: '' },
      { selected: [], freeText: '' },
    ]);
  });

  it('marks drafts ready only when every question has a selection or free text', () => {
    const drafts = view.newAnswerDrafts(card);
    expect(view.answerDraftReady(card, drafts)).toBe(false);
    drafts[0]!.selected = [0];
    expect(view.answerDraftReady(card, drafts)).toBe(false);
    drafts[1]!.freeText = '自定义';
    expect(view.answerDraftReady(card, drafts)).toBe(true);
  });

  it('summarizes answers with selected labels plus free text', () => {
    const drafts = [
      { selected: [1], freeText: '' },
      { selected: [0], freeText: 'tail' },
    ];
    expect(view.answerSummary(card, drafts)).toEqual([
      { question: '选一个', answer: '乙' },
      { question: '选多个', answer: 'A, tail' },
    ]);
  });

  it('builds an answer intent matching the encoding contract', () => {
    const result = view.buildAnswerIntent('s1', 'question_1', card, [
      { selected: [1], freeText: '' },
      { selected: [0], freeText: 'tail' },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent).toEqual({
        type: 'answer',
        sessionId: 's1',
        cardId: 'question_1',
        answers: [{ selected: [1] }, { selected: [0], freeText: 'tail' }],
      });
      expect(parseOpIntent(result.intent).ok).toBe(true);
    }
  });

  it('rejects wrong-length drafts and out-of-range selections', () => {
    expect(view.buildAnswerIntent('s1', 'question_1', card, [{ selected: [0] }]).ok).toBe(false);
    expect(
      view.buildAnswerIntent('s1', 'question_1', card, [
        { selected: [5], freeText: '' },
        { selected: [], freeText: '' },
      ]).ok,
    ).toBe(false);
  });

  it('builds the cancel intent and it satisfies the contract', () => {
    const intent = view.buildAnswerCancelIntent('s1', 'question_1');
    expect(intent).toEqual({ type: 'answer-cancel', sessionId: 's1', cardId: 'question_1' });
    expect(parseOpIntent(intent).ok).toBe(true);
  });
});

describe('forum-view goal-set intent', () => {
  const view = loadForumView();

  it('omits startMode for auto and non-auto start modes', () => {
    const auto = view.buildGoalSetIntent('s1', ' 目标 ', false, 'auto');
    expect(auto.ok).toBe(true);
    if (auto.ok) {
      expect(auto.intent).toEqual({ type: 'goal-set', sessionId: 's1', objective: '目标', replace: false });
      expect(parseOpIntent(auto.intent).ok).toBe(true);
    }
    const manual = view.buildGoalSetIntent('s1', '目标', true, 'manual');
    expect(manual.ok).toBe(true);
    if (manual.ok) {
      expect(manual.intent['startMode']).toBe('manual');
      expect(manual.intent['replace']).toBe(true);
      expect(parseOpIntent(manual.intent).ok).toBe(true);
    }
  });

  it('rejects empty objectives', () => {
    expect(view.buildGoalSetIntent('s1', '   ', false, 'auto').ok).toBe(false);
    expect(view.buildGoalSetIntent('s1', undefined, false, 'auto').ok).toBe(false);
  });
});

describe('forum-view receipts and deep links', () => {
  const view = loadForumView();

  it('labels receipt states and appends the reason for rejected and lost', () => {
    expect(view.receiptBadge({ state: 'accepted' }).text).toBe('已受理');
    expect(view.receiptBadge({ state: 'delivered' }).text).toBe('已送达');
    expect(view.receiptBadge({ state: 'applied' }).text).toBe('已生效');
    expect(view.receiptBadge({ state: 'rejected', reason: 'card-closed' }).text).toBe('已失效（卡片已关闭）');
    expect(view.receiptBadge({ state: 'lost', reason: 'not-delivered' }).text).toBe('已失效（未送达）');
  });

  it('finds the latest settled outcome for a card in the timeline', () => {
    const timeline = [
      { seq: 1, at: 1, kind: 'card-settled', cardId: 'c1', outcome: 'answered' },
      { seq: 2, at: 2, kind: 'card-settled', cardId: 'c1', outcome: 'cancelled' },
    ];
    expect(view.settledOutcomeOf(timeline, 'c1')).toBe('cancelled');
    expect(view.settledOutcomeOf(timeline, 'c2')).toBeUndefined();
  });

  it('resolves deep-link card views as open, closed, or missing', () => {
    const openCards = [{ cardId: 'c1', kind: 'approval', openedAt: 1 }];
    const timeline = [{ seq: 1, at: 1, kind: 'card-settled', cardId: 'c2', outcome: 'approved' }];
    expect(view.deepLinkCardView(openCards, timeline, 'c1')).toEqual({ status: 'open', card: openCards[0] });
    expect(view.deepLinkCardView(openCards, timeline, 'c2')).toEqual({ status: 'closed', outcome: 'approved' });
    expect(view.deepLinkCardView(openCards, timeline, 'c3')).toEqual({ status: 'missing' });
    expect(view.deepLinkCardView(openCards, timeline, '')).toEqual({ status: 'none' });
  });
});

describe('forum-view login request (K4)', () => {
  const view = loadForumView();

  it('builds a login body from trimmed token input', () => {
    const result = view.buildLoginRequest('  secret-token  ');
    expect(result).toEqual({ ok: true, body: JSON.stringify({ token: 'secret-token' }) });
  });

  it('rejects empty and non-string token input', () => {
    expect(view.buildLoginRequest('   ')).toEqual({ ok: false, reason: 'empty-token' });
    expect(view.buildLoginRequest(undefined)).toEqual({ ok: false, reason: 'empty-token' });
    expect(view.buildLoginRequest(42)).toEqual({ ok: false, reason: 'empty-token' });
  });

  it('maps login failure statuses to user-facing text', () => {
    expect(view.loginErrorText(401)).toContain('token');
    expect(view.loginErrorText(429)).toContain('频繁');
    expect(view.loginErrorText(500)).toContain('失败');
    expect(view.loginErrorText(0)).toContain('失败');
  });
});

describe('forum-view devices view (K4-UI)', () => {
  const view = loadForumView();

  it('normalizes the token list into render rows', () => {
    const rows = view.deviceRows([
      { tokenId: 't1', name: 'phone', role: 'device', createdAt: 1000 },
      { tokenId: 't2', name: 'laptop', role: 'machine', createdAt: 2000 },
    ]);
    expect(rows).toEqual([
      { tokenId: 't1', name: 'phone', role: 'device', createdAt: 1000 },
      { tokenId: 't2', name: 'laptop', role: 'machine', createdAt: 2000 },
    ]);
  });

  it('tolerates malformed device entries and non-array input', () => {
    expect(view.deviceRows(null)).toEqual([]);
    expect(view.deviceRows(undefined)).toEqual([]);
    expect(view.deviceRows([{ tokenId: 't1' }, null, 42])).toEqual([
      { tokenId: 't1', name: '', role: 'device', createdAt: 0 },
    ]);
  });

  it('formats createdAt as a locale string and blanks invalid values', () => {
    const text = view.deviceCreatedAtText(0);
    expect(text).toBe('');
    expect(view.deviceCreatedAtText(Number.NaN)).toBe('');
    expect(view.deviceCreatedAtText('x')).toBe('');
    expect(view.deviceCreatedAtText(Date.UTC(2024, 0, 2, 3, 4, 5)).length).toBeGreaterThan(0);
  });

  it('builds the revoke request with an encoded token id', () => {
    expect(view.buildRevokeRequest('tok 1')).toEqual({ method: 'DELETE', path: '/api/browser/tokens/tok%201' });
    expect(view.buildRevokeRequest('')).toBeNull();
    expect(view.buildRevokeRequest(null)).toBeNull();
  });

  it('builds the offline-thread remove request with an encoded session id', () => {
    expect(view.buildThreadRemoveRequest('s/1')).toEqual({ method: 'DELETE', path: '/api/browser/threads/s%2F1' });
    expect(view.buildThreadRemoveRequest('')).toBeNull();
    expect(view.buildThreadRemoveRequest(undefined)).toBeNull();
  });

  it('shows the remove entry only for offline threads', () => {
    expect(view.showThreadRemove({ online: false, sessionId: 's1' })).toBe(true);
    expect(view.showThreadRemove({ online: true, sessionId: 's1' })).toBe(false);
    expect(view.showThreadRemove(null)).toBe(false);
    expect(view.showThreadRemove(undefined)).toBe(false);
  });
});

describe('page 401 handling (K4-A2)', () => {
  it('signals unauthorized and resets local state back to the login view', () => {
    let unauthorized = 0;
    const store = new PageStore({ onUnauthorized: () => (unauthorized += 1) });
    store.applyInbox([summaryOf({ sessionId: 's1' })]);
    store.applyThreadSnapshot(snapshotOf('s1'));
    store.noteUnauthorized();
    expect(unauthorized).toBe(1);
  });

  it('routes any unauthenticated hash to the login view via the page guard', () => {
    const view = loadForumView();
    const routes = ['', '#/', '#/devices', '#/thread/s1'];
    for (const hash of routes) {
      const route = view.parseRoute(hash);
      const guarded = route.name === 'login';
      expect(guarded).toBe(false);
    }
    expect(view.parseRoute('#/login')).toEqual({ name: 'login' });
  });

  it('clears local state on reset so the login view starts empty', () => {
    const store = new PageStore();
    store.applyInbox([summaryOf({ sessionId: 's1' })]);
    store.applyThreadSnapshot(snapshotOf('s1'));
    store.reset();
    expect(store.inbox).toEqual([]);
    expect(store.currentThread).toBeUndefined();
  });
});
