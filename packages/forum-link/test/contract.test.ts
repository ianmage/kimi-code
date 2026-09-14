import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  type ActionFrame,
  type ControlFrame,
  type Descriptor,
  type Entry,
  type ParseResult,
  type UplinkFrame,
  parseActionFrame,
  parseControlFrame,
  parseUplinkFrame,
} from '#/contract/frames';
import * as hubParse from '#/hub/parse';

const distDir = fileURLToPath(new URL('../dist', import.meta.url));

describe('Phase 1.1 package skeleton', () => {
  it('dist/hub.mjs exists as the only hub entry artifact', () => {
    expect(existsSync(distDir)).toBe(true);
    const files = readdirSync(distDir);
    const hubFiles = files.filter((f) => f.startsWith('hub'));
    expect(hubFiles).toEqual(['hub.mjs']);
  });

  it('dist/hub.mjs inlines the page title literal', () => {
    const code = readFileSync(`${distDir}/hub.mjs`, 'utf8');
    expect(code).toContain('Forum Link');
  });

  it('dist/hub.mjs has no bare zod import', () => {
    const code = readFileSync(`${distDir}/hub.mjs`, 'utf8');
    expect(code).not.toMatch(/from\s+['"]zod['"]/);
    expect(code).not.toMatch(/require\(\s*['"]zod['"]\s*\)/);
  });

  it('src/index.ts exports a non-empty surface', async () => {
    const mod = await import('#/index');
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });
});

function unwrapFrame<T>(result: ParseResult<T>): T {
  if (result.ok) return result.frame;
  throw new Error(`expected parse success, got issue: ${result.issue}`);
}

function issueOf(result: ParseResult<unknown>): string {
  if (result.ok) throw new Error(`expected parse failure, got frame: ${JSON.stringify(result.frame)}`);
  return result.issue;
}

const ACTION_TYPES = [
  'answer-question',
  'approve',
  'deny',
  'send-message',
  'pause',
  'end-session',
] as const satisfies readonly ActionFrame['type'][];

const DESCRIPTOR_SAMPLE = {
  sessionId: 'session-1',
  machineName: 'machine-1',
  projectName: 'project-1',
  title: 'Fix login bug',
  status: 'running',
} as const satisfies Descriptor;

const MESSAGE_ENTRY_SAMPLE = {
  kind: 'message',
  role: 'user',
  text: 'hello',
} as const satisfies Entry;

const SNAPSHOT_SAMPLE = {
  type: 'snapshot',
  target: 'thread-1',
  descriptor: DESCRIPTOR_SAMPLE,
  entries: [
    { seq: 1, entry: MESSAGE_ENTRY_SAMPLE },
    { seq: 2, entry: { kind: 'card-settled', cardId: 'card-1', outcome: 'answered' } },
  ],
  maxSeq: 2,
  openCards: [
    { cardId: 'card-1', kind: 'question', state: 'answered' },
    { cardId: 'card-2', kind: 'approval', state: 'open' },
  ],
} as const satisfies ControlFrame;

const VALID_ACTION_SAMPLES = {
  'answer-question': { type: 'answer-question', target: 'thread-1', cardId: 'card-1', answer: 'option-b' },
  approve: { type: 'approve', target: 'thread-1', cardId: 'card-1' },
  deny: { type: 'deny', target: 'thread-1', cardId: 'card-2', feedback: 'too risky' },
  'send-message': { type: 'send-message', target: 'thread-1', text: 'please continue' },
  pause: { type: 'pause', target: 'thread-1' },
  'end-session': { type: 'end-session', target: 'thread-1' },
} as const satisfies Record<ActionFrame['type'], ActionFrame>;

const UPLINK_SAMPLES = [
  { type: 'register', descriptor: DESCRIPTOR_SAMPLE },
  { type: 'entry', entry: MESSAGE_ENTRY_SAMPLE },
  { type: 'descriptor', descriptor: DESCRIPTOR_SAMPLE },
] as const satisfies readonly UplinkFrame[];

const SHARED_SAMPLES: readonly unknown[] = [
  ...Object.values(VALID_ACTION_SAMPLES),
  ...UPLINK_SAMPLES,
  { type: 'heartbeat' },
  { type: 'error', message: 'boom' },
  { type: 'snapshot-request', target: 'thread-1' },
  SNAPSHOT_SAMPLE,
  { type: 'approve', target: 'thread-1', cardId: 'card-1', approved_for_session: true },
  { type: 'approve-session', target: 'thread-1' },
  { type: 'escalate', target: 'thread-1' },
  { type: 'entry', entry: { kind: 'tool-call', toolName: 'Bash' } },
  null,
  42,
  'string',
];

const FRAME_FAMILIES = ['uplink', 'action', 'control'] as const;

const CONTRACT_PARSERS = {
  uplink: parseUplinkFrame,
  action: parseActionFrame,
  control: parseControlFrame,
};

const HUB_PARSERS = {
  uplink: hubParse.parseUplinkFrame,
  action: hubParse.parseActionFrame,
  control: hubParse.parseControlFrame,
};

describe('Phase 1.2 frames protocol', () => {
  it('accepts exactly the six action types and rejects unknown ones', () => {
    for (const actionType of ACTION_TYPES) {
      const result = parseActionFrame(VALID_ACTION_SAMPLES[actionType]);
      expect(result.ok, `action type: ${actionType}`).toBe(true);
    }
    const unknownSamples = [
      { type: 'approve-session', target: 'thread-1' },
      { type: 'escalate', target: 'thread-1' },
      { type: 'resume', target: 'thread-1' },
    ];
    for (const sample of unknownSamples) {
      expect(parseActionFrame(sample).ok, JSON.stringify(sample)).toBe(false);
    }
  });

  it('rejects approval payloads carrying out-of-protocol fields', () => {
    const samples = [
      { type: 'approve', target: 't', cardId: 'c', approved_for_session: true },
      { type: 'approve', target: 't', cardId: 'c', scope: 'session' },
      { type: 'approve', target: 't', cardId: 'c', permissionMode: 'always-ask' },
      { type: 'approve', target: 't', cardId: 'c', extra: true },
    ];
    for (const sample of samples) {
      expect(issueOf(parseActionFrame(sample)).length, JSON.stringify(sample)).toBeGreaterThan(0);
    }
    const leakSample = { type: 'approve', target: 't', cardId: 'c', scope: 'SECRET-INPUT-VALUE' };
    expect(issueOf(parseActionFrame(leakSample))).not.toContain('SECRET-INPUT-VALUE');
  });

  it('accepts only the whitelisted entry kinds and fields', () => {
    const validEntries = [
      MESSAGE_ENTRY_SAMPLE,
      { kind: 'message', role: 'assistant', text: 'done', truncated: true },
      { kind: 'question-card', cardId: 'q-1', question: 'Which fix?', options: ['quick', 'proper'] },
      { kind: 'approval-card', cardId: 'a-1', toolName: 'Bash', action: 'exec', summary: 'rm -rf build' },
      { kind: 'status-marker', status: 'waiting-question' },
      { kind: 'card-settled', cardId: 'q-1', outcome: 'answered' },
    ];
    for (const entry of validEntries) {
      const result = parseUplinkFrame({ type: 'entry', entry });
      expect(result.ok, JSON.stringify(entry)).toBe(true);
    }
    const invalidEntries = [
      { kind: 'message', role: 'assistant', text: 'x', thinking: 'internal reasoning' },
      { kind: 'tool-call', toolName: 'Bash', command: 'ls' },
      { kind: 'thinking', text: 'internal reasoning' },
      { kind: 'card-settled', cardId: 'q-1', outcome: 'answered', reason: 'remote' },
      { kind: 'message', role: 'system', text: 'x' },
      { kind: 'message' },
      { kind: 'question-card', cardId: 'q-1', question: 'Which?', options: ['a'], answer: 'a' },
    ];
    for (const entry of invalidEntries) {
      expect(parseUplinkFrame({ type: 'entry', entry }).ok, JSON.stringify(entry)).toBe(false);
    }
  });

  it('parses samples identically through the contract entry and the hub entry', () => {
    expect(SHARED_SAMPLES.length).toBeGreaterThanOrEqual(12);
    for (const sample of SHARED_SAMPLES) {
      for (const family of FRAME_FAMILIES) {
        expect(HUB_PARSERS[family](sample)).toStrictEqual(CONTRACT_PARSERS[family](sample));
      }
    }
  });

  it('rejects unknown keys on every object schema', () => {
    const results = [
      parseUplinkFrame({ type: 'register', descriptor: DESCRIPTOR_SAMPLE, extra: 1 }),
      parseUplinkFrame({ type: 'register', descriptor: { ...DESCRIPTOR_SAMPLE, extra: 1 } }),
      parseUplinkFrame({ type: 'descriptor', descriptor: { ...DESCRIPTOR_SAMPLE, extra: 1 } }),
      parseUplinkFrame({ type: 'entry', entry: { kind: 'status-marker', status: 'idle' }, extra: 1 }),
      parseControlFrame({ type: 'snapshot-request', target: 't', extra: 1 }),
      parseControlFrame({ type: 'heartbeat', extra: 1 }),
      parseControlFrame({ type: 'error', message: 'x', extra: 1 }),
      parseControlFrame({ ...SNAPSHOT_SAMPLE, extra: 1 }),
      parseControlFrame({
        ...SNAPSHOT_SAMPLE,
        openCards: [{ cardId: 'c', kind: 'question', state: 'open', extra: 1 }],
      }),
      parseControlFrame({
        ...SNAPSHOT_SAMPLE,
        entries: [{ seq: 1, entry: MESSAGE_ENTRY_SAMPLE, extra: 1 }],
      }),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
    }
  });

  it('keeps approve payloads free of decision-carrying fields', () => {
    const frame = unwrapFrame(parseActionFrame({ type: 'approve', target: 'thread-1', cardId: 'card-1' }));
    expect(Object.keys(frame).toSorted()).toEqual(['cardId', 'target', 'type']);
    const record = frame as Record<string, unknown>;
    expect(record['scope']).toBeUndefined();
    expect(record['approved_for_session']).toBeUndefined();
    expect(record['permissionMode']).toBeUndefined();
    const withFeedback = unwrapFrame(
      parseActionFrame({ type: 'approve', target: 'thread-1', cardId: 'card-1', feedback: 'looks good' }),
    );
    expect(Object.keys(withFeedback).toSorted()).toEqual(['cardId', 'feedback', 'target', 'type']);
  });

  it('rejects non-object and null inputs without throwing', () => {
    for (const input of [null, 'string', 42, true, [], undefined]) {
      const result = parseActionFrame(input);
      expect(result.ok).toBe(false);
      expect(issueOf(result).length).toBeGreaterThan(0);
    }
  });

  it('accepts valid control frames', () => {
    expect(parseControlFrame({ type: 'heartbeat' }).ok).toBe(true);
    expect(parseControlFrame({ type: 'error', message: 'boom' }).ok).toBe(true);
    expect(parseControlFrame({ type: 'snapshot-request', target: 'thread-1' }).ok).toBe(true);
    expect(parseControlFrame(SNAPSHOT_SAMPLE).ok).toBe(true);
  });

  it('accepts valid uplink frames', () => {
    for (const sample of UPLINK_SAMPLES) {
      expect(parseUplinkFrame(sample).ok).toBe(true);
    }
  });

  it('re-exports the three parse functions from the hub entry', () => {
    expect(Object.keys(hubParse).toSorted()).toEqual([
      'parseActionFrame',
      'parseControlFrame',
      'parseUplinkFrame',
    ]);
  });
});
