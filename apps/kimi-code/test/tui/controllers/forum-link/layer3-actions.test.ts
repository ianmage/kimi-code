import { describe, expect, it, vi } from 'vitest';

import type { Event, Session, Unsubscribe } from '@moonshot-ai/kimi-code-sdk';
import type { UplinkFrame } from '@moonshot-ai/forum-link';

import { ForumLinkController, wrapUiHooksForForumLink } from '#/tui/controllers/forum-link';
import { ApprovalController } from '#/tui/reverse-rpc/approval/controller';
import { QuestionController } from '#/tui/reverse-rpc/question/controller';
import type { ReverseRPCUIHooks } from '#/tui/reverse-rpc/index';
import type { ApprovalPanelData, QuestionPanelData } from '#/tui/reverse-rpc/types';
import type { AppState } from '#/tui/types';

const SESSION_ID = 's1';

type Spy = ReturnType<typeof vi.fn>;

function turnStarted(turnId = 1): Event {
  return { type: 'turn.started', turnId, origin: { kind: 'user' }, agentId: 'main', sessionId: SESSION_ID };
}

function turnEnded(reason: 'completed' | 'cancelled' = 'completed', turnId = 1): Event {
  return { type: 'turn.ended', turnId, reason, agentId: 'main', sessionId: SESSION_ID };
}

function approvalPayload(id: string): ApprovalPanelData {
  return {
    id,
    tool_call_id: `tc-${id}`,
    tool_name: 'Bash',
    action: 'run command',
    description: 'run a command',
    display: [],
    choices: [],
  };
}

function questionPayload(id: string): QuestionPanelData {
  return {
    id,
    tool_call_id: `tc-${id}`,
    questions: [
      { question: '选择哪个方案？', multi_select: false, options: [{ label: '选项A' }, { label: '选项B' }] },
    ],
  };
}

function statusMarkers(frames: readonly UplinkFrame[]): string[] {
  return frames
    .filter((frame) => frame.type === 'entry' && frame.entry.kind === 'status-marker')
    .map((frame) => (frame.type === 'entry' && frame.entry.kind === 'status-marker' ? frame.entry.status : ''));
}

interface Layer3Fixture {
  controller: ForumLinkController;
  approvalController: ApprovalController;
  questionController: QuestionController;
  session: Session;
  frames: UplinkFrame[];
  statuses: string[];
  stateAtCreate: string[];
  cancel: Spy;
  cancelCompaction: Spy;
  sendNormalUserInput: Spy;
  createNewSession: Spy;
  onDroppedAction: Spy;
  emit(event: Event): void;
  publish(): void;
}

interface Layer3Options {
  isCompacting?: boolean;
  idleWaitTimeoutMs?: number;
}

function makeLayer3(options: Layer3Options = {}): Layer3Fixture {
  const frames: UplinkFrame[] = [];
  const statuses: string[] = [];
  const stateAtCreate: string[] = [];
  const approvalController = new ApprovalController();
  const questionController = new QuestionController();
  const cancel = vi.fn(async () => {});
  const cancelCompaction = vi.fn(async () => {});
  const listeners = new Set<(event: Event) => void>();
  const session = {
    id: SESSION_ID,
    onEvent: (l: (event: Event) => void): Unsubscribe => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    cancel,
    cancelCompaction,
  } as unknown as Session;
  const sendNormalUserInput = vi.fn(async () => {});
  const createNewSession = vi.fn(async () => {
    stateAtCreate.push(controller.state);
  });
  const onDroppedAction = vi.fn();
  const controller = new ForumLinkController({
    onProjectorFrame: (frame) => {
      frames.push(frame);
    },
    onStatus: (message) => {
      statuses.push(message);
    },
    getAppState: () => ({ isCompacting: options.isCompacting ?? false }) as AppState,
    approvalController,
    questionController,
    sendNormalUserInput,
    createNewSession,
    onDroppedAction,
    endSessionTiming: { idleWaitTimeoutMs: options.idleWaitTimeoutMs },
  });
  const original: ReverseRPCUIHooks = {
    showApprovalPanel: vi.fn(),
    hideApprovalPanel: vi.fn(),
    showQuestionDialog: vi.fn(),
    hideQuestionDialog: vi.fn(),
  };
  const wrapped = wrapUiHooksForForumLink(original, controller);
  approvalController.setUIHooks({
    showPanel: wrapped.showApprovalPanel,
    hidePanel: wrapped.hideApprovalPanel,
  });
  questionController.setUIHooks({
    showPanel: wrapped.showQuestionDialog,
    hidePanel: wrapped.hideQuestionDialog,
  });
  return {
    controller,
    approvalController,
    questionController,
    session,
    frames,
    statuses,
    stateAtCreate,
    cancel,
    cancelCompaction,
    sendNormalUserInput,
    createNewSession,
    onDroppedAction,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    publish: () => {
      controller.setLinkState('published');
      controller.onSessionChanged(session);
    },
  };
}

