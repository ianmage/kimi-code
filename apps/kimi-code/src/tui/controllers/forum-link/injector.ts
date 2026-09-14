import type { Session } from '@moonshot-ai/kimi-code-sdk';
import type { ActionFrame } from '@moonshot-ai/forum-link';

import type { ApprovalController } from '#/tui/reverse-rpc/approval/controller';
import type { QuestionController } from '#/tui/reverse-rpc/question/controller';
import type { AppState } from '#/tui/types';
import type { OpenCard } from './controller';
import type { CardSettlementOutcome } from './projector';

/**
 * Explicit host surface for the downlink injector. The injector never imports
 * KimiTUI; every local capability it needs is declared here and wired by the
 * owner (P3.3). `endSession` is the controller-level orchestration seam
 * implemented in P3.2 — the injector only fire-and-forgets it. `session` may
 * be undefined before the first `setSession`; the session-scoped actions are
 * no-ops then. `appState` is a getter so live mutations (isCompacting) are
 * always observed.
 */
export interface InjectorHost {
  readonly session: Session | undefined;
  readonly appState: AppState;
  readonly approvalController: ApprovalController;
  readonly questionController: QuestionController;
  sendNormalUserInput(text: string): Promise<void>;
  endSession(): Promise<void>;
  getOpenCards(): readonly OpenCard[];
  onCardClosed(kind: OpenCard['kind'], upstreamId: string, outcome: CardSettlementOutcome): void;
  onDroppedAction?(frame: ActionFrame): void;
}

type CardActionFrame = Extract<ActionFrame, { type: 'answer-question' | 'approve' | 'deny' }>;

const CARD_KIND: Record<CardActionFrame['type'], OpenCard['kind']> = {
  'answer-question': 'question',
  approve: 'approval',
  deny: 'approval',
};

const CARD_OUTCOME: Record<CardActionFrame['type'], CardSettlementOutcome> = {
  'answer-question': 'answered',
  approve: 'approved',
  deny: 'rejected',
};

/**
 * Maps downlink action frames onto existing local paths. `dispatch` is
 * synchronous by contract (K12): the three card actions settle the card and
 * respond with no await between the two steps (G1), and the async actions
 * (send-message / pause / end-session) are started with `void` and never
 * awaited here. Card actions whose cardId or kind no longer matches an open
 * card are dropped as late arrivals (A6) — a late remote answer can never hit
 * the card that replaced the one the local user already answered.
 */
export class Injector {
  constructor(private readonly host: InjectorHost) {}

  dispatch(frame: ActionFrame): void {
    switch (frame.type) {
      case 'answer-question':
      case 'approve':
      case 'deny':
        this.dispatchCardAction(frame);
        break;
      case 'send-message':
        this.safely(() => this.host.sendNormalUserInput(frame.text));
        break;
      case 'pause': {
        const session = this.host.session;
        if (session === undefined) break;
        if (this.host.appState.isCompacting) this.safely(() => session.cancelCompaction());
        else this.safely(() => session.cancel());
        break;
      }
      case 'end-session':
        this.safely(() => this.host.endSession());
        break;
      default:
        this.host.onDroppedAction?.(frame);
        break;
    }
  }

  private safely(run: () => Promise<unknown>): void {
    run().catch(() => {});
  }

  private dispatchCardAction(frame: CardActionFrame): void {
    const kind = CARD_KIND[frame.type];
    const card = this.host
      .getOpenCards()
      .find((open) => open.cardId === frame.cardId && open.kind === kind);
    if (card === undefined) {
      this.host.onDroppedAction?.(frame);
      return;
    }
    this.host.onCardClosed(kind, card.upstreamId, CARD_OUTCOME[frame.type]);
    if (frame.type === 'answer-question') {
      this.host.questionController.respond({ answers: [frame.answer] });
    } else if (frame.type === 'approve') {
      this.host.approvalController.respond({ decision: 'approved', feedback: frame.feedback });
    } else {
      this.host.approvalController.respond({ decision: 'rejected', feedback: frame.feedback });
    }
  }
}
