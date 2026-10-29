import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { ApprovalRequest } from '@moonshot-ai/kimi-code-sdk';
import { log } from '@moonshot-ai/kimi-code-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovalController } from '#/tui/reverse-rpc/approval/controller';
import { createApprovalRequestHandler } from '#/tui/reverse-rpc/approval/handler';
import {
  consultRemoteApproval,
  resetPreApprovalCallbackCacheForTest,
  resolvePreApprovalCallbackPath,
} from '#/tui/reverse-rpc/approval/remote-approval';
import { REMOTE_APPROVED_LABEL } from '#/constant/app';
import type { ApprovalPanelData } from '#/tui/reverse-rpc/types';

function approvalEvent(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    toolCallId: 'tc-1',
    toolName: 'Bash',
    action: 'run command',
    display: {
      kind: 'generic',
      summary: 'run command',
      detail: {
        command: 'rm -rf /tmp/cache',
        cwd: '/tmp',
      },
    },
    ...overrides,
  };
}

describe('approval reverse-rpc', () => {
  it('auto-approves queued requests with the same action when the current is approved for session', async () => {
    const controller = new ApprovalController();
    const panel = (id: string, action: string) => ({
      id,
      tool_call_id: id,
      tool_name: 'Bash',
      action,
      description: '',
      display: [],
      choices: [],
    });

    const first = controller.show(panel('tc-1', 'run command: ls'));
    const second = controller.show(panel('tc-2', 'run command: ls'));
    const third = controller.show(panel('tc-3', 'edit src/x.ts'));
    const fourth = controller.show(panel('tc-4', 'run command: ls'));

    controller.respond({ decision: 'approved', scope: 'session', feedback: 'ok' });

    await expect(first).resolves.toEqual({
      decision: 'approved',
      scope: 'session',
      feedback: 'ok',
    });
    // Queued same-action requests inherit a session-scoped approval without
    // surfacing another panel. The user's feedback is not carried over —
    // it described the first request only.
    await expect(second).resolves.toEqual({ decision: 'approved', scope: 'session' });
    await expect(fourth).resolves.toEqual({ decision: 'approved', scope: 'session' });
    // A different-action request still waits for an explicit decision.
    expect(controller.hasPending()).toBe(true);

    controller.respond({ decision: 'rejected' });
    await expect(third).resolves.toEqual({ decision: 'rejected' });
  });

  it('does not auto-approve queued requests when only approved-once is chosen', async () => {
    const controller = new ApprovalController();
    const panel = (id: string) => ({
      id,
      tool_call_id: id,
      tool_name: 'Bash',
      action: 'run command: ls',
      description: '',
      display: [],
      choices: [],
    });

    const first = controller.show(panel('tc-1'));
    const second = controller.show(panel('tc-2'));

    controller.respond({ decision: 'approved' });

    await expect(first).resolves.toEqual({ decision: 'approved' });
    // The second same-action request must NOT be auto-resolved — approve-once
    // is a one-shot decision, not a session rule.
    expect(controller.hasPending()).toBe(true);
    controller.respond({ decision: 'approved' });
    await expect(second).resolves.toEqual({ decision: 'approved' });
  });

  it('ApprovalController cancels pending requests with a cancelled response', async () => {
    const controller = new ApprovalController();
    const pending = controller.show({
      id: 'req-1',
      tool_call_id: 'tc-1',
      tool_name: 'Bash',
      action: 'run',
      description: '',
      display: [],
      choices: [],
    });

    controller.cancelAll('closed');

    await expect(pending).resolves.toEqual({
      decision: 'cancelled',
      feedback: 'closed',
    });
  });

  it('adapts approval payloads through the handler and falls back on failure', async () => {
    const controller = new ApprovalController();
    const show = vi.spyOn(controller, 'show').mockResolvedValue({
      decision: 'approved',
      scope: 'session',
      feedback: 'looks good',
    });
    const handler = createApprovalRequestHandler(controller);

    await expect(handler(approvalEvent())).resolves.toEqual({
      decision: 'approved',
      scope: 'session',
      feedback: 'looks good',
    });
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tc-1',
        tool_call_id: 'tc-1',
        tool_name: 'Bash',
        display: [
          expect.objectContaining({
            type: 'shell',
            command: 'rm -rf /tmp/cache',
            cwd: '/tmp',
            danger: 'recursive delete',
          }),
        ],
      }),
    );

    show.mockRejectedValueOnce(new Error('boom'));
    await expect(handler(approvalEvent())).resolves.toEqual({
      decision: 'cancelled',
      feedback: 'approval handler failed',
    });
  });

  it('tracks the requesting agent until approval settles or fails', async () => {
    const controller = new ApprovalController();
    const show = vi.spyOn(controller, 'show').mockResolvedValue({ decision: 'approved' });
    const token = Symbol('permission');
    const tracker = {
      startInteraction: vi.fn(() => token),
      endInteraction: vi.fn(),
    };
    const handler = createApprovalRequestHandler(controller, undefined, tracker);

    await expect(handler(approvalEvent({ agentId: 'agent-1' }))).resolves.toEqual({
      decision: 'approved',
    });
    expect(tracker.startInteraction).toHaveBeenCalledWith({
      agentId: 'agent-1',
      kind: 'permission',
    });
    expect(tracker.endInteraction).toHaveBeenCalledWith(token);

    show.mockRejectedValueOnce(new Error('boom'));
    await expect(handler(approvalEvent({ agentId: 'agent-1' }))).resolves.toEqual({
      decision: 'cancelled',
      feedback: 'approval handler failed',
    });
    expect(tracker.endInteraction).toHaveBeenCalledTimes(2);
  });
});

