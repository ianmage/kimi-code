import { describe, expect, it } from 'vitest';

import { ForumLinkController } from '#/tui/controllers/forum-link';
import { Projector } from '#/tui/controllers/forum-link/projector';
import type { SampleAppState } from '#/tui/controllers/forum-link/projector';
import type { ApprovalPanelData, QuestionPanelData } from '#/tui/reverse-rpc/types';
import type { TodoItem } from '#/tui/components/chrome/todo-panel';
import { parseCard, parseOverview, parseTimelineEntry } from '@moonshot-ai/forum-link';
import type { Card, TimelineEntry } from '@moonshot-ai/forum-link';
import type { Event, ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import type { TranscriptEntry } from '#/tui/types';

const AGENT = 'main';

function fakeSessionSequence(projector: Projector): void {
  const userEntry: TranscriptEntry = {
    id: 'u1',
    kind: 'user',
    renderMode: 'plain',
    content: 'run the deploy',
  };
  projector.onTranscriptEntry(userEntry);
  const events: Event[] = [
    { type: 'turn.started', turnId: 1, origin: { kind: 'user' }, agentId: AGENT, sessionId: 's1' } as Event,
    { type: 'assistant.delta', turnId: 1, delta: 'deploying', agentId: AGENT, sessionId: 's1' } as Event,
    { type: 'turn.ended', turnId: 1, reason: 'completed', agentId: AGENT, sessionId: 's1' } as Event,
    { type: 'subagent.spawned', subagentId: 'sub-1', agentId: AGENT, sessionId: 's1' } as Event,
    {
      type: 'background.task.started',
      taskId: 't1',
      info: {
        taskId: 't1',
        description: '',
        status: 'running',
        startedAt: 0,
        endedAt: null,
      },
      agentId: AGENT,
      sessionId: 's1',
    } as unknown as Event,
  ];
  for (const event of events) projector.handleEvent(event);
}

describe('layer2 dry-run', () => {
  it('controller constructs and exposes a contract-shaped snapshot', () => {
    const controller = new ForumLinkController({});
    const snapshot = controller.getSnapshot();
    expect(typeof snapshot.workerId).toBe('string');
    expect(snapshot.workerId.length).toBeGreaterThan(0);
    expect(snapshot.threads).toHaveLength(1);
    expect(snapshot.threads[0]!.descriptor.kind).toBe('interactive');
    expect(Array.isArray(snapshot.threads[0]!.timeline)).toBe(true);
    expect(controller.state).toBe('detached');
  });

  it('projector timeline entries conform to the contract schema', () => {
    const projector = new Projector({ mainAgentId: AGENT, now: () => 1000 });
    fakeSessionSequence(projector);
    const entries = projector.snapshotTimeline();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const parsed = parseTimelineEntry(entry);
      expect(parsed.ok).toBe(true);
    }
    const kinds = entries.map((entry) => entry.kind);
    expect(kinds).toContain('user-message');
    expect(kinds).toContain('assistant-turn');
  });

  it('projector overview conforms to the contract schema', () => {
    const projector = new Projector({ mainAgentId: AGENT, now: () => 1000 });
    fakeSessionSequence(projector);
    const overview = projector.sampleOverview(
      {
        streamingPhase: 'idle',
        isCompacting: false,
        model: 'kimi',
        thinkingEffort: 'high',
        permissionMode: 'auto',
        planMode: false,
        contextUsage: 0,
        goal: null,
      },
      [],
      projector.eventFolds,
      {},
      '',
    );
    const parsed = parseOverview(overview);
    expect(parsed.ok).toBe(true);
    expect(overview.subagents).toHaveLength(1);
    expect(overview.backgroundTasks).toHaveLength(1);
  });
});

const OVERVIEW_APP_STATE: SampleAppState = {
  streamingPhase: 'thinking',
  isCompacting: false,
  model: 'kimi',
  thinkingEffort: 'high',
  permissionMode: 'auto',
  planMode: false,
  contextUsage: 0.42,
  goal: null,
};

const OVERVIEW_TODOS: readonly TodoItem[] = [{ title: 'one', status: 'pending' }];

