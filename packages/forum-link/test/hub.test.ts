import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHubServer } from '#/hub/router';
import { adminKeyMode, emptyState, readOrGenerateAdminKey, relaxAdminKeyPermissions, Store, type PersistedState } from '#/hub/store';
import { Tokens } from '#/hub/tokens';
import { Gate, type AuthFace, type GateOptions } from '#/hub/gate';
import { HubState, type FanoutEvent, type State } from '#/hub/state';
import { DEFAULT_WORKER_GRACE_MS, WorkerRegistry } from '#/hub/ownership';
import { BROWSER_COOKIE_NAME } from '#/contract/browser';
import type {
  Card,
  Overview,
  ReceiptReport,
  TimelineEntry,
  UplinkBatch,
  UplinkFrame,
  WorkerSnapshot,
} from '#/contract/worker';
import { LIMITS } from '#/contract/shared';
import type { Descriptor, OpIntent, OpType, TokenRecord } from '#/contract/shared';

const HUB_MJS = fileURLToPath(new URL('../dist/hub.mjs', import.meta.url));
const TEST_WRITE_INTERVAL_MS = 10;
const TEST_RENAME_RETRY_DELAY_MS = 1;
const SUBPROCESS_TIMEOUT_MS = 15000;

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'forum-link-hub-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function createStore(overrides: Partial<ConstructorParameters<typeof Store>[0]> = {}): Store {
  return new Store({
    dataDir,
    writeIntervalMs: TEST_WRITE_INTERVAL_MS,
    renameRetryDelayMs: TEST_RENAME_RETRY_DELAY_MS,
    ...overrides,
  });
}

function createStoreWithAssembler(
  view: () => PersistedState,
  overrides: Partial<ConstructorParameters<typeof Store>[0]> = {},
): Store {
  return createStore({ persistView: view, ...overrides });
}

function createStoreWithTokens(overrides: Partial<ConstructorParameters<typeof Store>[0]> = {}): {
  store: Store;
  tokens: Tokens;
  getState(): PersistedState;
} {
  const store = createStore(overrides);
  const loaded = store.load();
  if (!loaded.ok) throw new Error(loaded.error);
  let state = loaded.state;
  store.bindPersistView(() => state);
  const tokens = new Tokens({
    store: {
      records: () => state.tokens,
      save: async (next: readonly TokenRecord[]) => {
        const result = await store.commitTokens([...next]);
        if (!result.ok) throw new Error('injected persist failure');
        state = { ...state, tokens: [...next] };
      },
    },
  });
  return { store, tokens, getState: () => state };
}

function readStateFile(): PersistedState {
  return JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as PersistedState;
}

function errnoError(code: string): Error & NodeJS.ErrnoException {
  const error = new Error(`injected ${code}`) as Error & NodeJS.ErrnoException;
  error.code = code;
  return error;
}

async function issueHttpTokens(
  pairs: { role: 'machine' | 'device'; name: string }[] = [
    { role: 'machine', name: 'laptop' },
    { role: 'device', name: 'phone' },
  ],
): Promise<{ machineSecret: string; deviceSecret: string }> {
  const store = createStore();
  const loaded = store.load();
  if (!loaded.ok) throw new Error(loaded.error);
  let state = loaded.state;
  store.bindPersistView(() => state);
  const tokens = new Tokens({
    store: {
      records: () => state.tokens,
      save: async (next: readonly TokenRecord[]) => {
        const result = await store.commitTokens([...next]);
        if (!result.ok) throw new Error('injected persist failure');
        state = { ...state, tokens: [...next] };
      },
    },
  });
  let machineSecret = '';
  let deviceSecret = '';
  for (const { role, name } of pairs) {
    const result = await tokens.issue(role, name);
    if (!result.ok) throw new Error('issue failed');
    if (role === 'machine') machineSecret = result.secret;
    else deviceSecret = result.secret;
  }
  return { machineSecret, deviceSecret };
}

function eperm(): never {
  const error = new Error('injected EPERM') as NodeJS.ErrnoException;
  error.code = 'EPERM';
  throw error;
}

async function spawnServeHub(): Promise<{ child: ChildProcess; output: string }> {
  const child = spawn(process.execPath, [HUB_MJS, 'serve', '--data-dir', dataDir, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    output += chunk;
  });
  const exited = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null, signal: 'timeout' });
    }, SUBPROCESS_TIMEOUT_MS);
    child.once('exit', () => {
      clearTimeout(timer);
    });
  });
  return { child, output: output + `\n[exit ${exited.code ?? 'signal ' + String(exited.signal)}]` };
}

async function startServeHub(extraArgs: string[] = []): Promise<{ child: ChildProcess; baseUrl: string }> {
  const child = spawn(process.execPath, [HUB_MJS, 'serve', '--data-dir', dataDir, '--port', '0', ...extraArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    output += chunk;
  });
  const deadline = Date.now() + 8000;
  for (;;) {
    const match = /listening on http:\/\/\S+:(\d+)/.exec(output);
    if (match !== null) return { child, baseUrl: `http://127.0.0.1:${match[1]}` };
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill();
      throw new Error(`hub failed to start: ${output}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

function recordOf(tokenId: string, role: 'machine' | 'device'): TokenRecord {
  return {
    tokenId,
    name: tokenId,
    role,
    hash: createHash('sha256').update(tokenId).digest('hex'),
    createdAt: 0,
  };
}

function p13Card(cardId: string): Card {
  return { cardId, kind: 'approval', openedAt: 1000, approval: {} };
}

function workerSnapshotOf(
  workerId: string,
  threads: { sessionId: string; timeline?: TimelineEntry[]; openCards?: Card[] }[],
): WorkerSnapshot {
  return {
    workerId,
    threads: threads.map((thread) => ({
      descriptor: {
        sessionId: thread.sessionId,
        machine: { tokenName: 'worker-reported-name', hostname: 'host-1' },
        project: 'proj',
        title: 't',
        kind: 'interactive',
        capabilities: ['approve', 'send', 'end-session'],
      },
      overview: {
        rev: 1,
        phase: 'idle',
        isCompacting: false,
        model: 'kimi',
        thinkingEffort: 'high',
        permissionMode: 'default',
        planMode: false,
        contextUsage: 0,
        goal: null,
        todos: [],
        subagents: [],
        backgroundTasks: [],
        models: [],
        lastLine: '',
        sampledAt: 1000,
      },
      timeline: thread.timeline ?? [],
      openCards: thread.openCards ?? [],
    })),
    recentReceipts: [],
  };
}

function createGate(secrets: Record<string, TokenRecord>, overrides: Partial<GateOptions> = {}): Gate {
  return new Gate({ lookup: (secret) => secrets[secret], ...overrides });
}

interface FakeRequestInit {
  authorization?: string;
  remoteAddress?: string;
  xff?: string[];
}

function makeReq(init: FakeRequestInit = {}): IncomingMessage {
  const headers: Record<string, string | string[]> = {};
  if (init.authorization !== undefined) headers['authorization'] = init.authorization;
  if (init.xff !== undefined && init.xff.length > 0) {
    headers['x-forwarded-for'] = init.xff.length === 1 ? init.xff[0]! : init.xff;
  }
  const req = new EventEmitter() as unknown as IncomingMessage;
  Object.assign(req, { headers, socket: { remoteAddress: init.remoteAddress } });
  return req;
}

function makeRes(): { res: ServerResponse; isDestroyed(): boolean } {
  const res = new EventEmitter() as unknown as ServerResponse;
  const state = { destroyed: false };
  Object.assign(res, {
    destroy() {
      state.destroyed = true;
      res.emit('close');
      return res;
    },
  });
  return { res, isDestroyed: () => state.destroyed };
}


describe('hub store', () => {
  it('P1-1.6: a debounced write assembles the document at write-step time, not signal time', async () => {
    let state = emptyState();
    const { renameSync } = await import('node:fs');
    let renameCount = 0;
    const store = createStoreWithAssembler(() => state, {
      rename: (from, to) => {
        renameCount += 1;
        renameSync(from, to);
      },
    });
    state = {
      ...state,
      receipts: [{ opId: 'op-1', sessionId: 's1', opType: 'send', state: 'accepted', at: 1 }],
    };
    store.requestWrite();
    state = {
      ...state,
      receipts: [
        { opId: 'op-1', sessionId: 's1', opType: 'send', state: 'accepted', at: 1 },
        { opId: 'op-2', sessionId: 's1', opType: 'send', state: 'accepted', at: 2 },
      ],
    };
    await new Promise((resolve) => {
      setTimeout(resolve, TEST_WRITE_INTERVAL_MS * 5);
    });
    expect(renameCount).toBe(1);
    const persisted = readStateFile();
    expect(persisted.receipts.map((receipt) => receipt.opId)).toEqual(['op-1', 'op-2']);
  });

  it('P1-1.5: a token write step subsumes the concurrent debounced write', async () => {
    let state = emptyState();
    const { renameSync } = await import('node:fs');
    let renameCount = 0;
    const store = createStoreWithAssembler(() => state, {
      rename: (from, to) => {
        renameCount += 1;
        renameSync(from, to);
      },
    });
    state = {
      ...state,
      receipts: [{ opId: 'op-1', sessionId: 's1', opType: 'send', state: 'accepted', at: 1 }],
    };
    store.requestWrite();
    const proposed: TokenRecord[] = [recordOf('tok-1', 'machine')];
    const result = await store.commitTokens(proposed);
    expect(result).toEqual({ ok: true });
    state = { ...state, tokens: proposed };
    await new Promise((resolve) => {
      setTimeout(resolve, TEST_WRITE_INTERVAL_MS * 5);
    });
    expect(renameCount).toBe(1);
    const persisted = readStateFile();
    expect(persisted.tokens.map((token) => token.tokenId)).toEqual(['tok-1']);
    expect(persisted.receipts.map((receipt) => receipt.opId)).toEqual(['op-1']);
  });

  it('P1-1.4: commitTokens with an exhausted rename returns ok:false, keeps the token out of memory and later documents', async () => {
    let state = emptyState();
    const { renameSync } = await import('node:fs');
    let fail = false;
    const store = createStoreWithAssembler(() => state, {
      renameRetries: 2,
      rename: (from, to) => {
        if (fail) eperm();
        renameSync(from, to);
      },
    });
    const good: TokenRecord[] = [recordOf('tok-1', 'machine')];
    const committed = await store.commitTokens(good);
    expect(committed).toEqual({ ok: true });
    state = { ...state, tokens: good };
    fail = true;
    const proposed: TokenRecord[] = [...good, recordOf('tok-2', 'device')];
    const rejected = await store.commitTokens(proposed);
    expect(rejected).toEqual({ ok: false });
    expect(state.tokens.map((token) => token.tokenId)).toEqual(['tok-1']);
    fail = false;
    state = {
      ...state,
      receipts: [{ opId: 'op-1', sessionId: 's1', opType: 'send', state: 'accepted', at: 1 }],
    };
    store.requestWrite();
    await store.flush();
    const persisted = readStateFile();
    expect(persisted.tokens.map((token) => token.tokenId)).toEqual(['tok-1']);
    expect(persisted.receipts.map((receipt) => receipt.opId)).toEqual(['op-1']);
  });

  it('P1-1.4b: after a transient rename failure recovers, requestWrite + flush persist the full memory state and load round-trips it', async () => {
    let state = emptyState();
    const { renameSync } = await import('node:fs');
    let fail = false;
    const store = createStoreWithAssembler(() => state, {
      renameRetries: 2,
      rename: (from, to) => {
        if (fail) eperm();
        renameSync(from, to);
      },
    });
    const good: TokenRecord[] = [recordOf('tok-1', 'machine')];
    const committed = await store.commitTokens(good);
    expect(committed).toEqual({ ok: true });
    state = { ...state, tokens: good };
    fail = true;
    const proposed: TokenRecord[] = [...good, recordOf('tok-2', 'device')];
    const rejected = await store.commitTokens(proposed);
    expect(rejected).toEqual({ ok: false });
    expect(state.tokens.map((token) => token.tokenId)).toEqual(['tok-1']);
    fail = false;
    state = {
      tokens: good,
      threads: [
        {
          sessionId: 's1',
          ownerTokenId: 'tok-1',
          hostWorkerId: 'w1',
          descriptor: { sessionId: 's1' },
          overview: { rev: 1, phase: 'idle', sampledAt: 1 } as unknown as Overview,
          overviewRev: 1,
          openCards: [],
        },
      ],
      receipts: [{ opId: 'op-1', sessionId: 's1', opType: 'send', state: 'accepted', at: 1 }],
    };
    store.requestWrite();
    await expect(store.flush()).resolves.toBeUndefined();
    const reloaded = createStore().load();
    expect(reloaded).toEqual({ ok: true, state });
  });

  it('P1-1.1: load returns fatal on non-ENOENT read errors and serve refuses to start without overwriting it', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    for (const code of ['EACCES', 'EPERM', 'EBUSY']) {
      const store = createStore({ read: () => { throw errnoError(code); } });
      const result = store.load();
      expect(result.ok, code).toBe(false);
      if (!result.ok) expect(result.error).toContain('state.json');
    }
    mkdirSync(join(dataDir, 'state.json'));
    const { output } = await spawnServeHub();
    expect(output).toContain('start-refused');
    expect(output).toMatch(/\[exit [1-9]/);
    expect(statSync(join(dataDir, 'state.json')).isDirectory()).toBe(true);
    expect(existsSync(join(dataDir, 'state.json.tmp'))).toBe(false);
  });

  it('P1-1.2: load returns an empty state when state.json does not exist and the hub starts normally', () => {
    const store = createStore();
    const result = store.load();
    expect(result).toEqual({ ok: true, state: emptyState() });
  });

  it('writeSecurity resolves only after the change is on disk', async () => {
    let state = emptyState();
    const store = createStoreWithAssembler(() => state);
    state = { tokens: [], threads: [], receipts: [] };
    await store.writeSecurity();
    expect(readStateFile()).toEqual(state);
    state = {
      tokens: [],
      threads: [
        {
          sessionId: 's1',
          ownerTokenId: 't1',
          hostWorkerId: 'w1',
          descriptor: { sessionId: 's1' },
          overview: { rev: 1, phase: 'idle', sampledAt: 1 } as unknown as Overview,
          overviewRev: 1,
          openCards: [],
        },
      ],
      receipts: [],
    };
    await store.writeSecurity();
    expect(readStateFile()).toEqual(state);
  });

  it('writeSecurity rejects when rename permanently fails', async () => {
    const store = createStoreWithAssembler(() => emptyState(), {
      renameRetries: 2,
      rename: () => {
        throw new Error('injected permanent rename failure');
      },
    });
    await expect(store.writeSecurity()).rejects.toThrow('injected permanent rename failure');
    expect(existsSync(join(dataDir, 'state.json'))).toBe(false);
  });

  it('recovers on the next write after a failed write', async () => {
    let state = emptyState();
    const { renameSync } = await import('node:fs');
    let fail = true;
    const store = createStoreWithAssembler(() => state, {
      rename: (from, to) => {
        if (fail) throw new Error('injected rename failure');
        renameSync(from, to);
      },
    });
    await expect(store.writeSecurity()).rejects.toThrow('injected rename failure');
    fail = false;
    await store.writeSecurity();
    expect(existsSync(join(dataDir, 'state.json'))).toBe(true);
  });

  it('load returns an empty state when state.json does not exist', () => {
    const store = createStore();
    const result = store.load();
    expect(result).toEqual({ ok: true, state: { tokens: [], threads: [], receipts: [] } });
  });

  it('load returns fatal on unparseable JSON and serve refuses to start without overwriting it', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const corrupted = '{"tokens": [broken';
    writeFileSync(join(dataDir, 'state.json'), corrupted, 'utf8');
    const store = createStore();
    const result = store.load();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('state.json');
    const { output } = await spawnServeHub();
    expect(output).toContain('start-refused');
    expect(readFileSync(join(dataDir, 'state.json'), 'utf8')).toBe(corrupted);
  });

  it('load returns fatal on schema mismatch', () => {
    writeFileSync(join(dataDir, 'state.json'), '{"tokens": "nope"}', 'utf8');
    const result = createStore().load();
    expect(result.ok).toBe(false);
  });

  it('coalesces multiple requestWrite signals within the interval into one write', async () => {
    let state = emptyState();
    let renameCount = 0;
    const { renameSync } = await import('node:fs');
    const store = createStoreWithAssembler(() => state, {
      rename: (from, to) => {
        renameCount += 1;
        renameSync(from, to);
      },
    });
    for (let i = 0; i < 5; i += 1) {
      state = {
        ...state,
        receipts: [{ opId: String(i), sessionId: 's', opType: 'send', state: 'accepted', at: i }],
      };
      store.requestWrite();
    }
    await new Promise((resolve) => {
      setTimeout(resolve, TEST_WRITE_INTERVAL_MS * 5);
    });
    expect(renameCount).toBe(1);
    const persisted = readStateFile();
    expect(persisted.receipts).toHaveLength(1);
    expect(persisted.receipts[0]).toMatchObject({ opId: '4' });
  });

  it('persists no timeline entries and no token secrets', async () => {
    const { store, tokens, getState } = createStoreWithTokens();
    const issue = await tokens.issue('machine', 'laptop');
    if (!issue.ok) throw new Error('issue failed');
    const state: PersistedState & { timeline?: unknown[] } = {
      ...getState(),
      threads: [
        {
          sessionId: 's1',
          ownerTokenId: issue.tokenId,
          hostWorkerId: 'w1',
          descriptor: { sessionId: 's1' },
          overview: { rev: 1, phase: 'idle', sampledAt: 1 } as unknown as Overview,
          overviewRev: 1,
          openCards: [],
        },
      ],
      timeline: [{ seq: 1, at: 1, kind: 'user-message', text: 'hello' }],
    };
    store.bindPersistView(() => state);
    await store.writeSecurity();
    const text = readFileSync(join(dataDir, 'state.json'), 'utf8');
    expect(text).not.toContain('timeline');
    expect(text).not.toContain('hello');
    expect(text).not.toContain(issue.secret);
    expect(readStateFile().tokens[0]!.hash).toHaveLength(64);
  });

  it('retries Windows EPERM rename failures and succeeds after the injected attempts', async () => {
    let calls = 0;
    const { renameSync } = await import('node:fs');
    const store = createStoreWithAssembler(() => emptyState(), {
      renameRetries: 2,
      renameRetryDelayMs: TEST_RENAME_RETRY_DELAY_MS,
      rename: (from, to) => {
        calls += 1;
        if (calls <= 2) eperm();
        renameSync(from, to);
      },
    });
    await store.writeSecurity();
    expect(calls).toBe(3);
    expect(existsSync(join(dataDir, 'state.json'))).toBe(true);
  });

  it('rejects after exhausting EPERM retries', async () => {
    const store = createStoreWithAssembler(() => emptyState(), {
      renameRetries: 2,
      renameRetryDelayMs: TEST_RENAME_RETRY_DELAY_MS,
      rename: () => eperm(),
    });
    await expect(store.writeSecurity()).rejects.toThrow('injected EPERM');
  });

  it('does not retry non-EPERM rename errors', async () => {
    let calls = 0;
    const store = createStoreWithAssembler(() => emptyState(), {
      renameRetries: 3,
      rename: () => {
        calls += 1;
        const error = new Error('no such file') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
    });
    await expect(store.writeSecurity()).rejects.toThrow('no such file');
    expect(calls).toBe(1);
  });

  describe('admin key', () => {
    it('generates on first serve, keeps content out of state.json, and survives reuse', async () => {
      const first = readOrGenerateAdminKey(dataDir);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.key.length).toBeGreaterThan(20);
      expect(existsSync(join(dataDir, 'admin.key'))).toBe(true);
      const second = readOrGenerateAdminKey(dataDir);
      expect(second).toEqual(first);
      const store = createStoreWithAssembler(() => emptyState());
      await store.writeSecurity();
      const stateText = readFileSync(join(dataDir, 'state.json'), 'utf8');
      expect(stateText).not.toContain(first.key);
    });

    it('admin.key has 0600 permissions on non-Windows platforms', () => {
      readOrGenerateAdminKey(dataDir);
      const path = join(dataDir, 'admin.key');
      if (process.platform === 'win32') {
        expect(existsSync(path)).toBe(true);
        return;
      }
      expect(adminKeyMode(path)).toBe(0o600);
    });

    it('relaxes permissions of a pre-existing world-writable admin.key on non-Windows', async () => {
      const path = join(dataDir, 'admin.key');
      writeFileSync(path, 'existing-key', { mode: 0o666 });
      const result = readOrGenerateAdminKey(dataDir);
      expect(result).toEqual({ ok: true, key: 'existing-key' });
      if (process.platform === 'win32') return;
      expect(adminKeyMode(path)).toBe(0o600);
      chmodSync(path, 0o666);
      relaxAdminKeyPermissions(path);
      expect(adminKeyMode(path)).toBe(0o600);
    });
  });
});

describe('hub tokens', () => {
  it('stores only the hash after issue, never the secret', async () => {
    const { tokens } = createStoreWithTokens();
    const issue = await tokens.issue('device', 'phone');
    if (!issue.ok) throw new Error('issue failed');
    expect(issue.secret.length).toBeGreaterThanOrEqual(32);
    const onDisk = readStateFile().tokens;
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]).toMatchObject({ tokenId: issue.tokenId, name: 'phone', role: 'device' });
    expect(typeof onDisk[0]!.hash).toBe('string');
    expect(onDisk[0]!.hash).not.toBe(issue.secret);
    const stateText = readFileSync(join(dataDir, 'state.json'), 'utf8');
    expect(stateText).not.toContain(issue.secret);
    expect(tokens.lookup(issue.secret)).toBeDefined();
  });

  it('list() returns records without the hash', async () => {
    const { tokens } = createStoreWithTokens();
    await tokens.issue('machine', 'laptop');
    await tokens.issue('device', 'phone');
    const records = tokens.list();
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record).not.toHaveProperty('hash');
      expect(Object.keys(record).toSorted()).toEqual(['createdAt', 'name', 'role', 'tokenId']);
    }
  });

  it('rejects duplicate names within the same role', async () => {
    const { tokens } = createStoreWithTokens();
    const first = await tokens.issue('machine', 'laptop');
    expect(first.ok).toBe(true);
    const duplicate = await tokens.issue('machine', 'laptop');
    expect(duplicate).toEqual({ ok: false, reason: 'duplicate-name' });
    const sameNameOtherRole = await tokens.issue('device', 'laptop');
    expect(sameNameOtherRole.ok).toBe(true);
    expect(readStateFile().tokens).toHaveLength(2);
  });

  it('lookup misses for unknown secrets', async () => {
    const { tokens } = createStoreWithTokens();
    await tokens.issue('device', 'phone');
    expect(tokens.lookup('not-a-real-secret')).toBeUndefined();
  });

  it('revoke makes lookup return undefined immediately after it resolves', async () => {
    const { tokens } = createStoreWithTokens();
    const issue = await tokens.issue('device', 'phone');
    if (!issue.ok) throw new Error('issue failed');
    expect(tokens.lookup(issue.secret)).toBeDefined();
    const result = await tokens.revoke(issue.tokenId);
    expect(result.ok).toBe(true);
    expect(tokens.lookup(issue.secret)).toBeUndefined();
    expect(readStateFile().tokens).toHaveLength(0);
    expect(tokens.list()).toHaveLength(0);
  });

  it('returns persist-failed on issue and keeps tokens valid on revoke failure', async () => {
    let state = emptyState();
    let fail = false;
    const { renameSync } = await import('node:fs');
    const failStore = createStoreWithAssembler(() => state, {
      rename: (from, to) => {
        if (fail) throw new Error('injected persist failure');
        renameSync(from, to);
      },
    });
    const tokens = new Tokens({
      store: {
        records: () => state.tokens,
        save: async (next: readonly TokenRecord[]) => {
          const result = await failStore.commitTokens([...next]);
          if (!result.ok) throw new Error('injected persist failure');
          state = { ...state, tokens: [...next] };
        },
      },
    });
    fail = true;
    const blocked = await tokens.issue('device', 'phone');
    expect(blocked).toEqual({ ok: false, reason: 'persist-failed', error: expect.any(Error) });
    expect(tokens.list()).toHaveLength(0);
    fail = false;
    const issue = await tokens.issue('device', 'phone');
    if (!issue.ok) throw new Error('issue failed');
    fail = true;
    const revoke = await tokens.revoke(issue.tokenId);
    expect(revoke.ok).toBe(false);
    expect(tokens.lookup(issue.secret)).toBeDefined();
  });

  it('PersistedState round-trips through writeSecurity and load with all three sections intact', async () => {
    const store = createStoreWithAssembler(() => original);
    const token: TokenRecord = {
      tokenId: 'tok-1',
      name: 'laptop',
      role: 'machine',
      hash: 'a'.repeat(64),
      createdAt: 1717000000000,
    };
    const openCard = {
      cardId: 'approval_1',
      kind: 'approval',
      openedAt: 1717000001000,
      approval: { id: 'approval_1', choices: [{ label: 'Approve once', response: 'approved' }] },
    };
    const original: PersistedState = {
      tokens: [token],
      threads: [
        {
          sessionId: 'session-1',
          ownerTokenId: 'tok-1',
          hostWorkerId: 'worker-1',
          descriptor: {
            sessionId: 'session-1',
            machine: { tokenName: 'laptop', hostname: 'host-1' },
            project: 'kimi-code',
            title: 'Fix login bug',
            kind: 'interactive',
            capabilities: ['approve', 'send'],
          },
          overview: {
            rev: 3,
            phase: 'idle',
            isCompacting: false,
            model: 'kimi',
            thinkingEffort: 'high',
            permissionMode: 'auto',
            planMode: false,
            contextUsage: 0.25,
            goal: null,
            todos: [{ title: 'one', status: 'pending' }],
            subagents: [],
            backgroundTasks: [],
            models: [],
            lastLine: '',
            sampledAt: 1717000002000,
          },
          overviewRev: 3,
          openCards: [openCard],
        },
      ],
      receipts: [
        {
          opId: 'op-1',
          sessionId: 'session-1',
          opType: 'approve',
          cardId: 'approval_1',
          state: 'rejected',
          reason: 'card-closed',
          at: 1717000003000,
          workerId: 'worker-1',
        },
        { opId: 'op-2', sessionId: 'session-1', opType: 'send', state: 'applied', at: 1717000004000 },
      ],
    };
    await store.writeSecurity();
    const loaded = createStore().load();
    expect(loaded).toEqual({ ok: true, state: original });
    expect(loaded.ok && loaded.state.threads[0]!.openCards).toEqual([openCard]);
    expect(loaded.ok && loaded.state.receipts[0]!.workerId).toBe('worker-1');
    expect(loaded.ok && loaded.state.receipts[1]).not.toHaveProperty('workerId');
    const persisted = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as PersistedState;
    expect(persisted).toEqual(original);
  });

  it('tokens survive a store reload round-trip', async () => {
    const first = createStoreWithTokens();
    const issue = await first.tokens.issue('machine', 'laptop');
    if (!issue.ok) throw new Error('issue failed');
    const second = createStoreWithTokens();
    expect(second.tokens.lookup(issue.secret)).toBeDefined();
    expect(second.tokens.list()).toEqual(first.tokens.list());
  });
});

describe('serve wiring', () => {
  it('spawns a hub that creates admin.key and exits zero on SIGTERM', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const child = spawn(process.execPath, [HUB_MJS, 'serve', '--data-dir', dataDir, '--port', '0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      output += chunk;
    });
    const deadline = Date.now() + 8000;
    for (;;) {
      if (/listening on http:\/\/\S+/.test(output)) break;
      if (child.exitCode !== null || Date.now() > deadline) {
        child.kill();
        throw new Error(`hub failed to start: ${output}`);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    expect(existsSync(join(dataDir, 'admin.key'))).toBe(true);
    expect(existsSync(join(dataDir, 'state.json'))).toBe(false);
    const exited = await new Promise<boolean>((resolve) => {
      child.once('exit', () => {
        resolve(true);
      });
      child.kill('SIGTERM');
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve(false);
      }, 5000).unref?.();
    });
    expect(exited).toBe(true);
  });

  it('rejects corrupted state.json with a non-zero exit and does not overwrite the file', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const corrupted = 'not json at all';
    writeFileSync(join(dataDir, 'state.json'), corrupted, 'utf8');
    const { output } = await spawnServeHub();
    expect(output).toContain('start-refused');
    expect(readFileSync(join(dataDir, 'state.json'), 'utf8')).toBe(corrupted);
  });

  it('rejects schema-invalid state.json with a non-zero exit', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    writeFileSync(join(dataDir, 'state.json'), '{"tokens": 42}', 'utf8');
    const { output } = await spawnServeHub();
    expect(output).toContain('start-refused');
  });

  it('P1-1.2: a missing state.json starts as an empty state and the hub boots normally', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const result = createStore().load();
    expect(result).toEqual({ ok: true, state: emptyState() });
    const { child, baseUrl } = await startServeHub();
    try {
      const inbox = await fetch(`${baseUrl}/api/browser/inbox`);
      expect(inbox.status).toBe(401);
    } finally {
      child.kill();
      await new Promise<void>((resolve) => {
        child.once('exit', () => {
          resolve();
        });
      });
    }
  });

  it('P1-1.3: issuing a token and closing within the debounce window keeps the token and does not roll back threads or receipts', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const { machineSecret, deviceSecret } = await issueHttpTokens();
    const adminKey = readOrGenerateAdminKey(dataDir);
    if (!adminKey.ok) throw new Error('admin key missing');
    const first = await startServeHub();
    let before: PersistedState | undefined;
    try {
      const register = await fetch(`${first.baseUrl}/api/worker/register`, {
        method: 'POST',
        headers: { authorization: `Bearer ${machineSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify(workerSnapshotOf('w-p13', [{ sessionId: 's1', openCards: [p13Card('approval_1')] }])),
      });
      expect(register.status).toBe(200);
      const deadline = Date.now() + 8000;
      for (;;) {
        if (existsSync(join(dataDir, 'state.json'))) {
          const persisted = readStateFile();
          if (persisted.threads.length === 1 && persisted.threads[0]!.openCards.length === 1) {
            before = persisted;
            break;
          }
        }
        if (Date.now() > deadline) throw new Error('thread not persisted before issue');
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
      }
      const issue = await fetch(`${first.baseUrl}/api/admin/tokens`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminKey.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'device', name: 'issued-before-close' }),
      });
      expect(issue.status).toBe(200);
      const issued = (await issue.json()) as { tokenId: string; secret: string };
      await new Promise<void>((resolve) => {
        first.child.once('exit', () => {
          resolve();
        });
        first.child.kill('SIGTERM');
        setTimeout(() => {
          first.child.kill('SIGKILL');
          resolve();
        }, 5000).unref?.();
      });
      const afterIssue = readStateFile();
      expect(afterIssue.tokens.map((token) => token.tokenId)).toContain(issued.tokenId);
      expect(afterIssue.threads).toEqual(before.threads);
      expect(afterIssue.receipts).toEqual(before.receipts);
    } finally {
      if (first.child.exitCode === null && first.child.signalCode === null) first.child.kill();
    }

    const second = await startServeHub();
    try {
      const inbox = await fetch(`${second.baseUrl}/api/browser/inbox`, {
        headers: { cookie: `${BROWSER_COOKIE_NAME}=${deviceSecret}` },
      });
      expect(inbox.status).toBe(200);
      const body = (await inbox.json()) as { threads: { descriptor: { sessionId: string }; openCards: { cardId: string }[] }[] };
      expect(body.threads).toHaveLength(1);
      expect(body.threads[0]!.descriptor.sessionId).toBe('s1');
      expect(body.threads[0]!.openCards.map((card) => card.cardId)).toEqual(['approval_1']);
      const revived = readStateFile();
      expect(revived.tokens.map((token) => token.name).toSorted()).toEqual(
        ['issued-before-close', 'laptop', 'phone'].toSorted(),
      );
      expect(revived.threads).toEqual(before!.threads);
      expect(revived.receipts).toEqual(before!.receipts);
    } finally {
      second.child.kill();
      await new Promise<void>((resolve) => {
        second.child.once('exit', () => {
          resolve();
        });
      });
    }
  });
});

