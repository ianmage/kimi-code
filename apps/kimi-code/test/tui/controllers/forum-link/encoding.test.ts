import { describe, expect, it } from 'vitest';

import { ApprovalPanelComponent } from '#/tui/components/dialogs/approval-panel';
import { QuestionDialogComponent } from '#/tui/components/dialogs/question-dialog';
import {
  encodeApproval,
  encodeApprovalCancel,
  encodeQuestion,
  encodeQuestionCancel,
  type EncodeAnswerInput,
} from '#/tui/controllers/forum-link/encoding';
import type {
  ApprovalPanelData,
  PendingApproval,
  PendingQuestion,
  QuestionPanelData,
  QuestionPanelResponse,
} from '#/tui/reverse-rpc/types';
import type { ApprovalPanelResponse } from '#/tui/components/dialogs/approval-panel';

const DEFAULT_APPROVAL_CHOICES: ApprovalPanelData['choices'] = [
  { label: 'Approve once', response: 'approved' },
  { label: 'Approve for this session', response: 'approved_for_session' },
  { label: 'Reject', response: 'rejected' },
  { label: 'Reject with feedback', response: 'rejected', requires_feedback: true },
];

const PLAN_REVIEW_CHOICES: ApprovalPanelData['choices'] = [
  { label: 'Ship it', response: 'approved', selected_label: 'Ship it' },
  { label: 'Reject', response: 'rejected', selected_label: 'Reject' },
  { label: 'Revise', response: 'rejected', selected_label: 'Revise', requires_feedback: true },
];

const GOAL_START_CHOICES: ApprovalPanelData['choices'] = [
  {
    label: 'Switch to Never Ask and start',
    response: 'approved',
    selected_label: 'auto',
    description: 'Tools are approved automatically, and questions are skipped.',
  },
  { label: 'Do not start', response: 'cancelled', selected_label: 'cancel' },
];

function approvalData(choices: ApprovalPanelData['choices']): ApprovalPanelData {
  return {
    id: 'approval_1',
    tool_call_id: 'tool_1',
    tool_name: 'WriteFile',
    action: 'write a file',
    description: 'Update README.md',
    display: [],
    choices,
  };
}

function driveApproval(
  data: ApprovalPanelData,
  keys: string[],
): ApprovalPanelResponse[] {
  const responses: ApprovalPanelResponse[] = [];
  const dialog = new ApprovalPanelComponent({ data }, (response) => responses.push(response));
  for (const key of keys) dialog.handleInput(key);
  return responses;
}

function questionData(questions: QuestionPanelData['questions']): QuestionPanelData {
  return { id: 'question_1', tool_call_id: 'tool_1', questions };
}

function driveQuestion(
  data: QuestionPanelData,
  keys: string[],
): QuestionPanelResponse[] {
  const responses: QuestionPanelResponse[] = [];
  const dialog = new QuestionDialogComponent({ data }, (response) => responses.push(response));
  for (const key of keys) dialog.handleInput(key);
  return responses;
}

