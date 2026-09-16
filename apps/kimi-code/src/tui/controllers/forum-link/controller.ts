import { basename } from 'node:path';
import { hostname } from 'node:os';

import type { Session } from '@moonshot-ai/kimi-code-sdk';
import type { ActionFrame, Descriptor, UplinkFrame } from '@moonshot-ai/forum-link';

import type { ApprovalController } from '#/tui/reverse-rpc/approval/controller';
import type { QuestionController } from '#/tui/reverse-rpc/question/controller';
import type { ReverseRPCUIHooks } from '../../reverse-rpc/index';
import type { ApprovalPanelData, QuestionPanelData } from '../../reverse-rpc/types';
import type { AppState, TranscriptEntry } from '../../types';
import { resolveEndSessionMode } from './end-session';
import { Injector } from './injector';
import { Link, type LinkCredential } from './link';
import { Projector, type CardSettlementOutcome } from './projector';

export interface OpenCard {
  readonly cardId: string;
  readonly kind: 'question' | 'approval';
  readonly upstreamId: string;
}

export type ForumLinkState = 'detached' | 'connecting' | 'published' | 'backoff';

export type ForumLinkStartResult =
  | { ok: true }
  | { ok: false; reason: 'already-active' | 'no-session' | 'no-descriptor' | 'connect-failed'; error?: unknown };

export type ForumLinkCardKind = OpenCard['kind'];

export interface ForumLinkHostFace {
  readonly appState: () => AppState;
  readonly approvalController: ApprovalController;
  readonly questionController: QuestionController;
  readonly sendNormalUserInput: (text: string) => Promise<void>;
  readonly createNewSession: () => Promise<void>;
  readonly showStatus: (message: string) => void;
  session(): Session | undefined;
  workDir(): string;
  sessionTitle(): string | null;
}

/**
 * Assembly factory for the TUI wiring: keeps the KimiTUI call site to a
 * single line and the descriptor-building knowledge inside this module.
 */
export function createForumLinkController(host: ForumLinkHostFace): ForumLinkController {
  return new ForumLinkController({
    getAppState: host.appState,
    approvalController: host.approvalController,
    questionController: host.questionController,
    sendNormalUserInput: host.sendNormalUserInput,
    createNewSession: host.createNewSession,
    onStatus: host.showStatus,
    buildDescriptor: (session) => ({
      sessionId: session.id,
      machineName: hostname(),
      projectName: basename(host.workDir()),
      title: host.sessionTitle() ?? '',
      status: 'idle',
    }),
  });
}

/**
 * Dependency surface of the controller. Every field is optional so the
 * unwired skeleton can be constructed with an empty object; the downlink
 * injector is only wired when the four host faces (appState plus the two
 * responders and the input sender) are all present.
 */
export interface ForumLinkControllerDeps {
  /** Receives every frame the internal projector derives; absent means drop. */
  onProjectorFrame?: (frame: UplinkFrame) => void;
  /** Receives one-line link state notices; absent means silent. */
  onStatus?: (message: string) => void;
  /**
   * Reads the current app state on every access; present only when the
   * injector host is wired. A getter (not a captured object) so mutations
   * like isCompacting flips are always observed live.
   */
  getAppState?: () => AppState;
  /** Reverse-rpc responder faces for downlink card actions. */
  approvalController?: ApprovalController;
  questionController?: QuestionController;
  /** Sends a user message into the current session. */
  sendNormalUserInput?: (text: string) => Promise<void>;
  /** Creates a fresh session; the end-session orchestration's final step. */
  createNewSession?: () => Promise<void>;
  /** Notified when a downlink card action no longer matches an open card. */
  onDroppedAction?: (frame: ActionFrame) => void;
  /** Assembles the thread descriptor; the publish command injects the real one. */
  buildDescriptor?: (session: Session) => Descriptor;
  /** Bounded idle wait before end-session gives up; sub-second in tests. */
  endSessionTiming?: { idleWaitTimeoutMs?: number };
  /** Link factory; injectable for tests, defaults to the real Link. */
  createLink?: (handlers: LinkHandlers) => Link;
}

export interface LinkHandlers {
  onStateChange: (state: ForumLinkState) => void;
  onAction: (frame: ActionFrame) => void;
}

const DEFAULT_CARD_OUTCOME: Record<ForumLinkCardKind, CardSettlementOutcome> = {
  question: 'answered',
  approval: 'approved',
};

