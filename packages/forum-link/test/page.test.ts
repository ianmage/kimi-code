import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { CardState, Descriptor, Entry } from '#/contract/frames';
import type { HubServer } from '#/hub/router';
import { createHubServer } from '#/hub/router';
import type { ResolveDeps, ThreadSummary } from '#/page/resolve';
import { resolveThreadBySessionId } from '#/page/resolve';
import type { SnapshotPayload } from '#/page/store';
import { isCardActionable, needsConfirmation, ThreadStore } from '#/page/store';

const pageHtml = readFileSync(fileURLToPath(new URL('../src/page/index.html', import.meta.url)), 'utf8');

function descriptorOf(sessionId: string, status: Descriptor['status'] = 'running'): Descriptor {
  return { sessionId, machineName: 'machine-1', projectName: 'project-1', title: 'Fix login bug', status };
}

function message(text: string): Entry {
  return { kind: 'message', role: 'user', text };
}

function questionCard(cardId: string): Entry {
  return { kind: 'question-card', cardId, question: 'Which fix?', options: ['quick', 'proper'] };
}

function approvalCard(cardId: string): Entry {
  return { kind: 'approval-card', cardId, toolName: 'Bash', action: 'exec', summary: 'rm -rf build' };
}

describe('Phase 5.1 thread store', () => {
  it('drops duplicate seq deliveries and keeps exactly one timeline item', () => {
    const store = new ThreadStore();
    store.applyEntry(1, message('hello'));
    store.applyEntry(1, message('hello'));
    expect(store.timeline).toHaveLength(1);
    expect(store.timeline[0]?.entry).toEqual(message('hello'));
  });

  it('signals resync on a seq gap, converges via snapshot, then keeps appending', () => {
    let resyncs = 0;
    const store = new ThreadStore({ onResyncNeeded: () => { resyncs += 1; } });
    store.applyEntry(1, message('one'));
    store.applyEntry(3, message('three'));
    expect(resyncs).toBe(1);
    expect(store.timeline.map((item) => item.seq)).toEqual([1]);
    store.applySnapshot({
      descriptor: descriptorOf('session-1'),
      entries: [
        { seq: 3, entry: message('three') },
        { seq: 1, entry: message('one') },
        { seq: 2, entry: message('two') },
      ],
      maxSeq: 3,
      openCards: [],
    });
    expect(store.timeline.map((item) => item.seq)).toEqual([1, 2, 3]);
    store.applyEntry(4, message('four'));
    expect(resyncs).toBe(1);
    expect(store.timeline.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
  });

  it('settles a card by cardId and never reopens it on a duplicate open entry', () => {
    const store = new ThreadStore();
    store.applyEntry(1, approvalCard('c1'));
    expect(store.openCards).toEqual([{ cardId: 'c1', kind: 'approval', state: 'open' }]);
    store.applyEntry(2, { kind: 'card-settled', cardId: 'c1', outcome: 'approved' });
    expect(store.openCards).toEqual([{ cardId: 'c1', kind: 'approval', state: 'approved' }]);
    store.applyEntry(3, approvalCard('c1'));
    expect(store.openCards).toEqual([{ cardId: 'c1', kind: 'approval', state: 'approved' }]);
  });

  it('remembers a settlement that arrived before the card opened', () => {
    const store = new ThreadStore();
    store.applyEntry(1, { kind: 'card-settled', cardId: 'c9', outcome: 'rejected' });
    expect(store.openCards).toEqual([]);
    store.applyEntry(2, approvalCard('c9'));
    expect(store.openCards).toEqual([{ cardId: 'c9', kind: 'approval', state: 'rejected' }]);
  });

  it('replaces timeline and openCards from a snapshot', () => {
    const store = new ThreadStore();
    store.applyEntry(1, questionCard('q1'));
    store.applyEntry(2, approvalCard('a1'));
    store.applySnapshot({
      descriptor: descriptorOf('session-1'),
      entries: [{ seq: 4, entry: message('only') }],
      maxSeq: 5,
      openCards: [{ cardId: 'a1', kind: 'approval', state: 'approved' }],
    });
    expect(store.timeline.map((item) => item.seq)).toEqual([4]);
    expect(store.openCards).toEqual([{ cardId: 'a1', kind: 'approval', state: 'approved' }]);
    store.applyEntry(6, message('after'));
    expect(store.timeline.map((item) => item.seq)).toEqual([4, 6]);
  });

  it('clears timeline, cards and descriptor state on reset', () => {
    const store = new ThreadStore();
    store.applySnapshot({
      descriptor: descriptorOf('session-1'),
      entries: [{ seq: 1, entry: message('hi') }],
      maxSeq: 1,
      openCards: [{ cardId: 'q1', kind: 'question', state: 'open' }],
    });
    const next = descriptorOf('session-2');
    store.applyReset(next);
    expect(store.timeline).toEqual([]);
    expect(store.openCards).toEqual([]);
    expect(store.descriptor).toEqual(next);
    store.applyEntry(1, message('fresh'));
    expect(store.timeline).toHaveLength(1);
  });

  it('updates the descriptor and notifies observers on applyDescriptor', () => {
    const descriptors: Descriptor[] = [];
    const store = new ThreadStore({ onDescriptorChange: (descriptor) => { descriptors.push(descriptor); } });
    expect(store.descriptor).toBeUndefined();
    store.applySnapshot({ descriptor: descriptorOf('session-1'), entries: [], maxSeq: 0, openCards: [] });
    const next = descriptorOf('session-1', 'idle');
    store.applyDescriptor(next);
    expect(store.descriptor).toEqual(next);
    expect(descriptors).toEqual([descriptorOf('session-1'), next]);
  });

  it('notifies timeline and cards observers only on actual changes', () => {
    let timelineNotified = 0;
    let cardsNotified = 0;
    const store = new ThreadStore({
      onTimelineChange: () => { timelineNotified += 1; },
      onCardsChange: () => { cardsNotified += 1; },
    });
    store.applyEntry(1, message('one'));
    store.applyEntry(1, message('one'));
    expect(timelineNotified).toBe(1);
    store.applyEntry(2, questionCard('q1'));
    expect(cardsNotified).toBe(1);
    store.applyEntry(3, { kind: 'status-marker', status: 'idle' });
    expect(cardsNotified).toBe(1);
    expect(timelineNotified).toBe(3);
  });

  it('gates card actions on both the card state and the session status', () => {
    const open: CardState = { cardId: 'c1', kind: 'approval', state: 'open' };
    const settled: CardState = { cardId: 'c1', kind: 'approval', state: 'approved' };
    expect(isCardActionable(open, 'running')).toBe(true);
    expect(isCardActionable(open, 'waiting-question')).toBe(true);
    expect(isCardActionable(open, 'idle')).toBe(false);
    expect(isCardActionable(settled, 'running')).toBe(false);
    expect(isCardActionable(settled, 'idle')).toBe(false);
  });

  it('requires confirmation only for approve and end-session', () => {
    expect(needsConfirmation('approve')).toBe(true);
    expect(needsConfirmation('end-session')).toBe(true);
    expect(needsConfirmation('deny')).toBe(false);
    expect(needsConfirmation('answer-question')).toBe(false);
    expect(needsConfirmation('send-message')).toBe(false);
    expect(needsConfirmation('pause')).toBe(false);
  });
});

describe('Phase 5.2 resolveThreadBySessionId', () => {
  function summaryOf(id: string, sessionId: string): ThreadSummary {
    return { id, descriptor: descriptorOf(sessionId) };
  }

  function depsWith(
    outcomes: Array<{ threads: ThreadSummary[] } | undefined | Error>,
  ): { calls: number; fetchThreads: ResolveDeps['fetchThreads'] } {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      fetchThreads: async () => {
        calls += 1;
        const outcome = outcomes.shift();
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    };
  }

  it('returns the matching summary immediately when the first fetch already has it', async () => {
    const target = summaryOf('t-1', 'session-9');
    const deps = depsWith([{ threads: [summaryOf('t-0', 'session-8'), target] }]);
    const result = await resolveThreadBySessionId('session-9', deps, { retryIntervalMs: 1 });
    expect(result).toEqual(target);
    expect(deps.calls).toBe(1);
  });

  it('retries on a bounded cadence until the session republishes', async () => {
    const target = summaryOf('t-2', 'session-9');
    const deps = depsWith([
      { threads: [summaryOf('t-0', 'session-8')] },
      { threads: [] },
      { threads: [target] },
    ]);
    const startedAt = Date.now();
    const result = await resolveThreadBySessionId('session-9', deps, { retryIntervalMs: 10 });
    expect(result).toEqual(target);
    expect(deps.calls).toBe(3);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20);
  });

  it('gives up after exactly maxRetries additional attempts', async () => {
    const deps = depsWith([{ threads: [] }]);
    const result = await resolveThreadBySessionId('session-9', deps, {
      retryIntervalMs: 1,
      maxRetries: 3,
    });
    expect(result).toBeUndefined();
    expect(deps.calls).toBe(4);
  });

  it('counts a network failure as one attempt and keeps polling', async () => {
    const target = summaryOf('t-3', 'session-9');
    const deps = depsWith([undefined, new Error('offline'), { threads: [target] }]);
    const result = await resolveThreadBySessionId('session-9', deps, { retryIntervalMs: 1 });
    expect(result).toEqual(target);
    expect(deps.calls).toBe(3);
  });
});

