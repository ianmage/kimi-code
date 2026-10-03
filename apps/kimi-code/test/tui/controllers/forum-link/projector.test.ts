import { describe, expect, it } from 'vitest';

import type { Event, GoalSnapshot, ModelAlias } from '@moonshot-ai/kimi-code-sdk';

import { Projector } from '#/tui/controllers/forum-link/projector';
import type { SampleAppState } from '#/tui/controllers/forum-link/projector';
import type { TodoItem } from '#/tui/components/chrome/todo-panel';
import type { TranscriptEntry } from '#/tui/types';

const AGENT = 'main';
const SESSION = 's1';

let clock = 0;
const tick = () => {
  clock += 1;
  return clock;
};

function makeProjector(overrides: { ringLength?: number; maxTextChars?: number; maxFoldLength?: number } = {}) {
  return new Projector({
    limits: {
      timelineRingLength: overrides.ringLength,
      maxTextChars: overrides.maxTextChars,
      maxFoldLength: overrides.maxFoldLength,
    },
    mainAgentId: AGENT,
    now: tick,
  });
}

function userEntry(content: string): TranscriptEntry {
  return { id: 'e1', kind: 'user', renderMode: 'plain', content };
}

function turnStarted(turnId = 1, agentId = AGENT): Event {
  return { type: 'turn.started', turnId, origin: { kind: 'user' }, agentId, sessionId: SESSION } as Event;
}

function turnEnded(reason: 'completed' | 'cancelled' = 'completed', turnId = 1, agentId = AGENT): Event {
  return { type: 'turn.ended', turnId, reason, agentId, sessionId: SESSION } as Event;
}

function assistantDelta(delta: string, turnId = 1, agentId = AGENT): Event {
  return { type: 'assistant.delta', turnId, delta, agentId, sessionId: SESSION } as Event;
}

function thinkingDelta(delta: string, turnId = 1, agentId = AGENT): Event {
  return { type: 'thinking.delta', turnId, delta, agentId, sessionId: SESSION } as Event;
}

function toolCallStarted(overrides: { toolCallId?: string; name?: string; args?: unknown; agentId?: string } = {}): Event {
  return {
    type: 'tool.call.started',
    turnId: 1,
    toolCallId: overrides.toolCallId ?? 'tc1',
    name: overrides.name ?? 'Bash',
    args: overrides.args ?? { command: 'rm -rf /important && echo done', secret: 'hunter2' },
    agentId: overrides.agentId ?? AGENT,
    sessionId: SESSION,
  } as Event;
}

function toolCallDelta(agentId = AGENT): Event {
  return { type: 'tool.call.delta', turnId: 1, toolCallId: 'tc1', delta: 'x', agentId, sessionId: SESSION } as Event;
}

function toolResult(overrides: { toolCallId?: string; output?: unknown; isError?: boolean; agentId?: string } = {}): Event {
  return {
    type: 'tool.result',
    turnId: 1,
    toolCallId: overrides.toolCallId ?? 'tc1',
    output: overrides.output ?? 'ok',
    isError: overrides.isError,
    agentId: overrides.agentId ?? AGENT,
    sessionId: SESSION,
  } as Event;
}

function foreignEvent(type: string, agentId = AGENT): Event {
  return { type, agentId, sessionId: SESSION } as Event;
}

function subagentEvent(type: string, subagentId = 'sub-1', agentId = AGENT): Event {
  return { type, subagentId, agentId, sessionId: SESSION } as Event;
}

function backgroundTaskEvent(type: string, taskId = 'task-1', agentId = AGENT): Event {
  return { type, taskId, agentId, sessionId: SESSION } as Event;
}

const BASE_APP_STATE: SampleAppState = {
  streamingPhase: 'idle',
  isCompacting: false,
  model: 'kimi',
  thinkingEffort: 'high',
  permissionMode: 'auto',
  planMode: false,
  contextUsage: 0.25,
  goal: null,
};

const TODOS: readonly TodoItem[] = [
  { title: 'first', status: 'pending' },
  { title: 'second', status: 'done' },
];

const MODEL: ModelAlias = {
  provider: 'kimi',
  model: 'kimi-for-coding',
  maxContextSize: 262144,
  displayName: 'Kimi for Coding',
  supportEfforts: ['low', 'high'],
  capabilities: ['thinking'],
};

