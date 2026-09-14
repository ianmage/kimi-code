import { describe, expect, it } from 'vitest';

import type { Event } from '@moonshot-ai/kimi-code-sdk';
import type { Entry, UplinkFrame } from '@moonshot-ai/forum-link';

import { ForumLinkController, Projector } from '#/tui/controllers/forum-link';
import type { ApprovalPanelData } from '#/tui/reverse-rpc/types';
import type { TranscriptEntry } from '#/tui/types';

const SESSION_ID = 's1';

type MessageEntry = Extract<
  Extract<UplinkFrame, { type: 'entry' }>['entry'],
  { kind: 'message' }
>;

function entries(frames: readonly UplinkFrame[]) {
  return frames.filter((frame) => frame.type === 'entry').map((frame) => frame.entry);
}

function messageEntries(frames: readonly UplinkFrame[]): MessageEntry[] {
  return entries(frames).filter((entry): entry is MessageEntry => entry.kind === 'message');
}

type StatusEntry = Extract<Entry, { kind: 'status-marker' }>;
type ApprovalEntry = Extract<Entry, { kind: 'approval-card' }>;

function statusEntries(frames: readonly UplinkFrame[]): StatusEntry['status'][] {
  return entries(frames)
    .filter((entry): entry is StatusEntry => entry.kind === 'status-marker')
    .map((entry) => entry.status);
}

function promptSubmitted(text: string): Event {
  return {
    type: 'prompt.submitted',
    promptId: 'p1',
    userMessageId: 'um1',
    status: 'running',
    content: [{ type: 'text', text }],
    createdAt: '2025-01-01T00:00:00.000Z',
    agentId: 'main',
    sessionId: SESSION_ID,
  };
}

function turnStarted(turnId = 1): Event {
  return { type: 'turn.started', turnId, origin: { kind: 'user' }, agentId: 'main', sessionId: SESSION_ID };
}

function turnEnded(reason: 'completed' | 'cancelled' = 'completed', turnId = 1): Event {
  return { type: 'turn.ended', turnId, reason, agentId: 'main', sessionId: SESSION_ID };
}

function assistantDelta(delta: string, agentId = 'main'): Event {
  return { type: 'assistant.delta', turnId: 1, delta, agentId, sessionId: SESSION_ID };
}

function thinkingDelta(delta: string): Event {
  return { type: 'thinking.delta', turnId: 1, delta, agentId: 'main', sessionId: SESSION_ID };
}

function toolCallStarted(): Event {
  return {
    type: 'tool.call.started',
    turnId: 1,
    toolCallId: 't1',
    name: 'Read',
    args: { path: 'src/main.ts' },
    agentId: 'main',
    sessionId: SESSION_ID,
  };
}

function shellOutput(): Event {
  return {
    type: 'shell.output',
    commandId: 'cmd-1',
    update: { kind: 'stdout', text: 'SECRET-SHELL-OUTPUT' },
    agentId: 'main',
    sessionId: SESSION_ID,
  };
}

function subagentSpawned(): Event {
  return {
    type: 'subagent.spawned',
    subagentId: 'agent-sub-1',
    subagentName: 'researcher',
    parentToolCallId: 't1',
    runInBackground: false,
    agentId: 'main',
    sessionId: SESSION_ID,
  };
}

function subagentCompleted(): Event {
  return {
    type: 'subagent.completed',
    subagentId: 'agent-sub-1',
    resultSummary: 'done',
    agentId: 'main',
    sessionId: SESSION_ID,
  };
}

function approvalPayload(): ApprovalPanelData {
  return {
    id: 'up-1',
    tool_call_id: 'tc1',
    tool_name: 'Bash',
    action: 'rm -rf /tmp/x',
    description: '删除临时目录',
    display: [],
    choices: [
      { label: 'Allow', response: 'approved' },
      { label: 'Allow for session', response: 'approved_for_session' },
      { label: 'Deny', response: 'rejected' },
    ],
  };
}

function replayUserEntry(index: number): TranscriptEntry {
  return {
    id: `replay-e${String(index)}`,
    kind: 'user',
    turnId: 'replay:3',
    renderMode: 'markdown',
    content: `回放期间的用户消息 ${String(index)}`,
  };
}

function makeProjector() {
  const frames: UplinkFrame[] = [];
  const projector = new Projector({
    emit: (frame) => {
      frames.push(frame);
    },
  });
  return { frames, projector };
}

function makeController() {
  const frames: UplinkFrame[] = [];
  const controller = new ForumLinkController({
    onProjectorFrame: (frame) => {
      frames.push(frame);
    },
  });
  return { controller, frames };
}

