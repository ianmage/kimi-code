import { basename } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

import type { Session, SessionPlan } from '@moonshot-ai/kimi-code-sdk';
import type { Card, Descriptor, OpType, Overview, TimelineEntry, WorkerSnapshot } from '@moonshot-ai/forum-link';

import type { TodoItem } from '#/tui/components/chrome/todo-panel';
import type { ApprovalController } from '#/tui/reverse-rpc/approval/controller';
import type { QuestionController } from '#/tui/reverse-rpc/question/controller';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import type { SteerInputItem } from '#/tui/types';
import type { ReverseRPCUIHooks } from '../../reverse-rpc/index';
import type { ApprovalPanelData, QuestionPanelData } from '../../reverse-rpc/types';
import type { AppState, TranscriptEntry } from '../../types';
import { resolveEndSessionMode } from './end-session';
import { Injector, type OpenCardView } from './injector';
import type { SessionControlHostView } from './session-control';
import { Link, type LinkOptions, type LinkTiming } from './link';
import { Projector } from './projector';

export type ForumLinkState = 'detached' | 'connecting' | 'published' | 'backoff';

export type ForumLinkStartResult =
  | { ok: true }
  | { ok: false; reason: 'already-active' | 'no-session' | 'connect-failed'; error?: unknown };

export type ForumLinkCardKind = 'approval' | 'question';

export interface ForumLinkHostFace {
  readonly appState: () => AppState;
  readonly approvalController: ApprovalController;
  readonly questionController: QuestionController;
  readonly sendNormalUserInput: (text: string) => Promise<void>;
  readonly createNewSession: () => Promise<void>;
  readonly showStatus: (message: string) => void;
  readonly steerMessage: (session: Session, input: readonly SteerInputItem[]) => void;
  readonly slashHost: SlashCommandHost;
  readonly getTodos: () => readonly TodoItem[];
  readonly getPlan: () => Promise<SessionPlan | null>;
  readonly cancelForeground: () => void;
  session(): Session | undefined;
  workDir(): string;
  sessionTitle(): string | null;
}

export const FORUM_LINK_CAPABILITIES: readonly OpType[] = [
  'approve',
  'approve-cancel',
  'answer',
  'answer-cancel',
  'send',
  'steer',
  'pause',
  'end-session',
  'set-permission-mode',
  'switch-model',
  'new-session',
  'goal-set',
  'goal-pause',
  'goal-resume',
  'goal-cancel',
];

export interface ForumLinkControllerDeps {
  readonly host?: ForumLinkHostFace;
  readonly linkTiming?: LinkTiming;
  readonly overviewIntervalMs?: number;
  readonly endSessionTiming?: { idleWaitTimeoutMs?: number };
  readonly newCardId?: () => string;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_IDLE_WAIT_TIMEOUT_MS = 5000;
const DEFAULT_OVERVIEW_INTERVAL_MS = 2000;

const LINK_STATE_NOTICES: Record<ForumLinkState, string> = {
  connecting: 'Forum Link: connecting...',
  published: 'Forum Link: published',
  backoff: 'Forum Link: connection lost, retrying...',
  detached: 'Forum Link: unpublished',
};

export function forumLinkStateNotice(state: ForumLinkState): string {
  return LINK_STATE_NOTICES[state];
}

const RECONNECTING_NOTICE = 'Forum Link: reconnecting...';

const END_SESSION_IDLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'turn.ended',
  'compaction.completed',
  'compaction.cancelled',
]);

const DEFAULT_CARD_OUTCOME: Record<ForumLinkCardKind, string> = {
  approval: 'approved',
  question: 'answered',
};

interface CardEntry {
  readonly kind: ForumLinkCardKind;
  readonly panelData: ApprovalPanelData | QuestionPanelData;
  readonly panelRef: ApprovalController | QuestionController;
}

export function createForumLinkController(host: ForumLinkHostFace): ForumLinkController {
  return new ForumLinkController({ host });
}

export class ForumLinkController {
  private linkState: ForumLinkState = 'detached';
  private currentSession?: Session;
  private sessionUnsubscribe?: () => void;
  private projector!: Projector;
  private link?: Link;
  private injector?: Injector;
  private readonly openCardsMap = new Map<string, CardEntry>();
  private readonly deps: ForumLinkControllerDeps;
  private overviewDirty = false;
  private overviewTimer: ReturnType<typeof setTimeout> | undefined;
  private currentOverview?: Overview;
  private readonly host: ForumLinkHostFace | undefined;

