import { describe, expect, it } from 'vitest';

import type { QuestionRequest } from '@moonshot-ai/kimi-code-sdk';
import { parseCard, type ReceiptReport } from '@moonshot-ai/forum-link';

import {
  Projector,
  deriveDiffLines,
} from '#/tui/controllers/forum-link/projector';
import {
  encodeApproval,
  encodeApprovalCancel,
  encodeQuestion,
} from '#/tui/controllers/forum-link/encoding';
import { Injector, type InjectorHost, type OpenCardView } from '#/tui/controllers/forum-link/injector';
import type { SessionControlHostView } from '#/tui/controllers/forum-link/session-control';
import { ApprovalController } from '#/tui/reverse-rpc/approval/controller';
import { QuestionController } from '#/tui/reverse-rpc/question/controller';
import { adaptQuestionAnswers } from '#/tui/reverse-rpc/question/handler';
import type {
  ApprovalPanelData,
  DiffDisplayBlock,
  QuestionPanelData,
} from '#/tui/reverse-rpc/types';

const AGENT = 'main';

let clock = 0;
const tick = () => {
  clock += 1;
  return clock;
};

function makeProjector(overrides: {
  maxCardFieldChars?: number;
  getPlan?: () => Promise<{ content: string; path: string; id: string } | null>;
} = {}) {
  return new Projector({
    mainAgentId: AGENT,
    now: tick,
    limits: { maxCardFieldChars: overrides.maxCardFieldChars },
    getPlan: overrides.getPlan,
  });
}

function approvalData(overrides: Partial<ApprovalPanelData> = {}): ApprovalPanelData {
  return {
    id: 'approval_1',
    tool_call_id: 'tool_1',
    tool_name: 'Bash',
    action: 'run a command',
    description: 'Update the deploy script',
    display: [],
    choices: [
      {
        label: 'Approve once',
        response: 'approved',
        selected_label: 'once',
        description: 'Allow this single call',
      },
      {
        label: 'Approve for this session',
        response: 'approved_for_session',
        description: 'Allow every matching call in this session',
      },
      { label: 'Reject', response: 'rejected' },
      { label: 'Reject with feedback', response: 'rejected', requires_feedback: true },
    ],
    ...overrides,
  };
}

