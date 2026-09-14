import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { ActionFrame, Descriptor, Entry } from '#/contract/frames';
import type { HubServer } from '#/hub/router';
import { createHubServer } from '#/hub/router';
import type { ResolveDeps, ThreadSummary } from '#/page/resolve';
import { resolveThreadBySessionId } from '#/page/resolve';
import type { SnapshotPayload } from '#/page/store';
import { isCardActionable, ThreadStore } from '#/page/store';

const pageHtml = readFileSync(fileURLToPath(new URL('../src/page/index.html', import.meta.url)), 'utf8');
const AUTH = { Authorization: 'Bearer secret' };

function descriptorOf(sessionId: string, status: Descriptor['status'] = 'running'): Descriptor {
  return { sessionId, machineName: 'machine-1', projectName: 'project-1', title: 'Fix login bug', status };
}

function message(text: string): Entry {
  return { kind: 'message', role: 'assistant', text };
}

function approvalCard(cardId: string): Entry {
  return { kind: 'approval-card', cardId, toolName: 'Bash', action: 'exec', summary: 'rm -rf build' };
}

class PageFeed {
  private readonly store: ThreadStore;

  constructor(store: ThreadStore) {
    this.store = store;
  }

  dispatch(data: string): void {
    const payload = JSON.parse(data) as { seq?: unknown; entry?: unknown; reset?: unknown; descriptor?: unknown };
    if (typeof payload.seq === 'number' && payload.entry) {
      this.store.applyEntry(payload.seq, payload.entry as Entry);
      return;
    }
    if (payload.reset && payload.descriptor) {
      this.store.applyReset(payload.descriptor as Descriptor);
      return;
    }
    if (payload.descriptor) {
      this.store.applyDescriptor(payload.descriptor as Descriptor);
    }
  }
}

interface HubStartOptions {
  port?: number;
  heartbeatIntervalMs?: number;
}

