import type { CardState, Entry } from '#/contract/frames';

export interface BufferOptions {
  bufferSize?: number;
}

export interface ThreadSnapshot {
  descriptor?: never;
  entries: ReadonlyArray<{ seq: number; entry: Entry }>;
  maxSeq: number;
  openCards: ReadonlyArray<CardState>;
}

const DEFAULT_BUFFER_SIZE = 50;

export class ThreadBuffer {
  private readonly bufferSize: number;
  private readonly entries: { seq: number; entry: Entry }[] = [];
  private readonly cards = new Map<string, CardState>();
  private readonly settledOutcomes = new Map<string, CardState['state']>();
  private nextSeq = 1;

  constructor(options?: BufferOptions) {
    this.bufferSize = options?.bufferSize ?? DEFAULT_BUFFER_SIZE;
  }

  append(entry: Entry): number {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    this.entries.push({ seq, entry });
    if (this.entries.length > this.bufferSize) this.entries.shift();
    if (entry.kind === 'question-card') this.registerOpenCard(entry.cardId, 'question');
    else if (entry.kind === 'approval-card') this.registerOpenCard(entry.cardId, 'approval');
    else if (entry.kind === 'card-settled') this.settleCard(entry.cardId, entry.outcome);
    return seq;
  }

  settleCard(cardId: string, outcome: CardState['state']): void {
    this.settledOutcomes.set(cardId, outcome);
    const card = this.cards.get(cardId);
    if (card) this.cards.set(cardId, { cardId, kind: card.kind, state: outcome });
  }

  snapshot(): ThreadSnapshot {
    return {
      entries: this.entries.map((item) => ({ seq: item.seq, entry: item.entry })),
      maxSeq: this.nextSeq - 1,
      openCards: Array.from(this.cards.values(), (card) => ({ ...card })),
    };
  }

  reset(): void {
    this.nextSeq = 1;
    this.entries.length = 0;
    this.cards.clear();
    this.settledOutcomes.clear();
  }

  private registerOpenCard(cardId: string, kind: CardState['kind']): void {
    const outcome = this.settledOutcomes.get(cardId);
    this.cards.set(cardId, { cardId, kind, state: outcome ?? 'open' });
  }
}