const AVAILABLE_MODELS: Record<string, ModelAlias> = { kimi: MODEL };

function sample(projector: Projector, overrides: Partial<SampleAppState> = {}, lastLine = '') {
  const appState = { ...BASE_APP_STATE, ...overrides };
  return projector.sampleOverview(appState, TODOS, projector.eventFolds, AVAILABLE_MODELS, lastLine);
}

describe('O4 timeline ring', () => {
  it('A1: local user transcript entry produces user-message', () => {
    const projector = makeProjector();
    projector.onTranscriptEntry(userEntry('hello world'));
    const snapshot = projector.snapshotTimeline();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({ kind: 'user-message', text: 'hello world' });
  });

  it('A1: strips ANSI and drops empty user text', () => {
    const projector = makeProjector();
    projector.onTranscriptEntry(userEntry('\u001B[31mred\u001B[0m text'));
    projector.onTranscriptEntry(userEntry('   \u001B[2m\u001B[0m  '));
    const snapshot = projector.snapshotTimeline();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({ kind: 'user-message', text: 'red text' });
  });

  it('A2: seq strictly increments by 1 across mixed entries', () => {
    const projector = makeProjector();
    projector.onTranscriptEntry(userEntry('q'));
    projector.handleEvent(turnStarted());
    projector.handleEvent(assistantDelta('partial'));
    projector.handleEvent(toolCallStarted({}));
    projector.handleEvent(toolResult({}));
    projector.handleEvent(turnEnded());
    const snapshot = projector.snapshotTimeline();
    expect(snapshot.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
  });

  it('A2: ring overflow keeps the newest N entries as a hole-free suffix', () => {
    const projector = makeProjector({ ringLength: 3 });
    for (let index = 0; index < 6; index += 1) {
      projector.onTranscriptEntry(userEntry(`m${String(index)}`));
    }
    const snapshot = projector.snapshotTimeline();
    expect(snapshot).toHaveLength(3);
    expect(snapshot.map((entry) => (entry as { text: string }).text)).toEqual(['m3', 'm4', 'm5']);
    expect(snapshot.map((entry) => entry.seq)).toEqual([4, 5, 6]);
  });

  it('A3: non-whitelisted events produce no entries', () => {
    const projector = makeProjector();
    projector.handleEvent(thinkingDelta('secret reasoning'));
    projector.handleEvent(toolCallDelta());
    projector.handleEvent(subagentEvent('assistant.delta', 'sub-1'));
    projector.handleEvent(foreignEvent('usage.updated'));
    projector.handleEvent(foreignEvent('session.meta.updated'));
    expect(projector.snapshotTimeline()).toEqual([]);
  });

  it('A3: tool-call entry carries keyArg but not raw arguments', () => {
    const projector = makeProjector();
    const rawArgs = { command: 'echo preamble; do-the-thing --with=flags; cleanup', secret: 'hunter2' };
    projector.handleEvent(toolCallStarted({ args: rawArgs }));
    const [entry] = projector.snapshotTimeline();
    expect(entry).toMatchObject({ kind: 'tool-call', toolCallId: 'tc1', name: 'Bash' });
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('hunter2');
    expect(entry).not.toHaveProperty('args');
  });

  it('A3: tool-result carries chip but not output text', () => {
    const projector = makeProjector();
    projector.handleEvent(toolCallStarted({ name: 'Read', args: { path: 'a.txt' } }));
    projector.handleEvent(toolResult({ output: 'line1\nline2\nline3\nline4\nline5\n' }));
    const entries = projector.snapshotTimeline();
    const result = entries.find((entry) => entry.kind === 'tool-result');
    expect(result).toMatchObject({ kind: 'tool-result', toolCallId: 'tc1', ok: true });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('line1');
  });

  it('assistant turn accumulates deltas and flushes on turn.ended with truncation flag', () => {
    const projector = makeProjector({ maxTextChars: 10 });
    projector.handleEvent(turnStarted());
    projector.handleEvent(assistantDelta('abcdef'));
    projector.handleEvent(assistantDelta('ghijklm'));
    expect(projector.snapshotTimeline()).toHaveLength(0);
    projector.handleEvent(turnEnded());
    const [entry] = projector.snapshotTimeline();
    expect(entry).toMatchObject({ kind: 'assistant-turn', text: 'abcdefghij', truncated: true });
  });

  it('status entries are emitted only on value change', () => {
    const projector = makeProjector();
    projector.onStatusPhase('thinking');
    projector.onStatusPhase('thinking');
    projector.onStatusPhase('composing');
    projector.onStatusPhase('composing');
    const snapshot = projector.snapshotTimeline();
    expect(snapshot).toHaveLength(2);
    expect(snapshot.map((entry) => (entry as { phase: string }).phase)).toEqual(['thinking', 'composing']);
  });

  it('card open/settle entries round-trip through the entry points', () => {
    const projector = makeProjector();
    projector.onCardOpened('approval', 'approval_1', {} as never);
    projector.onCardSettled('approval_1', 'approved');
    const snapshot = projector.snapshotTimeline();
    expect(snapshot[0]).toMatchObject({
      kind: 'card-opened',
      card: { cardId: 'approval_1', kind: 'approval' },
    });
    expect(snapshot[1]).toMatchObject({ kind: 'card-settled', cardId: 'approval_1', outcome: 'approved' });
  });
});

describe('O4 entry production returns', () => {
  it('producer methods return the freshly pushed entry', () => {
    const projector = makeProjector();
    const user = projector.onTranscriptEntry(userEntry('hello'));
    expect(user).toMatchObject({ seq: 1, kind: 'user-message', text: 'hello' });

    const turnStart = projector.handleEvent(turnStarted());
    expect(turnStart).toBeUndefined();
    const delta = projector.handleEvent(assistantDelta('partial'));
    expect(delta).toBeUndefined();
    const turnEnd = projector.handleEvent(turnEnded());
    expect(turnEnd).toMatchObject({ seq: 2, kind: 'assistant-turn', text: 'partial', truncated: false });

    const toolCall = projector.handleEvent(toolCallStarted({}));
    expect(toolCall).toMatchObject({ seq: 3, kind: 'tool-call', toolCallId: 'tc1' });
    const toolRes = projector.handleEvent(toolResult({}));
    expect(toolRes).toMatchObject({ seq: 4, kind: 'tool-result', toolCallId: 'tc1' });

    const opened = projector.onCardOpened('approval', 'approval_1', {} as never);
    expect(opened).toMatchObject({ seq: 5, kind: 'card-opened' });
    const settled = projector.onCardSettled('approval_1', 'approved');
    expect(settled).toMatchObject({ seq: 6, kind: 'card-settled', cardId: 'approval_1' });

    const status = projector.onStatusPhase('thinking');
    expect(status).toMatchObject({ seq: 7, kind: 'status', phase: 'thinking' });
    expect(projector.onStatusPhase('thinking')).toBeUndefined();
  });

  it('returned entries match the ring snapshot and stay undefined when nothing is produced', () => {
    const projector = makeProjector();
    const produced = projector.onTranscriptEntry(userEntry('one'));
    const snapshot = projector.snapshotTimeline();
    expect(snapshot).toHaveLength(1);
    expect(produced).toEqual(snapshot[0]);

    expect(projector.onTranscriptEntry({ id: 'e2', kind: 'assistant', renderMode: 'plain', content: 'x' })).toBeUndefined();
    expect(projector.onTranscriptEntry(userEntry('   '))).toBeUndefined();
    expect(projector.handleEvent(foreignEvent('usage.updated'))).toBeUndefined();
    expect(projector.handleEvent(turnEnded())).toBeUndefined();
    expect(projector.snapshotTimeline()).toHaveLength(1);
  });

  it('an empty-turn flush returns undefined and clears the turn state', () => {
    const projector = makeProjector();
    projector.handleEvent(turnStarted());
    expect(projector.handleEvent(turnEnded())).toBeUndefined();
    expect(projector.snapshotTimeline()).toEqual([]);
  });
});

describe('O5 overview sampling', () => {
  it('A1: rev strictly increases on consecutive samples', () => {
    const projector = makeProjector();
    const first = sample(projector);
    const second = sample(projector);
    const third = sample(projector);
    expect(second.rev).toBeGreaterThan(first.rev);
    expect(third.rev).toBeGreaterThan(second.rev);
  });

  it('A2: GoalSnapshot passes through unchanged', () => {
    const projector = makeProjector();
    const goal: GoalSnapshot = {
      goalId: 'g1',
      objective: 'ship the feature',
      completionCriterion: 'tests green',
      status: 'active',
      turnsUsed: 3,
      tokensUsed: 12345,
      wallClockMs: 6789,
      budget: {
        tokenBudget: 50000,
        turnBudget: null,
        wallClockBudgetMs: null,
        remainingTokens: 37655,
        remainingTurns: null,
        remainingWallClockMs: null,
        tokenBudgetReached: false,
        turnBudgetReached: false,
        wallClockBudgetReached: false,
        overBudget: false,
      },
    };
    const overview = sample(projector, { goal });
    expect(overview.goal).toEqual(goal);
  });

  it('A2: null goal passes through as null', () => {
    const projector = makeProjector();
    expect(sample(projector).goal).toBeNull();
  });

  it('A3: subagent folds are bounded and keep the newest', () => {
    const projector = makeProjector({ maxFoldLength: 3 });
    for (let index = 0; index < 5; index += 1) {
      projector.handleEvent(subagentEvent('subagent.spawned', `sub-${String(index)}`));
    }
    const overview = sample(projector);
    expect(overview.subagents).toHaveLength(3);
    expect(overview.subagents.map((fold) => fold['subagentId'])).toEqual(['sub-2', 'sub-3', 'sub-4']);
  });

  it('A3: background task folds are bounded and keep the newest', () => {
    const projector = makeProjector({ maxFoldLength: 2 });
    projector.handleEvent(backgroundTaskEvent('background.task.started', 't1'));
    projector.handleEvent(backgroundTaskEvent('background.task.terminated', 't1'));
    projector.handleEvent(backgroundTaskEvent('background.task.started', 't2'));
    projector.handleEvent(backgroundTaskEvent('background.task.terminated', 't2'));
    const overview = sample(projector);
    expect(overview.backgroundTasks).toHaveLength(2);
    expect(overview.backgroundTasks.map((fold) => fold['taskId'])).toEqual(['t2', 't2']);
  });

  it('A3: fold payloads keep H1 event fields verbatim', () => {
    const projector = makeProjector();
    projector.handleEvent(subagentEvent('subagent.completed', 'sub-9'));
    const [fold] = projector.eventFolds;
    expect(fold).toMatchObject({ category: 'subagent', type: 'subagent.completed', subagentId: 'sub-9' });
  });

  it('models carry alias, displayName and segmentsFor efforts', () => {
    const projector = makeProjector();
    const overview = sample(projector);
    expect(overview.models).toEqual([
      { alias: 'kimi', displayName: 'Kimi for Coding', efforts: ['off', 'low', 'high'] },
    ]);
  });

  it('P1: lastLine uses accumulated turn text while a turn is running', () => {
    const projector = makeProjector();
    projector.handleEvent(turnStarted());
    projector.handleEvent(assistantDelta('first line\nsecond line\n\n'));
    const overview = sample(projector);
    expect(overview.lastLine).toBe('second line');
  });

  it('P1: lastLine falls back to the previous assistant message after the turn ends', () => {
    const projector = makeProjector();
    projector.handleEvent(turnStarted());
    projector.handleEvent(assistantDelta('answer line'));
    projector.handleEvent(turnEnded());
    const overview = sample(projector);
    expect(overview.lastLine).toBe('answer line');
  });

  it('P1: lastLine truncates overlong text', () => {
    const projector = makeProjector({ maxTextChars: 8 });
    projector.handleEvent(turnStarted());
    projector.handleEvent(assistantDelta('a-very-long-final-line'));
    const overview = sample(projector);
    expect(overview.lastLine).toBe('a-very-l');
  });

  it('carries app-state fields verbatim', () => {
    const projector = makeProjector();
    const overview = sample(projector, {
      streamingPhase: 'thinking',
      isCompacting: true,
      model: 'other',
      thinkingEffort: 'low',
      permissionMode: 'yolo',
      planMode: true,
      contextUsage: 0.75,
    });
    expect(overview).toMatchObject({
      phase: 'thinking',
      isCompacting: true,
      model: 'other',
      thinkingEffort: 'low',
      permissionMode: 'yolo',
      planMode: true,
      contextUsage: 0.75,
    });
    expect(overview.todos).toEqual([
      { title: 'first', status: 'pending' },
      { title: 'second', status: 'done' },
    ]);
  });
});
