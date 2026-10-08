import type { Session, PermissionMode, ThinkingEffort } from '@moonshot-ai/kimi-code-sdk';
import type { OpIntent, ReceiptReason } from '@moonshot-ai/forum-link';

import { effectiveModelForHost, applyPermissionChoice, performModelSwitch } from '#/tui/commands/config';
import { handleGoalCommand, startGoalWithPermission } from '#/tui/commands/goal';
import { slashCommandBusyReason } from '#/tui/commands/resolve';
import { findBuiltInSlashCommand, resolveSlashCommandAvailability } from '#/tui/commands/registry';
import { defaultThinkingEffortFor, segmentsFor } from '#/tui/components/dialogs/model-selector';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import type { SteerInputItem } from '#/tui/types';

export type SessionControlOutcome =
  | { readonly state: 'applied' }
  | { readonly state: 'rejected'; readonly reason: ReceiptReason };

export interface GuardedPlan {
  run(): Promise<void>;
  verify(): Promise<SessionControlOutcome>;
}

export type SessionControlDecision =
  | { readonly kind: 'guarded'; readonly plan: GuardedPlan }
  | { readonly kind: 'rejected'; readonly reason: ReceiptReason };

export interface SessionControlHostView {
  readonly slashHost: SlashCommandHost;
  sendNormalUserInput(text: string): Promise<void> | void;
  steerMessage(session: Session, input: readonly SteerInputItem[]): void;
  cancelForeground(): void;
  createNewSession(): Promise<void>;
  runEndSession(opts?: { beforeEnd?: () => void }): Promise<void>;
  session(): Session | undefined;
}

const MAX_GOAL_OBJECTIVE_LENGTH = 4000;

const SESSION_CONTROL_OP_TYPES: ReadonlySet<string> = new Set([
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
]);

export function isSessionControlOpType(type: string): boolean {
  return SESSION_CONTROL_OP_TYPES.has(type);
}

interface HostGuards {
  readonly appState: SlashCommandHost['state']['appState'];
  readonly busyReason: ReturnType<typeof slashCommandBusyReason>;
}

function hostGuards(host: SessionControlHostView): HostGuards {
  const appState = host.slashHost.state.appState;
  return {
    appState,
    busyReason: slashCommandBusyReason({
      isStreaming: appState.streamingPhase !== 'idle',
      isCompacting: appState.isCompacting,
    }),
  };
}

type AvailabilityVerdict = 'always' | 'idle-only' | 'busy';

function slashAvailability(commandName: string, args: string, guards: HostGuards): AvailabilityVerdict {
  const command = findBuiltInSlashCommand(commandName);
  if (command === undefined) return 'idle-only';
  const availability = resolveSlashCommandAvailability(command, args);
  if (availability === 'always') return 'always';
  return guards.busyReason === undefined ? 'idle-only' : 'busy';
}

function requireIdle(availability: AvailabilityVerdict): ReceiptReason | undefined {
  return availability === 'busy' ? 'session-busy' : undefined;
}

function plan(
  run: () => Promise<void> | void,
  verify: () => Promise<SessionControlOutcome>,
): SessionControlDecision {
  return {
    kind: 'guarded',
    plan: {
      run: async () => {
        await run();
      },
      verify,
    },
  };
}

const APPLIED: SessionControlOutcome = { state: 'applied' };

function rejected(reason: ReceiptReason): SessionControlDecision {
  return { kind: 'rejected', reason };
}

function rejectedOutcome(reason: ReceiptReason): SessionControlOutcome {
  return { state: 'rejected', reason };
}

function goalOutcome(
  host: SessionControlHostView,
  match: (goal: Awaited<ReturnType<Session['getGoal']>>['goal']) => boolean,
): Promise<SessionControlOutcome> {
  const session = host.session();
  if (session === undefined) return Promise.resolve(rejectedOutcome('postcondition-failed'));
  return session
    .getGoal()
    .then(({ goal }) => (match(goal) ? APPLIED : rejectedOutcome('postcondition-failed')))
    .catch(() => rejectedOutcome('postcondition-failed'));
}

function permissionModeOf(mode: string): PermissionMode | undefined {
  return mode === 'manual' || mode === 'auto' || mode === 'yolo' ? mode : undefined;
}

function goalArgs(objective: string, replace: boolean): string {
  return replace ? `replace ${objective}` : objective;
}

