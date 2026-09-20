import { describe, expect, it, vi } from 'vitest';

import type { Event, Session, Unsubscribe } from '@moonshot-ai/kimi-code-sdk';
import type { ActionFrame, Descriptor, UplinkFrame } from '@moonshot-ai/forum-link';

import { ForumLinkController } from '#/tui/controllers/forum-link';
import { resolveEndSessionMode } from '#/tui/controllers/forum-link/end-session';
import type { Link } from '#/tui/controllers/forum-link/link';
import type { ApprovalPanelData, QuestionPanelData } from '#/tui/reverse-rpc/types';
import type { AppState } from '#/tui/types';

interface SessionFixture {
  session: Session;
  cancel: ReturnType<typeof vi.fn>;
  cancelCompaction: ReturnType<typeof vi.fn>;
  /** Captured session.onEvent listener; call to emit an event into the session. */
  emit(event: Event): void;
  hasListener(): boolean;
}

function makeSession(id: string): SessionFixture {
  const cancel = vi.fn(async () => {});
  const cancelCompaction = vi.fn(async () => {});
  let listener: ((event: Event) => void) | undefined;
  const session = {
    id,
    onEvent: (l: (event: Event) => void): Unsubscribe => {
      listener = l;
      return () => {
        listener = undefined;
      };
    },
    cancel,
    cancelCompaction,
  } as unknown as Session;
  return {
    session,
    cancel,
    cancelCompaction,
    emit: (event) => {
      listener?.(event);
    },
    hasListener: () => listener !== undefined,
  };
}

function makeAppState(
  isCompacting = false,
  streamingPhase: AppState['streamingPhase'] = 'thinking',
): AppState {
  return { isCompacting, streamingPhase } as AppState;
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
    questions: [{ question: 'Continue?', multi_select: false, options: [{ label: 'yes' }] }],
  };
}

function makeDescriptor(sessionId: string): Omit<Descriptor, 'status'> {
  return {
    sessionId,
    machineName: 'machine-1',
    projectName: 'forum-link',
    title: 'test title',
  };
}

function turnEnded(turnId = 1): Event {
  return { type: 'turn.ended', turnId, reason: 'cancelled', agentId: 'main', sessionId: 's1' };
}

function compactionCancelled(): Event {
  return { type: 'compaction.cancelled', agentId: 'main', sessionId: 's1' };
}

interface ControllerFixture {
  controller: ForumLinkController;
  frames: UplinkFrame[];
  statuses: string[];
  order: string[];
  stateAtCreate: string[];
  createNewSession: ReturnType<typeof vi.fn>;
  buildDescriptor: ReturnType<typeof vi.fn>;
  approvalRespond: ReturnType<typeof vi.fn>;
  questionRespond: ReturnType<typeof vi.fn>;
  sendNormalUserInput: ReturnType<typeof vi.fn>;
  onDroppedAction: ReturnType<typeof vi.fn>;
}

interface FixtureOptions {
  session?: Session;
  appState?: AppState;
  endSessionTiming?: { idleWaitTimeoutMs?: number };
}

function makeController(options: FixtureOptions = {}): ControllerFixture {
  const frames: UplinkFrame[] = [];
  const statuses: string[] = [];
  const order: string[] = [];
  const stateAtCreate: string[] = [];
  const createNewSession = vi.fn(async () => {
    order.push('createNewSession');
    stateAtCreate.push(controller.state);
  });
  const buildDescriptor = vi.fn((session: Session) => makeDescriptor(session.id));
  const approvalRespond = vi.fn();
  const questionRespond = vi.fn();
  const sendNormalUserInput = vi.fn(async () => {});
  const onDroppedAction = vi.fn();
  const controller = new ForumLinkController({
    onProjectorFrame: (frame) => {
      frames.push(frame);
    },
    onStatus: (message) => {
      statuses.push(message);
      if (message === 'Forum Link: unpublished') order.push('stop');
    },
    getAppState: () => options.appState ?? makeAppState(),
    approvalController: { respond: approvalRespond } as never,
    questionController: { respond: questionRespond } as never,
    sendNormalUserInput,
    createNewSession,
    onDroppedAction,
    buildDescriptor,
    endSessionTiming: options.endSessionTiming,
  });
  if (options.session !== undefined) controller.onSessionChanged(options.session);
  return {
    controller,
    frames,
    statuses,
    order,
    stateAtCreate,
    createNewSession,
    buildDescriptor,
    approvalRespond,
    questionRespond,
    sendNormalUserInput,
    onDroppedAction,
  };
}

