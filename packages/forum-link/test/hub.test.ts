import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Descriptor, Entry } from '#/contract/frames';
import { ThreadBuffer } from '#/hub/buffer';
import { Gate, formatStartupBanner } from '#/hub/gate';
import type { HubServer, HubServerOptions } from '#/hub/router';
import { createHubServer } from '#/hub/router';
import { Registry } from '#/hub/registry';

const hubSrcDir = fileURLToPath(new URL('../src/hub', import.meta.url));

function descriptorOf(sessionId: string): Descriptor {
  return {
    sessionId,
    machineName: 'machine-1',
    projectName: 'project-1',
    title: 'Fix login bug',
    status: 'running',
  };
}

function message(text: string): Entry {
  return { kind: 'message', role: 'user', text };
}

describe('Phase 1.3 hub domain', () => {
  let probeDir: string;
  let probeBefore: string[];

  beforeAll(() => {
    probeDir = mkdtempSync(join(tmpdir(), 'forum-link-hub-'));
    probeBefore = readdirSync(probeDir);
  });

  afterAll(() => {
    rmSync(probeDir, { recursive: true, force: true });
  });

  it('evicts oldest entries beyond the capacity while maxSeq keeps the true total', () => {
    const buffer = new ThreadBuffer({ bufferSize: 3 });
    const seqs: number[] = [];
    for (let i = 1; i <= 5; i += 1) {
      seqs.push(buffer.append(message(`m${i}`)));
    }
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    const snapshot = buffer.snapshot();
    expect(snapshot.entries).toHaveLength(3);
    expect(snapshot.entries.map((item) => item.seq)).toEqual([3, 4, 5]);
    expect(snapshot.entries.map((item) => item.entry)).toEqual([
      message('m3'),
      message('m4'),
      message('m5'),
    ]);
    expect(snapshot.maxSeq).toBe(5);
    expect(snapshot.descriptor).toBeUndefined();

    const defaultBuffer = new ThreadBuffer();
    for (let i = 1; i <= 51; i += 1) {
      defaultBuffer.append(message(`d${i}`));
    }
    const defaultSnapshot = defaultBuffer.snapshot();
    expect(defaultSnapshot.entries).toHaveLength(50);
    expect(defaultSnapshot.entries[0]?.seq).toBe(2);
    expect(defaultSnapshot.maxSeq).toBe(51);
  });

  it('registers open cards and settles them by cardId', () => {
    const buffer = new ThreadBuffer();
    buffer.append({
      kind: 'question-card',
      cardId: 'q1',
      question: 'Which fix?',
      options: ['quick', 'proper'],
    });
    buffer.append({
      kind: 'approval-card',
      cardId: 'a1',
      toolName: 'Bash',
      action: 'exec',
      summary: 'rm -rf build',
    });
    expect(buffer.snapshot().openCards).toEqual([
      { cardId: 'q1', kind: 'question', state: 'open' },
      { cardId: 'a1', kind: 'approval', state: 'open' },
    ]);
    buffer.append({ kind: 'card-settled', cardId: 'q1', outcome: 'answered' });
    buffer.settleCard('a1', 'rejected');
    expect(buffer.snapshot().openCards).toEqual([
      { cardId: 'q1', kind: 'question', state: 'answered' },
      { cardId: 'a1', kind: 'approval', state: 'rejected' },
    ]);
  });

  it('keeps a settled state when the open frame arrives late', () => {
    const buffer = new ThreadBuffer();
    buffer.settleCard('c1', 'approved');
    buffer.append({
      kind: 'approval-card',
      cardId: 'c1',
      toolName: 'Bash',
      action: 'exec',
      summary: 'rm -rf build',
    });
    expect(buffer.snapshot().openCards).toEqual([{ cardId: 'c1', kind: 'approval', state: 'approved' }]);
  });

  it('resets seq, entries and open cards', () => {
    const buffer = new ThreadBuffer();
    buffer.append(message('hi'));
    buffer.append({ kind: 'question-card', cardId: 'q1', question: 'Which fix?', options: ['quick'] });
    buffer.append({ kind: 'card-settled', cardId: 'q1', outcome: 'answered' });
    buffer.reset();
    const snapshot = buffer.snapshot();
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.maxSeq).toBe(0);
    expect(snapshot.openCards).toEqual([]);
    expect(buffer.append(message('again'))).toBe(1);
  });

  it('finds live threads by sessionId and forgets removed ones', () => {
    const registry = new Registry();
    const first = registry.create(descriptorOf('session-1'));
    const second = registry.create(descriptorOf('session-2'));
    expect(registry.findLiveBySessionId('session-1')).toBe(first);
    expect(registry.findLiveBySessionId('session-2')).toBe(second);
    expect(registry.findLiveBySessionId('session-x')).toBeUndefined();
    registry.remove(first.id);
    expect(registry.findLiveBySessionId('session-1')).toBeUndefined();
    expect(registry.get(first.id)).toBeUndefined();
    expect(registry.get(second.id)).toBe(second);
  });

  it('isolates seq and buffers across connections sharing one sessionId', () => {
    const registry = new Registry();
    const first = registry.create(descriptorOf('session-1'));
    const second = registry.create(descriptorOf('session-1'));
    expect(first.id).not.toBe(second.id);
    expect(first.buffer.append(message('a'))).toBe(1);
    expect(second.buffer.append(message('b'))).toBe(1);
    expect(first.buffer.append(message('c'))).toBe(2);
    expect(second.buffer.snapshot().maxSeq).toBe(1);
    expect(first.buffer.snapshot().entries.map((item) => item.seq)).toEqual([1, 2]);
    expect(second.buffer.snapshot().entries.map((item) => item.entry)).toEqual([message('b')]);
  });

  it('reaps threads only past the liveness window', () => {
    const registry = new Registry({ livenessWindowMs: 50 });
    const thread = registry.create(descriptorOf('session-1'));
    const now = thread.lastSignalAt;
    expect(registry.reap(now)).toEqual([]);
    expect(registry.get(thread.id)).toBe(thread);
    expect(registry.reap(now + 50)).toEqual([]);
    expect(registry.reap(now + 51)).toEqual([thread.id]);
    expect(registry.get(thread.id)).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it('refreshes lastSignalAt on touch', () => {
    const thread = new Registry().create(descriptorOf('session-1'));
    const stale = thread.lastSignalAt - 1000;
    thread.lastSignalAt = stale;
    thread.touch();
    expect(thread.lastSignalAt).toBeGreaterThan(stale);
  });

  it('lists thread summaries carrying the connection id and current descriptor', () => {
    const registry = new Registry();
    const thread = registry.create(descriptorOf('session-1'));
    const updated: Descriptor = { ...descriptorOf('session-1'), title: 'Shipped', status: 'idle' };
    thread.descriptor = updated;
    expect(registry.list()).toEqual([{ id: thread.id, descriptor: updated }]);
  });

  it('keeps the hub domain off the filesystem', () => {
    expect(readdirSync(probeDir)).toEqual(probeBefore);
    for (const file of ['buffer.ts', 'registry.ts']) {
      const code = readFileSync(`${hubSrcDir}/${file}`, 'utf8');
      expect(code, file).not.toMatch(/node:fs|from ['"]fs['"]|writeFile|appendFile/);
    }
  });
});

describe('Phase 1.4 gate', () => {
  it('returns ok for the right password, unauthorized for a wrong or missing one', () => {
    const gate = new Gate({ password: 'secret' });
    expect(gate.check('ip-1', 'secret')).toBe('ok');
    expect(gate.check('ip-1', 'wrong')).toBe('unauthorized');
    expect(gate.check('ip-1', undefined)).toBe('unauthorized');
  });

  it('admits everything in open mode, including missing credentials', () => {
    const gate = new Gate({ password: '' });
    expect(gate.isOpen).toBe(true);
    expect(gate.check('ip-1', undefined)).toBe('ok');
    expect(gate.check('ip-1', 'anything')).toBe('ok');
  });

  it('rate-limits a source after maxFailures consecutive wrong passwords, even with the right one', () => {
    const gate = new Gate({ password: 'secret', windowMs: 100 });
    for (let i = 0; i < 5; i += 1) {
      expect(gate.check('ip-1', 'wrong', 1000)).toBe('unauthorized');
    }
    expect(gate.check('ip-1', 'secret', 1000)).toBe('rate-limited');
  });

  it('resets the failure count once the window has elapsed', () => {
    const gate = new Gate({ password: 'secret', windowMs: 100 });
    for (let i = 0; i < 5; i += 1) {
      expect(gate.check('ip-1', 'wrong', 1000)).toBe('unauthorized');
    }
    expect(gate.check('ip-1', 'wrong', 1101)).toBe('unauthorized');
    for (let i = 0; i < 4; i += 1) {
      expect(gate.check('ip-1', 'wrong', 1101)).toBe('unauthorized');
    }
    expect(gate.check('ip-1', 'secret', 1101)).toBe('rate-limited');
  });

  it('clears the failure count of a source after a successful login', () => {
    const gate = new Gate({ password: 'secret', windowMs: 100000 });
    for (let i = 0; i < 4; i += 1) {
      expect(gate.check('ip-1', 'wrong', 1000)).toBe('unauthorized');
    }
    expect(gate.check('ip-1', 'secret', 1000)).toBe('ok');
    for (let i = 0; i < 4; i += 1) {
      expect(gate.check('ip-1', 'wrong', 1000)).toBe('unauthorized');
    }
    expect(gate.check('ip-1', 'wrong', 1000)).toBe('unauthorized');
  });

  it('lets noteSuccess lift an already rate-limited source', () => {
    const gate = new Gate({ password: 'secret', windowMs: 100000 });
    for (let i = 0; i < 5; i += 1) {
      gate.check('ip-1', 'wrong', 1000);
    }
    expect(gate.check('ip-1', 'secret', 1000)).toBe('rate-limited');
    gate.noteSuccess('ip-1');
    expect(gate.check('ip-1', 'wrong', 1000)).toBe('unauthorized');
  });

  it('isolates rate limiting per source', () => {
    const gate = new Gate({ password: 'secret', windowMs: 100 });
    for (let i = 0; i < 5; i += 1) {
      gate.check('ip-a', 'wrong', 1000);
    }
    expect(gate.check('ip-a', 'secret', 1000)).toBe('rate-limited');
    expect(gate.check('ip-b', 'wrong', 1000)).toBe('unauthorized');
    expect(gate.check('ip-b', 'secret', 1000)).toBe('ok');
  });

  it('compares passwords through a constant-time path only', () => {
    const code = readFileSync(`${hubSrcDir}/gate.ts`, 'utf8');
    expect(code).toMatch(/timingSafeEqual/);
    expect(code).not.toMatch(/password ===/);
  });

  it('renders the open-mode warning in the startup banner', () => {
    const banner = formatStartupBanner({ password: '', maxFailures: 5, windowMs: 60000 });
    expect(banner).toContain('OPEN mode');
    expect(banner).toContain('WARNING');
    expect(banner).toContain('rate limit: 5 failures per 60000ms per source');
    expect(banner).not.toContain('auth: password required');
  });

  it('renders the password-required line in the startup banner', () => {
    const banner = formatStartupBanner({ password: 'secret', maxFailures: 5, windowMs: 60000 });
    expect(banner).toContain('auth: password required');
    expect(banner).toContain('rate limit: 5 failures per 60000ms per source');
    expect(banner).not.toContain('OPEN mode');
    expect(banner).not.toContain('WARNING');
  });
});

describe('Phase 1.5 hub http', () => {
  const AUTH = { Authorization: 'Bearer secret' };

  let hub: HubServer;
  let baseUrl: string;

  async function startHub(options: Partial<HubServerOptions> = {}): Promise<HubServer> {
    const server = createHubServer({ password: 'secret', ...options });
    await listen(server);
    return server;
  }

  async function listen(server: HubServer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      server.server.once('error', reject);
      server.server.listen(0, '127.0.0.1', () => {
        server.server.off('error', reject);
        resolve();
      });
    });
  }

  async function urlOf(server: HubServer): Promise<string> {
    const address = server.server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    return `http://127.0.0.1:${address.port}`;
  }

  async function registerThread(base: string, sessionId = 'session-1'): Promise<string> {
    const res = await fetch(`${base}/api/register`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(descriptorOf(sessionId)),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  async function openStream(base: string, threadId: string): Promise<Response> {
    const res = await fetch(`${base}/api/stream/${threadId}`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();
    return res;
  }

  async function readFor(res: Response, ms: number): Promise<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const read = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return 'eof';
        text += decoder.decode(value, { stream: true });
      }
    })();
    const timer = new Promise<'timeout'>((resolve) => {
      setTimeout(() => {
        resolve('timeout');
      }, ms);
    });
    const outcome = await Promise.race([timer, read]);
    await reader.cancel();
    return text;
  }

  afterEach(async () => {
    if (hub !== undefined) {
      await hub.close();
      hub = undefined as unknown as HubServer;
    }
  });

  it('rejects api routes without credentials or with a wrong password, but serves the page', async () => {
    hub = await startHub();
    baseUrl = await urlOf(hub);

    const anonymous = await fetch(`${baseUrl}/api/threads`);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.text()).toBe('{"error":"unauthorized"}');

    const wrong = await fetch(`${baseUrl}/api/threads`, { headers: { Authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toBe('{"error":"unauthorized"}');

    const viaQuery = await fetch(`${baseUrl}/api/threads?key=secret`);
    expect(viaQuery.status).toBe(200);
    expect(await viaQuery.json()).toEqual({ threads: [] });

    const page = await fetch(`${baseUrl}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('<h1>Forum Link</h1>');
  });

  it('rate-limits a source after repeated wrong passwords', async () => {
    hub = await startHub();
    baseUrl = await urlOf(hub);
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(`${baseUrl}/api/threads`, { headers: { Authorization: 'Bearer nope' } });
      expect(res.status).toBe(401);
    }
    const limited = await fetch(`${baseUrl}/api/threads`, { headers: { Authorization: 'Bearer nope' } });
    expect(limited.status).toBe(429);
    expect(await limited.text()).toBe('{"error":"rate limited"}');
  });

  it('rejects out-of-protocol action payloads before fanout and never relays them', async () => {
    hub = await startHub({ heartbeatIntervalMs: 30 });
    baseUrl = await urlOf(hub);
    const threadId = await registerThread(baseUrl);
    const stream = await openStream(baseUrl, threadId);

    const hostile = await fetch(`${baseUrl}/api/action`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'approve', target: threadId, cardId: 'c1', approved_for_session: true }),
    });
    expect(hostile.status).toBe(400);
    expect(await hostile.text()).toBe('{"error":"invalid action"}');

    const recorded = await readFor(stream, 150);
    expect(recorded).not.toContain('data:');
    expect((recorded.match(/: heartbeat/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('answers 404 for actions aimed at an unknown thread and leaves other threads intact', async () => {
    hub = await startHub();
    baseUrl = await urlOf(hub);
    const threadId = await registerThread(baseUrl);

    const missingTarget = await fetch(`${baseUrl}/api/action`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'approve', cardId: 'c1' }),
    });
    expect(missingTarget.status).toBe(400);
    expect(await missingTarget.text()).toBe('{"error":"invalid action"}');

    const missingCard = await fetch(`${baseUrl}/api/action`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'approve', target: threadId }),
    });
    expect(missingCard.status).toBe(400);
    expect(await missingCard.text()).toBe('{"error":"invalid action"}');

    const stream = await openStream(baseUrl, threadId);

    const missing = await fetch(`${baseUrl}/api/action`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'approve', target: 'no-such-thread', cardId: 'c1' }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('{"error":"unknown thread"}');

    const unknownStream = await fetch(`${baseUrl}/api/stream/no-such-thread`, { headers: AUTH });
    expect(unknownStream.status).toBe(404);
    expect(await unknownStream.text()).toBe('{"error":"unknown thread"}');

    const unknownSnapshot = await fetch(`${baseUrl}/api/threads/no-such-thread/snapshot`, { headers: AUTH });
    expect(unknownSnapshot.status).toBe(404);

    const entryRes = await fetch(`${baseUrl}/api/entry?target=${threadId}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'entry', entry: message('still alive') }),
    });
    expect(entryRes.status).toBe(200);
    const recorded = await readFor(stream, 120);
    expect(recorded).toContain('still alive');
  });

  it('runs register, entry fanout to two subscribers, and snapshot end to end', async () => {
    hub = await startHub();
    baseUrl = await urlOf(hub);

    const registerRes = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(descriptorOf('session-1')),
    });
    expect(registerRes.status).toBe(200);
    const { id: threadId } = (await registerRes.json()) as { id: string };

    const first = await openStream(baseUrl, threadId);
    const second = await openStream(baseUrl, threadId);

    const entryRes = await fetch(`${baseUrl}/api/entry?target=${threadId}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'entry', entry: message('hello forum') }),
    });
    expect(entryRes.status).toBe(200);

    const firstText = await readFor(first, 120);
    const secondText = await readFor(second, 120);
    expect(firstText).toBe(secondText);
    expect(firstText).toContain('"seq":1');
    expect(firstText).toContain('hello forum');

    const snapshotRes = await fetch(`${baseUrl}/api/threads/${threadId}/snapshot`, { headers: AUTH });
    expect(snapshotRes.status).toBe(200);
    const snapshot = (await snapshotRes.json()) as Record<string, unknown>;
    expect(Object.keys(snapshot).toSorted()).toEqual(['descriptor', 'entries', 'maxSeq', 'openCards']);
    expect(snapshot['maxSeq']).toBe(1);
    expect((snapshot['entries'] as Array<{ seq: number }>).at(0)?.seq).toBe(1);
  });

  it('sends sse heartbeats on the injected cadence with the required headers', async () => {
    hub = await startHub({ heartbeatIntervalMs: 40 });
    baseUrl = await urlOf(hub);
    const threadId = await registerThread(baseUrl);

    const res = await fetch(`${baseUrl}/api/stream/${threadId}`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const text = await readFor(res, 240);
    const beats = text.match(/: heartbeat/g) ?? [];
    expect(beats.length).toBeGreaterThanOrEqual(4);
    expect(beats.length).toBeLessThanOrEqual(8);
  });

  it('reaps stale threads on the injected cadence and closes their subscriptions', async () => {
    hub = await startHub({ livenessWindowMs: 60, reapIntervalMs: 30 });
    baseUrl = await urlOf(hub);
    const threadId = await registerThread(baseUrl);
    const res = await fetch(`${baseUrl}/api/stream/${threadId}`, { headers: AUTH });
    expect(res.status).toBe(200);

    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const listRes = await fetch(`${baseUrl}/api/threads`, { headers: AUTH });
      const list = (await listRes.json()) as { threads: Array<{ id: string }> };
      if (list.threads.length === 0) break;
    }
    const listRes = await fetch(`${baseUrl}/api/threads`, { headers: AUTH });
    const list = (await listRes.json()) as { threads: Array<{ id: string }> };
    expect(list.threads).toEqual([]);

    const chunks: Uint8Array[] = [];
    const outcome = await Promise.race([
      (async () => {
        for await (const chunk of res.body!) chunks.push(chunk as Uint8Array);
        return 'eof';
      })(),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => {
          resolve('timeout');
        }, 300);
      }),
    ]);
    expect(outcome).toBe('eof');
    expect(Buffer.concat(chunks).toString('utf8')).not.toContain('data: {');
  });

  it('forwards valid action frames to the thread stream as action frames', async () => {
    hub = await startHub();
    baseUrl = await urlOf(hub);
    const threadId = await registerThread(baseUrl);
    const stream = await openStream(baseUrl, threadId);

    const actionRes = await fetch(`${baseUrl}/api/action`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'approve', target: threadId, cardId: 'card-9' }),
    });
    expect(actionRes.status).toBe(200);

    const recorded = await readFor(stream, 120);
    expect(recorded).toContain('data: {"action":');
    expect(recorded).toContain('"cardId":"card-9"');
  });

  it('refreshes liveness when the tui posts heartbeats', async () => {
    hub = await startHub({ livenessWindowMs: 80, reapIntervalMs: 20 });
    baseUrl = await urlOf(hub);
    const threadId = await registerThread(baseUrl);

    for (let beat = 0; beat < 4; beat += 1) {
      await new Promise((resolve) => setTimeout(resolve, 45));
      const beatRes = await fetch(`${baseUrl}/api/heartbeat`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ target: threadId }),
      });
      expect(beatRes.status).toBe(200);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));

    const listRes = await fetch(`${baseUrl}/api/threads`, { headers: AUTH });
    const list = (await listRes.json()) as { threads: Array<{ id: string }> };
    expect(list.threads.map((thread) => thread.id)).toEqual([threadId]);
  });

  it('keeps re-registering the same sessionId as fresh independent threads', async () => {
    hub = await startHub();
    baseUrl = await urlOf(hub);
    const firstId = await registerThread(baseUrl, 'session-dup');
    const secondId = await registerThread(baseUrl, 'session-dup');
    expect(firstId).not.toBe(secondId);

    const entryRes = await fetch(`${baseUrl}/api/entry?target=${secondId}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'entry', entry: message('second only') }),
    });
    expect(entryRes.status).toBe(200);

    const firstSnapshot = await (await fetch(`${baseUrl}/api/threads/${firstId}/snapshot`, { headers: AUTH })).json();
    const secondSnapshot = await (
      await fetch(`${baseUrl}/api/threads/${secondId}/snapshot`, { headers: AUTH })
    ).json();
    expect((firstSnapshot as { entries: unknown[] }).entries).toEqual([]);
    expect((secondSnapshot as { entries: unknown[] }).entries).toHaveLength(1);
  });
});

