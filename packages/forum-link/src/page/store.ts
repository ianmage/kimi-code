import type { ThreadSnapshot, ThreadSummary } from '#/contract/browser';
import type { Descriptor, Receipt } from '#/contract/shared';
import type { Card, Overview, TimelineEntry } from '#/contract/worker';

const RUNNING_PHASES = new Set(['waiting', 'thinking', 'composing', 'shell']);

export type PageStreamEvent =
  | { type: 'thread.upsert'; summary: ThreadSummary }
  | { type: 'thread.removed'; sessionId: string }
  | { type: 'thread.reset'; sessionId: string }
  | { type: 'timeline.append'; sessionId: string; entries: TimelineEntry[] }
  | { type: 'overview'; sessionId: string; overview: Overview }
  | { type: 'card.opened'; sessionId: string; card: Card }
  | { type: 'card.settled'; sessionId: string; cardId: string; outcome: string }
  | { type: 'receipt'; receipt: Receipt };

export interface PageStoreOptions {
  refetchInbox?: () => void;
  refetchThread?: (sessionId: string) => void;
  onUnauthorized?: () => void;
}

export interface CurrentThread {
  sessionId: string;
  descriptor: Descriptor;
  overview: Overview;
  online: boolean;
  timeline: TimelineEntry[];
  openCards: Card[];
  receipts: Receipt[];
}

export function sortInbox(threads: readonly ThreadSummary[]): ThreadSummary[] {
  const pinned = threads
    .filter((thread) => thread.openCards.length > 0)
    .toSorted((a, b) => earliestOpenedAt(a) - earliestOpenedAt(b) || compareStrings(a.descriptor.sessionId, b.descriptor.sessionId));
  const rest = threads.filter((thread) => thread.openCards.length === 0);
  const groups = new Map<string, ThreadSummary[]>();
  for (const thread of rest) {
    const key = thread.descriptor.machine.tokenName;
    const group = groups.get(key) ?? [];
    group.push(thread);
    groups.set(key, group);
  }
  const orderedGroups = [...groups.entries()].toSorted(([keyA, groupA], [keyB, groupB]) => {
    const latestA = Math.max(...groupA.map((thread) => thread.lastActivityAt));
    const latestB = Math.max(...groupB.map((thread) => thread.lastActivityAt));
    return latestB - latestA || compareStrings(keyA, keyB);
  });
  const ordered = orderedGroups.flatMap(([, group]) =>
    group.toSorted((a, b) => b.lastActivityAt - a.lastActivityAt || compareStrings(a.descriptor.sessionId, b.descriptor.sessionId)),
  );
  return [...pinned, ...ordered];
}

export function displayState(thread: ThreadSummary): string {
  const base =
    thread.openCards.length > 0
      ? 'pending'
      : thread.overview.isCompacting
        ? 'compacting'
        : RUNNING_PHASES.has(thread.overview.phase)
          ? thread.overview.phase
          : 'idle';
  return thread.online ? base : `${base} (offline)`;
}

export function goalProgress(overview: Overview, now: number): string {
  const goal = overview.goal;
  if (goal === null) return '';
  const used = formatDuration(activeWallClockMs(goal, overview.sampledAt, now));
  const budgetMs = wallClockBudgetMs(goal);
  return budgetMs === null ? used : `${used} / ${formatDuration(budgetMs)}`;
}

export function appendTimeline(
  current: readonly TimelineEntry[],
  entries: readonly TimelineEntry[],
): { timeline: TimelineEntry[]; gap: boolean } {
  const timeline = current.slice();
  let tail = timeline.length > 0 ? timeline.at(-1)!.seq : 0;
  for (const entry of entries) {
    if (entry.seq <= tail) continue;
    if (entry.seq !== tail + 1) return { timeline: current.slice(), gap: true };
    timeline.push(entry);
    tail = entry.seq;
  }
  return { timeline, gap: false };
}

export class PageStore {
  private readonly threads = new Map<string, ThreadSummary>();
  private readonly refetchInbox?: () => void;
  private readonly refetchThread?: (sessionId: string) => void;
  private readonly onUnauthorized?: () => void;
  private current: CurrentThread | undefined;

  constructor(options: PageStoreOptions = {}) {
    this.refetchInbox = options.refetchInbox;
    this.refetchThread = options.refetchThread;
    this.onUnauthorized = options.onUnauthorized;
  }

  get inbox(): ThreadSummary[] {
    return [...this.threads.values()];
  }

  get currentThread(): CurrentThread | undefined {
    return this.current;
  }

  applyInbox(threads: readonly ThreadSummary[]): void {
    this.threads.clear();
    for (const thread of threads) this.threads.set(thread.descriptor.sessionId, thread);
  }

  applyThreadSnapshot(snapshot: ThreadSnapshot): void {
    const sessionId = snapshot.descriptor.sessionId;
    this.current = {
      sessionId,
      descriptor: snapshot.descriptor,
      overview: snapshot.overview,
      online: snapshot.online,
      timeline: snapshot.timeline.slice(),
      openCards: snapshot.openCards.slice(),
      receipts: sortReceipts(snapshot.receipts),
    };
    this.threads.set(sessionId, summaryFromSnapshot(snapshot));
  }

