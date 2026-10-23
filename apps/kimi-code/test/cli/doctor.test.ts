import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ILogService } from '@moonshot-ai/agent-core-v2/_base/log/log';
import type { IAgentProfileRegistry } from '@moonshot-ai/agent-core-v2/app/agentProfileCatalog/agentProfileRegistry';
import type { IBootstrapService } from '@moonshot-ai/agent-core-v2/app/bootstrap/bootstrap';
import type { IConfigService } from '@moonshot-ai/agent-core-v2/app/config/config';
import type {
  ProjectLocalConfigDiagnostic,
  ProjectLocalConfigLoad,
} from '@moonshot-ai/agent-core-v2/app/projectLocalConfig/projectLocalConfigReader';
import type { IWorkspaceSkillCatalog } from '@moonshot-ai/agent-core-v2/features/skill/workspace/workspaceSkillCatalog';
import { HostFileSystem } from '@moonshot-ai/agent-core-v2/os/backends/node-local/hostFsService';
import { ErrorCodes } from '@moonshot-ai/agent-core-v2/errors';
import { FileProjectLocalConfigService } from '@moonshot-ai/agent-core-v2/persistence/backends/node-fs/projectLocalConfigService';
import type { IWorkspaceAgentProfileLoader } from '@moonshot-ai/agent-core-v2/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoader';
import type { IWorkspaceContext } from '@moonshot-ai/agent-core-v2/workspace/workspaceContext/workspaceContext';
import type { IWorkspaceInstructionsService } from '@moonshot-ai/agent-core-v2/workspace/workspaceInstructions/workspaceInstructions';
import { WorkspaceTrustDisclosureService } from '@moonshot-ai/agent-core-v2/workspace/workspaceTrust/trustDisclosureService';
import type { IWorkspaceTrust } from '@moonshot-ai/agent-core-v2/workspace/workspaceTrust/workspaceTrust';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handleDoctor,
  registerDoctorCommand,
  type DoctorDeps,
} from '#/cli/sub/doctor';

let dir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `kimi-doctor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

function makeDeps(overrides: Partial<DoctorDeps> = {}): {
  deps: DoctorDeps;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  return {
    deps: {
      cwd: () => dir,
      defaultConfigPath: () => join(dir, 'config.toml'),
      defaultTuiConfigPath: () => join(dir, 'tui.toml'),
      stdout: { write: (chunk) => stdout.push(chunk) > 0 },
      stderr: { write: (chunk) => stderr.push(chunk) > 0 },
      exit: (code) => {
        exitCodes.push(code);
        throw new Error(`exit ${String(code)}`);
      },
      ...overrides,
    },
    stdout,
    stderr,
    exitCodes,
  };
}

function makeLoad(
  diagnostics: readonly ProjectLocalConfigDiagnostic[] = [],
  source: 'absent' | 'present' = 'present',
): ProjectLocalConfigLoad {
  return {
    projectRoot: dir,
    configPath: join(dir, '.kimi-code', 'local.toml'),
    additionalDirs: [],
    diagnostics,
    source,
  };
}

function tomlPath(path: string): string {
  return path.replaceAll('\\', '/');
}

async function writeLocalConfig(text: string): Promise<string> {
  const configDir = join(dir, '.kimi-code');
  await mkdir(configDir, { recursive: true });
  const path = join(configDir, 'local.toml');
  await writeFile(path, text, 'utf-8');
  return path;
}

function throwingStub<T>(label: string): T {
  return new Proxy(
    {},
    {
      get() {
        throw new Error(`${label} is not stubbed`);
      },
    },
  ) as T;
}

async function writeValidConfig(path = join(dir, 'config.toml')): Promise<void> {
  await writeFile(
    path,
    `
[providers.kimi]
type = "kimi"
base_url = "https://api.example.com/v1"
api_key = "YOUR_API_KEY"

[models.kimi]
provider = "kimi"
model = "kimi"
max_context_size = 262144
`,
    'utf-8',
  );
}

async function writeValidTuiConfig(path = join(dir, 'tui.toml')): Promise<void> {
  await writeFile(
    path,
    `
theme = "dark"

[editor]
command = "code --wait"

[notifications]
enabled = true
notification_condition = "unfocused"

[upgrade]
auto_install = true
`,
    'utf-8',
  );
}

describe('kimi doctor', () => {
  it('skips missing default config files without failing', async () => {
    const { deps, stdout, stderr } = makeDeps();

    const code = await handleDoctor(deps, {});

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const out = stdout.join('');
    expect(out).toContain('SKIP config.toml');
    expect(out).toContain('SKIP tui.toml');
    expect(out).toContain('built-in defaults will apply');
  });

  it('keeps v2 validation for a valid config', async () => {
    const configPath = join(dir, 'config.toml');
    await writeFile(
      configPath,
      `