const LINK_STATE_NOTICES: Partial<Record<ForumLinkState, string>> = {
  connecting: 'Forum Link: connecting...',
  published: 'Forum Link: published',
  backoff: 'Forum Link: connection lost, retrying...',
  detached: 'Forum Link: unpublished',
};

const RECONNECTING_NOTICE = 'Forum Link: reconnecting...';

const END_SESSION_TIMEOUT_NOTICE =
  'Forum Link: end-session timed out waiting for idle; staying unpublished';

const DEFAULT_IDLE_WAIT_TIMEOUT_MS = 5000;

const END_SESSION_IDLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'turn.ended',
  'compaction.completed',
  'compaction.cancelled',
]);

/**
 * One-line notice per state transition, with backoff debounce: only the first
 * backoff entry notifies, and recovering to connecting says "reconnecting"
 * instead of "connecting". Same-state transitions and initial detached stay
 * silent.
 */
function linkStateNotice(previous: ForumLinkState, next: ForumLinkState): string | undefined {
  if (previous === next) return undefined;
  if (previous === 'backoff' && next === 'connecting') return RECONNECTING_NOTICE;
  return LINK_STATE_NOTICES[next];
}

export class ForumLinkController {
  private linkState: ForumLinkState = 'detached';
  private readonly openCardsList: OpenCard[] = [];
  private nextCardNumber = 0;
  private readonly projector: Projector;
  private readonly injector?: Injector;
  private link?: Link;
  private currentSession?: Session;

  constructor(private readonly deps: ForumLinkControllerDeps) {
    this.projector = new Projector({
      emit: (frame) => {
        this.handleProjectorFrame(frame);
      },
    });
    if (
      deps.getAppState === undefined ||
      deps.approvalController === undefined ||
      deps.questionController === undefined ||
      deps.sendNormalUserInput === undefined
    ) {
      this.injector = undefined;
      return;
    }
    const currentSession = (): Session | undefined => this.currentSession;
    this.injector = new Injector({
      get session() {
        return currentSession();
      },
      get appState() {
        return deps.getAppState!();
      },
      approvalController: deps.approvalController,
      questionController: deps.questionController,
      sendNormalUserInput: deps.sendNormalUserInput,
      endSession: () => this.runEndSession(),
      getOpenCards: () => this.openCardsList,
      onCardClosed: (kind, upstreamId, outcome) => {
        this.onCardClosed(kind, upstreamId, outcome);
      },
      onDroppedAction: (frame) => deps.onDroppedAction?.(frame),
    });
  }

  get state(): ForumLinkState {
    return this.linkState;
  }

  get session(): Session | undefined {
    return this.currentSession;
  }

  /** Projector's current derived status, mirrored into descriptors. */
  get projectorStatus(): Projector['status'] {
    return this.projector.status;
  }

  /** Downlink entry — forwards a validated action frame to the injector. */
  dispatchAction(frame: ActionFrame): void {
    this.injector?.dispatch(frame);
  }

  /** Link state transition entry point; notifies at most one line per change. */
  setLinkState(next: ForumLinkState): void {
    const notice = linkStateNotice(this.linkState, next);
    this.linkState = next;
    if (notice !== undefined) this.deps.onStatus?.(notice);
  }

  /** The controller is the single owner of card open/close state. */
  get openCards(): readonly OpenCard[] {
    return this.openCardsList;
  }

  /** S1 observation seam — wired in `KimiTUI.appendTranscriptEntry`. */
  onTranscriptEntry(_entry: TranscriptEntry): void {}

  /** S2 observation seam — wired in `KimiTUI.setSession`. */
  onSessionChanged(session: Session): void {
    for (const card of this.openCardsList.splice(0)) {
      this.projector.onCardClosed(card.kind, card.cardId, 'cancelled');
    }
    this.currentSession = session;
    if (this.linkState === 'detached') return;
    this.projector.detach();
    this.projector.attach(session);
    const descriptor = this.deps.buildDescriptor?.(session);
    if (descriptor === undefined) return;
    this.projector.emitRegister(descriptor);
  }

  /** S3 observation seam — a card opened (approval panel / question dialog). */
  onCardOpened(
    kind: ForumLinkCardKind,
    upstreamId: string,
    payload: ApprovalPanelData | QuestionPanelData,
  ): void {
    this.nextCardNumber += 1;
    const cardId = `c${String(this.nextCardNumber)}`;
    this.openCardsList.push({ cardId, kind, upstreamId });
    this.projector.onCardOpened(kind, cardId, payload);
  }

