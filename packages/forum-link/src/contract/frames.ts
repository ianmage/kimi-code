import { z } from 'zod';

export type ParseResult<T> = { ok: true; frame: T } | { ok: false; issue: string };

export const sessionStatusSchema = z.enum(['waiting-question', 'running', 'idle']);

export const descriptorSchema = z.strictObject({
  sessionId: z.string(),
  machineName: z.string(),
  projectName: z.string(),
  title: z.string(),
  status: sessionStatusSchema,
});

export type Descriptor = z.infer<typeof descriptorSchema>;

export const messageEntrySchema = z.strictObject({
  kind: z.literal('message'),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  truncated: z.boolean().optional(),
});

export const questionCardEntrySchema = z.strictObject({
  kind: z.literal('question-card'),
  cardId: z.string(),
  question: z.string(),
  options: z.array(z.string()).readonly(),
});

export const approvalCardEntrySchema = z.strictObject({
  kind: z.literal('approval-card'),
  cardId: z.string(),
  toolName: z.string(),
  action: z.string(),
  summary: z.string(),
});

export const statusMarkerEntrySchema = z.strictObject({
  kind: z.literal('status-marker'),
  status: sessionStatusSchema,
});

export const cardSettledEntrySchema = z.strictObject({
  kind: z.literal('card-settled'),
  cardId: z.string(),
  outcome: z.enum(['answered', 'approved', 'rejected', 'cancelled']),
});

export const entrySchema = z.discriminatedUnion('kind', [
  messageEntrySchema,
  questionCardEntrySchema,
  approvalCardEntrySchema,
  statusMarkerEntrySchema,
  cardSettledEntrySchema,
]);

export type Entry = z.infer<typeof entrySchema>;

export const registerFrameSchema = z.strictObject({
  type: z.literal('register'),
  descriptor: descriptorSchema,
});

export const entryFrameSchema = z.strictObject({
  type: z.literal('entry'),
  entry: entrySchema,
});

export const descriptorFrameSchema = z.strictObject({
  type: z.literal('descriptor'),
  descriptor: descriptorSchema,
});

export const uplinkFrameSchema = z.discriminatedUnion('type', [
  registerFrameSchema,
  entryFrameSchema,
  descriptorFrameSchema,
]);

export type UplinkFrame = z.infer<typeof uplinkFrameSchema>;

export const answerQuestionFrameSchema = z.strictObject({
  type: z.literal('answer-question'),
  target: z.string(),
  cardId: z.string(),
  answer: z.string(),
});

export const approveFrameSchema = z.strictObject({
  type: z.literal('approve'),
  target: z.string(),
  cardId: z.string(),
  feedback: z.string().optional(),
});

export const denyFrameSchema = z.strictObject({
  type: z.literal('deny'),
  target: z.string(),
  cardId: z.string(),
  feedback: z.string().optional(),
});

export const sendMessageFrameSchema = z.strictObject({
  type: z.literal('send-message'),
  target: z.string(),
  text: z.string(),
});

export const pauseFrameSchema = z.strictObject({
  type: z.literal('pause'),
  target: z.string(),
});

export const endSessionFrameSchema = z.strictObject({
  type: z.literal('end-session'),
  target: z.string(),
});

export const actionFrameSchema = z.discriminatedUnion('type', [
  answerQuestionFrameSchema,
  approveFrameSchema,
  denyFrameSchema,
  sendMessageFrameSchema,
  pauseFrameSchema,
  endSessionFrameSchema,
]);

export type ActionFrame = z.infer<typeof actionFrameSchema>;

export const cardStateSchema = z.strictObject({
  cardId: z.string(),
  kind: z.enum(['question', 'approval']),
  state: z.enum(['open', 'answered', 'approved', 'rejected', 'cancelled']),
});

export type CardState = z.infer<typeof cardStateSchema>;

export const snapshotEntrySchema = z.strictObject({
  seq: z.number(),
  entry: entrySchema,
});

export const snapshotRequestFrameSchema = z.strictObject({
  type: z.literal('snapshot-request'),
  target: z.string(),
});

export const snapshotFrameSchema = z.strictObject({
  type: z.literal('snapshot'),
  target: z.string(),
  descriptor: descriptorSchema,
  entries: z.array(snapshotEntrySchema).readonly(),
  maxSeq: z.number(),
  openCards: z.array(cardStateSchema).readonly(),
});

export const heartbeatFrameSchema = z.strictObject({
  type: z.literal('heartbeat'),
});

export const errorFrameSchema = z.strictObject({
  type: z.literal('error'),
  message: z.string(),
});

export const controlFrameSchema = z.discriminatedUnion('type', [
  snapshotRequestFrameSchema,
  snapshotFrameSchema,
  heartbeatFrameSchema,
  errorFrameSchema,
]);

export type ControlFrame = z.infer<typeof controlFrameSchema>;

function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

function parseFrame<T>(schema: z.ZodType<T>, input: unknown): ParseResult<T> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, frame: result.data };
  return { ok: false, issue: summarizeIssues(result.error) };
}

export function parseUplinkFrame(input: unknown): ParseResult<UplinkFrame> {
  return parseFrame(uplinkFrameSchema, input);
}

export function parseActionFrame(input: unknown): ParseResult<ActionFrame> {
  return parseFrame(actionFrameSchema, input);
}

export function parseControlFrame(input: unknown): ParseResult<ControlFrame> {
  return parseFrame(controlFrameSchema, input);
}