describe('Layer2 离线干跑 — 复合会话帧流（CP3 / O-1 IV1）', () => {
  it('思考、工具、子代理、取消混排的单轮：帧流恰为 L1 且零泄漏', () => {
    const { frames, projector } = makeProjector();
    projector.handleEvent(promptSubmitted('帮我分析这个项目'));
    projector.handleEvent(turnStarted());
    projector.handleEvent(thinkingDelta('内部思考内容不应泄漏 SECRET-THINKING'));
    projector.handleEvent(toolCallStarted());
    projector.handleEvent(shellOutput());
    projector.handleEvent(subagentSpawned());
    projector.handleEvent(assistantDelta('SECRET-SUBAGENT-TEXT', 'agent-sub-1'));
    projector.handleEvent(subagentCompleted());
    projector.handleEvent(assistantDelta('这是主代理'));
    projector.handleEvent(assistantDelta('的最终回答'));
    projector.handleEvent(turnEnded('completed'));

    expect(messageEntries(frames).filter((entry) => entry.role === 'user')).toEqual([
      { kind: 'message', role: 'user', text: '帮我分析这个项目' },
    ]);
    expect(messageEntries(frames).filter((entry) => entry.role === 'assistant')).toEqual([
      { kind: 'message', role: 'assistant', text: '这是主代理的最终回答' },
    ]);
    expect(statusEntries(frames)).toEqual(['running', 'idle']);
    expect(entries(frames)).toHaveLength(4);

    const serialized = JSON.stringify(frames);
    for (const secret of [
      'SECRET-THINKING',
      'SECRET-SHELL-OUTPUT',
      'SECRET-SUBAGENT-TEXT',
      'tool.call',
      'Read',
      'shell',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe('Layer2 离线干跑 — 审批卡 + ESC 取消（CP3 / O-1 IV2）', () => {
  it('取消结算开放审批卡，部分文本仍 flush，approval 卡不开 waiting-question', () => {
    const { frames, projector } = makeProjector();
    projector.handleEvent(turnStarted());
    projector.handleEvent(assistantDelta('我需要执行危险命令'));
    projector.onCardOpened('approval', 'up-1', approvalPayload());
    projector.handleEvent(turnEnded('cancelled'));

    const approvalFrames = entries(frames).filter(
      (entry): entry is ApprovalEntry => entry.kind === 'approval-card',
    );
    expect(approvalFrames).toEqual([
      {
        kind: 'approval-card',
        cardId: 'up-1',
        toolName: 'Bash',
        action: 'rm -rf /tmp/x',
        summary: '删除临时目录',
      },
    ]);
    expect(Object.keys(approvalFrames[0] ?? {}).toSorted()).toEqual([
      'action',
      'cardId',
      'kind',
      'summary',
      'toolName',
    ]);

    const serialized = JSON.stringify(frames);
    expect(serialized).not.toContain('Allow for session');
    expect(serialized).not.toContain('scope');
    expect(serialized).not.toContain('approved_for_session');

    expect(entries(frames)).toContainEqual({ kind: 'card-settled', cardId: 'up-1', outcome: 'cancelled' });
    expect(messageEntries(frames)).toEqual([
      { kind: 'message', role: 'assistant', text: '我需要执行危险命令' },
    ]);
    expect(statusEntries(frames)).toEqual(['running', 'idle']);
  });

  it('Controller S3 路径：upstreamId 翻译为线程内 cardId 后取消结算', () => {
    const { controller, frames } = makeController();
    controller.onCardOpened('approval', 'up-1', approvalPayload());
    controller.onCardClosed('approval', 'up-1', 'cancelled');

    expect(entries(frames)).toEqual([
      {
        kind: 'approval-card',
        cardId: 'c1',
        toolName: 'Bash',
        action: 'rm -rf /tmp/x',
        summary: '删除临时目录',
      },
      { kind: 'card-settled', cardId: 'c1', outcome: 'cancelled' },
    ]);
  });
});

describe('Layer2 离线干跑 — 状态位去抖计数（CP3 / O-1 IV3）', () => {
  it('连续两轮无卡片：status-marker 恰 4 条，值序列 running/idle 交替', () => {
    const { frames, projector } = makeProjector();
    projector.handleEvent(turnStarted(1));
    projector.handleEvent(assistantDelta('第一轮'));
    projector.handleEvent(turnEnded('completed', 1));
    projector.handleEvent(turnStarted(2));
    projector.handleEvent(assistantDelta('第二轮'));
    projector.handleEvent(turnEnded('completed', 2));

    expect(statusEntries(frames)).toEqual(['running', 'idle', 'running', 'idle']);
    expect(entries(frames)).toHaveLength(6);
  });
});

describe('Layer2 离线干跑 — 回放零 user 帧（A7 / F1）', () => {
  it('replay transcript 条目流经 onTranscriptEntry 零帧，Projector 无该方法', () => {
    const { controller, frames } = makeController();
    for (let i = 0; i < 10; i += 1) {
      controller.onTranscriptEntry(replayUserEntry(i));
    }
    expect(frames).toEqual([]);

    const { projector } = makeProjector();
    expect('onTranscriptEntry' in projector).toBe(false);
  });
});

describe('Layer2 离线干跑 — 未 start 零副作用（S-2 A4）', () => {
  it('构造后 detached、订阅零、emit 收集器空', () => {
    const { controller, frames } = makeController();
    expect(controller.state).toBe('detached');
    const { projector } = makeProjector();
    expect(projector.subscriptionCount).toBe(0);
    expect(frames).toEqual([]);
  });
});
