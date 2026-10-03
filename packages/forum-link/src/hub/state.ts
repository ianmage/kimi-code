import { randomUUID } from 'node:crypto';

import type {
  Card,
  Overview,
  ReceiptReport,
  RegisterResponse,
  TimelineEntry,
  UplinkBatch,
  WorkerSnapshot,
} from '#/contract/worker';
import {
  LIMITS,
  type Descriptor,
  type OpIntent,
  type Receipt,
  opIntentSchema,
  receiptSchema,
} from '#/contract/shared';
import type { ThreadSummary } from '#/contract/browser';
import type { Notifier } from '#/hub/notifier';

export interface ThreadRecord {
  sessionId: string;
  ownerTokenId: string;
  hostWorkerId: string;
  descriptor: Descriptor;
  overview: Overview;
  overviewRev: number;
  timeline: TimelineEntry[];
  tailSeq: number;
  openCards: Map<string, Card & { openedAt: number }>;
  online: boolean;
}

export type FanoutEvent =
  | { type: 'thread.upsert'; summary: ThreadSummary }
  | { type: 'thread.removed'; sessionId: string }
  | { type: 'thread.reset'; sessionId: string }
  | { type: 'timeline.append'; sessionId: string; entries: TimelineEntry[] }
  | { type: 'overview'; sessionId: string; overview: Overview }
  | { type: 'card.opened'; sessionId: string; card: Card }
  | { type: 'card.settled'; sessionId: string; cardId: string; outcome: string }
  | { type: 'receipt'; receipt: Receipt };

export type FanoutListener = (event: FanoutEvent) => void;

export type BatchResult = { ok: true } | { ok: false; reason: 'resync-required' };

export type RemoveThreadResult = { ok: true } | { ok: false; reason: 'refused-online' };

export interface StateOptions {
  onFanout?: FanoutListener;
  onPersist?: () => void;
  onLog?: (message: string) => void;
  deliver?: (workerId: string, push: { opId: string; sessionId: string; intent: OpIntent }) => void;
  tokenName?: (tokenId: string) => string | undefined;
  now?: () => number;
  newOpId?: () => string;
  receiptsPerThread?: number;
  notifier?: Notifier;
}

export interface PersistView {
  threads: {
    sessionId: string;
    ownerTokenId: string;
    hostWorkerId: string;
    descriptor: unknown;
    overview: Overview;
    overviewRev: number;
    openCards: unknown[];
  }[];
  receipts: (Receipt & { workerId?: string })[];
}

export interface State {
  register(ownerTokenId: string, workerId: string, snapshot: WorkerSnapshot): RegisterResponse;
  applyBatch(workerId: string, batch: UplinkBatch): BatchResult;
  acceptOp(deviceTokenId: string, sessionId: string, intent: OpIntent): Receipt;
  reportReceipt(workerId: string, report: ReceiptReport): void;
  workerConnected(workerId: string): void;
  workerDisconnected(workerId: string): void;
  removeOfflineThread(sessionId: string): RemoveThreadResult;
  dropOwner(tokenId: string): void;
  unregister(workerId: string, finalReceipts: ReceiptReport[]): void;
  inbox(): ThreadSummary[];
  threadSnapshot(sessionId: string): { descriptor: Descriptor; overview: Overview; online: boolean; timeline: TimelineEntry[]; openCards: Card[]; receipts: Receipt[] } | undefined;
  receiptsFor(sessionId: string): Receipt[];
  threadsForWorker(workerId: string): string[];
  markWorkerReceiptsLost(workerId: string): void;
  onFanout(listener: FanoutListener): void;
}

const TERMINAL_RECEIPT_STATES = new Set<string>(['applied', 'rejected', 'lost']);

function tailSeqOf(timeline: TimelineEntry[]): number {
  return timeline.length > 0 ? timeline.at(-1)!.seq : 0;
}

function truncateTimeline(timeline: TimelineEntry[]): TimelineEntry[] {
  if (timeline.length <= LIMITS.timelineRingLength) return timeline;
  return timeline.slice(timeline.length - LIMITS.timelineRingLength);
}

function lastActivityOf(record: ThreadRecord): number {
  const timelineAt = record.timeline.length > 0 ? record.timeline.at(-1)!.at : 0;
  let cardAt = 0;
  for (const card of record.openCards.values()) cardAt = Math.max(cardAt, card.openedAt);
  return Math.max(timelineAt, cardAt, record.overview.sampledAt);
}

