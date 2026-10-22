import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '#human/llm/message';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import {
  literalRulePattern,
  matchesGlobRuleSubject,
  matchesPathRuleSubject,
} from '#/tool/rule-match';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IHostEnvironment, type IHostEnvironment as HostEnvironmentService } from '#/os/interface/hostEnvironment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFsError } from '#/os/interface/hostFsErrors';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPermissionPolicyService, type PermissionPolicyEvaluation } from '#/agent/permissionPolicy/permissionPolicy';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { AgentPermissionPolicyService } from '#/agent/permissionPolicy/permissionPolicyService';
import { DangerousCommandAskPermissionPolicyService } from '#/agent/permissionPolicy/policies/dangerous-command-ask';
import {
  IAgentPermissionRulesService,
  type IAgentPermissionRulesService as PermissionRulesServiceContract,
  type PermissionRule,
} from '#/agent/permissionRules/permissionRules';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { Runtime, RuntimeCapability, RuntimeLease } from '#/runtime/runtime';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IConfigService } from '#/app/config/config';
import { ILogService } from '#/_base/log/log';
import { PERMISSION_SECTION } from '#/agent/permissionRules/configSection';
import { IBashParserService } from '#/app/bashParser/bashParser';
import { BashParserService } from '#/app/bashParser/bashParserService';
import { IBootstrapService, type HostArgs } from '#/app/bootstrap/bootstrap';
import { IGitService } from '#/app/git/git';
import { findGitWorkTree } from '#/app/git/workTree';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { ToolAccesses, type ToolAccesses as ToolAccessList } from '#/tool/toolContract';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import { stubPermissionModeService } from '../permissionMode/stubs';
import { recordingTelemetry } from '../../app/telemetry/stubs';

const { join, basename, dirname } = nodePath.posix;
const nativeJoin = nodePath.join;
const realFsRoot = 'F:/LearnProj/AI/kimi-code/.tmp/yb-real-fs';

async function symlinkReal(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, 'junction');
}

const signal = new AbortController().signal;

const hostFs = new HostFileSystem();

let logRecords: { level: string; msg: string; payload: unknown }[];
const logService: ILogService = {
  _serviceBrand: undefined,
  level: 'info',
  setLevel: () => {},
  flush: () => Promise.resolve(),
  error: (msg, payload) => logRecords.push({ level: 'error', msg, payload }),
  warn: (msg, payload) => logRecords.push({ level: 'warn', msg, payload }),
  info: (msg, payload) => logRecords.push({ level: 'info', msg, payload }),
  debug: (msg, payload) => logRecords.push({ level: 'debug', msg, payload }),
  child: () => logService,
};