describe('hub gate', () => {
  const MACHINE_SECRET = 'machine-secret';
  const DEVICE_SECRET = 'device-secret';
  const ADMIN_KEY = 'admin-key-value';

  function matrixGate(): Gate {
    return createGate(
      {
        [MACHINE_SECRET]: recordOf('tok-machine', 'machine'),
        [DEVICE_SECRET]: recordOf('tok-device', 'device'),
      },
      { adminKey: ADMIN_KEY, maxFailures: 100 },
    );
  }

  it('enforces the role access matrix with only diagonal cells allowed', () => {
    const gate = matrixGate();
    interface MatrixCase {
      face: AuthFace;
      secret?: string;
      remoteAddress?: string;
      expected: 'ok' | 401 | 403;
    }
    const cases: MatrixCase[] = [
      { face: 'worker', secret: MACHINE_SECRET, expected: 'ok' },
      { face: 'worker', secret: DEVICE_SECRET, expected: 403 },
      { face: 'worker', expected: 401 },
      { face: 'worker', secret: 'not-a-token', expected: 401 },
      { face: 'browser', secret: DEVICE_SECRET, expected: 'ok' },
      { face: 'browser', secret: MACHINE_SECRET, expected: 403 },
      { face: 'browser', expected: 401 },
      { face: 'browser', secret: 'not-a-token', expected: 401 },
      { face: 'admin', secret: ADMIN_KEY, remoteAddress: '127.0.0.1', expected: 'ok' },
      { face: 'admin', secret: MACHINE_SECRET, remoteAddress: '127.0.0.1', expected: 401 },
      { face: 'admin', secret: DEVICE_SECRET, remoteAddress: '127.0.0.1', expected: 401 },
      { face: 'admin', remoteAddress: '127.0.0.1', expected: 401 },
      { face: 'admin', secret: ADMIN_KEY, remoteAddress: '203.0.113.9', expected: 403 },
      { face: 'admin', secret: MACHINE_SECRET, remoteAddress: '203.0.113.9', expected: 403 },
      { face: 'admin', remoteAddress: '203.0.113.9', expected: 403 },
    ];
    for (const { face, secret, remoteAddress, expected } of cases) {
      const req = makeReq({
        authorization: secret === undefined ? undefined : `Bearer ${secret}`,
        remoteAddress,
      });
      const result = gate.authorize(req, face);
      if (expected === 'ok') {
        expect(result, `${face} with ${secret ?? 'no secret'} from ${remoteAddress ?? 'unknown'}`).toEqual({
          ok: true,
          tokenId: expect.any(String),
          role: expect.any(String),
        });
      } else {
        expect(result, `${face} with ${secret ?? 'no secret'} from ${remoteAddress ?? 'unknown'}`).toEqual({
          ok: false,
          status: expected,
        });
      }
    }
  });

  it('rejects non-loopback admin sources even with the admin key', () => {
    const gate = matrixGate();
    const req = makeReq({ authorization: `Bearer ${ADMIN_KEY}`, remoteAddress: '198.51.100.7' });
    expect(gate.authorize(req, 'admin')).toEqual({ ok: false, status: 403 });
    const ipv6 = makeReq({ authorization: `Bearer ${ADMIN_KEY}`, remoteAddress: '2001:db8::1' });
    expect(gate.authorize(ipv6, 'admin')).toEqual({ ok: false, status: 403 });
  });

  it('resolves client IPs from X-Forwarded-For behind trusted proxies', () => {
    interface XffCase {
      trustedProxies?: string[];
      remoteAddress?: string;
      xff?: string[];
      expected: string;
    }
    const cases: XffCase[] = [
      { remoteAddress: '127.0.0.1', xff: ['203.0.113.5'], expected: '203.0.113.5' },
      { remoteAddress: '127.0.0.1', xff: ['203.0.113.5, 10.0.0.2'], trustedProxies: ['10.0.0.2'], expected: '203.0.113.5' },
      { remoteAddress: '127.0.0.1', xff: ['203.0.113.5', '10.0.0.2, 127.0.0.1'], trustedProxies: ['10.0.0.2'], expected: '203.0.113.5' },
      { remoteAddress: '127.0.0.1', xff: ['203.0.113.5 , 10.0.0.2'], trustedProxies: ['10.0.0.2'], expected: '203.0.113.5' },
      { remoteAddress: '127.0.0.1', xff: ['10.0.0.2, 10.0.0.3'], trustedProxies: ['10.0.0.2', '10.0.0.3'], expected: '127.0.0.1' },
      { remoteAddress: '198.51.100.7', xff: ['1.2.3.4'], expected: '198.51.100.7' },
      { remoteAddress: '198.51.100.7', expected: '198.51.100.7' },
      { remoteAddress: '127.0.0.1', expected: '127.0.0.1' },
      { remoteAddress: '::1', xff: ['203.0.113.5'], expected: '203.0.113.5' },
      { remoteAddress: '10.0.0.2', xff: ['203.0.113.5'], trustedProxies: ['10.0.0.2'], expected: '203.0.113.5' },
      { remoteAddress: '10.0.0.2', xff: ['203.0.113.5'], expected: '10.0.0.2' },
    ];
    for (const { trustedProxies, remoteAddress, xff, expected } of cases) {
      const gate = createGate({}, { trustedProxies });
      const req = makeReq({ remoteAddress, xff });
      expect(gate.clientIp(req), `from ${remoteAddress ?? 'undefined'} xff ${JSON.stringify(xff)}`).toBe(expected);
    }
  });

  it('rate limits auth failures per source IP with injectable window and cap', () => {
    let clock = 1000;
    const gate = createGate(
      { [MACHINE_SECRET]: recordOf('tok-machine', 'machine') },
      { maxFailures: 3, windowMs: 500, now: () => clock },
    );
    const from = (ip: string) => makeReq({ remoteAddress: ip });
    expect(gate.authenticate(from('203.0.113.1'))).toEqual({ ok: false, status: 401 });
    expect(gate.authenticate(from('203.0.113.1'))).toEqual({ ok: false, status: 401 });
    expect(gate.authenticate(from('203.0.113.2'))).toEqual({ ok: false, status: 401 });
    expect(gate.authenticate(makeReq({ authorization: `Bearer ${MACHINE_SECRET}`, remoteAddress: '203.0.113.1' }))).toEqual({
      ok: true,
      tokenId: 'tok-machine',
      role: 'machine',
    });
    expect(gate.authenticate(from('203.0.113.2'))).toEqual({ ok: false, status: 401 });
    expect(gate.authenticate(from('203.0.113.2'))).toEqual({ ok: false, status: 401 });
    expect(gate.authenticate(from('203.0.113.2'))).toEqual({ ok: false, status: 429 });
    expect(gate.authenticate(from('203.0.113.3'))).toEqual({ ok: false, status: 401 });
    clock += 501;
    expect(gate.authenticate(from('203.0.113.2'))).toEqual({ ok: false, status: 401 });
  });

  it('noteAuthFailure counts toward the per-IP limit', () => {
    let clock = 1000;
    const gate = createGate(
      { [MACHINE_SECRET]: recordOf('tok-machine', 'machine') },
      { maxFailures: 2, windowMs: 500, now: () => clock },
    );
    gate.noteAuthFailure('203.0.113.4');
    gate.noteAuthFailure('203.0.113.4');
    expect(gate.authenticate(makeReq({ remoteAddress: '203.0.113.4' }))).toEqual({ ok: false, status: 429 });
    expect(
      gate.authenticate(makeReq({ authorization: `Bearer ${MACHINE_SECRET}`, remoteAddress: '203.0.113.4' })),
    ).toEqual({ ok: false, status: 429 });
  });

  it('registers connections per tokenId and closeAll closes them synchronously', () => {
    const gate = createGate({});
    const a = makeRes();
    const b = makeRes();
    const c = makeRes();
    gate.registerConnection('tok-1', a.res);
    gate.registerConnection('tok-1', b.res);
    gate.registerConnection('tok-2', c.res);
    gate.closeAll('tok-1');
    expect(a.isDestroyed()).toBe(true);
    expect(b.isDestroyed()).toBe(true);
    expect(c.isDestroyed()).toBe(false);
    gate.closeAll('tok-1');
    expect(c.isDestroyed()).toBe(false);
    c.res.emit('close');
    gate.closeAll('tok-2');
    expect(c.isDestroyed()).toBe(false);
  });
});

describe('hub gate over spawned hub', () => {
  async function stopHub(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await new Promise<void>((resolve) => {
      child.once('exit', () => {
        resolve();
      });
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5000).unref?.();
    });
  }

  it('enforces the role matrix over real HTTP', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const { machineSecret, deviceSecret } = await issueHttpTokens();
    const adminKey = readOrGenerateAdminKey(dataDir);
    if (!adminKey.ok) throw new Error('admin key missing');
    const { child, baseUrl } = await startServeHub();
    try {
      const page = await fetch(`${baseUrl}/`);
      expect(page.status).toBe(200);
      const post = (path: string, token: string | undefined) =>
        fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
          body: '{}',
        });
      expect((await post('/api/worker/register', machineSecret)).status).toBe(400);
      expect((await post('/api/worker/register', deviceSecret)).status).toBe(403);
      expect((await post('/api/worker/register', undefined)).status).toBe(401);
      expect((await fetch(`${baseUrl}/api/browser/inbox`, { headers: { authorization: `Bearer ${deviceSecret}` } })).status).toBe(200);
      expect((await fetch(`${baseUrl}/api/browser/inbox`, { headers: { authorization: `Bearer ${machineSecret}` } })).status).toBe(403);
      expect((await fetch(`${baseUrl}/api/browser/inbox`)).status).toBe(401);
      expect((await fetch(`${baseUrl}/api/admin/tokens`, { headers: { authorization: `Bearer ${adminKey.key}` } })).status).toBe(200);
      expect((await fetch(`${baseUrl}/api/admin/tokens`, { headers: { authorization: `Bearer ${machineSecret}` } })).status).toBe(401);
      expect((await fetch(`${baseUrl}/api/admin/tokens`, { headers: { authorization: `Bearer ${deviceSecret}` } })).status).toBe(401);
    } finally {
      await stopHub(child);
    }
  });

  it('rejects admin key from a spoofed non-loopback source behind a trusted proxy', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const adminKey = readOrGenerateAdminKey(dataDir);
    if (!adminKey.ok) throw new Error('admin key missing');
    const { child, baseUrl } = await startServeHub();
    try {
      const res = await fetch(`${baseUrl}/api/admin/tokens`, {
        headers: { authorization: `Bearer ${adminKey.key}`, 'x-forwarded-for': '203.0.113.9' },
      });
      expect(res.status).toBe(403);
    } finally {
      await stopHub(child);
    }
  });

  it('rate limits repeated auth failures from one source', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const { child, baseUrl } = await startServeHub();
    try {
      const attempt = () =>
        fetch(`${baseUrl}/api/worker/register`, {
          method: 'POST',
          headers: { authorization: 'Bearer invalid-secret' },
          body: '{}',
        });
      for (let i = 0; i < 5; i += 1) {
        expect((await attempt()).status).toBe(401);
      }
      expect((await attempt()).status).toBe(429);
    } finally {
      await stopHub(child);
    }
  });
});