describe('resolveEndSessionMode — 终止模式判定（O-1）', () => {
  it.each([
    { isCompacting: false, streamingPhase: 'idle', expected: 'immediate' },
    { isCompacting: false, streamingPhase: 'waiting', expected: 'turn' },
    { isCompacting: false, streamingPhase: 'thinking', expected: 'turn' },
    { isCompacting: false, streamingPhase: 'composing', expected: 'turn' },
    { isCompacting: false, streamingPhase: 'shell', expected: 'immediate' },
    { isCompacting: true, streamingPhase: 'idle', expected: 'compaction' },
    { isCompacting: true, streamingPhase: 'waiting', expected: 'compaction' },
    { isCompacting: true, streamingPhase: 'thinking', expected: 'compaction' },
    { isCompacting: true, streamingPhase: 'composing', expected: 'compaction' },
    { isCompacting: true, streamingPhase: 'shell', expected: 'compaction' },
  ])('契约表全组合（isCompacting × streamingPhase → 模式）: %j', (row) => {
    const appState = {
      isCompacting: row.isCompacting,
      streamingPhase: row.streamingPhase,
    } as AppState;
    expect(resolveEndSessionMode(appState)).toBe(row.expected);
  });

  it.each(['idle', 'waiting', 'thinking', 'composing', 'shell'] as const)(
    '压缩优先：isCompacting=true 时 streamingPhase=%s 恒为 compaction',
    (streamingPhase) => {
      expect(resolveEndSessionMode({ isCompacting: true, streamingPhase } as AppState)).toBe(
        'compaction',
      );
    },
  );

  it('undefined 入参 → immediate', () => {
    expect(resolveEndSessionMode(undefined)).toBe('immediate');
  });

  it('纯函数性：同一输入连续两次调用输出一致', () => {
    const appState = { isCompacting: false, streamingPhase: 'thinking' } as AppState;
    expect(resolveEndSessionMode(appState)).toBe(resolveEndSessionMode(appState));
  });

  it('未知相位（部分注入 AppState）→ 保守视为 turn', () => {
    expect(resolveEndSessionMode({ isCompacting: false } as AppState)).toBe('turn');
  });
});