describe('Phase 5.2 end-to-end re-resolution', () => {
  const AUTH = { Authorization: 'Bearer secret' };

  let hub: HubServer | undefined;
  let baseUrl: string;

  afterEach(async () => {
    if (hub !== undefined) {
      await hub.close();
      hub = undefined;
    }
  });

  async function registerThread(sessionId: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(descriptorOf(sessionId)),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { id: string }).id;
  }

  async function postEntry(threadId: string, entry: Entry): Promise<void> {
    const res = await fetch(`${baseUrl}/api/entry?target=${threadId}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'entry', entry }),
    });
    expect(res.status).toBe(200);
  }

  async function getSnapshot(threadId: string): Promise<SnapshotPayload> {
    const res = await fetch(`${baseUrl}/api/threads/${threadId}/snapshot`, { headers: AUTH });
    expect(res.status).toBe(200);
    return (await res.json()) as SnapshotPayload;
  }

  const fetchThreads: ResolveDeps['fetchThreads'] = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/threads`, { headers: AUTH });
      if (!res.ok) return undefined;
      return (await res.json()) as { threads: ThreadSummary[] };
    } catch {
      return undefined;
    }
  };

  it('recovers into the republished thread after the hub reaps the dead one', async () => {
    hub = createHubServer({ password: 'secret', livenessWindowMs: 60, reapIntervalMs: 20 });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once('error', reject);
      hub!.server.listen(0, '127.0.0.1', () => {
        hub!.server.off('error', reject);
        resolve();
      });
    });
    const address = hub!.server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    baseUrl = `http://127.0.0.1:${address.port}`;

    const threadA = await registerThread('session-e2e');
    await postEntry(threadA, message('before disconnect'));

    const store = new ThreadStore();
    store.applySnapshot(await getSnapshot(threadA));
    expect(store.timeline.map((item) => item.entry)).toEqual([message('before disconnect')]);

    const deadline = Date.now() + 1000;
    for (;;) {
      const res = await fetch(`${baseUrl}/api/threads/${threadA}/snapshot`, { headers: AUTH });
      if (res.status === 404) break;
      if (Date.now() > deadline) throw new Error('thread was not reaped within 1s');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const deadStream = await fetch(`${baseUrl}/api/stream/${threadA}`, { headers: AUTH });
    expect(deadStream.status).toBe(404);

    const threadB = await registerThread('session-e2e');
    await postEntry(threadB, message('after reconnect'));

    const resolved = await resolveThreadBySessionId('session-e2e', { fetchThreads });
    expect(resolved?.id).toBe(threadB);

    store.applySnapshot(await getSnapshot(threadB));
    expect(store.timeline.map((item) => item.entry)).toEqual([message('after reconnect')]);
    expect(store.descriptor).toEqual(descriptorOf('session-e2e'));
  });
});

