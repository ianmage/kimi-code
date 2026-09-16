import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Event, Session } from '@moonshot-ai/kimi-code-sdk';
import type { Entry, UplinkFrame } from '@moonshot-ai/forum-link';

import {
  ForumLinkController,
  Projector,
  type ProjectorOptions,
} from '#/tui/controllers/forum-link';
import type { ApprovalPanelData, QuestionPanelData } from '#/tui/reverse-rpc/types';
import type { TranscriptEntry } from '#/tui/types';

function makeProjector(overrides: Pick<ProjectorOptions, 'limits' | 'mainAgentId'> = {}) {
  const frames: UplinkFrame[] = [];
  const projector = new Projector({
    emit: (frame) => {
      frames.push(frame);
    },
    limits: overrides.limits,
    mainAgentId: overrides.mainAgentId,
  });
  return { frames, projector };
}

type MessageEntry = Extract<Entry, { kind: 'message' }>;

function entries(frames: readonly UplinkFrame[]): Entry[] {
  return frames.filter((frame) => frame.type === 'entry').map((frame) => frame.entry);
}

function messageEntries(frames: readonly UplinkFrame[]): MessageEntry[] {
  return entries(frames).filter((entry): entry is MessageEntry => entry.kind === 'message');
}

function turnStarted(turnId = 1, agentId = 'main'): Event {
  return { type: 'turn.started', turnId, origin: { kind: 'user' }, agentId, sessionId: 's1' };
}

function turnEnded(
  reason: 'completed' | 'cancelled' | 'failed' | 'blocked' = 'completed',
  turnId = 1,
  agentId = 'main',
): Event {
  return { type: 'turn.ended', turnId, reason, agentId, sessionId: 's1' };
}

function assistantDelta(delta: string, turnId = 1, agentId = 'main'): Event {
  return { type: 'assistant.delta', turnId, delta, agentId, sessionId: 's1' };
}

function promptSubmitted(
  content: ReadonlyArray<{ type: 'text'; text: string }>,
  status: 'running' | 'queued' | 'blocked' = 'running',
  agentId = 'main',
): Event {
  return {
    type: 'prompt.submitted',
    promptId: 'p1',
    userMessageId: 'um1',
    status,
    content,
    createdAt: '2025-01-01T00:00:00.000Z',
    agentId,
    sessionId: 's1',
  };
}

function foreignEvent(type: string): Event {
  return { type, agentId: 'main', sessionId: 's1' } as Event;
}

function thinkingDelta(delta: string, turnId = 1, agentId = 'main'): Event {
  return { type: 'thinking.delta', turnId, delta, agentId, sessionId: 's1' };
}

function toolCallStarted(agentId = 'main'): Event {
  return {
    type: 'tool.call.started',
    turnId: 1,
    toolCallId: 'tc1',
    name: 'Bash',
    args: {},
    agentId,
    sessionId: 's1',
  };
}


function approvalPayload(id: string): ApprovalPanelData {
  return {
    id,
    tool_call_id: `tc-${id}`,
    tool_name: 'Bash',
    action: 'rm -rf',
    description: '危险操作',
    display: [],
    choices: [
      { label: 'Approve', response: 'approved' },
      { label: 'Approve for session', response: 'approved_for_session' },
      { label: 'Reject', response: 'rejected' },
    ],
  };
}

function questionPayload(id: string): QuestionPanelData {
  return {
    id,
    tool_call_id: `tc-${id}`,
    questions: [
      {
        question: '选哪个?',
        multi_select: true,
        other_label: '其他',
        options: [{ label: 'A' }, { label: 'B', description: 'second option' }],
      },
    ],
  };
}

function userEntry(overrides: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return { id: 'e1', kind: 'user', renderMode: 'markdown', content: 'hi', ...overrides };
}