describe('Controller 编排 — end-session 定序（M-2 A3/A4/A5）', () => {
  it('取消 → 等 turn.ended → stop 解除发布 → createNewSession，顺序不可乱', async () => {
    const fixture = makeSession('s1');
    const wired = makeController({
      session: fixture.session,
      appState: makeAppState(false, 'thinking'),
      endSessionTiming: { idleWaitTimeoutMs: 50 },
    });
    wired.controller.setLinkState('published');

    const pending = wired.controller.runEndSession();
    await Promise.resolve();
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
    expect(wired.createNewSession).not.toHaveBeenCalled();
    expect(wired.controller.state).toBe('detached');
    expect(wired.order).toEqual(['stop']);

    fixture.emit(turnEnded());
    await pending;

    expect(wired.createNewSession).toHaveBeenCalledTimes(1);
    expect(wired.order).toEqual(['stop', 'createNewSession']);
    expect(wired.stateAtCreate).toEqual(['detached']);
    expect(wired.controller.state).toBe('detached');
  });

  it('idle 等待超时：放弃新建、保持已解除发布并本地提示', async () => {
    const fixture = makeSession('s1');
    const wired = makeController({
      session: fixture.session,
      appState: makeAppState(false, 'thinking'),
      endSessionTiming: { idleWaitTimeoutMs: 50 },
    });
    wired.controller.setLinkState('published');

    await wired.controller.runEndSession();

    expect(fixture.cancel).toHaveBeenCalledTimes(1);
    expect(wired.createNewSession).not.toHaveBeenCalled();
    expect(wired.controller.state).toBe('detached');
    expect(wired.statuses).toContain(
      'Forum Link: end-session timed out waiting for idle; staying unpublished',
    );
  });

  it('isCompacting 时分派 cancelCompaction 而非 cancel', async () => {
    const fixture = makeSession('s1');
    const wired = makeController({
      session: fixture.session,
      appState: makeAppState(true),
      endSessionTiming: { idleWaitTimeoutMs: 50 },
    });

    const pending = wired.controller.runEndSession();
    fixture.emit(compactionCancelled());
    await pending;

    expect(fixture.cancelCompaction).toHaveBeenCalledTimes(1);
    expect(fixture.cancel).not.toHaveBeenCalled();
    expect(wired.createNewSession).toHaveBeenCalledTimes(1);
  });

  it('未注入 createNewSession 时：取消与解除发布照常完成，新建跳过', async () => {
    const fixture = makeSession('s1');
    const frames: UplinkFrame[] = [];
    const controller = new ForumLinkController({
      onProjectorFrame: (frame) => {
        frames.push(frame);
      },
      getAppState: () => makeAppState(false, 'thinking'),
      approvalController: { respond: vi.fn() } as never,
      questionController: { respond: vi.fn() } as never,
      sendNormalUserInput: vi.fn(async () => {}),
      endSessionTiming: { idleWaitTimeoutMs: 50 },
    });
    controller.onSessionChanged(fixture.session);
    controller.setLinkState('published');

    await controller.runEndSession();

    expect(fixture.cancel).toHaveBeenCalledTimes(1);
    expect(controller.state).toBe('detached');
    expect(controller.session).toBe(fixture.session);
  });
});

describe('Controller 编排 — end-session immediate 路径（M-1 A1/A2/A6）', () => {
  it.each(['idle', 'shell'] as const)(
    'streamingPhase=%s：零 cancel、零等待、stop → createNewSession 收敛',
    async (streamingPhase) => {
      const fixture = makeSession('s1');
      const wired = makeController({
        session: fixture.session,
        appState: makeAppState(false, streamingPhase),
        endSessionTiming: { idleWaitTimeoutMs: 60_000 },
      });
      wired.controller.setLinkState('published');

      await wired.controller.runEndSession();

      expect(fixture.cancel).not.toHaveBeenCalled();
      expect(fixture.cancelCompaction).not.toHaveBeenCalled();
      expect(wired.createNewSession).toHaveBeenCalledTimes(1);
      expect(wired.order).toEqual(['stop', 'createNewSession']);
      expect(wired.stateAtCreate).toEqual(['detached']);
      expect(wired.statuses).not.toContain(
        'Forum Link: end-session timed out waiting for idle; staying unpublished',
      );
      expect(fixture.hasListener()).toBe(false);
    },
  );

  it('无当前会话时直接返回：不抛异常、不新建会话', async () => {
    const wired = makeController({});

    await wired.controller.runEndSession();

    expect(wired.createNewSession).not.toHaveBeenCalled();
    expect(wired.controller.state).toBe('detached');
  });
});

describe('Controller 编排 — Injector 接线', () => {
  it('dispatchAction 经 Injector 转发 approve 到 approvalController.respond', () => {
    const wired = makeController({ session: makeSession('s1').session });
    wired.controller.onCardOpened('approval', 'up-1', approvalPayload('up-1'));

    wired.controller.dispatchAction({ type: 'approve', target: 't', cardId: 'c1' });

    expect(wired.approvalRespond).toHaveBeenCalledTimes(1);
    expect(wired.controller.openCards).toEqual([]);
  });

  it('dispatchAction 转发 end-session 到 runEndSession 编排', async () => {
    const fixture = makeSession('s1');
    const wired = makeController({
      session: fixture.session,
      endSessionTiming: { idleWaitTimeoutMs: 50 },
    });

    wired.controller.dispatchAction({ type: 'end-session', target: 't' });
    await Promise.resolve();
    expect(fixture.cancel).toHaveBeenCalledTimes(1);

    fixture.emit(turnEnded());
    await vi.waitFor(() => {
      expect(wired.createNewSession).toHaveBeenCalledTimes(1);
    });
  });

  it('无会话时 pause 分派为空操作，不抛异常', () => {
    const wired = makeController({});
    expect(() => {
      wired.controller.dispatchAction({ type: 'pause', target: 't' });
    }).not.toThrow();
  });

  it('部分接线（缺 approvalController）不构造 Injector：dispatchAction 为空操作', () => {
    const controller = new ForumLinkController({
      getAppState: () => makeAppState(),
      sendNormalUserInput: vi.fn(async () => {}),
    });
    controller.onCardOpened('approval', 'up-1', approvalPayload('up-1'));
    expect(() => {
      controller.dispatchAction({ type: 'approve', target: 't', cardId: 'c1' });
      controller.dispatchAction({ type: 'send-message', target: 't', text: 'x' });
    }).not.toThrow();
    expect(controller.openCards).toEqual([{ cardId: 'c1', kind: 'approval', upstreamId: 'up-1' }]);
  });
});