  applyEvent(event: PageStreamEvent): void {
    switch (event.type) {
      case 'thread.upsert':
        this.applyUpsert(event.summary);
        return;
      case 'thread.removed':
        this.threads.delete(event.sessionId);
        if (this.current?.sessionId === event.sessionId) this.current = undefined;
        return;
      case 'thread.reset':
        if (this.current?.sessionId === event.sessionId) this.refetchThread?.(event.sessionId);
        return;
      case 'timeline.append':
        this.applyTimelineAppend(event.sessionId, event.entries);
        return;
      case 'overview':
        this.applyOverview(event.sessionId, event.overview);
        return;
      case 'card.opened':
        this.applyCardOpened(event.sessionId, event.card);
        return;
      case 'card.settled':
        this.applyCardSettled(event.sessionId, event.cardId);
        return;
      case 'receipt':
        this.applyReceipt(event.receipt);
        return;
    }
  }

  noteStreamConnected(): void {
    this.refetchInbox?.();
    if (this.current !== undefined) this.refetchThread?.(this.current.sessionId);
  }

  noteUnauthorized(): void {
    this.onUnauthorized?.();
  }

  reset(): void {
    this.threads.clear();
    this.current = undefined;
  }

  private applyUpsert(summary: ThreadSummary): void {
    const sessionId = summary.descriptor.sessionId;
    this.threads.set(sessionId, summary);
    const current = this.current;
    if (current?.sessionId !== sessionId) return;
    this.current = {
      ...current,
      descriptor: summary.descriptor,
      online: summary.online,
      overview: summary.overview.rev > current.overview.rev ? summary.overview : current.overview,
    };
  }

  private applyTimelineAppend(sessionId: string, entries: readonly TimelineEntry[]): void {
    this.bumpActivity(sessionId, entries);
    const current = this.current;
    if (current?.sessionId !== sessionId) return;
    const result = appendTimeline(current.timeline, entries);
    if (result.gap) {
      this.refetchThread?.(sessionId);
      return;
    }
    this.current = { ...current, timeline: result.timeline };
  }

  private applyOverview(sessionId: string, overview: Overview): void {
    const summary = this.threads.get(sessionId);
    if (summary !== undefined && overview.rev > summary.overview.rev) {
      this.threads.set(sessionId, { ...summary, overview });
    }
    const current = this.current;
    if (current?.sessionId !== sessionId || overview.rev <= current.overview.rev) return;
    this.current = { ...current, overview };
  }

  private applyCardOpened(sessionId: string, card: Card): void {
    const summary = this.threads.get(sessionId);
    if (summary !== undefined && !summary.openCards.some((open) => open.cardId === card.cardId)) {
      this.threads.set(sessionId, {
        ...summary,
        openCards: [...summary.openCards, { cardId: card.cardId, kind: card.kind, openedAt: card.openedAt }],
        lastActivityAt: Math.max(summary.lastActivityAt, card.openedAt),
      });
    }
    const current = this.current;
    if (current?.sessionId !== sessionId || current.openCards.some((open) => open.cardId === card.cardId)) return;
    this.current = { ...current, openCards: [...current.openCards, card] };
  }

  private applyCardSettled(sessionId: string, cardId: string): void {
    const summary = this.threads.get(sessionId);
    if (summary !== undefined) {
      this.threads.set(sessionId, {
        ...summary,
        openCards: summary.openCards.filter((open) => open.cardId !== cardId),
      });
    }
    const current = this.current;
    if (current?.sessionId !== sessionId) return;
    this.current = { ...current, openCards: current.openCards.filter((open) => open.cardId !== cardId) };
  }

  private applyReceipt(receipt: Receipt): void {
    const current = this.current;
    if (current === undefined || receipt.sessionId !== current.sessionId) return;
    const rest = current.receipts.filter((existing) => existing.opId !== receipt.opId);
    this.current = { ...current, receipts: sortReceipts([...rest, receipt]) };
  }

  private bumpActivity(sessionId: string, entries: readonly TimelineEntry[]): void {
    if (entries.length === 0) return;
    const at = entries.at(-1)!.at;
    const summary = this.threads.get(sessionId);
    if (summary === undefined || at <= summary.lastActivityAt) return;
    this.threads.set(sessionId, { ...summary, lastActivityAt: at });
  }
}

function earliestOpenedAt(thread: ThreadSummary): number {
  return Math.min(...thread.openCards.map((card) => card.openedAt));
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function summaryFromSnapshot(snapshot: ThreadSnapshot): ThreadSummary {
  return {
    descriptor: snapshot.descriptor,
    overview: snapshot.overview,
    online: snapshot.online,
    openCards: snapshot.openCards.map(({ cardId, kind, openedAt }) => ({ cardId, kind, openedAt })),
    lastActivityAt: lastActivityOf(snapshot),
  };
}

function lastActivityOf(snapshot: ThreadSnapshot): number {
  const timelineAt = snapshot.timeline.length > 0 ? snapshot.timeline.at(-1)!.at : 0;
  let cardAt = 0;
  for (const card of snapshot.openCards) cardAt = Math.max(cardAt, card.openedAt);
  return Math.max(timelineAt, cardAt, snapshot.overview.sampledAt);
}

function sortReceipts(receipts: readonly Receipt[]): Receipt[] {
  return receipts.toSorted((a, b) => a.at - b.at || compareStrings(a.opId, b.opId));
}

function activeWallClockMs(goal: NonNullable<Overview['goal']>, sampledAt: number, now: number): number {
  const wallClockMs = goal['wallClockMs'];
  const base = typeof wallClockMs === 'number' ? wallClockMs : 0;
  if (goal.status !== 'active') return base;
  return base + Math.max(0, now - sampledAt);
}

function wallClockBudgetMs(goal: NonNullable<Overview['goal']>): number | null {
  const budget = goal['budget'];
  if (typeof budget !== 'object' || budget === null) return null;
  const budgetMs = (budget as Record<string, unknown>)['wallClockBudgetMs'];
  return typeof budgetMs === 'number' ? budgetMs : null;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