describe('Projector — agentId 闸门先于类型判别', () => {
  it('子代理事件零投影：无帧且状态不变', () => {
    const { frames, projector } = makeProjector();
    projector.handleEvent(turnStarted(1, 'sub-1'));
    projector.handleEvent(assistantDelta('sub text', 1, 'sub-1'));
    projector.handleEvent(turnEnded('completed', 1, 'sub-1'));
    expect(frames).toEqual([]);
    expect(projector.status).toBe('idle');
  });

  it('mainAgentId 可注入', () => {
    const { frames, projector } = makeProjector({ mainAgentId: 'primary' });
    projector.handleEvent(turnStarted(1, 'main'));
    projector.handleEvent(turnStarted(1, 'primary'));
    expect(entries(frames)).toEqual([{ kind: 'status-marker', status: 'running' }]);
  });
});

describe('Projector — 事件类型白名单', () => {
  it('白名单外的主代理事件零帧', () => {
    const types = [
      'thinking.delta',
      'tool.call.started',
      'tool.progress',
      'tool.result',
      'shell.output',
      'shell.started',
      'subagent.spawned',
      'subagent.completed',
      'turn.step.started',
      'session.meta.updated',
      'error',
    ];
    for (const type of types) {
      const { frames, projector } = makeProjector();
      projector.handleEvent(foreignEvent(type));
      expect(frames, `event type ${type} must produce zero frames`).toEqual([]);
    }
  });
});

describe('Projector — 单轮单帧', () => {
  it('累积 delta 在轮末产出恰一个 assistant 消息帧，中途无增量帧', () => {
    const { frames, projector } = makeProjector();
    projector.handleEvent(turnStarted());
    projector.handleEvent(assistantDelta('a'));
    projector.handleEvent(assistantDelta('b'));
    projector.handleEvent(assistantDelta('c'));
    projector.handleEvent(turnEnded('completed'));
    expect(entries(frames)).toEqual([
      { kind: 'status-marker', status: 'running' },
      { kind: 'message', role: 'assistant', text: 'abc' },
      { kind: 'status-marker', status: 'idle' },
    ]);
  });

  it('注入 maxTextChars 截断并标记 truncated', () => {
    const { frames, projector } = makeProjector({ limits: { maxTextChars: 10 } });
    projector.handleEvent(turnStarted());
    projector.handleEvent(assistantDelta('a'.repeat(10)));
    projector.handleEvent(assistantDelta('b'.repeat(10)));
    projector.handleEvent(assistantDelta('c'.repeat(5)));
    projector.handleEvent(turnEnded('completed'));
    expect(messageEntries(frames)).toEqual([
      { kind: 'message', role: 'assistant', text: 'a'.repeat(10), truncated: true },
    ]);
  });

  it('cancelled 轮仍 flush 部分文本', () => {
    const { frames, projector } = makeProjector();
    projector.handleEvent(turnStarted());
    projector.handleEvent(assistantDelta('x'));
    projector.handleEvent(assistantDelta('y'));
    projector.handleEvent(turnEnded('cancelled'));
    expect(entries(frames)).toEqual([
      { kind: 'status-marker', status: 'running' },
      { kind: 'message', role: 'assistant', text: 'xy' },
      { kind: 'status-marker', status: 'idle' },
    ]);
  });

  it('无 delta 的轮不产消息帧，仅状态帧', () => {
    const { frames, projector } = makeProjector();
    projector.handleEvent(turnStarted());
    projector.handleEvent(turnEnded('completed'));
    expect(entries(frames)).toEqual([
      { kind: 'status-marker', status: 'running' },
      { kind: 'status-marker', status: 'idle' },
    ]);
  });

  it('默认 maxTextChars=4000', () => {
    const { frames, projector } = makeProjector();
    projector.handleEvent(turnStarted());
    for (let i = 0; i < 5; i += 1) {
      projector.handleEvent(assistantDelta('x'.repeat(1000)));
    }
    projector.handleEvent(turnEnded('completed'));
    expect(messageEntries(frames)).toEqual([
      { kind: 'message', role: 'assistant', text: 'x'.repeat(4000), truncated: true },
    ]);
  });
});