describe('Controller 编排 — stop 升级为真实实现', () => {
  it('连调两次 stop 不抛：openCards 清空、projector detach、状态 detached', async () => {
    const wired = makeController({ session: makeSession('s1').session });
    wired.controller.setLinkState('published');
    wired.controller.onCardOpened('question', 'up-1', questionPayload('up-1'));

    await wired.controller.stop();
    await wired.controller.stop();

    expect(wired.controller.openCards).toEqual([]);
    expect(wired.controller.state).toBe('detached');
  });
});

describe('Controller 编排 — 会话切换原地更新（M-2 A1/A2）', () => {
  it('published 状态切换：结算开放卡片并上行 register 帧（同线程新属性）', () => {
    const first = makeSession('s1');
    const fixture = makeController({ session: first.session });
    fixture.controller.setLinkState('published');
    fixture.controller.onCardOpened('approval', 'up-1', approvalPayload('up-1'));
    fixture.controller.onCardOpened('question', 'up-2', questionPayload('up-2'));

    const next = makeSession('s2');
    fixture.controller.onSessionChanged(next.session);

    expect(fixture.frames).toContainEqual({
      type: 'entry',
      entry: { kind: 'card-settled', cardId: 'c1', outcome: 'cancelled' },
    });
    expect(fixture.frames).toContainEqual({
      type: 'entry',
      entry: { kind: 'card-settled', cardId: 'c2', outcome: 'cancelled' },
    });
    expect(fixture.frames).toContainEqual({
      type: 'register',
      descriptor: { ...makeDescriptor('s2'), status: 'idle' },
    });
    expect(fixture.controller.openCards).toEqual([]);
    expect(fixture.controller.session).toBe(next.session);
  });

  it('未发布切换不上行 register 帧', () => {
    const fixture = makeController({ session: makeSession('s1').session });
    const next = makeSession('s2');
    fixture.controller.onSessionChanged(next.session);
    expect(fixture.frames.filter((frame) => frame.type === 'register')).toEqual([]);
    expect(fixture.controller.state).toBe('detached');
  });

  it('published 但无 buildDescriptor 时跳过上行 register', () => {
    const frames: UplinkFrame[] = [];
    const controller = new ForumLinkController({
      onProjectorFrame: (frame) => {
        frames.push(frame);
      },
    });
    controller.setLinkState('published');
    controller.onSessionChanged(makeSession('s2').session);
    expect(frames.filter((frame) => frame.type === 'register')).toEqual([]);
  });

  it('切换时无开放卡片：零 card-settled 帧，register 帧仍在', () => {
    const fixture = makeController({ session: makeSession('s1').session });
    fixture.controller.setLinkState('published');
    fixture.controller.onSessionChanged(makeSession('s2').session);
    const settled = fixture.frames.filter(
      (frame) => frame.type === 'entry' && frame.entry.kind === 'card-settled',
    );
    expect(settled).toEqual([]);
    expect(fixture.frames).toContainEqual({
      type: 'register',
      descriptor: { ...makeDescriptor('s2'), status: 'idle' },
    });
  });

  it('已发布切换重挂 Projector：旧会话去订阅、新会话事件被投影', () => {
    const first = makeSession('s1');
    const wired = makeController({ session: first.session });
    wired.controller.setLinkState('published');

    const next = makeSession('s2');
    wired.controller.onSessionChanged(next.session);

    expect(first.hasListener()).toBe(false);
    expect(next.hasListener()).toBe(true);

    next.emit({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, agentId: 'main', sessionId: 's2' });
    next.emit({ type: 'assistant.delta', turnId: 1, delta: '新会话内容', agentId: 'main', sessionId: 's2' });
    next.emit({ type: 'turn.ended', turnId: 1, reason: 'completed', agentId: 'main', sessionId: 's2' });

    const texts = wired.frames
      .filter((frame) => frame.type === 'entry' && frame.entry.kind === 'message')
      .map((frame) => (frame.type === 'entry' && frame.entry.kind === 'message' ? frame.entry.text : ''));
    expect(texts).toContain('新会话内容');

    first.emit({ type: 'assistant.delta', turnId: 1, delta: '旧会话幽灵', agentId: 'main', sessionId: 's1' });
    expect(wired.frames.some((frame) => JSON.stringify(frame).includes('旧会话幽灵'))).toBe(false);
  });

  it('未发布切换不挂订阅：Projector 保持 idle', () => {
    const first = makeSession('s1');
    const wired = makeController({ session: first.session });
    const next = makeSession('s2');
    wired.controller.onSessionChanged(next.session);
    expect(first.hasListener()).toBe(false);
    expect(next.hasListener()).toBe(false);
  });
});

