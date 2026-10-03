import type {
  ApprovalPanelChoice,
  ApprovalPanelData,
  QuestionPanelData,
  QuestionPanelResponse,
} from '#/tui/reverse-rpc/types';
import type { ApprovalPanelResponse } from '#/tui/components/dialogs/approval-panel';

export type EncodeResult<T> = { ok: true; value: T } | { ok: false; reason: 'invalid-params' };

export interface EncodeApprovalInput {
  readonly optionIndex: number;
  readonly feedback?: string | undefined;
}

export interface EncodeAnswerInput {
  readonly selected: number[];
  readonly freeText?: string | undefined;
}

const INVALID: { ok: false; reason: 'invalid-params' } = { ok: false, reason: 'invalid-params' };

function choiceAt(payload: ApprovalPanelData, index: number): ApprovalPanelChoice | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= payload.choices.length) return undefined;
  return payload.choices[index];
}

export function encodeApproval(
  card: { approval?: ApprovalPanelData | undefined },
  input: EncodeApprovalInput,
): EncodeResult<ApprovalPanelResponse> {
  const payload = card.approval;
  if (payload === undefined) return INVALID;
  const option = choiceAt(payload, input.optionIndex);
  if (option === undefined) return INVALID;
  const feedback = input.feedback ?? '';
  if (option.requires_feedback === true && feedback.length === 0) return INVALID;
  return {
    ok: true,
    value: {
      response: option.response,
      feedback: feedback || undefined,
      selected_label: option.selected_label,
    },
  };
}

export function encodeApprovalCancel(): ApprovalPanelResponse {
  return { response: 'rejected' };
}

type AnswerEncoding = { invalid: true } | { invalid: false; text: string | undefined };

function encodeAnswer(
  question: QuestionPanelData['questions'][number],
  input: EncodeAnswerInput,
): AnswerEncoding {
  const selected = new Set<number>();
  for (const index of input.selected) {
    if (!Number.isInteger(index) || index < 0 || index >= question.options.length) {
      return { invalid: true };
    }
    selected.add(index);
  }
  const labels: string[] = [];
  for (let i = 0; i < question.options.length; i++) {
    if (!selected.has(i)) continue;
    const label = question.options[i]?.label;
    if (label === undefined || label.length === 0) return { invalid: true };
    labels.push(label);
  }
  const freeText = (input.freeText ?? '').trim();
  if (freeText.length > 0) labels.push(freeText);
  return { invalid: false, text: labels.length > 0 ? labels.join(', ') : undefined };
}

export function encodeQuestion(
  card: { question?: QuestionPanelData | undefined },
  answers: EncodeAnswerInput[],
): EncodeResult<QuestionPanelResponse> {
  const payload = card.question;
  if (payload === undefined) return INVALID;
  if (!Array.isArray(answers) || answers.length !== payload.questions.length) return INVALID;
  const out: string[] = [];
  for (let i = 0; i < payload.questions.length; i++) {
    const question = payload.questions[i];
    const input = answers[i];
    if (question === undefined || input === undefined) return INVALID;
    const encoded = encodeAnswer(question, input);
    if (encoded.invalid) return INVALID;
    if (encoded.text !== undefined) out[i] = encoded.text;
  }
  return { ok: true, value: { answers: out, method: 'enter' } };
}

export function encodeQuestionCancel(): QuestionPanelResponse {
  return { answers: [] };
}
