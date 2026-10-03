import { z } from 'zod';

import type { ParseResult } from './shared';
import { tokenRoleSchema } from './shared';

export const adminIssueRequestSchema = z.strictObject({
  role: tokenRoleSchema,
  name: z.string().min(1),
});

export type AdminIssueRequest = z.infer<typeof adminIssueRequestSchema>;

export const adminTokenSchema = z.strictObject({
  tokenId: z.string(),
  name: z.string(),
  role: tokenRoleSchema,
  createdAt: z.number(),
});

export type AdminToken = z.infer<typeof adminTokenSchema>;

export const adminIssueResponseSchema = z.strictObject({
  tokenId: z.string(),
  secret: z.string(),
});

export type AdminIssueResponse = z.infer<typeof adminIssueResponseSchema>;

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

export function parseAdminIssueRequest(input: unknown): ParseResult<AdminIssueRequest> {
  return parseValue(adminIssueRequestSchema, input);
}

export function parseAdminToken(input: unknown): ParseResult<AdminToken> {
  return parseValue(adminTokenSchema, input);
}

export function parseAdminIssueResponse(input: unknown): ParseResult<AdminIssueResponse> {
  return parseValue(adminIssueResponseSchema, input);
}