default_model = "kimi"

[providers.kimi]
type = "kimi"
base_url = "https://api.example.com/v1"
api_key = "YOUR_API_KEY"

[models.kimi]
provider = "kimi"
model = "kimi"
protocol = "openai"
max_context_size = 262144
`,
      'utf-8',
    );
    const { deps, stdout, stderr } = makeDeps();

    const code = await handleDoctor(deps, { target: 'config' });

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    expect(stdout.join('')).toContain(`OK config.toml  ${configPath}`);
  });

  it('reports schema-invalid sections', async () => {
    await writeFile(
      join(dir, 'config.toml'),
      `
[models.kimi]
provider = "kimi"
model = "kimi"
max_context_size = "large"
`,
      'utf-8',
    );
    const { deps, stderr } = makeDeps();

    const code = await handleDoctor(deps, { target: 'config' });

    expect(code).toBe(1);
    const err = stderr.join('');
    expect(err).toContain('Validation issues:');
    expect(err).toContain('models.kimi.max_context_size:');
  });

  it('checks only config.toml when the config target is selected', async () => {
    const { deps, stdout, stderr } = makeDeps();

    const code = await handleDoctor(deps, { target: 'config' });

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const out = stdout.join('');
    expect(out).toContain('SKIP config.toml');
    expect(out).not.toContain('tui.toml');
  });

  it('checks only tui.toml when the tui target is selected', async () => {
    const { deps, stdout, stderr } = makeDeps();

    const code = await handleDoctor(deps, { target: 'tui' });

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const out = stdout.join('');
    expect(out).toContain('SKIP tui.toml');
    expect(out).not.toContain('config.toml');
  });

  it('treats a missing explicit target path as an error', async () => {
    const { deps, stdout, stderr } = makeDeps();

    const code = await handleDoctor(deps, { target: 'config', path: './missing.toml' });

    expect(code).toBe(1);
    expect(stdout.join('')).toBe('');
    const err = stderr.join('');
    expect(err).toContain('Kimi doctor found 1 issue.');
    expect(err).toContain(`ERROR config.toml  ${resolve(dir, 'missing.toml')}`);
    expect(err).toContain('File does not exist.');
    expect(err).not.toContain('tui.toml');
  });

  it('checks a valid explicit config path routed through commander', async () => {
    const configPath = join(dir, 'candidate-config.toml');
    await writeValidConfig(configPath);
    const { deps, stdout, stderr, exitCodes } = makeDeps();
    const program = new Command('kimi');
    registerDoctorCommand(program, deps);

    await program.parseAsync(['node', 'kimi', 'doctor', 'config', './candidate-config.toml']);

    expect(exitCodes).toEqual([]);
    expect(stderr.join('')).toBe('');
    const out = stdout.join('');
    expect(out).toContain(`OK config.toml  ${configPath}`);
    expect(out).not.toContain('tui.toml');
    expect(out).toContain('All checked config files are valid.');
  });

  it('does not resolve the default config path when an explicit config path is provided', async () => {
    const configPath = join(dir, 'candidate-config.toml');
    await writeValidConfig(configPath);
    const { deps, stdout, stderr } = makeDeps();

    const code = await handleDoctor(
      {
        ...deps,
        defaultConfigPath: () => {
          throw new Error('default config path should not be resolved');
        },
      },
      { target: 'config', path: './candidate-config.toml' },
    );

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    expect(stdout.join('')).toContain(`OK config.toml  ${configPath}`);
  });

  it('checks a valid explicit tui path routed through commander', async () => {
    const tuiConfigPath = join(dir, 'candidate-tui.toml');
    await writeValidTuiConfig(tuiConfigPath);
    const { deps, stdout, stderr, exitCodes } = makeDeps();
    const program = new Command('kimi');
    registerDoctorCommand(program, deps);

    await program.parseAsync(['node', 'kimi', 'doctor', 'tui', './candidate-tui.toml']);

    expect(exitCodes).toEqual([]);
    expect(stderr.join('')).toBe('');
    const out = stdout.join('');
    expect(out).toContain(`OK tui.toml     ${tuiConfigPath}`);
    expect(out).not.toContain('config.toml');
    expect(out).toContain('All checked config files are valid.');
  });

  it('aggregates config.toml and tui.toml parse errors', async () => {
    await writeFile(
      join(dir, 'config.toml'),
      `
