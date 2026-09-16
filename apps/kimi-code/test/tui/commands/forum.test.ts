import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findBuiltInSlashCommand, resolveSlashCommandAvailability } from '#/tui/commands/index';
import { dispatchInput, type SlashCommandHost } from '#/tui/commands/dispatch';
import { handleForumCommand } from '#/tui/commands/forum';
import { NO_ACTIVE_SESSION_MESSAGE } from '#/tui/constant/kimi-tui';
import { ForumLinkController } from '#/tui/controllers/forum-link';
import { KimiTUI, type KimiTUIStartupInput } from '#/tui/kimi-tui';
import { getRemoteKeyFile } from '#/utils/paths';

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'forum-cmd-'));
  vi.stubEnv('KIMI_CODE_HOME', homeDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(homeDir, { recursive: true, force: true });
});

function writeRemoteKey(content: string): void {
  writeFileSync(getRemoteKeyFile(), content, 'utf-8');
}

interface StubController {
  state: ForumLinkController['state'];
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function makeStubController(state: ForumLinkController['state'] = 'detached'): StubController {
  return {
    state,
    start: vi.fn(async () => ({ ok: true })),
    stop: vi.fn(async () => {}),
  };
}

function makeHost(options: {
  session?: { id: string };
  controller?: StubController;
} = {}): SlashCommandHost & {
  showError: ReturnType<typeof vi.fn>;
  showStatus: ReturnType<typeof vi.fn>;
  ensureForumLink: ReturnType<typeof vi.fn>;
  track: ReturnType<typeof vi.fn>;
} {
  const stub = options.controller ?? makeStubController();
  const host = {
    session: 'session' in options ? options.session : { id: 'ses-1' },
    state: {
      appState: { streamingPhase: 'idle', isCompacting: false, model: 'k2' },
    },
    track: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    restoreInputText: vi.fn(),
    forumLink: options.controller === undefined ? undefined : (stub as never),
    ensureForumLink: vi.fn(() => stub as never),
  } as unknown as SlashCommandHost & {
    showError: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    ensureForumLink: ReturnType<typeof vi.fn>;
    track: ReturnType<typeof vi.fn>;
  };
  return host;
}

describe('forum slash command registration', () => {
  it('is registered as an always-available built-in', () => {
    const command = findBuiltInSlashCommand('forum');
    expect(command).toBeDefined();
    expect(resolveSlashCommandAvailability(command!, '')).toBe('always');
  });
});

describe('handleForumCommand', () => {
  it('shows the no-active-session error and never touches the network or controller', async () => {
    const host = makeHost({ session: undefined, controller: makeStubController() });
    writeRemoteKey('url=http://127.0.0.1:8787\npassword=x\n');

    await handleForumCommand(host);

    expect(host.showError).toHaveBeenCalledTimes(1);
    expect(host.showError).toHaveBeenCalledWith(NO_ACTIVE_SESSION_MESSAGE);
    expect(host.ensureForumLink).not.toHaveBeenCalled();
    expect(host.showStatus).not.toHaveBeenCalled();
    expect(readdirSync(homeDir)).toEqual(['remote_key']);
  });

  it('shows the credential hint with the full path and makes no connection', async () => {
    const host = makeHost();

    await handleForumCommand(host);

    expect(host.showError).toHaveBeenCalledTimes(1);
    const message = host.showError.mock.calls[0]?.[0] as string;
    expect(message).toContain(join(homeDir, 'remote_key'));
    expect(message).toContain('url=');
    expect(host.ensureForumLink).not.toHaveBeenCalled();
    expect(host.showStatus).not.toHaveBeenCalled();
  });

  it('toggles off when the controller is not detached: stop, no publish path', async () => {
    const controller = makeStubController('published');
    const host = makeHost({ controller });

    await handleForumCommand(host);

    expect(controller.stop).toHaveBeenCalledTimes(1);
    expect(controller.start).not.toHaveBeenCalled();
    expect(host.ensureForumLink).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Forum Link: unpublished');
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('toggles off from connecting and backoff states as well', async () => {
    for (const state of ['connecting', 'backoff'] as const) {
      const controller = makeStubController(state);
      const host = makeHost({ controller });

      await handleForumCommand(host);

      expect(controller.stop).toHaveBeenCalledTimes(1);
      expect(controller.start).not.toHaveBeenCalled();
    }
  });

  it('publishes when detached: credential resolved and forwarded to start', async () => {
    const controller = makeStubController('detached');
    const host = makeHost({ controller });
    writeRemoteKey('url=http://127.0.0.1:8787\npassword=secret123\n');

    await handleForumCommand(host);

    expect(host.ensureForumLink).toHaveBeenCalledTimes(1);
    expect(controller.start).toHaveBeenCalledTimes(1);
    expect(controller.start).toHaveBeenCalledWith({
      url: 'http://127.0.0.1:8787',
      password: 'secret123',
    });
    expect(host.showStatus).toHaveBeenCalledWith('Forum Link: published');
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('passes an empty password through when the key file omits it', async () => {
    const controller = makeStubController('detached');
    const host = makeHost({ controller });
    writeRemoteKey('url=http://127.0.0.1:8787\n');

    await handleForumCommand(host);

    expect(controller.start).toHaveBeenCalledWith({
      url: 'http://127.0.0.1:8787',
      password: '',
    });
  });

  it('shows the error when start fails (e.g. 401)', async () => {
    const controller = makeStubController('detached');
    controller.start.mockResolvedValueOnce({
      ok: false,
      reason: 'connect-failed',
      error: new Error('unauthorized'),
    });
    const host = makeHost({ controller });
    writeRemoteKey('url=http://127.0.0.1:8787\npassword=bad\n');

    await handleForumCommand(host);

    expect(host.showError).toHaveBeenCalledTimes(1);
    expect(host.showError).toHaveBeenCalledWith(
      'Forum Link publish failed: unauthorized',
    );
    expect(host.showStatus).not.toHaveBeenCalledWith('Forum Link: published');
  });
});

function makeStartupInput(workDir: string): KimiTUIStartupInput {
  return {
    cliOptions: {
      session: undefined,
      continue: false,
      yolo: false,
      auto: false,
      plan: false,
      model: undefined,
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
      agent: undefined,
      agentFiles: [],
    },
    tuiConfig: {
      theme: 'dark',
      disablePasteBurst: false,
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
      statusLine: { items: null, command: null },
    },
    version: '0.0.0-test',
    workDir,
  };
}

function makeTuiHarness() {
  return {
    getConfig: vi.fn(async () => ({})),
    createSession: vi.fn(async () => {}),
    resumeSession: vi.fn(async () => {}),
    listSessions: vi.fn(async () => []),
    listSessionsPage: vi.fn(async () => ({ items: [], nextCursor: undefined })),
    close: vi.fn(async () => {}),
    track: vi.fn(),
    setTelemetryContext: vi.fn(),
    getExperimentalFeatures: vi.fn(async () => []),
    supportsAtomicSectionReplace: vi.fn(() => false),
    auth: {
      status: vi.fn(async () => ({ providers: [] })),
      login: vi.fn(async () => {}),
      logout: vi.fn(),
      getManagedUsage: vi.fn(),
    },
  };
}

function makeTui(workDir = '/tmp/proj-a'): KimiTUI {
  const tui = new KimiTUI(makeTuiHarness() as never, makeStartupInput(workDir));
  vi.spyOn(tui.state.ui, 'requestRender').mockImplementation(() => {});
  vi.spyOn(tui.state.terminal, 'setProgress').mockImplementation(() => {});
  return tui;
}

describe('KimiTUI — ensureForumLink / buildForumDescriptor wiring', () => {
  it('forumLink starts undefined; ensureForumLink creates once and memoizes', () => {
    const tui = makeTui();
    expect(tui.forumLink).toBeUndefined();

    const first = tui.ensureForumLink();
    expect(first).toBeInstanceOf(ForumLinkController);
    expect(tui.forumLink).toBe(first);
    expect(tui.ensureForumLink()).toBe(first);
  });

  it('descriptor building maps session + appState fields onto the descriptor', () => {
    const tui = makeTui('F:/proj/forum-demo');
    const controller = tui.ensureForumLink();
    tui.setAppState({ sessionTitle: '我的调试会话' });

    expect(controller).toBeInstanceOf(ForumLinkController);
    const describe = (
      controller as unknown as { deps: { buildDescriptor?: (session: unknown) => unknown } }
    ).deps;
    const result = describe.buildDescriptor?.({ id: 'ses-42' }) as {
      sessionId: string;
      machineName: string;
      projectName: string;
      title: string;
      status: string;
    };
    expect(result.sessionId).toBe('ses-42');
    expect(result.projectName).toBe('forum-demo');
    expect(result.title).toBe('我的调试会话');
    expect(result.status).toBe('idle');
    expect(typeof result.machineName).toBe('string');
    expect(result.machineName.length).toBeGreaterThan(0);
  });

  it('descriptor title falls back to empty string without a session title', () => {
    const tui = makeTui('/tmp/proj-b');
    const controller = tui.ensureForumLink();
    const describe = (
      controller as unknown as { deps: { buildDescriptor?: (session: unknown) => unknown } }
    ).deps;
    const result = describe.buildDescriptor?.({ id: 's' }) as { title: string };
    expect(result.title).toBe('');
  });

  it('S3 wrapper picks up the lazily created controller on later panel shows', () => {
    const tui = makeTui();
    const approvalController = (
      tui as unknown as {
        approvalController: {
          show: (payload: unknown) => Promise<unknown>;
          respond: (response: unknown) => void;
        };
      }
    ).approvalController;

    void approvalController.show({
      id: 'early-1',
      tool_call_id: 'tc-early',
      tool_name: 'Bash',
      action: 'run',
      description: 'early panel',
      display: [],
      choices: [{ label: 'Allow', response: 'approved' }],
    });
    expect(tui.forumLink?.openCards ?? []).toEqual([]);

    tui.ensureForumLink();

    approvalController.respond({ decision: 'rejected' });
    void approvalController.show({
      id: 'late-1',
      tool_call_id: 'tc-late',
      tool_name: 'Bash',
      action: 'run',
      description: 'late panel',
      display: [],
      choices: [{ label: 'Allow', response: 'approved' }],
    });
    expect(tui.forumLink?.openCards ?? []).toEqual([
      { cardId: 'c1', kind: 'approval', upstreamId: 'late-1' },
    ]);
  });

  it('basename mapping uses the platform separator for workDir', () => {
    const tui = makeTui(join('C:', 'work', 'repo-x'));
    const controller = tui.ensureForumLink();
    const describe = (
      controller as unknown as { deps: { buildDescriptor?: (session: unknown) => unknown } }
    ).deps;
    const result = describe.buildDescriptor?.({ id: 's' }) as { projectName: string };
    expect(result.projectName).toBe('repo-x');
  });

  it('ensureForumLink seeds the current session when one already exists', async () => {
    const tui = makeTui();
    const session = {
      id: 'ses-lazy',
      setApprovalHandler: vi.fn(),
      setQuestionHandler: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } as never;
    await tui.setSession(session);
    expect(tui.forumLink).toBeUndefined();

    const controller = tui.ensureForumLink();
    const current = (
      controller as unknown as { session: unknown }
    ).session;
    expect(current).toBe(session);
  });

  it('ensureForumLink with no live session leaves the controller session unset', () => {
    const tui = makeTui();
    const controller = tui.ensureForumLink();
    expect((controller as unknown as { session: unknown }).session).toBeUndefined();
  });
});

describe('dispatchInput — /forum routing', () => {
  it('dispatches /forum through the builtin path to the command handler', async () => {
    const controller = makeStubController('detached');
    const host = makeHost({ controller });
    writeRemoteKey('url=http://127.0.0.1:8787\npassword=route\n');

    dispatchInput(host, '/forum');
    await vi.waitFor(() => {
      expect(controller.start).toHaveBeenCalledTimes(1);
    });
    expect(controller.start).toHaveBeenCalledWith({
      url: 'http://127.0.0.1:8787',
      password: 'route',
    });
    expect(host.showStatus).toHaveBeenCalledWith('Forum Link: published');
  });

  it('dispatches /forum to stop when already published', async () => {
    const controller = makeStubController('published');
    const host = makeHost({ controller });
    writeRemoteKey('url=http://127.0.0.1:8787\npassword=route\n');

    dispatchInput(host, '/forum');
    await vi.waitFor(() => {
      expect(controller.stop).toHaveBeenCalledTimes(1);
    });
    expect(controller.start).not.toHaveBeenCalled();
  });
});