describe('Layer3 集成 — 六动作端到端闭环（CP6 / O-2）', () => {
  it('answer-question：远程作答 resolve show promise 为单答案数组并结算 answered 帧', async () => {
    const fixture = makeLayer3();
    fixture.publish();
    const shown = fixture.questionController.show(questionPayload('q-1'));
    expect(fixture.controller.openCards).toEqual([{ cardId: 'c1', kind: 'question', upstreamId: 'q-1' }]);

    fixture.controller.dispatchAction({ type: 'answer-question', target: 't', cardId: 'c1', answer: '选项A' });

    await expect(shown).resolves.toEqual({ answers: ['选项A'] });
    expect(fixture.controller.openCards).toEqual([]);
    expect(fixture.frames).toContainEqual({
      type: 'entry',
      entry: { kind: 'card-settled', cardId: 'c1', outcome: 'answered' },
    });
  });

  it('approve：远程批准 resolve 无 scope 并结算 approved 帧', async () => {
    const fixture = makeLayer3();
    fixture.publish();
    const shown = fixture.approvalController.show(approvalPayload('a-1'));

    fixture.controller.dispatchAction({ type: 'approve', target: 't', cardId: 'c1' });

    const response = await shown;
    expect(response).toEqual({ decision: 'approved' });
    expect(response).not.toHaveProperty('scope');
    expect(fixture.controller.openCards).toEqual([]);
    expect(fixture.frames).toContainEqual({
      type: 'entry',
      entry: { kind: 'card-settled', cardId: 'c1', outcome: 'approved' },
    });
  });

  it('deny：远程拒绝透传 feedback 并结算 rejected 帧', async () => {
    const fixture = makeLayer3();
    fixture.publish();
    const shown = fixture.approvalController.show(approvalPayload('a-1'));

    fixture.controller.dispatchAction({ type: 'deny', target: 't', cardId: 'c1', feedback: '太危险' });

    await expect(shown).resolves.toEqual({ decision: 'rejected', feedback: '太危险' });
    expect(fixture.controller.openCards).toEqual([]);
    expect(fixture.frames).toContainEqual({
      type: 'entry',
      entry: { kind: 'card-settled', cardId: 'c1', outcome: 'rejected' },
    });
  });

  it('send-message：远程留言直发 sendNormalUserInput seam', () => {
    const fixture = makeLayer3();
    fixture.publish();

    fixture.controller.dispatchAction({ type: 'send-message', target: 't', text: '补充指令' });

    expect(fixture.sendNormalUserInput).toHaveBeenCalledTimes(1);
    expect(fixture.sendNormalUserInput).toHaveBeenCalledWith('补充指令');
  });

  it('pause：远程暂停取消当前轮', () => {
    const fixture = makeLayer3();
    fixture.publish();

    fixture.controller.dispatchAction({ type: 'pause', target: 't' });

    expect(fixture.cancel).toHaveBeenCalledTimes(1);
    expect(fixture.cancelCompaction).not.toHaveBeenCalled();
  });

  it('end-session：远程结束触发 cancel → stop → createNewSession 编排', async () => {
    const fixture = makeLayer3({ idleWaitTimeoutMs: 50 });
    fixture.publish();

    fixture.controller.dispatchAction({ type: 'end-session', target: 't' });
    expect(fixture.cancel).toHaveBeenCalledTimes(1);

    fixture.emit(turnEnded('cancelled'));

    await vi.waitFor(() => {
      expect(fixture.createNewSession).toHaveBeenCalledTimes(1);
    });
  });
});

