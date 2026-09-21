import type { Event, Session, Unsubscribe } from '@moonshot-ai/kimi-code-sdk';
import type { Descriptor, Entry, UplinkFrame } from '@moonshot-ai/forum-link';

import { MAIN_AGENT_ID } from '#/tui/constant/kimi-tui';
import type { ApprovalPanelData, QuestionPanelData } from '#/tui/reverse-rpc/types';

export type ProjectorStatus = 'waiting-question' | 'running' | 'idle';

export type CardSettlementOutcome = 'answered' | 'approved' | 'rejected' | 'cancelled';

export interface ProjectorEventStats {
  seen: number;
  projected: number;
  dropped: number;
}

export interface ProjectorLimits {
  /** Cap on projected assistant text length; defaults to 4000. */
  maxTextChars?: number;
}

export interface ProjectorOptions {
  emit: (frame: UplinkFrame) => void;
  limits?: ProjectorLimits;
  /** Defaults to MAIN_AGENT_ID; injectable for tests. */
  mainAgentId?: string;
  onStatusChange?: (status: ProjectorStatus) => void;
}

const DEFAULT_MAX_TEXT_CHARS = 4000;

const DEBUG_ENV_VAR = 'KIMI_CODE_FORUM_LINK_DEBUG';
const DEBUG_ON_VALUES = new Set(['1', 'true']);

/**
 * Coarse projected/dropped predicate for the debug counters: the four
 * whitelist types on the main agent count as projected even when the handler
 * ends up emitting nothing (blocked prompt, empty text). Mirrors the
 * `handleEvent` switch — keep both in sync.
 */
const PROJECTED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'prompt.submitted',
  'turn.started',
  'assistant.delta',
  'turn.ended',
]);

interface OpenProjectorCard {
  readonly cardId: string;
  readonly kind: 'question' | 'approval';
}

function isQuestionPanelData(
  payload: ApprovalPanelData | QuestionPanelData,
): payload is QuestionPanelData {
  return 'questions' in payload;
}

/**
 * Derives L1 uplink frames from session activity via two whitelist gates:
 * main-agent events only, then a fixed event-type mapping. Assistant text is
 * buffered per turn and flushed once on `turn.ended` (a cancelled turn still
 * flushes partial text and settles its open cards). User messages come only
 * from `prompt.submitted`, which replay never emits — the S1 transcript seam
 * is deliberately not consumed here.
 */
export class Projector {
  private readonly emit: (frame: UplinkFrame) => void;
  private readonly limits: Required<ProjectorLimits>;
  private readonly mainAgentId: string;
  private readonly onStatusChange: ((status: ProjectorStatus) => void) | undefined;
  private readonly debugStats: Map<string, ProjectorEventStats> | undefined;

  private statusValue: ProjectorStatus = 'idle';
  private unsubscribe?: Unsubscribe;
  private turnText = '';
  private openCards: OpenProjectorCard[] = [];

  constructor(options: ProjectorOptions) {
    this.emit = options.emit;
    this.limits = {
      maxTextChars: options.limits?.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS,
    };
    this.mainAgentId = options.mainAgentId ?? MAIN_AGENT_ID;
    this.onStatusChange = options.onStatusChange;
    this.debugStats = DEBUG_ON_VALUES.has(process.env[DEBUG_ENV_VAR] ?? '')
      ? new Map<string, ProjectorEventStats>()
      : undefined;
  }

  get status(): ProjectorStatus {
    return this.statusValue;
  }

  get subscriptionCount(): number {
    return this.unsubscribe === undefined ? 0 : 1;
  }

  /** Uplinks a register frame on the current emit path (session switch). */
  emitRegister(descriptor: Descriptor): void {
    this.emit({ type: 'register', descriptor });
  }

  /** Debug counters keyed by event type; undefined when the flag is off. */
  getStats(): ReadonlyMap<string, ProjectorEventStats> | undefined {
    return this.debugStats;
  }

  attach(session: Session): void {
    if (this.unsubscribe !== undefined) return;
    this.unsubscribe = session.onEvent((event) => {
      this.handleEvent(event);
    });
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.statusValue = 'idle';
    this.turnText = '';
    this.openCards = [];
  }