interface FakeLinkFixture {
  controller: ForumLinkController;
  fakeLink: FakeLink;
  frames: UplinkFrame[];
  statuses: string[];
  buildDescriptor: ReturnType<typeof vi.fn>;
  session: Session;
  cancel: ReturnType<typeof vi.fn>;
  cancelCompaction: ReturnType<typeof vi.fn>;
  emit(event: Event): void;
  hasListener(): boolean;
  setState(next: AppState): void;
}

class FakeLink {
  readonly connect = vi.fn(async (_credential: unknown, _registerSource: () => Descriptor) => {});
  readonly send = vi.fn();
  readonly close = vi.fn();
  onStateChange: ((state: Link['state']) => void) | undefined;
  onAction: ((frame: ActionFrame) => void) | undefined;

  registerDescriptor(): Descriptor {
    const source = this.connect.mock.calls[0]?.[1];
    if (source === undefined) throw new Error('connect was not called');
    return source();
  }
}

function makeStartFixture(options: { isCompacting?: boolean } = {}): FakeLinkFixture {
  const fakeLink = new FakeLink();
  const frames: UplinkFrame[] = [];
  const statuses: string[] = [];
  const buildDescriptor = vi.fn((session: Session) => makeDescriptor(session.id));
  const fixture = makeSession('s1');
  let state: AppState = { isCompacting: options.isCompacting ?? false } as AppState;
  const controller = new ForumLinkController({
    onProjectorFrame: (frame) => {
      frames.push(frame);
    },
    onStatus: (message) => {
      statuses.push(message);
    },
    getAppState: () => state,
    approvalController: { respond: vi.fn() } as never,
    questionController: { respond: vi.fn() } as never,
    sendNormalUserInput: vi.fn(async () => {}),
    buildDescriptor,
    createLink: (handlers) => {
      fakeLink.onStateChange = handlers.onStateChange;
      fakeLink.onAction = handlers.onAction;
      return fakeLink as unknown as Link;
    },
  });
  controller.onSessionChanged(fixture.session);
  return {
    controller,
    fakeLink,
    frames,
    statuses,
    buildDescriptor,
    session: fixture.session,
    cancel: fixture.cancel,
    cancelCompaction: fixture.cancelCompaction,
    emit: fixture.emit,
    hasListener: fixture.hasListener,
    setState: (next: AppState) => {
      state = next;
    },
  };
}