function withTokenName(descriptor: Descriptor, tokenName: string): Descriptor {
  return { ...descriptor, machine: { ...descriptor.machine, tokenName } };
}

function frameEntriesContiguous(entries: TimelineEntry[], startSeq: number): number | undefined {
  let tail = startSeq;
  for (const entry of entries) {
    if (entry.seq !== tail + 1) return undefined;
    tail = entry.seq;
  }
  return tail;
}

export class HubState implements State {
  private readonly threads = new Map<string, ThreadRecord>();
  private readonly receipts = new Map<string, Receipt & { workerId?: string }>();
  private readonly listeners = new Set<FanoutListener>();
  private persistHook?: () => void;
  private readonly onLog: (message: string) => void;
  private readonly deliver?: (workerId: string, push: { opId: string; sessionId: string; intent: OpIntent }) => void;
  private readonly tokenName: (tokenId: string) => string | undefined;
  private readonly now: () => number;
  private readonly newOpId: () => string;
  private readonly receiptsPerThread: number;
  private readonly notifier?: Notifier;

  constructor(options: StateOptions = {}) {
    this.persistHook = options.onPersist;
    this.onLog = options.onLog ?? (() => {});
    this.deliver = options.deliver;
    this.tokenName = options.tokenName ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.newOpId = options.newOpId ?? randomUUID;
    this.receiptsPerThread = options.receiptsPerThread ?? LIMITS.receiptsPerThread;
    this.notifier = options.notifier;
    for (const listener of options.onFanout !== undefined ? [options.onFanout] : []) {
      this.listeners.add(listener);
    }
    if (this.notifier !== undefined) {
      this.listeners.add((event) => {
        if (event.type === 'card.opened') this.notifier!.notifyNewCard(event.sessionId, event.card.cardId);
      });
    }
  }

  restore(view: PersistView): void {
    for (const thread of view.threads) {
      const record: ThreadRecord = {
        sessionId: thread.sessionId,
        ownerTokenId: thread.ownerTokenId,
        hostWorkerId: thread.hostWorkerId,
        descriptor: thread.descriptor as Descriptor,
        overview: thread.overview,
        overviewRev: thread.overviewRev,
        timeline: [],
        tailSeq: 0,
        openCards: new Map<string, Card & { openedAt: number }>(),
        online: false,
      };
      for (const card of thread.openCards as (Card & { openedAt: number })[]) {
        record.openCards.set(card.cardId, card);
        this.notifier?.markSeen(thread.sessionId, card.cardId);
      }
      this.threads.set(thread.sessionId, record);
    }
    for (const receipt of view.receipts) {
      this.receipts.set(receipt.opId, receipt);
    }
  }

  persistView(): PersistView {
    return {
      threads: [...this.threads.values()].map((record) => ({
        sessionId: record.sessionId,
        ownerTokenId: record.ownerTokenId,
        hostWorkerId: record.hostWorkerId,
        descriptor: record.descriptor,
        overview: record.overview,
        overviewRev: record.overviewRev,
        openCards: [...record.openCards.values()],
      })),
      receipts: [...this.receipts.values()],
    };
  }