describe('hub state', () => {
  let clock: number;

  function overviewOf(rev: number): Overview {
    return {
      rev,
      phase: 'idle',
      isCompacting: false,
      model: 'kimi',
      thinkingEffort: 'high',
      permissionMode: 'default',
      planMode: false,
      contextUsage: 0,
      goal: null,
      todos: [],
      subagents: [],
      backgroundTasks: [],
      models: [],
      lastLine: '',
      sampledAt: clock,
    };
  }

  function descriptorOf(sessionId: string, capabilities: OpType[] = ['approve', 'approve-cancel', 'send', 'new-session', 'end-session']): Descriptor {
    return {
      sessionId,
      machine: { tokenName: 'worker-reported-name', hostname: 'host-1' },
      project: 'proj',
      title: 't',
      kind: 'interactive',
      capabilities,
    };
  }

  function cardOf(cardId: string): Card {
    return { cardId, kind: 'approval', openedAt: clock, approval: {} };
  }

  function entryOf(seq: number): TimelineEntry {
    return { seq, at: clock, kind: 'user-message', text: `m${seq}` };
  }

  function snapshotOf(
    workerId: string,
    threads: { sessionId: string; timeline?: TimelineEntry[]; openCards?: Card[] }[],
    recentReceipts: ReceiptReport[] = [],
  ): WorkerSnapshot {
    return {
      workerId,
      threads: threads.map((thread) => ({
        descriptor: descriptorOf(thread.sessionId),
        overview: overviewOf(1),
        timeline: thread.timeline ?? [],
        openCards: thread.openCards ?? [],
      })),
      recentReceipts,
    };
  }

  interface StateHarness {
    state: HubState;
    delivers: { workerId: string; push: { opId: string; sessionId: string; intent: OpIntent } }[];
    logs: string[];
    persists: number;
    events: FanoutEvent[];
  }

  function createState(receiptsPerThread?: number): StateHarness {
    let opCounter = 0;
    const harness: StateHarness = {
      state: new HubState({
        now: () => clock,
        newOpId: () => `op-${(opCounter += 1)}`,
        tokenName: (tokenId) => (tokenId === 'tok-A' ? 'machine-a' : tokenId === 'tok-B' ? 'machine-b' : undefined),
        receiptsPerThread,
        deliver: (workerId, push) => {
          harness.delivers.push({ workerId, push });
        },
        onLog: (message) => {
          harness.logs.push(message);
        },
        onPersist: () => {
          harness.persists += 1;
        },
      }),
      delivers: [],
      logs: [],
      persists: 0,
      events: [],
    };
    harness.state.onFanout((event) => {
      harness.events.push(event);
    });
    return harness;
  }

  function batchOf(workerId: string, frames: UplinkFrame[]): UplinkBatch {
    return { workerId, frames };
  }

  beforeEach(() => {
    clock = 1000;
  });

  it('O1-A1: submitting the same snapshot twice yields a deeply equal state', () => {
    const { state } = createState();
    const snapshot = snapshotOf('w1', [{ sessionId: 's1', timeline: [entryOf(1)], openCards: [cardOf('approval_1')] }]);
    state.register('tok-A', 'w1', snapshot);
    const first = JSON.stringify(state.inbox());
    const firstReceipts = JSON.stringify(state.receiptsFor('s1'));
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1', timeline: [entryOf(1)], openCards: [cardOf('approval_1')] }]));
    expect(JSON.stringify(state.inbox())).toBe(first);
    expect(JSON.stringify(state.receiptsFor('s1'))).toBe(firstReceipts);
    expect(state.threadsForWorker('w1')).toEqual(['s1']);
  });

  it('O1-A2: re-registration without the original thread removes only the registering worker thread', () => {
    const { state } = createState();
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1' }]));
    state.register('tok-A', 'w2', snapshotOf('w2', [{ sessionId: 's2' }]));
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1x' }]));
    expect(state.threadsForWorker('w1')).toEqual(['s1x']);
    expect(state.threadsForWorker('w2')).toEqual(['s2']);
    expect(state.threadSnapshot('s1')).toBeUndefined();
    expect(state.threadSnapshot('s2')).toBeDefined();
  });

  it('O1-A3: a non-owner token registering an existing sessionId is rejected and logged', () => {
    const { state, logs } = createState();
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1' }]));
    const before = JSON.stringify(state.inbox());
    const response = state.register('tok-B', 'w2', snapshotOf('w2', [{ sessionId: 's1' }]));
    expect(response.threads).toEqual([{ sessionId: 's1', accepted: false }]);
    expect(JSON.stringify(state.inbox())).toBe(before);
    expect(logs.some((line) => line.includes('s1') && line.includes('owner'))).toBe(true);
  });

  it('O1-A4: a batch with a sequence gap returns resync-required and leaves the mirror unchanged', () => {
    const { state } = createState();
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1', timeline: [entryOf(1), entryOf(2)] }]));
    const before = JSON.stringify(state.threadSnapshot('s1')!.timeline);
    const result = state.applyBatch('w1', batchOf('w1', [{ sessionId: 's1', kind: 'timeline', entries: [entryOf(4)] }]));
    expect(result).toEqual({ ok: false, reason: 'resync-required' });
    expect(JSON.stringify(state.threadSnapshot('s1')!.timeline)).toBe(before);
    const ok = state.applyBatch('w1', batchOf('w1', [{ sessionId: 's1', kind: 'timeline', entries: [entryOf(3)] }]));
    expect(ok).toEqual({ ok: true });
    expect(state.threadSnapshot('s1')!.timeline).toHaveLength(3);
  });

  it('O1-A4: a batch for an unknown thread returns resync-required', () => {
    const { state } = createState();
    const result = state.applyBatch('w1', batchOf('w1', [{ sessionId: 'nope', kind: 'timeline', entries: [entryOf(1)] }]));
    expect(result).toEqual({ ok: false, reason: 'resync-required' });
  });

  it('O1-A4: overview frames only apply at a higher revision and descriptor frames update the descriptor', () => {
    const { state } = createState();
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1' }]));
    const stale = state.applyBatch('w1', batchOf('w1', [{ sessionId: 's1', kind: 'overview', overview: overviewOf(0) }]));
    expect(stale).toEqual({ ok: true });
    expect(state.threadSnapshot('s1')!.overview.rev).toBe(1);
    const newer = state.applyBatch('w1', batchOf('w1', [{ sessionId: 's1', kind: 'overview', overview: overviewOf(5) }]));
    expect(newer).toEqual({ ok: true });
    expect(state.threadSnapshot('s1')!.overview.rev).toBe(5);
    const descriptor = { ...descriptorOf('s1'), title: 'renamed', machine: { tokenName: 'worker-reported-name', hostname: 'h2' } };
    state.applyBatch('w1', batchOf('w1', [{ sessionId: 's1', kind: 'descriptor', descriptor }]));
    expect(state.threadSnapshot('s1')!.descriptor.title).toBe('renamed');
    expect(state.threadSnapshot('s1')!.descriptor.machine.hostname).toBe('h2');
    expect(state.threadSnapshot('s1')!.descriptor.machine.tokenName).toBe('machine-a');
  });

  it('O1-A5: terminal receipts ignore any later report', () => {
    const { state } = createState();
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1' }]));
    const receipt = state.acceptOp('tok-device', 's1', { type: 'send', sessionId: 's1', text: 'hi' });
    state.reportReceipt('w1', { opId: receipt.opId, state: 'delivered' });
    state.reportReceipt('w1', { opId: receipt.opId, state: 'applied' });
    const afterApplied = JSON.stringify(state.receiptsFor('s1'));
    state.reportReceipt('w1', { opId: receipt.opId, state: 'rejected', reason: 'card-closed' });
    state.reportReceipt('w1', { opId: receipt.opId, state: 'delivered' });
    expect(JSON.stringify(state.receiptsFor('s1'))).toBe(afterApplied);
    expect(state.receiptsFor('s1')[0]!.state).toBe('applied');
  });

  it('O1-A6: card ids stay stable while open and settled ids never re-enter the open set', () => {
    const { state, events } = createState();
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1', openCards: [cardOf('approval_1')] }]));
    expect(state.threadSnapshot('s1')!.openCards.map((card) => card.cardId)).toEqual(['approval_1']);
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1', openCards: [cardOf('approval_1')] }]));
    expect(state.threadSnapshot('s1')!.openCards.map((card) => card.cardId)).toEqual(['approval_1']);
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1', openCards: [] }]));
    expect(state.threadSnapshot('s1')!.openCards).toEqual([]);
    expect(
      events.filter((event) => event.type === 'card.settled'),
    ).toEqual([{ type: 'card.settled', sessionId: 's1', cardId: 'approval_1', outcome: 'closed' }]);
    expect(
      state.threadSnapshot('s1')!.timeline.some((entry) => entry.kind === 'card-settled' && entry.cardId === 'approval_1'),
    ).toBe(true);
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1', openCards: [cardOf('approval_1')] }]));
    expect(state.threadSnapshot('s1')!.openCards.map((card) => card.cardId)).toEqual(['approval_1']);
  });

  it('O1-A7: a delivered new-session receipt survives thread removal, applies later, or is lost when absent', () => {
    const { state } = createState();
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1' }]));
    const receipt = state.acceptOp('tok-device', 's1', { type: 'new-session', sessionId: 's1' });
    state.reportReceipt('w1', { opId: receipt.opId, state: 'delivered' });
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's2' }], [{ opId: receipt.opId, state: 'delivered' }]));
    expect(state.threadSnapshot('s1')).toBeUndefined();
    expect(state.receiptsFor('s1').find((entry) => entry.opId === receipt.opId)?.state).toBe('delivered');
    state.reportReceipt('w1', { opId: receipt.opId, state: 'applied' });
    expect(state.receiptsFor('s1').find((entry) => entry.opId === receipt.opId)?.state).toBe('applied');
  });

  it('O1-A7: a receipt absent from the snapshot is lost as not-delivered', () => {
    const { state } = createState();
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1' }]));
    const receipt = state.acceptOp('tok-device', 's1', { type: 'new-session', sessionId: 's1' });
    state.reportReceipt('w1', { opId: receipt.opId, state: 'delivered' });
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's2' }]));
    const lost = state.receiptsFor('s1').find((entry) => entry.opId === receipt.opId);
    expect(lost).toMatchObject({ state: 'lost', reason: 'not-delivered' });
  });

  it('V5-A1: acceptOp returns each rejection reason in order without delivering', () => {
    const { state, delivers } = createState();
    const badShape = state.acceptOp('tok-device', 's1', { type: 'send', sessionId: 'other', text: 'hi' } as unknown as OpIntent);
    expect(badShape).toMatchObject({ state: 'rejected', reason: 'bad-shape' });
    const unknown = state.acceptOp('tok-device', 's1', { type: 'send', sessionId: 's1', text: 'hi' });
    expect(unknown).toMatchObject({ state: 'rejected', reason: 'thread-unknown' });
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1' }]));
    state.workerDisconnected('w1');
    const offline = state.acceptOp('tok-device', 's1', { type: 'send', sessionId: 's1', text: 'hi' });
    expect(offline).toMatchObject({ state: 'rejected', reason: 'thread-offline' });
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1' }]));
    const incapable = state.acceptOp('tok-device', 's1', { type: 'goal-set', sessionId: 's1', objective: 'x', replace: false });
    expect(incapable).toMatchObject({ state: 'rejected', reason: 'not-capable' });
    expect(delivers).toEqual([]);
    const accepted = state.acceptOp('tok-device', 's1', { type: 'send', sessionId: 's1', text: 'hi' });
    expect(accepted).toMatchObject({ state: 'accepted' });
    expect(delivers).toEqual([
      { workerId: 'w1', push: { opId: accepted.opId, sessionId: 's1', intent: { type: 'send', sessionId: 's1', text: 'hi' } } },
    ]);
  });

  it('V5-A1: an intent failing schema validation is rejected as bad-shape', () => {
    const { state, delivers } = createState();
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1' }]));
    const malformed = state.acceptOp('tok-device', 's1', { type: 'send', sessionId: 's1' } as unknown as OpIntent);
    expect(malformed).toMatchObject({ state: 'rejected', reason: 'bad-shape', opType: 'send' });
    expect(delivers).toEqual([]);
    expect(state.receiptsFor('s1')).toHaveLength(1);
  });

  it('V5-A2: an operation targeting a closed card is still delivered', () => {
    const { state, delivers } = createState();
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1', openCards: [] }]));
    const receipt = state.acceptOp('tok-device', 's1', { type: 'approve', sessionId: 's1', cardId: 'approval_gone', optionIndex: 0 });
    expect(receipt.state).toBe('accepted');
    expect(delivers).toHaveLength(1);
  });

  it('V1-Descriptor: the hub overwrites descriptor.tokenName with the issued name', () => {
    const { state } = createState();
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1' }]));
    expect(state.threadSnapshot('s1')!.descriptor.machine.tokenName).toBe('machine-a');
    expect(state.inbox()[0]!.descriptor.machine.tokenName).toBe('machine-a');
  });

  it('O1-Contract: removeOfflineThread refuses online threads and loses receipts for removed threads', () => {
    const { state } = createState();
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1' }]));
    expect(state.removeOfflineThread('s1')).toEqual({ ok: false, reason: 'refused-online' });
    expect(state.threadSnapshot('s1')).toBeDefined();
    const receipt = state.acceptOp('tok-device', 's1', { type: 'send', sessionId: 's1', text: 'hi' });
    state.workerDisconnected('w1');
    expect(state.threadSnapshot('s1')!.online).toBe(false);
    expect(state.removeOfflineThread('s1')).toEqual({ ok: true });
    expect(state.threadSnapshot('s1')).toBeUndefined();
    expect(state.receiptsFor('s1')[0]).toMatchObject({ state: 'lost', reason: 'thread-removed' });
    expect(state.removeOfflineThread('s1')).toEqual({ ok: true });
    expect(receipt.opId).toBeTruthy();
  });

  it('O1-Contract: dropOwner removes threads and loses non-terminal receipts as machine-revoked', () => {
    const { state } = createState();
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1' }]));
    state.register('tok-B', 'w2', snapshotOf('w2', [{ sessionId: 's2' }]));
    const aReceipt = state.acceptOp('tok-device', 's1', { type: 'send', sessionId: 's1', text: 'hi' });
    const bReceipt = state.acceptOp('tok-device', 's2', { type: 'send', sessionId: 's2', text: 'hi' });
    state.dropOwner('tok-A');
    expect(state.threadSnapshot('s1')).toBeUndefined();
    expect(state.threadSnapshot('s2')).toBeDefined();
    expect(state.receiptsFor('s1')[0]).toMatchObject({ state: 'lost', reason: 'machine-revoked' });
    expect(state.receiptsFor('s2').find((entry) => entry.opId === bReceipt.opId)?.state).toBe('accepted');
    expect(aReceipt.state).toBe('accepted');
  });

  it('O1-Contract: unregister applies finalReceipts before removing threads', () => {
    const { state } = createState();
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1' }]));
    const endReceipt = state.acceptOp('tok-device', 's1', { type: 'end-session', sessionId: 's1' });
    state.reportReceipt('w1', { opId: endReceipt.opId, state: 'delivered' });
    const pending = state.acceptOp('tok-device', 's1', { type: 'send', sessionId: 's1', text: 'hi' });
    state.unregister('w1', [{ opId: endReceipt.opId, state: 'applied' }]);
    expect(state.threadSnapshot('s1')).toBeUndefined();
    expect(state.receiptsFor('s1').find((entry) => entry.opId === endReceipt.opId)?.state).toBe('applied');
    expect(state.receiptsFor('s1').find((entry) => entry.opId === pending.opId)).toMatchObject({ state: 'lost', reason: 'thread-removed' });
  });

  it('O1-Contract: workerDisconnected keeps non-terminal receipts and marks threads offline', () => {
    const { state } = createState();
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1' }]));
    const receipt = state.acceptOp('tok-device', 's1', { type: 'send', sessionId: 's1', text: 'hi' });
    state.workerDisconnected('w1');
    expect(state.threadSnapshot('s1')!.online).toBe(false);
    expect(state.receiptsFor('s1')[0]!.state).toBe('accepted');
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1' }], [{ opId: receipt.opId, state: 'delivered' }]));
    expect(state.receiptsFor('s1')[0]!.state).toBe('delivered');
  });

  it('O1-Artifacts: receipts are bounded per sessionId by evicting the oldest terminal receipts', () => {
    const { state } = createState(3);
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1' }]));
    const applied: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const receipt = state.acceptOp('tok-device', 's1', { type: 'send', sessionId: 's1', text: 'hi' });
      state.reportReceipt('w1', { opId: receipt.opId, state: 'delivered' });
      state.reportReceipt('w1', { opId: receipt.opId, state: 'applied' });
      applied.push(receipt.opId);
    }
    const receipts = state.receiptsFor('s1');
    expect(receipts).toHaveLength(3);
    expect(receipts.map((receipt) => receipt.opId)).toEqual(applied.slice(1));
    const pending = state.acceptOp('tok-device', 's1', { type: 'send', sessionId: 's1', text: 'hi' });
    expect(state.receiptsFor('s1').some((receipt) => receipt.opId === pending.opId)).toBe(true);
  });

  it('reportReceipt only accepts reports from the owning worker and valid transitions', () => {
    const { state } = createState();
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1' }]));
    state.register('tok-B', 'w2', snapshotOf('w2', [{ sessionId: 's2' }]));
    const receipt = state.acceptOp('tok-device', 's1', { type: 'send', sessionId: 's1', text: 'hi' });
    state.reportReceipt('w2', { opId: receipt.opId, state: 'delivered' });
    expect(state.receiptsFor('s1')[0]!.state).toBe('accepted');
    state.reportReceipt('w1', { opId: receipt.opId, state: 'applied' });
    expect(state.receiptsFor('s1')[0]!.state).toBe('accepted');
    state.reportReceipt('w1', { opId: receipt.opId, state: 'delivered' });
    expect(state.receiptsFor('s1')[0]!.state).toBe('delivered');
    state.reportReceipt('w1', { opId: receipt.opId, state: 'rejected', reason: 'invalid-params' });
    expect(state.receiptsFor('s1')[0]).toMatchObject({ state: 'rejected', reason: 'invalid-params' });
  });

  it('fans out the full event vocabulary across state transitions', () => {
    const { state, events } = createState();
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1', timeline: [entryOf(1)], openCards: [cardOf('approval_1')] }]));
    state.applyBatch('w1', batchOf('w1', [{ sessionId: 's1', kind: 'timeline', entries: [entryOf(2)] }]));
    state.applyBatch('w1', batchOf('w1', [{ sessionId: 's1', kind: 'overview', overview: overviewOf(9) }]));
    state.acceptOp('tok-device', 's1', { type: 'send', sessionId: 's1', text: 'hi' });
    state.workerDisconnected('w1');
    state.removeOfflineThread('s1');
    const types = events.map((event) => event.type);
    for (const expected of [
      'thread.reset',
      'card.opened',
      'thread.upsert',
      'timeline.append',
      'overview',
      'receipt',
      'thread.removed',
    ]) {
      expect(types).toContain(expected);
    }
    expect(types).not.toContain('card.settled');
  });
});

describe('hub worker registry (P2)', () => {
  let clock: number;

  function overviewOf(rev: number): Overview {
    return {
      rev,
      phase: 'idle',
      isCompacting: false,
      model: 'kimi',
      thinkingEffort: 'high',
      permissionMode: 'default',
      planMode: false,
      contextUsage: 0,
      goal: null,
      todos: [],
      subagents: [],
      backgroundTasks: [],
      models: [],
      lastLine: '',
      sampledAt: clock,
    };
  }

  function descriptorOf(sessionId: string): Descriptor {
    return {
      sessionId,
      machine: { tokenName: 'worker-reported-name', hostname: 'host-1' },
      project: 'proj',
      title: 't',
      kind: 'interactive',
      capabilities: ['approve', 'send', 'end-session'],
    };
  }

  function cardOf(cardId: string): Card {
    return { cardId, kind: 'approval', openedAt: clock, approval: {} };
  }

  function entryOf(seq: number): TimelineEntry {
    return { seq, at: clock, kind: 'user-message', text: `m${seq}` };
  }

  function snapshotOf(
    workerId: string,
    threads: { sessionId: string; timeline?: TimelineEntry[]; openCards?: Card[] }[],
    recentReceipts: ReceiptReport[] = [],
  ): WorkerSnapshot {
    return {
      workerId,
      threads: threads.map((thread) => ({
        descriptor: descriptorOf(thread.sessionId),
        overview: overviewOf(1),
        timeline: thread.timeline ?? [],
        openCards: thread.openCards ?? [],
      })),
      recentReceipts,
    };
  }

  interface RegistryHarness {
    state: HubState;
    registry: WorkerRegistry;
    events: FanoutEvent[];
    persists: number;
    logs: string[];
  }

  function createHarness(options: { graceMs?: number; persisted?: PersistedState } = {}): RegistryHarness {
    let opCounter = 0;
    const harness: RegistryHarness = {
      state: new HubState({
        now: () => clock,
        newOpId: () => `op-${(opCounter += 1)}`,
        onPersist: () => {
          harness.persists += 1;
        },
        onLog: (message) => {
          harness.logs.push(message);
        },
      }),
      registry: undefined as unknown as WorkerRegistry,
      events: [],
      persists: 0,
      logs: [],
    };
    harness.state.onFanout((event) => {
      harness.events.push(event);
    });
    if (options.persisted !== undefined) harness.state.restore(options.persisted);
    const registry = new WorkerRegistry({
      now: () => clock,
      graceMs: options.graceMs,
      onLog: (message) => {
        harness.logs.push(message);
      },
      onExpire: (workerId) => {
        harness.state.markWorkerReceiptsLost(workerId);
      },
    });
    if (options.persisted !== undefined) registry.restoreFrom(options.persisted.threads, options.persisted.receipts);
    harness.registry = registry;
    return harness;
  }

  function receiptEventsOf(events: readonly FanoutEvent[]): Extract<FanoutEvent, { type: 'receipt' }>[] {
    return events.filter((event): event is Extract<FanoutEvent, { type: 'receipt' }> => event.type === 'receipt');
  }

  const GRACE_MS = 60_000;

  beforeEach(() => {
    clock = 1000;
  });

  it('P2-2.4: authorize allows only the bound owner; claim establishes or refuses without side effects', () => {
    const { registry } = createHarness();
    expect(registry.authorize('w1', 'tok-A')).toBe(false);
    expect(registry.claim('w1', 'tok-A')).toBe(true);
    expect(registry.authorize('w1', 'tok-A')).toBe(true);
    expect(registry.authorize('w1', 'tok-B')).toBe(false);
    expect(registry.authorize('w2', 'tok-A')).toBe(false);
    expect(registry.claim('w1', 'tok-B')).toBe(false);
    expect(registry.authorize('w1', 'tok-A')).toBe(true);
    expect(registry.claim('w2', 'tok-B')).toBe(true);
    expect(registry.authorize('w2', 'tok-B')).toBe(true);
  });

  it('P2-2.1: a worker offline beyond grace has its non-terminal receipts lost as not-delivered with events, pruning, and persist signal', () => {
    const harness = createHarness({ graceMs: GRACE_MS });
    const { state, registry, events } = harness;
    registry.claim('w1', 'tok-A');
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1' }]));
    const receipt = state.acceptOp('tok-device', 's1', { type: 'send', sessionId: 's1', text: 'hi' });
    const handle = registry.online('w1');
    const persistsBefore = harness.persists;
    registry.offline('w1', handle);
    clock += GRACE_MS - 1;
    registry.scan();
    expect(state.receiptsFor('s1')[0]!.state).toBe('accepted');
    expect(harness.persists).toBe(persistsBefore);
    clock += 1;
    registry.scan();
    const lost = state.receiptsFor('s1').find((entry) => entry.opId === receipt.opId);
    expect(lost).toMatchObject({ state: 'lost', reason: 'not-delivered' });
    expect(receiptEventsOf(events).some((event) => event.receipt.opId === receipt.opId && event.receipt.state === 'lost')).toBe(true);
    expect(state.persistView().receipts.find((entry) => entry.opId === receipt.opId)?.state).toBe('lost');
    expect(harness.persists).toBe(persistsBefore + 1);
    registry.scan();
    expect(harness.persists).toBe(persistsBefore + 1);
  });

  it('P2-2.2: reconnect within grace via register keeps receipts and reconciles them', () => {
    const { state, registry } = createHarness({ graceMs: GRACE_MS });
    registry.claim('w1', 'tok-A');
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1' }]));
    const receipt = state.acceptOp('tok-device', 's1', { type: 'send', sessionId: 's1', text: 'hi' });
    const handle = registry.online('w1');
    registry.offline('w1', handle);
    clock += GRACE_MS - 1;
    registry.online('w1');
    registry.scan();
    expect(state.receiptsFor('s1')[0]!.state).toBe('accepted');
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1' }], [{ opId: receipt.opId, state: 'delivered' }]));
    expect(state.receiptsFor('s1')[0]).toMatchObject({ state: 'delivered' });
    clock += GRACE_MS * 2;
    registry.scan();
    expect(state.receiptsFor('s1')[0]!.state).toBe('delivered');
  });

  it('P2-2.3: a registry built from persisted state starts every known worker offline from startup time', () => {
    const persisted: PersistedState = {
      tokens: [],
      threads: [
        {
          sessionId: 's1',
          ownerTokenId: 'tok-A',
          hostWorkerId: 'w1',
          descriptor: descriptorOf('s1'),
          overview: overviewOf(1),
          overviewRev: 1,
          openCards: [cardOf('approval_1')],
        },
      ],
      receipts: [
        { opId: 'op-1', sessionId: 's1', opType: 'send', state: 'accepted', at: 100, workerId: 'w1' },
        { opId: 'op-2', sessionId: 's1', opType: 'send', state: 'accepted', at: 101, workerId: 'w2' },
      ],
    };
    const harness = createHarness({ graceMs: GRACE_MS, persisted });
    const { state, registry, events } = harness;
    registry.scan();
    expect(state.receiptsFor('s1')[0]!.state).toBe('accepted');
    expect(harness.persists).toBe(0);
    clock += GRACE_MS;
    registry.scan();
    expect(state.receiptsFor('s1').find((entry) => entry.opId === 'op-1')).toMatchObject({ state: 'lost', reason: 'not-delivered' });
    expect(state.receiptsFor('s1').find((entry) => entry.opId === 'op-2')).toMatchObject({ state: 'lost', reason: 'not-delivered' });
    expect(receiptEventsOf(events).some((event) => event.receipt.opId === 'op-1' && event.receipt.state === 'lost')).toBe(true);
    expect(harness.persists).toBe(2);
  });

  it('P2-2.5: conflicting persisted owners leave the worker unbound and claimable, with a register-rejected-style log', () => {
    const persisted: PersistedState = {
      tokens: [],
      threads: [
        {
          sessionId: 's1',
          ownerTokenId: 'tok-A',
          hostWorkerId: 'w1',
          descriptor: descriptorOf('s1'),
          overview: overviewOf(1),
          overviewRev: 1,
          openCards: [],
        },
        {
          sessionId: 's2',
          ownerTokenId: 'tok-B',
          hostWorkerId: 'w1',
          descriptor: descriptorOf('s2'),
          overview: overviewOf(1),
          overviewRev: 1,
          openCards: [],
        },
      ],
      receipts: [],
    };
    const { registry, logs } = createHarness({ persisted });
    expect(registry.authorize('w1', 'tok-A')).toBe(false);
    expect(registry.authorize('w1', 'tok-B')).toBe(false);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain('w1');
    expect(registry.claim('w1', 'tok-A')).toBe(true);
    expect(registry.authorize('w1', 'tok-A')).toBe(true);
  });

  it('P2-2.6: default grace exceeds the worker max reconnect interval (backoff cap 30s + request timeout 10s, from apps/kimi-code/src/tui/controllers/forum-link/link.ts:48,51)', () => {
    const WORKER_BACKOFF_CAP_MS = 30_000;
    const WORKER_REQUEST_TIMEOUT_MS = 10_000;
    const WORKER_MAX_RECONNECT_MS = WORKER_BACKOFF_CAP_MS + WORKER_REQUEST_TIMEOUT_MS;
    expect(DEFAULT_WORKER_GRACE_MS).toBe(5 * 60_000);
    expect(DEFAULT_WORKER_GRACE_MS).toBeGreaterThan(WORKER_MAX_RECONNECT_MS);
  });

  it('P2-2.7: a same-owner stream replacement does not mark the worker offline', () => {
    const { state, registry } = createHarness({ graceMs: GRACE_MS });
    registry.claim('w1', 'tok-A');
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1' }]));
    const receipt = state.acceptOp('tok-device', 's1', { type: 'send', sessionId: 's1', text: 'hi' });
    const first = registry.online('w1');
    registry.offline('w1', first);
    const second = registry.online('w1');
    clock += GRACE_MS * 2;
    registry.scan();
    expect(registry.isOnline('w1')).toBe(true);
    expect(state.receiptsFor('s1').find((entry) => entry.opId === receipt.opId)?.state).toBe('accepted');
    registry.offline('w1', second);
    clock += GRACE_MS;
    registry.scan();
    expect(registry.isOnline('w1')).toBe(false);
    expect(state.receiptsFor('s1').find((entry) => entry.opId === receipt.opId)).toMatchObject({ state: 'lost', reason: 'not-delivered' });
  });

  it('P2-scan: the periodic scanner expires workers on an injectable interval', async () => {
    const { state, registry } = createHarness({ graceMs: 0 });
    registry.claim('w1', 'tok-A');
    state.register('tok-A', 'w1', snapshotOf('w1', [{ sessionId: 's1' }]));
    const receipt = state.acceptOp('tok-device', 's1', { type: 'send', sessionId: 's1', text: 'hi' });
    const handle = registry.online('w1');
    registry.offline('w1', handle);
    registry.startScan(5);
    try {
      await new Promise((resolve) => {
        setTimeout(resolve, 30);
      });
      expect(state.receiptsFor('s1').find((entry) => entry.opId === receipt.opId)?.state).toBe('lost');
    } finally {
      registry.stopScan();
    }
  });
});