describe('Controller — start() 发布编排（M-1）', () => {
  it('start 接线 Link：connect 收到 credential 与 descriptor 源函数，projector 挂当前会话', async () => {
    const fixture = makeStartFixture();
    await fixture.controller.start({ url: 'http://127.0.0.1:8787', password: 'secret' });

    expect(fixture.fakeLink.connect).toHaveBeenCalledTimes(1);
    expect(fixture.fakeLink.connect).toHaveBeenCalledWith(
      { url: 'http://127.0.0.1:8787', password: 'secret' },
      expect.any(Function),
    );
    expect(fixture.fakeLink.registerDescriptor()).toEqual({ ...makeDescriptor('s1'), status: 'idle' });
    expect(fixture.buildDescriptor).toHaveBeenCalledWith(fixture.session);
    expect(fixture.hasListener()).toBe(true);
  });

  it('link onStateChange 驱动 controller 状态：published 后 projector 帧经 link.send 投递', async () => {
    const fixture = makeStartFixture();
    await fixture.controller.start({ url: 'http://127.0.0.1:8787', password: '' });
    expect(fixture.controller.state).toBe('detached');

    fixture.fakeLink.onStateChange?.('connecting');
    expect(fixture.controller.state).toBe('connecting');

    fixture.fakeLink.onStateChange?.('published');
    expect(fixture.controller.state).toBe('published');
    expect(fixture.statuses).toEqual([
      'Forum Link: connecting...',
      'Forum Link: published',
    ]);

    fixture.emit({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, agentId: 'main', sessionId: 's1' });
    fixture.emit({ type: 'assistant.delta', turnId: 1, delta: '发布后内容', agentId: 'main', sessionId: 's1' });
    fixture.emit({ type: 'turn.ended', turnId: 1, reason: 'completed', agentId: 'main', sessionId: 's1' });

    expect(fixture.fakeLink.send).toHaveBeenCalledTimes(5);
    const sentText = fixture.fakeLink.send.mock.calls
      .map((call) => call[0] as UplinkFrame)
      .find((frame) => frame.type === 'entry' && frame.entry.kind === 'message');
    expect(sentText).toEqual({
      type: 'entry',
      entry: { kind: 'message', role: 'assistant', text: '发布后内容' },
    });
  });

  it('未发布时 projector 帧丢弃：link.send 未被调用', async () => {
    const fixture = makeStartFixture();
    await fixture.controller.start({ url: 'http://127.0.0.1:8787', password: '' });

    fixture.emit({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, agentId: 'main', sessionId: 's1' });
    fixture.emit({ type: 'assistant.delta', turnId: 1, delta: '未发布内容', agentId: 'main', sessionId: 's1' });
    fixture.emit({ type: 'turn.ended', turnId: 1, reason: 'completed', agentId: 'main', sessionId: 's1' });

    expect(fixture.fakeLink.send).not.toHaveBeenCalled();
    expect(fixture.controller.state).toBe('detached');
  });

  it('stop 关闭 link 并回到 detached：published → stop → fakeLink.close 调用', async () => {
    const fixture = makeStartFixture();
    await fixture.controller.start({ url: 'http://127.0.0.1:8787', password: '' });
    fixture.fakeLink.onStateChange?.('published');

    await fixture.controller.stop();

    expect(fixture.fakeLink.close).toHaveBeenCalledTimes(1);
    expect(fixture.controller.state).toBe('detached');
    expect(fixture.hasListener()).toBe(false);
  });

  it('start 重入守卫：非 detached 状态下再次 start 直接返回不重连', async () => {
    const fixture = makeStartFixture();
    await fixture.controller.start({ url: 'http://127.0.0.1:8787', password: '' });
    fixture.fakeLink.onStateChange?.('backoff');

    await fixture.controller.start({ url: 'http://127.0.0.1:8787', password: '' });

    expect(fixture.fakeLink.connect).toHaveBeenCalledTimes(1);
  });

  it('start 失败（401）：connect-failed 结果携带错误，供命令层 showError', async () => {
    const fixture = makeStartFixture();
    fixture.fakeLink.connect.mockRejectedValueOnce(new Error('unauthorized'));

    const result = await fixture.controller.start({ url: 'http://127.0.0.1:8787', password: 'bad' });
    expect(result).toEqual({ ok: false, reason: 'connect-failed', error: expect.any(Error) });
  });

  it('getAppState 注入可变容器：pause 在 isCompacting 变更后读到最新值', async () => {
    const fixture = makeStartFixture();
    fixture.setState({ isCompacting: true } as AppState);

    fixture.controller.dispatchAction({ type: 'pause', target: 't' });
    await Promise.resolve();

    expect(fixture.cancelCompaction).toHaveBeenCalledTimes(1);
    expect(fixture.cancel).not.toHaveBeenCalled();

    fixture.setState({ isCompacting: false } as AppState);
    fixture.controller.dispatchAction({ type: 'pause', target: 't' });
    await Promise.resolve();

    expect(fixture.cancel).toHaveBeenCalledTimes(1);
  });

  it('onStateChange detached 通知 unpublished', async () => {
    const fixture = makeStartFixture();
    await fixture.controller.start({ url: 'http://127.0.0.1:8787', password: '' });
    fixture.fakeLink.onStateChange?.('connecting');
    fixture.fakeLink.onStateChange?.('detached');

    expect(fixture.controller.state).toBe('detached');
    expect(fixture.statuses).toEqual(['Forum Link: connecting...', 'Forum Link: unpublished']);
  });
});