const OVERVIEW_MODELS: Record<string, ModelAlias> = {
  kimi: {
    provider: 'kimi',
    model: 'kimi-for-coding',
    maxContextSize: 262144,
    displayName: 'Kimi for Coding',
    supportEfforts: ['low', 'high'],
    capabilities: ['thinking'],
  },
};

function subagentEvent(type: string, subagentId: string): Event {
  return { type, subagentId, agentId: AGENT, sessionId: 's1' } as Event;
}

function backgroundTaskEvent(type: string, taskId: string): Event {
  return { type, taskId, agentId: AGENT, sessionId: 's1' } as Event;
}

function toolCallStarted(toolCallId: string, name: string, args: unknown): Event {
  return {
    type: 'tool.call.started',
    turnId: 1,
    toolCallId,
    name,
    args,
    agentId: AGENT,
    sessionId: 's1',
  } as unknown as Event;
}

function toolResult(toolCallId: string, output: unknown): Event {
  return {
    type: 'tool.result',
    turnId: 1,
    toolCallId,
    output,
    agentId: AGENT,
    sessionId: 's1',
  } as unknown as Event;
}

describe('layer2 conformance: projector output vs contract parse*', () => {
  it('every timeline kind the projector can emit parses through the contract', () => {
    const projector = new Projector({ mainAgentId: AGENT, now: () => 1000 });
    projector.onTranscriptEntry({ id: 'u1', kind: 'user', renderMode: 'plain', content: 'go' });
    projector.handleEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, agentId: AGENT, sessionId: 's1' } as Event);
    projector.handleEvent({ type: 'assistant.delta', turnId: 1, delta: 'text', agentId: AGENT, sessionId: 's1' } as Event);
    projector.handleEvent({ type: 'turn.ended', turnId: 1, reason: 'completed', agentId: AGENT, sessionId: 's1' } as Event);
    projector.handleEvent(toolCallStarted('tc-1', 'Bash', { command: 'ls' }));
    projector.handleEvent(toolResult('tc-1', 'ok'));
    projector.onCardOpened('approval', 'approval_x', {} as never);
    projector.onCardSettled('approval_x', 'approved');
    projector.onStatusPhase('thinking');
    const entries = projector.snapshotTimeline();
    expect(entries.map((entry) => entry.kind)).toEqual([
      'user-message',
      'assistant-turn',
      'tool-call',
      'tool-result',
      'card-opened',
      'card-settled',
      'status',
    ]);
    for (const entry of entries) {
      const parsed = parseTimelineEntry(entry);
      expect(parsed.ok, `${entry.kind}: ${parsed.ok ? '' : parsed.issues}`).toBe(true);
      if (parsed.ok) expect(parsed.value).toEqual(entry);
    }
  });

  it('timeline entries survive a JSON round-trip before parsing', () => {
    const projector = new Projector({ mainAgentId: AGENT, now: () => 1000 });
    projector.onTranscriptEntry({ id: 'u1', kind: 'user', renderMode: 'plain', content: 'go' });
    projector.handleEvent(toolCallStarted('tc-1', 'Read', { path: 'a.txt' }));
    projector.handleEvent(toolResult('tc-1', 'ok'));
    const roundTripped = JSON.parse(JSON.stringify(projector.snapshotTimeline())) as TimelineEntry[];
    for (const entry of roundTripped) {
      expect(parseTimelineEntry(entry).ok).toBe(true);
    }
  });

  it('overview with subagent and background-task folds parses through the contract', () => {
    const projector = new Projector({ mainAgentId: AGENT, now: () => 1000 });
    projector.handleEvent(subagentEvent('subagent.spawned', 'sub-1'));
    projector.handleEvent(subagentEvent('subagent.completed', 'sub-1'));
    projector.handleEvent(backgroundTaskEvent('background.task.started', 't1'));
    projector.handleEvent(backgroundTaskEvent('background.task.terminated', 't1'));
    const overview = projector.sampleOverview(
      OVERVIEW_APP_STATE,
      OVERVIEW_TODOS,
      projector.eventFolds,
      OVERVIEW_MODELS,
      'last line',
    );
    expect(overview.subagents).toHaveLength(2);
    expect(overview.backgroundTasks).toHaveLength(2);
    const parsed = parseOverview(JSON.parse(JSON.stringify(overview)));
    expect(parsed.ok, parsed.ok ? '' : parsed.issues).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(overview);
  });

  it('approval card with diff lines and plan_body extras parses through the contract', async () => {
    let resolvePlan: ((plan: { id: string; content: string; path: string } | null) => void) | undefined;
    const projector = new Projector({
      mainAgentId: AGENT,
      now: () => 2000,
      getPlan: () =>
        new Promise((resolve) => {
          resolvePlan = resolve;
        }),
    });
    const payload: ApprovalPanelData = {
      id: 'approval_plan',
      tool_call_id: 'tool_plan',
      tool_name: 'ExitPlanMode',
      action: 'review plan',
      description: 'plan review',
      display: [
        {
          type: 'diff',
          path: 'src/a.ts',
          old_text: 'line1\nline2',
          new_text: 'line1\nline2 changed',
        },
      ],
      choices: [
        { label: 'Ship it', response: 'approved' },
        { label: 'Reject', response: 'rejected' },
      ],
    };
    const card = projector.projectCard('approval_plan', payload);
    resolvePlan?.({ id: 'p1', content: '# The plan', path: 'plan.md' });
    await Promise.resolve();
    const extras = projector.planBodyBlock('approval_plan');
    expect(extras).toEqual({ type: 'plan_body', text: '# The plan' });
    const baseApproval = card['approval'] as { display?: unknown[] } | undefined;
    const cardWithExtras: Card = {
      ...card,
      approval: { ...baseApproval, display: [...(baseApproval?.display ?? []), extras] },
    };
    const parsed = parseCard(JSON.parse(JSON.stringify(cardWithExtras)));
    expect(parsed.ok, parsed.ok ? '' : parsed.issues).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(cardWithExtras);
    const approval = cardWithExtras['approval'] as { display?: Array<{ lines?: unknown[] }> } | undefined;
    const diffBlock = approval?.display?.[0];
    expect(diffBlock).toBeDefined();
    expect(Array.isArray(diffBlock?.lines)).toBe(true);
    expect((diffBlock?.lines ?? []).length).toBeGreaterThan(0);
  });

  it('question card parses through the contract', () => {
    const projector = new Projector({ mainAgentId: AGENT, now: () => 3000 });
    const payload: QuestionPanelData = {
      id: 'question_1',
      tool_call_id: 'tool_q',
      questions: [
        {
          question: 'Which database?',
          multi_select: false,
          options: [{ label: 'Postgres' }, { label: 'SQLite' }],
        },
      ],
    };
    const card = projector.projectCard('question_1', payload);
    expect(card.kind).toBe('question');
    const parsed = parseCard(JSON.parse(JSON.stringify(card)));
    expect(parsed.ok, parsed.ok ? '' : parsed.issues).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(card);
  });

  it('truncated cards still parse and carry the truncated flag', () => {
    const projector = new Projector({ mainAgentId: AGENT, now: () => 4000 });
    const longText = 'x'.repeat(5000);
    const payload: ApprovalPanelData = {
      id: 'approval_trunc',
      tool_call_id: 'tool_t',
      tool_name: 'WriteFile',
      action: 'write',
      description: longText,
      display: [{ type: 'brief', text: longText }],
      choices: [{ label: 'Approve once', response: 'approved' }],
    };
    const card = projector.projectCard('approval_trunc', payload);
    expect(card['truncated']).toBe(true);
    const parsed = parseCard(JSON.parse(JSON.stringify(card)));
    expect(parsed.ok, parsed.ok ? '' : parsed.issues).toBe(true);
    const questionPayload: QuestionPanelData = {
      id: 'question_trunc',
      tool_call_id: 'tool_t2',
      questions: [{ question: longText, multi_select: false, options: [{ label: 'A' }] }],
    };
    const questionCard = projector.projectCard('question_trunc', questionPayload);
    expect(questionCard['truncated']).toBe(true);
    expect(parseCard(JSON.parse(JSON.stringify(questionCard))).ok).toBe(true);
  });
});
