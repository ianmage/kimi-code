import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type {
  Descriptor,
  OpIntent,
  OpType,
  Receipt,
  ReceiptReason,
  ReceiptState,
  TimelineEntry,
  UplinkBatch,
  WorkerSnapshot,
} from '#/contract/index';
import {
  OP_TYPES,
  RECEIPT_REASONS,
  RECEIPT_STATES,
  parseAdminIssueRequest,
  parseAdminToken,
  parseBrowserLoginRequest,
  parseBrowserOpsRequest,
  parseCard,
  parseDisplayBlock,
  parseOpIntent,
  parseReceipt,
  parseThreadSummary,
  parseUplinkBatch,
  parseWorkerRegister,
  parseWorkerReceiptReport,
  parseWorkerUnregister,
} from '#/contract/index';

const distDir = fileURLToPath(new URL('../dist', import.meta.url));

describe('Phase 1.1 package skeleton', () => {
  it('dist/hub.mjs exists as the only hub entry artifact', () => {
    expect(existsSync(distDir)).toBe(true);
    const files = readdirSync(distDir);
    const hubFiles = files.filter((f) => f.startsWith('hub'));
    expect(hubFiles).toEqual(['hub.mjs']);
  });

  it('dist/hub.mjs imports only node: specifiers', () => {
    const code = readFileSync(`${distDir}/hub.mjs`, 'utf8');
    const imports = [...code.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    for (const specifier of imports) {
      expect(specifier.startsWith('node:'), specifier).toBe(true);
    }
  });

  it('src/index.ts exports a non-empty surface', async () => {
    const mod = await import('#/index');
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });
});

function expectOk(result: { ok: boolean }): void {
  expect(result.ok).toBe(true);
}

function expectFail(result: { ok: boolean; issues?: string }): string {
  expect(result.ok).toBe(false);
  const issues = result.issues;
  expect(typeof issues === 'string' && issues.length > 0).toBe(true);
  return issues ?? '';
}

const NON_OBJECTS: readonly unknown[] = [null, 'string', 42, true, [], undefined];

const DESCRIPTOR_SAMPLE: Descriptor = {
  sessionId: 'session-1',
  machine: { tokenName: 'laptop', hostname: 'host-1' },
  project: 'kimi-code',
  title: 'Fix login bug',
  kind: 'interactive',
  capabilities: ['approve', 'send', 'pause'],
};

const RECEIPT_SAMPLE: Receipt = {
  opId: 'op-1',
  sessionId: 'session-1',
  opType: 'approve',
  state: 'accepted',
  at: 1717000000000,
};

describe('V1 shared contract', () => {
  it('accepts unknown DisplayBlock types and preserves all fields', () => {
    const block = { type: 'future-block-xyz', command: 'ls -la', cwd: '/tmp', nested: { a: 1 } };
    const result = parseDisplayBlock(block);
    expectOk(result);
    if (result.ok) expect(result.value).toEqual(block);
  });

  it('rejects DisplayBlock inputs without a string type', () => {
    expectFail(parseDisplayBlock({}));
    expectFail(parseDisplayBlock({ type: 42 }));
    for (const input of NON_OBJECTS) expectFail(parseDisplayBlock(input));
  });

  it('OpType is the closed 14-value enum', () => {
    expect(OP_TYPES).toEqual([
      'approve',
      'approve-cancel',
      'answer',
      'answer-cancel',
      'send',
      'steer',
      'pause',
      'end-session',
      'set-permission-mode',
      'switch-model',
      'new-session',
      'goal-set',
      'goal-pause',
      'goal-resume',
      'goal-cancel',
    ]);
  });

  it('accepts every OpIntent variant and rejects out-of-enum intents without throwing', () => {
    const samples: Record<OpType, OpIntent> = {
      approve: { type: 'approve', sessionId: 's', cardId: 'c1', optionIndex: 0 },
      'approve-cancel': { type: 'approve-cancel', sessionId: 's', cardId: 'c1' },
      answer: {
        type: 'answer',
        sessionId: 's',
        cardId: 'c1',
        answers: [{ selected: [0], freeText: 'why' }],
      },
      'answer-cancel': { type: 'answer-cancel', sessionId: 's', cardId: 'c1' },
      send: { type: 'send', sessionId: 's', text: 'please continue' },
      steer: { type: 'steer', sessionId: 's', text: 'change direction' },
      pause: { type: 'pause', sessionId: 's' },
      'end-session': { type: 'end-session', sessionId: 's' },
      'set-permission-mode': { type: 'set-permission-mode', sessionId: 's', mode: 'auto' },
      'switch-model': { type: 'switch-model', sessionId: 's', alias: 'k2', effort: 'high' },
      'new-session': { type: 'new-session', sessionId: 's' },
      'goal-set': { type: 'goal-set', sessionId: 's', objective: 'ship it', replace: false },
      'goal-pause': { type: 'goal-pause', sessionId: 's' },
      'goal-resume': { type: 'goal-resume', sessionId: 's' },
      'goal-cancel': { type: 'goal-cancel', sessionId: 's' },
    };
    for (const intent of Object.values(samples)) expectOk(parseOpIntent(intent));
    for (const intent of Object.values(samples)) {
      const missing = { ...intent } as Record<string, unknown>;
      delete missing['sessionId'];
      expectFail(parseOpIntent(missing));
    }
    expectFail(parseOpIntent({ type: 'escalate', sessionId: 's' }));
    expectFail(parseOpIntent({ type: 'approve-session', sessionId: 's' }));
    expectFail(parseOpIntent({ type: 'resume', sessionId: 's' }));
    expectFail(parseOpIntent({ type: 'approve', sessionId: 's' }));
    expectFail(parseOpIntent({ type: 'send', sessionId: 's', text: 42 }));
    for (const input of NON_OBJECTS) expectFail(parseOpIntent(input));
  });

  it('ReceiptReason accepts exactly the 12 values and rejects others', () => {
    expect(RECEIPT_REASONS).toHaveLength(12);
    for (const reason of RECEIPT_REASONS) {
      expectOk(parseReceipt({ ...RECEIPT_SAMPLE, reason }));
    }
    expectFail(parseReceipt({ ...RECEIPT_SAMPLE, reason: 'miscellaneous' }));
    expectFail(parseReceipt({ ...RECEIPT_SAMPLE, reason: 'unknown-op' }));
  });

  it('ReceiptState is the closed 5-value enum', () => {
    expect(RECEIPT_STATES).toEqual(['accepted', 'delivered', 'applied', 'rejected', 'lost']);
  });

  it('parses valid receipts and rejects missing or mistyped fields', () => {
    expectOk(parseReceipt(RECEIPT_SAMPLE));
    expectOk(parseReceipt({ ...RECEIPT_SAMPLE, cardId: 'c1', reason: 'card-closed' }));
    expectFail(parseReceipt({ ...RECEIPT_SAMPLE, opId: 42 }));
    expectFail(parseReceipt({ ...RECEIPT_SAMPLE, state: 'queued' }));
    expectFail(parseReceipt({ opId: 'op-1', sessionId: 's', opType: 'approve' }));
    for (const input of NON_OBJECTS) expectFail(parseReceipt(input));
  });

  it('descriptor requires every field and rejects unknown ones', () => {
    expectOk(parseOpIntent({ type: 'send', sessionId: 's', text: 'x' }));
    const malformed = { ...DESCRIPTOR_SAMPLE, extra: true } as unknown;
    expect(parseOpIntent(malformed).ok).toBe(false);
  });
});

const TIMELINE_ENTRIES: TimelineEntry[] = [
  { seq: 1, at: 1717000000000, kind: 'user-message', text: 'hello' },
  {
    seq: 2,
    at: 1717000000100,
    kind: 'assistant-turn',
    text: 'working on it',
    truncated: false,
  },
  { seq: 3, at: 1717000000200, kind: 'tool-call', toolCallId: 'tc-1', name: 'Bash', keyArg: 'ls' },
  { seq: 4, at: 1717000000300, kind: 'tool-result', toolCallId: 'tc-1', ok: true, chip: '0 files' },
  { seq: 5, at: 1717000000400, kind: 'card-opened', card: { cardId: 'c1', kind: 'question' } },
  { seq: 6, at: 1717000000500, kind: 'card-settled', cardId: 'c1', outcome: 'answered' },
  { seq: 7, at: 1717000000600, kind: 'status', phase: 'thinking' },
];

const OVERVIEW_SAMPLE = {
  rev: 1,
  phase: 'idle',
  isCompacting: false,
  model: 'kimi',
  thinkingEffort: 'high',
  permissionMode: 'ask',
  planMode: false,
  contextUsage: 0.25,
  goal: null,
  todos: [],
  subagents: [],
  backgroundTasks: [],
  models: [],
  lastLine: '',
  sampledAt: 1717000000000,
};

function workerSnapshot(): WorkerSnapshot {
  return {
    workerId: 'worker-1',
    threads: [
      {
        descriptor: DESCRIPTOR_SAMPLE,
        overview: OVERVIEW_SAMPLE,
        timeline: TIMELINE_ENTRIES,
        openCards: [],
      },
    ],
    recentReceipts: [{ opId: 'op-1', state: 'delivered' }],
  };
}

describe('V2 worker face', () => {
  it('accepts a valid worker register snapshot', () => {
    expectOk(parseWorkerRegister(workerSnapshot()));
  });

  it('rejects snapshots with missing or mistyped fields', () => {
    const snapshot = workerSnapshot() as unknown as Record<string, unknown>;
    expectFail(parseWorkerRegister({ ...snapshot, workerId: 42 }));
    expectFail(parseWorkerRegister({ ...snapshot, threads: 'nope' }));
    expectFail(parseWorkerRegister({ threads: [] }));
    const noRecent = { ...snapshot, recentReceipts: undefined };
    delete noRecent['recentReceipts'];
    expectFail(parseWorkerRegister(noRecent));
    for (const input of NON_OBJECTS) expectFail(parseWorkerRegister(input));
  });

  it('accepts a valid uplink batch and rejects seq gaps at the schema level', () => {
    const batch: UplinkBatch = {
      workerId: 'worker-1',
      frames: [
        { sessionId: 'session-1', kind: 'timeline', entries: [TIMELINE_ENTRIES[0]!] },
        {
          sessionId: 'session-1',
          kind: 'overview',
          overview: { ...OVERVIEW_SAMPLE, rev: 2, phase: 'composing', sampledAt: 1717000001000 },
        },
        { sessionId: 'session-1', kind: 'descriptor', descriptor: DESCRIPTOR_SAMPLE },
      ],
    };
    expectOk(parseUplinkBatch(batch));
    expectFail(parseUplinkBatch({ ...batch, frames: [{ sessionId: 's', kind: 'timeline' }] }));
    expectFail(parseUplinkBatch({ ...batch, workerId: 'w', frames: [{ kind: 'timeline' }] }));
    expectFail(parseUplinkBatch({ workerId: 'w', frames: [] }));
    for (const input of NON_OBJECTS) expectFail(parseUplinkBatch(input));
  });

  it('accepts receipt reports and unregister payloads', () => {
    expectOk(parseWorkerReceiptReport({ workerId: 'w1', receipts: [{ opId: 'op-1', state: 'applied' }] }));
    expectOk(
      parseWorkerReceiptReport({
        workerId: 'w1',
        receipts: [{ opId: 'op-1', state: 'rejected', reason: 'card-closed' }],
      }),
    );
    expectFail(parseWorkerReceiptReport({ workerId: 'w1', receipts: [{ opId: 'op-1', state: 'accepted' }] }));
    expectFail(parseWorkerReceiptReport({ receipts: [] }));
    expectOk(
      parseWorkerUnregister({
        workerId: 'w1',
        finalReceipts: [{ opId: 'op-1', state: 'applied' }],
      }),
    );
    expectFail(parseWorkerUnregister({ workerId: 'w1' }));
    for (const input of NON_OBJECTS) expectFail(parseWorkerReceiptReport(input));
  });

  it('cards carry panel payloads and diff/plan extras through the loose schema', () => {
    const approvalCard = {
      cardId: 'approval_1',
      kind: 'approval',
      openedAt: 1717000000000,
      approval: {
        id: 'approval_1',
        tool_call_id: 'tool_1',
        tool_name: 'Edit',
        action: 'edit',
        description: '',
        display: [
          {
            type: 'diff',
            path: 'src/a.ts',
            old_text: 'a',
            new_text: 'b',
            lines: [
              { op: 'del', oldNo: 1, text: 'a' },
              { op: 'add', newNo: 1, text: 'b' },
            ],
          },
          { type: 'plan_body', text: '# Plan' },
        ],
        choices: [{ label: 'Approve once', response: 'approved' }],
      },
    };
    expectOk(parseCard(approvalCard));
    const questionCard = {
      cardId: 'question_1',
      kind: 'question',
      openedAt: 1717000000000,
      question: {
        id: 'question_1',
        tool_call_id: 'tool_1',
        questions: [{ question: 'Q?', multi_select: false, options: [{ label: 'A' }] }],
      },
    };
    expectOk(parseCard(questionCard));
    expectOk(parseCard({ ...approvalCard, truncated: true }));
    expectFail(parseCard({ cardId: 'c', kind: 'other', openedAt: 1 }));
    expectFail(parseCard({ cardId: 'c', kind: 'approval' }));
    for (const input of NON_OBJECTS) expectFail(parseCard(input));
  });
});

describe('V3 browser face', () => {
  it('login frame requires a string token', () => {
    expectOk(parseBrowserLoginRequest({ token: 'device-secret' }));
    expectFail(parseBrowserLoginRequest({}));
    expectFail(parseBrowserLoginRequest({ token: 42 }));
    for (const input of NON_OBJECTS) expectFail(parseBrowserLoginRequest(input));
  });

  it('ops frame requires sessionId and a valid OpIntent', () => {
    expectOk(parseBrowserOpsRequest({ sessionId: 's', intent: { type: 'pause', sessionId: 's' } }));
    expectFail(parseBrowserOpsRequest({ sessionId: 's', intent: { type: 'nope', sessionId: 's' } }));
    expectFail(parseBrowserOpsRequest({ intent: { type: 'pause', sessionId: 's' } }));
    for (const input of NON_OBJECTS) expectFail(parseBrowserOpsRequest(input));
  });

  it('thread summary carries descriptor, overview, online, openCards and lastActivityAt', () => {
    const summary = {
      descriptor: DESCRIPTOR_SAMPLE,
      overview: OVERVIEW_SAMPLE,
      online: true,
      openCards: [{ cardId: 'c1', kind: 'question', openedAt: 1717000000000 }],
      lastActivityAt: 1717000000000,
    };
    const result = parseThreadSummary(summary);
    expectOk(result);
    expectFail(parseThreadSummary({ ...summary, online: 'yes' }));
    expectFail(parseThreadSummary({ ...summary, descriptor: { sessionId: 's' } }));
    for (const input of NON_OBJECTS) expectFail(parseThreadSummary(input));
  });
});

describe('admin face', () => {
  it('issue frame requires role and name', () => {
    expectOk(parseAdminIssueRequest({ role: 'device', name: 'phone' }));
    expectOk(parseAdminIssueRequest({ role: 'machine', name: 'laptop' }));
    expectFail(parseAdminIssueRequest({ role: 'admin', name: 'x' }));
    expectFail(parseAdminIssueRequest({ role: 'device' }));
    expectFail(parseAdminIssueRequest({ name: 'x' }));
    for (const input of NON_OBJECTS) expectFail(parseAdminIssueRequest(input));
  });

  it('token view requires tokenId, name, role and createdAt', () => {
    expectOk(parseAdminToken({ tokenId: 't1', name: 'phone', role: 'device', createdAt: 1717000000000 }));
    expectFail(parseAdminToken({ tokenId: 't1', name: 'phone', role: 'device' }));
    expectFail(parseAdminToken({ tokenId: 't1', name: 'phone', role: 'superuser', createdAt: 1 }));
    for (const input of NON_OBJECTS) expectFail(parseAdminToken(input));
  });
});

describe('parse* discriminant contract', () => {
  const parsers = [
    parseDisplayBlock,
    parseOpIntent,
    parseReceipt,
    parseWorkerRegister,
    parseUplinkBatch,
    parseWorkerReceiptReport,
    parseWorkerUnregister,
    parseBrowserLoginRequest,
    parseBrowserOpsRequest,
    parseThreadSummary,
    parseAdminIssueRequest,
    parseAdminToken,
  ] as const;

  it('never throws on any input', () => {
    const hostile: unknown[] = [
      ...NON_OBJECTS,
      { type: 'approve' },
      { type: Object.create(null) },
      JSON.parse('{"type":"approve","sessionId":null}'),
      new Date(),
    ];
    for (const parser of parsers) {
      for (const input of hostile) {
        expect(() => parser(input as never)).not.toThrow();
      }
    }
  });

  it('returns issues strings, never issue arrays', () => {
    let checked = 0;
    for (const parser of parsers) {
      const result = parser(42 as never);
      if (!result.ok) {
        expect(typeof result.issues).toBe('string');
        checked += 1;
      }
    }
    expect(checked).toBe(parsers.length);
  });
});
