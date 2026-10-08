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
    writeRemoteKey('url=http://127.0.0.1:8787\ntoken=x\n');

    await handleForumCommand(host, '');

    expect(host.showError).toHaveBeenCalledTimes(1);
    expect(host.showError).toHaveBeenCalledWith(NO_ACTIVE_SESSION_MESSAGE);
    expect(host.ensureForumLink).not.toHaveBeenCalled();
    expect(host.showStatus).not.toHaveBeenCalled();
    expect(readdirSync(homeDir)).toEqual(['remote_key']);
  });

  it('shows the credential hint with the full path and makes no connection', async () => {
    const host = makeHost();

    await handleForumCommand(host, '');

    expect(host.showError).toHaveBeenCalledTimes(1);
    const message = host.showError.mock.calls[0]?.[0] as string;
    expect(message).toContain(join(homeDir, 'remote_key'));
    expect(message).toContain('url=');
    expect(host.ensureForumLink).not.toHaveBeenCalled();
    expect(host.showStatus).not.toHaveBeenCalled();
  });

  it('is idempotent while connecting/published/backoff: status notice only, zero side effects', async () => {
    const notices = {
      connecting: 'Forum Link: connecting...',
      published: 'Forum Link: published',
      backoff: 'Forum Link: connection lost, retrying...',
    } as const;
    for (const state of ['connecting', 'published', 'backoff'] as const) {
      const controller = makeStubController(state);
      const host = makeHost({ controller });

      await handleForumCommand(host, '');

      expect(host.showStatus).toHaveBeenCalledTimes(1);
      expect(host.showStatus).toHaveBeenCalledWith(notices[state]);
      expect(controller.start).not.toHaveBeenCalled();
      expect(controller.stop).not.toHaveBeenCalled();
      expect(host.ensureForumLink).not.toHaveBeenCalled();
      expect(host.showError).not.toHaveBeenCalled();
    }
  });

  it('publishes when detached: credential resolved and forwarded to start', async () => {
    const controller = makeStubController('detached');
    const host = makeHost({ controller });
    writeRemoteKey('url=http://127.0.0.1:8787\ntoken=secret123\n');

    await handleForumCommand(host, '');

    expect(host.ensureForumLink).toHaveBeenCalledTimes(1);
    expect(controller.start).toHaveBeenCalledTimes(1);
    expect(controller.start).toHaveBeenCalledWith({
      url: 'http://127.0.0.1:8787',
      token: 'secret123',
    });
    expect(host.showStatus).toHaveBeenCalledWith('Forum Link: published');
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('shows the credential error when the key file omits the token', async () => {
    const controller = makeStubController('detached');
    const host = makeHost({ controller });
    writeRemoteKey('url=http://127.0.0.1:8787\n');

    await handleForumCommand(host, '');

    expect(controller.start).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledTimes(1);
    const message = host.showError.mock.calls[0]?.[0] as string;
    expect(message).toContain('token');
  });

  it('shows the error when start fails (e.g. 401)', async () => {
    const controller = makeStubController('detached');
    controller.start.mockResolvedValueOnce({
      ok: false,
      reason: 'connect-failed',
      error: new Error('unauthorized'),
    });
    const host = makeHost({ controller });
    writeRemoteKey('url=http://127.0.0.1:8787\ntoken=bad\n');

    await handleForumCommand(host, '');

    expect(host.showError).toHaveBeenCalledTimes(1);
    expect(host.showError).toHaveBeenCalledWith(
      'Forum Link publish failed: unauthorized',
    );
    expect(controller.stop).toHaveBeenCalledTimes(1);
    expect(host.showStatus).not.toHaveBeenCalledWith('Forum Link: published');
  });

  it('a publish failure is recoverable: a later /forum calls start again', async () => {
    const controller = makeStubController('detached');
    controller.start.mockResolvedValueOnce({
      ok: false,
      reason: 'connect-failed',
      error: new Error('unauthorized'),
    });
    const host = makeHost({ controller });
    writeRemoteKey('url=http://127.0.0.1:8787\ntoken=bad\n');

    await handleForumCommand(host, '');
    expect(controller.start).toHaveBeenCalledTimes(1);
    expect(controller.stop).toHaveBeenCalledTimes(1);

    controller.state = 'detached';
    await handleForumCommand(host, '');

    expect(controller.start).toHaveBeenCalledTimes(2);
    expect(controller.stop).toHaveBeenCalledTimes(1);
    expect(host.showStatus).toHaveBeenCalledWith('Forum Link: published');
  });
});