  /** S3 observation seam — the tracked card settled. Unknown ids are no-ops. */
  onCardClosed(kind: ForumLinkCardKind, upstreamId: string, outcome?: CardSettlementOutcome): void {
    const index = this.openCardsList.findIndex(
      (card) => card.kind === kind && card.upstreamId === upstreamId,
    );
    const card = index >= 0 ? this.openCardsList[index] : undefined;
    if (card === undefined) return;
    this.openCardsList.splice(index, 1);
    this.projector.onCardClosed(kind, card.cardId, outcome ?? DEFAULT_CARD_OUTCOME[kind]);
  }

  /**
   * Publish orchestration (M-1): create the link, attach the projector to the
   * current session, and connect. The caller pre-validates the session and
   * resolves the credential; re-entry while not detached is a no-op (toggle
   * semantics live in the command layer). Frames emitted before the link
   * reaches published are dropped — no history backfill (D-I).
   */
  async start(credential: LinkCredential): Promise<ForumLinkStartResult> {
    if (this.linkState !== 'detached') return { ok: false, reason: 'already-active' };
    const session = this.currentSession;
    if (session === undefined) return { ok: false, reason: 'no-session' };
    const descriptor = this.deps.buildDescriptor?.(session);
    if (descriptor === undefined) return { ok: false, reason: 'no-descriptor' };
    if (this.link === undefined) {
      const handlers: LinkHandlers = {
        onStateChange: (state) => {
          this.setLinkState(state);
        },
        onAction: (frame) => {
          this.dispatchAction(frame);
        },
      };
      this.link = this.deps.createLink?.(handlers) ?? new Link(handlers);
    }
    this.projector.attach(session);
    try {
      await this.link.connect(credential, descriptor);
    } catch (error) {
      return { ok: false, reason: 'connect-failed', error };
    }
    return { ok: true };
  }

  /**
   * End-session orchestration (M-1): dispatch on the resolved termination
   * mode. `immediate` skips cancel and the idle wait entirely — an idle or
   * shell-phase session has nothing to cancel, so waiting would only time
   * out — and goes straight to stop → createNewSession. `turn` and
   * `compaction` keep the original sequencing: the idle listener is armed
   * before the cancel call — a turn.ended racing the cancel's own resolution
   * must not be lost to a late subscription — and the bounded wait gives up
   * on timeout, staying unpublished.
   */
  async runEndSession(): Promise<void> {
    const session = this.currentSession;
    if (session === undefined) return;
    const mode = resolveEndSessionMode(this.deps.getAppState?.());
    if (mode === 'immediate') {
      await this.stop();
      await this.deps.createNewSession?.();
      return;
    }
    const idle = this.waitForIdle(session);
    if (mode === 'compaction') await session.cancelCompaction();
    else await session.cancel();
    await this.stop();
    if (await idle) await this.deps.createNewSession?.();
    else this.deps.onStatus?.(END_SESSION_TIMEOUT_NOTICE);
  }

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

  /** Idempotent teardown: close the link, detach the projector, drop open cards. */
  async stop(): Promise<void> {
    this.link?.close();
    this.projector.detach();
    this.openCardsList.length = 0;
    this.setLinkState('detached');
  }

  /**
   * Internal projector emit routing: observers (deps.onProjectorFrame) see
   * every derived frame regardless of state; the link only receives frames
   * while published — pre-publish output is dropped, never backfilled (D-I).
   */
  private handleProjectorFrame(frame: UplinkFrame): void {
    this.deps.onProjectorFrame?.(frame);
    if (this.linkState === 'published') this.link?.send(frame);
  }
}

/**
 * Wrap the reverse-rpc UI hooks so the forum-link controller observes card
 * open/close without replacing the original panel behavior. `controller` may
 * be a direct reference or a resolver returning the current controller (or
 * undefined before the first `/forum` publish) — resolved on every hook call
 * so a lazily created controller is picked up immediately. The original hook
 * always runs first; the notification is skipped when it throws or when no
 * controller is wired at call time. `hidePanel` carries no payload, so the
 * wrapper tracks the id of the last shown panel per kind and settles that
 * card on hide — a hide without a preceding show notifies nothing. A
 * replacement show of the same kind settles the tracked card first: the
 * reverse-rpc queue advances from a locally answered request straight to
 * `showPanel(next)` with no intervening `hidePanel`, so without this the
 * superseded card would linger open and a late remote action for it would
 * settle the card that replaced it. Always returns a wrapped copy; the
 * per-call resolution makes the wrapper a no-op pass-through until the
 * first `/forum` publish creates the controller.
 */
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