describe('AgentPermissionPolicyService chain', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let mode: PermissionMode;
  let rules: PermissionRule[];
  let sessionApprovalRulePatterns: string[];
  let workspace: ReturnType<typeof workspaceStub>;
  let hostArgs: HostArgs;
  let dangerousCommandGuardEnabled: boolean;
  let runtimeStub: ReturnType<typeof createRuntimeStub>;
  let fakeFs: FakeHostFs;

  beforeEach(() => {
    disposables = new DisposableStore();
    mode = 'manual';
    rules = [];
    sessionApprovalRulePatterns = [];
    workspace = workspaceStub('/workspace');
    hostArgs = { requestHeaders: {}, nonInteractive: false };
    dangerousCommandGuardEnabled = true;
    fakeFs = createFakeHostFs(['/workspace', '/workspace/src']);
    runtimeStub = createRuntimeStub({ fakeFs });
    logRecords = [];
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IAgentPermissionModeService, stubPermissionModeService(() => mode));
        reg.definePartialInstance(IBootstrapService, {
          get args() {
            return hostArgs;
          },
        });
        reg.definePartialInstance(IConfigService, {
          get: ((section: string) =>
            section === PERMISSION_SECTION && !dangerousCommandGuardEnabled
              ? { dangerousCommandGuard: false }
              : undefined) as IConfigService['get'],
          onDidSectionChange: (() => ({ dispose: () => {} })) as IConfigService['onDidSectionChange'],
        });
        reg.defineInstance(
          IAgentScopeContext,
          makeAgentScopeContext({ agentId: 'main', agentScope: '' }),
        );
        reg.definePartialInstance(IAgentPermissionRulesService, permissionRulesStub({
          rules: () => rules,
          sessionApprovalRulePatterns: () => sessionApprovalRulePatterns,
        }));
        reg.defineInstance(ISessionWorkspaceContext, workspace.stub);
        reg.defineInstance(IHostEnvironment, kaosStub());
        reg.defineInstance(IAgentRuntimeService, runtimeStub.service);
        reg.defineInstance(ILogService, logService);
        reg.defineInstance(ITelemetryService, recordingTelemetry([]));
        reg.definePartialInstance(IGitService, { findWorkTree: async () => null });
        reg.define(IBashParserService, BashParserService);
        reg.define(IAgentPermissionPolicyService, AgentPermissionPolicyService);
      },
      strict: true,
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  function service(): IAgentPermissionPolicyService {
    return ix.get(IAgentPermissionPolicyService);
  }

  async function evaluate(
    input: PolicyContextInput,
  ): Promise<PermissionPolicyEvaluation | undefined> {
    const svc = service();
    return svc.evaluate(policyContext(input));
  }

  it('keeps auto-mode AskUserQuestion deny above default approval', async () => {
    mode = 'auto';

    await expect(evaluate({
      toolName: 'AskUserQuestion',
      args: { questions: [] },
    })).resolves.toMatchObject({
      policyName: 'auto-mode-ask-user-question-deny',
      result: { kind: 'deny' },
    });
  });

  it('applies deny rules before yolo-mode approval', async () => {
    mode = 'yolo';
    rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash',
      reason: 'blocked by test',
    });

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'printf first', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'user-configured-deny',
      result: {
        kind: 'deny',
        message: 'Tool "Bash" was denied by permission rule. Reason: blocked by test',
      },
    });
  });

  it('keeps ask rules higher priority than matching allow rules', async () => {
    rules.push(
      {
        decision: 'allow',
        scope: 'project',
        pattern: 'Bash',
      },
      {
        decision: 'ask',
        scope: 'user',
        pattern: 'Bash',
      },
    );

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'printf first', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'user-configured-ask',
      result: { kind: 'ask' },
    });
  });

  it('reuses approve-for-session before matching ask rules', async () => {
    rules.push({
      decision: 'ask',
      scope: 'user',
      pattern: 'Bash',
    });
    sessionApprovalRulePatterns.push('Bash(printf first)');

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'printf first', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'session-approval-history',
      result: {
        kind: 'approve',
        reason: {
          has_rule_args: true,
          match_strategy: 'matches_rule',
        },
      },
    });
  });

  it.each(['manual', 'yolo'] as const)(
    'asks for shutdown in %s mode',
    async (currentMode) => {
      mode = currentMode;

      await expect(evaluate({
        toolName: 'Bash',
        args: { command: 'shutdown -h now', timeout: 60 },
      })).resolves.toMatchObject({
        policyName: 'dangerous-command-ask',
        result: { kind: 'ask', reason: { dangerous_command: 'shutdown' } },
      });
    },
  );

  it.each([
    'shutdown -h now',
    'reboot',
    'rm -rf /tmp/build',
    'dd if=/dev/zero of=/dev/sda bs=1M',
  ])('approves `%s` in auto mode', async (command) => {
    mode = 'auto';

    await expect(evaluate({
      toolName: 'Bash',
      args: { command, timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'auto-mode-approve',
      result: { kind: 'approve' },
    });
  });

  it.each([
    ['sudo reboot', 'reboot'],
    ['sudo -u root reboot', 'reboot'],
    ['/sbin/poweroff', 'poweroff'],
    ['echo ok && shutdown now', 'shutdown'],
    ['if halt; then echo x; fi', 'halt'],
    ['echo $(reboot)', 'reboot'],
    ['init 0', 'init'],
    ['telinit 6', 'telinit'],
    ['mkfs.ext4 /dev/sda1', 'mkfs.ext4'],
    ['wipefs -a /dev/sda', 'wipefs'],
    ['dd if=/dev/zero of=/dev/sda bs=1M', 'dd'],
    ['Restart-Computer -Force', 'restart-computer'],
    ['Stop-Computer', 'stop-computer'],
    ['bcdedit /set x y', 'bcdedit'],
    ['diskpart /s script.txt', 'diskpart'],
    ['format C:', 'format'],
    ['SHUTDOWN /s /t 0', 'shutdown'],
    ['shut\\down -h now', 'shutdown'],
    ['systemctl poweroff', 'systemctl poweroff'],
    ['systemctl --user reboot', 'systemctl reboot'],
    ['bash -c "shutdown now"', 'shutdown'],
    ['rm -rf /tmp/build /root', 'rm -rf'],
    ['rm -fr dir', 'rm -rf'],
    ['rm -r -f dir', 'rm -rf'],
    ['rm -R --force dir', 'rm -rf'],
    ['rm -rfv dir', 'rm -rf'],
    ['sudo -u root rm --recursive --force dir', 'rm -rf'],
    ['echo ok && rm -rf dir', 'rm -rf'],
    ['env rm -rf dir', 'rm -rf'],
    ['env FOO=bar rm -rf dir', 'rm -rf'],
    ['env -i FOO=bar shutdown now', 'shutdown'],
    ['nohup rm -rf dir', 'rm -rf'],
    ['exec reboot', 'reboot'],
    ['command reboot', 'reboot'],
    ['builtin shutdown now', 'shutdown'],
    ['nice -n 5 poweroff', 'poweroff'],
    ['nice --adjustment=5 shutdown now', 'shutdown'],
    ['busybox poweroff', 'poweroff'],
    ['busybox rm -rf dir', 'rm -rf'],
    ['eval "shutdown now"', 'shutdown'],
    ['eval rm -rf dir', 'rm -rf'],
    ['bash -lc "shutdown now"', 'shutdown'],
    ['bash -c "env rm -rf dir"', 'rm -rf'],
    ["bash -c 'eval \"shutdown now\"'", 'shutdown'],
  ] as const)('asks for `%s` in yolo mode', async (command, matched) => {
    mode = 'yolo';

    await expect(evaluate({
      toolName: 'Bash',
      args: { command, timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'dangerous-command-ask',
      result: { kind: 'ask', reason: { dangerous_command: matched } },
    });
  });

  it.each(['rm -rf /tmp/build', 'rm -rf /temp/cache'])(
    'approves `%s` in yolo mode',
    async (command) => {
      mode = 'yolo';

      await expect(evaluate({
        toolName: 'Bash',
        args: { command, timeout: 60 },
      })).resolves.toMatchObject({
        policyName: 'yolo-mode-approve',
        result: { kind: 'approve' },
      });
    },
  );

  it.each([
    'init 3',
    'dd if=/dev/zero of=/dev/null bs=1M count=1',
    'echo shutdown',
    'systemctl status sshd',
    'bash -c "echo ok"',
    'rm -r dir',
    'rm -f file',
    'rm -i file',
    'rm --recursive dir',
    'rm --force file',
    'rm dir',
    'env FOO=bar echo ok',
    'command -v rm',
    'command echo ok',
    'nohup echo ok',
    'nice echo ok',
    'busybox --list',
    'eval "echo ok"',
  ])('does not flag `%s` in auto mode', async (command) => {
    mode = 'auto';

    await expect(evaluate({
      toolName: 'Bash',
      args: { command, timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'auto-mode-approve',
      result: { kind: 'approve' },
    });
  });

  it.each(['$CMD --force', 'bash -c "echo $HOME"', 'echo "unterminated'])(
    'approves unanalyzable command `%s` in yolo mode',
    async (command) => {
      mode = 'yolo';

      await expect(evaluate({
        toolName: 'Bash',
        args: { command, timeout: 60 },
      })).resolves.toMatchObject({
        policyName: 'yolo-mode-approve',
        result: { kind: 'approve' },
      });
    },
  );

  it('approves a heredoc command containing a single quote in yolo mode', async () => {
    mode = 'yolo';

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'gh --body "$(cat <<\'EOF\'\nit\'s\nEOF\n)"', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'yolo-mode-approve',
      result: { kind: 'approve' },
    });
  });

  it('does not acquire a runtime lease for commands without rm -rf', async () => {
    mode = 'yolo';

    await evaluate({ toolName: 'Bash', args: { command: 'echo ok', timeout: 60 } });

    expect(runtimeStub.acquireCount).toBe(0);
    expect(runtimeStub.disposeCount).toBe(0);
  });

  it('acquires and releases exactly one lease per rm -rf evaluation', async () => {
    mode = 'yolo';

    await evaluate({ toolName: 'Bash', args: { command: 'rm -rf dist', timeout: 60 } });
    await evaluate({ toolName: 'Bash', args: { command: 'rm -rf /tmp/build', timeout: 60 } });

    expect(runtimeStub.acquireCount).toBe(2);
    expect(runtimeStub.disposeCount).toBe(2);
  });

  it.each(['rm -rf node_modules', 'rm -rf /tmp/build'])(
    'asks for `%s` in yolo mode when the runtime has no fs capability',
    async (command) => {
      mode = 'yolo';
      runtimeStub.capabilities = new Set();

      await expect(evaluate({
        toolName: 'Bash',
        args: { command, timeout: 60 },
      })).resolves.toMatchObject({
        policyName: 'dangerous-command-ask',
        result: { kind: 'ask', reason: { dangerous_command: 'rm -rf' } },
      });
    },
  );

  it('fake fs realpath rejects unknown paths with os.fs.not_found HostFsError', async () => {
    await expect(fakeFs.realpath('/workspace/definitely-missing')).rejects.toMatchObject({
      name: 'HostFsError',
      code: 'os.fs.not_found',
    });
  });

  it('fake fs stat reports configured directories and rejects unknown paths', async () => {
    await expect(fakeFs.stat('/workspace')).resolves.toMatchObject({ isDirectory: true });
    await expect(fakeFs.stat('/workspace/definitely-missing')).rejects.toMatchObject({
      name: 'HostFsError',
      code: 'os.fs.not_found',
    });
  });

  describe('rm eligibility whitelist', () => {
    beforeEach(() => {
      fakeFs = createFakeHostFs([
        '/workspace',
        '/workspace/src',
        '/workspace/packages/x',
        '/workspace/packages/pkg',
        '/workspace/node_modules',
        '/workspace/apps/a/node_modules/.vite',
        '/workspace/.git',
        '/home/test',
        '/tmp',
        '/temp',
        '/var/tmp',
        '/yy/tmp',
      ]);
      runtimeStub = createRuntimeStub({ fakeFs });
      recreateServices();
    });

    function recreateServices(): void {
      disposables.dispose();
      disposables = new DisposableStore();
      ix = createServices(disposables, {
        additionalServices: (reg) => {
          reg.defineInstance(IAgentPermissionModeService, stubPermissionModeService(() => mode));
          reg.definePartialInstance(IBootstrapService, {
            get args() {
              return hostArgs;
            },
          });
          reg.definePartialInstance(IConfigService, {
            get: ((section: string) =>
              section === PERMISSION_SECTION && !dangerousCommandGuardEnabled
                ? { dangerousCommandGuard: false }
                : undefined) as IConfigService['get'],
            onDidSectionChange: (() => ({ dispose: () => {} })) as IConfigService['onDidSectionChange'],
          });
          reg.defineInstance(
            IAgentScopeContext,
            makeAgentScopeContext({ agentId: 'main', agentScope: '' }),
          );
          reg.definePartialInstance(IAgentPermissionRulesService, permissionRulesStub({
            rules: () => rules,
            sessionApprovalRulePatterns: () => sessionApprovalRulePatterns,
          }));
          reg.defineInstance(ISessionWorkspaceContext, workspace.stub);
          reg.defineInstance(IHostEnvironment, kaosStub());
          reg.defineInstance(IAgentRuntimeService, runtimeStub.service);
          reg.defineInstance(ILogService, logService);
          reg.defineInstance(ITelemetryService, recordingTelemetry([]));
          reg.definePartialInstance(IGitService, { findWorkTree: async () => null });
          reg.define(IBashParserService, BashParserService);
          reg.define(IAgentPermissionPolicyService, AgentPermissionPolicyService);
        },
        strict: true,
      });
    }

    async function expectYoloApprove(command: string): Promise<void> {
      mode = 'yolo';
      await expect(evaluate({
        toolName: 'Bash',
        args: { command, timeout: 60 },
      })).resolves.toMatchObject({
        policyName: 'yolo-mode-approve',
        result: { kind: 'approve' },
      });
    }

    async function expectYoloAsk(command: string): Promise<void> {
      mode = 'yolo';
      await expect(evaluate({
        toolName: 'Bash',
        args: { command, timeout: 60 },
      })).resolves.toMatchObject({
        policyName: 'dangerous-command-ask',
        result: { kind: 'ask', reason: { dangerous_command: 'rm -rf' } },
      });
    }

    it.each([
      'rm -rf node_modules',
      'rm -rf dist build coverage',
      'rm -rf packages/x/dist',
      'rm -rf apps/a/node_modules/.vite',
      'rm -rf coverage',
      'rm -rf Node_Modules',
    ])('approves `%s` in yolo mode', async (command) => {
      await expectYoloApprove(command);
    });

    it.each([
      'rm -rf .',
      'rm -rf src',
      'rm -rf dist src',
      'rm -rf node_modules/../src',
      'rm -rf .git/dist',
      'rm -rf dist/.env',
    ])('asks for `%s` in yolo mode', async (command) => {
      await expectYoloAsk(command);
    });

    it.each([
      'rm -rf dist/',
      'rm -rf /tmp/link/',
    ])('asks for symlink-escape `%s` in yolo mode', async (command) => {
      fakeFs.addLink('/workspace/dist', '/workspace/src');
      fakeFs.addLink('/tmp/link', '/home/test');
      await expectYoloAsk(command);
    });

    it('asks for workspace-linked rm inside node_modules in yolo mode', async () => {
      fakeFs.addLink('/workspace/node_modules/@scope/pkg', '/workspace/packages/pkg');
      await expectYoloAsk('rm -rf node_modules/@scope/pkg/');
    });

    it.each([
      'rm -rf /root',
      'rm -rf /tmp/build /root',
      'rm -rf /tmp',
      'rm -rf /var/tmp',
      'rm -rf /tmp/',
    ])('asks for non-whitelisted `%s` in yolo mode', async (command) => {
      await expectYoloAsk(command);
    });

    it.each([
      'rm -rf /tmp/build',
      'rm -rf /temp/cache',
      'rm -rf /var/tmp/x',
    ])('approves temp-content `%s` in yolo mode', async (command) => {
      await expectYoloApprove(command);
    });

    it('asks when the workspace itself lives inside a temp directory', async () => {
      fakeFs = createFakeHostFs(['/tmp/ws', '/tmp/ws/src']);
      workspace = workspaceStub('/tmp/ws');
      recreateServices();
      await expectYoloAsk('rm -rf /tmp/ws');
      await expectYoloAsk('rm -rf /tmp');
    });

    it('asks when realpath fails with a permission error', async () => {
      fakeFs.failRealpath(new HostFsError('os.fs.permission_denied', 'denied'));
      await expectYoloAsk('rm -rf /tmp/x');
    });

    it('asks and does not throw when the fs throws a non-fs error', async () => {
      fakeFs.failRealpath(new Error('boom'));
      await expectYoloAsk('rm -rf /tmp/x');
    });

    it('approves rm -rf dist when args.cwd points into the workspace', async () => {
      mode = 'yolo';
      await expect(evaluate({
        toolName: 'Bash',
        args: { command: 'rm -rf dist', timeout: 60, cwd: 'packages/x' },
      })).resolves.toMatchObject({
        policyName: 'yolo-mode-approve',
        result: { kind: 'approve' },
      });
    });

    it.each([
      'export A=1; cd packages/x && rm -rf dist',
      'cd /yy/tmp && rm -rf foo',
      '[ -d dist ] && rm -rf dist',
      'echo x && rm -rf dist',
      'rm -rf node_modules && pnpm install',
      'pnpm build && rm -rf /tmp/x',
      'export A=1; cd /yy/tmp && rm -rf foo',
    ])('approves cd-chained `%s` in yolo mode', async (command) => {
      await expectYoloApprove(command);
    });

    it.each([
      'pnpm build && rm -rf dist',
      'ln -s ~ nm && rm -rf nm/',
      'X=$(ln -s ~ dist) rm -rf dist/',
      'f(){ :; }; rm -rf dist',
      'cd x; rm -rf dist',
      'cd x || rm -rf dist',
      'cd - && rm -rf dist',
      'env -C x rm -rf dist',
      '(cd x && rm -rf dist)',
      'rm -rf dist & ln -s ~ dist',
      'rm -rf dist | cat',
      'X || cd a && rm -rf dist',
      'cd a/.. && rm -rf dist',
      'CDPATH=/x; cd a && rm -rf dist',
    ])('asks for position-unsafe `%s` in yolo mode', async (command) => {
      fakeFs.addDirectory('/workspace/x');
      fakeFs.addDirectory('/workspace/a');
      await expectYoloAsk(command);
    });

    it('asks when cd target does not exist', async () => {
      await expectYoloAsk('cd /yy/missing && rm -rf foo');
    });

    it('asks for relative cd when CDPATH is set', async () => {
      vi.stubEnv('CDPATH', '/x');
      try {
        await expectYoloAsk('cd packages/x && rm -rf dist');
        await expectYoloApprove('cd /yy/tmp && rm -rf foo');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('asks for rm -rf /tmp/x in a win32 scenario without cygpath', async () => {
      fakeFs = createFakeHostFs(['Z:/ws', 'Z:/ws/src', 'Z:/tmp'], { pathClass: 'win32' });
      runtimeStub = createRuntimeStub({
        fakeFs,
        pathClass: 'win32',
        environment: {
          osKind: 'Windows',
          shellName: 'bash',
          shellPath: 'Z:/missing/bin/bash.exe',
        },
      });
      workspace = workspaceStub('Z:/ws');
      recreateServices();
      await expectYoloAsk('rm -rf /tmp/x');
    });

    it('approves rm -rf dist in a win32 scenario', async () => {
      fakeFs = createFakeHostFs(['Z:/ws', 'Z:/ws/src'], { pathClass: 'win32' });
      runtimeStub = createRuntimeStub({
        fakeFs,
        pathClass: 'win32',
        environment: {
          osKind: 'Windows',
          shellName: 'bash',
          shellPath: 'Z:/missing/bin/bash.exe',
        },
      });
      workspace = workspaceStub('Z:/ws');
      recreateServices();
      await expectYoloApprove('rm -rf dist');
    });

    it.runIf(process.platform === 'win32')(
      'approves rm -rf /tmp/x via the real shell path bridge on Windows Git Bash',
      async () => {
        const cygpathCandidates = [
          nodePath.win32.join(
            nodePath.win32.dirname(process.env['SHELL'] ?? 'C:/Program Files/Git/bin/bash.exe'),
            'cygpath.exe',
          ),
        ];
        const shellDir = nodePath.win32.dirname(
          process.env['SHELL'] ?? 'C:/Program Files/Git/bin/bash.exe',
        );
        if (nodePath.win32.basename(shellDir).toLowerCase() === 'bin') {
          cygpathCandidates.push(nodePath.win32.join(shellDir, '..', 'usr', 'bin', 'cygpath.exe'));
        }
        if (!cygpathCandidates.some((candidate) => existsSync(candidate))) return;
        const realTemp = execFileSync(
          cygpathCandidates.find((c) => existsSync(c))!,
          ['-w', '-C', 'UTF8', '--', '/tmp'],
          { encoding: 'utf8' },
        ).trim();
        const realTempDir = realTemp.replaceAll('\\', '/');
        fakeFs = createFakeHostFs([realTempDir], { pathClass: 'win32' });
        runtimeStub = createRuntimeStub({
          fakeFs,
          pathClass: 'win32',
          environment: {
            osKind: 'Windows',
            shellName: 'bash',
            shellPath: process.env['SHELL'] ?? 'C:/Program Files/Git/bin/bash.exe',
          },
        });
        workspace = workspaceStub('C:/ws');
        recreateServices();
        await expectYoloApprove('rm -rf /tmp/x');
      },
    );
  });

  describe('rm eligibility failure logging', () => {
    it('A1: logs a warn when runtime acquire fails during evaluateRmEligibility', async () => {
      mode = 'yolo';
      runtimeStub.failAcquire = new Error('acquire failed');

      await expect(evaluate({
        toolName: 'Bash',
        args: { command: 'rm -rf /tmp/x', timeout: 60 },
      })).resolves.toMatchObject({
        policyName: 'dangerous-command-ask',
        result: { kind: 'ask', reason: { dangerous_command: 'rm -rf' } },
      });

      const warns = logRecords.filter((record) => record.level === 'warn');
      expect(warns).toHaveLength(1);
      expect(warns[0]!.msg).toContain('evaluateRmEligibility');
      expect(warns[0]!.payload).toMatchObject({ error: { message: 'acquire failed' } });
    });

    it('A2: logs a warn when isRmEligible fails on a non-fs stat error', async () => {
      mode = 'yolo';
      fakeFs.failStat(new Error('stat boom'));

      await expect(evaluate({
        toolName: 'Bash',
        args: { command: 'cd packages/x && rm -rf dist', timeout: 60 },
      })).resolves.toMatchObject({
        policyName: 'dangerous-command-ask',
        result: { kind: 'ask', reason: { dangerous_command: 'rm -rf' } },
      });

      const warns = logRecords.filter((record) => record.level === 'warn');
      expect(warns).toHaveLength(1);
      expect(warns[0]!.msg).toContain('isRmEligible');
      expect(warns[0]!.payload).toMatchObject({ error: { message: 'stat boom' } });
    });

    it('A3: falls back to ask without logging when acquire fails and no log service is injected', async () => {
      const policy = new DangerousCommandAskPermissionPolicyService(
        new BashParserService(),
        stubPermissionModeService(() => 'yolo'),
        {
          get: (() => undefined) as IConfigService['get'],
          onDidSectionChange: (() => ({ dispose: () => {} })) as IConfigService['onDidSectionChange'],
        } as unknown as IConfigService,
        createRuntimeStub({ fakeFs, failAcquire: new Error('acquire failed') }).service,
        workspace.stub,
      );
      await expect(policy.evaluate(policyContext({
        toolName: 'Bash',
        args: { command: 'rm -rf /tmp/x', timeout: 60 },
      }))).resolves.toMatchObject({ kind: 'ask', reason: { dangerous_command: 'rm -rf' } });
    });

    it('A3: falls back to ask without logging when stat fails and no log service is injected', async () => {
      fakeFs.failStat(new Error('stat boom'));
      const policy = new DangerousCommandAskPermissionPolicyService(
        new BashParserService(),
        stubPermissionModeService(() => 'yolo'),
        {
          get: (() => undefined) as IConfigService['get'],
          onDidSectionChange: (() => ({ dispose: () => {} })) as IConfigService['onDidSectionChange'],
        } as unknown as IConfigService,
        createRuntimeStub({ fakeFs }).service,
        workspace.stub,
      );
      await expect(policy.evaluate(policyContext({
        toolName: 'Bash',
        args: { command: 'cd packages/x && rm -rf dist', timeout: 60 },
      }))).resolves.toMatchObject({ kind: 'ask', reason: { dangerous_command: 'rm -rf' } });
    });
  });

  describe('rm eligibility in manual mode', () => {
    beforeEach(() => {
      fakeFs = createFakeHostFs(['/workspace', '/workspace/src', '/workspace/node_modules']);
      runtimeStub = createRuntimeStub({ fakeFs });
    });

    it('falls back to ask for whitelisted rm without rules', async () => {
      mode = 'manual';
      await expect(evaluate({
        toolName: 'Bash',
        args: { command: 'rm -rf node_modules', timeout: 60 },
      })).resolves.toMatchObject({
        policyName: 'fallback-ask',
        result: { kind: 'ask' },
      });
    });

    it('approves whitelisted rm via session approval history', async () => {
      mode = 'manual';
      sessionApprovalRulePatterns.push('Bash(rm -rf node_modules)');
      await expect(evaluate({
        toolName: 'Bash',
        args: { command: 'rm -rf node_modules', timeout: 60 },
      })).resolves.toMatchObject({
        policyName: 'session-approval-history',
        result: { kind: 'approve' },
      });
    });

    it('still asks for non-whitelisted rm with session approval', async () => {
      mode = 'manual';
      sessionApprovalRulePatterns.push('Bash(rm -rf src)');
      await expect(evaluate({
        toolName: 'Bash',
        args: { command: 'rm -rf src', timeout: 60 },
      })).resolves.toMatchObject({
        policyName: 'dangerous-command-ask',
        result: { kind: 'ask' },
      });
    });

    it('approves whitelisted rm via a user allow rule', async () => {
      mode = 'manual';
      rules.push({ decision: 'allow', scope: 'user', pattern: 'Bash(rm -rf *)' });
      await expect(evaluate({
        toolName: 'Bash',
        args: { command: 'rm -rf node_modules', timeout: 60 },
      })).resolves.toMatchObject({
        policyName: 'user-configured-allow',
        result: { kind: 'approve' },
      });
    });

    it('still asks for non-whitelisted rm with a user allow rule', async () => {
      mode = 'manual';
      rules.push({ decision: 'allow', scope: 'user', pattern: 'Bash(rm -rf *)' });
      await expect(evaluate({
        toolName: 'Bash',
        args: { command: 'rm -rf src', timeout: 60 },
      })).resolves.toMatchObject({
        policyName: 'dangerous-command-ask',
        result: { kind: 'ask' },
      });
    });
  });

  it('asks for whitelisted rm in yolo mode when the user configures an ask rule', async () => {
    mode = 'yolo';
    rules.push({ decision: 'ask', scope: 'user', pattern: 'Bash(rm -rf *)' });
    fakeFs = createFakeHostFs(['/workspace', '/workspace/node_modules']);
    runtimeStub = createRuntimeStub({ fakeFs });

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'rm -rf node_modules', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'user-configured-ask',
      result: { kind: 'ask' },
    });
  });

  describe('rm eligibility with real fs', () => {
    let realFsWorkspaceDir: string;
    const pathClass: 'posix' | 'win32' = process.platform === 'win32' ? 'win32' : 'posix';
    const isExfatTemp = process.platform === 'win32' && /^R:/i.test(tmpdir());

    beforeEach(async () => {
      await mkdir(realFsRoot, { recursive: true });
      realFsWorkspaceDir = await mkdtemp(nativeJoin(realFsRoot, 'kimi-rm-elig-'));
      await mkdir(nativeJoin(realFsWorkspaceDir, 'src'), { recursive: true });
      workspace = workspaceStub(realFsWorkspaceDir.replaceAll('\\', '/'));
      runtimeStub = createRuntimeStub({ fakeFs, useRealFs: true, pathClass });
    });

    afterEach(async () => {
      await rm(realFsWorkspaceDir, { recursive: true, force: true });
    });

    it('asks for a symlinked dist directory', async ({ skip }) => {
      if (isExfatTemp) skip();
      await symlinkReal(
        nativeJoin(realFsWorkspaceDir, 'src'),
        nativeJoin(realFsWorkspaceDir, 'dist'),
      );
      mode = 'yolo';
      await expect(evaluate({
        toolName: 'Bash',
        args: { command: 'rm -rf dist/', timeout: 60 },
      })).resolves.toMatchObject({
        policyName: 'dangerous-command-ask',
        result: { kind: 'ask', reason: { dangerous_command: 'rm -rf' } },
      });
    });

    it('approves a missing coverage directory', async () => {
      mode = 'yolo';
      await expect(evaluate({
        toolName: 'Bash',
        args: { command: 'rm -rf coverage', timeout: 60 },
      })).resolves.toMatchObject({
        policyName: 'yolo-mode-approve',
        result: { kind: 'approve' },
      });
    });

    it('resolves missing subpaths under a link through the link target', async ({ skip }) => {
      if (isExfatTemp) skip();
      const targetDir = await mkdtemp(nativeJoin(realFsRoot, 'kimi-rm-target-'));
      try {
        await mkdir(nativeJoin(targetDir, 'dist'), { recursive: true });
        const linkPath = nativeJoin(realFsWorkspaceDir, 'link');
        await symlinkReal(targetDir, linkPath);
        mode = 'yolo';
        await expect(evaluate({
          toolName: 'Bash',
          args: { command: `rm -rf ${linkPath.replaceAll('\\', '/')}/missing/x`, timeout: 60 },
        })).resolves.toMatchObject({
          policyName: 'yolo-mode-approve',
          result: { kind: 'approve' },
        });
      } finally {
        await rm(targetDir, { recursive: true, force: true });
      }
    });
  });

  it.each(['rm -rf $X', 'rm -rf ~/x', 'rm -rf *'])(
    'asks for dropped rm operand `%s` in yolo mode',
    async (command) => {
      mode = 'yolo';

      await expect(evaluate({
        toolName: 'Bash',
        args: { command, timeout: 60 },
      })).resolves.toMatchObject({
        policyName: 'dangerous-command-ask',
        result: { kind: 'ask', reason: { dangerous_command: 'rm -rf' } },
      });
    },
  );

  it.each([
    'sudo rm -rf dist',
    'env -C x rm -rf dist',
    'bash -c "rm -rf dist"',
    'eval rm -rf dist',
  ])('asks for wrapped rm command `%s` in yolo mode', async (command) => {
    mode = 'yolo';

    await expect(evaluate({
      toolName: 'Bash',
      args: { command, timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'dangerous-command-ask',
      result: { kind: 'ask', reason: { dangerous_command: 'rm -rf' } },
    });
  });

  it.each([
    'rm -rf dist; $X; shutdown now',
    'rm -rf /tmp/x && $EDITOR f',
  ])('asks for rm command followed by unanalyzable code `%s` in yolo mode', async (command) => {
    mode = 'yolo';

    await expect(evaluate({
      toolName: 'Bash',
      args: { command, timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'dangerous-command-ask',
      result: { kind: 'ask', reason: { dangerous_command: 'rm -rf' } },
    });
  });

  it.each(['$CMD --force', 'bash -c "echo $HOME"', 'echo "unterminated'])(
    'asks for unanalyzable command `%s` in manual mode',
    async (command) => {
      mode = 'manual';

      await expect(evaluate({
        toolName: 'Bash',
        args: { command, timeout: 60 },
      })).resolves.toMatchObject({
        policyName: 'dangerous-command-ask',
        result: { kind: 'ask', reason: { unanalyzable_command: true } },
      });
    },
  );

  it.each(['$CMD --force', 'bash -c "echo $HOME"', 'env $FLAGS'])(
    'approves unanalyzable command `%s` in auto mode',
    async (command) => {
      mode = 'auto';

      await expect(evaluate({
        toolName: 'Bash',
        args: { command, timeout: 60 },
      })).resolves.toMatchObject({
        policyName: 'auto-mode-approve',
        result: { kind: 'approve' },
      });
    },
  );

  it('does not load the dangerous command policy for non-interactive hosts', async () => {
    hostArgs = { ...hostArgs, nonInteractive: true };
    mode = 'auto';

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'rm -rf /tmp/build', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'auto-mode-approve',
      result: { kind: 'approve' },
    });
  });

  it('does not load the built-in guard policies when disabled by config', async () => {
    dangerousCommandGuardEnabled = false;
    mode = 'yolo';

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'shutdown -h now', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'yolo-mode-approve',
      result: { kind: 'approve' },
    });

    await expect(evaluate({
      toolName: 'Read',
      args: { path: '/workspace/.env' },
    })).resolves.toMatchObject({
      policyName: 'yolo-mode-approve',
      result: { kind: 'approve' },
    });

    await expect(evaluate({
      toolName: 'Write',
      args: { path: '.git/config', content: 'x' },
      accesses: ToolAccesses.writeFile('/workspace/.git/config'),
    })).resolves.toMatchObject({
      policyName: 'yolo-mode-approve',
      result: { kind: 'approve' },
    });

    await expect(evaluate({
      toolName: 'Read',
      args: { path: '/workspace/.git/config' },
    })).resolves.toMatchObject({
      policyName: 'yolo-mode-approve',
      result: { kind: 'approve' },
    });
  });

  it('does not let session approval history exempt dangerous commands', async () => {
    sessionApprovalRulePatterns.push('Bash(shutdown -h now)');

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'shutdown -h now', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'dangerous-command-ask',
      result: { kind: 'ask' },
    });
  });

  it('keeps deny rules above dangerous command ask', async () => {
    rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash(shutdown *)',
    });

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'shutdown -h now', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'user-configured-deny',
      result: { kind: 'deny' },
    });
  });

  it.each(['AgentSwarm', 'EnterPlanMode', 'ExitPlanMode', 'CreateGoal'] as const)(
    'approves %s through the default tool allowlist in manual mode',
    async (toolName) => {
      await expect(evaluate({ toolName, args: {} })).resolves.toMatchObject({
        policyName: 'default-tool-approve',
        result: { kind: 'approve' },
      });
    },
  );
});

