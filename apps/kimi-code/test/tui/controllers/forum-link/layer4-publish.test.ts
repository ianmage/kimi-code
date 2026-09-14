import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Descriptor, Entry, UplinkFrame } from '@moonshot-ai/forum-link';
import type { Event, Session, Unsubscribe } from '@moonshot-ai/kimi-code-sdk';

import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { handleForumCommand } from '#/tui/commands/forum';
import { ForumLinkController } from '#/tui/controllers/forum-link';
import { Link } from '#/tui/controllers/forum-link/link';
import type { AppState } from '#/tui/types';

const HUB_MJS = fileURLToPath(new URL('../../../../../../packages/forum-link/dist/hub.mjs', import.meta.url));
const LINK_SOURCE = fileURLToPath(new URL('../../../../src/tui/controllers/forum-link/link.ts', import.meta.url));
const CONTROLLER_SOURCE = fileURLToPath(
  new URL('../../../../src/tui/controllers/forum-link/controller.ts', import.meta.url),
);
const HUB_BUILT = existsSync(HUB_MJS);

const PASSWORD = 'secret';
const SESSION_ID = 'layer4-session';

const LINK_TIMING = { heartbeatIntervalMs: 200, heartbeatTimeoutMs: 800, backoffBaseMs: 100, backoffCapMs: 300 };

interface ThreadSummaryJson {
  id: string;
  descriptor: Descriptor;
}

interface SnapshotJson {
  descriptor: Descriptor;
  entries: { seq: number; entry: Entry }[];
  maxSeq: number;
}

interface HubProcess {
  readonly baseUrl: string;
  readonly port: number;
  kill(): Promise<void>;
}

const liveChildren = new Map<ChildProcess, Promise<void>>();

function trackChild(child: ChildProcess): void {
  const exited = new Promise<void>((resolve) => {
    child.once('exit', resolve);
  });
  liveChildren.set(child, exited);
  void exited.then(() => {
    liveChildren.delete(child);
  });
}

afterAll(async () => {
  for (const child of [...liveChildren.keys()]) await stopChild(child);
});

async function stopChild(child: ChildProcess): Promise<void> {
  const exited = liveChildren.get(child);
  if (exited === undefined) return;
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
}

