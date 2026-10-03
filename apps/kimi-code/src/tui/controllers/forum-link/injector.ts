import type { ApprovalResponse } from '@moonshot-ai/kimi-code-sdk';
import type { OpIntent, ReceiptReport } from '@moonshot-ai/forum-link';

import { adaptPanelResponse } from '#/tui/reverse-rpc/approval/adapter';
import type { ApprovalPanelData, QuestionPanelData, QuestionPanelResponse } from '#/tui/reverse-rpc/types';
import { encodeApproval, encodeApprovalCancel, encodeQuestion, encodeQuestionCancel } from './encoding';
import { executeSessionControl, type SessionControlHostView, type SessionControlOutcome } from './session-control';
import type { DownlinkOp } from './link';

export interface OpenCardView {
  readonly kind: 'approval' | 'question';
  readonly approval?: ApprovalPanelData | undefined;
  readonly question?: QuestionPanelData | undefined;
}

export interface InjectorHost {
  reportReceipt(report: ReceiptReport): void;
  getOpenCard(cardId: string): OpenCardView | undefined;
  isCurrentPanel(cardId: string): boolean;
  respondApproval(cardId: string, response: ApprovalResponse): void;
  respondQuestion(cardId: string, response: QuestionPanelResponse): void;
}

type CardIntent = Extract<OpIntent, { type: 'approve' | 'approve-cancel' | 'answer' | 'answer-cancel' }>;

const APPLIED: SessionControlOutcome = { state: 'applied' };

function isCardIntent(intent: OpIntent): intent is CardIntent {
  return (
    intent.type === 'approve' ||
    intent.type === 'approve-cancel' ||
    intent.type === 'answer' ||
    intent.type === 'answer-cancel'
  );
}

export class Injector {
  constructor(
    private readonly host: InjectorHost,
    private readonly sessionControl: SessionControlHostView,
  ) {}

  async handle(op: DownlinkOp): Promise<void> {
    this.host.reportReceipt({ opId: op.opId, state: 'delivered' });
    if (this.sessionControl.session()?.id !== op.sessionId) {
      this.host.reportReceipt({ opId: op.opId, state: 'rejected', reason: 'thread-unknown' });
      return;
    }
    if (op.intent.type === 'end-session') {
      await this.settleEndSession(op.opId);
      return;
    }
    let outcome: SessionControlOutcome;
    try {
      outcome = isCardIntent(op.intent)
        ? this.settleCard(op.intent)
        : await executeSessionControl(op.intent, this.sessionControl);
    } catch {
      outcome = { state: 'rejected', reason: 'postcondition-failed' };
    }
    this.reportTerminal(op.opId, outcome);
  }

  private settleCard(intent: CardIntent): SessionControlOutcome {
    const card = this.host.getOpenCard(intent.cardId);
    if (card === undefined) return { state: 'rejected', reason: 'card-closed' };
    if (!this.host.isCurrentPanel(intent.cardId)) return { state: 'rejected', reason: 'card-closed' };
    if (intent.type === 'approve' || intent.type === 'approve-cancel') {
      if (card.kind !== 'approval' || card.approval === undefined) {
        return { state: 'rejected', reason: 'card-closed' };
      }
      const encoded =
        intent.type === 'approve'
          ? encodeApproval(card, { optionIndex: intent.optionIndex, feedback: intent.feedback })
          : { ok: true as const, value: encodeApprovalCancel() };
      if (!encoded.ok) return { state: 'rejected', reason: 'invalid-params' };
      this.host.respondApproval(intent.cardId, adaptPanelResponse(encoded.value));
      return APPLIED;
    }
    if (card.kind !== 'question' || card.question === undefined) {
      return { state: 'rejected', reason: 'card-closed' };
    }
    const encoded =
      intent.type === 'answer'
        ? encodeQuestion(card, intent.answers)
        : { ok: true as const, value: encodeQuestionCancel() };
    if (!encoded.ok) return { state: 'rejected', reason: 'invalid-params' };
    this.host.respondQuestion(intent.cardId, encoded.value);
    return APPLIED;
  }

  private async settleEndSession(opId: string): Promise<void> {
    let reported = false;
    const beforeStop = () => {
      this.host.reportReceipt({ opId, state: 'applied' });
      reported = true;
    };
    try {
      await this.sessionControl.runEndSession({ beforeStop });
    } catch {
      if (!reported) this.reportTerminal(opId, { state: 'rejected', reason: 'postcondition-failed' });
      return;
    }
    if (!reported) beforeStop();
  }

  private reportTerminal(opId: string, outcome: SessionControlOutcome): void {
    this.host.reportReceipt(
      outcome.state === 'applied'
        ? { opId, state: 'applied' }
        : { opId, state: 'rejected', reason: outcome.reason },
    );
  }
}