  constructor(deps: ForumLinkControllerDeps) {
    this.deps = deps;
    this.host = deps.host;
    this.resetProjector();
    if (this.host !== undefined) {
      const hostView: SessionControlHostView = {
        slashHost: this.host.slashHost,
        sendNormalUserInput: this.host.sendNormalUserInput,
        steerMessage: this.host.steerMessage,
        cancelForeground: this.host.cancelForeground,
        createNewSession: this.host.createNewSession,
        runEndSession: (opts?: { beforeEnd?: () => void }) => this.runEndSession(opts),
        session: () => this.currentSession,
      };
      this.injector = new Injector(
        {
          reportReceipt: (report) => this.link?.reportReceipt(report),
          getOpenCard: (cardId) => this.getOpenCardView(cardId),
          isCurrentPanel: (cardId) => this.openCardsMap.has(cardId),
          respondApproval: (cardId, response) => this.respondCard(cardId, 'approval', () => {
            (this.openCardsMap.get(cardId)!.panelRef as ApprovalController).respond(response);
          }),
          respondQuestion: (cardId, response) => this.respondCard(cardId, 'question', () => {
            (this.openCardsMap.get(cardId)!.panelRef as QuestionController).respond(response);
          }),
        },
        hostView,
      );
    }
  }

  get state(): ForumLinkState {
    return this.linkState;
  }

  get session(): Session | undefined {
    return this.currentSession;
  }

  get openCards(): readonly { cardId: string; kind: ForumLinkCardKind }[] {
    return [...this.openCardsMap.entries()].map(([cardId, entry]) => ({
      cardId,
      kind: entry.kind,
    }));
  }

  async start(credential: Pick<LinkOptions, 'url' | 'token'>): Promise<ForumLinkStartResult> {
    if (this.linkState !== 'detached') return { ok: false, reason: 'already-active' };
    const session = this.currentSession;
    if (session === undefined) return { ok: false, reason: 'no-session' };
    this.resetProjector();
    this.attachSession(session);
    this.link = new Link({
      url: credential.url,
      token: credential.token,
      getSnapshot: () => this.getSnapshot(),
      onOp: (op) => {
        void this.injector?.handle(op);
      },
      onStateChange: (next) => {
        this.setLinkState(next);
      },
      onFatal: (message) => {
        this.clearOverviewTimer();
        this.setLinkState('detached');
        this.host?.showStatus(message);
      },
      timing: this.deps.linkTiming,
      fetchImpl: this.deps.fetchImpl,
    });
    this.link.start();
    return { ok: true };
  }

  async stop(): Promise<void> {
    this.clearOverviewTimer();
    this.sessionUnsubscribe?.();
    this.sessionUnsubscribe = undefined;
    await this.link?.stop();
    this.link = undefined;
    this.openCardsMap.clear();
    this.overviewDirty = false;
    this.setLinkState('detached');
  }

  getSnapshot(): Omit<WorkerSnapshot, 'recentReceipts'> {
    const session = this.currentSession;
    const sessionId = session?.id ?? 'unattached';
    return {
      workerId: this.workerId(),
      threads: [
        {
          descriptor: this.buildDescriptor(sessionId),
          overview: this.currentOverview ?? this.sampleOverviewNow(),
          timeline: this.projector.snapshotTimeline(),
          openCards: this.snapshotOpenCards(),
        },
      ],
    };
  }

  onTranscriptEntry(entry: TranscriptEntry): void {
    this.enqueueTimelineEntry(this.projector.onTranscriptEntry(entry));
    if (entry.kind === 'user') this.markOverviewDirty();
  }

  onSessionEvent(event: Parameters<Projector['handleEvent']>[0]): void {
    const type = event.type as string;
    if (
      type === 'tool.result' ||
      type.startsWith('subagent.') ||
      type.startsWith('background.task.')
    ) {
      this.markOverviewDirty();
    }
    if (type === 'assistant.delta') this.markOverviewDirty();
    this.enqueueTimelineEntry(this.projector.handleEvent(event));
  }

  onSessionChanged(session: Session): void {
    this.settleAllOpenCards('cancelled');
    this.resetProjector();
    this.sessionUnsubscribe?.();
    this.sessionUnsubscribe = undefined;
    this.currentSession = session;
    this.attachSession(session);
    if (this.linkState === 'detached') return;
    this.link?.resync();
  }

  onAppStateChanged(): void {
    this.markOverviewDirty();
  }

  onCardOpened(
    kind: ForumLinkCardKind,
    upstreamId: string,
    payload: ApprovalPanelData | QuestionPanelData,
  ): void {
    if (this.host === undefined) return;
    if (this.findByUpstreamId(kind, upstreamId) !== undefined) return;
    const cardId = this.mintCardId(kind);
    const panelRef =
      kind === 'approval' ? this.host.approvalController : this.host.questionController;
    this.openCardsMap.set(cardId, { kind, panelData: payload, panelRef });
    this.enqueueTimelineEntry(this.projector.onCardOpened(kind, cardId, payload));
    this.syncCardLifecycle();
  }