describe('hub worker face (V2)', () => {
  let clock: number;

  function overviewOf(rev: number): Overview {
    return {
      rev,
      phase: 'idle',
      isCompacting: false,
      model: 'kimi',
      thinkingEffort: 'high',
      permissionMode: 'default',
      planMode: false,
      contextUsage: 0,
      goal: null,
      todos: [],
      subagents: [],
      backgroundTasks: [],
      models: [],
      lastLine: '',
      sampledAt: clock,
    };
  }

  function descriptorOf(sessionId: string, capabilities: OpType[] = ['approve', 'send', 'end-session']): Descriptor {
    return {
      sessionId,
      machine: { tokenName: 'worker-reported-name', hostname: 'host-1' },
      project: 'proj',
      title: 't',
      kind: 'interactive',
      capabilities,
    };
  }

  function cardOf(cardId: string): Card {
    return { cardId, kind: 'approval', openedAt: clock, approval: {} };
  }

  function entryOf(seq: number): TimelineEntry {
    return { seq, at: clock, kind: 'user-message', text: `m${seq}` };
  }

  function snapshotOf(
    workerId: string,
    threads: { sessionId: string; timeline?: TimelineEntry[]; openCards?: Card[] }[],
    recentReceipts: ReceiptReport[] = [],
  ): WorkerSnapshot {
    return {
      workerId,
      threads: threads.map((thread) => ({
        descriptor: descriptorOf(thread.sessionId),
        overview: overviewOf(1),
        timeline: thread.timeline ?? [],
        openCards: thread.openCards ?? [],
      })),
      recentReceipts,
    };
  }

  beforeEach(() => {
    clock = 1000;
  });

  async function stopWorkerHub(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await new Promise<void>((resolve) => {
      child.once('exit', () => {
        resolve();
      });
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5000).unref?.();
    });
  }

  interface SseStream {
    lines: string[];
    close(): void;
    closed: Promise<void>;
  }

  async function openSse(url: string, authorization: string): Promise<SseStream> {
    const res = await fetch(url, { headers: { authorization } });
    if (res.status !== 200 || res.body === null) throw new Error(`stream failed: ${res.status}`);
    const lines: string[] = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let closedResolve: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      closedResolve = resolve;
    });
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          lines.push(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
      }
      closedResolve();
    })();
    void pump.catch(() => {
      closedResolve();
    });
    return {
      lines,
      close() {
        void reader.cancel().catch(() => {});
      },
      closed,
    };
  }

  function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error(`timeout waiting for ${label}`));
        }, ms).unref?.();
      }),
    ]);
  }

  async function waitForLines(stream: SseStream, count: number, label: string): Promise<void> {
    await waitForCondition(() => stream.lines.length >= count, label);
  }

  async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
    await waitForCondition(predicate, label);
  }

  async function waitForCondition(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
      await new Promise((resolve) => {
        setTimeout(resolve, 10).unref?.();
      });
    }
  }

  function opEventsOf(lines: readonly string[]): { opId: string; sessionId: string; intent: OpIntent }[] {
    const events: { opId: string; sessionId: string; intent: OpIntent }[] = [];
    for (let i = 0; i < lines.length - 1; i += 1) {
      if (lines[i] !== 'event: op') continue;
      const data = lines[i + 1]!.startsWith('data: ') ? lines[i + 1]!.slice(6) : undefined;
      if (data === undefined) continue;
      events.push(JSON.parse(data) as { opId: string; sessionId: string; intent: OpIntent });
    }
    return events;
  }

  interface WorkerHarness {
    baseUrl: string;
    machineSecret: string;
    deviceSecret: string;
    post(path: string, body: unknown): Promise<Response>;
    openStream(workerId: string): Promise<SseStream>;
    stop(): Promise<void>;
  }

  async function startSpawnedWorkerHarness(extraArgs: string[] = []): Promise<WorkerHarness> {
    const { machineSecret, deviceSecret } = await issueHttpTokens();
    const { child, baseUrl } = await startServeHub(extraArgs);
    const authorization = `Bearer ${machineSecret}`;
    const post = (path: string, body: unknown) =>
      fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const openStream = (workerId: string) =>
      openSse(`${baseUrl}/api/worker/stream?workerId=${encodeURIComponent(workerId)}`, authorization);
    const stop = () => stopWorkerHub(child);
    return { baseUrl, machineSecret, deviceSecret, post, openStream, stop };
  }

  interface InProcessHarness {
    baseUrl: string;
    machineSecret: string;
    deviceSecret: string;
    state: State;
    post(path: string, body: unknown): Promise<Response>;
    openStream(workerId: string): Promise<SseStream>;
    close(): Promise<{ ok: boolean }>;
  }

  async function startInProcessHarness(): Promise<InProcessHarness> {
    const { machineSecret, deviceSecret } = await issueHttpTokens();
    const hub = createHubServer({ dataDir });
    const baseUrl = await new Promise<string>((resolve) => {
      hub.server.listen(0, '127.0.0.1', () => {
        const address = hub.server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
    const authorization = `Bearer ${machineSecret}`;
    const post = (path: string, body: unknown) =>
      fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const openStream = (workerId: string) =>
      openSse(`${baseUrl}/api/worker/stream?workerId=${encodeURIComponent(workerId)}`, authorization);
    return {
      baseUrl,
      machineSecret,
      deviceSecret,
      state: hub.state,
      post,
      openStream,
      close: () => hub.close(),
    };
  }

  it('V2-Checkpoint: fake worker completes register, stream, batch, receipt, unregister', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const hub = await startSpawnedWorkerHarness();
    try {
      const register = await hub.post('/api/worker/register', snapshotOf('w-check', [{ sessionId: 's1', timeline: [entryOf(1)] }]));
      expect(register.status).toBe(200);
      expect(await register.json()).toEqual({ workerId: 'w-check', threads: [{ sessionId: 's1', accepted: true }] });
      const stream = await hub.openStream('w-check');
      await waitForLines(stream, 1, 'stream open');
      const batch = await hub.post('/api/worker/batch', {
        workerId: 'w-check',
        frames: [{ sessionId: 's1', kind: 'timeline', entries: [entryOf(2)] }],
      });
      expect(batch.status).toBe(200);
      const receipt = await hub.post('/api/worker/receipt', { workerId: 'w-check', receipts: [{ opId: 'op-none', state: 'delivered' }] });
      expect(receipt.status).toBe(204);
      const unregister = await hub.post('/api/worker/unregister', { workerId: 'w-check', finalReceipts: [] });
      expect(unregister.status).toBe(204);
      stream.close();
    } finally {
      await hub.stop();
    }
  });

  it('V2-Checkpoint: an accepted op reaches the worker stream as an op event', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const hub = await startInProcessHarness();
    try {
      const register = await hub.post('/api/worker/register', snapshotOf('w-ops', [{ sessionId: 's1' }]));
      expect(register.status).toBe(200);
      const stream = await hub.openStream('w-ops');
      await waitForLines(stream, 1, 'stream open');
      const receipt = hub.state.acceptOp('tok-device', 's1', { type: 'send', sessionId: 's1', text: 'hi' });
      expect(receipt.state).toBe('accepted');
      await waitForLines(stream, 3, 'op event lines');
      expect(opEventsOf(stream.lines)).toEqual([
        { opId: receipt.opId, sessionId: 's1', intent: { type: 'send', sessionId: 's1', text: 'hi' } },
      ]);
      stream.close();
      const afterClose = hub.state.acceptOp('tok-device', 's1', { type: 'send', sessionId: 's1', text: 'again' });
      expect(afterClose.state).toBe('accepted');
      expect(hub.state.receiptsFor('s1').find((entry) => entry.opId === afterClose.opId)?.state).toBe('accepted');
    } finally {
      await hub.close();
    }
  });

  it('V2-Interface: non-machine roles and malformed requests are rejected', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const hub = await startSpawnedWorkerHarness();
    try {
      const deviceRegister = await fetch(`${hub.baseUrl}/api/worker/register`, {
        method: 'POST',
        headers: { authorization: `Bearer ${hub.deviceSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify(snapshotOf('w-x', [{ sessionId: 's1' }])),
      });
      expect(deviceRegister.status).toBe(403);
      const badBody = await hub.post('/api/worker/register', { nonsense: true });
      expect(badBody.status).toBe(400);
      const missingWorkerId = await fetch(`${hub.baseUrl}/api/worker/stream`, {
        headers: { authorization: `Bearer ${hub.machineSecret}` },
      });
      expect(missingWorkerId.status).toBe(400);
    } finally {
      await hub.stop();
    }
  });

  it('V2-A1: ops accepted while disconnected are not re-pushed after reconnect', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const hub = await startInProcessHarness();
    try {
      const register = await hub.post('/api/worker/register', snapshotOf('w-a1', [{ sessionId: 's1' }]));
      expect(register.status).toBe(200);
      const stream1 = await hub.openStream('w-a1');
      await waitForLines(stream1, 1, 'stream open');
      const first = hub.state.acceptOp('tok-device', 's1', { type: 'send', sessionId: 's1', text: 'one' });
      expect(first.state).toBe('accepted');
      await waitForLines(stream1, 3, 'first op event');
      stream1.close();
      await waitUntil(() => {
        return !hub.state.threadSnapshot('s1')!.online;
      }, 'thread to go offline');
      const reconnect = await hub.post('/api/worker/register', snapshotOf('w-a1', [{ sessionId: 's1' }]));
      expect(reconnect.status).toBe(200);
      expect(hub.state.receiptsFor('s1').find((entry) => entry.opId === first.opId)).toMatchObject({
        state: 'lost',
        reason: 'not-delivered',
      });
      const stream2 = await hub.openStream('w-a1');
      await waitForLines(stream2, 1, 'stream open');
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
      expect(opEventsOf(stream2.lines)).toEqual([]);
      const second = hub.state.acceptOp('tok-device', 's1', { type: 'send', sessionId: 's1', text: 'two' });
      expect(second.state).toBe('accepted');
      await waitForLines(stream2, 3, 'second op event');
      expect(opEventsOf(stream2.lines)).toEqual([
        { opId: second.opId, sessionId: 's1', intent: { type: 'send', sessionId: 's1', text: 'two' } },
      ]);
      stream2.close();
    } finally {
      await hub.close();
    }
  });

  it('V2-A2: a 409 batch leaves the hub mirror unchanged', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const hub = await startInProcessHarness();
    try {
      const register = await hub.post('/api/worker/register', snapshotOf('w-a2', [{ sessionId: 's1', timeline: [entryOf(1), entryOf(2)] }]));
      expect(register.status).toBe(200);
      const before = JSON.stringify(hub.state.threadSnapshot('s1'));
      const rejected = await hub.post('/api/worker/batch', {
        workerId: 'w-a2',
        frames: [
          { sessionId: 's1', kind: 'timeline', entries: [entryOf(3)] },
          { sessionId: 's1', kind: 'timeline', entries: [entryOf(5)] },
        ],
      });
      expect(rejected.status).toBe(409);
      expect(await rejected.text()).toContain('resync-required');
      expect(JSON.stringify(hub.state.threadSnapshot('s1'))).toBe(before);
      const ok = await hub.post('/api/worker/batch', {
        workerId: 'w-a2',
        frames: [{ sessionId: 's1', kind: 'timeline', entries: [entryOf(3)] }],
      });
      expect(ok.status).toBe(200);
      expect(hub.state.threadSnapshot('s1')!.timeline).toHaveLength(3);
    } finally {
      await hub.close();
    }
  });

  it('V2-A3: heartbeat interval is injectable and SSE carries X-Accel-Buffering: no', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const hub = await startSpawnedWorkerHarness(['--heartbeat-interval-ms', '100']);
    try {
      const register = await hub.post('/api/worker/register', snapshotOf('w-hb', [{ sessionId: 's1' }]));
      expect(register.status).toBe(200);
      const res = await fetch(`${hub.baseUrl}/api/worker/stream?workerId=w-hb`, {
        headers: { authorization: `Bearer ${hub.machineSecret}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-accel-buffering')).toBe('no');
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !text.includes(': hb')) {
        const { done, value } = await withTimeout(reader.read(), 2000, 'heartbeat read');
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      void reader.cancel().catch(() => {});
      expect(text).toContain(': connected');
      expect(text).toContain(': hb');
    } finally {
      await hub.stop();
    }
  });

  it('V2-A4: unregister applies finalReceipts before removing threads', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const hub = await startInProcessHarness();
    try {
      const register = await hub.post('/api/worker/register', snapshotOf('w-a4', [{ sessionId: 's1' }]));
      expect(register.status).toBe(200);
      const endReceipt = hub.state.acceptOp('tok-device', 's1', { type: 'end-session', sessionId: 's1' });
      expect(endReceipt.state).toBe('accepted');
      const receipt = await hub.post('/api/worker/receipt', {
        workerId: 'w-a4',
        receipts: [{ opId: endReceipt.opId, state: 'delivered' }],
      });
      expect(receipt.status).toBe(204);
      const unregister = await hub.post('/api/worker/unregister', {
        workerId: 'w-a4',
        finalReceipts: [{ opId: endReceipt.opId, state: 'applied' }],
      });
      expect(unregister.status).toBe(204);
      expect(hub.state.threadSnapshot('s1')).toBeUndefined();
      expect(hub.state.receiptsFor('s1').find((entry) => entry.opId === endReceipt.opId)?.state).toBe('applied');
    } finally {
      await hub.close();
    }
  });

  it('V2-Contract: a second stream for the same workerId evicts the first connection', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const hub = await startSpawnedWorkerHarness();
    try {
      const register = await hub.post('/api/worker/register', snapshotOf('w-conn', [{ sessionId: 's1' }]));
      expect(register.status).toBe(200);
      const first = await hub.openStream('w-conn');
      await waitForLines(first, 1, 'first stream open');
      const second = await hub.openStream('w-conn');
      await waitForLines(second, 1, 'second stream open');
      await withTimeout(first.closed, 5000, 'first stream to close');
      second.close();
    } finally {
      await hub.stop();
    }
  });

  it('V2-Contract: workerConnected marks hosted threads online again', () => {
    const state = new HubState();
    state.register('tok-o', 'w-o', snapshotOf('w-o', [{ sessionId: 'so' }]));
    state.workerDisconnected('w-o');
    expect(state.threadSnapshot('so')!.online).toBe(false);
    state.workerConnected('w-o');
    expect(state.threadSnapshot('so')!.online).toBe(true);
  });

  it('V2-Contract: stream close marks hosted threads offline', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const hub = await startInProcessHarness();
    try {
      const register = await hub.post('/api/worker/register', snapshotOf('w-off', [{ sessionId: 's1' }]));
      expect(register.status).toBe(200);
      expect(hub.state.threadSnapshot('s1')!.online).toBe(true);
      const stream = await hub.openStream('w-off');
      await waitForLines(stream, 1, 'stream open');
      stream.close();
      await waitUntil(() => {
        return !hub.state.threadSnapshot('s1')!.online;
      }, 'thread to go offline');
    } finally {
      await hub.close();
    }
  });
});

