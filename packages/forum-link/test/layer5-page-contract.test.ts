import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BROWSER_COOKIE_NAME } from '#/contract/browser';
import type { ThreadSnapshot, ThreadSummary } from '#/contract/browser';
import type { Receipt, TokenRecord } from '#/contract/shared';
import type { Card, Overview, ReceiptReport, TimelineEntry, UplinkFrame, WorkerSnapshot } from '#/contract/worker';
import { Store, emptyState } from '#/hub/store';
import { Tokens } from '#/hub/tokens';
import { PageStore, sortInbox, type PageStreamEvent } from '#/page/store';

const HUB_MJS = fileURLToPath(new URL('../dist/hub.mjs', import.meta.url));
const SUBPROCESS_TIMEOUT_MS = 15000;
const ALL_STREAM_EVENTS: PageStreamEvent['type'][] = [
  'thread.upsert',
  'thread.removed',
  'thread.reset',
  'timeline.append',
  'overview',
  'card.opened',
  'card.settled',
  'receipt',
];

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'forum-link-layer5-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

interface SseStream {
  lines: string[];
  close(): void;
}

async function openSse(url: string, headers: Record<string, string>): Promise<SseStream> {
  const res = await fetch(url, { headers });
  if (res.status !== 200 || res.body === null) throw new Error(`stream failed: ${res.status}`);
  const lines: string[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
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
  })();
  void pump.catch(() => {});
  return {
    lines,
    close() {
      void reader.cancel().catch(() => {});
    },
  };
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 10).unref?.();
    });
  }
}

async function issueTokens(
  pairs: { role: 'machine' | 'device'; name: string }[],
): Promise<Record<string, { role: string; name: string; secret: string }>> {
  let state = emptyState();
  const store = new Store({ dataDir, writeIntervalMs: 10, renameRetryDelayMs: 1, persistView: () => state });
  const tokens = new Tokens({
    store: {
      records: () => state.tokens,
      save: async (next: readonly TokenRecord[]) => {
        const result = await store.commitTokens([...next]);
        if (!result.ok) throw new Error('issue failed');
        state = { ...state, tokens: [...next] };
      },
    },
  });
  const issued: Record<string, { role: string; name: string; secret: string }> = {};
  for (const { role, name } of pairs) {
    const result = await tokens.issue(role, name);
    if (!result.ok) throw new Error(`issue ${role} ${name} failed`);
    issued[name] = { role, name, secret: result.secret };
  }
  return issued;
}

interface Layer5Hub {
  baseUrl: string;
  stop(): Promise<void>;
}

async function startLayer5Hub(): Promise<Layer5Hub> {
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
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const deadline = Date.now() + 8000;
    const poll = () => {
      const match = /listening on http:\/\/\S+:(\d+)/.exec(output);
      if (match !== null) {
        resolve(`http://127.0.0.1:${match[1]}`);
        return;
      }
      if (child.exitCode !== null || Date.now() > deadline) {
        child.kill();
        reject(new Error(`hub failed to start: ${output}`));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
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
  return { baseUrl, stop };
}

interface WorkerClient {
  workerId: string;
  register(snapshot: WorkerSnapshot): Promise<Response>;
  batch(frames: UplinkFrame[]): Promise<Response>;
  receipt(receipts: ReceiptReport[]): Promise<Response>;
  unregister(finalReceipts: ReceiptReport[]): Promise<Response>;
  openStream(): Promise<SseStream>;
}

function workerClient(baseUrl: string, secret: string, workerId: string): WorkerClient {
  const authorization = `Bearer ${secret}`;
  const post = (path: string, body: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return {
    workerId,
    register: (snapshot) => post('/api/worker/register', snapshot),
    batch: (frames) => post('/api/worker/batch', { workerId, frames }),
    receipt: (receipts) => post('/api/worker/receipt', { workerId, receipts }),
    unregister: (finalReceipts) => post('/api/worker/unregister', { workerId, finalReceipts }),
    openStream: () =>
      openSse(`${baseUrl}/api/worker/stream?workerId=${encodeURIComponent(workerId)}`, { authorization }),
  };
}

interface BrowserClient {
  cookie: string;
  inbox(): Promise<Response>;
  thread(sessionId: string): Promise<Response>;
  openStream(): Promise<SseStream>;
}

function browserClient(baseUrl: string, secret: string): BrowserClient {
  const cookie = `${BROWSER_COOKIE_NAME}=${secret}`;
  return {
    cookie,
    inbox: () => fetch(`${baseUrl}/api/browser/inbox`, { headers: { cookie } }),
    thread: (sessionId) =>
      fetch(`${baseUrl}/api/browser/threads/${encodeURIComponent(sessionId)}`, { headers: { cookie } }),
    openStream: () => openSse(`${baseUrl}/api/browser/stream`, { cookie }),
  };
}

async function login(baseUrl: string, secret: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/browser/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: secret }),
  });
  if (res.status !== 204) throw new Error(`login failed: ${res.status}`);
}