[providers.kimi]
type = "kimi"

[models.kimi]
provider = "kimi"
model = "kimi"
max_context_size = 0
`,
      'utf-8',
    );
    await writeFile(join(dir, 'tui.toml'), 'editor = 123\n', 'utf-8');
    const { deps, stdout, stderr } = makeDeps();

    const code = await handleDoctor(deps, {});

    expect(code).toBe(1);
    expect(stdout.join('')).toBe('');
    const err = stderr.join('');
    expect(err).toContain('Kimi doctor found 2 issues.');
    expect(err).toContain(`ERROR config.toml  ${join(dir, 'config.toml')}`);
    expect(err).toContain('max_context_size');
    expect(err).toContain(`ERROR tui.toml     ${join(dir, 'tui.toml')}`);
    expect(err).toContain('editor');
  });

  it('formats Zod validation issues with field paths for tui.toml', async () => {
    await writeFile(
      join(dir, 'tui.toml'),
      `
editor = 123

[notifications]
enabled = "yes"
`,
      'utf-8',
    );
    const { deps, stderr } = makeDeps();

    const code = await handleDoctor(deps, { target: 'tui' });

    expect(code).toBe(1);
    const err = stderr.join('');
    expect(err).toContain('Validation issues:');
    expect(err).toContain('editor:');
    expect(err).toContain('notifications.enabled:');
  });

  it('formats wrapped Zod validation issues with TOML-style field paths for config.toml', async () => {
    await writeFile(
      join(dir, 'config.toml'),
      `
[providers.kimi]
type = "kimi"