  register(ownerTokenId: string, workerId: string, snapshot: WorkerSnapshot): RegisterResponse {
    const ownerName = this.tokenName(ownerTokenId);
    const response: RegisterResponse = { workerId, threads: [] };
    const snapshotIds = new Set(snapshot.threads.map((thread) => thread.descriptor.sessionId));
    for (const thread of snapshot.threads) {
      const sessionId = thread.descriptor.sessionId;
      const existing = this.threads.get(sessionId);
      if (existing !== undefined && existing.ownerTokenId !== ownerTokenId) {
        this.onLog(`register rejected thread ${sessionId}: owner mismatch`);
        response.threads.push({ sessionId, accepted: false });
        continue;
      }
      const descriptor = ownerName === undefined ? thread.descriptor : withTokenName(thread.descriptor, ownerName);
      const timeline = thread.timeline.slice();
      const openCards = new Map<string, Card & { openedAt: number }>();
      for (const card of thread.openCards) openCards.set(card.cardId, { ...card, openedAt: card.openedAt });
      const settledIds =
        existing === undefined
          ? []
          : [...existing.openCards.keys()].filter((cardId) => !openCards.has(cardId));
      const settledAt = this.now();
      for (const cardId of settledIds) {
        timeline.push({ seq: tailSeqOf(timeline) + 1, at: settledAt, kind: 'card-settled', cardId, outcome: 'closed' });
      }
      const previouslyOpen = existing?.openCards;
      const record: ThreadRecord = {
        sessionId,
        ownerTokenId,
        hostWorkerId: workerId,
        descriptor,
        overview: thread.overview,
        overviewRev: thread.overview.rev,
        timeline: truncateTimeline(timeline),
        tailSeq: tailSeqOf(timeline),
        openCards,
        online: true,
      };
      this.threads.set(sessionId, record);
      response.threads.push({ sessionId, accepted: true });
      this.emit({ type: 'thread.reset', sessionId });
      for (const cardId of settledIds) {
        this.emit({ type: 'card.settled', sessionId, cardId, outcome: 'closed' });
      }
      for (const card of openCards.values()) {
        if (previouslyOpen?.has(card.cardId)) continue;
        this.emit({ type: 'card.opened', sessionId, card });
      }
      this.emit({ type: 'thread.upsert', summary: this.summaryOf(record) });
    }
    this.reconcileReceipts(workerId, snapshot.recentReceipts);
    const hostedSessionIds = [...this.threads.keys()];
    for (const sessionId of hostedSessionIds) {
      const record = this.threads.get(sessionId)!;
      if (record.hostWorkerId !== workerId || snapshotIds.has(sessionId)) continue;
      this.threads.delete(sessionId);
      this.emit({ type: 'thread.removed', sessionId });
    }
    this.persistHook?.();
    return response;
  }

  applyBatch(workerId: string, batch: UplinkBatch): BatchResult {
    const tails = new Map<string, number>();
    for (const frame of batch.frames) {
      const record = this.threads.get(frame.sessionId);
      if (record === undefined || record.hostWorkerId !== workerId) {
        return { ok: false, reason: 'resync-required' };
      }
      if (frame.kind !== 'timeline') continue;
      const tail = frameEntriesContiguous(frame.entries, tails.get(frame.sessionId) ?? record.tailSeq);
      if (tail === undefined) return { ok: false, reason: 'resync-required' };
      tails.set(frame.sessionId, tail);
    }
    for (const frame of batch.frames) {
      const record = this.threads.get(frame.sessionId)!;
      if (frame.kind === 'timeline') {
        record.timeline.push(...frame.entries);
        record.timeline = truncateTimeline(record.timeline);
        record.tailSeq = tails.get(frame.sessionId)!;
        this.emit({ type: 'timeline.append', sessionId: frame.sessionId, entries: frame.entries });
        continue;
      }
      if (frame.kind === 'overview') {
        if (frame.overview.rev > record.overviewRev) {
          record.overview = frame.overview;
          record.overviewRev = frame.overview.rev;
          this.emit({ type: 'overview', sessionId: frame.sessionId, overview: frame.overview });
        }
        continue;
      }
      const ownerName = this.tokenName(record.ownerTokenId);
      record.descriptor =
        ownerName === undefined ? frame.descriptor : withTokenName(frame.descriptor, ownerName);
      this.emit({ type: 'thread.upsert', summary: this.summaryOf(record) });
    }
    this.persistHook?.();
    return { ok: true };
  }

  acceptOp(deviceTokenId: string, sessionId: string, intent: OpIntent): Receipt {
    const parsed = opIntentSchema.safeParse(intent);
    if (!parsed.success || parsed.data.sessionId !== sessionId) {
      const raw = typeof intent === 'object' && intent !== null ? (intent as { type?: unknown; cardId?: unknown }) : {};
      const cardId = typeof raw.cardId === 'string' ? raw.cardId : undefined;
      return this.recordReceipt({
        opId: this.newOpId(),
        sessionId,
        opType: raw.type as OpIntent['type'],
        cardId,
        state: 'rejected',
        reason: 'bad-shape',
        at: this.now(),
      });
    }
    const value = parsed.data;
    const cardId = 'cardId' in value ? value.cardId : undefined;
    const record = this.threads.get(sessionId);
    if (record === undefined) {
      return this.recordReceipt({
        opId: this.newOpId(),
        sessionId,
        opType: value.type,
        cardId,
        state: 'rejected',
        reason: 'thread-unknown',
        at: this.now(),
      });
    }
    if (!record.online) {
      return this.recordReceipt({
        opId: this.newOpId(),
        sessionId,
        opType: value.type,
        cardId,
        state: 'rejected',
        reason: 'thread-offline',
        at: this.now(),
      });
    }
    if (!record.descriptor.capabilities.includes(value.type)) {
      return this.recordReceipt({
        opId: this.newOpId(),
        sessionId,
        opType: value.type,
        cardId,
        state: 'rejected',
        reason: 'not-capable',
        at: this.now(),
      });
    }
    const opId = this.newOpId();
    const at = this.now();
    this.receipts.set(opId, {
      opId,
      sessionId,
      opType: value.type,
      cardId,
      state: 'accepted',
      at,
      workerId: record.hostWorkerId,
    });
    this.boundReceipts(sessionId);
    const receipt: Receipt = { opId, sessionId, opType: value.type, cardId, state: 'accepted', at };
    this.emit({ type: 'receipt', receipt });
    this.deliver?.(record.hostWorkerId, { opId, sessionId, intent: value });
    this.persistHook?.();
    return receipt;
  }

