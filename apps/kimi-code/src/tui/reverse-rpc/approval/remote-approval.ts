import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { log } from '@moonshot-ai/kimi-code-sdk';

import {
  KIMI_CODE_PRE_APPROVAL_CALLBACK_ENV,
  KIMI_CODE_PRE_APPROVAL_TIMEOUT_MS_ENV,
  REMOTE_PRE_APPROVAL_DEFAULT_TIMEOUT_MS,
} from '#/constant/app';
import type { ApprovalPanelData } from '#/tui/reverse-rpc/types';

export interface PreApprovalPayload {
  toolCallId: string;
  toolName: string;
  action: string;
  display: ApprovalPanelData['display'];
}

export type PreApprovalCallback = (payload: PreApprovalPayload) => Promise<{ approve: boolean }>;

const callbackCache = new Map<string, PreApprovalCallback | undefined>();
const throwWarnedPaths = new Set<string>();

export function resolvePreApprovalCallbackPath(env: NodeJS.ProcessEnv): string | undefined {
  const value = env[KIMI_CODE_PRE_APPROVAL_CALLBACK_ENV];
  if (value === undefined || value.trim().length === 0) return undefined;
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

export function isAbsoluteCallbackPath(path: string): boolean {
  return isAbsolute(path);
}

function resolveTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env[KIMI_CODE_PRE_APPROVAL_TIMEOUT_MS_ENV];
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return REMOTE_PRE_APPROVAL_DEFAULT_TIMEOUT_MS;
}

export async function loadPreApprovalCallback(
  path: string,
): Promise<PreApprovalCallback | undefined> {
  if (callbackCache.has(path)) return callbackCache.get(path);
  let callback: PreApprovalCallback | undefined;
  try {
    const mod = (await import(pathToFileURL(path).href)) as { preApproval?: unknown };
    if (typeof mod.preApproval === 'function') {
      callback = mod.preApproval as PreApprovalCallback;
    } else {
      log.warn('pre-approval callback module does not export a preApproval function', { path });
    }
  } catch (error) {
    log.warn('failed to load pre-approval callback module', { path, error: String(error) });
  }
  callbackCache.set(path, callback);
  return callback;
}

export async function consultRemoteApproval(
  data: ApprovalPanelData,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const path = resolvePreApprovalCallbackPath(env);
  if (path === undefined) return false;
  const callback = await loadPreApprovalCallback(path);
  if (callback === undefined) return false;

  const payload: PreApprovalPayload = {
    toolCallId: data.tool_call_id,
    toolName: data.tool_name,
    action: data.action,
    display: data.display,
  };

  const timeoutMs = resolveTimeoutMs(env);
  let timedOut = false;
  let onTimeout: (() => void) | undefined;
  const timeoutPromise = new Promise<undefined>((resolve) => {
    onTimeout = () => {
      timedOut = true;
      resolve(undefined);
    };
  });
  const timer = setTimeout(onTimeout!, timeoutMs);
  timer.unref?.();
  try {
    const result = (await Promise.race([callback(payload), timeoutPromise])) as
      | { approve: boolean }
      | undefined;
    if (result === undefined) {
      if (timedOut) log.warn('pre-approval callback timed out', { timeoutMs });
      return false;
    }
    return result.approve;
  } catch (error) {
    if (!throwWarnedPaths.has(path)) {
      throwWarnedPaths.add(path);
      log.warn('pre-approval callback threw', { path, error: String(error) });
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function resetPreApprovalCallbackCacheForTest(): void {
  callbackCache.clear();
  throwWarnedPaths.clear();
}
