import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type { ModelAlias, PermissionMode, Session } from '@moonshot-ai/kimi-code-sdk';
import { BROWSER_COOKIE_NAME, type OpIntent, type ReceiptReport } from '@moonshot-ai/forum-link';

import type { AppState } from '#/tui/types';
import { DEFAULT_NOTIFICATIONS_CONFIG, DEFAULT_UPGRADE_PREFERENCES } from '#/tui/config';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import {
  executeSessionControl,
  isSessionControlOpType,
  resolveSessionControl,
  type SessionControlHostView,
} from '#/tui/controllers/forum-link/session-control';
import { Injector, type InjectorHost, type OpenCardView } from '#/tui/controllers/forum-link/injector';
import { Link, type DownlinkOp, type LinkOptions } from '#/tui/controllers/forum-link/link';
import { ApprovalController } from '#/tui/reverse-rpc/approval/controller';
import { QuestionController } from '#/tui/reverse-rpc/question/controller';
import type { ApprovalPanelData, QuestionPanelData } from '#/tui/reverse-rpc/types';
import { showPermissionPicker } from '#/tui/commands/config';
import { PermissionSelectorComponent } from '#/tui/components/dialogs/permission-selector';

const ENTER = '\r';
const DOWN = '\u001B[B';

interface GoalFixture {
  goalId: string;
  objective: string;
  status: 'active' | 'paused' | 'blocked' | 'complete';
}

function goalSnapshot(overrides: Partial<GoalFixture> = {}): GoalFixture {
  return { goalId: 'g1', objective: 'obj', status: 'active', ...overrides };
}

function model(name: string, overrides: Partial<ModelAlias> = {}): ModelAlias {
  return {
    provider: 'test',
    model: name,
    maxContextSize: 200_000,
    displayName: name,
    ...overrides,
  } as unknown as ModelAlias;
}

interface HostOverrides {
  streaming?: boolean;
  compacting?: boolean;
  replaying?: boolean;
  permissionMode?: PermissionMode;
  model?: string;
  effort?: string;
  goal?: GoalFixture | null;
  availableModels?: Record<string, ModelAlias>;
}

function makeHostView(overrides: HostOverrides = {}) {
  const session = {
    id: 'session-1',
    setPermission: vi.fn(async () => {}),
    setModel: vi.fn(async (alias: string) => {
      liveStatus.model = alias;
    }),
    setThinking: vi.fn(async (effort: string) => {
      liveStatus.thinkingEffort = effort;
    }),
    getStatus: vi.fn(async () => ({ ...liveStatus })),
    getGoal: vi.fn(async () => ({ goal: overrides.goal ?? null })),
    createGoal: vi.fn(async () => ({})),
    pauseGoal: vi.fn(async () => ({})),
    resumeGoal: vi.fn(async () => ({})),
    cancelGoal: vi.fn(async () => ({})),
    cancel: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
  } as unknown as Record<string, unknown> & Session;
  const mockSession = session as unknown as {
    id: string;
    getGoal: ReturnType<typeof vi.fn>;
    createGoal: ReturnType<typeof vi.fn>;
    setPermission: ReturnType<typeof vi.fn>;
    setThinking: ReturnType<typeof vi.fn>;
    setModel: ReturnType<typeof vi.fn>;
    pauseGoal: ReturnType<typeof vi.fn>;
    resumeGoal: ReturnType<typeof vi.fn>;
    cancelGoal: ReturnType<typeof vi.fn>;
  };
  const liveStatus = { model: overrides.model ?? 'k2', thinkingEffort: overrides.effort ?? 'high' };
  const appState: AppState = {
    model: overrides.model ?? 'k2',
    workDir: '/workspace',
    additionalDirs: [],
    thinkingEffort: overrides.effort ?? 'high',
    permissionMode: overrides.permissionMode ?? 'auto',
    planMode: false,
    inputMode: 'prompt',
    swarmMode: false,
    towerMode: false,
    streamingPhase: overrides.streaming ? 'thinking' : 'idle',
    isCompacting: overrides.compacting ?? false,
    isReplaying: overrides.replaying ?? false,
    sessionId: 'session-1',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    cumulativeTokens: 0,
    streamingStartTime: 0,
    stepRetry: null,
    theme: 'dark',
    version: 'test',
    editorCommand: null,
    notifications: DEFAULT_NOTIFICATIONS_CONFIG,
    upgrade: DEFAULT_UPGRADE_PREFERENCES,
    sessionTitle: null,
    goal: (overrides.goal ?? null) as AppState['goal'],
    mcpServersSummary: null,
    availableModels: overrides.availableModels ?? {
      k2: model('k2', {
        supportEfforts: ['low', 'high'],
        defaultEffort: 'high',
        capabilities: ['thinking'],
      }),
      cheap: model('cheap', {
        supportEfforts: ['low', 'high'],
        defaultEffort: 'high',
        capabilities: ['thinking'],
      }),
    },
    availableProviders: {},
  };
  const slashHost = {
    state: {
      appState,
      editor: { getText: vi.fn(() => '') },
      transcriptContainer: { addChild: vi.fn() },
      transcriptEntries: [],
      ui: { requestRender: vi.fn() },
    },
    session,
    skillCommandMap: new Map<string, string>(),
    requireSession: () => session,
    setAppState: vi.fn((patch: Record<string, unknown>) => Object.assign(appState, patch)),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    sendNormalUserInput: vi.fn(),
    waitForLazyCreation: vi.fn(async () => {}),
    track: vi.fn(),
    harness: {
      getConfig: vi.fn(async () => ({})),
      setConfig: vi.fn(async () => ({})),
    },
    authFlow: {
      activateModelAfterLogin: vi.fn(async () => {}),
      refreshOAuthProviderModels: vi.fn(async () => undefined),
    },
  } as unknown as SlashCommandHost;
  const mockHost = slashHost as unknown as {
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    sendNormalUserInput: ReturnType<typeof vi.fn>;
    session: Session;
  };
  const calls = {
    sent: [] as string[],
    steered: [] as { text: string }[],
    cancelledForeground: 0,
    createdSessions: 0,
    endSession: 0,
    beforeEnd: 0,
  };
  const hostView: SessionControlHostView = {
    slashHost,
    sendNormalUserInput: (text: string) => {
      calls.sent.push(text);
    },
    steerMessage: (_session: Session, input: readonly { text: string }[]) => {
      for (const item of input) calls.steered.push(item);
    },
    cancelForeground: () => {
      calls.cancelledForeground += 1;
    },
    createNewSession: async () => {
      calls.createdSessions += 1;
      mockSession.id = 'session-2';
    },
    runEndSession: async (opts?: { beforeEnd?: () => void }) => {
      calls.endSession += 1;
      opts?.beforeEnd?.();
    },
    session: () => session,
  };
  return { hostView, session, mockSession, slashHost, mockHost, calls, appState };
}

function intentOf(partial: { type: string } & Record<string, unknown>): OpIntent {
  return { sessionId: 'session-1', ...partial } as OpIntent;
}

async function apply(intent: OpIntent, hostView: SessionControlHostView) {
  return executeSessionControl(intent, hostView);
}