  reportReceipt(workerId: string, report: ReceiptReport): void {
    this.applyReport(workerId, report);
    this.persistHook?.();
  }

  workerConnected(workerId: string): void {
    for (const record of this.threads.values()) {
      if (record.hostWorkerId !== workerId || record.online) continue;
      record.online = true;
      this.emit({ type: 'thread.upsert', summary: this.summaryOf(record) });
    }
    this.persistHook?.();
  }

  workerDisconnected(workerId: string): void {
    for (const record of this.threads.values()) {
      if (record.hostWorkerId !== workerId || !record.online) continue;
      record.online = false;
      this.emit({ type: 'thread.upsert', summary: this.summaryOf(record) });
    }
    this.persistHook?.();
  }

  removeOfflineThread(sessionId: string): RemoveThreadResult {
    const record = this.threads.get(sessionId);
    if (record === undefined) return { ok: true };
    if (record.online) return { ok: false, reason: 'refused-online' };
    this.threads.delete(sessionId);
    this.emit({ type: 'thread.removed', sessionId });
    this.markReceiptsLost((receipt) => receipt.sessionId === sessionId, 'thread-removed');
    this.persistHook?.();
    return { ok: true };
  }

  dropOwner(tokenId: string): void {
    const affectedWorkers = new Set<string>();
    const ownedSessionIds = [...this.threads.keys()];
    for (const sessionId of ownedSessionIds) {
      const record = this.threads.get(sessionId)!;
      if (record.ownerTokenId !== tokenId) continue;
      affectedWorkers.add(record.hostWorkerId);
      this.threads.delete(sessionId);
      this.emit({ type: 'thread.removed', sessionId });
    }
    this.markReceiptsLost(
      (receipt) => receipt.workerId !== undefined && affectedWorkers.has(receipt.workerId),
      'machine-revoked',
    );
    this.persistHook?.();
  }

  unregister(workerId: string, finalReceipts: ReceiptReport[]): void {
    for (const report of finalReceipts) this.applyReport(workerId, report);
    const hostedIds = [...this.threads.keys()];
    for (const sessionId of hostedIds) {
      const record = this.threads.get(sessionId)!;
      if (record.hostWorkerId !== workerId) continue;
      this.threads.delete(sessionId);
      this.emit({ type: 'thread.removed', sessionId });
    }
    this.markReceiptsLost((receipt) => receipt.workerId === workerId, 'thread-removed');
    this.persistHook?.();
  }

  inbox(): ThreadSummary[] {
    return [...this.threads.values()].map((record) => this.summaryOf(record));
  }

  threadSnapshot(sessionId: string): { descriptor: Descriptor; overview: Overview; online: boolean; timeline: TimelineEntry[]; openCards: Card[]; receipts: Receipt[] } | undefined {
    const record = this.threads.get(sessionId);
    if (record === undefined) return undefined;
    return {
      descriptor: record.descriptor,
      overview: record.overview,
      online: record.online,
      timeline: truncateTimeline(record.timeline.slice()),
      openCards: [...record.openCards.values()],
      receipts: this.receiptsFor(sessionId),
    };
  }

  receiptsFor(sessionId: string): Receipt[] {
    return [...this.receipts.values()]
      .filter((receipt) => receipt.sessionId === sessionId)
      .map((receipt) => this.publicReceipt(receipt));
  }

  threadsForWorker(workerId: string): string[] {
    return [...this.threads.values()]
      .filter((record) => record.hostWorkerId === workerId)
      .map((record) => record.sessionId);
  }