async function startHub(options: HubStartOptions = {}): Promise<{ hub: HubServer; baseUrl: string }> {
  const hub = createHubServer({ password: 'secret', heartbeatIntervalMs: options.heartbeatIntervalMs });
  await new Promise<void>((resolve, reject) => {
    hub.server.once('error', reject);
    hub.server.listen(options.port ?? 0, '127.0.0.1', () => {
      hub.server.off('error', reject);
      resolve();
    });
  });
  const address = hub.server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  return { hub, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function registerThread(baseUrl: string, sessionId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify(descriptorOf(sessionId)),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

async function postFrame(baseUrl: string, threadId: string, frame: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/entry?target=${threadId}`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify(frame),
  });
}

async function postAction(baseUrl: string, frame: ActionFrame): Promise<Response> {
  return fetch(`${baseUrl}/api/action`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify(frame),
  });
}

async function openStream(baseUrl: string, threadId: string): Promise<Response> {
  const res = await fetch(`${baseUrl}/api/stream/${threadId}`, { headers: AUTH });
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
      if (done) return;
      text += decoder.decode(value, { stream: true });
    }
  })();
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
  await reader.cancel();
  return text;
}

function sseDataEvents(text: string): string[] {
  const events: string[] = [];
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (line.startsWith('data: ')) events.push(line.slice('data: '.length));
    }
  }
  return events;
}

async function getSnapshot(baseUrl: string, threadId: string): Promise<SnapshotPayload> {
  const res = await fetch(`${baseUrl}/api/threads/${threadId}/snapshot`, { headers: AUTH });
  expect(res.status).toBe(200);
  return (await res.json()) as SnapshotPayload;
}

describe('Phase 5.3 layer5 page contract', () => {
  let hubs: HubServer[] = [];

  afterEach(async () => {
    const closing = hubs;
    hubs = [];
    for (const hub of closing) await hub.close();
  });

  it('drives the page store from real hub sse payloads through the inline dispatch semantics', async () => {
    const { hub, baseUrl } = await startHub({ heartbeatIntervalMs: 40 });
    hubs.push(hub);
    const threadId = await registerThread(baseUrl, 'page-sse');
    const stream = await openStream(baseUrl, threadId);

    await postFrame(baseUrl, threadId, { type: 'entry', entry: message('one') });
    await postFrame(baseUrl, threadId, { type: 'entry', entry: approvalCard('c1') });
    await postFrame(baseUrl, threadId, {
      type: 'entry',
      entry: { kind: 'card-settled', cardId: 'c1', outcome: 'approved' },
    });
    await postFrame(baseUrl, threadId, { type: 'entry', entry: message('two') });
    await postAction(baseUrl, { type: 'approve', target: threadId, cardId: 'c1' });
    await postFrame(baseUrl, threadId, { type: 'descriptor', descriptor: descriptorOf('page-sse', 'idle') });

    const recorded = await readFor(stream, 300);
    expect(recorded).toContain(': heartbeat');
    const events = sseDataEvents(recorded);
    expect(events).toHaveLength(6);
    expect((JSON.parse(events[4]!) as { action: { type: string } }).action.type).toBe('approve');

    const store = new ThreadStore();
    const feed = new PageFeed(store);
    for (const event of events) feed.dispatch(event);

    expect(store.timeline.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
    expect(store.timeline.map((item) => item.entry)).toEqual([
      message('one'),
      approvalCard('c1'),
      { kind: 'card-settled', cardId: 'c1', outcome: 'approved' },
      message('two'),
    ]);
    expect(store.openCards).toEqual([{ cardId: 'c1', kind: 'approval', state: 'approved' }]);
    expect(store.descriptor?.status).toBe('idle');
    expect(isCardActionable(store.openCards[0]!, store.descriptor!.status)).toBe(false);
  });

  it('clears the page timeline when the tui re-registers and keeps appending from seq 1', async () => {
    const { hub, baseUrl } = await startHub();
    hubs.push(hub);
    const threadId = await registerThread(baseUrl, 'page-reset');
    const store = new ThreadStore();
    const feed = new PageFeed(store);

    const firstStream = await openStream(baseUrl, threadId);
    for (const text of ['a', 'b', 'c']) {
      await postFrame(baseUrl, threadId, { type: 'entry', entry: message(text) });
    }
    const first = sseDataEvents(await readFor(firstStream, 200));
    expect(first).toHaveLength(3);
    for (const event of first) feed.dispatch(event);
    expect(store.timeline.map((item) => item.entry)).toEqual([message('a'), message('b'), message('c')]);

    const secondStream = await openStream(baseUrl, threadId);
    const nextDescriptor = descriptorOf('page-reset-2');
    const registerRes = await postFrame(baseUrl, threadId, { type: 'register', descriptor: nextDescriptor });
    expect(registerRes.status).toBe(200);
    const second = sseDataEvents(await readFor(secondStream, 200));
    expect(second).toHaveLength(1);
    for (const event of second) feed.dispatch(event);
    expect(store.timeline).toEqual([]);
    expect(store.openCards).toEqual([]);
    expect(store.descriptor).toEqual(nextDescriptor);

    const thirdStream = await openStream(baseUrl, threadId);
    await postFrame(baseUrl, threadId, { type: 'entry', entry: message('fresh') });
    const third = sseDataEvents(await readFor(thirdStream, 200));
    expect(third).toHaveLength(1);
    for (const event of third) feed.dispatch(event);
    expect(store.timeline.map((item) => item.seq)).toEqual([1]);
    expect(store.timeline[0]?.entry).toEqual(message('fresh'));
  });

  it('signals resync on a dropped sse frame and converges through the snapshot endpoint', async () => {
    const { hub, baseUrl } = await startHub();
    hubs.push(hub);
    const threadId = await registerThread(baseUrl, 'page-gap');
    const stream = await openStream(baseUrl, threadId);
    for (const text of ['one', 'two', 'three']) {
      await postFrame(baseUrl, threadId, { type: 'entry', entry: message(text) });
    }
    const events = sseDataEvents(await readFor(stream, 200));
    expect(events).toHaveLength(3);

    let resyncs = 0;
    const store = new ThreadStore({ onResyncNeeded: () => { resyncs += 1; } });
    const feed = new PageFeed(store);
    feed.dispatch(events[0]!);
    feed.dispatch(events[2]!);
    expect(resyncs).toBe(1);
    expect(store.timeline.map((item) => item.seq)).toEqual([1]);

    store.applySnapshot(await getSnapshot(baseUrl, threadId));
    expect(store.timeline.map((item) => item.seq)).toEqual([1, 2, 3]);

    feed.dispatch(events[1]!);
    expect(resyncs).toBe(1);
    expect(store.timeline.map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it('keeps the inline dispatch branches aligned with the hub payload shapes', () => {
    expect(pageHtml).toContain("typeof data.seq === 'number'");
    expect(pageHtml).toContain('if (data && data.reset && data.descriptor) {');
    expect(pageHtml).toContain('if (data && data.descriptor) {');
    expect(pageHtml).toContain('snapshot.maxSeq');
    expect(pageHtml).toContain('snapshot.openCards');
    expect(pageHtml).not.toContain('data.action');
  });

  it('re-attaches the page resolver after a hub restart on the same port', async () => {
    const first = await startHub();
    hubs.push(first.hub);
    const threadA = await registerThread(first.baseUrl, 'page-restart');
    await postFrame(first.baseUrl, threadA, { type: 'entry', entry: message('before restart') });

    const store = new ThreadStore();
    store.applySnapshot(await getSnapshot(first.baseUrl, threadA));
    expect(store.timeline.map((item) => item.entry)).toEqual([message('before restart')]);

    const fetchThreads: ResolveDeps['fetchThreads'] = async () => {
      try {
        const res = await fetch(`${first.baseUrl}/api/threads`, { headers: AUTH });
        if (!res.ok) return undefined;
        return (await res.json()) as { threads: ThreadSummary[] };
      } catch {
        return undefined;
      }
    };

    const port = Number(new URL(first.baseUrl).port);
    await first.hub.close();
    hubs = hubs.filter((hub) => hub !== first.hub);
    expect(await fetchThreads()).toBeUndefined();

    const second = await startHub({ port });
    hubs.push(second.hub);
    const threadB = await registerThread(second.baseUrl, 'page-restart');
    expect(threadB).not.toBe(threadA);
    await postFrame(second.baseUrl, threadB, { type: 'entry', entry: message('after restart') });

    const resolved = await resolveThreadBySessionId('page-restart', { fetchThreads }, { retryIntervalMs: 10 });
    expect(resolved?.id).toBe(threadB);

    store.applySnapshot(await getSnapshot(second.baseUrl, threadB));
    expect(store.timeline.map((item) => item.entry)).toEqual([message('after restart')]);
    expect(store.descriptor).toEqual(descriptorOf('page-restart'));
  });
});
