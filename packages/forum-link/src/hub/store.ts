import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import {
  type Receipt,
  receiptSchema,
  tokenRecordSchema,
  type TokenRecord,
} from '#/contract/shared';
import type { Overview } from '#/contract/worker';
import { z } from 'zod';

const persistedThreadSchema = z.object({
  sessionId: z.string(),
  ownerTokenId: z.string(),
  hostWorkerId: z.string(),
  descriptor: z.unknown(),
  overview: z.unknown(),
  overviewRev: z.number(),
  openCards: z.array(z.unknown()),
});

const receiptWithWorkerSchema = receiptSchema.extend({ workerId: z.string().optional() });

const persistedStateSchema = z.object({
  tokens: z.array(tokenRecordSchema),
  threads: z.array(persistedThreadSchema),
  receipts: z.array(receiptWithWorkerSchema),
});

export interface PersistedThread {
  sessionId: string;
  ownerTokenId: string;
  hostWorkerId: string;
  descriptor: unknown;
  overview: Overview;
  overviewRev: number;
  openCards: unknown[];
}

export interface PersistedState {
  tokens: TokenRecord[];
  threads: PersistedThread[];
  receipts: (Receipt & { workerId?: string })[];
}

export interface StoreOptions {
  dataDir: string;
  writeIntervalMs?: number;
  renameRetries?: number;
  renameRetryDelayMs?: number;
  rename?: (from: string, to: string) => void;
  read?: (path: string) => string;
  persistView?: () => PersistedState;
  onWriteError?: (error: unknown) => void;
}

export type LoadResult = { ok: true; state: PersistedState } | { ok: false; error: string };

export function emptyState(): PersistedState {
  return { tokens: [], threads: [], receipts: [] };
}

const DEFAULT_WRITE_INTERVAL_MS = 500;
const DEFAULT_RENAME_RETRIES = 5;
const DEFAULT_RENAME_RETRY_DELAY_MS = 50;

export class Store {
  private readonly dataDir: string;
  private readonly writeIntervalMs: number;
  private readonly renameRetries: number;
  private readonly renameRetryDelayMs: number;
  private readonly renameImpl: (from: string, to: string) => void;
  private readonly readImpl: (path: string) => string;
  private view: () => PersistedState;
  private readonly onWriteError: (error: unknown) => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(options: StoreOptions) {
    this.dataDir = options.dataDir;
    this.writeIntervalMs = options.writeIntervalMs ?? DEFAULT_WRITE_INTERVAL_MS;
    this.renameRetries = options.renameRetries ?? DEFAULT_RENAME_RETRIES;
    this.renameRetryDelayMs = options.renameRetryDelayMs ?? DEFAULT_RENAME_RETRY_DELAY_MS;
    this.renameImpl = options.rename ?? renameSync;
    this.readImpl = options.read ?? ((path) => readFileSync(path, 'utf8'));
    this.view = options.persistView ?? (() => emptyState());
    this.onWriteError = options.onWriteError ?? (() => {});
  }

  bindPersistView(view: () => PersistedState): void {
    this.view = view;
  }

  get statePath(): string {
    return join(this.dataDir, 'state.json');
  }

  load(): LoadResult {
    let text: string;
    try {
      text = this.readImpl(this.statePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { ok: true, state: emptyState() };
      return { ok: false, error: `state.json is not readable: ${String(error)}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { ok: false, error: `state.json is not valid JSON: ${String(error)}` };
    }
    const result = persistedStateSchema.safeParse(parsed);
    if (!result.success) {
      return { ok: false, error: `state.json does not match the persisted schema: ${result.error.message}` };
    }
    return { ok: true, state: result.data as PersistedState };
  }

  requestWrite(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.enqueue(() => this.writeNow(this.view())).then(
        () => {},
        (error) => {
          this.onWriteError(error);
        },
      );
    }, this.writeIntervalMs);
    this.timer.unref?.();
  }

  commitTokens(proposed: readonly TokenRecord[]): Promise<{ ok: boolean }> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    return this.enqueue(async () => {
      const view = this.view();
      await this.writeNow({ tokens: [...proposed], threads: view.threads, receipts: view.receipts });
      return { ok: true };
    }).then(
      (result) => result,
      () => ({ ok: false }),
    );
  }

  writeSecurity(): Promise<void> {
    return this.enqueue(() => this.writeNow(this.view())) as Promise<void>;
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
      await this.writeSecurity();
    }
    await this.writing;
  }

  private enqueue<T>(step: () => Promise<T>): Promise<T> {
    const run = this.writing.then(step, step);
    this.writing = run;
    return run;
  }

  private writeNow(state: PersistedState): Promise<void> {
    const tempPath = `${this.statePath}.tmp`;
    mkdirSync(this.dataDir, { recursive: true });
    const fd = openSync(tempPath, 'w');
    try {
      writeFileSync(fd, serializeState(state), 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return renameWithRetry(tempPath, this.statePath, this.renameRetries, this.renameRetryDelayMs, this.renameImpl);
  }
}

function serializeState(state: PersistedState): string {
  return JSON.stringify({
    tokens: state.tokens,
    threads: state.threads,
    receipts: state.receipts,
  });
}

async function renameWithRetry(
  from: string,
  to: string,
  retries: number,
  delayMs: number,
  renameImpl: (from: string, to: string) => void,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameImpl(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= retries || (code !== 'EPERM' && code !== 'EBUSY')) throw error;
      await delay(delayMs);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export type AdminKeyResult = { ok: true; key: string } | { ok: false; error: string };

export function readOrGenerateAdminKey(dataDir: string): AdminKeyResult {
  const path = join(dataDir, 'admin.key');
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing.length > 0) return { ok: true, key: existing };
  } catch {
    mkdirSync(dataDir, { recursive: true });
  }
  const key = randomBytes(32).toString('base64url');
  writeFileSync(path, key, { mode: 0o600, flag: 'wx' });
  return { ok: true, key };
}

export function adminKeyMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}

export function relaxAdminKeyPermissions(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    void 0;
  }
}