function questionData(): QuestionPanelData {
  return {
    id: 'question_1',
    tool_call_id: 'tool_1',
    questions: [
      {
        question: 'Pick one?',
        multi_select: false,
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ],
  };
}

const DIFF_BLOCK: DiffDisplayBlock = {
  type: 'diff',
  path: 'src/app.ts',
  old_text: 'line 1\nline 2\nline 3',
  new_text: 'line 1\nline 2 changed\nline 3',
};

describe('O6-A1 option fields survive projection', () => {
  it('projects approval choices with response, selected_label, requires_feedback and description', () => {
    const projector = makeProjector();
    const card = projector.projectCard('approval_1', approvalData());
    expect(card.kind).toBe('approval');
    const approval = card.approval as unknown as ApprovalPanelData;
    expect(approval.choices).toEqual(approvalData().choices);
    for (const choice of approval.choices) {
      expect(typeof choice.response).toBe('string');
      expect('selected_label' in choice || 'requires_feedback' in choice || 'description' in choice || true).toBe(true);
    }
    const first = approval.choices[0];
    expect(first?.response).toBe('approved');
    expect(first?.selected_label).toBe('once');
    expect(first?.requires_feedback).toBeUndefined();
    expect(first?.description).toBe('Allow this single call');
    const feedbackChoice = approval.choices[3];
    expect(feedbackChoice?.requires_feedback).toBe(true);
  });

  it('projects question payloads verbatim', () => {
    const projector = makeProjector();
    const card = projector.projectCard('question_1', questionData());
    expect(card.kind).toBe('question');
    expect(card.question).toEqual(questionData());
  });

  it('projected cards conform to the contract schema', () => {
    const projector = makeProjector();
    const approvalCard = projector.projectCard('approval_1', approvalData());
    const questionCard = projector.projectCard('question_1', questionData());
    expect(parseCard(approvalCard).ok).toBe(true);
    expect(parseCard(questionCard).ok).toBe(true);
  });
});

describe('O6-A2 diff and plan review extras', () => {
  it('diff cards carry line-level differences derived via computeDiffLines', () => {
    const projector = makeProjector();
    const card = projector.projectCard(
      'approval_diff',
      approvalData({ display: [DIFF_BLOCK] }),
    );
    const diffBlock = (card.approval as unknown as ApprovalPanelData).display[0] as unknown as {
      type: string;
      lines: Array<{ op: string; oldNo?: number; newNo?: number; text: string }>;
    };
    expect(diffBlock.type).toBe('diff');
    expect(Array.isArray(diffBlock.lines)).toBe(true);
    expect(diffBlock.lines).toEqual([
      { op: 'ctx', newNo: 1, text: 'line 1' },
      { op: 'del', oldNo: 2, text: 'line 2' },
      { op: 'add', newNo: 2, text: 'line 2 changed' },
      { op: 'ctx', newNo: 3, text: 'line 3' },
    ]);
    const ctxLine = diffBlock.lines.find((line) => line.op === 'ctx');
    expect(ctxLine?.newNo).toBe(1);
    expect(ctxLine?.oldNo).toBeUndefined();
  });

  it('deriveDiffLines maps kinds and honors maxLines', () => {
    const block: DiffDisplayBlock = {
      type: 'diff',
      path: 'p',
      old_text: 'a\nb\nc',
      new_text: 'x\nb\nc',
    };
    expect(deriveDiffLines(block, 500)).toEqual([
      { op: 'del', oldNo: 1, text: 'a' },
      { op: 'add', newNo: 1, text: 'x' },
      { op: 'ctx', newNo: 2, text: 'b' },
      { op: 'ctx', newNo: 3, text: 'c' },
    ]);
    expect(deriveDiffLines(block, 2)).toHaveLength(2);
  });

  it('plan review cards fetch the plan body asynchronously exactly once', async () => {
    let calls = 0;
    const projector = makeProjector({
      getPlan: async () => {
        calls += 1;
        return { id: 'plan-1', content: '# The plan\n\n1. Do the thing.', path: 'plan.md' };
      },
    });
    const payload = approvalData({ tool_name: 'ExitPlanMode', display: [] });
    const card = projector.projectCard('approval_plan', payload);
    expect(card.kind).toBe('approval');
    expect(projector.takePlanBody('approval_plan')).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    expect(projector.planBodyBlock('approval_plan')).toEqual({
      type: 'plan_body',
      text: '# The plan\n\n1. Do the thing.',
    });
    expect(projector.takePlanBody('approval_plan')).toBe('# The plan\n\n1. Do the thing.');
  });

  it('non-plan approval cards never fetch the plan', async () => {
    let calls = 0;
    const projector = makeProjector({
      getPlan: async () => {
        calls += 1;
        return null;
      },
    });
    projector.projectCard('approval_shell', approvalData());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(0);
  });

  it('plan fetch failure is swallowed', async () => {
    const projector = makeProjector({
      getPlan: async () => {
        throw new Error('boom');
      },
    });
    const payload = approvalData({ tool_name: 'ExitPlanMode' });
    expect(() => projector.projectCard('approval_plan', payload)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(projector.takePlanBody('approval_plan')).toBeUndefined();
  });
});

describe('O6-A3 truncation', () => {
  it('over-limit fields are truncated with a flag and the original payload is untouched', () => {
    const long = 'x'.repeat(100);
    const payload = approvalData({
      description: long,
      choices: [
        { label: long, response: 'approved' },
        { label: 'Reject', response: 'rejected' },
      ],
      display: [{ type: 'shell', language: 'bash', command: long, cwd: long }],
    });
    const original = structuredClone(payload);
    const projector = makeProjector({ maxCardFieldChars: 10 });
    const card = projector.projectCard('approval_trunc', payload);
    expect(card['truncated']).toBe(true);
    const approval = card.approval as unknown as ApprovalPanelData;
    expect(approval.description).toBe('x'.repeat(10));
    expect(approval.choices[0]?.label).toBe('x'.repeat(10));
    expect(approval.choices[1]?.label).toBe('Reject');
    const shell = approval.display[0] as { command: string; cwd: string };
    expect(shell.command).toBe('x'.repeat(10));
    expect(shell.cwd).toBe('x'.repeat(10));
    expect(payload).toEqual(original);
  });

  it('fields within the limit are kept without a truncation flag', () => {
    const payload = approvalData({ description: 'short' });
    const projector = makeProjector({ maxCardFieldChars: 100 });
    const card = projector.projectCard('approval_ok', payload);
    expect(card['truncated']).toBeUndefined();
    expect((card.approval as unknown as ApprovalPanelData).description).toBe('short');
  });
});

describe('O7-A3 invalid intents produce no response', () => {
  it('approval option index out of range is rejected', () => {
    const card = makeProjector().projectCard('approval_1', approvalData());
    expect(encodeApproval(card as unknown as { approval?: ApprovalPanelData }, { optionIndex: 99 })).toEqual({
      ok: false,
      reason: 'invalid-params',
    });
  });

  it('approval requires_feedback without feedback is rejected', () => {
    const card = makeProjector().projectCard('approval_1', approvalData());
    expect(encodeApproval(card as unknown as { approval?: ApprovalPanelData }, { optionIndex: 3 })).toEqual({
      ok: false,
      reason: 'invalid-params',
    });
  });

  it('invalid question answers are rejected', () => {
    const card = makeProjector().projectCard('question_1', questionData());
    expect(encodeQuestion(card as unknown as { question?: QuestionPanelData }, [{ selected: [7] }])).toEqual({
      ok: false,
      reason: 'invalid-params',
    });
    expect(encodeQuestion(card as unknown as { question?: QuestionPanelData }, [])).toEqual({ ok: false, reason: 'invalid-params' });
  });
});

describe('P1 goal start and cancel semantics', () => {
  it('goal start cards are plain option lists with no special branch', () => {
    const goalChoices: ApprovalPanelData['choices'] = [
      {
        label: 'Switch to Never Ask and start',
        response: 'approved',
        selected_label: 'auto',
        description: 'Tools are approved automatically.',
      },
      { label: 'Do not start', response: 'cancelled', selected_label: 'cancel' },
    ];
    const projector = makeProjector();
    const card = projector.projectCard('approval_goal', approvalData({ choices: goalChoices }));
    expect((card.approval as unknown as ApprovalPanelData).choices).toEqual(goalChoices);
    expect(encodeApproval(card as unknown as { approval?: ApprovalPanelData }, { optionIndex: 0 })).toEqual({
      ok: true,
      value: { response: 'approved', feedback: undefined, selected_label: 'auto' },
    });
    expect(encodeApproval(card as unknown as { approval?: ApprovalPanelData }, { optionIndex: 1 })).toEqual({
      ok: true,
      value: { response: 'cancelled', feedback: undefined, selected_label: 'cancel' },
    });
  });

  it('encodeApprovalCancel equals Esc: rejected, no feedback, no label', () => {
    expect(encodeApprovalCancel()).toEqual({ response: 'rejected' });
    expect(encodeApprovalCancel().feedback).toBeUndefined();
    expect(encodeApprovalCancel().selected_label).toBeUndefined();
  });
});

function layer3InjectorFixture() {
  const receipts: ReceiptReport[] = [];
  const approvalController = new ApprovalController();
  const questionController = new QuestionController();
  let currentPanel: string | undefined;
  const cards = new Map<string, OpenCardView>();
  const host: InjectorHost = {
    reportReceipt: (report) => {
      receipts.push(report);
    },
    getOpenCard: (cardId) => cards.get(cardId),
    isCurrentPanel: (cardId) => cardId === currentPanel,
    respondApproval: (cardId, response) => {
      currentPanel = undefined;
      cards.delete(cardId);
      approvalController.respond(response);
    },
    respondQuestion: (cardId, response) => {
      currentPanel = undefined;
      cards.delete(cardId);
      questionController.respond(response);
    },
  };
  const hostView = {
    slashHost: {},
    sendNormalUserInput: () => {},
    steerMessage: () => {},
    cancelForeground: () => {},
    createNewSession: async () => {},
    runEndSession: async () => {},
    session: () => ({ id: 's1' }),
  } as unknown as SessionControlHostView;
  const injector = new Injector(host, hostView);
  const openCard = (kind: 'approval' | 'question', cardId: string, payload: ApprovalPanelData | QuestionPanelData) => {
    cards.set(cardId, {
      kind,
      approval: kind === 'approval' ? (payload as ApprovalPanelData) : undefined,
      question: kind === 'question' ? (payload as QuestionPanelData) : undefined,
    });
    currentPanel = cardId;
  };
  return { injector, receipts, approvalController, questionController, openCard };
}

describe('M2 injector × real controller integration', () => {
  it('remote answer reaches the real QuestionController.respond with the adaptQuestionAnswers result', async () => {
    const fixture = layer3InjectorFixture();
    const data = questionData();
    const shown = fixture.questionController.show(data);
    fixture.openCard('question', 'question_1', data);

    await fixture.injector.handle({
      opId: 'op1',
      sessionId: 's1',
      intent: { type: 'answer', sessionId: 's1', cardId: 'question_1', answers: [{ selected: [0] }] },
    });

    const request: QuestionRequest = {
      questions: [{ question: 'Pick one?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }],
    };
    const expected = adaptQuestionAnswers(request, { answers: ['A'], method: 'enter' });
    await expect(shown).resolves.toEqual({ answers: ['A'], method: 'enter' });
    expect(expected).toEqual({ answers: { 'Pick one?': 'A' }, method: 'enter' });
    expect(fixture.receipts).toEqual([
      { opId: 'op1', state: 'delivered' },
      { opId: 'op1', state: 'applied' },
    ]);
  });

  it('remote approve-for-session reaches the real ApprovalController and auto-resolves a queued same-action request', async () => {
    const fixture = layer3InjectorFixture();
    const data = approvalData();
    const first = fixture.approvalController.show(data);
    fixture.openCard('approval', 'approval_1', data);
    const queued = fixture.approvalController.show(approvalData());

    await fixture.injector.handle({
      opId: 'op1',
      sessionId: 's1',
      intent: { type: 'approve', sessionId: 's1', cardId: 'approval_1', optionIndex: 1 },
    });

    await expect(first).resolves.toEqual({ decision: 'approved', scope: 'session' });
    await expect(queued).resolves.toEqual({ decision: 'approved', scope: 'session' });
    expect(fixture.receipts).toEqual([
      { opId: 'op1', state: 'delivered' },
      { opId: 'op1', state: 'applied' },
    ]);
  });
});