export function resolveSessionControl(
  intent: OpIntent,
  host: SessionControlHostView,
): SessionControlDecision {
  if (!isSessionControlOpType(intent.type)) return rejected('invalid-params');
  const guards = hostGuards(host);
  // oxlint-disable-next-line typescript-eslint/switch-exhaustiveness-check -- Card-type intents are rejected above; only session types reach this switch.
  switch (intent.type) {
    case 'send': {
      if (intent.text.trim().length === 0) return rejected('invalid-params');
      if (guards.appState.model.trim().length === 0) return rejected('invalid-params');
      return plan(() => host.sendNormalUserInput(intent.text), () => Promise.resolve(APPLIED));
    }
    case 'steer': {
      const phase = guards.appState.streamingPhase;
      if (guards.appState.isCompacting) return rejected('not-running');
      if (phase === 'idle' || phase === 'shell') return rejected('not-running');
      const session = host.session();
      if (session === undefined) return rejected('not-running');
      return plan(
        () => {
          host.steerMessage(session, [{ text: intent.text }]);
        },
        () => Promise.resolve(APPLIED),
      );
    }
    case 'pause':
      return plan(
        () => {
          host.cancelForeground();
        },
        () => Promise.resolve(APPLIED),
      );
    case 'end-session':
      return plan(() => host.runEndSession(), () => Promise.resolve(APPLIED));
    case 'set-permission-mode': {
      const mode = permissionModeOf(intent.mode);
      if (mode === undefined) return rejected('invalid-params');
      return plan(
        () => applyPermissionChoice(host.slashHost, mode),
        () =>
          Promise.resolve(
            host.slashHost.state.appState.permissionMode === mode
              ? APPLIED
              : rejectedOutcome('postcondition-failed'),
          ),
      );
    }
    case 'switch-model': {
      const model = guards.appState.availableModels[intent.alias];
      if (model === undefined) return rejected('invalid-params');
      const effective = effectiveModelForHost(host.slashHost, model);
      const effort: ThinkingEffort = intent.effort ?? defaultThinkingEffortFor(effective);
      if (!segmentsFor(effective).includes(effort)) return rejected('invalid-params');
      if (guards.busyReason !== undefined) return rejected('session-busy');
      const persist = intent.scope !== 'session';
      return plan(
        () => performModelSwitch(host.slashHost, intent.alias, effort, persist),
        () =>
          Promise.resolve(
            host.slashHost.state.appState.model === intent.alias &&
              host.slashHost.state.appState.thinkingEffort === effort
              ? APPLIED
              : rejectedOutcome('postcondition-failed'),
          ),
      );
    }
    case 'new-session': {
      const busy = requireIdle(slashAvailability('new', '', guards));
      if (busy !== undefined) return rejected(busy);
      if (guards.appState.isReplaying) return rejected('invalid-params');
      const before = host.session()?.id;
      return plan(
        () => host.createNewSession(),
        () =>
          Promise.resolve(
            host.session()?.id !== undefined && host.session()?.id !== before
              ? APPLIED
              : rejectedOutcome('postcondition-failed'),
          ),
      );
    }
    case 'goal-set': {
      const objective = intent.objective.trim();
      if (objective.length === 0 || objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
        return rejected('invalid-params');
      }
      const busy = requireIdle(slashAvailability('goal', goalArgs(objective, intent.replace), guards));
      if (busy !== undefined) return rejected(busy);
      if (guards.appState.model.trim().length === 0) return rejected('invalid-params');
      const permissionMode = guards.appState.permissionMode;
      const startMode = intent.startMode;
      if (startMode === undefined && permissionMode !== 'auto') return rejected('invalid-params');
      const choice = startMode ?? 'auto';
      const parsed = { kind: 'create' as const, objective, replace: intent.replace };
      const run =
        choice === 'auto' && permissionMode === 'auto'
          ? () => handleGoalCommand(host.slashHost, goalArgs(objective, intent.replace))
          : () => startGoalWithPermission(host.slashHost, parsed, choice, {});
      return plan(run, () =>
        goalOutcome(host, (goal) => goal !== null && goal.status === 'active' && goal.objective === objective),
      );
    }
    case 'goal-pause':
    case 'goal-resume':
    case 'goal-cancel': {
      const subcommand =
        intent.type === 'goal-pause' ? 'pause' : intent.type === 'goal-resume' ? 'resume' : 'cancel';
      const busy = requireIdle(slashAvailability('goal', subcommand, guards));
      if (busy !== undefined) return rejected(busy);
      const expected = subcommand === 'pause' ? 'paused' : subcommand === 'resume' ? 'active' : null;
      return plan(
        () => handleGoalCommand(host.slashHost, subcommand),
        () => goalOutcome(host, (goal) => (expected === null ? goal === null : goal?.status === expected)),
      );
    }
    default:
      return rejected('invalid-params');
  }
}

export async function executeSessionControl(
  intent: OpIntent,
  host: SessionControlHostView,
): Promise<SessionControlOutcome> {
  const decision = resolveSessionControl(intent, host);
  if (decision.kind === 'rejected') return rejectedOutcome(decision.reason);
  try {
    await decision.plan.run();
  } catch {
    return rejectedOutcome('postcondition-failed');
  }
  return decision.plan.verify();
}