describe('Controller — descriptor 组合与状态迁移（M1 / D3）', () => {
  function turnStartedEvent(sessionId = 's1'): Event {
    return { type: 'turn.started', turnId: 1, origin: { kind: 'user' }, agentId: 'main', sessionId };
  }

  function turnEndedEvent(sessionId = 's1'): Event {
    return { type: 'turn.ended', turnId: 1, reason: 'completed', agentId: 'main', sessionId };
  }

  it('M1 帧序：published 后状态迁移经 observers 观察 descriptor 帧，身份逐字段对齐 buildDescriptor', async () => {
    const fixture = makeStartFixture();
    await fixture.controller.start({ url: 'http://127.0.0.1:8787', password: '' });
    fixture.fakeLink.onStateChange?.('published');

    fixture.emit(turnStartedEvent());
    let descriptorFrames = fixture.frames.filter((frame) => frame.type === 'descriptor');
    expect(descriptorFrames).toEqual([
      { type: 'descriptor', descriptor: { ...makeDescriptor('s1'), status: 'running' } },
    ]);

    fixture.controller.onCardOpened('question', 'up-1', questionPayload('up-1'));
    descriptorFrames = fixture.frames.filter((frame) => frame.type === 'descriptor');
    expect(descriptorFrames).toEqual([
      { type: 'descriptor', descriptor: { ...makeDescriptor('s1'), status: 'running' } },
      { type: 'descriptor', descriptor: { ...makeDescriptor('s1'), status: 'waiting-question' } },
    ]);

    fixture.controller.onCardClosed('question', 'up-1');
    descriptorFrames = fixture.frames.filter((frame) => frame.type === 'descriptor');
    expect(descriptorFrames).toEqual([
      { type: 'descriptor', descriptor: { ...makeDescriptor('s1'), status: 'running' } },
      { type: 'descriptor', descriptor: { ...makeDescriptor('s1'), status: 'waiting-question' } },
      { type: 'descriptor', descriptor: { ...makeDescriptor('s1'), status: 'running' } },
    ]);

    fixture.emit(turnEndedEvent());
    descriptorFrames = fixture.frames.filter((frame) => frame.type === 'descriptor');
    expect(descriptorFrames).toEqual([
      { type: 'descriptor', descriptor: { ...makeDescriptor('s1'), status: 'running' } },
      { type: 'descriptor', descriptor: { ...makeDescriptor('s1'), status: 'waiting-question' } },
      { type: 'descriptor', descriptor: { ...makeDescriptor('s1'), status: 'running' } },
      { type: 'descriptor', descriptor: { ...makeDescriptor('s1'), status: 'idle' } },
    ]);
  });

  it('发布中途 running：start 时 projector 已 running，connect 源函数求值为 running', async () => {
    const fixture = makeStartFixture();
    await fixture.controller.start({ url: 'http://127.0.0.1:8787', password: '' });
    fixture.fakeLink.onStateChange?.('published');
    fixture.emit(turnStartedEvent());

    const source = fixture.fakeLink.connect.mock.calls[0]?.[1];
    expect(source).toBeTypeOf('function');
    expect(source?.()).toEqual({ ...makeDescriptor('s1'), status: 'running' });
  });

  it('重连注册源活读当前会话：backoff 中切换 s2 后再求值，身份为新会话', async () => {
    const fixture = makeStartFixture();
    await fixture.controller.start({ url: 'http://127.0.0.1:8787', password: '' });
    fixture.fakeLink.onStateChange?.('backoff');
    fixture.controller.onSessionChanged(makeSession('s2').session);

    expect(fixture.fakeLink.registerDescriptor()).toEqual({ ...makeDescriptor('s2'), status: 'idle' });
  });

  it('重连注册源活读当前会话：切换 s2 并迁移后求值，status 为 running', async () => {
    const fixture = makeStartFixture();
    await fixture.controller.start({ url: 'http://127.0.0.1:8787', password: '' });
    fixture.fakeLink.onStateChange?.('published');

    const next = makeSession('s2');
    fixture.controller.onSessionChanged(next.session);
    next.emit(turnStartedEvent('s2'));

    expect(fixture.fakeLink.registerDescriptor()).toEqual({ ...makeDescriptor('s2'), status: 'running' });
  });

  it('门控丢弃：connecting/backoff 状态下迁移不进 link.send，observers 仍收到 descriptor 帧', async () => {
    const fixture = makeStartFixture();
    await fixture.controller.start({ url: 'http://127.0.0.1:8787', password: '' });
    fixture.fakeLink.onStateChange?.('connecting');

    fixture.emit(turnStartedEvent());

    expect(fixture.fakeLink.send).not.toHaveBeenCalled();
    expect(fixture.frames).toContainEqual({
      type: 'descriptor',
      descriptor: { ...makeDescriptor('s1'), status: 'running' },
    });

    fixture.fakeLink.onStateChange?.('backoff');
    fixture.emit(turnEndedEvent());

    expect(fixture.fakeLink.send).not.toHaveBeenCalled();
    expect(fixture.frames).toContainEqual({
      type: 'descriptor',
      descriptor: { ...makeDescriptor('s1'), status: 'idle' },
    });
  });

  it('会话切换组合：register 帧身份为新会话、status idle，旧会话 open 卡以 cancelled 结算在前', () => {
    const fixture = makeStartFixture();
    fixture.controller.setLinkState('published');
    fixture.controller.onCardOpened('approval', 'up-1', approvalPayload('up-1'));

    const next = makeSession('s2');
    fixture.controller.onSessionChanged(next.session);

    const registerFrames = fixture.frames.filter((frame) => frame.type === 'register');
    expect(registerFrames).toEqual([
      { type: 'register', descriptor: { ...makeDescriptor('s2'), status: 'idle' } },
    ]);
    const settledIndex = fixture.frames.findIndex(
      (frame) => frame.type === 'entry' && frame.entry.kind === 'card-settled',
    );
    expect(settledIndex).toBeGreaterThanOrEqual(0);
    expect(fixture.frames[settledIndex]).toEqual({
      type: 'entry',
      entry: { kind: 'card-settled', cardId: 'c1', outcome: 'cancelled' },
    });
    for (let i = 0; i < settledIndex; i += 1) {
      expect(fixture.frames[i]?.type).not.toBe('register');
    }
  });

  it('切换后迁移：descriptor 帧身份为新会话、status 为迁移后值，无旧会话残留', async () => {
    const fixture = makeStartFixture();
    await fixture.controller.start({ url: 'http://127.0.0.1:8787', password: '' });
    fixture.fakeLink.onStateChange?.('published');

    const next = makeSession('s2');
    fixture.controller.onSessionChanged(next.session);

    next.emit(turnStartedEvent('s2'));

    const descriptorFrames = fixture.frames.filter((frame) => frame.type === 'descriptor');
    expect(descriptorFrames).toEqual([
      { type: 'descriptor', descriptor: { ...makeDescriptor('s2'), status: 'running' } },
    ]);
  });
});