function streamEventsOf(lines: readonly string[]): PageStreamEvent[] {
  const events: PageStreamEvent[] = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (!lines[i]!.startsWith('event: ')) continue;
    const dataLine = lines[i + 1]!;
    if (!dataLine.startsWith('data: ')) continue;
    events.push(JSON.parse(dataLine.slice(6)) as PageStreamEvent);
  }
  return events;
}

interface FakeThread {
  sessionId: string;
  hostname: string;
  lastActivityAt: number;
  openCards: Card[];
  timeline: TimelineEntry[];
}

function entryOf(seq: number, at: number): TimelineEntry {
  return { seq, at, kind: 'user-message', text: `m${seq}` };
}

function cardOf(cardId: string, openedAt: number): Card {
  return { cardId, kind: 'approval', openedAt, approval: {} };
}

function overviewOf(rev: number, sampledAt: number): Overview {
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
    sampledAt,
  };
}

function snapshotOf(workerId: string, threads: FakeThread[], recentReceipts: ReceiptReport[] = []): WorkerSnapshot {
  return {
    workerId,
    threads: threads.map((thread) => ({
      descriptor: {
        sessionId: thread.sessionId,
        machine: { tokenName: 'worker-reported-name', hostname: thread.hostname },
        project: 'proj',
        title: `title-${thread.sessionId}`,
        kind: 'interactive',
        capabilities: ['approve', 'send'],
      },
      overview: overviewOf(1, thread.lastActivityAt),
      timeline: thread.timeline.slice(),
      openCards: thread.openCards.slice(),
    })),
    recentReceipts,
  };
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function groupByTokenName(threads: readonly ThreadSummary[]): Map<string, ThreadSummary[]> {
  const groups = new Map<string, ThreadSummary[]>();
  for (const thread of threads) {
    const key = thread.descriptor.machine.tokenName;
    groups.set(key, [...(groups.get(key) ?? []), thread]);
  }
  return groups;
}

describe('layer5 page contract (K2-IV1)', () => {
  it('login, inbox and thread snapshots, and timeline appends flow into the page store', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const tokens = await issueTokens([
      { role: 'machine', name: 'laptop' },
      { role: 'device', name: 'phone' },
    ]);
    const machine = tokens['laptop']!;
    const device = tokens['phone']!;
    const hub = await startLayer5Hub();
    try {
      await login(hub.baseUrl, device.secret);
      const browser = browserClient(hub.baseUrl, device.secret);
      const worker = workerClient(hub.baseUrl, machine.secret, 'w-l5');
      const browserStream = await browser.openStream();
      const thread: FakeThread = {
        sessionId: 's1',
        hostname: 'host-1',
        lastActivityAt: 1000,
        openCards: [],
        timeline: [entryOf(1, 1000), entryOf(2, 1000)],
      };
      const register = await worker.register(snapshotOf('w-l5', [thread]));
      expect(register.status).toBe(200);
      const workerStream = await worker.openStream();

      const inboxRes = await browser.inbox();
      expect(inboxRes.status).toBe(200);
      const inbox = await readJson<{ threads: ThreadSummary[] }>(inboxRes);
      expect(inbox.threads).toHaveLength(1);
      expect(inbox.threads[0]!.descriptor.machine.tokenName).toBe('laptop');
      const store = new PageStore();
      store.applyInbox(inbox.threads);

      const threadRes = await browser.thread('s1');
      expect(threadRes.status).toBe(200);
      store.applyThreadSnapshot(await readJson<ThreadSnapshot>(threadRes));
      expect(store.inbox.map((summary) => summary.descriptor.sessionId)).toEqual(['s1']);
      expect(store.currentThread?.timeline.map((entry) => entry.seq)).toEqual([1, 2]);

      const batch = await worker.batch([
        { sessionId: 's1', kind: 'timeline', entries: [entryOf(3, 2000), entryOf(4, 2000)] },
      ]);
      expect(batch.status).toBe(200);
      await waitUntil(
        () => streamEventsOf(browserStream.lines).some((event) => event.type === 'timeline.append'),
        'timeline.append event',
      );
      for (const event of streamEventsOf(browserStream.lines)) store.applyEvent(event);
      expect(store.currentThread?.timeline.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
      const names = new Set(streamEventsOf(browserStream.lines).map((event) => event.type));
      expect(names.has('thread.upsert')).toBe(true);
      expect(names.has('thread.reset')).toBe(true);
      browserStream.close();
      workerStream.close();
    } finally {
      await hub.stop();
    }
  });

  it('a sequence gap triggers the refetch callback and a re-read restores the timeline', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const tokens = await issueTokens([
      { role: 'machine', name: 'laptop' },
      { role: 'device', name: 'phone' },
    ]);
    const machine = tokens['laptop']!;
    const device = tokens['phone']!;
    const hub = await startLayer5Hub();
    try {
      const browser = browserClient(hub.baseUrl, device.secret);
      const worker = workerClient(hub.baseUrl, machine.secret, 'w-gap');
      const thread: FakeThread = {
        sessionId: 's1',
        hostname: 'host-1',
        lastActivityAt: 1000,
        openCards: [],
        timeline: [entryOf(1, 1000)],
      };
      const register = await worker.register(snapshotOf('w-gap', [thread]));
      expect(register.status).toBe(200);
      const workerStream = await worker.openStream();
      const browserStream = await browser.openStream();

      const threadRes = await browser.thread('s1');
      expect(threadRes.status).toBe(200);
      const refetched: string[] = [];
      const store = new PageStore({ refetchThread: (sessionId) => refetched.push(sessionId) });
      store.applyThreadSnapshot(await readJson<ThreadSnapshot>(threadRes));

      const batch = await worker.batch([{ sessionId: 's1', kind: 'timeline', entries: [entryOf(2, 2000), entryOf(3, 2000)] }]);
      expect(batch.status).toBe(200);
      await waitUntil(
        () => streamEventsOf(browserStream.lines).some((event) => event.type === 'timeline.append'),
        'timeline.append event',
      );
      for (const event of streamEventsOf(browserStream.lines)) store.applyEvent(event);
      expect(store.currentThread?.timeline.map((entry) => entry.seq)).toEqual([1, 2, 3]);

      store.applyEvent({ type: 'timeline.append', sessionId: 's1', entries: [entryOf(6, 3000)] });
      expect(refetched).toEqual(['s1']);
      expect(store.currentThread?.timeline.map((entry) => entry.seq)).toEqual([1, 2, 3]);

      const followUp = await worker.batch([
        { sessionId: 's1', kind: 'timeline', entries: [entryOf(4, 3000), entryOf(5, 3000)] },
      ]);
      expect(followUp.status).toBe(200);
      const restoredRes = await browser.thread('s1');
      expect(restoredRes.status).toBe(200);
      store.applyThreadSnapshot(await readJson<ThreadSnapshot>(restoredRes));
      expect(store.currentThread?.timeline.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
      browserStream.close();
      workerStream.close();
    } finally {
      await hub.stop();
    }
  });

  it('a worker resync emits thread.reset and the store refetches the thread', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const tokens = await issueTokens([
      { role: 'machine', name: 'laptop' },
      { role: 'device', name: 'phone' },
    ]);
    const machine = tokens['laptop']!;
    const device = tokens['phone']!;
    const hub = await startLayer5Hub();
    try {
      const browser = browserClient(hub.baseUrl, device.secret);
      const worker = workerClient(hub.baseUrl, machine.secret, 'w-reset');
      const thread: FakeThread = {
        sessionId: 's1',
        hostname: 'host-1',
        lastActivityAt: 1000,
        openCards: [],
        timeline: [entryOf(1, 1000)],
      };
      const register = await worker.register(snapshotOf('w-reset', [thread]));
      expect(register.status).toBe(200);
      const workerStream = await worker.openStream();
      const browserStream = await browser.openStream();

      const threadRes = await browser.thread('s1');
      expect(threadRes.status).toBe(200);
      const refetched: string[] = [];
      const store = new PageStore({ refetchThread: (sessionId) => refetched.push(sessionId) });
      store.applyThreadSnapshot(await readJson<ThreadSnapshot>(threadRes));

      const resynced: FakeThread = { ...thread, lastActivityAt: 5000, timeline: [entryOf(1, 5000), entryOf(2, 5000)] };
      const resync = await worker.register(snapshotOf('w-reset', [resynced]));
      expect(resync.status).toBe(200);
      await waitUntil(
        () => streamEventsOf(browserStream.lines).some((event) => event.type === 'thread.reset'),
        'thread.reset event',
      );
      for (const event of streamEventsOf(browserStream.lines)) store.applyEvent(event);
      expect(refetched).toEqual(['s1']);

      const restoredRes = await browser.thread('s1');
      expect(restoredRes.status).toBe(200);
      store.applyThreadSnapshot(await readJson<ThreadSnapshot>(restoredRes));
      expect(store.currentThread?.timeline.map((entry) => entry.seq)).toEqual([1, 2]);
      browserStream.close();
      workerStream.close();
    } finally {
      await hub.stop();
    }
  });

  it('a stream reconnect refetches the inbox and the current thread', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const tokens = await issueTokens([
      { role: 'machine', name: 'laptop' },
      { role: 'device', name: 'phone' },
    ]);
    const machine = tokens['laptop']!;
    const device = tokens['phone']!;
    const hub = await startLayer5Hub();
    try {
      const browser = browserClient(hub.baseUrl, device.secret);
      const worker = workerClient(hub.baseUrl, machine.secret, 'w-conn');
      const thread: FakeThread = {
        sessionId: 's1',
        hostname: 'host-1',
        lastActivityAt: 1000,
        openCards: [],
        timeline: [entryOf(1, 1000)],
      };
      const register = await worker.register(snapshotOf('w-conn', [thread]));
      expect(register.status).toBe(200);
      const workerStream = await worker.openStream();
      const firstStream = await browser.openStream();
      await waitUntil(() => firstStream.lines.length > 0, 'browser stream open');
      firstStream.close();

      const inboxFetches: string[] = [];
      const refetched: string[] = [];
      const store = new PageStore({
        refetchInbox: () => inboxFetches.push('inbox'),
        refetchThread: (sessionId) => refetched.push(sessionId),
      });
      const inboxRes = await browser.inbox();
      store.applyInbox((await readJson<{ threads: ThreadSummary[] }>(inboxRes)).threads);
      const threadRes = await browser.thread('s1');
      store.applyThreadSnapshot(await readJson<ThreadSnapshot>(threadRes));
      expect(inboxFetches).toHaveLength(0);
      expect(refetched).toHaveLength(0);

      const secondStream = await browser.openStream();
      await waitUntil(() => secondStream.lines.length > 0, 'browser stream reconnect');
      store.noteStreamConnected();
      expect(inboxFetches).toEqual(['inbox']);
      expect(refetched).toEqual(['s1']);
      secondStream.close();
      workerStream.close();
    } finally {
      await hub.stop();
    }
  });

  it('all eight stream event kinds reach the page store through the real hub (V3-A1 page side)', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const tokens = await issueTokens([
      { role: 'machine', name: 'laptop' },
      { role: 'device', name: 'phone' },
    ]);
    const machine = tokens['laptop']!;
    const device = tokens['phone']!;
    const hub = await startLayer5Hub();
    try {
      const browser = browserClient(hub.baseUrl, device.secret);
      const worker = workerClient(hub.baseUrl, machine.secret, 'w-all');
      const thread: FakeThread = {
        sessionId: 's1',
        hostname: 'host-1',
        lastActivityAt: 1000,
        openCards: [cardOf('approval_1', 1000)],
        timeline: [entryOf(1, 1000)],
      };
      const browserStream = await browser.openStream();
      const register = await worker.register(snapshotOf('w-all', [thread]));
      expect(register.status).toBe(200);
      const workerStream = await worker.openStream();

      const store = new PageStore();
      const inboxRes = await browser.inbox();
      store.applyInbox((await readJson<{ threads: ThreadSummary[] }>(inboxRes)).threads);
      const threadRes = await browser.thread('s1');
      store.applyThreadSnapshot(await readJson<ThreadSnapshot>(threadRes));
      expect(store.currentThread?.openCards.map((card) => card.cardId)).toEqual(['approval_1']);

      const batch = await worker.batch([
        { sessionId: 's1', kind: 'timeline', entries: [entryOf(2, 2000)] },
        { sessionId: 's1', kind: 'overview', overview: overviewOf(5, 2000) },
      ]);
      expect(batch.status).toBe(200);
      const ops = await fetch(`${hub.baseUrl}/api/browser/ops`, {
        method: 'POST',
        headers: { cookie: browser.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', intent: { type: 'send', sessionId: 's1', text: 'hi' } }),
      });
      expect(ops.status).toBe(202);
      const receipt = await readJson<Receipt>(ops);
      const reported = await worker.receipt([{ opId: receipt.opId, state: 'delivered' }]);
      expect(reported.status).toBe(204);

      const settled: FakeThread = { ...thread, openCards: [], timeline: [entryOf(1, 1000), entryOf(2, 2000)] };
      const settle = await worker.register(snapshotOf('w-all', [settled], [{ opId: receipt.opId, state: 'delivered' }]));
      expect(settle.status).toBe(200);

      await waitUntil(
        () => {
          const names = new Set(streamEventsOf(browserStream.lines).map((event) => event.type));
          return ALL_STREAM_EVENTS.filter((name) => name !== 'thread.removed').every((name) => names.has(name));
        },
        'seven event kinds before removal',
      );
      for (const event of streamEventsOf(browserStream.lines)) store.applyEvent(event);
      const seen = new Set(streamEventsOf(browserStream.lines).map((event) => event.type));
      for (const expected of ALL_STREAM_EVENTS.filter((name) => name !== 'thread.removed')) {
        expect(seen.has(expected), `event ${expected}`).toBe(true);
      }
      expect(store.currentThread?.openCards).toEqual([]);
      expect(store.currentThread?.overview.rev).toBe(5);
      expect(store.currentThread?.timeline.map((entry) => entry.seq)).toEqual([1, 2]);
      expect(store.currentThread?.receipts.map((entry) => entry.opId)).toEqual([receipt.opId]);
      expect(store.currentThread?.receipts[0]?.state).toBe('delivered');

      const unregister = await worker.unregister([]);
      expect(unregister.status).toBe(204);
      await waitUntil(
        () => streamEventsOf(browserStream.lines).some((event) => event.type === 'thread.removed'),
        'thread.removed event',
      );
      for (const event of streamEventsOf(browserStream.lines)) store.applyEvent(event);
      expect(store.currentThread).toBeUndefined();
      expect(store.inbox).toEqual([]);
      browserStream.close();
      workerStream.close();
    } finally {
      await hub.stop();
    }
  });
});