describe('Layer3 集成 — G1 竞态：本地先答，迟到远程动作（CP6 / A6 / I5）', () => {
  it('本地应答 X 后队列推进到 Y：迟到远程 approve 被丢弃，Y 不被错答', async () => {
    const fixture = makeLayer3();
    fixture.publish();
    const respondSpy = vi.spyOn(fixture.approvalController, 'respond');
    const shownX = fixture.approvalController.show(approvalPayload('x-1'));
    const shownY = fixture.approvalController.show(approvalPayload('y-1'));
    expect(fixture.controller.openCards).toEqual([{ cardId: 'c1', kind: 'approval', upstreamId: 'x-1' }]);

    fixture.approvalController.respond({ decision: 'approved' });

    await expect(shownX).resolves.toEqual({ decision: 'approved' });
    expect(fixture.controller.openCards).toEqual([{ cardId: 'c2', kind: 'approval', upstreamId: 'y-1' }]);
    expect(fixture.frames).toContainEqual({
      type: 'entry',
      entry: { kind: 'card-settled', cardId: 'c1', outcome: 'approved' },
    });

    fixture.controller.dispatchAction({ type: 'approve', target: 't', cardId: 'c1' });

    expect(fixture.onDroppedAction).toHaveBeenCalledTimes(1);
    expect(fixture.onDroppedAction).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'approve', cardId: 'c1' }),
    );
    expect(respondSpy).toHaveBeenCalledTimes(1);
    let yResolved = false;
    void shownY.then(() => {
      yResolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(yResolved).toBe(false);
    expect(fixture.controller.openCards).toEqual([{ cardId: 'c2', kind: 'approval', upstreamId: 'y-1' }]);
  });

  it('question 队列同理：本地作答 X 推进 Y，迟到远程作答被丢弃且状态机保持 waiting-question', async () => {
    const fixture = makeLayer3();
    fixture.publish();
    fixture.emit(turnStarted());
    const respondSpy = vi.spyOn(fixture.questionController, 'respond');
    const shownX = fixture.questionController.show(questionPayload('qx-1'));
    const shownY = fixture.questionController.show(questionPayload('qy-1'));
    expect(statusMarkers(fixture.frames)).toEqual(['running', 'waiting-question']);

    fixture.questionController.respond({ answers: ['选项B'] });

    await expect(shownX).resolves.toEqual({ answers: ['选项B'] });
    expect(fixture.controller.openCards).toEqual([{ cardId: 'c2', kind: 'question', upstreamId: 'qy-1' }]);
    expect(fixture.frames).toContainEqual({
      type: 'entry',
      entry: { kind: 'card-settled', cardId: 'c1', outcome: 'answered' },
    });

    fixture.controller.dispatchAction({ type: 'answer-question', target: 't', cardId: 'c1', answer: '迟到' });

    expect(fixture.onDroppedAction).toHaveBeenCalledTimes(1);
    expect(respondSpy).toHaveBeenCalledTimes(1);
    let yResolved = false;
    void shownY.then(() => {
      yResolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(yResolved).toBe(false);
    expect(statusMarkers(fixture.frames)).toEqual([
      'running',
      'waiting-question',
      'running',
      'waiting-question',
    ]);
  });
});

describe('Layer3 集成 — 运行中留言入队（CP6 / A7 / U3）', () => {
  it('轮次运行中远程留言：seam 被调用且不打断当前轮', () => {
    const fixture = makeLayer3();
    fixture.publish();
    fixture.emit(turnStarted());
    expect(statusMarkers(fixture.frames)).toEqual(['running']);

    fixture.controller.dispatchAction({ type: 'send-message', target: 't', text: '留言内容' });

    expect(fixture.sendNormalUserInput).toHaveBeenCalledTimes(1);
    expect(fixture.sendNormalUserInput).toHaveBeenCalledWith('留言内容');
    expect(fixture.cancel).not.toHaveBeenCalled();
    expect(statusMarkers(fixture.frames)).toEqual(['running']);
  });
});

describe('Layer3 集成 — pause 与 end-session 状态序列（CP6 / A8 / A9）', () => {
  it('pause：取消当前轮，turn.ended(cancelled) 后 Projector 回 idle，无异常抛出', () => {
    const fixture = makeLayer3();
    fixture.publish();
    fixture.emit(turnStarted());
    expect(statusMarkers(fixture.frames)).toEqual(['running']);

    expect(() => {
      fixture.controller.dispatchAction({ type: 'pause', target: 't' });
    }).not.toThrow();
    expect(fixture.cancel).toHaveBeenCalledTimes(1);

    fixture.emit(turnEnded('cancelled'));

    expect(statusMarkers(fixture.frames)).toEqual(['running', 'idle']);
  });

  it('end-session：published→detached 状态转移，idle 后 createNewSession', async () => {
    const fixture = makeLayer3({ idleWaitTimeoutMs: 50 });
    fixture.publish();
    fixture.emit(turnStarted());
    expect(fixture.controller.state).toBe('published');
    expect(statusMarkers(fixture.frames)).toEqual(['running']);

    fixture.controller.dispatchAction({ type: 'end-session', target: 't' });
    fixture.emit(turnEnded('cancelled'));

    await vi.waitFor(() => {
      expect(fixture.createNewSession).toHaveBeenCalledTimes(1);
    });
    expect(fixture.stateAtCreate).toEqual(['detached']);
    expect(fixture.controller.state).toBe('detached');
    expect(fixture.statuses).toContain('Forum Link: unpublished');
    expect(statusMarkers(fixture.frames)).toEqual(['running', 'idle']);
  });
});