async function startHub(port?: number): Promise<HubProcess> {
  const child = spawn(
    process.execPath,
    [
      HUB_MJS,
      '--port',
      port === undefined ? '0' : String(port),
      '--password',
      PASSWORD,
      '--heartbeat-interval-ms',
      '300',
      '--liveness-window-ms',
      '1500',
      '--reap-interval-ms',
      '100',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  trackChild(child);
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    output += chunk;
  });
  const deadline = Date.now() + 5000;
  for (;;) {
    const match = /listening on http:\/\/(\S+):(\d+)/.exec(output);
    if (match !== null) {
      return {
        baseUrl: `http://127.0.0.1:${match[2]}`,
        port: Number(match[2]),
        kill: () => stopChild(child),
      };
    }
    if (child.exitCode !== null || Date.now() > deadline) {
      await stopChild(child);
      throw new Error(`hub process failed to start: ${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function startHubOnPort(port: number, attempts = 8): Promise<HubProcess> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await startHub(port);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw lastError;
}

async function getJson<T>(baseUrl: string, path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${PASSWORD}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

async function getThreads(baseUrl: string): Promise<ThreadSummaryJson[]> {
  const body = await getJson<{ threads: ThreadSummaryJson[] }>(baseUrl, '/api/threads');
  return body.threads;
}

async function getSnapshot(baseUrl: string, threadId: string): Promise<SnapshotJson> {
  return getJson<SnapshotJson>(baseUrl, `/api/threads/${threadId}/snapshot`);
}

async function until(predicate: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function messageTexts(snapshot: SnapshotJson, role: 'user' | 'assistant'): string[] {
  return snapshot.entries
    .filter((snapshotEntry) => snapshotEntry.entry.kind === 'message' && snapshotEntry.entry.role === role)
    .map((snapshotEntry) =>
      snapshotEntry.entry.kind === 'message' ? snapshotEntry.entry.text : '',
    );
}

interface SessionFixture {
  session: Session;
  emit(event: Event): void;
}

function makeSession(id = SESSION_ID): SessionFixture {
  const listeners = new Set<(event: Event) => void>();
  const session = {
    id,
    onEvent: (listener: (event: Event) => void): Unsubscribe => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    cancel: async () => {},
    cancelCompaction: async () => {},
  } as unknown as Session;
  return {
    session,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
  };
}

function promptSubmitted(text: string): Event {
  return {
    type: 'prompt.submitted',
    promptId: 'p1',
    userMessageId: 'um1',
    status: 'running',
    content: [{ type: 'text', text }],
    createdAt: '2025-01-01T00:00:00.000Z',
    agentId: 'main',
    sessionId: SESSION_ID,
  };
}

function turnStarted(): Event {
  return { type: 'turn.started', turnId: 1, origin: { kind: 'user' }, agentId: 'main', sessionId: SESSION_ID };
}

function turnEnded(reason: 'completed' | 'cancelled' = 'completed'): Event {
  return { type: 'turn.ended', turnId: 1, reason, agentId: 'main', sessionId: SESSION_ID };
}

function approvalPayload(id: string) {
  return {
    id,
    tool_call_id: `tc-${id}`,
    tool_name: 'Bash',
    action: 'PRE-PUBLISH-ACTION',
    description: 'pre publish approval',
    display: [],
    choices: [],
  };
}

type ForumLinkState = ForumLinkController['state'];

interface ControllerFixture {
  controller: ForumLinkController;
  frames: UplinkFrame[];
  statuses: string[];
  states: ForumLinkState[];
  session: SessionFixture;
}

function makeController(): ControllerFixture {
  const frames: UplinkFrame[] = [];
  const statuses: string[] = [];
  const states: ForumLinkState[] = [];
  const sessionFixture = makeSession();
  const controller = new ForumLinkController({
    onProjectorFrame: (frame) => {
      frames.push(frame);
    },
    onStatus: (message) => {
      statuses.push(message);
    },
    getAppState: () => ({ isCompacting: false }) as AppState,
    buildDescriptor: (session: Session): Descriptor => ({
      sessionId: session.id,
      machineName: 'layer4-machine',
      projectName: 'layer4-project',
      title: 'layer4 title',
      status: 'idle',
    }),
    createLink: (handlers) =>
      new Link({
        ...handlers,
        timing: LINK_TIMING,
        onStateChange: (state) => {
          states.push(state);
          handlers.onStateChange(state);
        },
      }),
  });
  controller.onSessionChanged(sessionFixture.session);
  return { controller, frames, statuses, states, session: sessionFixture };
}

describe('Layer4 真发布 — 发布出现与 toggle 消失（CP5 / M-1 IV1 A1 A2）', () => {
  it.skipIf(!HUB_BUILT)(
    'start 发布线程且 descriptor 正确，帧上行入 hub，stop 后线程经 reap 消失',
    { timeout: 20000 },
    async () => {
      const hub = await startHub();
      const fixture = makeController();
      try {
        expect(await getThreads(hub.baseUrl)).toEqual([]);

        await fixture.controller.start({ url: hub.baseUrl, password: PASSWORD });
        expect(fixture.controller.state).toBe('published');
        expect(fixture.statuses).toContain('Forum Link: published');

        const threads = await getThreads(hub.baseUrl);
        expect(threads).toHaveLength(1);
        expect(threads[0]!.descriptor).toEqual({
          sessionId: SESSION_ID,
          machineName: 'layer4-machine',
          projectName: 'layer4-project',
          title: 'layer4 title',
          status: 'idle',
        });
        const threadId = threads[0]!.id;

        fixture.session.emit(promptSubmitted('hello from layer4'));
        fixture.session.emit(turnStarted());
        fixture.session.emit(turnEnded('completed'));
        let snapshot = await getSnapshot(hub.baseUrl, threadId);
        await until(async () => {
          snapshot = await getSnapshot(hub.baseUrl, threadId);
          return messageTexts(snapshot, 'user').includes('hello from layer4');
        });
        expect(messageTexts(snapshot, 'user')).toEqual(['hello from layer4']);
        expect(snapshot.entries.map((snapshotEntry) => snapshotEntry.seq)).toEqual([1, 2, 3]);

        await fixture.controller.stop();
        expect(fixture.controller.state).toBe('detached');
        expect(fixture.statuses).toContain('Forum Link: unpublished');
        await until(async () => (await getThreads(hub.baseUrl)).length === 0);
      } finally {
        await fixture.controller.stop().catch(() => {});
        await hub.kill();
      }
    },
  );
});

describe('Layer4 真发布 — 时间线自发布时刻累积（CP5 / M-1 A4 / D-I）', () => {
  it.skipIf(!HUB_BUILT)('发布前帧不回填，发布后新事件 seq 从 1 开始', { timeout: 20000 }, async () => {
    const hub = await startHub();
    const fixture = makeController();
    try {
      fixture.controller.onCardOpened('approval', 'up-1', approvalPayload('up-1'));
      expect(fixture.frames).toContainEqual({
        type: 'entry',
        entry: {
          kind: 'approval-card',
          cardId: 'c1',
          toolName: 'Bash',
          action: 'PRE-PUBLISH-ACTION',
          summary: 'pre publish approval',
        },
      });

      await fixture.controller.start({ url: hub.baseUrl, password: PASSWORD });
      const threads = await getThreads(hub.baseUrl);
      expect(threads).toHaveLength(1);
      const threadId = threads[0]!.id;
      let snapshot = await getSnapshot(hub.baseUrl, threadId);
      expect(snapshot.entries).toEqual([]);
      expect(snapshot.maxSeq).toBe(0);

      fixture.session.emit(promptSubmitted('after publish'));
      fixture.session.emit(turnStarted());
      fixture.session.emit(turnEnded('completed'));
      await until(async () => {
        snapshot = await getSnapshot(hub.baseUrl, threadId);
        return snapshot.entries.length === 3;
      });
      expect(snapshot.entries[0]!.seq).toBe(1);
      expect(snapshot.entries.map((snapshotEntry) => snapshotEntry.seq)).toEqual([1, 2, 3]);
      expect(messageTexts(snapshot, 'user')).toEqual(['after publish']);
      expect(JSON.stringify(snapshot.entries)).not.toContain('PRE-PUBLISH-ACTION');
    } finally {
      await fixture.controller.stop().catch(() => {});
      await hub.kill();
    }
  });
});

describe('Layer4 真发布 — 凭证缺失零连接（CP5 / M-1 A3）', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'forum-layer4-'));
    vi.stubEnv('KIMI_CODE_HOME', homeDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it.skipIf(!HUB_BUILT)('凭证缺失时 showError 指引且 hub 注册表保持空', { timeout: 20000 }, async () => {
    const hub = await startHub();
    try {
      const host = makeCommandHost();
      await handleForumCommand(host);

      expect(host.showError).toHaveBeenCalledTimes(1);
      expect(host.showError.mock.calls[0]?.[0]).toContain('remote_key');
      expect(host.ensureForumLink).not.toHaveBeenCalled();
      expect(host.showStatus).not.toHaveBeenCalled();
      expect(await getThreads(hub.baseUrl)).toEqual([]);
      expect(readdirSync(homeDir)).toEqual([]);
    } finally {
      await hub.kill();
    }
  });
});

function makeCommandHost(): SlashCommandHost & {
  showError: ReturnType<typeof vi.fn>;
  showStatus: ReturnType<typeof vi.fn>;
  ensureForumLink: ReturnType<typeof vi.fn>;
} {
  return {
    session: { id: 'layer4-cmd' },
    showError: vi.fn(),
    showStatus: vi.fn(),
    ensureForumLink: vi.fn(),
  } as unknown as SlashCommandHost & {
    showError: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    ensureForumLink: ReturnType<typeof vi.fn>;
  };
}

describe('Layer4 真发布 — 断链恢复（CP5 / V-3 Checkpoint / A10 部分）', () => {
  it.skipIf(!HUB_BUILT)(
    'hub 进程死亡进入 backoff，同端口重启后恢复 published 并重注册新线程',
    { timeout: 30000 },
    async () => {
      const hub = await startHub();
      const fixture = makeController();
      try {
        await fixture.controller.start({ url: hub.baseUrl, password: PASSWORD });
        expect(fixture.controller.state).toBe('published');
        const firstThreads = await getThreads(hub.baseUrl);
        expect(firstThreads).toHaveLength(1);
        const firstThreadId = firstThreads[0]!.id;

        await hub.kill();
        await until(() => fixture.controller.state === 'backoff');

        const hub2 = await startHubOnPort(hub.port);
        try {
          await until(() => fixture.controller.state === 'published');
          const lastBackoff = fixture.states.lastIndexOf('backoff');
          const lastConnecting = fixture.states.lastIndexOf('connecting');
          const lastPublished = fixture.states.lastIndexOf('published');
          expect(lastBackoff).toBeGreaterThan(-1);
          expect(lastConnecting).toBeGreaterThan(lastBackoff);
          expect(lastPublished).toBeGreaterThan(lastConnecting);

          const recoveredThreads = await getThreads(hub2.baseUrl);
          expect(recoveredThreads).toHaveLength(1);
          expect(recoveredThreads[0]!.descriptor.sessionId).toBe(SESSION_ID);
          expect(recoveredThreads[0]!.id).not.toBe(firstThreadId);

          fixture.session.emit(promptSubmitted('after recovery'));
          fixture.session.emit(turnStarted());
          fixture.session.emit(turnEnded('completed'));
          const threadId = recoveredThreads[0]!.id;
          let snapshot = await getSnapshot(hub2.baseUrl, threadId);
          await until(async () => {
            snapshot = await getSnapshot(hub2.baseUrl, threadId);
            return messageTexts(snapshot, 'user').includes('after recovery');
          });
          expect(messageTexts(snapshot, 'user')).toEqual(['after recovery']);
        } finally {
          await hub2.kill();
        }
      } finally {
        await fixture.controller.stop().catch(() => {});
        await hub.kill();
      }
    },
  );
});

describe('Layer4 真发布 — 零监听审计（CP5 / V-3 A1 / I9）', () => {
  it.skipIf(!HUB_BUILT)(
    'Link/Controller 源码无监听调用，发布期间测试进程零新增 Server 句柄',
    { timeout: 20000 },
    async () => {
      expect(readFileSync(LINK_SOURCE, 'utf8')).not.toMatch(/createServer|\.listen\(/);
      expect(readFileSync(CONTROLLER_SOURCE, 'utf8')).not.toMatch(/createServer|\.listen\(/);

      const hub = await startHub();
      const fixture = makeController();
      try {
        const before = serverHandleCount();
        await fixture.controller.start({ url: hub.baseUrl, password: PASSWORD });
        expect(fixture.controller.state).toBe('published');
        fixture.session.emit(promptSubmitted('zero listen'));
        fixture.session.emit(turnStarted());
        fixture.session.emit(turnEnded('completed'));
        await new Promise((resolve) => setTimeout(resolve, 400));
        const during = serverHandleCount();
        await fixture.controller.stop();
        await new Promise((resolve) => setTimeout(resolve, 400));
        const after = serverHandleCount();
        if (before !== undefined && during !== undefined && after !== undefined) {
          expect(during).toBe(before);
          expect(after).toBe(before);
        }
      } finally {
        await fixture.controller.stop().catch(() => {});
        await hub.kill();
      }
    },
  );
});

function serverHandleCount(): number | undefined {
  const getActiveHandles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
  if (getActiveHandles === undefined) return undefined;
  return getActiveHandles.call(process).filter((handle) => constructorNameOf(handle) === 'Server').length;
}

function constructorNameOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as { constructor?: { name?: string } }).constructor?.name;
}