[models.kimi]
provider = "kimi"
model = "kimi"
max_context_size = "large"
`,
      'utf-8',
    );
    const { deps, stderr } = makeDeps();

    const code = await handleDoctor(deps, { target: 'config' });

    expect(code).toBe(1);
    const err = stderr.join('');
    expect(err).toContain('Validation issues:');
    expect(err).toContain('models.kimi.max_context_size:');
  });

  it('skips local.toml when the project-local config file does not exist', async () => {
    const { deps, stdout, stderr } = makeDeps({
      readProjectLocalConfig: async () => makeLoad([], 'absent'),
    });

    const code = await handleDoctor(deps, {});

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const out = stdout.join('');
    expect(out).toContain('SKIP local.toml');
    expect(out).toContain('File does not exist; no project-local directories are configured.');
  });

  it('trusts the load over a second existence check', async () => {
    await writeLocalConfig('[workspace]\nadditional_dir = []\n');
    const { deps, stdout } = makeDeps({
      readProjectLocalConfig: async () => makeLoad([], 'absent'),
    });

    const code = await handleDoctor(deps, {});

    expect(code).toBe(0);
    expect(stdout.join('')).toContain('SKIP local.toml');
  });

  it('reports an error instead of dying when the project-local reader rejects', async () => {
    const { deps, stdout, stderr } = makeDeps({
      readProjectLocalConfig: async () => {
        throw new Error('reader exploded');
      },
    });

    const code = await handleDoctor(deps, {});

    expect(code).toBe(1);
    expect(stdout.join('')).toBe('');
    const err = stderr.join('');
    expect(err).toContain('ERROR local.toml');
    expect(err).toContain('reader exploded');
  });

  it('reports unavailable project-local directories without failing', async () => {
    const missingA = join(dir, 'missing-a');
    const missingB = join(dir, 'missing-b');
    await writeLocalConfig(`[workspace]\nadditional_dir = ["${tomlPath(missingA)}"]\n`);
    const { deps, stdout, stderr } = makeDeps({
      readProjectLocalConfig: async () =>
        makeLoad([
          {
            scope: 'entry',
            index: 0,
            entry: missingA,
            category: 'missing',
            dir: missingA,
            code: ErrorCodes.ADDITIONAL_DIR_UNAVAILABLE,
            message: 'missing',
          },
          {
            scope: 'entry',
            index: 1,
            entry: missingB,
            category: 'not_directory',
            dir: missingB,
            code: ErrorCodes.ADDITIONAL_DIR_UNAVAILABLE,
            message: 'not_directory',
          },
        ]),
    });

    const code = await handleDoctor(deps, {});

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const out = stdout.join('');
    expect(out).toContain('OK local.toml');
    expect(out).toContain(`${missingA} → missing`);
    expect(out).toContain(`${missingB} → not_directory`);
  });

  it('fails on an invalid local.toml document', async () => {
    await writeLocalConfig('[workspace\n');
    const { deps, stdout, stderr } = makeDeps({
      readProjectLocalConfig: async () =>
        makeLoad([
          {
            scope: 'file',
            category: 'toml_invalid',
            code: ErrorCodes.STORAGE_DECODE_FAILED,
            message: 'Invalid TOML in local.toml',
          },
        ]),
    });

    const code = await handleDoctor(deps, {});

    expect(code).toBe(1);
    expect(stdout.join('')).toBe('');
    const err = stderr.join('');
    expect(err).toContain('ERROR local.toml');
    expect(err).toContain('Invalid TOML in local.toml');
  });

  it('fails on an empty workspace.additional_dir entry', async () => {
    await writeLocalConfig('[workspace]\nadditional_dir = [""]\n');
    const { deps, stdout, stderr } = makeDeps({
      readProjectLocalConfig: async () =>
        makeLoad([
          {
            scope: 'entry',
            index: 0,
            entry: '',
            category: 'empty',
            code: ErrorCodes.CONFIG_INVALID,
            message: 'workspace.additional_dir contains an empty entry',
          },
        ]),
    });

    const code = await handleDoctor(deps, {});

    expect(code).toBe(1);
    expect(stdout.join('')).toBe('');
    const err = stderr.join('');
    expect(err).toContain('ERROR local.toml');
    expect(err).toContain('<empty> → empty');
  });

  it('does not check local.toml when the config target is selected', async () => {
    const readProjectLocalConfig = vi.fn(async () => makeLoad());
    const { deps, stdout } = makeDeps({ readProjectLocalConfig });

    const code = await handleDoctor(deps, { target: 'config' });

    expect(code).toBe(0);
    expect(readProjectLocalConfig).not.toHaveBeenCalled();
    expect(stdout.join('')).not.toContain('local.toml');
  });

  it('reads a real project-local config through the default reader', async () => {
    const missingA = join(dir, 'missing-a');
    const missingB = join(dir, 'missing-b');
    const localConfigPath = await writeLocalConfig(
      `[workspace]\nadditional_dir = ["${tomlPath(missingA)}", "${tomlPath(missingB)}"]\n`,
    );
    const { deps, stdout, stderr } = makeDeps();

    const code = await handleDoctor(deps, {});

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const out = stdout.join('');
    expect(out).toContain(`OK local.toml   ${tomlPath(localConfigPath)}`);
    expect(out).toContain(`${tomlPath(missingA)} → missing`);
    expect(out).toContain(`${tomlPath(missingB)} → missing`);

    await writeFile(localConfigPath, '[workspace\n', 'utf-8');
    const second = makeDeps();

    const secondCode = await handleDoctor(second.deps, {});

    expect(secondCode).toBe(1);
    expect(second.stderr.join('')).toContain('ERROR local.toml');
  });

  it('agrees with the trust disclosure on an invalid project-local config', async () => {
    await writeLocalConfig('[workspace\n');
    const hostFs = new HostFileSystem();
    const bootstrap = {
      osHomeDir: homedir(),
      homeDir: homedir(),
      args: { skillDirs: [] },
    };
    const localConfig = new FileProjectLocalConfigService(
      bootstrap as unknown as IBootstrapService,
      hostFs,
    );
    const load = await localConfig.readAdditionalDirs(dir);
    expect(load.diagnostics.map((diagnostic) => diagnostic.scope)).toEqual(['file']);

    const disclosure = new WorkspaceTrustDisclosureService(
      { cwd: dir } as unknown as IWorkspaceContext,
      hostFs,
      bootstrap as unknown as IBootstrapService,
      { get: () => true } as unknown as IConfigService,
      localConfig,
      { ready: Promise.resolve(), isTrusted: () => false } as unknown as IWorkspaceTrust,
      throwingStub<IWorkspaceSkillCatalog>('workspace skill catalog'),
      throwingStub<IWorkspaceAgentProfileLoader>('workspace agent profile loader'),
      throwingStub<IAgentProfileRegistry>('agent profile registry'),
      throwingStub<IWorkspaceInstructionsService>('workspace instructions service'),
      { warn: () => {} } as unknown as ILogService,
    );

    const activation = await disclosure.describeGatedActivation();

    const uninspectable = activation.warnings.filter(
      (warning) => warning === 'Could not inspect additional directory configuration.',
    );
    expect(uninspectable).toHaveLength(1);
    expect(activation.additionalDirs).toEqual([]);

    const { deps, stdout, stderr } = makeDeps();

    const code = await handleDoctor(deps, {});

    expect(code).toBe(1);
    expect(stdout.join('')).toBe('');
    expect(stderr.join('')).toContain('ERROR local.toml');
    expect(stderr.join('')).toContain(`Invalid TOML in ${load.configPath}`);
  });
});

describe('kimi doctor (default v2 config validation)', () => {
  afterEach(() => {
    delete process.env['KIMI_LOOP_MAX_RETRIES_PER_STEP'];
    delete process.env['KIMI_LOOP_MAX_ATTEMPTS_PER_STEP'];
  });

  it('accepts a config valid for the v2 engine, including schema-less keys', async () => {
    await writeFile(
      join(dir, 'config.toml'),
      `