describe('AgentPermissionPolicyService git cwd write approval', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let mode: PermissionMode;
  let workspace: ReturnType<typeof workspaceStub>;
  let workspaceDir: string;
  let cleanupDirs: string[];

  beforeEach(async () => {
    disposables = new DisposableStore();
    mode = 'manual';
    workspaceDir = await mkdtemp(join(tmpdir(), 'kimi-permission-git-'));
    cleanupDirs = [workspaceDir];
    await mkdir(join(workspaceDir, '.git'), { recursive: true });
    workspace = workspaceStub(workspaceDir);
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IAgentPermissionModeService, stubPermissionModeService(() => mode));
        reg.definePartialInstance(IBootstrapService, {
          args: { requestHeaders: {}, nonInteractive: false },
        });
        reg.definePartialInstance(IConfigService, {
          get: (() => undefined) as IConfigService['get'],
          onDidSectionChange: (() => ({ dispose: () => {} })) as IConfigService['onDidSectionChange'],
        });
        reg.defineInstance(
          IAgentScopeContext,
          makeAgentScopeContext({ agentId: 'main', agentScope: '' }),
        );
        reg.definePartialInstance(IAgentPermissionRulesService, permissionRulesStub());
        reg.defineInstance(ISessionWorkspaceContext, workspace.stub);
        reg.defineInstance(IHostEnvironment, kaosStub());
        reg.defineInstance(IAgentRuntimeService, {
          _serviceBrand: undefined,
          onDidChange: () => ({ dispose: () => {} }),
          isAvailable: () => true,
          inspect() { return (this as IAgentRuntimeService).acquire().runtime; },
          acquire: () => ({
            track: (resource) => resource,
            runtime: {
              identity: { workspaceId: 'test', runtimeId: 'local', generation: 'test' },
              capabilities: new Set(),
              status: 'ready',
              onDidChangeStatus: () => ({ dispose: () => {} }),
              dispose: () => {},
              environment: { pathClass: 'posix' } as never,
              path: {
                separator: '/',
                delimiter: ':',
                isAbsolute: () => true,
                join: (...paths: readonly string[]) => join(...paths),
                relative: (from: string, to: string) => to.replace(`${from}/`, ''),
                resolve: (...paths: readonly string[]) => join(...paths),
                basename: (path: string) => basename(path),
                dirname: (path: string) => dirname(path),
              },
              workspace: { mapRoots: (roots) => roots },
            },
            dispose: () => {},
          }),
        });
        reg.defineInstance(ITelemetryService, recordingTelemetry([]));
        reg.defineInstance(ILogService, logService);
        reg.definePartialInstance(IGitService, {
          findWorkTree: (cwd: string) => findGitWorkTree(hostFs, cwd),
        });
        reg.define(IBashParserService, BashParserService);
        reg.define(IAgentPermissionPolicyService, AgentPermissionPolicyService);
      },
      strict: true,
    });
  });

  afterEach(async () => {
    disposables.dispose();
    await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function evaluate(
    input: PolicyContextInput,
  ): Promise<PermissionPolicyEvaluation | undefined> {
    const svc = ix.get(IAgentPermissionPolicyService);
    return svc.evaluate(policyContext(input));
  }

  it('still asks for Bash inside a git cwd in manual mode', async () => {
    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'printf first', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'fallback-ask',
      result: { kind: 'ask' },
    });
  });

  it('approves Write to a path inside the git cwd', async () => {
    await expect(evaluate({
      toolName: 'Write',
      args: { path: 'src/a.ts', content: 'x' },
      accesses: ToolAccesses.writeFile(join(workspaceDir, 'src/a.ts')),
    })).resolves.toMatchObject({
      policyName: 'git-cwd-write-approve',
      result: { kind: 'approve' },
    });
  });

  it('approves Edit on an additionalDir path in manual mode', async () => {
    const extraDir = await mkdtemp(join(tmpdir(), 'kimi-permission-extra-'));
    cleanupDirs.push(extraDir);
    workspace.addAdditionalDir(extraDir);
    await expect(evaluate({
      toolName: 'Edit',
      args: { path: join(extraDir, 'src/a.ts'), old_string: 'A', new_string: 'B' },
      accesses: ToolAccesses.readWriteFile(join(extraDir, 'src/a.ts')),
    })).resolves.toMatchObject({
      policyName: 'git-cwd-write-approve',
      result: { kind: 'approve' },
    });
  });

  it('asks for paths outside cwd and additionalDirs', async () => {
    const extraDir = await mkdtemp(join(tmpdir(), 'kimi-permission-extra-'));
    cleanupDirs.push(extraDir);
    workspace.addAdditionalDir(extraDir);
    const outsidePath = join(`${extraDir}-evil`, 'outside.ts');
    await expect(evaluate({
      toolName: 'Write',
      args: { path: outsidePath, content: 'x' },
      accesses: ToolAccesses.writeFile(outsidePath),
    })).resolves.toMatchObject({
      policyName: 'fallback-ask',
      result: { kind: 'ask' },
    });
  });

  it('asks for git control files before git-cwd approval', async () => {
    await expect(evaluate({
      toolName: 'Write',
      args: { path: '.git/config', content: 'x' },
      accesses: ToolAccesses.writeFile(join(workspaceDir, '.git/config')),
    })).resolves.toMatchObject({
      policyName: 'git-control-path-access-ask',
      result: { kind: 'ask' },
    });
  });

  it('asks for sensitive files before git-cwd approval', async () => {
    await expect(evaluate({
      toolName: 'Write',
      args: { path: '.env', content: 'SECRET=1' },
      accesses: ToolAccesses.writeFile(join(workspaceDir, '.env')),
    })).resolves.toMatchObject({
      policyName: 'sensitive-file-access-ask',
      result: { kind: 'ask' },
    });
  });

  it('does not use git-cwd approval in auto mode', async () => {
    mode = 'auto';
    await expect(evaluate({
      toolName: 'Write',
      args: { path: 'src/a.ts', content: 'x' },
      accesses: ToolAccesses.writeFile(join(workspaceDir, 'src/a.ts')),
    })).resolves.toMatchObject({
      policyName: 'auto-mode-approve',
      result: { kind: 'approve' },
    });
  });

  it('does not approve Write when execution has no write file access', async () => {
    await expect(evaluate({
      toolName: 'Write',
      args: { path: 'src/a.ts', content: 'x' },
      accesses: ToolAccesses.none(),
    })).resolves.toMatchObject({
      policyName: 'fallback-ask',
      result: { kind: 'ask' },
    });
  });

  it('does not approve when any write access is outside the cwd', async () => {
    await expect(evaluate({
      toolName: 'Write',
      args: { path: 'src/a.ts', content: 'x' },
      accesses: [
        { kind: 'file', operation: 'write', path: join(workspaceDir, 'src/a.ts') },
        { kind: 'file', operation: 'write', path: join(tmpdir(), 'outside.ts') },
      ],
    })).resolves.toMatchObject({
      policyName: 'fallback-ask',
      result: { kind: 'ask' },
    });
  });
});