describe('O8-A1 new-session guard', () => {
  it('rejects with session-busy while streaming and creates no local session', async () => {
    const { hostView, calls } = makeHostView({ streaming: true });
    const outcome = await apply(intentOf({ type: 'new-session' }), hostView);
    expect(outcome).toEqual({ state: 'rejected', reason: 'session-busy' });
    expect(calls.createdSessions).toBe(0);
  });

  it('rejects with session-busy while compacting', async () => {
    const { hostView, calls } = makeHostView({ compacting: true });
    const outcome = await apply(intentOf({ type: 'new-session' }), hostView);
    expect(outcome).toEqual({ state: 'rejected', reason: 'session-busy' });
    expect(calls.createdSessions).toBe(0);
  });

  it('applies when idle and the carried sessionId changed', async () => {
    const { hostView, mockSession } = makeHostView();
    const outcome = await apply(intentOf({ type: 'new-session' }), hostView);
    expect(outcome).toEqual({ state: 'applied' });
    expect(mockSession.id).toBe('session-2');
  });

  it('rejects with invalid-params during replay', async () => {
    const { hostView } = makeHostView({ replaying: true });
    const outcome = await apply(intentOf({ type: 'new-session' }), hostView);
    expect(outcome).toEqual({ state: 'rejected', reason: 'invalid-params' });
  });

  it('reports postcondition-failed when the sessionId did not change', async () => {
    const { hostView } = makeHostView();
    const made = hostView as unknown as { createNewSession: () => Promise<void> };
    made.createNewSession = async () => {};
    const outcome = await apply(intentOf({ type: 'new-session' }), hostView);
    expect(outcome).toEqual({ state: 'rejected', reason: 'postcondition-failed' });
  });
});

describe('O8-A2 steer guard', () => {
  it('rejects with not-running when idle and does not fall back to send', async () => {
    const { hostView, calls } = makeHostView();
    const outcome = await apply(intentOf({ type: 'steer', text: 'redirect' }), hostView);
    expect(outcome).toEqual({ state: 'rejected', reason: 'not-running' });
    expect(calls.sent).toEqual([]);
    expect(calls.steered).toEqual([]);
  });

  it('applies while a turn is running', async () => {
    const { hostView, calls } = makeHostView({ streaming: true });
    const outcome = await apply(intentOf({ type: 'steer', text: 'redirect' }), hostView);
    expect(outcome).toEqual({ state: 'applied' });
    expect(calls.steered).toEqual([{ text: 'redirect' }]);
    expect(calls.sent).toEqual([]);
  });

  it('rejects with not-running during a live shell phase', async () => {
    const made = makeHostView();
    made.appState.streamingPhase = 'shell';
    const outcome = await apply(intentOf({ type: 'steer', text: 'x' }), made.hostView);
    expect(outcome).toEqual({ state: 'rejected', reason: 'not-running' });
  });

  it('rejects with not-running while compacting', async () => {
    const { hostView } = makeHostView({ compacting: true });
    const outcome = await apply(intentOf({ type: 'steer', text: 'x' }), hostView);
    expect(outcome).toEqual({ state: 'rejected', reason: 'not-running' });
  });
});

describe('O8-A3 set-permission-mode equivalence', () => {
  it('applies through the real applyPermissionChoice and matches the local picker path', async () => {
    const { hostView, mockHost, appState } = makeHostView({ permissionMode: 'manual' });

    const remote = await apply(intentOf({ type: 'set-permission-mode', mode: 'yolo' }), hostView);
    expect(remote).toEqual({ state: 'applied' });
    expect(appState.permissionMode).toBe('yolo');
    expect(mockHost.session.setPermission).toHaveBeenCalledWith('yolo');

    const localRig = makeHostView({ permissionMode: 'manual' });
    showPermissionPicker(localRig.slashHost, 'yolo');
    const picker = localRig.mockHost.mountEditorReplacement.mock.calls[0]![0] as InstanceType<
      typeof PermissionSelectorComponent
    >;
    picker.handleInput(ENTER);
    await vi.waitFor(() => {
      expect(localRig.appState.permissionMode).toBe('yolo');
    });
    expect(appState.permissionMode).toEqual(localRig.appState.permissionMode);
  });

  it('rejects an unknown mode as invalid-params', async () => {
    const { hostView } = makeHostView();
    const outcome = await apply(intentOf({ type: 'set-permission-mode', mode: 'nonsense' }), hostView);
    expect(outcome).toEqual({ state: 'rejected', reason: 'invalid-params' });
  });

  it('reports postcondition-failed when the session rejects the switch', async () => {
    const { hostView, mockSession } = makeHostView({ permissionMode: 'manual' });
    mockSession.setPermission = vi.fn(async () => {
      throw new Error('boom');
    });
    const outcome = await apply(intentOf({ type: 'set-permission-mode', mode: 'auto' }), hostView);
    expect(outcome).toEqual({ state: 'rejected', reason: 'postcondition-failed' });
  });
});

describe('O8-A4 closed mapping table', () => {
  it('is type-closed: every session OpType is covered and card types are excluded', () => {
    for (const type of [
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
    ]) {
      expect(isSessionControlOpType(type)).toBe(true);
    }
    for (const type of ['approve', 'approve-cancel', 'answer', 'answer-cancel', 'made-up-op']) {
      expect(isSessionControlOpType(type)).toBe(false);
    }
  });

  it('rejects card-type intents at runtime', async () => {
    const { hostView } = makeHostView();
    const outcome = await apply(intentOf({ type: 'approve', cardId: 'c1', optionIndex: 0 }), hostView);
    expect(outcome).toEqual({ state: 'rejected', reason: 'invalid-params' });
  });
});

describe('O8-Contract run() failure semantics', () => {
  it('reports postcondition-failed without calling verify when run() throws', async () => {
    const { hostView } = makeHostView({ streaming: true });
    const made = hostView as unknown as { steerMessage: (s: Session, i: readonly { text: string }[]) => void };
    made.steerMessage = () => {
      throw new Error('steer blew up');
    };
    const outcome = await apply(intentOf({ type: 'steer', text: 'x' }), hostView);
    expect(outcome).toEqual({ state: 'rejected', reason: 'postcondition-failed' });
  });

  it('reports postcondition-failed when run() rejects', async () => {
    const { hostView } = makeHostView();
    const made = hostView as unknown as { createNewSession: () => Promise<void> };
    made.createNewSession = async () => {
      throw new Error('create failed');
    };
    const outcome = await apply(intentOf({ type: 'new-session' }), hostView);
    expect(outcome).toEqual({ state: 'rejected', reason: 'postcondition-failed' });
  });
});

describe('send', () => {
  it('applies through the local send path', async () => {
    const { hostView, calls } = makeHostView();
    const outcome = await apply(intentOf({ type: 'send', text: 'hello' }), hostView);
    expect(outcome).toEqual({ state: 'applied' });
    expect(calls.sent).toEqual(['hello']);
  });

  it('rejects empty text', async () => {
    const { hostView, calls } = makeHostView();
    const outcome = await apply(intentOf({ type: 'send', text: '   ' }), hostView);
    expect(outcome).toEqual({ state: 'rejected', reason: 'invalid-params' });
    expect(calls.sent).toEqual([]);
  });

  it('rejects when no model is configured', async () => {
    const { hostView, calls } = makeHostView({ model: '' });
    const outcome = await apply(intentOf({ type: 'send', text: 'hello' }), hostView);
    expect(outcome).toEqual({ state: 'rejected', reason: 'invalid-params' });
    expect(calls.sent).toEqual([]);
  });
});

describe('pause', () => {
  it('applies and reaches the local cancelForeground seam (= Esc)', async () => {
    const { hostView, calls } = makeHostView();
    const outcome = await apply(intentOf({ type: 'pause' }), hostView);
    expect(outcome).toEqual({ state: 'applied' });
    expect(calls.cancelledForeground).toBe(1);
  });

  it('applies while idle (nothing to cancel is still applied)', async () => {
    const { hostView } = makeHostView();
    const outcome = await apply(intentOf({ type: 'pause' }), hostView);
    expect(outcome).toEqual({ state: 'applied' });
  });
});