describe('hub browser face (V3/V4)', () => {
  let clock: number;

  function overviewOf(rev: number): Overview {
    return {
      rev,
      phase: 'idle',
      isCompacting: false,
      model: 'kimi',
      thinkingEffort: 'high',
      permissionMode: 'default',
      planMode: false,
      contextUsage: 0,
      goal: null,
      todos: [],
      subagents: [],
      backgroundTasks: [],
      models: [],
      lastLine: '',
      sampledAt: clock,
    };
  }

  function descriptorOf(sessionId: string, capabilities: OpType[] = ['approve', 'send', 'end-session']): Descriptor {
    return {
      sessionId,
      machine: { tokenName: 'worker-reported-name', hostname: 'host-1' },
      project: 'proj',
      title: 't',
      kind: 'interactive',
      capabilities,
    };
  }

  function cardOf(cardId: string): Card {
    return { cardId, kind: 'approval', openedAt: clock, approval: {} };
  }

  function entryOf(seq: number): TimelineEntry {
    return { seq, at: clock, kind: 'user-message', text: `m${seq}` };
  }

  function snapshotOf(
    workerId: string,
    threads: { sessionId: string; timeline?: TimelineEntry[]; openCards?: Card[] }[],
    recentReceipts: ReceiptReport[] = [],
  ): WorkerSnapshot {
    return {
      workerId,
      threads: threads.map((thread) => ({
        descriptor: descriptorOf(thread.sessionId),
        overview: overviewOf(1),
        timeline: thread.timeline ?? [],
        openCards: thread.openCards ?? [],
      })),
      recentReceipts,
    };
  }

  beforeEach(() => {
    clock = 1000;
  });

  interface SseStream {
    lines: string[];
    close(): void;
    closed: Promise<void>;
  }

  async function openSse(url: string, headers: Record<string, string>): Promise<SseStream> {
    const res = await fetch(url, { headers });
    if (res.status !== 200 || res.body === null) throw new Error(`stream failed: ${res.status}`);
    const lines: string[] = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let closedResolve: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      closedResolve = resolve;
    });
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          lines.push(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
      }
      closedResolve();
    })();
    void pump.catch(() => {
      closedResolve();
    });
    return {
      lines,
      close() {
        void reader.cancel().catch(() => {});
      },
      closed,
    };
  }

  async function waitUntil(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
      await new Promise((resolve) => {
        setTimeout(resolve, 10).unref?.();
      });
    }
  }

  async function waitForLines(stream: SseStream, count: number, label: string): Promise<void> {
    await waitUntil(() => stream.lines.length >= count, label);
  }

  function namedEventsOf(lines: readonly string[]): { event: string; data: unknown }[] {
    const events: { event: string; data: unknown }[] = [];
    for (let i = 0; i < lines.length - 1; i += 1) {
      if (!lines[i]!.startsWith('event: ')) continue;
      const dataLine = lines[i + 1]!;
      if (!dataLine.startsWith('data: ')) continue;
      events.push({ event: lines[i]!.slice(7), data: JSON.parse(dataLine.slice(6)) as unknown });
    }
    return events;
  }

  interface BrowserHarness {
    baseUrl: string;
    machineSecret: string;
    deviceSecret: string;
    workerPost(path: string, body: unknown): Promise<Response>;
    browserFetch(path: string, init?: RequestInit): Promise<Response>;
    browserPost(path: string, body: unknown, contentType?: string): Promise<Response>;
    openWorkerStream(workerId: string): Promise<SseStream>;
    openBrowserStream(): Promise<SseStream>;
    close(): Promise<void>;
  }

  async function startBrowserHarness(extraArgs: string[] = []): Promise<BrowserHarness> {
    const { machineSecret, deviceSecret } = await issueHttpTokens();
    const { child, baseUrl } = await startServeHub(extraArgs);
    const machineAuth = `Bearer ${machineSecret}`;
    const cookie = `${BROWSER_COOKIE_NAME}=${deviceSecret}`;
    const workerPost = (path: string, body: unknown) =>
      fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { authorization: machineAuth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const browserFetch = (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set('cookie', cookie);
      return fetch(`${baseUrl}${path}`, { ...init, headers });
    };
    const browserPost = (path: string, body: unknown, contentType = 'application/json') =>
      fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { cookie, 'content-type': contentType },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
    const openWorkerStream = (workerId: string) =>
      openSse(`${baseUrl}/api/worker/stream?workerId=${encodeURIComponent(workerId)}`, { authorization: machineAuth });
    const openBrowserStream = () => openSse(`${baseUrl}/api/browser/stream`, { cookie });
    const close = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      await new Promise<void>((resolve) => {
        child.once('exit', () => {
          resolve();
        });
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5000).unref?.();
      });
    };
    return {
      baseUrl,
      machineSecret,
      deviceSecret,
      workerPost,
      browserFetch,
      browserPost,
      openWorkerStream,
      openBrowserStream,
      close,
    };
  }

  it('V3-Checkpoint: device cookie reads inbox, streams, and submits ops for receipts', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const hub = await startBrowserHarness();
    try {
      const login = await fetch(`${hub.baseUrl}/api/browser/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: hub.deviceSecret }),
      });
      expect(login.status).toBe(204);
      const setCookie = login.headers.get('set-cookie') ?? '';
      expect(setCookie.startsWith(`${BROWSER_COOKIE_NAME}=${hub.deviceSecret}`)).toBe(true);

      const register = await hub.workerPost('/api/worker/register', snapshotOf('w-v3', [{ sessionId: 's1', timeline: [entryOf(1)] }]));
      expect(register.status).toBe(200);
      const workerStream = await hub.openWorkerStream('w-v3');
      await waitForLines(workerStream, 1, 'worker stream open');

      const stream = await hub.openBrowserStream();
      await waitForLines(stream, 1, 'browser stream open');

      const inbox = await hub.browserFetch('/api/browser/inbox');
      expect(inbox.status).toBe(200);
      const inboxBody = (await inbox.json()) as { threads: { descriptor: { sessionId: string }; online: boolean }[] };
      expect(inboxBody.threads).toHaveLength(1);
      expect(inboxBody.threads[0]!.descriptor.sessionId).toBe('s1');
      expect(inboxBody.threads[0]!.online).toBe(true);

      const thread = await hub.browserFetch('/api/browser/threads/s1');
      expect(thread.status).toBe(200);
      const threadBody = (await thread.json()) as { timeline: TimelineEntry[]; descriptor: { sessionId: string } };
      expect(threadBody.descriptor.sessionId).toBe('s1');
      expect(threadBody.timeline).toHaveLength(1);

      const ops = await hub.browserPost('/api/browser/ops', { sessionId: 's1', intent: { type: 'send', sessionId: 's1', text: 'hi' } });
      expect(ops.status).toBe(202);
      const receipt = (await ops.json()) as { opId: string; state: string };
      expect(receipt.state).toBe('accepted');
      expect(receipt.opId).toBeTruthy();

      await waitForLines(workerStream, 3, 'op pushed to worker');
      const receiptReport = await hub.workerPost('/api/worker/receipt', {
        workerId: 'w-v3',
        receipts: [{ opId: receipt.opId, state: 'delivered' }],
      });
      expect(receiptReport.status).toBe(204);

      await waitUntil(
        () => namedEventsOf(stream.lines).some((event) => event.event === 'receipt'),
        'receipt fanout event',
      );
      const after = await hub.browserFetch('/api/browser/threads/s1');
      const afterBody = (await after.json()) as { receipts: { opId: string; state: string }[] };
      expect(afterBody.receipts.find((entry) => entry.opId === receipt.opId)?.state).toBe('delivered');
      stream.close();
      workerStream.close();
    } finally {
      await hub.close();
    }
  });

  it('V3-A1: stream events cover every state-change kind and idle activity emits nothing', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const hub = await startBrowserHarness();
    try {
      const register = await hub.workerPost('/api/worker/register', snapshotOf('w-a1', [{ sessionId: 's1', openCards: [cardOf('approval_1')] }]));
      expect(register.status).toBe(200);
      const stream = await hub.openBrowserStream();
      await waitForLines(stream, 1, 'browser stream open');
      const before = stream.lines.length;
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
      expect(stream.lines.length).toBe(before);

      await hub.workerPost('/api/worker/register', snapshotOf('w-a1', [{ sessionId: 's1', openCards: [cardOf('approval_1'), cardOf('approval_2')] }]));
      await waitUntil(
        () => namedEventsOf(stream.lines).some((event) => event.event === 'card.opened'),
        'card.opened event',
      );
      await hub.workerPost('/api/worker/batch', {
        workerId: 'w-a1',
        frames: [{ sessionId: 's1', kind: 'timeline', entries: [entryOf(1)] }],
      });
      await hub.workerPost('/api/worker/batch', {
        workerId: 'w-a1',
        frames: [{ sessionId: 's1', kind: 'overview', overview: overviewOf(9) }],
      });
      const ops = await hub.browserPost('/api/browser/ops', { sessionId: 's1', intent: { type: 'send', sessionId: 's1', text: 'hi' } });
      expect(ops.status).toBe(202);
      const receipt = (await ops.json()) as { opId: string };
      await hub.workerPost('/api/worker/receipt', {
        workerId: 'w-a1',
        receipts: [{ opId: receipt.opId, state: 'delivered' }],
      });
      await waitUntil(
        () => namedEventsOf(stream.lines).some((event) => event.event === 'receipt'),
        'receipt event',
      );
      await hub.workerPost('/api/worker/register', snapshotOf('w-a1', [{ sessionId: 's1', openCards: [] }]));
      await waitUntil(
        () => namedEventsOf(stream.lines).filter((event) => event.event === 'card.settled').length >= 2,
        'card.settled events',
      );
      const workerStream = await hub.openWorkerStream('w-a1');
      await waitForLines(workerStream, 1, 'worker stream open');
      workerStream.close();
      await waitUntil(
        async () => {
          const thread = await hub.browserFetch('/api/browser/threads/s1');
          const body = (await thread.json()) as { online: boolean };
          return !body.online;
        },
        'thread offline',
      );
      const remove = await hub.browserFetch('/api/browser/threads/s1', { method: 'DELETE' });
      expect(remove.status).toBe(204);
      await waitUntil(
        () => namedEventsOf(stream.lines).some((event) => event.event === 'thread.removed'),
        'thread.removed event',
      );
      const names = namedEventsOf(stream.lines).map((event) => event.event);
      for (const expected of [
        'thread.upsert',
        'thread.reset',
        'timeline.append',
        'overview',
        'card.opened',
        'card.settled',
        'receipt',
        'thread.removed',
      ]) {
        expect(names, `event ${expected}`).toContain(expected);
      }
      stream.close();
    } finally {
      await hub.close();
    }
  });

  it('V3-A2: every submission gets a fresh opId with no dedup', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const hub = await startBrowserHarness();
    try {
      const register = await hub.workerPost('/api/worker/register', snapshotOf('w-a2', [{ sessionId: 's1' }]));
      expect(register.status).toBe(200);
      const intent = { type: 'send', sessionId: 's1', text: 'same' } as const;
      const opIds: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const ops = await hub.browserPost('/api/browser/ops', { sessionId: 's1', intent });
        expect(ops.status).toBe(202);
        const receipt = (await ops.json()) as { opId: string };
        opIds.push(receipt.opId);
      }
      expect(new Set(opIds).size).toBe(3);
    } finally {
      await hub.close();
    }
  });

  it('V3-A3: non-JSON write requests get 415 and produce no effects', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const hub = await startBrowserHarness();
    try {
      const register = await hub.workerPost('/api/worker/register', snapshotOf('w-a3', [{ sessionId: 's1' }]));
      expect(register.status).toBe(200);
      const before = JSON.stringify(await (await hub.browserFetch('/api/browser/threads/s1')).json());
      const ops = await hub.browserPost('/api/browser/ops', { sessionId: 's1', intent: { type: 'send', sessionId: 's1', text: 'x' } }, 'text/plain');
      expect(ops.status).toBe(415);
      const after = JSON.stringify(await (await hub.browserFetch('/api/browser/threads/s1')).json());
      expect(after).toBe(before);
      const login = await fetch(`${hub.baseUrl}/api/browser/login`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ token: hub.deviceSecret }),
      });
      expect(login.status).toBe(415);
    } finally {
      await hub.close();
    }
  });

  it('V4-A2: login sets the full cookie attributes and rejects machine tokens into the rate limit', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const hub = await startBrowserHarness();
    try {
      const login = await fetch(`${hub.baseUrl}/api/browser/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: hub.deviceSecret }),
      });
      expect(login.status).toBe(204);
      const setCookie = login.headers.get('set-cookie') ?? '';
      expect(setCookie).toBe(
        `${BROWSER_COOKIE_NAME}=${hub.deviceSecret}; HttpOnly; Secure; SameSite=Strict; Path=/`,
      );
      for (let i = 0; i < 5; i += 1) {
        const attempt = await fetch(`${hub.baseUrl}/api/browser/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: hub.machineSecret }),
        });
        expect(attempt.status).toBe(401);
      }
      const blocked = await fetch(`${hub.baseUrl}/api/browser/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: hub.deviceSecret }),
      });
      expect(blocked.status).toBe(429);
    } finally {
      await hub.close();
    }
  });

  it('V4-A1: no hub route accepts credentials in the query string', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const hub = await startBrowserHarness();
    try {
      const key = await fetch(`${hub.baseUrl}/api/browser/inbox?key=${hub.deviceSecret}`);
      expect(key.status).toBe(401);
      const token = await fetch(`${hub.baseUrl}/api/browser/inbox?token=${hub.deviceSecret}`);
      expect(token.status).toBe(401);
      const workerKey = await fetch(`${hub.baseUrl}/api/worker/register?key=${hub.machineSecret}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(snapshotOf('w-q', [{ sessionId: 's1' }])),
      });
      expect(workerKey.status).toBe(401);
      const login = await fetch(`${hub.baseUrl}/api/browser/login?token=${hub.deviceSecret}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'x' }),
      });
      expect(login.status).toBe(401);
    } finally {
      await hub.close();
    }
  });

  it('P1: 401 without or with a revoked cookie, 404 unknown thread, 409 online delete', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const hub = await startBrowserHarness();
    try {
      expect((await fetch(`${hub.baseUrl}/api/browser/inbox`)).status).toBe(401);
      expect((await fetch(`${hub.baseUrl}/api/browser/inbox`, { headers: { cookie: `${BROWSER_COOKIE_NAME}=bogus` } })).status).toBe(401);
      const register = await hub.workerPost('/api/worker/register', snapshotOf('w-p1', [{ sessionId: 's1' }]));
      expect(register.status).toBe(200);
      const workerStream = await hub.openWorkerStream('w-p1');
      await waitForLines(workerStream, 1, 'worker stream open');
      expect((await hub.browserFetch('/api/browser/threads/missing')).status).toBe(404);
      const onlineDelete = await hub.browserFetch('/api/browser/threads/s1', { method: 'DELETE' });
      expect(onlineDelete.status).toBe(409);
      expect(await onlineDelete.text()).toContain('refused-online');
      workerStream.close();
      await waitUntil(async () => {
        const thread = await hub.browserFetch('/api/browser/threads/s1');
        const body = (await thread.json()) as { online: boolean };
        return !body.online;
      }, 'thread offline');
      const offlineDelete = await hub.browserFetch('/api/browser/threads/s1', { method: 'DELETE' });
      expect(offlineDelete.status).toBe(204);
      expect((await hub.browserFetch('/api/browser/threads/s1')).status).toBe(404);

      const devices = await hub.browserFetch('/api/browser/devices');
      expect(devices.status).toBe(200);
      const deviceList = (await devices.json()) as { tokenId: string; role: string }[];
      expect(deviceList).toHaveLength(2);
      for (const record of deviceList) expect(record).not.toHaveProperty('hash');
      const victim = deviceList.find((record) => record.role === 'device')!;
      const revoke = await hub.browserFetch(`/api/browser/tokens/${victim.tokenId}`, { method: 'DELETE' });
      expect(revoke.status).toBe(204);
      expect((await hub.browserFetch('/api/browser/inbox')).status).toBe(401);
      expect((await fetch(`${hub.baseUrl}/api/browser/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: hub.deviceSecret }),
      })).status).toBe(401);
    } finally {
      await hub.close();
    }
  });

  it('logout clears the cookie', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const hub = await startBrowserHarness();
    try {
      const logout = await hub.browserFetch('/api/browser/logout', { method: 'POST' });
      expect(logout.status).toBe(204);
      const setCookie = logout.headers.get('set-cookie') ?? '';
      expect(setCookie.startsWith(`${BROWSER_COOKIE_NAME}=;`)).toBe(true);
      expect(setCookie).toContain('Max-Age=0');
    } finally {
      await hub.close();
    }
  });

  it('browser stream heartbeat is injectable and carries X-Accel-Buffering: no', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const hub = await startBrowserHarness(['--heartbeat-interval-ms', '100']);
    try {
      const res = await fetch(`${hub.baseUrl}/api/browser/stream`, {
        headers: { cookie: `${BROWSER_COOKIE_NAME}=${hub.deviceSecret}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-accel-buffering')).toBe('no');
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !text.includes(': hb')) {
        const read = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => {
              reject(new Error('timeout'));
            }, 2000).unref?.();
          }),
        ]);
        if (read.done) break;
        text += decoder.decode(read.value, { stream: true });
      }
      void reader.cancel().catch(() => {});
      expect(text).toContain(': connected');
      expect(text).toContain(': hb');
    } finally {
      await hub.close();
    }
  });

  it('bearer device tokens also pass the browser face and machine tokens are rejected', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const hub = await startBrowserHarness();
    try {
      const bearer = await fetch(`${hub.baseUrl}/api/browser/inbox`, {
        headers: { authorization: `Bearer ${hub.deviceSecret}` },
      });
      expect(bearer.status).toBe(200);
      const machine = await fetch(`${hub.baseUrl}/api/browser/inbox`, {
        headers: { authorization: `Bearer ${hub.machineSecret}` },
      });
      expect(machine.status).toBe(403);
      const stream = await hub.openBrowserStream();
      await waitForLines(stream, 1, 'browser stream open');
      stream.close();
    } finally {
      await hub.close();
    }
  });

  it('revoking a device token closes its registered stream synchronously', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const hub = await startBrowserHarness();
    try {
      const stream = await hub.openBrowserStream();
      await waitForLines(stream, 1, 'browser stream open');
      const devices = await hub.browserFetch('/api/browser/devices');
      const deviceList = (await devices.json()) as { tokenId: string; role: string }[];
      const victim = deviceList.find((record) => record.role === 'device')!;
      const revoke = await hub.browserFetch(`/api/browser/tokens/${victim.tokenId}`, { method: 'DELETE' });
      expect(revoke.status).toBe(204);
      await Promise.race([
        stream.closed,
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error('timeout waiting for stream close'));
          }, 5000).unref?.();
        }),
      ]);
    } finally {
      await hub.close();
    }
  });
});

describe('hub admin face and CLI (K5/M3)', () => {
  let clock: number;

  function overviewOf(rev: number): Overview {
    return {
      rev,
      phase: 'idle',
      isCompacting: false,
      model: 'kimi',
      thinkingEffort: 'high',
      permissionMode: 'default',
      planMode: false,
      contextUsage: 0,
      goal: null,
      todos: [],
      subagents: [],
      backgroundTasks: [],
      models: [],
      lastLine: '',
      sampledAt: clock,
    };
  }

  function descriptorOf(sessionId: string, capabilities: OpType[] = ['approve', 'send', 'end-session']): Descriptor {
    return {
      sessionId,
      machine: { tokenName: 'worker-reported-name', hostname: 'host-1' },
      project: 'proj',
      title: 't',
      kind: 'interactive',
      capabilities,
    };
  }

  function snapshotOf(
    workerId: string,
    threads: { sessionId: string }[],
    recentReceipts: ReceiptReport[] = [],
  ): WorkerSnapshot {
    return {
      workerId,
      threads: threads.map((thread) => ({
        descriptor: descriptorOf(thread.sessionId),
        overview: overviewOf(1),
        timeline: [],
        openCards: [],
      })),
      recentReceipts,
    };
  }

  beforeEach(() => {
    clock = 1000;
  });

  interface SseStream {
    lines: string[];
    close(): void;
    closed: Promise<void>;
  }

  async function openSse(url: string, headers: Record<string, string>): Promise<SseStream> {
    const res = await fetch(url, { headers });
    if (res.status !== 200 || res.body === null) throw new Error(`stream failed: ${res.status}`);
    const lines: string[] = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let closedResolve: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      closedResolve = resolve;
    });
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          lines.push(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
      }
      closedResolve();
    })();
    void pump.catch(() => {
      closedResolve();
    });
    return {
      lines,
      close() {
        void reader.cancel().catch(() => {});
      },
      closed,
    };
  }

  async function waitUntil(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  }

  async function waitForLines(stream: SseStream, count: number, label: string): Promise<void> {
    await waitUntil(() => stream.lines.length >= count, label);
  }

  interface CliResult {
    code: number | null;
    stdout: string;
    stderr: string;
  }

  function runCli(args: string[]): Promise<CliResult> {
    const child = spawn(process.execPath, [HUB_MJS, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    return new Promise((resolve, reject) => {
      child.once('exit', (code) => {
        resolve({ code, stdout, stderr });
      });
      setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`CLI did not exit: hub ${args.join(' ')}`));
      }, 8000).unref?.();
    });
  }

  async function startCliHarness(extraServeArgs: string[] = []): Promise<{
    baseUrl: string;
    machineSecret: string;
    deviceSecret: string;
    adminKey: string;
    cli(args: string[]): Promise<CliResult>;
    workerPost(path: string, body: unknown): Promise<Response>;
    stop(): Promise<void>;
  }> {
    const { machineSecret, deviceSecret } = await issueHttpTokens();
    const adminKey = readOrGenerateAdminKey(dataDir);
    if (!adminKey.ok) throw new Error('admin key missing');
    const { child, baseUrl } = await startServeHub(extraServeArgs);
    const cli = (args: string[]) => runCli([...args, '--data-dir', dataDir]);
    const workerPost = (path: string, body: unknown) =>
      fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${machineSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const stop = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      await new Promise<void>((resolve) => {
        child.once('exit', () => {
          resolve();
        });
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5000).unref?.();
      });
    };
    return { baseUrl, machineSecret, deviceSecret, adminKey: adminKey.key, cli, workerPost, stop };
  }

  it('K5-A1: CLI-issued device secret can log in and machine secret can register', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const hub = await startCliHarness();
    try {
      const issueDevice = await hub.cli(['token', 'issue', 'device', 'd1']);
      expect(issueDevice.code).toBe(0);
      const deviceSecret = /^secret: (\S+)$/m.exec(issueDevice.stdout)?.[1];
      expect(deviceSecret).toBeTruthy();
      const login = await fetch(`${hub.baseUrl}/api/browser/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: deviceSecret }),
      });
      expect(login.status).toBe(204);

      const issueMachine = await hub.cli(['token', 'issue', 'machine', 'm1']);
      expect(issueMachine.code).toBe(0);
      const machineSecret = /^secret: (\S+)$/m.exec(issueMachine.stdout)?.[1];
      expect(machineSecret).toBeTruthy();
      const register = await fetch(`${hub.baseUrl}/api/worker/register`, {
        method: 'POST',
        headers: { authorization: `Bearer ${machineSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify(snapshotOf('w-k5', [{ sessionId: 's1' }])),
      });
      expect(register.status).toBe(200);
      expect((await register.json()) as { threads: { accepted: boolean }[] }).toEqual({
        workerId: 'w-k5',
        threads: [{ sessionId: 's1', accepted: true }],
      });
    } finally {
      await hub.stop();
    }
  });

  it('K5-A2: token subcommands fail with a clear error when the hub is not running', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const otherDir = join(tmpdir(), `forum-link-hub-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const result = await runCli(['token', 'list', '--data-dir', otherDir]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('hub serve');
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('K5: admin face serves issue, list, and revoke', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const hub = await startCliHarness();
    try {
      const headers = { authorization: `Bearer ${hub.adminKey}`, 'content-type': 'application/json' };
      const badBody = await fetch(`${hub.baseUrl}/api/admin/tokens`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ role: 'device' }),
      });
      expect(badBody.status).toBe(400);
      const duplicate = await fetch(`${hub.baseUrl}/api/admin/tokens`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ role: 'machine', name: 'laptop' }),
      });
      expect(duplicate.status).toBe(409);

      const issue = await fetch(`${hub.baseUrl}/api/admin/tokens`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ role: 'device', name: 'admin-issued' }),
      });
      expect(issue.status).toBe(200);
      const issued = (await issue.json()) as { tokenId: string; secret: string };
      expect(issued.secret.length).toBeGreaterThanOrEqual(32);

      const list = await fetch(`${hub.baseUrl}/api/admin/tokens`, { headers: { authorization: `Bearer ${hub.adminKey}` } });
      expect(list.status).toBe(200);
      const records = (await list.json()) as { tokenId: string; name: string; role: string }[];
      expect(records.some((record) => record.tokenId === issued.tokenId && record.name === 'admin-issued')).toBe(true);
      for (const record of records) expect(record).not.toHaveProperty('hash');

      const revoke = await fetch(`${hub.baseUrl}/api/admin/tokens/${issued.tokenId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${hub.adminKey}` },
      });
      expect(revoke.status).toBe(204);
      const login = await fetch(`${hub.baseUrl}/api/browser/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: issued.secret }),
      });
      expect(login.status).toBe(401);
    } finally {
      await hub.stop();
    }
  });

  it('M3-A1 + G-A5: revoking device 2 closes its stream, 401s its next request, and keeps device 1 streaming', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const { deviceSecret } = await issueHttpTokens();
    const adminKey = readOrGenerateAdminKey(dataDir);
    if (!adminKey.ok) throw new Error('admin key missing');
    const { child, baseUrl } = await startServeHub();
    try {
      const secondIssue = await fetch(`${baseUrl}/api/admin/tokens`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminKey.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'device', name: 'phone-2' }),
      });
      expect(secondIssue.status).toBe(200);
      const second = (await secondIssue.json()) as { tokenId: string; secret: string };

      const cookie1 = `${BROWSER_COOKIE_NAME}=${deviceSecret}`;
      const cookie2 = `${BROWSER_COOKIE_NAME}=${second.secret}`;
      const openBrowserStream = (cookie: string) => openSse(`${baseUrl}/api/browser/stream`, { cookie });
      const browserFetch = (cookie: string, path: string) => fetch(`${baseUrl}${path}`, { headers: { cookie } });

      const stream1 = await openBrowserStream(cookie1);
      await waitForLines(stream1, 1, 'device 1 stream open');
      const stream2 = await openBrowserStream(cookie2);
      await waitForLines(stream2, 1, 'device 2 stream open');

      const revoke = await fetch(`${baseUrl}/api/admin/tokens/${second.tokenId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${adminKey.key}` },
      });
      expect(revoke.status).toBe(204);

      await Promise.race([
        stream2.closed,
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error('timeout waiting for revoked stream close'));
          }, 5000);
        }),
      ]);
      expect((await browserFetch(cookie2, '/api/browser/inbox')).status).toBe(401);
      expect((await browserFetch(cookie1, '/api/browser/inbox')).status).toBe(200);
      expect(stream1.lines.length).toBeGreaterThan(0);
      stream1.close();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await new Promise<void>((resolve) => {
        child.once('exit', () => {
          resolve();
        });
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5000).unref?.();
      });
    }
  });

  it('M3-A1 via CLI: hub token revoke closes the revoked device stream', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const hub = await startCliHarness();
    try {
      const issue = await hub.cli(['token', 'issue', 'device', 'phone-2']);
      expect(issue.code).toBe(0);
      const secret = /^secret: (\S+)$/m.exec(issue.stdout)?.[1];
      expect(secret).toBeTruthy();
      const list = await hub.cli(['token', 'list']);
      expect(list.code).toBe(0);
      const tokenId = /^\S+\tdevice\tphone-2\t/m.exec(list.stdout)?.[0]?.split('\t')[0];
      expect(tokenId).toBeTruthy();

      const stream = await openSse(`${hub.baseUrl}/api/browser/stream`, { cookie: `${BROWSER_COOKIE_NAME}=${secret}` });
      await waitForLines(stream, 1, 'device 2 stream open');
      const revoke = await hub.cli(['token', 'revoke', tokenId!]);
      expect(revoke.code).toBe(0);
      expect(revoke.stdout).toContain('revoked');
      await Promise.race([
        stream.closed,
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error('timeout waiting for revoked stream close'));
          }, 5000);
        }),
      ]);
    } finally {
      await hub.stop();
    }
  });

  it('M3-A2: a persistence failure returns an error and leaves the token valid', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const { machineSecret, deviceSecret } = await issueHttpTokens();
    const hub = createHubServer({ dataDir });
    const baseUrl = await new Promise<string>((resolve) => {
      hub.server.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(hub.server.address() as AddressInfo).port}`);
      });
    });
    try {
      const originalRevoke = hub.tokens.revoke.bind(hub.tokens);
      hub.tokens.revoke = async (tokenId: string) => {
        void originalRevoke;
        void tokenId;
        return { ok: false, error: new Error('injected persist failure') };
      };
      const list = await fetch(`${baseUrl}/api/browser/devices`, {
        headers: { cookie: `${BROWSER_COOKIE_NAME}=${deviceSecret}` },
      });
      const records = (await list.json()) as { tokenId: string; role: string }[];
      const victim = records.find((record) => record.role === 'device')!;
      const revoke = await fetch(`${baseUrl}/api/browser/tokens/${victim.tokenId}`, {
        method: 'DELETE',
        headers: { cookie: `${BROWSER_COOKIE_NAME}=${deviceSecret}` },
      });
      expect(revoke.status).toBe(500);
      expect((await fetch(`${baseUrl}/api/browser/inbox`, { headers: { cookie: `${BROWSER_COOKIE_NAME}=${deviceSecret}` } })).status).toBe(200);
      const register = await fetch(`${baseUrl}/api/worker/register`, {
        method: 'POST',
        headers: { authorization: `Bearer ${machineSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify(snapshotOf('w-m3a2', [{ sessionId: 's1' }])),
      });
      expect(register.status).toBe(200);
      expect(hub.tokens.lookup(deviceSecret)).toBeDefined();
    } finally {
      await hub.close();
    }
  });

  it('M3-A3: revoking a machine token removes its threads and 401s later requests', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const hub = await startCliHarness();
    try {
      const register = await hub.workerPost('/api/worker/register', snapshotOf('w-m3a3', [{ sessionId: 's1' }]));
      expect(register.status).toBe(200);
      const workerStream = await openSse(`${hub.baseUrl}/api/worker/stream?workerId=w-m3a3`, {
        authorization: `Bearer ${hub.machineSecret}`,
      });
      await waitForLines(workerStream, 1, 'worker stream open');
      const ops = await fetch(`${hub.baseUrl}/api/browser/ops`, {
        method: 'POST',
        headers: { cookie: `${BROWSER_COOKIE_NAME}=${hub.deviceSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', intent: { type: 'send', sessionId: 's1', text: 'hi' } }),
      });
      expect(ops.status).toBe(202);
      const receipt = (await ops.json()) as { opId: string; state: string };
      expect(receipt.state).toBe('accepted');

      const list = await hub.cli(['token', 'list']);
      expect(list.code).toBe(0);
      const tokenId = /^\S+\tmachine\tlaptop\t/m.exec(list.stdout)?.[0]?.split('\t')[0];
      expect(tokenId).toBeTruthy();
      const revoke = await hub.cli(['token', 'revoke', tokenId!]);
      expect(revoke.code).toBe(0);

      await waitUntil(async () => {
        const inbox = await fetch(`${hub.baseUrl}/api/browser/inbox`, {
          headers: { cookie: `${BROWSER_COOKIE_NAME}=${hub.deviceSecret}` },
        });
        const body = (await inbox.json()) as { threads: { descriptor: { sessionId: string } }[] };
        return !body.threads.some((thread) => thread.descriptor.sessionId === 's1');
      }, 'thread removal');
      const later = await fetch(`${hub.baseUrl}/api/worker/register`, {
        method: 'POST',
        headers: { authorization: `Bearer ${hub.machineSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify(snapshotOf('w-m3a3', [{ sessionId: 's2' }])),
      });
      expect(later.status).toBe(401);
      await Promise.race([
        workerStream.closed,
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error('timeout waiting for revoked worker stream close'));
          }, 5000);
        }),
      ]);
    } finally {
      await hub.stop();
    }
  });

  it('M3-A3 receipts: a pending receipt for the revoked machine becomes lost machine-revoked', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const hub = await startCliHarness();
    try {
      const register = await hub.workerPost('/api/worker/register', snapshotOf('w-m3r', [{ sessionId: 's1' }]));
      expect(register.status).toBe(200);
      const ops = await fetch(`${hub.baseUrl}/api/browser/ops`, {
        method: 'POST',
        headers: { cookie: `${BROWSER_COOKIE_NAME}=${hub.deviceSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', intent: { type: 'send', sessionId: 's1', text: 'hi' } }),
      });
      expect(ops.status).toBe(202);
      const receipt = (await ops.json()) as { opId: string };
      expect(receipt.opId).toBeTruthy();

      const list = await hub.cli(['token', 'list']);
      const tokenId = /^\S+\tmachine\tlaptop\t/m.exec(list.stdout)?.[0]?.split('\t')[0];
      const revoke = await hub.cli(['token', 'revoke', tokenId!]);
      expect(revoke.code).toBe(0);

      await waitUntil(async () => {
        const login = await fetch(`${hub.baseUrl}/api/browser/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: hub.deviceSecret }),
        });
        return login.status === 204;
      }, 'device login recovers from rate limit window');
      const thread = await fetch(`${hub.baseUrl}/api/browser/threads/s1`, {
        headers: { cookie: `${BROWSER_COOKIE_NAME}=${hub.deviceSecret}` },
      });
      expect(thread.status).toBe(404);
    } finally {
      await hub.stop();
    }
  });

  it('K5-Artifacts: serve honors --bind, --port, --data-dir, --trusted-proxy, and --heartbeat-interval-ms', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const portHolder = createNetServer();
    const port = await new Promise<number>((resolve) => {
      portHolder.listen(0, '127.0.0.1', () => {
        resolve((portHolder.address() as AddressInfo).port);
      });
    });
    await new Promise<void>((resolve) => {
      portHolder.close(() => {
        resolve();
      });
    });
    const { machineSecret } = await issueHttpTokens();
    const { child, baseUrl } = await startServeHub([
      '--bind', '127.0.0.1',
      '--port', String(port),
      '--trusted-proxy', '10.0.0.2',
      '--heartbeat-interval-ms', '100',
    ]);
    try {
      expect(baseUrl).toBe(`http://127.0.0.1:${port}`);
      expect(readFileSync(join(dataDir, 'hub.port'), 'utf8').trim()).toBe(String(port));
      const trusted = await fetch(`${baseUrl}/api/worker/register`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${machineSecret}`,
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.9, 10.0.0.2',
        },
        body: JSON.stringify(snapshotOf('w-tp', [{ sessionId: 's1' }])),
      });
      expect(trusted.status).toBe(200);
      const streamRegister = await fetch(`${baseUrl}/api/worker/register`, {
        method: 'POST',
        headers: { authorization: `Bearer ${machineSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify(snapshotOf('w-hb', [{ sessionId: 's1' }])),
      });
      expect(streamRegister.status).toBe(200);
      const res = await fetch(`${baseUrl}/api/worker/stream?workerId=w-hb`, {
        headers: { authorization: `Bearer ${machineSecret}` },
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !text.includes(': hb')) {
        const read = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => {
              reject(new Error('timeout'));
            }, 2000).unref?.();
          }),
        ]);
        if (read.done) break;
        text += decoder.decode(read.value, { stream: true });
      }
      void reader.cancel().catch(() => {});
      expect(text).toContain(': hb');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await new Promise<void>((resolve) => {
        child.once('exit', () => {
          resolve();
        });
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5000).unref?.();
      });
    }
  });
});