describe('O7-A2 approval equivalence', () => {
  it('approve once matches the real component', () => {
    const data = approvalData(DEFAULT_APPROVAL_CHOICES);
    expect(driveApproval(data, ['1'])).toEqual([
      { response: 'approved', feedback: undefined, selected_label: undefined },
    ]);
    expect(encodeApproval({ approval: data }, { optionIndex: 0 })).toEqual({
      ok: true,
      value: { response: 'approved', feedback: undefined, selected_label: undefined },
    });
  });

  it('approve for this session matches the real component', () => {
    const data = approvalData(DEFAULT_APPROVAL_CHOICES);
    expect(driveApproval(data, ['2'])).toEqual([
      { response: 'approved_for_session', feedback: undefined, selected_label: undefined },
    ]);
    expect(encodeApproval({ approval: data }, { optionIndex: 1 })).toEqual({
      ok: true,
      value: { response: 'approved_for_session', feedback: undefined, selected_label: undefined },
    });
  });

  it('plain reject matches the real component', () => {
    const data = approvalData(DEFAULT_APPROVAL_CHOICES);
    expect(driveApproval(data, ['3'])).toEqual([
      { response: 'rejected', feedback: undefined, selected_label: undefined },
    ]);
    expect(encodeApproval({ approval: data }, { optionIndex: 2 })).toEqual({
      ok: true,
      value: { response: 'rejected', feedback: undefined, selected_label: undefined },
    });
  });

  it('reject with feedback matches the real component', () => {
    const data = approvalData(DEFAULT_APPROVAL_CHOICES);
    expect(driveApproval(data, ['4', 'n', 'o', '\r'])).toEqual([
      { response: 'rejected', feedback: 'no', selected_label: undefined },
    ]);
    expect(encodeApproval({ approval: data }, { optionIndex: 3, feedback: 'no' })).toEqual({
      ok: true,
      value: { response: 'rejected', feedback: 'no', selected_label: undefined },
    });
  });

  it('plan review choices match the real component', () => {
    const data = approvalData(PLAN_REVIEW_CHOICES);
    expect(driveApproval(data, ['1'])).toEqual([
      { response: 'approved', feedback: undefined, selected_label: 'Ship it' },
    ]);
    expect(encodeApproval({ approval: data }, { optionIndex: 0 })).toEqual({
      ok: true,
      value: { response: 'approved', feedback: undefined, selected_label: 'Ship it' },
    });
    expect(driveApproval(data, ['2'])).toEqual([
      { response: 'rejected', feedback: undefined, selected_label: 'Reject' },
    ]);
    expect(encodeApproval({ approval: data }, { optionIndex: 1 })).toEqual({
      ok: true,
      value: { response: 'rejected', feedback: undefined, selected_label: 'Reject' },
    });
    expect(driveApproval(data, ['3', 'f', 'i', 'x', '\r'])).toEqual([
      { response: 'rejected', feedback: 'fix', selected_label: 'Revise' },
    ]);
    expect(encodeApproval({ approval: data }, { optionIndex: 2, feedback: 'fix' })).toEqual({
      ok: true,
      value: { response: 'rejected', feedback: 'fix', selected_label: 'Revise' },
    });
  });

  it('goal start choices match the real component', () => {
    const data = approvalData(GOAL_START_CHOICES);
    expect(driveApproval(data, ['1'])).toEqual([
      { response: 'approved', feedback: undefined, selected_label: 'auto' },
    ]);
    expect(encodeApproval({ approval: data }, { optionIndex: 0 })).toEqual({
      ok: true,
      value: { response: 'approved', feedback: undefined, selected_label: 'auto' },
    });
    expect(driveApproval(data, ['2'])).toEqual([
      { response: 'cancelled', feedback: undefined, selected_label: 'cancel' },
    ]);
    expect(encodeApproval({ approval: data }, { optionIndex: 1 })).toEqual({
      ok: true,
      value: { response: 'cancelled', feedback: undefined, selected_label: 'cancel' },
    });
  });

  it('cancel equals Esc: rejected, no feedback, no label — not cancelled', () => {
    const data = approvalData(DEFAULT_APPROVAL_CHOICES);
    expect(driveApproval(data, ['\u001B'])).toEqual([{ response: 'rejected' }]);
    expect(encodeApprovalCancel()).toEqual({ response: 'rejected' });
  });

  it('cursor navigation plus enter matches optionIndex encoding', () => {
    const data = approvalData(DEFAULT_APPROVAL_CHOICES);
    expect(driveApproval(data, ['\u001B[B', '\u001B[B', '\r'])).toEqual([
      { response: 'rejected', feedback: undefined, selected_label: undefined },
    ]);
  });
});