interface MutablePermissionRulesStubOptions {
  readonly rules?: () => readonly PermissionRule[];
  readonly sessionApprovalRulePatterns?: () => readonly string[];
}

function permissionRulesStub(
  options: MutablePermissionRulesStubOptions = {},
): Partial<PermissionRulesServiceContract> {
  const rules = options.rules ?? (() => []);
  const sessionApprovalRulePatterns = options.sessionApprovalRulePatterns ?? (() => []);
  return {
    get rules() {
      return rules();
    },
    get sessionApprovalRulePatterns() {
      return sessionApprovalRulePatterns();
    },
    addRules: () => {},
    recordApprovalResult: () => {},
  };
}

interface PolicyContextInput {
  readonly id?: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly accesses?: ToolAccessList;
}

function policyContext(input: PolicyContextInput): ResolvedToolExecutionHookContext {
  const toolCall = toolCallFor(input.id ?? `call_${input.toolName}`, input.toolName, input.args);
  const subject = ruleSubject(input.toolName, input.args);
  return {
    turnId: 0,
    signal,
    toolCall,
    toolCalls: [toolCall],
    args: input.args,
    execution: {
      description: description(input.toolName),
      display: display(input.toolName, input.args),
      accesses: input.accesses ?? accesses(input.toolName, input.args),
      approvalRule:
        subject === undefined ? input.toolName : literalRulePattern(input.toolName, subject),
      matchesRule:
        subject === undefined
          ? undefined
          : (ruleArgs) => matchesRuleSubject(input.toolName, ruleArgs, subject),
      execute: async () => ({ output: '' }),
    },
  };
}

