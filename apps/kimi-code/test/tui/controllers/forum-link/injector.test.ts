import { describe, expect, it, vi } from 'vitest';

import type { Session } from '@moonshot-ai/kimi-code-sdk';
import type { ActionFrame, UplinkFrame } from '@moonshot-ai/forum-link';

import { Injector } from '#/tui/controllers/forum-link/injector';
import { ForumLinkController } from '#/tui/controllers/forum-link/controller';
import type { OpenCard } from '#/tui/controllers/forum-link/controller';
import type { AppState } from '#/tui/types';
import type { QuestionPanelResponse } from '#/tui/reverse-rpc/types';

type RespondSpy = ReturnType<typeof vi.fn>;

function makeAppState(isCompacting = false): AppState {
  return { isCompacting } as AppState;
}

function makeSession(): { session: Session; cancel: RespondSpy; cancelCompaction: RespondSpy } {
  const cancel = vi.fn(async () => {});
  const cancelCompaction = vi.fn(async () => {});
  return { session: { cancel, cancelCompaction } as unknown as Session, cancel, cancelCompaction };
}

interface HostFixture {
  injector: Injector;
  controller: ForumLinkController;
  frames: UplinkFrame[];
  appState: AppState;
  session: Session;
  cancel: RespondSpy;
  cancelCompaction: RespondSpy;
  approvalRespond: RespondSpy;
  questionRespond: RespondSpy;
  sendNormalUserInput: RespondSpy;
  endSession: RespondSpy;
  onDroppedAction: RespondSpy;
  /** Shows a real reverse-rpc panel through the controller's onCardOpened. */
  openCard(kind: OpenCard['kind'], upstreamId: string): void;
}

function makeHost(appState: AppState = makeAppState()): HostFixture {
  const frames: UplinkFrame[] = [];
  const controller = new ForumLinkController({
    onProjectorFrame: (frame) => {
      frames.push(frame);
    },
  });
  const approvalRespond: RespondSpy = vi.fn();
  const questionRespond: RespondSpy = vi.fn();
  const { session, cancel, cancelCompaction } = makeSession();
  const sendNormalUserInput = vi.fn(async () => {});
  const endSession = vi.fn(async () => {});
  const onDroppedAction = vi.fn();
  const injector = new Injector({
    session,
    appState,
    approvalController: { respond: approvalRespond } as never,
    questionController: { respond: questionRespond } as never,
    sendNormalUserInput,
    endSession,
    getOpenCards: () => controller.openCards,
    onCardClosed: controller.onCardClosed.bind(controller),
    onDroppedAction,
  });
  return {
    injector,
    controller,
    frames,
    appState,
    session,
    cancel,
    cancelCompaction,
    approvalRespond,
    questionRespond,
    sendNormalUserInput,
    endSession,
    onDroppedAction,
    openCard: (kind, upstreamId) => {
      controller.onCardOpened(
        kind,
        upstreamId,
        kind === 'question'
          ? {
              id: upstreamId,
              tool_call_id: `tc-${upstreamId}`,
              questions: [{ question: 'Continue?', multi_select: false, options: [{ label: 'yes' }] }],
            }
          : {
              id: upstreamId,
              tool_call_id: `tc-${upstreamId}`,
              tool_name: 'Bash',
              action: 'run command',
              description: 'run a command',
              display: [],
              choices: [],
            },
      );
    },
  };
}

describe('Injector — 六动作映射', () => {
  it('answer-question responds with single-answer array and settles the card', () => {
    const host = makeHost();
    host.openCard('question', 'q1');
    const frame: ActionFrame = { type: 'answer-question', target: 't', cardId: 'c1', answer: '是' };
    host.injector.dispatch(frame);
    expect(host.questionRespond).toHaveBeenCalledTimes(1);
    expect(host.questionRespond).toHaveBeenCalledWith({ answers: ['是'] });
    expect(host.controller.openCards).toEqual([]);
    expect(host.frames).toContainEqual({
      type: 'entry',
      entry: { kind: 'card-settled', cardId: 'c1', outcome: 'answered' },
    });
  });

  it('approve responds approved and settles the card', () => {
    const host = makeHost();
    host.openCard('approval', 'a1');
    host.injector.dispatch({ type: 'approve', target: 't', cardId: 'c1' });
    expect(host.approvalRespond).toHaveBeenCalledTimes(1);
    expect(host.approvalRespond.mock.calls[0]?.[0]).toMatchObject({ decision: 'approved' });
    expect(host.controller.openCards).toEqual([]);
    expect(host.frames).toContainEqual({
      type: 'entry',
      entry: { kind: 'card-settled', cardId: 'c1', outcome: 'approved' },
    });
  });

  it('deny responds rejected with feedback passthrough', () => {
    const host = makeHost();
    host.openCard('approval', 'a1');
    host.injector.dispatch({ type: 'deny', target: 't', cardId: 'c1', feedback: 'risky' });
    expect(host.approvalRespond).toHaveBeenCalledWith({ decision: 'rejected', feedback: 'risky' });
    expect(host.frames).toContainEqual({
      type: 'entry',
      entry: { kind: 'card-settled', cardId: 'c1', outcome: 'rejected' },
    });
  });

  it('send-message forwards text verbatim via sendNormalUserInput', () => {
    const host = makeHost();
    host.injector.dispatch({ type: 'send-message', target: 't', text: 'hello' });
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('hello');
  });

  it('pause cancels the session when not compacting', () => {
    const host = makeHost();
    host.injector.dispatch({ type: 'pause', target: 't' });
    expect(host.cancel).toHaveBeenCalledTimes(1);
    expect(host.cancelCompaction).not.toHaveBeenCalled();
  });

  it('end-session delegates to host.endSession', () => {
    const host = makeHost();
    host.injector.dispatch({ type: 'end-session', target: 't' });
    expect(host.endSession).toHaveBeenCalledTimes(1);
  });
});