describe('Projector — prompt.submitted 用户消息', () => {
  it('从 TextPart 拼接用户消息文本', () => {
    const { frames, projector } = makeProjector();
    projector.handleEvent(
      promptSubmitted([
        { type: 'text', text: '你好' },
        { type: 'text', text: '世界' },
      ]),
    );
    expect(messageEntries(frames)).toEqual([{ kind: 'message', role: 'user', text: '你好世界' }]);
  });

  it('blocked 状态的提交零帧，queued 正常投影', () => {
    const blocked = makeProjector();
    blocked.projector.handleEvent(promptSubmitted([{ type: 'text', text: 'hi' }], 'blocked'));
    expect(blocked.frames).toEqual([]);

    const queued = makeProjector();
    queued.projector.handleEvent(promptSubmitted([{ type: 'text', text: 'hi' }], 'queued'));
    expect(messageEntries(queued.frames)).toEqual([{ kind: 'message', role: 'user', text: 'hi' }]);
  });

  it('无文本部分的提交零帧', () => {
    const { frames, projector } = makeProjector();
    const event: Event = {
      type: 'prompt.submitted',
      promptId: 'p1',
      userMessageId: 'um1',
      status: 'running',
      content: [{ type: 'tool_result', tool_call_id: 'tc1', output: 'o' }],
      createdAt: '2025-01-01T00:00:00.000Z',
      agentId: 'main',
      sessionId: 's1',
    };
    projector.handleEvent(event);
    expect(frames).toEqual([]);
  });
});

describe('Projector — 卡片投影', () => {
  it('approval 卡帧恰含五个白名单键', () => {
    const { frames, projector } = makeProjector();
    projector.onCardOpened('approval', 'c1', approvalPayload('ap-1'));
    const [entry] = entries(frames);
    expect(entry).toEqual({
      kind: 'approval-card',
      cardId: 'c1',
      toolName: 'Bash',
      action: 'rm -rf',
      summary: '危险操作',
    });
    expect(Object.keys(entry ?? {}).toSorted()).toEqual([
      'action',
      'cardId',
      'kind',
      'summary',
      'toolName',
    ]);
  });

  it('question 卡帧恰含四个白名单键，多问只取第一问', () => {
    const { frames, projector } = makeProjector();
    projector.onCardOpened('question', 'c1', questionPayload('qp-1'));
    const [entry] = entries(frames);
    expect(entry).toEqual({
      kind: 'question-card',
      cardId: 'c1',
      question: '选哪个?',
      options: ['A', 'B'],
    });
    expect(Object.keys(entry ?? {}).toSorted()).toEqual(['cardId', 'kind', 'options', 'question']);
  });

  it('onCardClosed 产 card-settled 帧，未知 cardId 零帧', () => {
    const { frames, projector } = makeProjector();
    projector.onCardOpened('question', 'c1', questionPayload('qp-1'));
    projector.onCardClosed('question', 'c1', 'answered');
    projector.onCardClosed('question', 'c9', 'answered');
    expect(entries(frames)).toEqual([
      { kind: 'question-card', cardId: 'c1', question: '选哪个?', options: ['A', 'B'] },
      { kind: 'card-settled', cardId: 'c1', outcome: 'answered' },
    ]);
  });

  it('turn.ended(cancelled) 结算本轮开放卡', () => {
    const { frames, projector } = makeProjector();
    projector.handleEvent(turnStarted());
    projector.onCardOpened('approval', 'c1', approvalPayload('ap-1'));
    projector.handleEvent(turnEnded('cancelled'));
    expect(entries(frames)).toEqual([
      { kind: 'status-marker', status: 'running' },
      { kind: 'approval-card', cardId: 'c1', toolName: 'Bash', action: 'rm -rf', summary: '危险操作' },
      { kind: 'card-settled', cardId: 'c1', outcome: 'cancelled' },
      { kind: 'status-marker', status: 'idle' },
    ]);
  });

  it('turn.ended(completed) 不结算开放卡', () => {
    const { frames, projector } = makeProjector();
    projector.handleEvent(turnStarted());
    projector.onCardOpened('approval', 'c1', approvalPayload('ap-1'));
    projector.handleEvent(turnEnded('completed'));
    expect(entries(frames).some((entry) => entry.kind === 'card-settled')).toBe(false);
  });
});