describe('hub notifier and hub logs (K6/K7)', () => {
  let clock: number;

  function overviewOf(rev: number): Overview {
    return {
      rev,
      phase: 'idle',
      isCompacting: false,
      model: 'kimi',
      thinkingEffort: 'high',
      permissionMode: 'default',
      planMode: false,
      contextUsage: 0,
      goal: null,
      todos: [],
      subagents: [],
      backgroundTasks: [],
      models: [],
      lastLine: '',
      sampledAt: clock,
    };
  }

  function descriptorOf(sessionId: string): Descriptor {
    return {
      sessionId,
      machine: { tokenName: 'worker-reported-name', hostname: 'host-1' },
      project: 'my-secret-project',
      title: 'Secret title for K6-A2',
      kind: 'interactive',
      capabilities: ['approve', 'send'],
    };
  }

  function cardOf(cardId: string): Card {
    return {
      cardId,
      kind: 'approval',
      openedAt: clock,
      approval: {
        id: cardId,
        command: 'rm -rf SECRET_COMMAND_TOKEN',
        toolName: 'SECRET_TOOL_NAME',
        project: 'my-secret-project',
        cwd: '/SECRET_WORKING_DIRECTORY',
      },
    };
  }

  function entryOf(seq: number): TimelineEntry {
    return { seq, at: clock, kind: 'user-message', text: `m${seq}` };
  }

  function snapshotOf(
    workerId: string,
    threads: { sessionId: string; timeline?: TimelineEntry[]; openCards?: Card[] }[],
  ): WorkerSnapshot {
    return {
      workerId,
      threads: threads.map((thread) => ({
        descriptor: descriptorOf(thread.sessionId),
        overview: overviewOf(1),
        timeline: thread.timeline ?? [],
        openCards: thread.openCards ?? [],
      })),
      recentReceipts: [],
    };
  }

  beforeEach(() => {
    clock = 1000;
  });

  interface NtfyRequest {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }

  interface FakeNtfy {
    baseUrl: string;
    requests: NtfyRequest[];
    fail: boolean;
    stop(): Promise<void>;
  }

  function startFakeNtfy(): Promise<FakeNtfy> {
    const ntfy: FakeNtfy = {
      baseUrl: '',
      requests: [],
      fail: false,
      stop: () => Promise.resolve(),
    };
    const server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        ntfy.requests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: { ...req.headers },
          body: Buffer.concat(chunks).toString('utf8'),
        });
        if (ntfy.fail) {
          res.writeHead(500);
          res.end();
          return;
        }
        res.writeHead(200);
        res.end();
      });
    });
    ntfy.stop = () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    return new Promise<FakeNtfy>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        ntfy.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve(ntfy);
      });
    });
  }

  interface HubHandle {
    child: ChildProcess;
    baseUrl: string;
    stdout: string;
    stderr: string;
    machineSecret: string;
    stop(): Promise<void>;
  }

  function startLoggedHub(extraArgs: string[], secrets: { machineSecret: string }): HubHandle {
    const child = spawn(process.execPath, [HUB_MJS, 'serve', '--data-dir', dataDir, '--port', '0', ...extraArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const handle: HubHandle = {
      child,
      baseUrl: '',
      stdout: '',
      stderr: '',
      machineSecret: secrets.machineSecret,
      stop: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill();
        await new Promise<void>((resolve) => {
          child.once('exit', () => {
            resolve();
          });
          setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 5000).unref?.();
        });
      },
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      handle.stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      handle.stderr += chunk;
    });
    return handle;
  }

  async function waitForStart(handle: HubHandle): Promise<void> {
    const deadline = Date.now() + 8000;
    for (;;) {
      const match = /listening on http:\/\/\S+:(\d+)/.exec(handle.stdout);
      if (match !== null) {
        handle.baseUrl = `http://127.0.0.1:${match[1]}`;
        return;
      }
      if (handle.child.exitCode !== null || Date.now() > deadline) {
        await handle.stop();
        throw new Error(`hub failed to start: ${handle.stdout}${handle.stderr}`);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
  }

  function waitFor<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error(`timeout waiting for ${label}`));
        }, ms).unref?.();
      }),
    ]);
  }

  async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
      await new Promise((resolve) => {
        setTimeout(resolve, 10).unref?.();
      });
    }
  }

  function workerPost(baseUrl: string, machineSecret: string, path: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${machineSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('K6-A1: the same card notifies once across re-registration and hub restart', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const ntfy = await startFakeNtfy();
    try {
      const { machineSecret } = await issueHttpTokens();
      const hub = startLoggedHub(['--ntfy-url', ntfy.baseUrl, '--ntfy-topic', 'k6'], { machineSecret });
      try {
        await waitForStart(hub);
        const register = await workerPost(hub.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w1', [{ sessionId: 's1', openCards: [cardOf('approval_1')] }]));
        expect(register.status).toBe(200);
        await waitUntil(() => ntfy.requests.length > 0, 'first notification');
        expect(ntfy.requests).toHaveLength(1);
        expect(ntfy.requests[0]!.url).toBe('/k6');

        const reregister = await workerPost(hub.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w1', [{ sessionId: 's1', openCards: [cardOf('approval_1')] }]));
        expect(reregister.status).toBe(200);
        await new Promise((resolve) => {
          setTimeout(resolve, 200);
        });
        expect(ntfy.requests).toHaveLength(1);
        await waitUntil(() => {
          if (!existsSync(join(dataDir, 'state.json'))) return false;
          const persisted = readStateFile();
          return persisted.threads.length === 1 && persisted.threads[0]!.openCards.length === 1;
        }, 'open card persisted before restart');
      } finally {
        await hub.stop();
      }

      const restarted = startLoggedHub(['--ntfy-url', ntfy.baseUrl, '--ntfy-topic', 'k6'], { machineSecret });
      try {
        await waitForStart(restarted);
        const register = await workerPost(restarted.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w1', [{ sessionId: 's1', openCards: [cardOf('approval_1')] }]));
        expect(register.status).toBe(200);
        await new Promise((resolve) => {
          setTimeout(resolve, 200);
        });
        expect(ntfy.requests).toHaveLength(1);

        const newCard = await workerPost(restarted.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w1', [{ sessionId: 's1', openCards: [cardOf('approval_1'), cardOf('approval_2')] }]));
        expect(newCard.status).toBe(200);
        await waitUntil(() => ntfy.requests.length >= 2, 'notification for the new card');
        expect(ntfy.requests).toHaveLength(2);
        expect(ntfy.requests[1]!.url).toBe('/k6');
      } finally {
        await restarted.stop();
      }
    } finally {
      await ntfy.stop();
    }
  });

  it('K6-A2: the notification body and headers carry no payload fields and the Click header is a well-formed deep link', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const ntfy = await startFakeNtfy();
    try {
      const { machineSecret } = await issueHttpTokens();
      const hub = startLoggedHub(
        ['--ntfy-url', ntfy.baseUrl, '--ntfy-topic', 'k6b', '--ntfy-token', 'SECRET-NTFY-TOKEN', '--public-url', 'https://hub.example.test'],
        { machineSecret },
      );
      try {
        await waitForStart(hub);
        const register = await workerPost(hub.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w1', [{ sessionId: 's1', openCards: [cardOf('approval_1')] }]));
        expect(register.status).toBe(200);
        await waitUntil(() => ntfy.requests.length > 0, 'notification');
        const request = ntfy.requests[0]!;
        expect(request.method).toBe('POST');
        expect(request.url).toBe('/k6b');
        expect(request.headers['authorization']).toBe('Bearer SECRET-NTFY-TOKEN');
        expect(request.headers['click']).toBe('https://hub.example.test/#/thread/s1?card=approval_1');
        expect(request.headers['priority']).toBeDefined();
        const forbidden = ['SECRET_COMMAND_TOKEN', 'SECRET_TOOL_NAME', 'my-secret-project', 'SECRET_WORKING_DIRECTORY', 'Secret title for K6-A2'];
        for (const header of ['click', 'title', 'priority']) {
          const value = request.headers[header];
          if (value === undefined) continue;
          for (const marker of forbidden) {
            expect(String(value), `header ${header}`).not.toContain(marker);
          }
        }
        for (const marker of [...forbidden, 'approval_1']) {
          expect(request.body, `body marker ${marker}`).not.toContain(marker);
        }
        expect(request.body.length).toBeGreaterThan(0);
        expect(request.body.length).toBeLessThan(200);
      } finally {
        await hub.stop();
      }
    } finally {
      await ntfy.stop();
    }
  });

  it('K6-A3: no ntfy configuration produces zero requests', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const ntfy = await startFakeNtfy();
    try {
      const { machineSecret } = await issueHttpTokens();
      const hub = startLoggedHub([], { machineSecret });
      try {
        await waitForStart(hub);
        const register = await workerPost(hub.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w1', [{ sessionId: 's1', openCards: [cardOf('approval_1'), cardOf('approval_2')] }]));
        expect(register.status).toBe(200);
        const register2 = await workerPost(hub.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w1', [{ sessionId: 's1', openCards: [cardOf('approval_1'), cardOf('approval_2'), cardOf('approval_3')] }]));
        expect(register2.status).toBe(200);
        await new Promise((resolve) => {
          setTimeout(resolve, 200);
        });
        expect(ntfy.requests).toHaveLength(0);
      } finally {
        await hub.stop();
      }
    } finally {
      await ntfy.stop();
    }
  });

  it('K6-Contract: a notification failure writes one stderr log line and does not retry', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const ntfy = await startFakeNtfy();
    ntfy.fail = true;
    try {
      const { machineSecret } = await issueHttpTokens();
      const hub = startLoggedHub(['--ntfy-url', ntfy.baseUrl, '--ntfy-topic', 'k6c'], { machineSecret });
      try {
        await waitForStart(hub);
        const register = await workerPost(hub.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w1', [{ sessionId: 's1', openCards: [cardOf('approval_1')] }]));
        expect(register.status).toBe(200);
        await waitUntil(() => ntfy.requests.length > 0, 'first ntfy attempt');
        await waitUntil(() => hub.stderr.includes('notify-failed'), 'notify-failed log line');
        await new Promise((resolve) => {
          setTimeout(resolve, 400);
        });
        expect(ntfy.requests).toHaveLength(1);
        const lines = hub.stderr
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        expect(lines).toEqual(['forum-link: notify-failed: ntfy responded 500 for card approval_1']);
      } finally {
        await hub.stop();
      }
    } finally {
      await ntfy.stop();
    }
  });

  it('K7-A1: owner conflicts and sequence gaps each write one single-line stderr log', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const { machineSecret, deviceSecret } = await issueHttpTokens();
    const adminKey = readOrGenerateAdminKey(dataDir);
    if (!adminKey.ok) throw new Error('admin key missing');
    const hub = startLoggedHub([], { machineSecret });
    try {
      await waitForStart(hub);
      const register = await workerPost(hub.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w1', [{ sessionId: 's1' }]));
      expect(register.status).toBe(200);
      const secondIssue = await fetch(`${hub.baseUrl}/api/admin/tokens`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminKey.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'machine', name: 'other-laptop' }),
      });
      expect(secondIssue.status).toBe(200);
      const second = (await secondIssue.json()) as { secret: string };
      const conflict = await fetch(`${hub.baseUrl}/api/worker/register`, {
        method: 'POST',
        headers: { authorization: `Bearer ${second.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify(snapshotOf('w2', [{ sessionId: 's1' }])),
      });
      expect(conflict.status).toBe(200);
      expect(await conflict.json()).toMatchObject({ threads: [{ sessionId: 's1', accepted: false }] });
      await waitUntil(() => hub.stderr.includes('register-rejected'), 'register-rejected log line');
      expect(hub.stderr).toContain('owner mismatch');

      const gap = await workerPost(hub.baseUrl, machineSecret, '/api/worker/batch', {
        workerId: 'w1',
        frames: [{ sessionId: 's1', kind: 'timeline', entries: [entryOf(7)] }],
      });
      expect(gap.status).toBe(409);
      await waitUntil(() => hub.stderr.includes('batch-gap'), 'batch-gap log line');

      const deviceInbox = await fetch(`${hub.baseUrl}/api/browser/inbox`, {
        headers: { authorization: `Bearer ${deviceSecret}` },
      });
      expect(deviceInbox.status).toBe(200);
      const lines = hub.stderr
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^forum-link: register-rejected: register rejected thread s1: owner mismatch$/);
      expect(lines[1]).toMatch(/^forum-link: batch-gap: resync required for worker w1$/);
    } finally {
      await hub.stop();
    }
  });

  it('K7-A1: a store write failure writes one single-line stderr log', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const { machineSecret } = await issueHttpTokens();
    mkdirSync(join(dataDir, 'state.json.tmp'));
    const hub = startLoggedHub([], { machineSecret });
    try {
      await waitForStart(hub);
      const register = await workerPost(hub.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w1', [{ sessionId: 's1', openCards: [cardOf('approval_1')] }]));
      expect(register.status).toBe(200);
      await waitUntil(() => hub.stderr.includes('store-write-failed'), 'store-write-failed log line', 8000);
      const lines = hub.stderr
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^forum-link: store-write-failed: .+/);
      expect(lines[0]).not.toContain('\r');
    } finally {
      await hub.stop();
    }
  });

  it('K7-A1: a corrupted state.json makes serve refuse to start with one single-line stderr log', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    writeFileSync(join(dataDir, 'state.json'), '{"tokens": [broken', 'utf8');
    const hub = startLoggedHub([], { machineSecret: 'unused' });
    const exited = await waitFor(
      new Promise<{ code: number | null }>((resolve) => {
        hub.child.once('exit', (code) => {
          resolve({ code });
        });
      }),
      8000,
      'hub to exit',
    );
    expect(exited.code).not.toBe(0);
    const lines = hub.stderr
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^forum-link: start-refused: .+state\.json/);
    expect(readFileSync(join(dataDir, 'state.json'), 'utf8')).toBe('{"tokens": [broken');
  });

  it('restored threads come back offline with receipts and open cards intact', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const { machineSecret, deviceSecret } = await issueHttpTokens();
    const first = startLoggedHub([], { machineSecret });
    try {
      await waitForStart(first);
      const register = await workerPost(first.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w1', [{ sessionId: 's1', timeline: [entryOf(1)], openCards: [cardOf('approval_1')] }]));
      expect(register.status).toBe(200);
      const ops = await fetch(`${first.baseUrl}/api/browser/ops`, {
        method: 'POST',
        headers: { cookie: `${BROWSER_COOKIE_NAME}=${deviceSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', intent: { type: 'send', sessionId: 's1', text: 'hi' } }),
      });
      expect(ops.status).toBe(202);
      const receipt = (await ops.json()) as { opId: string };
      await waitUntil(() => {
        if (!existsSync(join(dataDir, 'state.json'))) return false;
        const persisted = readStateFile();
        return (
          persisted.threads.length === 1 &&
          persisted.threads[0]!.openCards.length === 1 &&
          persisted.receipts.some((entry) => entry.opId === receipt.opId)
        );
      }, 'thread and receipt persisted');
    } finally {
      await first.stop();
    }

    const second = startLoggedHub([], { machineSecret });
    try {
      await waitForStart(second);
      const inbox = await fetch(`${second.baseUrl}/api/browser/inbox`, {
        headers: { cookie: `${BROWSER_COOKIE_NAME}=${deviceSecret}` },
      });
      expect(inbox.status).toBe(200);
      const body = (await inbox.json()) as {
        threads: { descriptor: { sessionId: string }; online: boolean; openCards: { cardId: string }[] }[];
      };
      expect(body.threads).toHaveLength(1);
      expect(body.threads[0]!.descriptor.sessionId).toBe('s1');
      expect(body.threads[0]!.online).toBe(false);
      expect(body.threads[0]!.openCards.map((card) => card.cardId)).toEqual(['approval_1']);
      const thread = await fetch(`${second.baseUrl}/api/browser/threads/s1`, {
        headers: { cookie: `${BROWSER_COOKIE_NAME}=${deviceSecret}` },
      });
      const threadBody = (await thread.json()) as { receipts: { opId: string; state: string }[] };
      expect(threadBody.receipts).toHaveLength(1);
      expect(threadBody.receipts[0]!.state).toBe('accepted');
    } finally {
      await second.stop();
    }
  });
});

describe('hub e2e (layer 3 closure)', () => {
  let clock: number;

  function overviewOf(rev: number): Overview {
    return {
      rev,
      phase: 'idle',
      isCompacting: false,
      model: 'kimi',
      thinkingEffort: 'high',
      permissionMode: 'default',
      planMode: false,
      contextUsage: 0,
      goal: null,
      todos: [],
      subagents: [],
      backgroundTasks: [],
      models: [],
      lastLine: '',
      sampledAt: clock,
    };
  }

  function descriptorOf(sessionId: string, capabilities: OpType[] = ['approve', 'send', 'end-session']): Descriptor {
    return {
      sessionId,
      machine: { tokenName: 'worker-reported-name', hostname: 'host-1' },
      project: 'proj',
      title: 't',
      kind: 'interactive',
      capabilities,
    };
  }

  function cardOf(cardId: string): Card {
    return { cardId, kind: 'approval', openedAt: clock, approval: {} };
  }

  function entryOf(seq: number): TimelineEntry {
    return { seq, at: clock, kind: 'user-message', text: `m${seq}` };
  }

  function snapshotOf(
    workerId: string,
    threads: { sessionId: string; timeline?: TimelineEntry[]; openCards?: Card[] }[],
    recentReceipts: ReceiptReport[] = [],
  ): WorkerSnapshot {
    return {
      workerId,
      threads: threads.map((thread) => ({
        descriptor: descriptorOf(thread.sessionId),
        overview: overviewOf(1),
        timeline: thread.timeline ?? [],
        openCards: thread.openCards ?? [],
      })),
      recentReceipts,
    };
  }

  beforeEach(() => {
    clock = 1000;
  });

  interface SseStream {
    lines: string[];
    close(): void;
    closed: Promise<void>;
  }

  async function openSse(url: string, headers: Record<string, string>): Promise<SseStream> {
    const res = await fetch(url, { headers });
    if (res.status !== 200 || res.body === null) throw new Error(`stream failed: ${res.status}`);
    const lines: string[] = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let closedResolve: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      closedResolve = resolve;
    });
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          lines.push(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
      }
      closedResolve();
    })();
    void pump.catch(() => {
      closedResolve();
    });
    return {
      lines,
      close() {
        void reader.cancel().catch(() => {});
      },
      closed,
    };
  }

  function namedEventsOf(lines: readonly string[]): { event: string; data: unknown }[] {
    const events: { event: string; data: unknown }[] = [];
    for (let i = 0; i < lines.length - 1; i += 1) {
      if (!lines[i]!.startsWith('event: ')) continue;
      const dataLine = lines[i + 1]!;
      if (!dataLine.startsWith('data: ')) continue;
      events.push({ event: lines[i]!.slice(7), data: JSON.parse(dataLine.slice(6)) as unknown });
    }
    return events;
  }

  async function waitUntil(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
      await new Promise((resolve) => {
        setTimeout(resolve, 10).unref?.();
      });
    }
  }

  async function waitForLines(stream: SseStream, count: number, label: string): Promise<void> {
    await waitUntil(() => stream.lines.length >= count, label);
  }

  function waitFor<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error(`timeout waiting for ${label}`));
        }, ms).unref?.();
      }),
    ]);
  }

  interface NtfyRequest {
    method: string;
    url: string;
    body: string;
  }

  interface FakeNtfy {
    baseUrl: string;
    requests: NtfyRequest[];
    stop(): Promise<void>;
  }

  function startFakeNtfy(): Promise<FakeNtfy> {
    const ntfy: FakeNtfy = {
      baseUrl: '',
      requests: [],
      stop: () => Promise.resolve(),
    };
    const server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        ntfy.requests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(200);
        res.end();
      });
    });
    ntfy.stop = () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    return new Promise<FakeNtfy>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        ntfy.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve(ntfy);
      });
    });
  }

  interface HubHandle {
    child: ChildProcess;
    baseUrl: string;
    output: string;
    stop(): Promise<void>;
  }

  function spawnHub(extraArgs: string[]): HubHandle {
    const child = spawn(process.execPath, [HUB_MJS, 'serve', '--data-dir', dataDir, '--port', '0', ...extraArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const handle: HubHandle = {
      child,
      baseUrl: '',
      output: '',
      stop: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill();
        await new Promise<void>((resolve) => {
          child.once('exit', () => {
            resolve();
          });
          setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 5000).unref?.();
        });
      },
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      handle.output += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      handle.output += chunk;
    });
    return handle;
  }

  async function waitForStart(handle: HubHandle): Promise<void> {
    const deadline = Date.now() + 8000;
    for (;;) {
      const match = /listening on http:\/\/\S+:(\d+)/.exec(handle.output);
      if (match !== null) {
        handle.baseUrl = `http://127.0.0.1:${match[1]}`;
        return;
      }
      if (handle.child.exitCode !== null || Date.now() > deadline) {
        await handle.stop();
        throw new Error(`hub failed to start: ${handle.output}`);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
  }

  function waitForExit(handle: HubHandle): Promise<number | null> {
    return Promise.race([
      new Promise<number | null>((resolve) => {
        handle.child.once('exit', (code) => {
          resolve(code);
        });
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error('timeout waiting for hub exit'));
        }, 8000).unref?.();
      }),
    ]);
  }

  function workerPost(baseUrl: string, machineSecret: string, path: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${machineSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  interface GracefulHub extends HubHandle {
    shutdown(): void;
  }

  function spawnGracefulHub(extraArgs: string[]): GracefulHub {
    const child = spawn(process.execPath, [HUB_MJS, 'serve', '--data-dir', dataDir, '--port', '0', ...extraArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORUM_LINK_GRACEFUL_SHUTDOWN_STDIN: '1' },
    });
    const handle: GracefulHub = {
      child,
      baseUrl: '',
      output: '',
      stop: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill();
        await new Promise<void>((resolve) => {
          child.once('exit', () => {
            resolve();
          });
          setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 5000).unref?.();
        });
      },
      shutdown() {
        child.stdin?.end('shutdown\n');
      },
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      handle.output += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      handle.output += chunk;
    });
    return handle;
  }

  async function waitForGracefulExit(handle: GracefulHub): Promise<number | null> {
    return Promise.race([
      new Promise<number | null>((resolve) => {
        handle.child.once('exit', (code) => {
          resolve(code);
        });
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error('timeout waiting for graceful hub exit'));
        }, 8000).unref?.();
      }),
    ]);
  }

  interface ThreadView {
    online: boolean;
    timeline: TimelineEntry[];
    openCards: { cardId: string }[];
    receipts: { opId: string; state: string }[];
  }

  it('G-A9: the credential x face routing matrix allows only diagonal cells over real HTTP', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const { machineSecret, deviceSecret } = await issueHttpTokens();
    const adminKey = readOrGenerateAdminKey(dataDir);
    if (!adminKey.ok) throw new Error('admin key missing');
    const hub = spawnHub([]);
    try {
      await waitForStart(hub);
      const bearer = (secret: string | undefined): Record<string, string> =>
        secret === undefined ? {} : { authorization: `Bearer ${secret}` };
      const workerRegister = (headers: Record<string, string>, body: unknown = '{}') =>
        fetch(`${hub.baseUrl}/api/worker/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        });
      const inbox = (headers: Record<string, string>) => fetch(`${hub.baseUrl}/api/browser/inbox`, { headers });
      const adminTokens = (headers: Record<string, string>) => fetch(`${hub.baseUrl}/api/admin/tokens`, { headers });

      expect((await workerRegister(bearer(machineSecret), snapshotOf('w1', [{ sessionId: 's1' }]))).status).toBe(200);
      expect((await workerRegister(bearer(deviceSecret))).status).toBe(403);
      expect((await workerRegister(bearer(undefined))).status).toBe(401);
      expect((await workerRegister(bearer('not-a-real-secret'))).status).toBe(401);

      const cookie = { cookie: `${BROWSER_COOKIE_NAME}=${deviceSecret}` };
      expect((await inbox(cookie)).status).toBe(200);
      expect((await inbox(bearer(deviceSecret))).status).toBe(200);
      expect((await inbox(bearer(machineSecret))).status).toBe(403);
      expect((await inbox({})).status).toBe(401);
      expect((await inbox({ cookie: `${BROWSER_COOKIE_NAME}=${machineSecret}` })).status).toBe(401);

      expect((await adminTokens(bearer(adminKey.key))).status).toBe(200);
      expect((await adminTokens(bearer(machineSecret))).status).toBe(401);
      expect((await adminTokens(bearer(deviceSecret))).status).toBe(401);
      expect((await adminTokens({})).status).toBe(401);
      expect(
        (await adminTokens({ authorization: `Bearer ${adminKey.key}`, 'x-forwarded-for': '203.0.113.9' })).status,
      ).toBe(403);
    } finally {
      await hub.stop();
    }
  });

  it('G-A5: revoking device 2 mid-session closes its stream and 401s it while device 1 keeps streaming', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const { machineSecret, deviceSecret } = await issueHttpTokens();
    const adminKey = readOrGenerateAdminKey(dataDir);
    if (!adminKey.ok) throw new Error('admin key missing');
    const hub = spawnHub([]);
    try {
      await waitForStart(hub);
      const register = await workerPost(hub.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w1', [{ sessionId: 's1' }]));
      expect(register.status).toBe(200);
      const issue = await fetch(`${hub.baseUrl}/api/admin/tokens`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminKey.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'device', name: 'phone-2' }),
      });
      expect(issue.status).toBe(200);
      const second = (await issue.json()) as { tokenId: string; secret: string };

      const cookie1 = `${BROWSER_COOKIE_NAME}=${deviceSecret}`;
      const cookie2 = `${BROWSER_COOKIE_NAME}=${second.secret}`;
      const stream1 = await openSse(`${hub.baseUrl}/api/browser/stream`, { cookie: cookie1 });
      await waitForLines(stream1, 1, 'device 1 stream open');
      const stream2 = await openSse(`${hub.baseUrl}/api/browser/stream`, { cookie: cookie2 });
      await waitForLines(stream2, 1, 'device 2 stream open');

      const revoke = await fetch(`${hub.baseUrl}/api/admin/tokens/${second.tokenId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${adminKey.key}` },
      });
      expect(revoke.status).toBe(204);

      await waitFor(stream2.closed, 5000, 'revoked device 2 stream to close');
      expect((await fetch(`${hub.baseUrl}/api/browser/inbox`, { headers: { cookie: cookie2 } })).status).toBe(401);
      expect((await fetch(`${hub.baseUrl}/api/browser/inbox`, { headers: { cookie: cookie1 } })).status).toBe(200);

      const reregister = await workerPost(hub.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w1', [{ sessionId: 's1', openCards: [cardOf('approval_1')] }]));
      expect(reregister.status).toBe(200);
      await waitUntil(
        () => namedEventsOf(stream1.lines).some((event) => event.event === 'card.opened'),
        'device 1 stream still receives events after revocation',
      );
      stream1.close();
    } finally {
      await hub.stop();
    }
  });

  it('G-A4: hub restart restores open cards and receipts before re-registration and reconciles after', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const ntfy = await startFakeNtfy();
    try {
      const { machineSecret, deviceSecret } = await issueHttpTokens();
      const ntfyArgs = ['--ntfy-url', ntfy.baseUrl, '--ntfy-topic', 'ga4'];
      const cookie = `${BROWSER_COOKIE_NAME}=${deviceSecret}`;
      let receiptSummary: { opId: string; state: string } | undefined;
      let before: ThreadView | undefined;

      const first = spawnHub(ntfyArgs);
      try {
        await waitForStart(first);
        const register = await workerPost(first.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w1', [{ sessionId: 's1', timeline: [entryOf(1), entryOf(2)], openCards: [cardOf('approval_1')] }]));
        expect(register.status).toBe(200);
        await waitUntil(() => ntfy.requests.length === 1, 'first notification');

        const ops = await fetch(`${first.baseUrl}/api/browser/ops`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: 's1', intent: { type: 'send', sessionId: 's1', text: 'hi' } }),
        });
        expect(ops.status).toBe(202);
        const receipt = (await ops.json()) as { opId: string; state: string };
        expect(receipt.state).toBe('accepted');
        const receiptReport = await workerPost(first.baseUrl, machineSecret, '/api/worker/receipt', {
          workerId: 'w1',
          receipts: [{ opId: receipt.opId, state: 'delivered' }],
        });
        expect(receiptReport.status).toBe(204);
        receiptSummary = { opId: receipt.opId, state: 'delivered' };

        await waitUntil(() => {
          if (!existsSync(join(dataDir, 'state.json'))) return false;
          const persisted = readStateFile();
          return (
            persisted.threads.length === 1 &&
            persisted.threads[0]!.openCards.length === 1 &&
            persisted.receipts.length === 1 &&
            persisted.receipts[0]!.opId === receipt.opId &&
            persisted.receipts[0]!.state === 'delivered'
          );
        }, 'thread, card, and receipt persisted before kill');

        const thread = await fetch(`${first.baseUrl}/api/browser/threads/s1`, { headers: { cookie } });
        expect(thread.status).toBe(200);
        before = (await thread.json()) as ThreadView;
        expect(before.online).toBe(true);
      } finally {
        await first.stop();
      }

      const second = spawnHub(ntfyArgs);
      try {
        await waitForStart(second);
        const thread = await fetch(`${second.baseUrl}/api/browser/threads/s1`, { headers: { cookie } });
        expect(thread.status).toBe(200);
        const offline = (await thread.json()) as ThreadView;
        expect(offline.online).toBe(false);
        expect(offline.timeline).toEqual([]);
        expect(offline.openCards.map((card) => card.cardId)).toEqual(['approval_1']);
        expect(offline.receipts).toEqual([expect.objectContaining({ opId: receiptSummary.opId, state: 'delivered' })]);

        const reregister = await workerPost(second.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w1', [{ sessionId: 's1', timeline: [entryOf(1), entryOf(2)], openCards: [cardOf('approval_1')] }], [{ opId: receiptSummary.opId, state: 'delivered' }]));
        expect(reregister.status).toBe(200);
        expect(await reregister.json()).toEqual({ workerId: 'w1', threads: [{ sessionId: 's1', accepted: true }] });

        const after = (await (await fetch(`${second.baseUrl}/api/browser/threads/s1`, { headers: { cookie } })).json()) as ThreadView;
        expect(after.online).toBe(true);
        expect(after.timeline).toEqual(before.timeline);
        expect(after.openCards).toEqual(before.openCards);
        expect(after.receipts).toEqual(before.receipts);

        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });
        expect(ntfy.requests).toHaveLength(1);
      } finally {
        await second.stop();
      }
    } finally {
      await ntfy.stop();
    }
  });

  it('O2-A2: serve refuses to restart on a state.json corrupted after a healthy run', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const { machineSecret } = await issueHttpTokens();
    const hub = spawnHub([]);
    try {
      await waitForStart(hub);
      const register = await workerPost(hub.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w1', [{ sessionId: 's1', openCards: [cardOf('approval_1')] }]));
      expect(register.status).toBe(200);
      await waitUntil(() => existsSync(join(dataDir, 'state.json')), 'state.json written by the healthy run');
    } finally {
      await hub.stop();
    }
    const corrupted = '{"tokens": [broken';
    writeFileSync(join(dataDir, 'state.json'), corrupted, 'utf8');
    const revived = spawnHub([]);
    const code = await waitForExit(revived);
    expect(code).not.toBe(0);
    expect(revived.output).toContain('start-refused');
    expect(readFileSync(join(dataDir, 'state.json'), 'utf8')).toBe(corrupted);
  });

  it('P3-3.1: token X with a workerId owned by token Y gets unknown-worker-equivalent rejections and Y keeps streaming', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const { machineSecret, deviceSecret } = await issueHttpTokens();
    const adminKey = readOrGenerateAdminKey(dataDir);
    if (!adminKey.ok) throw new Error('admin key missing');
    const hub = spawnHub([]);
    try {
      await waitForStart(hub);
      const issue = await fetch(`${hub.baseUrl}/api/admin/tokens`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminKey.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'machine', name: 'other-laptop' }),
      });
      expect(issue.status).toBe(200);
      const other = (await issue.json()) as { secret: string };
      const yAuth = `Bearer ${machineSecret}`;
      const xAuth = `Bearer ${other.secret}`;
      const register = await fetch(`${hub.baseUrl}/api/worker/register`, {
        method: 'POST',
        headers: { authorization: yAuth, 'content-type': 'application/json' },
        body: JSON.stringify(snapshotOf('w-own', [{ sessionId: 's1', timeline: [entryOf(1)] }])),
      });
      expect(register.status).toBe(200);
      const yStream = await openSse(`${hub.baseUrl}/api/worker/stream?workerId=w-own`, { authorization: yAuth });
      await waitForLines(yStream, 1, 'Y stream open');

      const xBatch = await fetch(`${hub.baseUrl}/api/worker/batch`, {
        method: 'POST',
        headers: { authorization: xAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ workerId: 'w-own', frames: [{ sessionId: 's1', kind: 'timeline', entries: [entryOf(2)] }] }),
      });
      expect(xBatch.status).toBe(409);
      const xBatchBody = await xBatch.text();
      expect(xBatchBody).toContain('resync-required');
      const unknownBatch = await fetch(`${hub.baseUrl}/api/worker/batch`, {
        method: 'POST',
        headers: { authorization: xAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ workerId: 'w-unknown', frames: [{ sessionId: 's1', kind: 'timeline', entries: [entryOf(2)] }] }),
      });
      expect(unknownBatch.status).toBe(409);
      expect(await unknownBatch.text()).toBe(xBatchBody);

      const xReceipt = await fetch(`${hub.baseUrl}/api/worker/receipt`, {
        method: 'POST',
        headers: { authorization: xAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ workerId: 'w-own', receipts: [{ opId: 'op-x', state: 'delivered' }] }),
      });
      expect(xReceipt.status).toBe(204);
      const unknownReceipt = await fetch(`${hub.baseUrl}/api/worker/receipt`, {
        method: 'POST',
        headers: { authorization: xAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ workerId: 'w-unknown', receipts: [{ opId: 'op-x', state: 'delivered' }] }),
      });
      expect(unknownReceipt.status).toBe(204);

      const xUnregister = await fetch(`${hub.baseUrl}/api/worker/unregister`, {
        method: 'POST',
        headers: { authorization: xAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ workerId: 'w-own', finalReceipts: [] }),
      });
      expect(xUnregister.status).toBe(204);
      const unknownUnregister = await fetch(`${hub.baseUrl}/api/worker/unregister`, {
        method: 'POST',
        headers: { authorization: xAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ workerId: 'w-unknown', finalReceipts: [] }),
      });
      expect(unknownUnregister.status).toBe(204);

      const xStream = await fetch(`${hub.baseUrl}/api/worker/stream?workerId=w-own`, { headers: { authorization: xAuth } });
      expect(xStream.status).toBeGreaterThanOrEqual(400);
      const xStreamStatus = xStream.status;
      void xStream.body?.cancel().catch(() => {});
      const unknownStream = await fetch(`${hub.baseUrl}/api/worker/stream?workerId=w-unknown`, { headers: { authorization: xAuth } });
      expect(unknownStream.status).toBeGreaterThanOrEqual(400);
      expect(unknownStream.status).toBe(xStreamStatus);
      void unknownStream.body?.cancel().catch(() => {});

      const thread = await fetch(`${hub.baseUrl}/api/browser/threads/s1`, {
        headers: { cookie: `${BROWSER_COOKIE_NAME}=${deviceSecret}` },
      });
      expect(thread.status).toBe(200);
      const body = (await thread.json()) as { online: boolean; timeline: { seq: number }[] };
      expect(body.online).toBe(true);
      expect(body.timeline.map((entry) => entry.seq)).toEqual([1]);
      const stillLive = await Promise.race([
        waitForLines(yStream, 1, 'noop').then(() => true),
        yStream.closed.then(() => false),
      ]);
      expect(stillLive).toBe(true);
      yStream.close();
    } finally {
      await hub.stop();
    }
  });

  it('P3-3.3: token X cannot register a workerId owned by token Y', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const { machineSecret, deviceSecret } = await issueHttpTokens();
    const adminKey = readOrGenerateAdminKey(dataDir);
    if (!adminKey.ok) throw new Error('admin key missing');
    const hub = spawnHub([]);
    try {
      await waitForStart(hub);
      const issue = await fetch(`${hub.baseUrl}/api/admin/tokens`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminKey.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'machine', name: 'other-laptop' }),
      });
      expect(issue.status).toBe(200);
      const other = (await issue.json()) as { secret: string };
      const register = await workerPost(hub.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w-own', [{ sessionId: 's1' }]));
      expect(register.status).toBe(200);

      const xRegister = await fetch(`${hub.baseUrl}/api/worker/register`, {
        method: 'POST',
        headers: { authorization: `Bearer ${other.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify(snapshotOf('w-own', [{ sessionId: 's-x1' }, { sessionId: 's1' }])),
      });
      expect(xRegister.status).toBe(200);
      const xBody = (await xRegister.json()) as { threads: { accepted: boolean }[] };
      expect(xBody).toEqual({ workerId: 'w-own', threads: [{ sessionId: 's-x1', accepted: false }, { sessionId: 's1', accepted: false }] });
      const ownerMismatch = await fetch(`${hub.baseUrl}/api/worker/register`, {
        method: 'POST',
        headers: { authorization: `Bearer ${other.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify(snapshotOf('w-other', [{ sessionId: 's1' }])),
      });
      expect(ownerMismatch.status).toBe(200);
      expect(ownerMismatch.headers.get('content-type')).toBe(xRegister.headers.get('content-type'));
      const mismatchBody = (await ownerMismatch.json()) as { threads: { accepted: boolean }[] };
      expect(mismatchBody.threads.every((entry) => !entry.accepted)).toBe(true);

      const device = deviceSecret;
      const inbox = await fetch(`${hub.baseUrl}/api/browser/inbox`, { headers: { cookie: `${BROWSER_COOKIE_NAME}=${device}` } });
      const inboxBody = (await inbox.json()) as { threads: { descriptor: { sessionId: string } }[] };
      expect(inboxBody.threads.map((thread) => thread.descriptor.sessionId)).toEqual(['s1']);
    } finally {
      await hub.stop();
    }
  });

  it('P3-3.4: after the owner token is revoked, the workerId is treated as unowned', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const { machineSecret } = await issueHttpTokens();
    const adminKey = readOrGenerateAdminKey(dataDir);
    if (!adminKey.ok) throw new Error('admin key missing');
    const hub = spawnHub([]);
    try {
      await waitForStart(hub);
      const register = await workerPost(hub.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w-rev', [{ sessionId: 's1' }]));
      expect(register.status).toBe(200);
      const list = await fetch(`${hub.baseUrl}/api/admin/tokens`, { headers: { authorization: `Bearer ${adminKey.key}` } });
      const records = (await list.json()) as { tokenId: string; role: string; name: string }[];
      const victim = records.find((record) => record.role === 'machine' && record.name === 'laptop')!;
      const revoke = await fetch(`${hub.baseUrl}/api/admin/tokens/${victim.tokenId}`, { method: 'DELETE', headers: { authorization: `Bearer ${adminKey.key}` } });
      expect(revoke.status).toBe(204);
      const revokedCalls = await workerPost(hub.baseUrl, machineSecret, '/api/worker/batch', {
        workerId: 'w-rev',
        frames: [{ sessionId: 's1', kind: 'timeline', entries: [entryOf(1)] }],
      });
      expect(revokedCalls.status).toBe(401);
      const issue = await fetch(`${hub.baseUrl}/api/admin/tokens`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminKey.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'machine', name: 'replacement' }),
      });
      expect(issue.status).toBe(200);
      const replacement = (await issue.json()) as { secret: string };
      const reclaim = await fetch(`${hub.baseUrl}/api/worker/register`, {
        method: 'POST',
        headers: { authorization: `Bearer ${replacement.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify(snapshotOf('w-rev', [{ sessionId: 's1' }])),
      });
      expect(reclaim.status).toBe(200);
      expect(await reclaim.json()).toEqual({ workerId: 'w-rev', threads: [{ sessionId: 's1', accepted: true }] });
      const batch = await fetch(`${hub.baseUrl}/api/worker/batch`, {
        method: 'POST',
        headers: { authorization: `Bearer ${replacement.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ workerId: 'w-rev', frames: [{ sessionId: 's1', kind: 'timeline', entries: [entryOf(1)] }] }),
      });
      expect(batch.status).toBe(200);
    } finally {
      await hub.stop();
    }
  });

  it('P3-3.5: an unregistered workerId cannot open a stream; register then stream succeeds', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const { machineSecret } = await issueHttpTokens();
    const hub = spawnHub([]);
    try {
      await waitForStart(hub);
      const refused = await fetch(`${hub.baseUrl}/api/worker/stream?workerId=w-fresh`, { headers: { authorization: `Bearer ${machineSecret}` } });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      void refused.body?.cancel().catch(() => {});
      const register = await workerPost(hub.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w-fresh', [{ sessionId: 's1' }]));
      expect(register.status).toBe(200);
      const stream = await openSse(`${hub.baseUrl}/api/worker/stream?workerId=w-fresh`, { authorization: `Bearer ${machineSecret}` });
      await waitForLines(stream, 1, 'stream open after register');
      stream.close();
    } finally {
      await hub.stop();
    }
  });

  it('P3-3.6: after a hub restart another token cannot claim the workerId, but the original owner can', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const { machineSecret } = await issueHttpTokens();
    const adminKey = readOrGenerateAdminKey(dataDir);
    if (!adminKey.ok) throw new Error('admin key missing');
    const first = spawnHub([]);
    try {
      await waitForStart(first);
      const register = await workerPost(first.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w-rst', [{ sessionId: 's1' }]));
      expect(register.status).toBe(200);
      await waitUntil(() => {
        if (!existsSync(join(dataDir, 'state.json'))) return false;
        return readStateFile().threads.some((thread) => thread.hostWorkerId === 'w-rst');
      }, 'thread persisted');
    } finally {
      await first.stop();
    }
    const second = spawnHub([]);
    try {
      await waitForStart(second);
      const issue = await fetch(`${second.baseUrl}/api/admin/tokens`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminKey.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'machine', name: 'other-laptop' }),
      });
      expect(issue.status).toBe(200);
      const other = (await issue.json()) as { secret: string };
      const foreign = await fetch(`${second.baseUrl}/api/worker/register`, {
        method: 'POST',
        headers: { authorization: `Bearer ${other.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify(snapshotOf('w-rst', [{ sessionId: 's1' }])),
      });
      expect(foreign.status).toBe(200);
      expect(await foreign.json()).toEqual({ workerId: 'w-rst', threads: [{ sessionId: 's1', accepted: false }] });
      const reclaim = await workerPost(second.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w-rst', [{ sessionId: 's1' }]));
      expect(reclaim.status).toBe(200);
      expect(await reclaim.json()).toEqual({ workerId: 'w-rst', threads: [{ sessionId: 's1', accepted: true }] });
      const stream = await openSse(`${second.baseUrl}/api/worker/stream?workerId=w-rst`, { authorization: `Bearer ${machineSecret}` });
      await waitForLines(stream, 1, 'owner stream open');
      stream.close();
    } finally {
      await second.stop();
    }
  });

  it('P3-3.7: appending more than timelineRingLength entries truncates the hub timeline to the limit while tailSeq stays continuous', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const { machineSecret, deviceSecret } = await issueHttpTokens();
    const hub = spawnHub([]);
    try {
      await waitForStart(hub);
      const register = await workerPost(hub.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w-ring', [{ sessionId: 's1', timeline: [entryOf(1)] }]));
      expect(register.status).toBe(200);
      const total = LIMITS.timelineRingLength + 30;
      const chunk = 50;
      let nextSeq = 2;
      while (nextSeq <= total) {
        const entries: TimelineEntry[] = [];
        for (let seq = nextSeq; seq < nextSeq + chunk && seq <= total; seq += 1) entries.push(entryOf(seq));
        const batch = await workerPost(hub.baseUrl, machineSecret, '/api/worker/batch', {
          workerId: 'w-ring',
          frames: [{ sessionId: 's1', kind: 'timeline', entries }],
        });
        expect(batch.status).toBe(200);
        nextSeq += chunk;
      }
      const cookie = `${BROWSER_COOKIE_NAME}=${deviceSecret}`;
      const thread = await fetch(`${hub.baseUrl}/api/browser/threads/s1`, { headers: { cookie } });
      expect(thread.status).toBe(200);
      const body = (await thread.json()) as { timeline: { seq: number }[] };
      expect(body.timeline).toHaveLength(LIMITS.timelineRingLength);
      expect(body.timeline[0]!.seq).toBe(total - LIMITS.timelineRingLength + 1);
      expect(body.timeline.at(-1)!.seq).toBe(total);
      const contiguous = await workerPost(hub.baseUrl, machineSecret, '/api/worker/batch', {
        workerId: 'w-ring',
        frames: [{ sessionId: 's1', kind: 'timeline', entries: [entryOf(total + 1)] }],
      });
      expect(contiguous.status).toBe(200);
    } finally {
      await hub.stop();
    }
  });

  it('P3-3.8: a register snapshot longer than the limit is truncated to the same bound', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const { machineSecret, deviceSecret } = await issueHttpTokens();
    const hub = spawnHub([]);
    try {
      await waitForStart(hub);
      const oversized: TimelineEntry[] = [];
      for (let seq = 1; seq <= LIMITS.timelineRingLength + 25; seq += 1) oversized.push(entryOf(seq));
      const register = await workerPost(hub.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w-snap', [{ sessionId: 's1', timeline: oversized }]));
      expect(register.status).toBe(200);
      const cookie = `${BROWSER_COOKIE_NAME}=${deviceSecret}`;
      const thread = await fetch(`${hub.baseUrl}/api/browser/threads/s1`, { headers: { cookie } });
      expect(thread.status).toBe(200);
      const body = (await thread.json()) as { timeline: { seq: number }[] };
      expect(body.timeline).toHaveLength(LIMITS.timelineRingLength);
      expect(body.timeline[0]!.seq).toBe(26);
      expect(body.timeline.at(-1)!.seq).toBe(LIMITS.timelineRingLength + 25);
      const batch = await workerPost(hub.baseUrl, machineSecret, '/api/worker/batch', {
        workerId: 'w-snap',
        frames: [{ sessionId: 's1', kind: 'timeline', entries: [entryOf(LIMITS.timelineRingLength + 26)] }],
      });
      expect(batch.status).toBe(200);
    } finally {
      await hub.stop();
    }
  });

  it('P4-4.1: a state change inside the debounce window is on disk after a graceful shutdown and readable after restart', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const { machineSecret, deviceSecret } = await issueHttpTokens();
    const hub = spawnGracefulHub(['--write-interval-ms', '60000']);
    try {
      await waitForStart(hub);
      const register = await workerPost(hub.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w-p41', [{ sessionId: 's1', timeline: [entryOf(1)], openCards: [cardOf('approval_1')] }]));
      expect(register.status).toBe(200);
      expect(readStateFile().threads).toHaveLength(0);
      hub.shutdown();
      const code = await waitForGracefulExit(hub);
      expect(code).toBe(0);
      const persisted = readStateFile();
      expect(persisted.threads).toHaveLength(1);
      expect(persisted.threads[0]!.hostWorkerId).toBe('w-p41');
      expect(persisted.threads[0]!.openCards.map((card) => (card as { cardId: string }).cardId)).toEqual(['approval_1']);
    } finally {
      await hub.stop();
    }
    const second = spawnHub([]);
    try {
      await waitForStart(second);
      const thread = await fetch(`${second.baseUrl}/api/browser/threads/s1`, {
        headers: { cookie: `${BROWSER_COOKIE_NAME}=${deviceSecret}` },
      });
      expect(thread.status).toBe(200);
      const body = (await thread.json()) as { online: boolean; openCards: { cardId: string }[] };
      expect(body.online).toBe(false);
      expect(body.openCards.map((card) => card.cardId)).toEqual(['approval_1']);
    } finally {
      await second.stop();
    }
  });

  it('P4-4.2: when the final flush cannot reach disk, the hub logs store-write-failed and exits non-zero', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const { machineSecret } = await issueHttpTokens();
    mkdirSync(join(dataDir, 'state.json.tmp'));
    const hub = spawnGracefulHub([]);
    try {
      await waitForStart(hub);
      const register = await workerPost(hub.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w-p42', [{ sessionId: 's1', timeline: [entryOf(1)] }]));
      expect(register.status).toBe(200);
      hub.shutdown();
      const code = await waitForGracefulExit(hub);
      expect(code).not.toBe(0);
      expect(hub.output).toContain('store-write-failed');
    } finally {
      await hub.stop();
    }
  });

  it('P4-4.3: a worker going offline during close is captured by the final flush', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const { machineSecret } = await issueHttpTokens();
    const hub = createHubServer({ dataDir });
    const baseUrl = await new Promise<string>((resolve) => {
      hub.server.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(hub.server.address() as AddressInfo).port}`);
      });
    });
    try {
      const register = await fetch(`${baseUrl}/api/worker/register`, {
        method: 'POST',
        headers: { authorization: `Bearer ${machineSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify(snapshotOf('w-p43', [{ sessionId: 's1', openCards: [cardOf('approval_1')] }])),
      });
      expect(register.status).toBe(200);
      const stream = await openSse(`${baseUrl}/api/worker/stream?workerId=w-p43`, {
        authorization: `Bearer ${machineSecret}`,
      });
      await waitForLines(stream, 1, 'worker stream open');
      expect(readStateFile().threads).toHaveLength(0);
      const result = await hub.close();
      expect(result).toEqual({ ok: true });
      const after = readStateFile();
      expect(after.threads).toHaveLength(1);
      expect(after.threads[0]!.hostWorkerId).toBe('w-p43');
      expect(after.threads[0]!.openCards.map((card) => (card as { cardId: string }).cardId)).toEqual(['approval_1']);
      const settledAt = statSync(join(dataDir, 'state.json')).mtimeMs;
      await new Promise((resolve) => {
        setTimeout(resolve, 700);
      });
      expect(statSync(join(dataDir, 'state.json')).mtimeMs).toBe(settledAt);
      expect(existsSync(join(dataDir, 'state.json.tmp'))).toBe(false);
    } finally {
      if (hub.server.listening) await hub.close();
    }
  });

  it('P7-7.1: two tokens run full independent lifecycles while cross-forged calls are rejected indistinguishably', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const { machineSecret, deviceSecret } = await issueHttpTokens();
    const adminKey = readOrGenerateAdminKey(dataDir);
    if (!adminKey.ok) throw new Error('admin key missing');
    const hub = spawnHub([]);
    try {
      await waitForStart(hub);
      const issue = await fetch(`${hub.baseUrl}/api/admin/tokens`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminKey.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'machine', name: 'machine-b' }),
      });
      expect(issue.status).toBe(200);
      const secretB = ((await issue.json()) as { secret: string }).secret;
      const authA = `Bearer ${machineSecret}`;
      const authB = `Bearer ${secretB}`;
      const cookie = `${BROWSER_COOKIE_NAME}=${deviceSecret}`;
      const postAs = (auth: string, path: string, body: unknown) =>
        fetch(`${hub.baseUrl}${path}`, {
          method: 'POST',
          headers: { authorization: auth, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      const submitOp = async (sessionId: string): Promise<{ opId: string; state: string }> => {
        const response = await fetch(`${hub.baseUrl}/api/browser/ops`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, intent: { type: 'send', sessionId, text: 'hi' } }),
        });
        expect(response.status).toBe(202);
        return (await response.json()) as { opId: string; state: string };
      };

      const registerA = await postAs(authA, '/api/worker/register', snapshotOf('w-a', [{ sessionId: 'sa', timeline: [entryOf(1)] }]));
      expect(registerA.status).toBe(200);
      expect(await registerA.json()).toEqual({ workerId: 'w-a', threads: [{ sessionId: 'sa', accepted: true }] });
      const streamA = await openSse(`${hub.baseUrl}/api/worker/stream?workerId=w-a`, { authorization: authA });
      await waitForLines(streamA, 1, 'A stream open');
      expect((await postAs(authA, '/api/worker/batch', { workerId: 'w-a', frames: [{ sessionId: 'sa', kind: 'timeline', entries: [entryOf(2)] }] })).status).toBe(200);
      const opA = await submitOp('sa');
      expect(opA.state).toBe('accepted');
      expect((await postAs(authA, '/api/worker/receipt', { workerId: 'w-a', receipts: [{ opId: opA.opId, state: 'delivered' }] })).status).toBe(204);
      expect((await postAs(authA, '/api/worker/receipt', { workerId: 'w-a', receipts: [{ opId: opA.opId, state: 'applied' }] })).status).toBe(204);

      const registerB = await postAs(authB, '/api/worker/register', snapshotOf('w-b', [{ sessionId: 'sb', timeline: [entryOf(1)] }]));
      expect(registerB.status).toBe(200);
      expect(await registerB.json()).toEqual({ workerId: 'w-b', threads: [{ sessionId: 'sb', accepted: true }] });
      const streamB = await openSse(`${hub.baseUrl}/api/worker/stream?workerId=w-b`, { authorization: authB });
      await waitForLines(streamB, 1, 'B stream open');
      expect((await postAs(authB, '/api/worker/batch', { workerId: 'w-b', frames: [{ sessionId: 'sb', kind: 'timeline', entries: [entryOf(2)] }] })).status).toBe(200);
      const opB = await submitOp('sb');
      expect(opB.state).toBe('accepted');
      expect((await postAs(authB, '/api/worker/receipt', { workerId: 'w-b', receipts: [{ opId: opB.opId, state: 'delivered' }] })).status).toBe(204);

      const forgedBatch = await postAs(authA, '/api/worker/batch', { workerId: 'w-b', frames: [{ sessionId: 'sb', kind: 'timeline', entries: [entryOf(3)] }] });
      expect(forgedBatch.status).toBe(409);
      const forgedBatchBody = await forgedBatch.text();
      expect(forgedBatchBody).toContain('resync-required');
      const unknownBatch = await postAs(authA, '/api/worker/batch', { workerId: 'w-ghost', frames: [{ sessionId: 'sb', kind: 'timeline', entries: [entryOf(3)] }] });
      expect(unknownBatch.status).toBe(409);
      expect(await unknownBatch.text()).toBe(forgedBatchBody);

      expect((await postAs(authA, '/api/worker/receipt', { workerId: 'w-b', receipts: [{ opId: opB.opId, state: 'rejected', reason: 'invalid-params' }] })).status).toBe(204);
      expect((await postAs(authA, '/api/worker/unregister', { workerId: 'w-b', finalReceipts: [] })).status).toBe(204);
      const forgedStream = await fetch(`${hub.baseUrl}/api/worker/stream?workerId=w-b`, { headers: { authorization: authA } });
      const forgedStreamStatus = forgedStream.status;
      expect(forgedStreamStatus).toBeGreaterThanOrEqual(400);
      void forgedStream.body?.cancel().catch(() => {});
      const unknownStream = await fetch(`${hub.baseUrl}/api/worker/stream?workerId=w-ghost`, { headers: { authorization: authA } });
      expect(unknownStream.status).toBe(forgedStreamStatus);
      void unknownStream.body?.cancel().catch(() => {});
      const forgedRegister = await postAs(authA, '/api/worker/register', snapshotOf('w-b', [{ sessionId: 's-evil' }]));
      expect(forgedRegister.status).toBe(200);
      expect(await forgedRegister.json()).toEqual({ workerId: 'w-b', threads: [{ sessionId: 's-evil', accepted: false }] });

      const inbox = await fetch(`${hub.baseUrl}/api/browser/inbox`, { headers: { cookie } });
      const inboxBody = (await inbox.json()) as { threads: { descriptor: { sessionId: string } }[] };
      expect(inboxBody.threads.map((thread) => thread.descriptor.sessionId).toSorted()).toEqual(['sa', 'sb']);

      const threadB = await fetch(`${hub.baseUrl}/api/browser/threads/sb`, { headers: { cookie } });
      expect(threadB.status).toBe(200);
      const viewB = (await threadB.json()) as ThreadView;
      expect(viewB.online).toBe(true);
      expect(viewB.timeline.map((entry) => entry.seq)).toEqual([1, 2]);
      expect(viewB.receipts.find((entry) => entry.opId === opB.opId)).toMatchObject({ state: 'delivered' });

      const stillLive = await Promise.race([
        waitForLines(streamB, 1, 'noop').then(() => true),
        streamB.closed.then(() => false),
      ]);
      expect(stillLive).toBe(true);

      expect((await postAs(authB, '/api/worker/receipt', { workerId: 'w-b', receipts: [{ opId: opB.opId, state: 'applied' }] })).status).toBe(204);
      expect((await postAs(authA, '/api/worker/batch', { workerId: 'w-a', frames: [{ sessionId: 'sa', kind: 'timeline', entries: [entryOf(3)] }] })).status).toBe(200);
      expect((await postAs(authB, '/api/worker/batch', { workerId: 'w-b', frames: [{ sessionId: 'sb', kind: 'timeline', entries: [entryOf(3)] }] })).status).toBe(200);
      const viewA = (await (await fetch(`${hub.baseUrl}/api/browser/threads/sa`, { headers: { cookie } })).json()) as ThreadView;
      expect(viewA.online).toBe(true);
      expect(viewA.timeline.map((entry) => entry.seq)).toEqual([1, 2, 3]);
      expect(viewA.receipts.find((entry) => entry.opId === opA.opId)).toMatchObject({ state: 'applied' });
      const viewBAfter = (await (await fetch(`${hub.baseUrl}/api/browser/threads/sb`, { headers: { cookie } })).json()) as ThreadView;
      expect(viewBAfter.online).toBe(true);
      expect(viewBAfter.timeline.map((entry) => entry.seq)).toEqual([1, 2, 3]);
      expect(viewBAfter.receipts.find((entry) => entry.opId === opB.opId)).toMatchObject({ state: 'applied' });

      streamA.close();
      streamB.close();
    } finally {
      await hub.stop();
    }
  });

  it('P7-7.2: a token issued mid-run survives a graceful shutdown and restart, and the worker reconciles on reconnect', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const { deviceSecret } = await issueHttpTokens();
    const adminKey = readOrGenerateAdminKey(dataDir);
    if (!adminKey.ok) throw new Error('admin key missing');
    const cookie = `${BROWSER_COOKIE_NAME}=${deviceSecret}`;
    let reconnectSecret = '';
    let openOpId = '';
    const first = spawnGracefulHub(['--write-interval-ms', '60000']);
    try {
      await waitForStart(first);
      const issue = await fetch(`${first.baseUrl}/api/admin/tokens`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminKey.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'machine', name: 'laptop-2' }),
      });
      expect(issue.status).toBe(200);
      reconnectSecret = ((await issue.json()) as { secret: string }).secret;
      const register = await workerPost(first.baseUrl, reconnectSecret, '/api/worker/register', snapshotOf('w-72', [{ sessionId: 's1', timeline: [entryOf(1)], openCards: [cardOf('approval_1')] }]));
      expect(register.status).toBe(200);
      const ops = await fetch(`${first.baseUrl}/api/browser/ops`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', intent: { type: 'send', sessionId: 's1', text: 'hi' } }),
      });
      expect(ops.status).toBe(202);
      const receipt = (await ops.json()) as { opId: string; state: string };
      expect(receipt.state).toBe('accepted');
      openOpId = receipt.opId;
      expect((await workerPost(first.baseUrl, reconnectSecret, '/api/worker/receipt', { workerId: 'w-72', receipts: [{ opId: openOpId, state: 'delivered' }] })).status).toBe(204);
      expect(readStateFile().threads).toHaveLength(0);
      first.shutdown();
      const code = await waitForGracefulExit(first);
      expect(code).toBe(0);
    } finally {
      await first.stop();
    }
    const persisted = readStateFile();
    expect(persisted.tokens.map((token) => token.name)).toContain('laptop-2');
    expect(persisted.threads).toHaveLength(1);
    expect(persisted.threads[0]!.hostWorkerId).toBe('w-72');
    expect(persisted.threads[0]!.openCards.map((card) => (card as { cardId: string }).cardId)).toEqual(['approval_1']);
    expect(persisted.receipts.find((entry) => entry.opId === openOpId)).toMatchObject({ state: 'delivered' });

    const second = spawnGracefulHub([]);
    try {
      await waitForStart(second);
      const thread = await fetch(`${second.baseUrl}/api/browser/threads/s1`, { headers: { cookie } });
      expect(thread.status).toBe(200);
      const offline = (await thread.json()) as ThreadView;
      expect(offline.online).toBe(false);
      expect(offline.openCards.map((card) => card.cardId)).toEqual(['approval_1']);
      expect(offline.receipts.find((entry) => entry.opId === openOpId)).toMatchObject({ state: 'delivered' });

      const reregister = await workerPost(second.baseUrl, reconnectSecret, '/api/worker/register', snapshotOf('w-72', [{ sessionId: 's1', timeline: [entryOf(1)], openCards: [cardOf('approval_1')] }], [{ opId: openOpId, state: 'delivered' }]));
      expect(reregister.status).toBe(200);
      expect(await reregister.json()).toEqual({ workerId: 'w-72', threads: [{ sessionId: 's1', accepted: true }] });
      const stream = await openSse(`${second.baseUrl}/api/worker/stream?workerId=w-72`, { authorization: `Bearer ${reconnectSecret}` });
      await waitForLines(stream, 1, 'reconnected worker stream open');
      const online = (await (await fetch(`${second.baseUrl}/api/browser/threads/s1`, { headers: { cookie } })).json()) as ThreadView;
      expect(online.online).toBe(true);
      expect(online.timeline.map((entry) => entry.seq)).toEqual([1]);
      expect(online.receipts.find((entry) => entry.opId === openOpId)).toMatchObject({ state: 'delivered' });
      stream.close();
    } finally {
      await second.stop();
    }
  });

  it('P7-7.3: a session-switch register prunes the old thread and reconciles its in-flight receipt to lost', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const { machineSecret, deviceSecret } = await issueHttpTokens();
    const cookie = `${BROWSER_COOKIE_NAME}=${deviceSecret}`;
    const hub = spawnHub([]);
    try {
      await waitForStart(hub);
      const register = await workerPost(hub.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w-73', [{ sessionId: 's-old', openCards: [cardOf('approval_1')] }]));
      expect(register.status).toBe(200);
      const stream = await openSse(`${hub.baseUrl}/api/worker/stream?workerId=w-73`, { authorization: `Bearer ${machineSecret}` });
      await waitForLines(stream, 1, 'stream open');
      const ops = await fetch(`${hub.baseUrl}/api/browser/ops`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's-old', intent: { type: 'send', sessionId: 's-old', text: 'in flight' } }),
      });
      expect(ops.status).toBe(202);
      const receipt = (await ops.json()) as { opId: string; state: string };
      expect(receipt.state).toBe('accepted');

      const switched = await workerPost(hub.baseUrl, machineSecret, '/api/worker/register', snapshotOf('w-73', [{ sessionId: 's-new' }]));
      expect(switched.status).toBe(200);
      expect(await switched.json()).toEqual({ workerId: 'w-73', threads: [{ sessionId: 's-new', accepted: true }] });

      expect((await fetch(`${hub.baseUrl}/api/browser/threads/s-old`, { headers: { cookie } })).status).toBe(404);
      const newThread = await fetch(`${hub.baseUrl}/api/browser/threads/s-new`, { headers: { cookie } });
      expect(newThread.status).toBe(200);
      const view = (await newThread.json()) as ThreadView;
      expect(view.online).toBe(true);
      expect(view.timeline).toEqual([]);

      await waitUntil(() => {
        if (!existsSync(join(dataDir, 'state.json'))) return false;
        const target = readStateFile().receipts.find((entry) => entry.opId === receipt.opId);
        return target !== undefined && target.state === 'lost';
      }, 'in-flight receipt reconciled to lost');
      expect(readStateFile().receipts.find((entry) => entry.opId === receipt.opId)).toMatchObject({
        state: 'lost',
        reason: 'not-delivered',
      });
      stream.close();
    } finally {
      await hub.stop();
    }
  });

  it('P7-7.4: a crashed worker past grace has its receipts finalized as lost while state.json entries stay bounded', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const { machineSecret, deviceSecret } = await issueHttpTokens();
    const cookie = `${BROWSER_COOKIE_NAME}=${deviceSecret}`;
    const hub = createHubServer({ dataDir, workerGraceMs: 400, workerScanIntervalMs: 50 });
    const baseUrl = await new Promise<string>((resolve) => {
      hub.server.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(hub.server.address() as AddressInfo).port}`);
      });
    });
    const readPersisted = (): PersistedState | undefined => {
      if (!existsSync(join(dataDir, 'state.json'))) return undefined;
      return readStateFile();
    };
    try {
      const register = await fetch(`${baseUrl}/api/worker/register`, {
        method: 'POST',
        headers: { authorization: `Bearer ${machineSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify(snapshotOf('w-74', [{ sessionId: 's1', timeline: [entryOf(1)] }])),
      });
      expect(register.status).toBe(200);
      const stream = await openSse(`${baseUrl}/api/worker/stream?workerId=w-74`, { authorization: `Bearer ${machineSecret}` });
      await waitForLines(stream, 1, 'stream open');

      const totalEntries = LIMITS.timelineRingLength + 60;
      let nextSeq = 2;
      while (nextSeq <= totalEntries) {
        const entries: TimelineEntry[] = [];
        for (let seq = nextSeq; seq < nextSeq + 50 && seq <= totalEntries; seq += 1) entries.push(entryOf(seq));
        const batch = await fetch(`${baseUrl}/api/worker/batch`, {
          method: 'POST',
          headers: { authorization: `Bearer ${machineSecret}`, 'content-type': 'application/json' },
          body: JSON.stringify({ workerId: 'w-74', frames: [{ sessionId: 's1', kind: 'timeline', entries }] }),
        });
        expect(batch.status).toBe(200);
        nextSeq += 50;
      }

      const totalOps = LIMITS.receiptsPerThread + 50;
      for (let index = 0; index < totalOps; index += 1) {
        const ops = await fetch(`${baseUrl}/api/browser/ops`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: 's1', intent: { type: 'send', sessionId: 's1', text: `m${index}` } }),
        });
        expect(ops.status).toBe(202);
      }

      stream.close();
      await waitUntil(() => {
        const persisted = readPersisted();
        if (persisted === undefined) return false;
        return (
          persisted.receipts.length === LIMITS.receiptsPerThread &&
          persisted.receipts.every((entry) => entry.state === 'lost')
        );
      }, 'crashed worker receipts finalized and capped');

      const persisted = readStateFile();
      expect(persisted.receipts).toHaveLength(LIMITS.receiptsPerThread);
      expect(persisted.receipts.every((entry) => entry.state === 'lost' && entry.reason === 'not-delivered')).toBe(true);
      expect(persisted.threads).toHaveLength(1);
      expect('timeline' in persisted.threads[0]!).toBe(false);

      const thread = await fetch(`${baseUrl}/api/browser/threads/s1`, { headers: { cookie } });
      expect(thread.status).toBe(200);
      const view = (await thread.json()) as ThreadView;
      expect(view.online).toBe(false);
      expect(view.timeline).toHaveLength(LIMITS.timelineRingLength);
      expect(view.timeline[0]!.seq).toBe(totalEntries - LIMITS.timelineRingLength + 1);
      expect(view.receipts).toHaveLength(LIMITS.receiptsPerThread);
    } finally {
      if (hub.server.listening) await hub.close();
    }
  });
});
