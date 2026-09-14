import type { Descriptor } from '#/contract/frames';

export interface ThreadSummary {
  id: string;
  descriptor: Descriptor;
}

export interface ResolveOptions {
  retryIntervalMs?: number;
  maxRetries?: number;
}

export interface ResolveDeps {
  fetchThreads: () => Promise<{ threads: ThreadSummary[] } | undefined>;
}

const DEFAULT_RETRY_INTERVAL_MS = 1000;
const DEFAULT_MAX_RETRIES = 8;

export async function resolveThreadBySessionId(
  sessionId: string,
  deps: ResolveDeps,
  options?: ResolveOptions,
): Promise<ThreadSummary | undefined> {
  const retryIntervalMs = options?.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => { setTimeout(resolve, retryIntervalMs); });
    let body: { threads: ThreadSummary[] } | undefined;
    try {
      body = await deps.fetchThreads();
    } catch {
      body = undefined;
    }
    const match = body?.threads.find((thread) => thread.descriptor.sessionId === sessionId);
    if (match !== undefined) return match;
  }
  return undefined;
}