  markWorkerReceiptsLost(workerId: string): void {
    const sessionIds = new Set<string>();
    for (const receipt of this.receipts.values()) {
      if (receipt.workerId !== workerId || TERMINAL_RECEIPT_STATES.has(receipt.state)) continue;
      sessionIds.add(receipt.sessionId);
    }
    this.markReceiptsLost((receipt) => receipt.workerId === workerId, 'not-delivered');
    for (const sessionId of sessionIds) this.boundReceipts(sessionId);
    this.persistHook?.();
  }

  onFanout(listener: FanoutListener): void {
    this.listeners.add(listener);
  }

  onPersist(listener: () => void): void {
    this.persistHook = listener;
  }

  private reconcileReceipts(workerId: string, reports: ReceiptReport[]): void {
    const seen = new Map(reports.map((report) => [report.opId, report]));
    const openOpIds = [...this.receipts.keys()];
    for (const opId of openOpIds) {
      const receipt = this.receipts.get(opId)!;
      if (receipt.workerId !== workerId || TERMINAL_RECEIPT_STATES.has(receipt.state)) continue;
      const report = seen.get(opId);
      if (report === undefined) {
        this.receipts.set(opId, { ...receipt, state: 'lost', reason: 'not-delivered' });
        this.emit({ type: 'receipt', receipt: this.publicReceipt(this.receipts.get(opId)!) });
        continue;
      }
      if (receipt.state === report.state && receipt.reason === report.reason) continue;
      this.receipts.set(opId, { ...receipt, state: report.state, reason: report.reason });
      this.emit({ type: 'receipt', receipt: this.publicReceipt(this.receipts.get(opId)!) });
    }
  }

  private applyReport(workerId: string, report: ReceiptReport): void {
    const receipt = this.receipts.get(report.opId);
    if (receipt === undefined || receipt.workerId !== workerId) return;
    if (TERMINAL_RECEIPT_STATES.has(receipt.state)) return;
    if (receipt.state === 'accepted' && report.state !== 'delivered') return;
    if (receipt.state === 'delivered' && report.state === 'delivered') return;
    this.receipts.set(report.opId, { ...receipt, state: report.state, reason: report.reason });
    this.boundReceipts(receipt.sessionId);
    this.emit({ type: 'receipt', receipt: this.publicReceipt(this.receipts.get(report.opId)!) });
  }

  private markReceiptsLost(
    workerMatch: (receipt: Receipt & { workerId?: string }) => boolean,
    reason: 'thread-removed' | 'machine-revoked' | 'not-delivered',
  ): void {
    const candidateOpIds = [...this.receipts.keys()];
    for (const opId of candidateOpIds) {
      const receipt = this.receipts.get(opId)!;
      if (TERMINAL_RECEIPT_STATES.has(receipt.state)) continue;
      if (!workerMatch(receipt)) continue;
      this.receipts.set(opId, { ...receipt, state: 'lost', reason });
      this.emit({ type: 'receipt', receipt: this.publicReceipt(this.receipts.get(opId)!) });
    }
  }

  private boundReceipts(sessionId: string): void {
    const terminal = [...this.receipts.entries()]
      .filter(([, receipt]) => receipt.sessionId === sessionId && TERMINAL_RECEIPT_STATES.has(receipt.state))
      .toSorted((a, b) => a[1].at - b[1].at);
    let excess = terminal.length - this.receiptsPerThread;
    for (const [opId] of terminal) {
      if (excess <= 0) break;
      this.receipts.delete(opId);
      excess -= 1;
    }
  }

  private summaryOf(record: ThreadRecord): ThreadSummary {
    return {
      descriptor: record.descriptor,
      overview: record.overview,
      online: record.online,
      openCards: [...record.openCards.values()].map(({ cardId, kind, openedAt }) => ({ cardId, kind, openedAt })),
      lastActivityAt: lastActivityOf(record),
    };
  }

  private recordReceipt(receipt: Receipt): Receipt {
    if (receiptSchema.safeParse(receipt).success) {
      this.receipts.set(receipt.opId, receipt);
      this.boundReceipts(receipt.sessionId);
      this.emit({ type: 'receipt', receipt });
      this.persistHook?.();
    }
    return receipt;
  }

  private publicReceipt(receipt: Receipt & { workerId?: string }): Receipt {
    const { workerId: _workerId, ...rest } = receipt;
    return rest;
  }

  private emit(event: FanoutEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