  handleEvent(event: Event): void {
    this.recordEvent(event);
    if (event.agentId !== this.mainAgentId) return;
    switch (event.type) {
      case 'prompt.submitted':
        this.projectUserMessage(event);
        break;
      case 'turn.started':
        this.setStatus('running');
        break;
      case 'assistant.delta':
        this.turnText += event.delta;
        break;
      case 'turn.ended':
        this.flushTurn(event.reason === 'cancelled');
        break;
      default:
        break;
    }
  }

  onCardOpened(
    kind: 'question' | 'approval',
    cardId: string,
    payload: ApprovalPanelData | QuestionPanelData,
  ): void {
    this.recordCard('card.opened', true);
    if (isQuestionPanelData(payload)) {
      const first = payload.questions[0];
      this.emitEntry({
        kind: 'question-card',
        cardId,
        question: first?.question ?? '',
        options: first?.options.map((option) => option.label) ?? [],
      });
      if (this.statusValue === 'running') this.setStatus('waiting-question');
    } else {
      this.emitEntry({
        kind: 'approval-card',
        cardId,
        toolName: payload.tool_name,
        action: payload.action,
        summary: payload.description,
      });
    }
    this.openCards.push({ cardId, kind });
  }

  onCardClosed(
    kind: 'question' | 'approval',
    cardId: string,
    outcome: CardSettlementOutcome,
  ): void {
    const index = this.openCards.findIndex(
      (card) => card.cardId === cardId && card.kind === kind,
    );
    if (index < 0) {
      this.recordCard('card.closed', false);
      return;
    }
    this.recordCard('card.closed', true);
    this.openCards.splice(index, 1);
    this.emitEntry({ kind: 'card-settled', cardId, outcome });
    if (kind === 'question' && this.statusValue === 'waiting-question') {
      this.setStatus('running');
    }
  }

  private recordEvent(event: Event): void {
    if (this.debugStats === undefined) return;
    const bucket = this.bucketFor(event.type);
    bucket.seen += 1;
    if (event.agentId === this.mainAgentId && PROJECTED_EVENT_TYPES.has(event.type)) {
      bucket.projected += 1;
    } else {
      bucket.dropped += 1;
    }
  }

  private recordCard(bucketName: 'card.opened' | 'card.closed', projected: boolean): void {
    if (this.debugStats === undefined) return;
    const bucket = this.bucketFor(bucketName);
    bucket.seen += 1;
    if (projected) bucket.projected += 1;
    else bucket.dropped += 1;
  }

  private bucketFor(type: string): ProjectorEventStats {
    let bucket = this.debugStats?.get(type);
    if (bucket === undefined) {
      bucket = { seen: 0, projected: 0, dropped: 0 };
      this.debugStats?.set(type, bucket);
    }
    return bucket;
  }

  private projectUserMessage(event: Extract<Event, { type: 'prompt.submitted' }>): void {
    if (event.status === 'blocked') return;
    const text = event.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('');
    if (text.length === 0) return;
    this.emitEntry({ kind: 'message', role: 'user', text });
  }

  private flushTurn(settleOpenCards: boolean): void {
    if (this.turnText.length > 0) {
      const truncated = this.turnText.length > this.limits.maxTextChars;
      const text = truncated ? this.turnText.slice(0, this.limits.maxTextChars) : this.turnText;
      const entry: Entry = truncated
        ? { kind: 'message', role: 'assistant', text, truncated: true }
        : { kind: 'message', role: 'assistant', text };
      this.emitEntry(entry);
    }
    this.turnText = '';
    if (settleOpenCards) {
      for (const card of this.openCards.splice(0)) {
        this.emitEntry({ kind: 'card-settled', cardId: card.cardId, outcome: 'cancelled' });
      }
    }
    this.setStatus('idle');
  }

  private setStatus(next: ProjectorStatus): void {
    if (this.statusValue === next) return;
    this.statusValue = next;
    this.emitEntry({ kind: 'status-marker', status: next });
    this.onStatusChange?.(next);
  }

  private emitEntry(entry: Entry): void {
    this.emit({ type: 'entry', entry });
  }
}