describe('remote pre-approval consultation', () => {
  let tempDir: string;
  let env: Record<string, string | undefined>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'kimi-pre-approval-'));
    env = {
      KIMI_CODE_PRE_APPROVAL_CALLBACK: undefined,
      KIMI_CODE_PRE_APPROVAL_TIMEOUT_MS: undefined,
    };
    resetPreApprovalCallbackCacheForTest();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  function panelData(action = 'run command'): ApprovalPanelData {
    return {
      id: 'tc-1',
      tool_call_id: 'tc-1',
      tool_name: 'Bash',
      action,
      description: '',
      display: [{ type: 'brief', text: 'brief' }],
      choices: [],
    };
  }

  async function writeCallback(body: string): Promise<string> {
    const path = join(tempDir, `cb-${randomUUID()}.mjs`);
    await writeFile(path, body);
    return path;
  }

  it('returns undefined path when env var is unset or empty', () => {
    expect(resolvePreApprovalCallbackPath(env)).toBeUndefined();
    env['KIMI_CODE_PRE_APPROVAL_CALLBACK'] = '   ';
    expect(resolvePreApprovalCallbackPath(env)).toBeUndefined();
    env['KIMI_CODE_PRE_APPROVAL_CALLBACK'] = join(tempDir, 'cb.mjs');
    expect(resolvePreApprovalCallbackPath(env)).toBe(join(tempDir, 'cb.mjs'));
  });

  it('expands a leading ~ to the user home directory', () => {
    env['KIMI_CODE_PRE_APPROVAL_CALLBACK'] = '~';
    expect(resolvePreApprovalCallbackPath(env)).toBe(homedir());
    env['KIMI_CODE_PRE_APPROVAL_CALLBACK'] = '~/.kimi-code/jev-pre-approval.mjs';
    expect(resolvePreApprovalCallbackPath(env)).toBe(
      join(homedir(), '.kimi-code', 'jev-pre-approval.mjs'),
    );
    env['KIMI_CODE_PRE_APPROVAL_CALLBACK'] = String.raw`~\.kimi-code\jev-pre-approval.mjs`;
    expect(resolvePreApprovalCallbackPath(env)).toBe(
      join(homedir(), '.kimi-code', 'jev-pre-approval.mjs'),
    );
    env['KIMI_CODE_PRE_APPROVAL_CALLBACK'] = '~not-a-tilde-prefix/other.mjs';
    expect(resolvePreApprovalCallbackPath(env)).toBe('~not-a-tilde-prefix/other.mjs');
  });

  it('returns false without importing when the env var is unset', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await expect(consultRemoteApproval(panelData(), env)).resolves.toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('approves only on a strict {approve: true} result', async () => {
    const truePath = await writeCallback(
      'export async function preApproval(payload) { return { approve: payload.toolName === "Bash" }; }\n',
    );
    env['KIMI_CODE_PRE_APPROVAL_CALLBACK'] = truePath;
    await expect(consultRemoteApproval(panelData(), env)).resolves.toBe(true);
    await expect(consultRemoteApproval(panelData(), env)).resolves.toBe(true);

    const falsePath = await writeCallback(
      'export async function preApproval() { return { approve: false }; }\n',
    );
    env['KIMI_CODE_PRE_APPROVAL_CALLBACK'] = falsePath;
    await expect(consultRemoteApproval(panelData(), env)).resolves.toBe(false);
  });

  it('maps ApprovalPanelData fields to the camelCase payload', async () => {
    const seen: unknown[] = [];
    const path = await writeCallback(
      'export async function preApproval(payload) { globalThis.__seen = globalThis.__seen ?? []; globalThis.__seen.push(payload); return { approve: true }; }\n',
    );
    env['KIMI_CODE_PRE_APPROVAL_CALLBACK'] = path;
    await expect(consultRemoteApproval(panelData(), env)).resolves.toBe(true);
    const seenList = (globalThis as { __seen?: unknown[] }).__seen ?? [];
    expect(seenList.at(-1)).toEqual({
      toolCallId: 'tc-1',
      toolName: 'Bash',
      action: 'run command',
      display: [{ type: 'brief', text: 'brief' }],
    });
    delete (globalThis as { __seen?: unknown[] }).__seen;
  });

  it('caches the callback module per path (one import for repeated consultations)', async () => {
    const path = await writeCallback(
      'globalThis.__loads = (globalThis.__loads ?? 0) + 1;\n' +
        'export async function preApproval() { return { approve: true }; }\n',
    );
    env['KIMI_CODE_PRE_APPROVAL_CALLBACK'] = path;
    await expect(consultRemoteApproval(panelData(), env)).resolves.toBe(true);
    await expect(consultRemoteApproval(panelData(), env)).resolves.toBe(true);
    expect((globalThis as { __loads?: number }).__loads).toBe(1);
    delete (globalThis as { __loads?: number }).__loads;
  });

  it('warns once on load failure and treats the callback as unconfigured afterwards', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    env['KIMI_CODE_PRE_APPROVAL_CALLBACK'] = join(tempDir, 'does-not-exist.mjs');
    await expect(consultRemoteApproval(panelData(), env)).resolves.toBe(false);
    await expect(consultRemoteApproval(panelData(), env)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe('failed to load pre-approval callback module');
  });

  it('warns once when the module does not export a preApproval function', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const path = await writeCallback('export const other = 1;\n');
    env['KIMI_CODE_PRE_APPROVAL_CALLBACK'] = path;
    await expect(consultRemoteApproval(panelData(), env)).resolves.toBe(false);
    await expect(consultRemoteApproval(panelData(), env)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe(
      'pre-approval callback module does not export a preApproval function',
    );
  });

  it('returns false and warns once when the callback throws on every call', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const path = await writeCallback(
      'export async function preApproval() { throw new Error("callback boom"); }\n',
    );
    env['KIMI_CODE_PRE_APPROVAL_CALLBACK'] = path;
    await expect(consultRemoteApproval(panelData(), env)).resolves.toBe(false);
    await expect(consultRemoteApproval(panelData(), env)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe('pre-approval callback threw');
  });

  it('times out under an injected short timeout without leaving a refed timer', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const path = await writeCallback(
      'export function preApproval() { return new Promise(() => {}); }\n',
    );
    env['KIMI_CODE_PRE_APPROVAL_CALLBACK'] = path;
    env['KIMI_CODE_PRE_APPROVAL_TIMEOUT_MS'] = '50';
    const startedAt = Date.now();
    await expect(consultRemoteApproval(panelData(), env)).resolves.toBe(false);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(1000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe('pre-approval callback timed out');
  });

  it('falls back to the default timeout when the timeout env var is invalid', async () => {
    const path = await writeCallback(
      'export async function preApproval() { return { approve: true }; }\n',
    );
    env['KIMI_CODE_PRE_APPROVAL_CALLBACK'] = path;
    env['KIMI_CODE_PRE_APPROVAL_TIMEOUT_MS'] = 'not-a-number';
    await expect(consultRemoteApproval(panelData(), env)).resolves.toBe(true);
  });
});