describe('end-session', () => {
  it('applies and enters the unpublish path with the beforeEnd callback', async () => {
    const { hostView, calls } = makeHostView();
    const outcome = await apply(intentOf({ type: 'end-session' }), hostView);
    expect(outcome).toEqual({ state: 'applied' });
    expect(calls.endSession).toBe(1);
  });

  it('reports postcondition-failed when runEndSession throws', async () => {
    const { hostView } = makeHostView();
    const made = hostView as unknown as { runEndSession: (opts?: { beforeEnd?: () => void }) => Promise<void> };
    made.runEndSession = async () => {
      throw new Error('unpublish failed');
    };
    const outcome = await apply(intentOf({ type: 'end-session' }), hostView);
    expect(outcome).toEqual({ state: 'rejected', reason: 'postcondition-failed' });
  });
});

describe('switch-model', () => {
  it('applies through the real performModelSwitch with model and effort matching the target', async () => {
    const { hostView, appState, mockSession } = makeHostView({ model: 'k2', effort: 'low' });
    const outcome = await apply(intentOf({ type: 'switch-model', alias: 'k2', effort: 'high' }), hostView);
    expect(outcome).toEqual({ state: 'applied' });
    expect(appState.model).toBe('k2');
    expect(appState.thinkingEffort).toBe('high');
    expect(mockSession.setThinking).toHaveBeenCalledWith('high');
  });

  it('rejects an unknown alias', async () => {
    const { hostView } = makeHostView();
    const outcome = await apply(intentOf({ type: 'switch-model', alias: 'ghost' }), hostView);
    expect(outcome).toEqual({ state: 'rejected', reason: 'invalid-params' });
  });

  it('rejects an effort outside the model segments', async () => {
    const { hostView } = makeHostView();
    const outcome = await apply(intentOf({ type: 'switch-model', alias: 'k2', effort: 'ultra' }), hostView);
    expect(outcome).toEqual({ state: 'rejected', reason: 'invalid-params' });
  });

  it('rejects with session-busy while streaming', async () => {
    const { hostView, mockSession } = makeHostView({ streaming: true });
    const outcome = await apply(intentOf({ type: 'switch-model', alias: 'k2', effort: 'high' }), hostView);
    expect(outcome).toEqual({ state: 'rejected', reason: 'session-busy' });
    expect(mockSession.setModel).not.toHaveBeenCalled();
  });

  it('defaults the effort to the model default when omitted', async () => {
    const { hostView, appState } = makeHostView({ effort: 'low' });
    const outcome = await apply(intentOf({ type: 'switch-model', alias: 'k2' }), hostView);
    expect(outcome).toEqual({ state: 'applied' });
    expect(appState.thinkingEffort).toBe('high');
  });
});

