import { z } from 'zod';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: string };

export const displayBlockSchema = z.looseObject({
  type: z.string(),
});

export type DisplayBlock = z.infer<typeof displayBlockSchema>;

export const OP_TYPES = [
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
] as const;

export type OpType = (typeof OP_TYPES)[number];

export const opTypeSchema = z.enum(OP_TYPES);

export const answerPayloadSchema = z.strictObject({
  selected: z.array(z.number().int()),
  freeText: z.string().optional(),
});

export type AnswerPayload = z.infer<typeof answerPayloadSchema>;

export const opIntentSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('approve'),
    sessionId: z.string(),
    cardId: z.string(),
    optionIndex: z.number().int(),
    feedback: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal('approve-cancel'),
    sessionId: z.string(),
    cardId: z.string(),
  }),
  z.strictObject({
    type: z.literal('answer'),
    sessionId: z.string(),
    cardId: z.string(),
    answers: z.array(answerPayloadSchema),
  }),
  z.strictObject({
    type: z.literal('answer-cancel'),
    sessionId: z.string(),
    cardId: z.string(),
  }),
  z.strictObject({
    type: z.literal('send'),
    sessionId: z.string(),
    text: z.string(),
  }),
  z.strictObject({
    type: z.literal('steer'),
    sessionId: z.string(),
    text: z.string(),
  }),
  z.strictObject({
    type: z.literal('pause'),
    sessionId: z.string(),
  }),
  z.strictObject({
    type: z.literal('end-session'),
    sessionId: z.string(),
  }),
  z.strictObject({
    type: z.literal('set-permission-mode'),
    sessionId: z.string(),
    mode: z.string(),
  }),
  z.strictObject({
    type: z.literal('switch-model'),
    sessionId: z.string(),
    alias: z.string(),
    effort: z.string().optional(),
    scope: z.enum(['session', 'persist']).optional(),
  }),
  z.strictObject({
    type: z.literal('new-session'),
    sessionId: z.string(),
  }),
  z.strictObject({
    type: z.literal('goal-set'),
    sessionId: z.string(),
    objective: z.string(),
    replace: z.boolean(),
    startMode: z.enum(['auto', 'manual', 'yolo']).optional(),
  }),
  z.strictObject({
    type: z.literal('goal-pause'),
    sessionId: z.string(),
  }),
  z.strictObject({
    type: z.literal('goal-resume'),
    sessionId: z.string(),
  }),
  z.strictObject({
    type: z.literal('goal-cancel'),
    sessionId: z.string(),
  }),
]);

export type OpIntent = z.infer<typeof opIntentSchema>;

export const descriptorSchema = z.strictObject({
  sessionId: z.string(),
  machine: z.strictObject({
    tokenName: z.string(),
    hostname: z.string(),
  }),
  project: z.string(),
  title: z.string(),
  kind: z.string(),
  capabilities: z.array(opTypeSchema),
});

export type Descriptor = z.infer<typeof descriptorSchema>;

export const RECEIPT_STATES = ['accepted', 'delivered', 'applied', 'rejected', 'lost'] as const;

export type ReceiptState = (typeof RECEIPT_STATES)[number];

export const receiptStateSchema = z.enum(RECEIPT_STATES);

export const RECEIPT_REASONS = [
  'bad-shape',
  'thread-unknown',
  'thread-offline',
  'not-capable',
  'card-closed',
  'session-busy',
  'not-running',
  'invalid-params',
  'postcondition-failed',
  'not-delivered',
  'thread-removed',
  'machine-revoked',
] as const;

export type ReceiptReason = (typeof RECEIPT_REASONS)[number];

export const receiptReasonSchema = z.enum(RECEIPT_REASONS);

export const receiptSchema = z.strictObject({
  opId: z.string(),
  sessionId: z.string(),
  opType: opTypeSchema,
  cardId: z.string().optional(),
  state: receiptStateSchema,
  reason: receiptReasonSchema.optional(),
  at: z.number(),
});

export type Receipt = z.infer<typeof receiptSchema>;

export const TOKEN_ROLES = ['machine', 'device'] as const;

export type TokenRole = (typeof TOKEN_ROLES)[number];

export const tokenRoleSchema = z.enum(TOKEN_ROLES);

export const tokenRecordSchema = z.strictObject({
  tokenId: z.string(),
  name: z.string(),
  role: tokenRoleSchema,
  hash: z.string(),
  createdAt: z.number(),
});

export type TokenRecord = z.infer<typeof tokenRecordSchema>;

export const LIMITS = {
  timelineRingLength: 200,
  receiptsPerThread: 100,
  maxTextFieldLength: 4000,
  maxDisplayBlocks: 500,
  maxSnapshotEntries: 2000,
} as const;

function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

function parseValue<T>(schema: z.ZodType<T>, input: unknown): ParseResult<T> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, issues: summarizeIssues(result.error) };
}

export function parseDisplayBlock(input: unknown): ParseResult<DisplayBlock> {
  return parseValue(displayBlockSchema, input);
}

export function parseOpIntent(input: unknown): ParseResult<OpIntent> {
  return parseValue(opIntentSchema, input);
}

export function parseDescriptor(input: unknown): ParseResult<Descriptor> {
  return parseValue(descriptorSchema, input);
}

export function parseReceipt(input: unknown): ParseResult<Receipt> {
  return parseValue(receiptSchema, input);
}

export function parseTokenRecord(input: unknown): ParseResult<TokenRecord> {
  return parseValue(tokenRecordSchema, input);
}