describe('Projector — 状态位去抖', () => {
  it('重复 turn.started / turn.ended 只发一次帧，两轮共四次状态帧', () => {
    const { frames, projector } = makeProjector();
    projector.handleEvent(turnStarted());
    projector.handleEvent(turnStarted());
    projector.handleEvent(turnEnded('completed'));
    projector.handleEvent(turnEnded('completed'));
    projector.handleEvent(turnStarted());
    projector.handleEvent(turnEnded('completed'));
    expect(entries(frames)).toEqual([
      { kind: 'status-marker', status: 'running' },
      { kind: 'status-marker', status: 'idle' },
      { kind: 'status-marker', status: 'running' },
      { kind: 'status-marker', status: 'idle' },
    ]);
  });

  it('question 卡开关驱动 waiting-question 状态往返', () => {
    const { frames, projector } = makeProjector();
    projector.handleEvent(turnStarted());
    projector.onCardOpened('question', 'c1', questionPayload('qp-1'));
    projector.onCardClosed('question', 'c1', 'answered');
    expect(entries(frames)).toEqual([
      { kind: 'status-marker', status: 'running' },
      { kind: 'question-card', cardId: 'c1', question: '选哪个?', options: ['A', 'B'] },
      { kind: 'status-marker', status: 'waiting-question' },
      { kind: 'card-settled', cardId: 'c1', outcome: 'answered' },
      { kind: 'status-marker', status: 'running' },
    ]);
  });
});

