import { z } from 'zod';

import {
  type ParseResult,
  descriptorSchema,
  parseDescriptor,
  receiptReasonSchema,
} from './shared';

export const timelineEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    seq: z.number().int(),
    at: z.number(),
    kind: z.literal('user-message'),
    text: z.string(),
  }),
  z.strictObject({
    seq: z.number().int(),
    at: z.number(),
    kind: z.literal('assistant-turn'),
    text: z.string(),
    truncated: z.boolean(),
  }),
  z.strictObject({
    seq: z.number().int(),
    at: z.number(),
    kind: z.literal('tool-call'),
    toolCallId: z.string(),
    name: z.string(),
    keyArg: z.string(),
  }),
  z.strictObject({
    seq: z.number().int(),
    at: z.number(),
    kind: z.literal('tool-result'),
    toolCallId: z.string(),
    ok: z.boolean(),
    chip: z.string().optional(),
  }),
  z.strictObject({
    seq: z.number().int(),
    at: z.number(),
    kind: z.literal('card-opened'),
    card: z.looseObject({
      cardId: z.string(),
      kind: z.enum(['approval', 'question']),
    }),
  }),
  z.strictObject({
    seq: z.number().int(),
    at: z.number(),
    kind: z.literal('card-settled'),
    cardId: z.string(),
    outcome: z.string(),
  }),
  z.strictObject({
    seq: z.number().int(),
    at: z.number(),
    kind: z.literal('status'),
    phase: z.string(),
  }),
]);

export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

export const diffExtraLineSchema = z.strictObject({
  op: z.enum(['add', 'del', 'ctx']),
  oldNo: z.number().int().optional(),
  newNo: z.number().int().optional(),
  text: z.string(),
});

export type DiffExtraLine = z.infer<typeof diffExtraLineSchema>;

export const planBodyExtraSchema = z.strictObject({
  type: z.literal('plan_body'),
  text: z.string(),
});

export type PlanBodyExtra = z.infer<typeof planBodyExtraSchema>;

export const cardSchema = z.looseObject({
  cardId: z.string(),
  kind: z.enum(['approval', 'question']),
  openedAt: z.number(),
  approval: z.looseObject({}).optional(),
  question: z.looseObject({}).optional(),
});

export type Card = z.infer<typeof cardSchema>;

export const goalSnapshotSchema = z.looseObject({
  goalId: z.string(),
  objective: z.string(),
  status: z.string(),
});

export type GoalSnapshotPayload = z.infer<typeof goalSnapshotSchema>;

export const todoItemSchema = z.looseObject({
  title: z.string(),
  status: z.string(),
});

export type TodoItemPayload = z.infer<typeof todoItemSchema>;

export const subagentFoldSchema = z.looseObject({
  category: z.literal('subagent'),
  type: z.string(),
  at: z.number(),
});

export type SubagentFold = z.infer<typeof subagentFoldSchema>;

export const backgroundTaskFoldSchema = z.looseObject({
  category: z.literal('background-task'),
  type: z.string(),
  at: z.number(),
});

export type BackgroundTaskFold = z.infer<typeof backgroundTaskFoldSchema>;

export const modelChoiceSchema = z.looseObject({
  alias: z.string(),
  displayName: z.string(),
  efforts: z.array(z.string()),
});

export type ModelChoice = z.infer<typeof modelChoiceSchema>;

export const overviewSchema = z.looseObject({
  rev: z.number().int(),
  phase: z.string(),
  isCompacting: z.boolean(),
  model: z.string(),
  thinkingEffort: z.string(),
  permissionMode: z.string(),
  planMode: z.boolean(),
  contextUsage: z.number(),
  goal: goalSnapshotSchema.nullable(),
  todos: z.array(todoItemSchema),
  subagents: z.array(subagentFoldSchema),
  backgroundTasks: z.array(backgroundTaskFoldSchema),
  models: z.array(modelChoiceSchema),
  lastLine: z.string(),
  sampledAt: z.number(),
});

export type Overview = z.infer<typeof overviewSchema>;

export const receiptReportSchema = z.strictObject({
  opId: z.string(),
  state: z.enum(['delivered', 'applied', 'rejected']),
  reason: receiptReasonSchema.optional(),
});

export type ReceiptReport = z.infer<typeof receiptReportSchema>;

export const workerSnapshotSchema = z.strictObject({
  workerId: z.string(),
  threads: z
    .array(
      z.strictObject({
        descriptor: descriptorSchema,
        overview: overviewSchema,
        timeline: z.array(timelineEntrySchema),
        openCards: z.array(cardSchema),
      }),
    )
    .min(1),
  recentReceipts: z.array(receiptReportSchema),
});

export type WorkerSnapshot = z.infer<typeof workerSnapshotSchema>;

export const registerResponseSchema = z.strictObject({
  workerId: z.string(),
  threads: z.array(
    z.strictObject({
      sessionId: z.string(),
      accepted: z.boolean(),
    }),
  ),
});

export type RegisterResponse = z.infer<typeof registerResponseSchema>;

export const opPushSchema = z.strictObject({
  opId: z.string(),
  sessionId: z.string(),
  intent: z.unknown(),
});

export type OpPush = z.infer<typeof opPushSchema>;

export const uplinkFrameSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    sessionId: z.string(),
    kind: z.literal('timeline'),
    entries: z.array(timelineEntrySchema).min(1),
  }),
  z.strictObject({
    sessionId: z.string(),
    kind: z.literal('overview'),
    overview: overviewSchema,
  }),
  z.strictObject({
    sessionId: z.string(),
    kind: z.literal('descriptor'),
    descriptor: descriptorSchema,
  }),
]);

export type UplinkFrame = z.infer<typeof uplinkFrameSchema>;

export const uplinkBatchSchema = z.strictObject({
  workerId: z.string(),
  frames: z.array(uplinkFrameSchema).min(1),
});

export type UplinkBatch = z.infer<typeof uplinkBatchSchema>;

export const workerReceiptReportSchema = z.strictObject({
  workerId: z.string(),
  receipts: z.array(receiptReportSchema),
});

export type WorkerReceiptReport = z.infer<typeof workerReceiptReportSchema>;

export const workerUnregisterSchema = z.strictObject({
  workerId: z.string(),
  finalReceipts: z.array(receiptReportSchema),
});

export type WorkerUnregister = z.infer<typeof workerUnregisterSchema>;

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

export function parseTimelineEntry(input: unknown): ParseResult<TimelineEntry> {
  return parseValue(timelineEntrySchema, input);
}

export function parseCard(input: unknown): ParseResult<Card> {
  return parseValue(cardSchema, input);
}

export function parseOverview(input: unknown): ParseResult<Overview> {
  return parseValue(overviewSchema, input);
}

export function parseWorkerRegister(input: unknown): ParseResult<WorkerSnapshot> {
  return parseValue(workerSnapshotSchema, input);
}

export function parseRegisterResponse(input: unknown): ParseResult<RegisterResponse> {
  return parseValue(registerResponseSchema, input);
}

export function parseUplinkBatch(input: unknown): ParseResult<UplinkBatch> {
  return parseValue(uplinkBatchSchema, input);
}

export function parseWorkerReceiptReport(input: unknown): ParseResult<WorkerReceiptReport> {
  return parseValue(workerReceiptReportSchema, input);
}

export function parseWorkerUnregister(input: unknown): ParseResult<WorkerUnregister> {
  return parseValue(workerUnregisterSchema, input);
}

export { parseDescriptor };