function toolCallFor(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return {
    type: 'function',
    id,
    name,
    arguments: JSON.stringify(args),
  };
}

function ruleSubject(toolName: string, args: Record<string, unknown>): string | undefined {
  switch (toolName) {
    case 'Bash':
      return stringArg(args, 'command');
    case 'Read':
    case 'ReadMediaFile':
    case 'Write':
    case 'Edit':
      return stringArg(args, 'path');
    case 'Grep':
    case 'Glob':
      return stringArg(args, 'pattern');
    default:
      return undefined;
  }
}

function matchesRuleSubject(toolName: string, ruleArgs: string, subject: string): boolean {
  switch (toolName) {
    case 'Read':
    case 'ReadMediaFile':
    case 'Write':
    case 'Edit':
      return matchesPathRuleSubject(ruleArgs, subject, { cwd: '/workspace', pathClass: 'posix' });
    default:
      return matchesGlobRuleSubject(ruleArgs, subject);
  }
}

function description(toolName: string): string {
  switch (toolName) {
    case 'Bash':
      return 'run command';
    case 'Write':
      return 'write file';
    case 'Edit':
      return 'edit file';
    default:
      return `Approve ${toolName}`;
  }
}

function display(toolName: string, args: Record<string, unknown>): ToolInputDisplay {
  const path = stringArg(args, 'path', '/workspace/file.txt');
  switch (toolName) {
    case 'Bash':
      return { kind: 'command', command: stringArg(args, 'command') };
    case 'Read':
    case 'ReadMediaFile':
      return { kind: 'file_io', operation: 'read', path };
    case 'Write':
      return { kind: 'file_io', operation: 'write', path };
    case 'Edit':
      return { kind: 'file_io', operation: 'edit', path };
    default:
      return { kind: 'generic', summary: `Approve ${toolName}`, detail: args };
  }
}