describe('goal-set', () => {
  it('applies in auto mode through the real handleGoalCommand', async () => {
    const { hostView, mockSession, mockHost } = makeHostView();
    mockSession.getGoal.mockResolvedValue({ goal: goalSnapshot({ objective: 'Ship feature X', status: 'active' }) });
    const outcome = await apply(
      intentOf({ type: 'goal-set', objective: 'Ship feature X', replace: false }),
      hostView,
    );
    expect(outcome).toEqual({ state: 'applied' });
    expect(mockSession.createGoal).toHaveBeenCalledWith({ objective: 'Ship feature X', replace: false });
    expect(mockHost.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('applies in manual mode through the real startGoalWithPermission with a startMode', async () => {
    const { hostView, mockSession, mockHost } = makeHostView({ permissionMode: 'manual' });
    mockSession.getGoal.mockResolvedValue({ goal: goalSnapshot({ objective: 'Ship Y', status: 'active' }) });
    const outcome = await apply(
      intentOf({ type: 'goal-set', objective: 'Ship Y', replace: false, startMode: 'auto' }),
      hostView,
    );
    expect(outcome).toEqual({ state: 'applied' });
    expect(mockSession.createGoal).toHaveBeenCalledWith({ objective: 'Ship Y', replace: false });
    expect(mockHost.sendNormalUserInput).toHaveBeenCalledWith('Ship Y');
  });

  it('applies in yolo startMode', async () => {
    const { hostView, mockSession } = makeHostView({ permissionMode: 'manual' });
    mockSession.getGoal.mockResolvedValue({ goal: goalSnapshot({ objective: 'Z', status: 'active' }) });
    const outcome = await apply(
      intentOf({ type: 'goal-set', objective: 'Z', replace: false, startMode: 'yolo' }),
      hostView,
    );
    expect(outcome).toEqual({ state: 'applied' });
    expect(mockSession.createGoal).toHaveBeenCalled();
  });

  it('passes replace through to createGoal', async () => {
    const { hostView, mockSession } = makeHostView({ goal: goalSnapshot({ objective: 'old' }) });
    mockSession.getGoal.mockResolvedValue({ goal: goalSnapshot({ objective: 'new', status: 'active' }) });
    const outcome = await apply(
      intentOf({ type: 'goal-set', objective: 'new', replace: true }),
      hostView,
    );
    expect(outcome).toEqual({ state: 'applied' });
    expect(mockSession.createGoal).toHaveBeenCalledWith({ objective: 'new', replace: true });
  });

  it('rejects with session-busy while streaming', async () => {
    const { hostView, mockSession } = makeHostView({ streaming: true });
    const outcome = await apply(
      intentOf({ type: 'goal-set', objective: 'Ship X', replace: false }),
      hostView,
    );
    expect(outcome).toEqual({ state: 'rejected', reason: 'session-busy' });
    expect(mockSession.createGoal).not.toHaveBeenCalled();
  });

  it('rejects an over-limit objective', async () => {
    const { hostView } = makeHostView();
    const outcome = await apply(
      intentOf({ type: 'goal-set', objective: 'x'.repeat(4001), replace: false }),
      hostView,
    );
    expect(outcome).toEqual({ state: 'rejected', reason: 'invalid-params' });
  });

  it('rejects an empty objective', async () => {
    const { hostView } = makeHostView();
    const outcome = await apply(intentOf({ type: 'goal-set', objective: '  ', replace: false }), hostView);
    expect(outcome).toEqual({ state: 'rejected', reason: 'invalid-params' });
  });

  it('reports postcondition-failed when the goal snapshot does not match the objective', async () => {
    const { hostView, mockSession } = makeHostView();
    mockSession.getGoal.mockResolvedValue({ goal: goalSnapshot({ objective: 'a different goal' }) });
    const outcome = await apply(
      intentOf({ type: 'goal-set', objective: 'Ship X', replace: false }),
      hostView,
    );
    expect(outcome).toEqual({ state: 'rejected', reason: 'postcondition-failed' });
  });

  it('reports postcondition-failed when createGoal fails and rolls back the permission switch', async () => {
    const { hostView, mockSession, mockHost } = makeHostView({ permissionMode: 'manual' });
    mockSession.createGoal = vi.fn(async () => {
      throw new Error('goal exists');
    });
    const outcome = await apply(
      intentOf({ type: 'goal-set', objective: 'Ship X', replace: false, startMode: 'auto' }),
      hostView,
    );
    expect(outcome).toEqual({ state: 'rejected', reason: 'postcondition-failed' });
    expect(mockHost.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('reads the terminal state from session.getGoal(), not the async appState mirror', async () => {
    const { hostView, mockSession, mockHost, appState } = makeHostView();
    appState.goal = null;
    mockSession.getGoal.mockResolvedValue({ goal: goalSnapshot({ objective: 'Ship X', status: 'active' }) });
    const outcome = await apply(
      intentOf({ type: 'goal-set', objective: 'Ship X', replace: false }),
      hostView,
    );
    expect(outcome).toEqual({ state: 'applied' });
    expect(appState.goal).toBeNull();
  });
});

describe('goal-pause / goal-resume / goal-cancel', () => {
  it('goal-pause applies through the real handleGoalCommand', async () => {
    const { hostView, mockSession } = makeHostView({ goal: goalSnapshot({ status: 'active' }) });
    mockSession.getGoal.mockResolvedValue({ goal: goalSnapshot({ status: 'paused' }) });
    const outcome = await apply(intentOf({ type: 'goal-pause' }), hostView);
    expect(outcome).toEqual({ state: 'applied' });
    expect(mockSession.pauseGoal).toHaveBeenCalledOnce();
  });

  it('goal-resume applies and sends the resume input', async () => {
    const { hostView, mockSession, mockHost } = makeHostView({ goal: goalSnapshot({ status: 'paused' }) });
    mockSession.getGoal.mockResolvedValue({ goal: goalSnapshot({ status: 'active' }) });
    const outcome = await apply(intentOf({ type: 'goal-resume' }), hostView);
    expect(outcome).toEqual({ state: 'applied' });
    expect(mockSession.resumeGoal).toHaveBeenCalledOnce();
    expect(mockHost.sendNormalUserInput).toHaveBeenCalledWith('Resume the active goal.');
  });

  it('goal-cancel applies when the goal is gone', async () => {
    const { hostView, mockSession } = makeHostView({ goal: goalSnapshot() });
    mockSession.getGoal.mockResolvedValue({ goal: null });
    const outcome = await apply(intentOf({ type: 'goal-cancel' }), hostView);
    expect(outcome).toEqual({ state: 'applied' });
    expect(mockSession.cancelGoal).toHaveBeenCalledOnce();
  });

  it('reports postcondition-failed when the pause does not take effect', async () => {
    const { hostView, mockSession } = makeHostView({ goal: goalSnapshot({ status: 'active' }) });
    mockSession.getGoal.mockResolvedValue({ goal: goalSnapshot({ status: 'active' }) });
    const outcome = await apply(intentOf({ type: 'goal-pause' }), hostView);
    expect(outcome).toEqual({ state: 'rejected', reason: 'postcondition-failed' });
  });

  it('rejects with session-busy for goal-resume while streaming', async () => {
    const { hostView, mockSession } = makeHostView({ streaming: true, goal: goalSnapshot() });
    const outcome = await apply(intentOf({ type: 'goal-resume' }), hostView);
    expect(outcome).toEqual({ state: 'rejected', reason: 'session-busy' });
    expect(mockSession.resumeGoal).not.toHaveBeenCalled();
  });
});

describe('resolveSessionControl decision shape', () => {
  it('returns a rejected decision without running anything for a busy new-session', () => {
    const { hostView, calls } = makeHostView({ streaming: true });
    const decision = resolveSessionControl(intentOf({ type: 'new-session' }), hostView);
    expect(decision).toEqual({ kind: 'rejected', reason: 'session-busy' });
    expect(calls.createdSessions).toBe(0);
  });

  it('exposes run/verify separately for the injector pipeline', async () => {
    const { hostView, calls } = makeHostView();
    const decision = resolveSessionControl(intentOf({ type: 'send', text: 'hi' }), hostView);
    expect(decision.kind).toBe('guarded');
    if (decision.kind !== 'guarded') return;
    expect(calls.sent).toEqual([]);
    await decision.plan.run();
    expect(calls.sent).toEqual(['hi']);
    expect(await decision.plan.verify()).toEqual({ state: 'applied' });
  });
});

const APPROVAL_CHOICES: ApprovalPanelData['choices'] = [
  { label: 'Approve once', response: 'approved' },
  { label: 'Approve for this session', response: 'approved_for_session' },
  { label: 'Reject', response: 'rejected' },
];

function injectorApprovalData(id: string, action = 'run a command'): ApprovalPanelData {
  return {
    id,
    tool_call_id: id,
    tool_name: 'Bash',
    action,
    description: '',
    display: [],
    choices: APPROVAL_CHOICES,
  };
}

function injectorQuestionData(id: string): QuestionPanelData {
  return {
    id,
    tool_call_id: id,
    questions: [
      { question: 'Pick one?', multi_select: false, options: [{ label: 'A' }, { label: 'B' }] },
    ],
  };
}

interface InjectorFixture {
  injector: Injector;
  receipts: ReceiptReport[];
  hostView: SessionControlHostView;
  calls: ReturnType<typeof makeHostView>['calls'];
  cards: Map<string, OpenCardView>;
  currentPanel: string | undefined;
  approvalController: ApprovalController;
  questionController: QuestionController;
  setCard(kind: 'approval' | 'question', cardId: string, panelId: string): void;
}

function makeInjectorFixture(overrides: HostOverrides = {}): InjectorFixture {
  const { hostView, calls } = makeHostView(overrides);
  const receipts: ReceiptReport[] = [];
  const cards = new Map<string, OpenCardView>();
  const approvalController = new ApprovalController();
  const questionController = new QuestionController();
  let currentPanel: string | undefined;
  const host: InjectorHost = {
    reportReceipt: (report) => {
      receipts.push(report);
    },
    getOpenCard: (cardId) => cards.get(cardId),
    isCurrentPanel: (cardId) => cardId === currentPanel,
    respondApproval: (cardId, response) => {
      currentPanel = undefined;
      cards.delete(cardId);
      approvalController.respond(response);
    },
    respondQuestion: (cardId, response) => {
      currentPanel = undefined;
      cards.delete(cardId);
      questionController.respond(response);
    },
  };
  const injector = new Injector(host, hostView);
  const fixture: InjectorFixture = {
    injector,
    receipts,
    hostView,
    calls,
    cards,
    approvalController,
    questionController,
    get currentPanel() {
      return currentPanel;
    },
    set currentPanel(value: string | undefined) {
      currentPanel = value;
    },
    setCard: (kind, cardId, panelId) => {
      cards.set(cardId, {
        kind,
        approval: kind === 'approval' ? injectorApprovalData(panelId) : undefined,
        question: kind === 'question' ? injectorQuestionData(panelId) : undefined,
      });
      currentPanel = cardId;
    },
  };
  return fixture;
}

function downlinkOp(opId: string, intent: OpIntent): DownlinkOp {
  return { opId, sessionId: 'session-1', intent };
}

function receiptsFor(receipts: ReceiptReport[], opId: string): ReceiptReport[] {
  return receipts.filter((report) => report.opId === opId);
}

describe('M2-A1 G1 targeted guard', () => {
  it('rejects an op on an old card once a new card is the current panel, leaving the new card untouched', async () => {
    const fixture = makeInjectorFixture();
    const shownOld = fixture.approvalController.show(injectorApprovalData('old-1'));
    fixture.setCard('approval', 'c1', 'old-1');
    const shownNew = fixture.approvalController.show(injectorApprovalData('new-1'));

    fixture.approvalController.respond({ decision: 'rejected' });
    await expect(shownOld).resolves.toEqual({ decision: 'rejected' });
    fixture.cards.delete('c1');
    fixture.setCard('approval', 'c2', 'new-1');
    expect(fixture.cards.has('c1')).toBe(false);

    await fixture.injector.handle(downlinkOp('op1', { type: 'approve', sessionId: 'session-1', cardId: 'c1', optionIndex: 0 }));

    expect(receiptsFor(fixture.receipts, 'op1')).toEqual([
      { opId: 'op1', state: 'delivered' },
      { opId: 'op1', state: 'rejected', reason: 'card-closed' },
    ]);
    let newResolved = false;
    void shownNew.then(() => {
      newResolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(newResolved).toBe(false);
    expect(fixture.cards.has('c2')).toBe(true);

    await fixture.injector.handle(downlinkOp('op2', { type: 'approve', sessionId: 'session-1', cardId: 'c2', optionIndex: 0 }));
    await expect(shownNew).resolves.toEqual({ decision: 'approved' });
    expect(receiptsFor(fixture.receipts, 'op2')).toEqual([
      { opId: 'op2', state: 'delivered' },
      { opId: 'op2', state: 'applied' },
    ]);
  });

  it('rejects an op for an unknown card id', async () => {
    const fixture = makeInjectorFixture();
    await fixture.injector.handle(downlinkOp('op1', { type: 'answer', sessionId: 'session-1', cardId: 'ghost', answers: [{ selected: [0] }] }));
    expect(receiptsFor(fixture.receipts, 'op1')).toEqual([
      { opId: 'op1', state: 'delivered' },
      { opId: 'op1', state: 'rejected', reason: 'card-closed' },
    ]);
  });

  it('rejects a kind-mismatched card op', async () => {
    const fixture = makeInjectorFixture();
    fixture.setCard('question', 'q1', 'q-1');
    await fixture.injector.handle(downlinkOp('op1', { type: 'approve', sessionId: 'session-1', cardId: 'q1', optionIndex: 0 }));
    expect(receiptsFor(fixture.receipts, 'op1')).toEqual([
      { opId: 'op1', state: 'delivered' },
      { opId: 'op1', state: 'rejected', reason: 'card-closed' },
    ]);
  });
});

describe('M2-A2 receipt sequence delivered → terminal', () => {
  it('card approve happy path reports delivered then applied', async () => {
    const fixture = makeInjectorFixture();
    const shown = fixture.approvalController.show(injectorApprovalData('a-1'));
    fixture.setCard('approval', 'c1', 'a-1');
    await fixture.injector.handle(downlinkOp('op1', { type: 'approve', sessionId: 'session-1', cardId: 'c1', optionIndex: 1 }));
    await expect(shown).resolves.toEqual({ decision: 'approved', scope: 'session' });
    expect(receiptsFor(fixture.receipts, 'op1')).toEqual([
      { opId: 'op1', state: 'delivered' },
      { opId: 'op1', state: 'applied' },
    ]);
  });

  it('card approve with an out-of-range option reports rejected: invalid-params', async () => {
    const fixture = makeInjectorFixture();
    fixture.setCard('approval', 'c1', 'a-1');
    await fixture.injector.handle(downlinkOp('op1', { type: 'approve', sessionId: 'session-1', cardId: 'c1', optionIndex: 99 }));
    expect(receiptsFor(fixture.receipts, 'op1')).toEqual([
      { opId: 'op1', state: 'delivered' },
      { opId: 'op1', state: 'rejected', reason: 'invalid-params' },
    ]);
  });

  it('answer reports delivered then applied with the encoded answers', async () => {
    const fixture = makeInjectorFixture();
    const shown = fixture.questionController.show(injectorQuestionData('q-1'));
    fixture.setCard('question', 'q1', 'q-1');
    await fixture.injector.handle(downlinkOp('op1', { type: 'answer', sessionId: 'session-1', cardId: 'q1', answers: [{ selected: [0] }] }));
    await expect(shown).resolves.toEqual({ answers: ['A'], method: 'enter' });
    expect(receiptsFor(fixture.receipts, 'op1')).toEqual([
      { opId: 'op1', state: 'delivered' },
      { opId: 'op1', state: 'applied' },
    ]);
  });

  it('answer-cancel reports delivered then applied', async () => {
    const fixture = makeInjectorFixture();
    const shown = fixture.questionController.show(injectorQuestionData('q-1'));
    fixture.setCard('question', 'q1', 'q-1');
    await fixture.injector.handle(downlinkOp('op1', { type: 'answer-cancel', sessionId: 'session-1', cardId: 'q1' }));
    await expect(shown).resolves.toEqual({ answers: [] });
    expect(receiptsFor(fixture.receipts, 'op1')).toEqual([
      { opId: 'op1', state: 'delivered' },
      { opId: 'op1', state: 'applied' },
    ]);
  });

  it('approve-cancel reports delivered then applied with an Esc-equivalent response', async () => {
    const fixture = makeInjectorFixture();
    const shown = fixture.approvalController.show(injectorApprovalData('a-1'));
    fixture.setCard('approval', 'c1', 'a-1');
    await fixture.injector.handle(downlinkOp('op1', { type: 'approve-cancel', sessionId: 'session-1', cardId: 'c1' }));
    await expect(shown).resolves.toEqual({ decision: 'rejected' });
    expect(receiptsFor(fixture.receipts, 'op1')).toEqual([
      { opId: 'op1', state: 'delivered' },
      { opId: 'op1', state: 'applied' },
    ]);
  });

  it('answer with invalid answers reports rejected: invalid-params', async () => {
    const fixture = makeInjectorFixture();
    fixture.setCard('question', 'q1', 'q-1');
    await fixture.injector.handle(downlinkOp('op1', { type: 'answer', sessionId: 'session-1', cardId: 'q1', answers: [{ selected: [5] }] }));
    expect(receiptsFor(fixture.receipts, 'op1')).toEqual([
      { opId: 'op1', state: 'delivered' },
      { opId: 'op1', state: 'rejected', reason: 'invalid-params' },
    ]);
  });

  it('session op guard rejection reports delivered then rejected with the guard reason', async () => {
    const fixture = makeInjectorFixture({ streaming: true });
    await fixture.injector.handle(downlinkOp('op1', { type: 'new-session', sessionId: 'session-1' }));
    expect(receiptsFor(fixture.receipts, 'op1')).toEqual([
      { opId: 'op1', state: 'delivered' },
      { opId: 'op1', state: 'rejected', reason: 'session-busy' },
    ]);
  });

  it('session op applied reports delivered then applied', async () => {
    const fixture = makeInjectorFixture();
    await fixture.injector.handle(downlinkOp('op1', { type: 'send', sessionId: 'session-1', text: 'hi' }));
    expect(fixture.calls.sent).toEqual(['hi']);
    expect(receiptsFor(fixture.receipts, 'op1')).toEqual([
      { opId: 'op1', state: 'delivered' },
      { opId: 'op1', state: 'applied' },
    ]);
  });

  it('run() throwing reports delivered then rejected: postcondition-failed', async () => {
    const fixture = makeInjectorFixture();
    const made = fixture.hostView as unknown as { createNewSession: () => Promise<void> };
    made.createNewSession = async () => {
      throw new Error('boom');
    };
    await fixture.injector.handle(downlinkOp('op1', { type: 'new-session', sessionId: 'session-1' }));
    expect(receiptsFor(fixture.receipts, 'op1')).toEqual([
      { opId: 'op1', state: 'delivered' },
      { opId: 'op1', state: 'rejected', reason: 'postcondition-failed' },
    ]);
  });

  it('verify mismatch reports delivered then rejected: postcondition-failed', async () => {
    const fixture = makeInjectorFixture();
    const made = fixture.hostView as unknown as { createNewSession: () => Promise<void> };
    made.createNewSession = async () => {};
    await fixture.injector.handle(downlinkOp('op1', { type: 'new-session', sessionId: 'session-1' }));
    expect(receiptsFor(fixture.receipts, 'op1')).toEqual([
      { opId: 'op1', state: 'delivered' },
      { opId: 'op1', state: 'rejected', reason: 'postcondition-failed' },
    ]);
  });
});

describe('M2-A3 approve-for-session auto-resolves queued same-action requests', () => {
  it('remote session-scoped approval auto-resolves the queued request without a new card', async () => {
    const fixture = makeInjectorFixture();
    const first = fixture.approvalController.show(injectorApprovalData('a-1', 'run command: ls'));
    fixture.setCard('approval', 'c1', 'a-1');
    const second = fixture.approvalController.show(injectorApprovalData('a-2', 'run command: ls'));

    await fixture.injector.handle(downlinkOp('op1', { type: 'approve', sessionId: 'session-1', cardId: 'c1', optionIndex: 1 }));

    await expect(first).resolves.toEqual({ decision: 'approved', scope: 'session' });
    await expect(second).resolves.toEqual({ decision: 'approved', scope: 'session' });
    expect(fixture.cards.size).toBe(0);
    expect(fixture.currentPanel).toBeUndefined();
    expect(receiptsFor(fixture.receipts, 'op1')).toEqual([
      { opId: 'op1', state: 'delivered' },
      { opId: 'op1', state: 'applied' },
    ]);
  });
});

describe('P1 end-session terminal state is written before the session ends', () => {
  it('reports applied via the beforeEnd callback before the link stops', async () => {
    const fixture = makeInjectorFixture();
    const events: string[] = [];
    const made = fixture.hostView as unknown as {
      runEndSession: (opts?: { beforeEnd?: () => void }) => Promise<void>;
    };
    made.runEndSession = async (opts) => {
      events.push('run-start');
      opts?.beforeEnd?.();
      events.push('after-before-stop');
    };
    await fixture.injector.handle(downlinkOp('op1', { type: 'end-session', sessionId: 'session-1' }));
    expect(events).toEqual(['run-start', 'after-before-stop']);
    expect(receiptsFor(fixture.receipts, 'op1')).toEqual([
      { opId: 'op1', state: 'delivered' },
      { opId: 'op1', state: 'applied' },
    ]);
  });

  it('still reports applied when runEndSession completes without invoking beforeEnd', async () => {
    const fixture = makeInjectorFixture();
    const made = fixture.hostView as unknown as {
      runEndSession: (opts?: { beforeEnd?: () => void }) => Promise<void>;
    };
    made.runEndSession = async () => {};
    await fixture.injector.handle(downlinkOp('op1', { type: 'end-session', sessionId: 'session-1' }));
    expect(receiptsFor(fixture.receipts, 'op1')).toEqual([
      { opId: 'op1', state: 'delivered' },
      { opId: 'op1', state: 'applied' },
    ]);
  });

  it('reports rejected: postcondition-failed when runEndSession throws before reporting', async () => {
    const fixture = makeInjectorFixture();
    const made = fixture.hostView as unknown as {
      runEndSession: (opts?: { beforeEnd?: () => void }) => Promise<void>;
    };
    made.runEndSession = async () => {
      throw new Error('unpublish failed');
    };
    await fixture.injector.handle(downlinkOp('op1', { type: 'end-session', sessionId: 'session-1' }));
    expect(receiptsFor(fixture.receipts, 'op1')).toEqual([
      { opId: 'op1', state: 'delivered' },
      { opId: 'op1', state: 'rejected', reason: 'postcondition-failed' },
    ]);
  });
});

describe('P5-5.1: ops targeting a session other than the current one are rejected untouched', () => {
  it('rejects a card op with delivered then rejected/thread-unknown and leaves the card open', async () => {
    const fixture = makeInjectorFixture();
    const shown = fixture.approvalController.show(injectorApprovalData('a-1'));
    fixture.setCard('approval', 'c1', 'a-1');
    await fixture.injector.handle({
      opId: 'op1',
      sessionId: 'session-other',
      intent: { type: 'approve', sessionId: 'session-other', cardId: 'c1', optionIndex: 0 },
    });
    expect(receiptsFor(fixture.receipts, 'op1')).toEqual([
      { opId: 'op1', state: 'delivered' },
      { opId: 'op1', state: 'rejected', reason: 'thread-unknown' },
    ]);
    expect(fixture.cards.has('c1')).toBe(true);
    expect(fixture.currentPanel).toBe('c1');
    let resolved = false;
    void shown.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it('rejects a session-control op without invoking any host capability', async () => {
    const fixture = makeInjectorFixture();
    await fixture.injector.handle({
      opId: 'op1',
      sessionId: 'session-other',
      intent: { type: 'send', sessionId: 'session-other', text: 'hi' },
    });
    expect(receiptsFor(fixture.receipts, 'op1')).toEqual([
      { opId: 'op1', state: 'delivered' },
      { opId: 'op1', state: 'rejected', reason: 'thread-unknown' },
    ]);
    expect(fixture.calls.sent).toEqual([]);
  });

  it('rejects card, session-control, and end-session ops when there is no current session', async () => {
    const fixture = makeInjectorFixture();
    const made = fixture.hostView as unknown as { session: () => Session | undefined };
    made.session = () => undefined;
    fixture.setCard('approval', 'c1', 'a-1');
    await fixture.injector.handle(
      downlinkOp('op1', { type: 'approve', sessionId: 'session-1', cardId: 'c1', optionIndex: 0 }),
    );
    await fixture.injector.handle(downlinkOp('op2', { type: 'send', sessionId: 'session-1', text: 'hi' }));
    await fixture.injector.handle(downlinkOp('op3', { type: 'end-session', sessionId: 'session-1' }));
    for (const opId of ['op1', 'op2', 'op3']) {
      expect(receiptsFor(fixture.receipts, opId)).toEqual([
        { opId, state: 'delivered' },
        { opId, state: 'rejected', reason: 'thread-unknown' },
      ]);
    }
    expect(fixture.cards.has('c1')).toBe(true);
    expect(fixture.calls.sent).toEqual([]);
    expect(fixture.calls.endSession).toBe(0);
  });
});

describe('P5-5.2: ops on the current session keep the existing dispatch', () => {
  it('applies card, session-control, and end-session ops on the current session', async () => {
    const cardFixture = makeInjectorFixture();
    const shown = cardFixture.approvalController.show(injectorApprovalData('a-1'));
    cardFixture.setCard('approval', 'c1', 'a-1');
    await cardFixture.injector.handle(
      downlinkOp('op1', { type: 'approve', sessionId: 'session-1', cardId: 'c1', optionIndex: 0 }),
    );
    await expect(shown).resolves.toEqual({ decision: 'approved' });
    expect(receiptsFor(cardFixture.receipts, 'op1')).toEqual([
      { opId: 'op1', state: 'delivered' },
      { opId: 'op1', state: 'applied' },
    ]);

    const sendFixture = makeInjectorFixture();
    await sendFixture.injector.handle(downlinkOp('op2', { type: 'send', sessionId: 'session-1', text: 'hi' }));
    expect(sendFixture.calls.sent).toEqual(['hi']);
    expect(receiptsFor(sendFixture.receipts, 'op2')).toEqual([
      { opId: 'op2', state: 'delivered' },
      { opId: 'op2', state: 'applied' },
    ]);

    const endFixture = makeInjectorFixture();
    await endFixture.injector.handle(downlinkOp('op3', { type: 'end-session', sessionId: 'session-1' }));
    expect(endFixture.calls.endSession).toBe(1);
    expect(receiptsFor(endFixture.receipts, 'op3')).toEqual([
      { opId: 'op3', state: 'delivered' },
      { opId: 'op3', state: 'applied' },
    ]);
  });
});

describe('P5-5.3: end-session on a mismatched session is rejected without stopping', () => {
  it('reports delivered then rejected/thread-unknown and never reaches runEndSession', async () => {
    const fixture = makeInjectorFixture();
    await fixture.injector.handle({
      opId: 'op1',
      sessionId: 'session-other',
      intent: { type: 'end-session', sessionId: 'session-other' },
    });
    expect(receiptsFor(fixture.receipts, 'op1')).toEqual([
      { opId: 'op1', state: 'delivered' },
      { opId: 'op1', state: 'rejected', reason: 'thread-unknown' },
    ]);
    expect(fixture.calls.endSession).toBe(0);
  });
});

interface RecordedHubRequest {
  method: string;
  path: string;
  body: unknown;
}

class InjectorFakeHub {
  readonly requests: RecordedHubRequest[] = [];
  readonly registerSnapshots: unknown[] = [];
  readonly unregisterBodies: unknown[] = [];
  readonly receiptBodies: unknown[] = [];
  readonly receiptTimeline: { source: 'post' | 'register' | 'unregister'; report: ReceiptReport }[] = [];
  private server: Server | undefined;
  private readonly streamControllers = new Set<{
    write: (chunk: string) => void;
    close: () => void;
  }>();

  get url(): string {
    const address = this.server?.address();
    if (address === undefined || address === null || typeof address === 'string') {
      throw new Error('hub not listening');
    }
    return `http://127.0.0.1:${address.port}`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', resolve);
    });
  }

  async close(): Promise<void> {
    for (const controller of this.streamControllers) controller.close();
    this.streamControllers.clear();
    await new Promise<void>((resolve) => {
      this.server!.close(() => {
        resolve();
      });
      this.server!.closeAllConnections?.();
    });
  }

  pushToStreams(text: string): void {
    for (const controller of this.streamControllers) controller.write(`${text}\n\n`);
  }

  private async handle(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const body = await readHubBody(req);
    this.requests.push({ method: req.method ?? '', path, body });
    if (req.method === 'GET' && path === '/api/worker/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': connected\n\n');
      const controller = {
        write: (chunk: string) => res.write(chunk),
        close: () => res.destroy(),
      };
      this.streamControllers.add(controller);
      res.on('close', () => {
        this.streamControllers.delete(controller);
      });
      return;
    }
    if (req.method === 'POST' && path === '/api/worker/register') {
      this.registerSnapshots.push(body);
      for (const report of ((body as { recentReceipts?: ReceiptReport[] }).recentReceipts) ?? []) {
        this.receiptTimeline.push({ source: 'register', report });
      }
      const snapshot = body as { workerId?: string; threads?: { descriptor: { sessionId: string } }[] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          workerId: snapshot.workerId ?? 'w1',
          threads: (snapshot.threads as { descriptor: { sessionId: string } }[] | undefined)?.map((thread) => ({
            sessionId: thread.descriptor.sessionId,
            accepted: true,
          })) ?? [],
        }),
      );
      return;
    }
    if (req.method === 'POST' && path === '/api/worker/receipt') {
      for (const report of ((body as { receipts?: ReceiptReport[] }).receipts) ?? []) {
        this.receiptTimeline.push({ source: 'post', report });
      }
      this.receiptBodies.push(body);
    }
    if (req.method === 'POST' && path === '/api/worker/unregister') {
      for (const report of ((body as { finalReceipts?: ReceiptReport[] }).finalReceipts) ?? []) {
        this.receiptTimeline.push({ source: 'unregister', report });
      }
      this.unregisterBodies.push(body);
    }
    res.writeHead(204);
    res.end();
  }
}

async function readHubBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const HUB_TIMING = {
  heartbeatTimeoutMs: 5_000,
  backoffBaseMs: 10,
  backoffCapMs: 40,
  batchIntervalMs: 5,
};

function makeHubSnapshot(sessionIds: string[]): LinkOptions['getSnapshot'] extends () => infer S ? S : never {
  return {
    workerId: 'w1',
    threads: sessionIds.map((sessionId) => ({
      descriptor: {
        sessionId,
        machine: { tokenName: 't', hostname: 'h' },
        project: 'p',
        title: 'title',
        kind: 'interactive',
        capabilities: ['send', 'new-session', 'end-session'],
      },
      overview: {
        rev: 1,
        phase: 'idle',
        isCompacting: false,
        model: 'm',
        thinkingEffort: 'low',
        permissionMode: 'default',
        planMode: false,
        contextUsage: 0,
        goal: null,
        todos: [],
        subagents: [],
        backgroundTasks: [],
        models: [],
        lastLine: '',
        sampledAt: 0,
      },
      timeline: [],
      openCards: [],
    })),
  };
}

function hubReceiptState(hub: InjectorFakeHub, opId: string): string | undefined {
  let state: string | undefined;
  for (const entry of hub.receiptTimeline) {
    if (entry.report.opId === opId) state = entry.report.state;
  }
  return state;
}

describe('M2-A4 new-session and end-session receipts reach applied over a real link (fake hub)', () => {
  it('new-session: terminal state is reported after the mid-run resync re-registration', async () => {
    const hub = new InjectorFakeHub();
    await hub.start();
    try {
      let sessionIds = ['session-1'];
      let resyncCount = 0;
      const { hostView } = makeHostView();
      const madeHost = hostView as unknown as { createNewSession: () => Promise<void> };
      const originalCreate = madeHost.createNewSession.bind(madeHost);
      madeHost.createNewSession = async () => {
        await originalCreate();
        sessionIds = ['s2'];
        resyncCount += 1;
        link.resync();
      };
      const host: InjectorHost = {
        reportReceipt: (report) => {
          link.reportReceipt(report);
        },
        getOpenCard: () => undefined,
        isCurrentPanel: () => false,
        respondApproval: () => {},
        respondQuestion: () => {},
      };
      const injector = new Injector(host, hostView);
      const link = new Link({
        url: hub.url,
        token: 'token',
        getSnapshot: () => makeHubSnapshot(sessionIds),
        onOp: (op) => {
          void injector.handle(op);
        },
        timing: HUB_TIMING,
      } satisfies LinkOptions);
      link.start();
      await waitFor(() => link.state === 'published');
      hub.pushToStreams(
        `event: op\ndata: ${JSON.stringify({ opId: 'opNew', sessionId: 'session-1', intent: { type: 'new-session', sessionId: 'session-1' } })}`,
      );
      await waitFor(() => hubReceiptState(hub, 'opNew') !== undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(resyncCount).toBe(1);
      expect(hubReceiptState(hub, 'opNew')).toBe('applied');
      const lastRegister = hub.registerSnapshots.at(-1) as { threads: { descriptor: { sessionId: string } }[] };
      expect(lastRegister.threads.map((t) => t.descriptor.sessionId)).toEqual(['s2']);
      await link.stop();
    } finally {
      await hub.close();
    }
  });

  it('end-session: applied is written before the resync, the new session registers, and no unregister happens', async () => {
    const hub = new InjectorFakeHub();
    await hub.start();
    try {
      const { hostView } = makeHostView();
      const madeHost = hostView as unknown as {
        runEndSession: (opts?: { beforeEnd?: () => void }) => Promise<void>;
      };
      const receipts: ReceiptReport[] = [];
      let link: Link;
      let sessionIds = ['session-1'];
      madeHost.runEndSession = async (opts) => {
        opts?.beforeEnd?.();
        sessionIds = ['s2'];
        link.resync();
      };
      const host: InjectorHost = {
        reportReceipt: (report) => {
          receipts.push(report);
          link.reportReceipt(report);
        },
        getOpenCard: () => undefined,
        isCurrentPanel: () => false,
        respondApproval: () => {},
        respondQuestion: () => {},
      };
      const injector = new Injector(host, hostView);
      link = new Link({
        url: hub.url,
        token: 'token',
        getSnapshot: () => makeHubSnapshot(sessionIds),
        onOp: (op) => {
          void injector.handle(op);
        },
        timing: HUB_TIMING,
      } satisfies LinkOptions);
      link.start();
      await waitFor(() => link.state === 'published');
      const registerCountBefore = hub.registerSnapshots.length;
      hub.pushToStreams(
        `event: op\ndata: ${JSON.stringify({ opId: 'opEnd', sessionId: 'session-1', intent: { type: 'end-session', sessionId: 'session-1' } })}`,
      );
      await waitFor(() => hub.registerSnapshots.length > registerCountBefore);
      const lastRegister = hub.registerSnapshots.at(-1) as {
        threads: { descriptor: { sessionId: string } }[];
        recentReceipts: ReceiptReport[];
      };
      expect(lastRegister.threads.map((t) => t.descriptor.sessionId)).toEqual(['s2']);
      expect(lastRegister.recentReceipts).toContainEqual({ opId: 'opEnd', state: 'applied' });
      await waitFor(() => hubReceiptState(hub, 'opEnd') === 'applied');
      expect(hub.unregisterBodies).toHaveLength(0);
      expect(receipts.filter((report) => report.opId === 'opEnd')).toEqual([
        { opId: 'opEnd', state: 'delivered' },
        { opId: 'opEnd', state: 'applied' },
      ]);
      await link.stop();
    } finally {
      await hub.close();
    }
  });
});

const P7_HUB_MJS = fileURLToPath(
  new URL('../../../../../../packages/forum-link/dist/hub.mjs', import.meta.url),
);
const P7_TIMEOUT_MS = 30_000;

let p7HubBuilt = false;

function ensureP7HubBuilt(): void {
  if (p7HubBuilt || existsSync(P7_HUB_MJS)) {
    p7HubBuilt = true;
    return;
  }
  const result = spawnSync('pnpm', ['-F', '@moonshot-ai/forum-link', 'build'], {
    cwd: fileURLToPath(new URL('../../../../../', import.meta.url)),
    stdio: 'ignore',
    shell: true,
    timeout: 120_000,
  });
  if (result.status !== 0) throw new Error('forum-link hub build failed');
  p7HubBuilt = true;
}

interface P7HubHandle {
  baseUrl: string;
  stop(): Promise<void>;
}

async function spawnP7Hub(dataDir: string): Promise<P7HubHandle> {
  ensureP7HubBuilt();
  const child = spawn(process.execPath, [P7_HUB_MJS, 'serve', '--data-dir', dataDir, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    output += chunk;
  });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const deadline = Date.now() + 8000;
    const poll = () => {
      const match = /listening on http:\/\/\S+:(\d+)/.exec(output);
      if (match !== null) {
        resolve(`http://127.0.0.1:${match[1]}`);
        return;
      }
      if (child.exitCode !== null || Date.now() > deadline) {
        child.kill();
        reject(new Error(`hub failed to start: ${output}`));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
  return {
    baseUrl,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      await new Promise<void>((resolve) => {
        child.once('exit', () => {
          resolve();
        });
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5000).unref?.();
      });
    },
  };
}

async function p7IssueTokens(
  baseUrl: string,
  dataDir: string,
): Promise<{ machineSecret: string; deviceSecret: string }> {
  const adminKey = readFileSync(join(dataDir, 'admin.key'), 'utf8').trim();
  const issue = async (role: 'machine' | 'device', name: string): Promise<string> => {
    const response = await fetch(`${baseUrl}/api/admin/tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ role, name }),
    });
    if (response.status !== 200) throw new Error(`token issue failed: ${response.status}`);
    return ((await response.json()) as { secret: string }).secret;
  };
  return { machineSecret: await issue('machine', 'laptop'), deviceSecret: await issue('device', 'phone') };
}

interface P7ThreadView {
  online: boolean;
  timeline: { seq: number; kind: string }[];
  receipts: { opId: string; state: string; reason?: string }[];
}

async function p7ReadThread(
  baseUrl: string,
  cookie: string,
  sessionId: string,
): Promise<P7ThreadView | undefined> {
  const response = await fetch(`${baseUrl}/api/browser/threads/${sessionId}`, { headers: { cookie } });
  if (response.status !== 200) return undefined;
  return (await response.json()) as P7ThreadView;
}

async function p7PostOp(
  baseUrl: string,
  cookie: string,
  sessionId: string,
  intent: Record<string, unknown>,
): Promise<{ opId: string; state: string; reason?: string }> {
  const response = await fetch(`${baseUrl}/api/browser/ops`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, intent }),
  });
  if (response.status !== 202) throw new Error(`ops failed: ${response.status}`);
  return (await response.json()) as { opId: string; state: string; reason?: string };
}

async function p7WaitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

function p7SnapshotOf(
  workerId: string,
  sessionIds: string[],
): LinkOptions['getSnapshot'] extends () => infer S ? S : never {
  return makeHubSnapshot(sessionIds);
}

describe('P7-7.3: session switch over a real hub keeps late old-session ops rejected and the new session empty', () => {
  it('late ops for the old session are rejected by the injector, the new session registers empty, and the hub prunes the old thread', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'forum-link-p7-'));
    const hub = await spawnP7Hub(dataDir);
    try {
      const { machineSecret, deviceSecret } = await p7IssueTokens(hub.baseUrl, dataDir);
      const cookie = `${BROWSER_COOKIE_NAME}=${deviceSecret}`;
      let sessionIds = ['s-old'];
      const { hostView, calls } = makeHostView();
      const madeSession = hostView.session as unknown as { id: string };
      madeSession.id = 's-old';
      const receipts: ReceiptReport[] = [];
      const heldOps: DownlinkOp[] = [];
      let holdOps = true;
      let link: Link;
      const host: InjectorHost = {
        reportReceipt: (report) => {
          receipts.push(report);
          link.reportReceipt(report);
        },
        getOpenCard: () => undefined,
        isCurrentPanel: () => false,
        respondApproval: () => {},
        respondQuestion: () => {},
      };
      const injector = new Injector(host, hostView);
      link = new Link({
        url: hub.baseUrl,
        token: machineSecret,
        getSnapshot: () => p7SnapshotOf('w1', sessionIds),
        onOp: (op) => {
          if (holdOps) heldOps.push(op);
          else void injector.handle(op);
        },
        timing: HUB_TIMING,
      } satisfies LinkOptions);
      link.start();
      await waitFor(() => link.state === 'published');
      await p7WaitFor(async () => (await p7ReadThread(hub.baseUrl, cookie, 's-old')) !== undefined, 'old thread registered');

      const inFlight = await p7PostOp(hub.baseUrl, cookie, 's-old', {
        type: 'send',
        sessionId: 's-old',
        text: 'in flight',
      });
      expect(inFlight.state).toBe('accepted');
      await waitFor(() => heldOps.length === 1);
      const held = heldOps[0]!;
      expect(held.opId).toBe(inFlight.opId);
      expect(held.sessionId).toBe('s-old');

      madeSession.id = 's-new';
      sessionIds = ['s-new'];
      link.resync();
      await p7WaitFor(async () => (await p7ReadThread(hub.baseUrl, cookie, 's-new')) !== undefined, 'new thread registered');
      const newThread = await p7ReadThread(hub.baseUrl, cookie, 's-new');
      expect(newThread?.online).toBe(true);
      expect(newThread?.timeline).toEqual([]);
      await p7WaitFor(async () => (await p7ReadThread(hub.baseUrl, cookie, 's-old')) === undefined, 'old thread pruned');

      holdOps = false;
      for (const op of heldOps.splice(0)) await injector.handle(op);
      expect(receipts.filter((report) => report.opId === inFlight.opId)).toEqual([
        { opId: inFlight.opId, state: 'delivered' },
        { opId: inFlight.opId, state: 'rejected', reason: 'thread-unknown' },
      ]);
      expect(calls.sent).toEqual([]);

      const late = await p7PostOp(hub.baseUrl, cookie, 's-old', {
        type: 'send',
        sessionId: 's-old',
        text: 'late',
      });
      expect(late.state).toBe('rejected');
      expect(late.reason).toBe('thread-unknown');

      await p7WaitFor(() => {
        if (!existsSync(join(dataDir, 'state.json'))) return false;
        try {
          const persisted = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as {
            receipts: { opId: string; state: string; reason?: string }[];
          };
          const target = persisted.receipts.find((entry) => entry.opId === inFlight.opId);
          return target !== undefined && target.state === 'lost';
        } catch {
          return false;
        }
      }, 'in-flight old-session receipt reconciled to lost in state.json');
      const persisted = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as {
        receipts: { opId: string; state: string; reason?: string }[];
      };
      expect(persisted.receipts.find((entry) => entry.opId === inFlight.opId)).toMatchObject({
        state: 'lost',
        reason: 'not-delivered',
      });

      await link.stop();
    } finally {
      await hub.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, P7_TIMEOUT_MS);
});