describe('O7-A1 + G-A2 question equivalence', () => {
  it('single-select label matches the real component', () => {
    const data = questionData([
      { question: 'Pick one?', multi_select: false, options: [{ label: 'A' }, { label: 'B' }] },
    ]);
    expect(driveQuestion(data, ['\r', '\r'])).toEqual([
      { answers: ['A'], method: 'enter' },
    ]);
    expect(encodeQuestion({ question: data }, [{ selected: [0] }])).toEqual({
      ok: true,
      value: { answers: ['A'], method: 'enter' },
    });
  });

  it('single-select free text matches the real component', () => {
    const data = questionData([
      { question: 'Pick one?', multi_select: false, options: [{ label: 'A' }, { label: 'B' }] },
    ]);
    expect(driveQuestion(data, ['3', 'H', 'i', '\r', '1'])).toEqual([
      { answers: ['Hi'], method: 'enter' },
    ]);
    expect(encodeQuestion({ question: data }, [{ selected: [], freeText: 'Hi' }])).toEqual({
      ok: true,
      value: { answers: ['Hi'], method: 'enter' },
    });
  });

  it('free text is trimmed exactly like the component commit', () => {
    const data = questionData([
      { question: 'Pick one?', multi_select: false, options: [{ label: 'A' }, { label: 'B' }] },
    ]);
    expect(driveQuestion(data, ['3', ' ', 'H', 'i', ' ', '\r', '1'])).toEqual([
      { answers: ['Hi'], method: 'enter' },
    ]);
    expect(encodeQuestion({ question: data }, [{ selected: [], freeText: ' Hi ' }])).toEqual({
      ok: true,
      value: { answers: ['Hi'], method: 'enter' },
    });
  });

  it('multi-select joins selected labels in declaration order with ", "', () => {
    const data = questionData([
      {
        question: 'Pick many?',
        multi_select: true,
        options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
      },
    ]);
    expect(driveQuestion(data, ['\r', '\u001B[B', '\u001B[B', '\r', '\t', '\r'])).toEqual([
      { answers: ['A, C'], method: 'enter' },
    ]);
    expect(encodeQuestion({ question: data }, [{ selected: [0, 2] }])).toEqual({
      ok: true,
      value: { answers: ['A, C'], method: 'enter' },
    });
  });

  it('multi-select free text is appended last', () => {
    const data = questionData([
      {
        question: 'Pick many?',
        multi_select: true,
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ]);
    expect(
      encodeQuestion({ question: data }, [{ selected: [1, 0], freeText: 'extra' }]),
    ).toEqual({ ok: true, value: { answers: ['A, B, extra'], method: 'enter' } });
  });

  it('mixed multi-question sets match the real component, unanswered slots stay empty', () => {
    const data = questionData([
      { question: 'Q1?', multi_select: false, options: [{ label: 'A1' }, { label: 'B1' }] },
      {
        question: 'Q2?',
        multi_select: true,
        options: [{ label: 'A2' }, { label: 'B2' }, { label: 'C2' }],
      },
      { question: 'Q3?', multi_select: false, options: [{ label: 'A3' }] },
    ]);
    const driven = driveQuestion(data, ['\r', '\r', '\u001B[B', '\r', '\t', '\t', '\r']);
    const encoded = encodeQuestion({ question: data }, [
      { selected: [0] },
      { selected: [0, 1] },
      { selected: [] },
    ]);
    expect(encoded.ok).toBe(true);
    if (encoded.ok) {
      expect(driven).toEqual([encoded.value]);
      expect(JSON.stringify(driven)).toBe(JSON.stringify([encoded.value]));
      expect(Object.keys(driven[0]?.answers ?? {})).toEqual(['0', '1']);
    }
  });

  it('cancel equals Esc: empty answers array', () => {
    const data = questionData([
      { question: 'Pick one?', multi_select: false, options: [{ label: 'A' }] },
    ]);
    expect(driveQuestion(data, ['\u001B'])).toEqual([{ answers: [] }]);
    expect(encodeQuestionCancel()).toEqual({ answers: [] });
  });
});

describe('O7-A3 invalid params', () => {
  it('approval option index out of range is rejected without a response', () => {
    const data = approvalData(DEFAULT_APPROVAL_CHOICES);
    expect(encodeApproval({ approval: data }, { optionIndex: 4 })).toEqual({
      ok: false,
      reason: 'invalid-params',
    });
    expect(encodeApproval({ approval: data }, { optionIndex: -1 })).toEqual({
      ok: false,
      reason: 'invalid-params',
    });
  });

  it('approval requires_feedback without feedback is rejected', () => {
    const data = approvalData(DEFAULT_APPROVAL_CHOICES);
    expect(encodeApproval({ approval: data }, { optionIndex: 3 })).toEqual({
      ok: false,
      reason: 'invalid-params',
    });
    expect(encodeApproval({ approval: data }, { optionIndex: 3, feedback: '' })).toEqual({
      ok: false,
      reason: 'invalid-params',
    });
  });

  it('approval encoding on a question card is rejected', () => {
    expect(encodeApproval({}, { optionIndex: 0 })).toEqual({
      ok: false,
      reason: 'invalid-params',
    });
  });

  it('question answer with out-of-range selected index is rejected', () => {
    const data = questionData([
      { question: 'Q?', multi_select: false, options: [{ label: 'A' }] },
    ]);
    expect(encodeQuestion({ question: data }, [{ selected: [1] }])).toEqual({
      ok: false,
      reason: 'invalid-params',
    });
    expect(encodeQuestion({ question: data }, [{ selected: [-1] }])).toEqual({
      ok: false,
      reason: 'invalid-params',
    });
  });

  it('question answer array length mismatch is rejected', () => {
    const data = questionData([
      { question: 'Q1?', multi_select: false, options: [{ label: 'A' }] },
      { question: 'Q2?', multi_select: false, options: [{ label: 'B' }] },
    ]);
    expect(encodeQuestion({ question: data }, [{ selected: [0] }])).toEqual({
      ok: false,
      reason: 'invalid-params',
    });
  });

  it('question encoding on an approval card is rejected', () => {
    expect(encodeQuestion({}, [])).toEqual({ ok: false, reason: 'invalid-params' });
  });
});