describe('approval handler remote consultation branch', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'kimi-pre-approval-'));
    resetPreApprovalCallbackCacheForTest();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env['KIMI_CODE_PRE_APPROVAL_CALLBACK'];
    delete process.env['KIMI_CODE_PRE_APPROVAL_TIMEOUT_MS'];
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeCallback(body: string): Promise<string> {
    const path = join(tempDir, `cb-${randomUUID()}.mjs`);
    await writeFile(path, body);
    return path;
  }

  it('resolves with the remote label without showing the panel when the callback approves', async () => {
    const controller = new ApprovalController();
    const show = vi.spyOn(controller, 'show');
    const onResponse = vi.fn();
    process.env['KIMI_CODE_PRE_APPROVAL_CALLBACK'] = await writeCallback(
      'export async function preApproval() { return { approve: true }; }\n',
    );
    const handler = createApprovalRequestHandler(controller, onResponse);

    await expect(handler(approvalEvent())).resolves.toEqual({
      decision: 'approved',
      selectedLabel: REMOTE_APPROVED_LABEL,
    });
    expect(show).not.toHaveBeenCalled();
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse.mock.calls[0]?.[1]).toEqual({
      decision: 'approved',
      selectedLabel: REMOTE_APPROVED_LABEL,
    });
  });

  it('shows the local panel with the same adapted data when the callback does not approve', async () => {
    const controller = new ApprovalController();
    const show = vi
      .spyOn(controller, 'show')
      .mockResolvedValue({ decision: 'approved', feedback: 'local user' });
    const onResponse = vi.fn();
    process.env['KIMI_CODE_PRE_APPROVAL_CALLBACK'] = await writeCallback(
      'export async function preApproval() { return { approve: false }; }\n',
    );
    const handler = createApprovalRequestHandler(controller, onResponse);

    await expect(handler(approvalEvent())).resolves.toEqual({
      decision: 'approved',
      feedback: 'local user',
    });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0]?.[0]).toMatchObject({ id: 'tc-1', tool_call_id: 'tc-1' });
    expect(onResponse).toHaveBeenCalledTimes(1);
  });

  it('behaves exactly like the local-only path when no callback is configured', async () => {
    const controller = new ApprovalController();
    const show = vi
      .spyOn(controller, 'show')
      .mockResolvedValue({ decision: 'approved', scope: 'session' });
    const handler = createApprovalRequestHandler(controller);

    await expect(handler(approvalEvent())).resolves.toEqual({
      decision: 'approved',
      scope: 'session',
    });
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('consults concurrent approvals independently', async () => {
    const controller = new ApprovalController();
    const show = vi.spyOn(controller, 'show');
    process.env['KIMI_CODE_PRE_APPROVAL_CALLBACK'] = await writeCallback(
      'export async function preApproval() { await new Promise((resolve) => setTimeout(resolve, 20)); return { approve: true }; }\n',
    );
    const handler = createApprovalRequestHandler(controller);

    const first = handler(approvalEvent({ toolCallId: 'tc-1' }));
    const second = handler(approvalEvent({ toolCallId: 'tc-2' }));
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse).toEqual({ decision: 'approved', selectedLabel: REMOTE_APPROVED_LABEL });
    expect(secondResponse).toEqual({ decision: 'approved', selectedLabel: REMOTE_APPROVED_LABEL });
    expect(show).not.toHaveBeenCalled();
  });

  it('does not consult the callback for plan_review and goal_start requests', async () => {
    const controller = new ApprovalController();
    const show = vi.spyOn(controller, 'show').mockResolvedValue({ decision: 'approved' });
    process.env['KIMI_CODE_PRE_APPROVAL_CALLBACK'] = await writeCallback(
      'globalThis.__consults = (globalThis.__consults ?? 0) + 1;\n' +
        'export async function preApproval() { return { approve: true }; }\n',
    );
    const handler = createApprovalRequestHandler(controller);

    const planReview = approvalEvent({
      toolName: 'ExitPlanMode',
      display: {
        kind: 'plan_review',
        plan: 'do the thing',
        options: [
          { label: 'a', description: 'option a' },
          { label: 'b', description: 'option b' },
        ],
      },
    });
    const goalStart = approvalEvent({
      toolName: 'CreateGoal',
      display: { kind: 'goal_start', objective: 'do it', mode: 'manual' },
    });

    await expect(handler(planReview)).resolves.toEqual({ decision: 'approved' });
    await expect(handler(goalStart)).resolves.toEqual({ decision: 'approved' });
    expect(show).toHaveBeenCalledTimes(2);
    expect((globalThis as { __consults?: number }).__consults).toBeUndefined();
    delete (globalThis as { __consults?: number }).__consults;
  });
});