describe('handleForumCommand — /forum stop', () => {
  it('stops exactly once and shows the unpublished notice when active', async () => {
    const controller = makeStubController('published');
    const host = makeHost({ controller });

    await handleForumCommand(host, 'stop');

    expect(controller.stop).toHaveBeenCalledTimes(1);
    expect(controller.start).not.toHaveBeenCalled();
    expect(host.ensureForumLink).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledTimes(1);
    expect(host.showStatus).toHaveBeenCalledWith('Forum Link: unpublished');
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('is a zero-call no-op notice when no controller exists', async () => {
    const host = makeHost();
    writeRemoteKey('url=http://127.0.0.1:8787\ntoken=x\n');

    await handleForumCommand(host, 'stop');

    expect(host.ensureForumLink).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledTimes(1);
    expect(host.showStatus).toHaveBeenCalledWith('Forum Link: unpublished');
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('is a zero-call no-op notice when the controller is detached', async () => {
    const controller = makeStubController('detached');
    const host = makeHost({ controller });

    await handleForumCommand(host, 'stop');

    expect(controller.stop).not.toHaveBeenCalled();
    expect(controller.start).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledTimes(1);
    expect(host.showStatus).toHaveBeenCalledWith('Forum Link: unpublished');
    expect(host.showError).not.toHaveBeenCalled();
  });
});

describe('handleForumCommand — invalid args', () => {
  it.each(['stop now', 'off', 'toggle'])(
    'rejects %j with the usage error and never touches the controller',
    async (args) => {
      const controller = makeStubController('published');
      const host = makeHost({ controller });

      await handleForumCommand(host, args);

      expect(host.showError).toHaveBeenCalledTimes(1);
      expect(host.showError).toHaveBeenCalledWith('Usage: /forum or /forum stop');
      expect(controller.start).not.toHaveBeenCalled();
      expect(controller.stop).not.toHaveBeenCalled();
      expect(host.ensureForumLink).not.toHaveBeenCalled();
      expect(host.showStatus).not.toHaveBeenCalled();
    },
  );
});

describe('handleForumCommand — argument parsing', () => {
  it('treats uppercase and padded stop as stop', async () => {
    for (const args of ['STOP', '  stop  ']) {
      const controller = makeStubController('published');
      const host = makeHost({ controller });

      await handleForumCommand(host, args);

      expect(controller.stop).toHaveBeenCalledTimes(1);
      expect(host.showStatus).toHaveBeenCalledWith('Forum Link: unpublished');
    }
  });

  it('treats empty and whitespace-only args as publish', async () => {
    const controller = makeStubController('detached');
    const host = makeHost({ controller });
    writeRemoteKey('url=http://127.0.0.1:8787\ntoken=parse\n');

    await handleForumCommand(host, '');
    await handleForumCommand(host, '   ');

    expect(controller.start).toHaveBeenCalledTimes(2);
    expect(host.showStatus).toHaveBeenCalledWith('Forum Link: published');
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
    const snapshot = controller.getSnapshot();
    const thread = snapshot.threads[0]!;
    expect(thread.descriptor.kind).toBe('interactive');
    expect(thread.descriptor.project).toBe('forum-demo');
    expect(thread.descriptor.title).toBe('我的调试会话');
    expect(thread.descriptor.machine.tokenName).toBe('');
    expect(typeof thread.descriptor.machine.hostname).toBe('string');
    expect(thread.descriptor.machine.hostname.length).toBeGreaterThan(0);
    expect(thread.descriptor.capabilities.length).toBeGreaterThan(0);
  });

  it('descriptor title falls back to empty string without a session title', () => {
    const tui = makeTui('/tmp/proj-b');
    const controller = tui.ensureForumLink();
    const snapshot = controller.getSnapshot();
    expect(snapshot.threads[0]!.descriptor.title).toBe('');
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
    const openCards = tui.forumLink?.openCards ?? [];
    expect(openCards).toHaveLength(1);
    expect(openCards[0]!.kind).toBe('approval');
    expect(openCards[0]!.cardId.startsWith('approval_')).toBe(true);
  });

  it('basename mapping uses the platform separator for workDir', () => {
    const tui = makeTui(join('C:', 'work', 'repo-x'));
    const controller = tui.ensureForumLink();
    const snapshot = controller.getSnapshot();
    expect(snapshot.threads[0]!.descriptor.project).toBe('repo-x');
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
    writeRemoteKey('url=http://127.0.0.1:8787\ntoken=route\n');

    dispatchInput(host, '/forum');
    await vi.waitFor(() => {
      expect(controller.start).toHaveBeenCalledTimes(1);
    });
    expect(controller.start).toHaveBeenCalledWith({
      url: 'http://127.0.0.1:8787',
      token: 'route',
    });
    expect(host.showStatus).toHaveBeenCalledWith('Forum Link: published');
  });

  it('dispatches /forum as an idempotent status notice when already published', async () => {
    const controller = makeStubController('published');
    const host = makeHost({ controller });
    writeRemoteKey('url=http://127.0.0.1:8787\ntoken=route\n');

    dispatchInput(host, '/forum');
    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalledWith('Forum Link: published');
    });
    expect(controller.stop).not.toHaveBeenCalled();
    expect(controller.start).not.toHaveBeenCalled();
  });

  it('dispatches /forum stop to the explicit stop path', async () => {
    const controller = makeStubController('published');
    const host = makeHost({ controller });
    writeRemoteKey('url=http://127.0.0.1:8787\ntoken=route\n');

    dispatchInput(host, '/forum stop');
    await vi.waitFor(() => {
      expect(controller.stop).toHaveBeenCalledTimes(1);
    });
    expect(controller.start).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Forum Link: unpublished');
  });
});
