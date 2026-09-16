import type { ActionFrame, CardState, Descriptor, Entry } from '#/contract/frames';

export interface TimelineItem {
  seq: number;
  entry: Entry;
}

export type PageCardState = CardState;

export interface ThreadStoreOptions {
  onTimelineChange?: (items: readonly TimelineItem[]) => void;
  onCardsChange?: (cards: readonly CardState[]) => void;
  onDescriptorChange?: (descriptor: Descriptor) => void;
  onResyncNeeded?: () => void;
}

export interface SnapshotPayload {
  descriptor: Descriptor;
  entries: ReadonlyArray<{ seq: number; entry: Entry }>;
  maxSeq: number;
  openCards: ReadonlyArray<CardState>;
}

export function isCardActionable(card: CardState, status: Descriptor['status']): boolean {
  return card.state === 'open' && status !== 'idle';
}

export function needsConfirmation(actionType: ActionFrame['type']): boolean {
  return actionType === 'approve' || actionType === 'end-session';
}

export class ThreadStore {
  private readonly options: ThreadStoreOptions;
  private readonly items: TimelineItem[] = [];
  private readonly cards = new Map<string, CardState>();
  private readonly settledOutcomes = new Map<string, CardState['state']>();
  private currentDescriptor: Descriptor | undefined;
  private lastSeq = 0;

  constructor(options?: ThreadStoreOptions) {
    this.options = options ?? {};
  }

  get timeline(): readonly TimelineItem[] {
    return this.items;
  }

  get openCards(): readonly CardState[] {
    return Array.from(this.cards.values(), (card) => ({ ...card }));
  }

  get descriptor(): Descriptor | undefined {
    return this.currentDescriptor === undefined ? undefined : { ...this.currentDescriptor };
  }

  applySnapshot(snapshot: SnapshotPayload): void {
    this.items.length = 0;
    const sorted = [...snapshot.entries].toSorted((a, b) => a.seq - b.seq);
    for (const item of sorted) this.items.push({ seq: item.seq, entry: item.entry });
    this.cards.clear();
    this.settledOutcomes.clear();
    for (const card of snapshot.openCards) {
      this.cards.set(card.cardId, { ...card });
      if (card.state !== 'open') this.settledOutcomes.set(card.cardId, card.state);
    }
    this.lastSeq = snapshot.maxSeq;
    this.setDescriptor(snapshot.descriptor);
    this.options.onTimelineChange?.(this.timeline);
    this.options.onCardsChange?.(this.openCards);
  }

  applyEntry(seq: number, entry: Entry): void {
    if (seq <= this.lastSeq) return;
    if (seq > this.lastSeq + 1) {
      this.options.onResyncNeeded?.();
      return;
    }
    this.lastSeq = seq;
    this.items.push({ seq, entry });
    this.options.onTimelineChange?.(this.timeline);
    if (entry.kind === 'question-card') this.registerOpenCard(entry.cardId, 'question');
    else if (entry.kind === 'approval-card') this.registerOpenCard(entry.cardId, 'approval');
    else if (entry.kind === 'card-settled') this.settleCard(entry.cardId, entry.outcome);
  }

  applyReset(descriptor: Descriptor): void {
    this.items.length = 0;
    this.cards.clear();
    this.settledOutcomes.clear();
    this.lastSeq = 0;
    this.setDescriptor(descriptor);
    this.options.onTimelineChange?.(this.timeline);
    this.options.onCardsChange?.(this.openCards);
  }

  applyDescriptor(descriptor: Descriptor): void {
    this.setDescriptor(descriptor);
  }

  private setDescriptor(descriptor: Descriptor): void {
    this.currentDescriptor = { ...descriptor };
    this.options.onDescriptorChange?.(this.descriptor!);
  }

  private registerOpenCard(cardId: string, kind: CardState['kind']): void {
    const outcome = this.settledOutcomes.get(cardId);
    const existing = this.cards.get(cardId);
    const state: CardState['state'] = outcome ?? 'open';
    if (existing !== undefined && existing.state !== 'open') return;
    this.cards.set(cardId, { cardId, kind, state });
    this.options.onCardsChange?.(this.openCards);
  }

  private settleCard(cardId: string, outcome: CardState['state']): void {
    this.settledOutcomes.set(cardId, outcome);
    const card = this.cards.get(cardId);
    if (card === undefined) return;
    this.cards.set(cardId, { cardId, kind: card.kind, state: outcome });
    this.options.onCardsChange?.(this.openCards);
  }
}