describe('Projector — attach / detach', () => {
  it('独立订阅一次，detach 幂等且复位状态', () => {
    const { frames, projector } = makeProjector();
    expect(projector.subscriptionCount).toBe(0);

    const unsubscribe = vi.fn();
    const listeners: Array<(event: Event) => void> = [];
    const session = {
      onEvent: (listener: (event: Event) => void) => {
        listeners.push(listener);
        return unsubscribe;
      },
    } as unknown as Session;

    projector.attach(session);
    expect(projector.subscriptionCount).toBe(1);

    listeners[0]?.(turnStarted());
    expect(entries(frames)).toEqual([{ kind: 'status-marker', status: 'running' }]);
    expect(projector.status).toBe('running');

    projector.detach();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(projector.subscriptionCount).toBe(0);
    expect(projector.status).toBe('idle');

    projector.detach();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(projector.subscriptionCount).toBe(0);

    projector.attach(session);
    expect(projector.subscriptionCount).toBe(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('ForumLinkController — Projector 最小接线', () => {
  function makeController() {
    const frames: UplinkFrame[] = [];
    const controller = new ForumLinkController({
      onProjectorFrame: (frame) => {
        frames.push(frame);
      },
    });
    return { controller, frames };
  }

  it('onCardOpened 经内部 projector 产 approval-card 帧', () => {
    const { controller, frames } = makeController();
    controller.onCardOpened('approval', 'up-1', approvalPayload('up-1'));
    expect(entries(frames)).toEqual([
      {
        kind: 'approval-card',
        cardId: 'c1',
        toolName: 'Bash',
        action: 'rm -rf',
        summary: '危险操作',
      },
    ]);
  });

  it('onCardClosed 缺省 outcome 按卡片类型补全', () => {
    const { controller, frames } = makeController();
    controller.onCardOpened('question', 'up-1', questionPayload('up-1'));
    controller.onCardClosed('question', 'up-1');
    expect(entries(frames)).toEqual([
      { kind: 'question-card', cardId: 'c1', question: '选哪个?', options: ['A', 'B'] },
      { kind: 'card-settled', cardId: 'c1', outcome: 'answered' },
    ]);
  });

  it('显式 outcome 原样透传', () => {
    const { controller, frames } = makeController();
    controller.onCardOpened('approval', 'up-1', approvalPayload('up-1'));
    controller.onCardClosed('approval', 'up-1', 'rejected');
    expect(entries(frames)).toEqual([
      {
        kind: 'approval-card',
        cardId: 'c1',
        toolName: 'Bash',
        action: 'rm -rf',
        summary: '危险操作',
      },
      { kind: 'card-settled', cardId: 'c1', outcome: 'rejected' },
    ]);
  });

  it('未知卡片关闭零帧', () => {
    const { controller, frames } = makeController();
    controller.onCardClosed('approval', 'ghost');
    expect(frames).toEqual([]);
  });

  it('回放 transcript 条目不产生 user 帧（用户消息唯一源是 prompt.submitted）', () => {
    const { controller, frames } = makeController();
    controller.onTranscriptEntry(userEntry({ turnId: 'replay:t1' }));
    controller.onTranscriptEntry(userEntry({ id: 'e2', turnId: 't2' }));
    expect(frames).toEqual([]);
  });
});

describe('Projector — 调试分桶计数（K-3 可观测性）', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('开关关闭：零开销——getStats 为 undefined，投影不受影响', () => {
    vi.stubEnv('KIMI_CODE_FORUM_LINK_DEBUG', undefined);
    const { frames, projector } = makeProjector();
    projector.handleEvent(turnStarted());
    projector.handleEvent(thinkingDelta('thought'));
    projector.handleEvent(toolCallStarted());
    projector.handleEvent(assistantDelta('a'));
    projector.handleEvent(turnEnded('completed'));
    expect(projector.getStats()).toBeUndefined();
    expect(entries(frames)).toEqual([
      { kind: 'status-marker', status: 'running' },
      { kind: 'message', role: 'assistant', text: 'a' },
      { kind: 'status-marker', status: 'idle' },
    ]);
  });

  it('开关开启：按事件类型分桶计数 seen/projected/dropped', () => {
    vi.stubEnv('KIMI_CODE_FORUM_LINK_DEBUG', '1');
    const { projector } = makeProjector();
    projector.handleEvent(turnStarted());
    projector.handleEvent(thinkingDelta('thought'));
    projector.handleEvent(toolCallStarted());
    projector.handleEvent(assistantDelta('SECRET-TOKEN-XYZ'));
    projector.handleEvent(assistantDelta('SECRET-TOKEN-XYZ', 1, 'sub'));
    projector.handleEvent(turnEnded('completed'));

    const stats = projector.getStats();
    expect(stats).toBeDefined();
    expect(stats?.get('thinking.delta')).toEqual({ seen: 1, projected: 0, dropped: 1 });
    expect(stats?.get('tool.call.started')).toEqual({ seen: 1, projected: 0, dropped: 1 });
    expect(stats?.get('turn.started')).toEqual({ seen: 1, projected: 1, dropped: 0 });
    expect(stats?.get('assistant.delta')).toEqual({ seen: 2, projected: 1, dropped: 1 });
    expect(stats?.get('turn.ended')).toEqual({ seen: 1, projected: 1, dropped: 0 });
  });

  it('卡片路径计入 card.opened / card.closed 桶', () => {
    vi.stubEnv('KIMI_CODE_FORUM_LINK_DEBUG', '1');
    const { frames, projector } = makeProjector();
    projector.onCardOpened('approval', 'c1', approvalPayload('ap-1'));
    projector.onCardClosed('approval', 'c1', 'approved');
    projector.onCardClosed('approval', 'ghost', 'approved');
    expect(projector.getStats()?.get('card.opened')).toEqual({ seen: 1, projected: 1, dropped: 0 });
    expect(projector.getStats()?.get('card.closed')).toEqual({ seen: 2, projected: 1, dropped: 1 });
    expect(entries(frames)).toEqual([
      {
        kind: 'approval-card',
        cardId: 'c1',
        toolName: 'Bash',
        action: 'rm -rf',
        summary: '危险操作',
      },
      { kind: 'card-settled', cardId: 'c1', outcome: 'approved' },
    ]);
  });

  it('计数器不记录事件内容——序列化后不含注入的文本', () => {
    vi.stubEnv('KIMI_CODE_FORUM_LINK_DEBUG', '1');
    const { projector } = makeProjector();
    projector.handleEvent(turnStarted());
    projector.handleEvent(assistantDelta('SECRET-TOKEN-XYZ'));
    projector.handleEvent(promptSubmitted([{ type: 'text', text: 'SECRET-TOKEN-XYZ' }]));
    projector.handleEvent(turnEnded('completed'));
    const serialized = JSON.stringify([...(projector.getStats()?.entries() ?? [])]);
    expect(serialized).not.toContain('SECRET-TOKEN-XYZ');
  });
});