describe('Phase 1.6 snapshot alignment', () => {
  const AUTH = { Authorization: 'Bearer secret' };

  let hub: HubServer;
  let baseUrl: string;

  async function startHub(options: Partial<HubServerOptions> = {}): Promise<void> {
    hub = createHubServer({ password: 'secret', ...options });
    await new Promise<void>((resolve, reject) => {
      hub.server.once('error', reject);
      hub.server.listen(0, '127.0.0.1', () => {
        hub.server.off('error', reject);
        resolve();
      });
    });
    const address = hub.server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async function registerThread(sessionId = 'session-1'): Promise<string> {
    const res = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(descriptorOf(sessionId)),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  async function postFrame(threadId: string, frame: unknown): Promise<Response> {
    return fetch(`${baseUrl}/api/entry?target=${threadId}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(frame),
    });
  }

  async function getSnapshot(threadId: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${baseUrl}/api/threads/${threadId}/snapshot`, { headers: AUTH });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  async function openStream(threadId: string): Promise<Response> {
    const res = await fetch(`${baseUrl}/api/stream/${threadId}`, { headers: AUTH });
    expect(res.status).toBe(200);
    return res;
  }

  async function readFor(res: Response, ms: number): Promise<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const read = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return 'eof';
        text += decoder.decode(value, { stream: true });
      }
    })();
    const timer = new Promise<'timeout'>((resolve) => {
      setTimeout(() => {
        resolve('timeout');
      }, ms);
    });
    const outcome = await Promise.race([timer, read]);
    await reader.cancel();
    return text;
  }

  afterEach(async () => {
    if (hub !== undefined) {
      await hub.close();
      hub = undefined as unknown as HubServer;
    }
  });

  it('returns a snapshot with exactly the four contract keys', async () => {
    await startHub();
    const threadId = await registerThread();
    await postFrame(threadId, { type: 'entry', entry: message('first') });
    await postFrame(threadId, { type: 'entry', entry: message('second') });

    const snapshot = await getSnapshot(threadId);
    expect(Object.keys(snapshot).toSorted()).toEqual(['descriptor', 'entries', 'maxSeq', 'openCards']);
    expect(snapshot['entries']).toEqual([
      { seq: 1, entry: message('first') },
      { seq: 2, entry: message('second') },
    ]);
    expect(snapshot['maxSeq']).toBe(2);
    expect(snapshot['descriptor']).toEqual(descriptorOf('session-1'));
    expect(snapshot['openCards']).toEqual([]);
  });

  it('keeps seq monotonic and maxSeq at the true total after eviction', async () => {
    await startHub({ bufferSize: 3 });
    const threadId = await registerThread();
    for (const text of ['m1', 'm2', 'm3', 'm4', 'm5']) {
      const res = await postFrame(threadId, { type: 'entry', entry: message(text) });
      expect(res.status).toBe(200);
    }

    const snapshot = await getSnapshot(threadId);
    const entries = snapshot['entries'] as Array<{ seq: number; entry: Entry }>;
    expect(entries).toHaveLength(3);
    expect(entries.map((item) => item.seq)).toEqual([3, 4, 5]);
    expect(entries.map((item) => item.entry)).toEqual([message('m3'), message('m4'), message('m5')]);
    expect(snapshot['maxSeq']).toBe(5);
  });

  it('resets the thread when the entry endpoint receives a register frame', async () => {
    await startHub();
    const threadId = await registerThread();
    const stream = await openStream(threadId);
    for (const text of ['a', 'b', 'c']) {
      await postFrame(threadId, { type: 'entry', entry: message(text) });
    }
    const approval: Entry = {
      kind: 'approval-card',
      cardId: 'c1',
      toolName: 'Bash',
      action: 'exec',
      summary: 'rm -rf build',
    };
    await postFrame(threadId, { type: 'entry', entry: approval });

    const nextDescriptor: Descriptor = {
      sessionId: 'session-2',
      machineName: 'machine-1',
      projectName: 'project-1',
      title: 'New session',
      status: 'running',
    };
    const registerRes = await postFrame(threadId, { type: 'register', descriptor: nextDescriptor });
    expect(registerRes.status).toBe(200);

    const recorded = await readFor(stream, 120);
    expect(recorded).toContain('data: {"reset":true,"descriptor":');
    expect(recorded).toContain('"sessionId":"session-2"');

    const snapshot = await getSnapshot(threadId);
    expect(snapshot['entries']).toEqual([]);
    expect(snapshot['maxSeq']).toBe(0);
    expect(snapshot['openCards']).toEqual([]);
    expect(snapshot['descriptor']).toEqual(nextDescriptor);

    const entryRes = await postFrame(threadId, { type: 'entry', entry: message('fresh') });
    expect(entryRes.status).toBe(200);
    expect(await entryRes.json()).toEqual({ seq: 1 });
  });

  it('settles cards by cardId over http and never regresses to open', async () => {
    await startHub();
    const threadId = await registerThread();
    const approval: Entry = {
      kind: 'approval-card',
      cardId: 'c1',
      toolName: 'Bash',
      action: 'exec',
      summary: 'rm -rf build',
    };
    await postFrame(threadId, { type: 'entry', entry: approval });
    await postFrame(threadId, { type: 'entry', entry: { kind: 'card-settled', cardId: 'c1', outcome: 'approved' } });

    const settled = await getSnapshot(threadId);
    expect(settled['openCards']).toEqual([{ cardId: 'c1', kind: 'approval', state: 'approved' }]);

    await postFrame(threadId, { type: 'entry', entry: approval });
    const reopened = await getSnapshot(threadId);
    expect(reopened['openCards']).toEqual([{ cardId: 'c1', kind: 'approval', state: 'approved' }]);
  });

  it('fans descriptor frames out to subscribers and refreshes listings', async () => {
    await startHub();
    const threadId = await registerThread();
    const stream = await openStream(threadId);

    const updated: Descriptor = { ...descriptorOf('session-1'), title: 'Shipped', status: 'idle' };
    const descriptorRes = await postFrame(threadId, { type: 'descriptor', descriptor: updated });
    expect(descriptorRes.status).toBe(200);

    const recorded = await readFor(stream, 120);
    expect(recorded).toContain('data: {"descriptor":');
    expect(recorded).toContain('"status":"idle"');

    const listRes = await fetch(`${baseUrl}/api/threads`, { headers: AUTH });
    const list = (await listRes.json()) as { threads: Array<{ id: string; descriptor: Descriptor }> };
    expect(list.threads).toEqual([{ id: threadId, descriptor: updated }]);

    const snapshot = await getSnapshot(threadId);
    expect(snapshot['descriptor']).toEqual(updated);
  });

  it('answers 404 for register frames aimed at an unknown thread', async () => {
    await startHub();
    const res = await postFrame('no-such-thread', { type: 'register', descriptor: descriptorOf('session-1') });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('{"error":"unknown thread"}');
  });
});