function accesses(toolName: string, args: Record<string, unknown>): ToolAccessList {
  const path = stringArg(args, 'path');
  switch (toolName) {
    case 'Read':
    case 'ReadMediaFile':
      return path.length > 0 ? ToolAccesses.readFile(path) : ToolAccesses.none();
    case 'Write':
      return path.length > 0 ? ToolAccesses.writeFile(path) : ToolAccesses.none();
    case 'Edit':
      return path.length > 0 ? ToolAccesses.readWriteFile(path) : ToolAccesses.none();
    case 'Grep':
    case 'Glob':
      return path.length > 0 ? ToolAccesses.searchTree(path) : ToolAccesses.none();
    default:
      return ToolAccesses.none();
  }
}

function stringArg(
  args: Record<string, unknown>,
  key: string,
  fallback = '',
): string {
  const value = args[key];
  return typeof value === 'string' ? value : fallback;
}

function workspaceStub(initialWorkDir: string): {
  readonly stub: ISessionWorkspaceContext;
  addAdditionalDir(dir: string): void;
} {
  let additionalDirs: string[] = [];
  const stub: ISessionWorkspaceContext = {
    _serviceBrand: undefined,
    workDir: initialWorkDir,
    get additionalDirs() {
      return additionalDirs;
    },
    resolve: (path) => path,
    isWithin: () => true,
    assertAllowed: (path) => path,
  };
  return {
    stub,
    addAdditionalDir: (dir) => {
      if (!additionalDirs.includes(dir)) additionalDirs = [...additionalDirs, dir];
    },
  };
}