default_model = "kimi"

[providers.kimi]
type = "kimi"
base_url = "https://api.example.com/v1"
api_key = "YOUR_API_KEY"

[models.kimi]
provider = "kimi"
model = "kimi"
max_context_size = 262144
`,
      'utf-8',
    );
    const { deps, stdout, stderr } = makeDeps();

    const code = await handleDoctor(deps, { target: 'config' });

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    expect(stdout.join('')).toContain(`OK config.toml  ${join(dir, 'config.toml')}`);
  });

  it('reports schema-invalid sections with TOML-style field paths', async () => {
    await writeFile(
      join(dir, 'config.toml'),
      `
[models.kimi]
provider = "kimi"
model = "kimi"
max_context_size = "large"
`,
      'utf-8',
    );
    const { deps, stderr } = makeDeps();

    const code = await handleDoctor(deps, { target: 'config' });

    expect(code).toBe(1);
    const err = stderr.join('');
    expect(err).toContain('Validation issues:');
    expect(err).toContain('models.kimi.max_context_size:');
  });

  it('warns about unknown top-level keys without failing', async () => {
    await writeFile(
      join(dir, 'config.toml'),
      `
[providrs.kimi]
type = "kimi"
`,
      'utf-8',
    );
    const { deps, stdout, stderr } = makeDeps();

    const code = await handleDoctor(deps, { target: 'config' });

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const out = stdout.join('');
    expect(out).toContain(`OK config.toml  ${join(dir, 'config.toml')}`);
    expect(out).toContain('Unknown top-level key ignored by the v2 engine: providrs.');
  });

  it('reports TOML syntax errors with line and column', async () => {
    await writeFile(join(dir, 'config.toml'), '[providers.kimi\ntype = "kimi"\n', 'utf-8');
    const { deps, stderr } = makeDeps();

    const code = await handleDoctor(deps, { target: 'config' });

    expect(code).toBe(1);
    const err = stderr.join('');
    expect(err).toContain('Invalid TOML in');
    expect(err).toMatch(/\(line \d+, column \d+\)/);
  });

  it('warns about deprecated config keys without failing', async () => {
    await writeFile(
      join(dir, 'config.toml'),
      `
[loop_control]
max_retries_per_step = 3
`,
      'utf-8',
    );
    const { deps, stdout, stderr } = makeDeps();

    const code = await handleDoctor(deps, { target: 'config' });

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const out = stdout.join('');
    expect(out).toContain(`OK config.toml  ${join(dir, 'config.toml')}`);
    expect(out).toContain("'max_retries_per_step' is deprecated");
    expect(out).toContain("rename it to 'max_attempts_per_step'");
  });

  it('warns about a deprecated env var that supplies a value', async () => {
    await writeFile(join(dir, 'config.toml'), '[loop_control]\n', 'utf-8');
    process.env['KIMI_LOOP_MAX_RETRIES_PER_STEP'] = '5';
    const { deps, stdout, stderr } = makeDeps();

    const code = await handleDoctor(deps, { target: 'config' });

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    expect(stdout.join('')).toContain(
      'Environment variable KIMI_LOOP_MAX_RETRIES_PER_STEP is deprecated; use KIMI_LOOP_MAX_ATTEMPTS_PER_STEP instead.',
    );
  });

  it('does not warn about the deprecated env var when the primary one is set', async () => {
    await writeFile(join(dir, 'config.toml'), '[loop_control]\n', 'utf-8');
    process.env['KIMI_LOOP_MAX_RETRIES_PER_STEP'] = '5';
    process.env['KIMI_LOOP_MAX_ATTEMPTS_PER_STEP'] = '5';
    const { deps, stdout } = makeDeps();

    const code = await handleDoctor(deps, { target: 'config' });

    expect(code).toBe(0);
    expect(stdout.join('')).not.toContain('KIMI_LOOP_MAX_RETRIES_PER_STEP');
  });
});