describe('Phase 1.7 layer1 hub integration', () => {
  const AUTH = { Authorization: 'Bearer secret' };
  const HUB_MJS = fileURLToPath(new URL('../dist/hub.mjs', import.meta.url));

  let hub: HubServer;
  let baseUrl: string;

  async function startHub(options: Partial<HubServerOptions> = {}): Promise<void> {
    hub = createHubServer({ password: 'secret', ...options });
    await new Promise<void>((resolve, reject) => {
      hub.server.once('error', reject);
      hub.server.listen(0, hub.bind, () => {
        hub.server.off('error', reject);
        resolve();
      });
    });
    const address = hub.server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    baseUrl = `http://${address.address}:${address.port}`;
  }

  async function registerThread(sessionId = 'session-1'): Promise<string> {
    const res = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(descriptorOf(sessionId)),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  async function postEntry(threadId: string, entry: Entry): Promise<Response> {
    return fetch(`${baseUrl}/api/entry?target=${threadId}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'entry', entry }),
    });
  }

  async function readEvents(res: Response, count: number, ms: number): Promise<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const read = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return 'eof';
        text += decoder.decode(value, { stream: true });
        if ((text.match(/^data: /gm) ?? []).length >= count) return 'complete';
      }
    })();
    const timer = new Promise<'timeout'>((resolve) => {
      setTimeout(() => {
        resolve('timeout');
      }, ms);
    });
    await Promise.race([timer, read]);
    await reader.cancel();
    return text;
  }

  async function openStream(threadId: string): Promise<Response> {
    const res = await fetch(`${baseUrl}/api/stream/${threadId}`, { headers: AUTH });
    expect(res.status).toBe(200);
    return res;
  }

  async function readFor(res: Response, ms: number): Promise<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const read = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return 'eof';
        text += decoder.decode(value, { stream: true });
      }
    })();
    const timer = new Promise<'timeout'>((resolve) => {
      setTimeout(() => {
        resolve('timeout');
      }, ms);
    });
    const outcome = await Promise.race([timer, read]);
    await reader.cancel();
    return text;
  }

  afterEach(async () => {
    if (hub !== undefined) {
      await hub.close();
      hub = undefined as unknown as HubServer;
    }
  });

  it('runs the full cp4 chain from gate to reap in one session', async () => {
    await startHub({ livenessWindowMs: 80, reapIntervalMs: 30 });
    const gateRes = await fetch(`${baseUrl}/api/threads`, { headers: { Authorization: 'Bearer secret' } });
    expect(gateRes.status).toBe(200);
    expect(await gateRes.json()).toEqual({ threads: [] });

    const threadId = await registerThread('session-cp4');
    const stream = await openStream(threadId);
    for (const entry of [message('first'), message('second')]) {
      const res = await postEntry(threadId, entry);
      expect(res.status).toBe(200);
    }
    const marker: Entry = { kind: 'status-marker', status: 'idle' };
    const markerRes = await postEntry(threadId, marker);
    expect(markerRes.status).toBe(200);

    const deltas = await readEvents(stream, 3, 500);
    for (const expected of ['"seq":1', '"seq":2', '"seq":3']) {
      expect(deltas).toContain(expected);
    }
    expect(deltas).toContain('first');
    expect(deltas).toContain('second');
    expect(deltas).toContain('"status-marker"');

    const snapshotRes = await fetch(`${baseUrl}/api/threads/${threadId}/snapshot`, { headers: AUTH });
    expect(snapshotRes.status).toBe(200);
    const snapshot = (await snapshotRes.json()) as Record<string, unknown>;
    expect(Object.keys(snapshot).toSorted()).toEqual(['descriptor', 'entries', 'maxSeq', 'openCards']);
    expect(snapshot['maxSeq']).toBe(3);
    expect(snapshot['descriptor']).toEqual(descriptorOf('session-cp4'));
    expect(snapshot['openCards']).toEqual([]);
    expect(snapshot['entries']).toEqual([
      { seq: 1, entry: message('first') },
      { seq: 2, entry: message('second') },
      { seq: 3, entry: marker },
    ]);

    const deadline = Date.now() + 500;
    let threads: Array<{ id: string }> = [];
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const listRes = await fetch(`${baseUrl}/api/threads`, { headers: AUTH });
      threads = ((await listRes.json()) as { threads: Array<{ id: string }> }).threads;
      if (!threads.some((thread) => thread.id === threadId)) break;
    }
    expect(threads.some((thread) => thread.id === threadId)).toBe(false);
  });

  it('delivers the same fanout payload to every subscriber of the thread', async () => {
    await startHub();
    const threadId = await registerThread();
    const first = await openStream(threadId);
    const second = await openStream(threadId);

    const entryRes = await postEntry(threadId, message('fanout'));
    expect(entryRes.status).toBe(200);

    const payloads = (text: string): unknown[] =>
      text
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice('data: '.length)));

    const firstText = await readFor(first, 150);
    const secondText = await readFor(second, 150);
    expect(payloads(firstText)).toEqual([{ seq: 1, entry: message('fanout') }]);
    expect(payloads(secondText)).toEqual([{ seq: 1, entry: message('fanout') }]);
    expect(JSON.stringify(payloads(firstText))).toBe(JSON.stringify(payloads(secondText)));
  });

  it('answers 400/401/404 for the three hostile paths while the stream stays heartbeat-only', async () => {
    await startHub({ heartbeatIntervalMs: 30 });
    const threadId = await registerThread('session-t1');
    const stream = await openStream(threadId);

    const hostile = await fetch(`${baseUrl}/api/action`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'approve', target: threadId, cardId: 'c1', approved_for_session: true }),
    });
    expect(hostile.status).toBe(400);

    const anonymous = await fetch(`${baseUrl}/api/threads`);
    expect(anonymous.status).toBe(401);

    const missing = await fetch(`${baseUrl}/api/action`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'approve', target: 'no-such-thread', cardId: 'c1' }),
    });
    expect(missing.status).toBe(404);

    const recorded = await readFor(stream, 150);
    expect(recorded).not.toContain('data:');
    expect((recorded.match(/: heartbeat/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('beats the sse heartbeat near the injected cadence', async () => {
    await startHub({ heartbeatIntervalMs: 40 });
    const threadId = await registerThread();
    const stream = await openStream(threadId);

    const text = await readFor(stream, 240);
    const beats = text.match(/: heartbeat/g) ?? [];
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats.length).toBeLessThanOrEqual(5);
  });

  it('binds the listener to loopback by default and via the bind option', async () => {
    await startHub();
    expect(hub.bind).toBe('127.0.0.1');
    const address = hub.server.address();
    expect(address).toMatchObject({ address: '127.0.0.1' });
    await fetch(`${baseUrl}/api/threads`, { headers: AUTH }).then((res) => expect(res.status).toBe(200));

    await hub.close();
    await startHub({ bind: '127.0.0.1' });
    expect(hub.bind).toBe('127.0.0.1');
    expect(hub.server.address()).toMatchObject({ address: '127.0.0.1' });
    await fetch(`${baseUrl}/api/threads`, { headers: AUTH }).then((res) => expect(res.status).toBe(200));
  });

  it.skipIf(!existsSync(HUB_MJS))('lists no threads after a real hub process restart', async () => {
    const password = 'secret';
    const spawnHub = async (): Promise<{ child: ChildProcess; baseUrl: string }> => {
      const child = spawn(process.execPath, [HUB_MJS, '--port', '0', '--password', password], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout!.setEncoding('utf8');
      child.stderr!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        output += chunk;
      });
      child.stderr!.on('data', (chunk: string) => {
        output += chunk;
      });
      const deadline = Date.now() + 5000;
      for (;;) {
        const match = /listening on http:\/\/(\S+):(\d+)/.exec(output);
        if (match !== null) {
          return { child, baseUrl: `http://127.0.0.1:${match[2]}` };
        }
        if (child.exitCode !== null || Date.now() > deadline) {
          child.kill();
          throw new Error(`hub process failed to start: ${output}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const headers = { Authorization: `Bearer ${password}`, 'content-type': 'application/json' };

    const first = await spawnHub();
    try {
      const registerRes = await fetch(`${first.baseUrl}/api/register`, {
        method: 'POST',
        headers,
        body: JSON.stringify(descriptorOf('session-restart')),
      });
      expect(registerRes.status).toBe(200);
      const { id: threadId } = (await registerRes.json()) as { id: string };
      const entryRes = await fetch(`${first.baseUrl}/api/entry?target=${threadId}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'entry', entry: message('before restart') }),
      });
      expect(entryRes.status).toBe(200);
      const listRes = await fetch(`${first.baseUrl}/api/threads`, { headers });
      expect(((await listRes.json()) as { threads: unknown[] }).threads).toHaveLength(1);
    } finally {
      first.child.kill();
      await new Promise<void>((resolve) => {
        if (first.child.exitCode !== null) return resolve();
        first.child.once('exit', () => resolve());
        setTimeout(resolve, 3000);
      });
    }

    const second = await spawnHub();
    try {
      const listRes = await fetch(`${second.baseUrl}/api/threads`, { headers });
      expect(listRes.status).toBe(200);
      expect(await listRes.json()).toEqual({ threads: [] });
    } finally {
      second.child.kill();
      await new Promise<void>((resolve) => {
        if (second.child.exitCode !== null) return resolve();
        second.child.once('exit', () => resolve());
        setTimeout(resolve, 3000);
      });
    }
  }, 15000);
});