function kaosStub(pathClass: HostEnvironmentService['pathClass'] = 'posix'): HostEnvironmentService {
  return {
    _serviceBrand: undefined,
    osKind: 'Linux',
    osArch: 'x86_64',
    osVersion: 'test',
    shellName: 'bash',
    shellPath: '/bin/bash',
    pathClass,
    homeDir: '/home/test',
    ready: Promise.resolve(),
  };
}

interface FakeHostFsOptions {
  readonly pathClass?: 'posix' | 'win32';
}

export function createFakeHostFs(
  existingDirectories: readonly string[] = [],
  options: FakeHostFsOptions = {},
): FakeHostFs {
  return new FakeHostFs(existingDirectories, options);
}

export class FakeHostFs implements IHostFileSystem {
  declare readonly _serviceBrand: undefined;
  private readonly pathClass: 'posix' | 'win32';
  private readonly directories = new Set<string>();
  private readonly links = new Map<string, string>();
  private realpathImpl: ((path: string) => Promise<string>) | undefined;
  private statImpl: ((path: string) => Promise<{ isFile: boolean; isDirectory: boolean; size: number }>) | undefined;

  constructor(existingDirectories: readonly string[] = [], options: FakeHostFsOptions = {}) {
    this.pathClass = options.pathClass ?? 'posix';
    for (const dir of existingDirectories) this.directories.add(this.normalize(dir));
  }