describe('G-A7 multi-machine inbox grouping', () => {
  it('sortInbox pins the open-card thread and groups the rest by tokenName', { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    const tokens = await issueTokens([
      { role: 'machine', name: 'laptop' },
      { role: 'machine', name: 'desktop' },
      { role: 'device', name: 'phone' },
    ]);
    const laptop = tokens['laptop']!;
    const desktop = tokens['desktop']!;
    const device = tokens['phone']!;
    const hub = await startLayer5Hub();
    try {
      const browser = browserClient(hub.baseUrl, device.secret);
      const workerA = workerClient(hub.baseUrl, laptop.secret, 'w-a');
      const workerB = workerClient(hub.baseUrl, desktop.secret, 'w-b');
      const a1: FakeThread = {
        sessionId: 'a1',
        hostname: 'host-a',
        lastActivityAt: 2000,
        openCards: [],
        timeline: [entryOf(1, 2000)],
      };
      const b1: FakeThread = {
        sessionId: 'b1',
        hostname: 'host-b',
        lastActivityAt: 3000,
        openCards: [cardOf('approval_9', 3000)],
        timeline: [entryOf(1, 3000)],
      };
      const b2: FakeThread = {
        sessionId: 'b2',
        hostname: 'host-b',
        lastActivityAt: 1500,
        openCards: [],
        timeline: [entryOf(1, 1500)],
      };
      const registerA = await workerA.register(snapshotOf('w-a', [a1]));
      expect(registerA.status).toBe(200);
      const registerB = await workerB.register(snapshotOf('w-b', [b1, b2]));
      expect(registerB.status).toBe(200);
      const workerStreamA = await workerA.openStream();
      const workerStreamB = await workerB.openStream();

      const inboxRes = await browser.inbox();
      expect(inboxRes.status).toBe(200);
      const inbox = await readJson<{ threads: ThreadSummary[] }>(inboxRes);
      expect(inbox.threads).toHaveLength(3);
      const byId = new Map(inbox.threads.map((summary) => [summary.descriptor.sessionId, summary]));
      expect(byId.get('a1')?.descriptor.machine.tokenName).toBe('laptop');
      expect(byId.get('b1')?.descriptor.machine.tokenName).toBe('desktop');
      expect(byId.get('b2')?.descriptor.machine.tokenName).toBe('desktop');
      expect(byId.get('b1')?.descriptor.machine.hostname).toBe('host-b');

      const sorted = sortInbox(inbox.threads);
      expect(sorted.map((summary) => summary.descriptor.sessionId)).toEqual(['b1', 'a1', 'b2']);
      expect(sorted[0]!.openCards.map((card) => card.cardId)).toEqual(['approval_9']);
      const groups = groupByTokenName(sorted.slice(1));
      expect([...groups.keys()]).toEqual(['laptop', 'desktop']);
      expect(groups.get('laptop')!.map((summary) => summary.descriptor.sessionId)).toEqual(['a1']);
      expect(groups.get('desktop')!.map((summary) => summary.descriptor.sessionId)).toEqual(['b2']);

      const a2: FakeThread = {
        sessionId: 'a2',
        hostname: 'host-a',
        lastActivityAt: 1000,
        openCards: [],
        timeline: [entryOf(1, 1000)],
      };
      const grow = await workerA.register(snapshotOf('w-a', [a1, a2]));
      expect(grow.status).toBe(200);
      const refreshedRes = await browser.inbox();
      const refreshed = await readJson<{ threads: ThreadSummary[] }>(refreshedRes);
      expect(refreshed.threads).toHaveLength(4);
      const sortedAgain = sortInbox(refreshed.threads);
      expect(sortedAgain.map((summary) => summary.descriptor.sessionId)).toEqual(['b1', 'a1', 'a2', 'b2']);
      const groupsAgain = groupByTokenName(sortedAgain.slice(1));
      expect([...groupsAgain.keys()]).toEqual(['laptop', 'desktop']);
      expect(groupsAgain.get('laptop')!.map((summary) => summary.descriptor.sessionId)).toEqual(['a1', 'a2']);
      expect(groupsAgain.get('desktop')!.map((summary) => summary.descriptor.sessionId)).toEqual(['b2']);
      workerStreamA.close();
      workerStreamB.close();
    } finally {
      await hub.stop();
    }
  });
});