describe('Injector — G1 同步原子守卫', () => {
  it('late remote answer for a closed card is dropped and never hits the next card', () => {
    const host = makeHost();
    host.openCard('question', 'q1');

    host.injector.dispatch({ type: 'answer-question', target: 't', cardId: 'c1', answer: 'local' });
    expect(host.questionRespond).toHaveBeenCalledTimes(1);
    expect(host.controller.openCards).toEqual([]);

    host.openCard('question', 'q2');

    host.injector.dispatch({ type: 'answer-question', target: 't', cardId: 'c1', answer: 'late' });
    expect(host.questionRespond).toHaveBeenCalledTimes(1);
    const response = host.questionRespond.mock.calls[0]?.[0] as QuestionPanelResponse;
    expect(response.answers).toEqual(['local']);
    expect(host.controller.openCards).toEqual([
      { cardId: 'c2', kind: 'question', upstreamId: 'q2' },
    ]);
    expect(host.onDroppedAction).toHaveBeenCalledTimes(1);
    expect(host.onDroppedAction).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'answer-question', cardId: 'c1' }),
    );
  });

  it('card actions match kind — an approval card cannot be answered as a question', () => {
    const host = makeHost();
    host.openCard('approval', 'a1');
    host.injector.dispatch({ type: 'answer-question', target: 't', cardId: 'c1', answer: 'x' });
    expect(host.questionRespond).not.toHaveBeenCalled();
    expect(host.controller.openCards).toEqual([{ cardId: 'c1', kind: 'approval', upstreamId: 'a1' }]);
    expect(host.onDroppedAction).toHaveBeenCalledTimes(1);
  });

  it('card actions match cardId — unknown id is dropped', () => {
    const host = makeHost();
    host.openCard('question', 'q1');
    host.injector.dispatch({ type: 'approve', target: 't', cardId: 'c9' });
    expect(host.approvalRespond).not.toHaveBeenCalled();
    expect(host.controller.openCards).toEqual([{ cardId: 'c1', kind: 'question', upstreamId: 'q1' }]);
    expect(host.onDroppedAction).toHaveBeenCalledTimes(1);
  });

  it('G1 stays atomic against the real controller — no window between respond and settle', () => {
    const host = makeHost();
    host.openCard('question', 'q1');
    let replayed = false;
    host.questionRespond.mockImplementation(() => {
      if (replayed) return;
      replayed = true;
      host.injector.dispatch({ type: 'answer-question', target: 't', cardId: 'c1', answer: 'replay' });
    });
    host.injector.dispatch({ type: 'answer-question', target: 't', cardId: 'c1', answer: 'first' });
    expect(replayed).toBe(true);
    expect(host.questionRespond).toHaveBeenCalledTimes(1);
    expect(host.controller.openCards).toEqual([]);
    expect(host.onDroppedAction).toHaveBeenCalledTimes(1);
  });
});

describe('Injector — 分派细节', () => {
  it('approve response object never carries scope (R6)', () => {
    const host = makeHost();
    host.openCard('approval', 'a1');
    host.injector.dispatch({ type: 'approve', target: 't', cardId: 'c1', feedback: 'ok' });
    const response = host.approvalRespond.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(response).toSorted()).toEqual(['decision', 'feedback']);
  });

  it('approve without feedback passes feedback: undefined', () => {
    const host = makeHost();
    host.openCard('approval', 'a1');
    host.injector.dispatch({ type: 'approve', target: 't', cardId: 'c1' });
    expect(host.approvalRespond).toHaveBeenCalledWith({ decision: 'approved', feedback: undefined });
  });

  it('slash text is forwarded verbatim — no command interpretation (I3)', () => {
    const host = makeHost();
    host.injector.dispatch({ type: 'send-message', target: 't', text: '/exit' });
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('/exit');
    expect(host.sendNormalUserInput).toHaveBeenCalledTimes(1);
  });

  it('unknown runtime action type is a silent zero-effect drop', () => {
    const host = makeHost();
    host.injector.dispatch({ type: 'escalate-privileges', target: 't' } as unknown as ActionFrame);
    expect(host.questionRespond).not.toHaveBeenCalled();
    expect(host.approvalRespond).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(host.cancel).not.toHaveBeenCalled();
    expect(host.cancelCompaction).not.toHaveBeenCalled();
    expect(host.endSession).not.toHaveBeenCalled();
    expect(host.controller.openCards).toEqual([]);
  });

  it('idle pause is a no-op call — cancel is invoked without throwing', () => {
    const host = makeHost();
    expect(() => {
      host.injector.dispatch({ type: 'pause', target: 't' });
    }).not.toThrow();
    expect(host.cancel).toHaveBeenCalledTimes(1);
  });

  it('isCompacting routes pause to cancelCompaction, not cancel', () => {
    const host = makeHost(makeAppState(true));
    host.injector.dispatch({ type: 'pause', target: 't' });
    expect(host.cancelCompaction).toHaveBeenCalledTimes(1);
    expect(host.cancel).not.toHaveBeenCalled();
  });

  it('dispatch stays synchronous — returns undefined and never awaits host promises', () => {
    const host = makeHost();
    const pendingInput = new Promise<void>(() => {});
    host.sendNormalUserInput.mockReturnValue(pendingInput);
    const dispatch: (frame: ActionFrame) => unknown = host.injector.dispatch.bind(host.injector);
    expect(dispatch({ type: 'send-message', target: 't', text: 'x' })).toBeUndefined();
    expect(host.sendNormalUserInput).toHaveBeenCalledTimes(1);
  });
});