  get paths(): readonly string[] {
    return [...this.directories];
  }

  addDirectory(path: string): void {
    this.directories.add(this.normalize(path));
  }

  addLink(linkPath: string, target: string): void {
    this.links.set(this.normalize(linkPath), this.normalize(target));
  }

  failRealpath(error: Error): void {
    this.realpathImpl = () => Promise.reject(error);
  }

  failStat(error: Error): void {
    this.statImpl = async () => {
      throw error;
    };
  }

  private normalize(path: string): string {
    const impl = this.pathClass === 'win32' ? nodePath.win32 : nodePath.posix;
    const normalized = impl.normalize(path);
    return this.pathClass === 'win32' ? normalized.replaceAll('\\', '/') : normalized;
  }

  async realpath(path: string): Promise<string> {
    if (this.realpathImpl !== undefined) return this.realpathImpl(path);
    const normalized = this.normalize(path);
    if (this.isRoot(normalized)) return normalized;
    let current = normalized;
    const seen = new Set<string>();
    while (this.links.has(current)) {
      if (seen.has(current)) throw new HostFsError('os.fs.unknown', `symlink loop at ${current}`);
      seen.add(current);
      current = this.links.get(current)!;
    }
    if (this.isRoot(current) || this.directories.has(current)) return current;
    throw new HostFsError('os.fs.not_found', `realpath failed: path does not exist (${path})`);
  }

  private isRoot(path: string): boolean {
    if (path === '/') return true;
    return this.pathClass === 'win32' && /^[A-Za-z]:\/?$/.test(path);
  }

  async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
    if (this.statImpl !== undefined) return this.statImpl(path);
    const normalized = this.normalize(path);
    if (this.directories.has(normalized)) return { isFile: false, isDirectory: true, size: 0 };
    throw new HostFsError('os.fs.not_found', `stat failed: path does not exist (${path})`);
  }

  async readText(): Promise<string> {
    throw new HostFsError('os.fs.not_found', 'not implemented');
  }

  async writeText(): Promise<void> {
    throw new HostFsError('os.fs.permission_denied', 'not implemented');
  }

  async appendText(): Promise<void> {
    throw new HostFsError('os.fs.permission_denied', 'not implemented');
  }

  async readBytes(): Promise<Uint8Array> {
    throw new HostFsError('os.fs.not_found', 'not implemented');
  }

  async writeBytes(): Promise<void> {
    throw new HostFsError('os.fs.permission_denied', 'not implemented');
  }

  async *readLines(): AsyncGenerator<string> {}

  async createExclusive(): Promise<boolean> {
    throw new HostFsError('os.fs.permission_denied', 'not implemented');
  }

  async lstat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
    const normalized = this.normalize(path);
    if (this.links.has(normalized)) return { isFile: false, isDirectory: false, size: 0 };
    return this.stat(path);
  }

  async readdir(): Promise<readonly { name: string; isFile: boolean; isDirectory: boolean }[]> {
    return [];
  }

  async mkdir(path: string): Promise<void> {
    this.directories.add(this.normalize(path));
  }

  async remove(path: string): Promise<void> {
    this.directories.delete(this.normalize(path));
  }
}

interface RuntimeStubOptions {
  readonly fakeFs: FakeHostFs;
  readonly capabilities?: readonly RuntimeCapability[];
  readonly pathClass?: 'posix' | 'win32';
  readonly environment?: Partial<HostEnvironmentService>;
  readonly useRealFs?: boolean;
  readonly failAcquire?: Error;
}

function createRuntimeStub(options: RuntimeStubOptions): {
  readonly service: IAgentRuntimeService;
  capabilities: Set<RuntimeCapability>;
  acquireCount: number;
  disposeCount: number;
  failAcquire: Error | undefined;
} {
  const impl = (options.pathClass ?? 'posix') === 'win32' ? nodePath.win32 : nodePath.posix;
  const state = {
    capabilities: new Set<RuntimeCapability>(options.capabilities ?? ['fs']),
    acquireCount: 0,
    disposeCount: 0,
    failAcquire: options.failAcquire,
  };
  const path = {
    separator: impl.sep,
    delimiter: impl.delimiter,
    isAbsolute: (path: string) => impl.isAbsolute(path),
    join: (...paths: readonly string[]) => impl.join(...paths),
    relative: (from: string, to: string) => impl.relative(from, to),
    resolve: (...paths: readonly string[]) => impl.resolve(...paths),
    basename: (path: string) => impl.basename(path),
    dirname: (path: string) => impl.dirname(path),
  };
  const environment = {
    osKind: 'Linux',
    osArch: 'x86_64',
    osVersion: 'test',
    shellName: 'bash',
    shellPath: '/bin/bash',
    pathClass: options.pathClass ?? 'posix',
    homeDir: '/home/test',
    ready: Promise.resolve(),
    ...options.environment,
  };
  const makeRuntime = (): Runtime => ({
    identity: { workspaceId: 'test', runtimeId: 'local', generation: 'test' },
    capabilities: state.capabilities,
    status: 'ready',
    onDidChangeStatus: () => ({ dispose: () => {} }),
    dispose: () => {},
    environment: environment as never,
    path: path as never,
    workspace: { mapRoots: (roots: unknown) => roots } as never,
    fs: options.useRealFs ? hostFs : options.fakeFs,
  });
  const makeLease = (required: readonly RuntimeCapability[]): RuntimeLease => {
    if (state.failAcquire !== undefined) throw state.failAcquire;
    const counted = required.includes('fs');
    if (counted) state.acquireCount += 1;
    return {
      track: (resource) => resource,
      runtime: makeRuntime(),
      dispose: () => {
        if (counted) state.disposeCount += 1;
      },
    };
  };
  const service: IAgentRuntimeService = {
    _serviceBrand: undefined,
    onDidChange: () => ({ dispose: () => {} }),
    isAvailable: (required: readonly RuntimeCapability[] = []) =>
      required.every((capability) => state.capabilities.has(capability)),
    inspect: () => makeRuntime(),
    acquire: (required: readonly RuntimeCapability[] = []) => makeLease(required),
  };
  return {
    service,
    get capabilities() {
      return state.capabilities;
    },
    set capabilities(value: Set<RuntimeCapability>) {
      state.capabilities = value;
    },
    get acquireCount() {
      return state.acquireCount;
    },
    get disposeCount() {
      return state.disposeCount;
    },
    get failAcquire() {
      return state.failAcquire;
    },
    set failAcquire(value: Error | undefined) {
      state.failAcquire = value;
    },
  };
}
