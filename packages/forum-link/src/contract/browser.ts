import { z } from 'zod';

import {
  type ParseResult,
  type Receipt,
  descriptorSchema,
  opIntentSchema,
  receiptSchema,
} from './shared';
import { overviewSchema, timelineEntrySchema, cardSchema } from './worker';

export const BROWSER_STREAM_EVENTS = [
  'thread.upsert',
  'thread.removed',
  'thread.reset',
  'timeline.append',
  'overview',
  'card.opened',
  'card.settled',
  'receipt',
] as const;

export type BrowserStreamEvent = (typeof BROWSER_STREAM_EVENTS)[number];

export const browserLoginRequestSchema = z.strictObject({
  token: z.string().min(1),
});

export type BrowserLoginRequest = z.infer<typeof browserLoginRequestSchema>;

export const BROWSER_COOKIE_NAME = '__Host-fl';

export const threadSummarySchema = z.strictObject({
  descriptor: descriptorSchema,
  overview: overviewSchema,
  online: z.boolean(),
  openCards: z.array(
    z.strictObject({
      cardId: z.string(),
      kind: z.enum(['approval', 'question']),
      openedAt: z.number(),
    }),
  ),
  lastActivityAt: z.number(),
});

export type ThreadSummary = z.infer<typeof threadSummarySchema>;

export const inboxResponseSchema = z.strictObject({
  threads: z.array(threadSummarySchema),
});

export type InboxResponse = z.infer<typeof inboxResponseSchema>;

export const threadSnapshotSchema = z.strictObject({
  descriptor: descriptorSchema,
  overview: overviewSchema,
  online: z.boolean(),
  timeline: z.array(timelineEntrySchema),
  openCards: z.array(cardSchema),
  receipts: z.array(receiptSchema),
});

export type ThreadSnapshot = z.infer<typeof threadSnapshotSchema>;

export const browserOpsRequestSchema = z.strictObject({
  sessionId: z.string(),
  intent: opIntentSchema,
});

export type BrowserOpsRequest = z.infer<typeof browserOpsRequestSchema>;

export type BrowserOpsResponse = Receipt;

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

export function parseBrowserLoginRequest(input: unknown): ParseResult<BrowserLoginRequest> {
  return parseValue(browserLoginRequestSchema, input);
}

export function parseThreadSummary(input: unknown): ParseResult<ThreadSummary> {
  return parseValue(threadSummarySchema, input);
}

export function parseInboxResponse(input: unknown): ParseResult<InboxResponse> {
  return parseValue(inboxResponseSchema, input);
}

export function parseThreadSnapshot(input: unknown): ParseResult<ThreadSnapshot> {
  return parseValue(threadSnapshotSchema, input);
}

export function parseBrowserOpsRequest(input: unknown): ParseResult<BrowserOpsRequest> {
  return parseValue(browserOpsRequestSchema, input);
}