describe('Phase 5.1 page html', () => {
  it('embeds the auth, list, thread and action markers', () => {
    expect(pageHtml).toContain('forum-link-key');
    expect(pageHtml).toContain('sessionStorage');
    expect(pageHtml).toContain('/api/threads');
    expect(pageHtml).toContain('/api/stream/');
    expect(pageHtml).toContain('/api/action');
    expect(pageHtml).toContain('EventSource');
    expect(pageHtml).toContain('visibilitychange');
    expect(pageHtml).toContain('没有已发布的会话');
    expect(pageHtml).toContain('确认允许此操作？');
    expect(pageHtml).toContain('确认结束会话？');
    expect(pageHtml).toContain('已发送');
  });

  it('wires thread re-resolution into the stream error path', () => {
    expect(pageHtml).toContain('resolveThreadBySessionId');
    expect(pageHtml).toContain('重连中');
    expect(pageHtml).toContain('会话已离线');
    expect(pageHtml).toContain('已重连');
  });

  it('keeps every asset inline with no external requests', () => {
    expect(pageHtml).not.toMatch(/https?:\/\//);
    expect(pageHtml).not.toContain('localStorage');
    expect(pageHtml).not.toMatch(/<script[^>]*\ssrc=/);
    expect(pageHtml).not.toMatch(/<link[^>]*\shref=/);
  });

  it('stays comment-free', () => {
    expect(pageHtml).not.toContain('<!--');
  });

  it('keeps the forum link heading the hub test relies on', () => {
    expect(pageHtml).toContain('<h1>Forum Link</h1>');
  });
});