  onCardClosed(kind: ForumLinkCardKind, upstreamId: string, outcome?: string): void {
    const entry = this.findByUpstreamId(kind, upstreamId);
    if (entry === undefined) return;
    this.openCardsMap.delete(entry.cardId);
    this.enqueueTimelineEntry(
      this.projector.onCardSettled(entry.cardId, outcome ?? DEFAULT_CARD_OUTCOME[kind]),
    );
    this.syncCardLifecycle();
  }

  getOpenCardView(cardId: string): OpenCardView | undefined {
    const entry = this.openCardsMap.get(cardId);
    if (entry === undefined) return undefined;
    return {
      kind: entry.kind,
      approval: entry.kind === 'approval' ? (entry.panelData as ApprovalPanelData) : undefined,
      question: entry.kind === 'question' ? (entry.panelData as QuestionPanelData) : undefined,
    };
  }

  isCurrentPanelCard(cardId: string): boolean {
    return this.openCardsMap.has(cardId);
  }

  private respondCard(
    cardId: string,
    kind: ForumLinkCardKind,
    respond: () => void,
  ): void {
    const entry = this.openCardsMap.get(cardId);
    if (entry === undefined || entry.kind !== kind) return;
    respond();
  }

  async runEndSession(opts?: { beforeEnd?: () => void }): Promise<void> {
    const session = this.currentSession;
    if (session === undefined) return;
    const mode = resolveEndSessionMode(this.host?.appState());
    if (mode === 'immediate') {
      opts?.beforeEnd?.();
      await this.host?.createNewSession();
      return;
    }
    const idle = this.waitForIdle(session);
    if (mode === 'compaction') await session.cancelCompaction();
    else await session.cancel();
    opts?.beforeEnd?.();
    if (await idle) await this.host?.createNewSession();
  }

  private resetProjector(): void {
    this.projector = new Projector({
      getPlan: this.host === undefined ? undefined : async () => this.host!.getPlan(),
    });
    this.currentOverview = undefined;
    this.overviewDirty = false;
  }

  private attachSession(session: Session): void {
    this.sessionUnsubscribe?.();
    this.sessionUnsubscribe = session.onEvent((event) => {
      this.onSessionEvent(event);
    });
  }

  private setLinkState(next: ForumLinkState): void {
    const previous = this.linkState;
    if (previous === next) return;
    this.linkState = next;
    let notice = LINK_STATE_NOTICES[next];
    if (previous === 'backoff' && next === 'connecting') notice = RECONNECTING_NOTICE;
    this.host?.showStatus(notice);
    if (next === 'published') {
      this.markOverviewDirty();
    }
  }

  private mintCardId(kind: ForumLinkCardKind): string {
    const uuid = this.deps.newCardId?.() ?? randomUUID();
    return `${kind}_${uuid}`;
  }

  private findByUpstreamId(
    kind: ForumLinkCardKind,
    upstreamId: string,
  ): { cardId: string; entry: CardEntry } | undefined {
    for (const [cardId, entry] of this.openCardsMap) {
      if (entry.kind !== kind) continue;
      if ((entry.panelData as { id?: string }).id === upstreamId) return { cardId, entry };
    }
    return undefined;
  }

  private settleAllOpenCards(outcome: string): void {
    for (const [cardId] of this.openCardsMap) {
      this.enqueueTimelineEntry(this.projector.onCardSettled(cardId, outcome));
    }
    this.openCardsMap.clear();
  }

  private appendPlanBodyExtra(cardId: string, card: Card): void {
    const extras = this.projector.planBodyBlock(cardId);
    if (extras === undefined) return;
    const approval = card['approval'] as { display?: unknown[] } | undefined;
    if (approval === undefined) return;
    approval.display = [...(approval.display ?? []), extras];
  }

  private syncCardLifecycle(): void {
    if (this.linkState === 'detached') return;
    this.link?.resync();
  }

  private enqueueTimelineEntry(entry: TimelineEntry | undefined): void {
    if (entry === undefined || this.linkState === 'detached') return;
    const session = this.currentSession;
    if (session === undefined) return;
    this.link?.enqueue({ sessionId: session.id, kind: 'timeline', entries: [entry] });
  }

  private markOverviewDirty(): void {
    if (this.linkState === 'detached') return;
    this.overviewDirty = true;
    if (this.overviewTimer !== undefined) return;
    const interval = this.deps.overviewIntervalMs ?? DEFAULT_OVERVIEW_INTERVAL_MS;
    this.overviewTimer = setTimeout(() => {
      this.overviewTimer = undefined;
      this.flushOverviewIfDirty();
    }, interval);
    this.overviewTimer.unref?.();
  }

  private flushOverviewIfDirty(): void {
    if (!this.overviewDirty) return;
    if (this.linkState === 'detached') {
      this.overviewDirty = false;
      return;
    }
    this.overviewDirty = false;
    const session = this.currentSession;
    if (session === undefined) return;
    const overview = this.sampleOverviewNow();
    this.link?.enqueue({ sessionId: session.id, kind: 'overview', overview });
  }

  private sampleOverviewNow(): Overview {
    const host = this.host;
    if (host === undefined) {
      return this.projector.sampleOverview(
        FALLBACK_APP_STATE,
        [],
        this.projector.eventFolds,
        {},
        '',
      );
    }
    const appState = host.appState();
    this.currentOverview = this.projector.sampleOverview(
      appState,
      host.getTodos(),
      this.projector.eventFolds,
      appState.availableModels,
      '',
    );
    return this.currentOverview;
  }

  private snapshotOpenCards(): Card[] {
    return [...this.openCardsMap.entries()].map(([cardId, entry]) => {
      const card = this.projector.projectCard(cardId, entry.panelData);
      this.appendPlanBodyExtra(cardId, card);
      return card;
    });
  }

  private buildDescriptor(sessionId: string): Descriptor {
    const host = this.host;
    return {
      sessionId,
      machine: { tokenName: '', hostname: hostname() },
      project: host === undefined ? '' : basename(host.workDir()),
      title: host?.sessionTitle() ?? '',
      kind: 'interactive',
      capabilities: [...FORUM_LINK_CAPABILITIES],
    };
  }

  private workerId(): string {
    return this.workerIdValue ?? (this.workerIdValue = `worker_${randomUUID()}`);
  }

  private workerIdValue: string | undefined;
  private waitForIdle(session: Session): Promise<boolean> {
    const timeoutMs = this.deps.endSessionTiming?.idleWaitTimeoutMs ?? DEFAULT_IDLE_WAIT_TIMEOUT_MS;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idleEvent = new Promise<boolean>((resolve) => {
      unsubscribe = session.onEvent((event) => {
        if (END_SESSION_IDLE_EVENT_TYPES.has(event.type)) resolve(true);
      });
    });
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
    });
    return Promise.race([idleEvent, timeout]).finally(() => {
      clearTimeout(timer);
      unsubscribe?.();
    });
  }

  private clearOverviewTimer(): void {
    if (this.overviewTimer !== undefined) {
      clearTimeout(this.overviewTimer);
      this.overviewTimer = undefined;
    }
  }
}

const FALLBACK_APP_STATE = {
  streamingPhase: 'idle',
  isCompacting: false,
  model: '',
  thinkingEffort: 'off',
  permissionMode: 'auto',
  planMode: false,
  contextUsage: 0,
  goal: null,
} as const;

export function wrapUiHooksForForumLink(
  original: ReverseRPCUIHooks,
  controller: ForumLinkController | undefined | (() => ForumLinkController | undefined),
): ReverseRPCUIHooks {
  const resolve = (): ForumLinkController | undefined =>
    typeof controller === 'function' ? controller() : controller;

  let lastShownApprovalId: string | undefined;
  let lastShownQuestionId: string | undefined;

  const settleSupersededCard = (
    kind: ForumLinkCardKind,
    previousId: string | undefined,
    nextId: string,
  ): void => {
    if (previousId === undefined || previousId === nextId) return;
    resolve()?.onCardClosed(kind, previousId);
  };

  return {
    showApprovalPanel: (payload) => {
      original.showApprovalPanel(payload);
      const active = resolve();
      if (active === undefined) return;
      settleSupersededCard('approval', lastShownApprovalId, payload.id);
      lastShownApprovalId = payload.id;
      active.onCardOpened('approval', payload.id, payload);
    },
    hideApprovalPanel: () => {
      original.hideApprovalPanel();
      const active = resolve();
      const upstreamId = lastShownApprovalId;
      lastShownApprovalId = undefined;
      if (active === undefined || upstreamId === undefined) return;
      active.onCardClosed('approval', upstreamId);
    },
    showQuestionDialog: (payload) => {
      original.showQuestionDialog(payload);
      const active = resolve();
      if (active === undefined) return;
      settleSupersededCard('question', lastShownQuestionId, payload.id);
      lastShownQuestionId = payload.id;
      active.onCardOpened('question', payload.id, payload);
    },
    hideQuestionDialog: () => {
      original.hideQuestionDialog();
      const active = resolve();
      const upstreamId = lastShownQuestionId;
      lastShownQuestionId = undefined;
      if (active === undefined || upstreamId === undefined) return;
      active.onCardClosed('question', upstreamId);
    },
  };
}
