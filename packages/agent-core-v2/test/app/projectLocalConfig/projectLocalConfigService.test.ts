import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'pathe';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readProjectLocalConfig,
  type ProjectLocalConfigFs,
} from '#/app/projectLocalConfig/projectLocalConfigReader';
import { rewriteAdditionalDirArray } from '#/app/projectLocalConfig/tomlArraySlice';
import { Error2, ErrorCodes } from '#/errors';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { FileProjectLocalConfigService } from '#/persistence/backends/node-fs/projectLocalConfigService';
import { stubBootstrap } from '../../app/bootstrap/stubs';

type FsHook = (...args: string[]) => boolean | undefined;

const hooks = vi.hoisted(() => ({
  rename: null as FsHook | null,
  unlink: null as FsHook | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string): Promise<void> => {
      const hook = hooks.rename;
      if (hook !== null && hook(from, to) === true) return;
      await actual.rename(from, to);
    },
    unlink: async (path: string): Promise<void> => {
      const hook = hooks.unlink;
      if (hook !== null && hook(path) === true) return;
      await actual.unlink(path);
    },
  };
});

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

function usePlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function failRenameTo(destination: string, errors: readonly Error[]): void {
  const remaining = [...errors];
  hooks.rename = (_from, to) => {
    if (to !== destination) return;
    const error = remaining.shift();
    if (error === undefined) return;
    throw error;
  };
}

afterEach(() => {
  hooks.rename = null;
  hooks.unlink = null;
  if (platformDescriptor !== undefined) {
    Object.defineProperty(process, 'platform', platformDescriptor);
  }
});

class CountingService extends FileProjectLocalConfigService {
  commits: { path: string; text: string }[] = [];
  failCommit = false;

  protected override async commit(path: string, text: string): Promise<void> {
    if (this.failCommit) throw new Error('commit failed');
    this.commits.push({ path, text });
    await super.commit(path, text);
  }
}

function withStatErrors(
  real: IHostFileSystem,
  errors: Readonly<Record<string, string>>,
): IHostFileSystem {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'stat') {
        return async (path: string) => {
          const code = errors[path];
          if (code !== undefined) throw Object.assign(new Error(code), { code });
          return target.stat(path);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function rejection(promise: Promise<unknown>): Promise<Error2> {
  try {
    await promise;
  } catch (error: unknown) {
    return error as Error2;
  }
  throw new Error('expected the call to reject');
}

describe('FileProjectLocalConfigService.appendAdditionalDir', () => {
  let root: string;
  let workDir: string;
  let configPath: string;
  let homeDir: string;
  let service: CountingService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kimi-project-local-'));
    workDir = join(root, 'work');
    homeDir = join(root, 'home');
    configPath = join(root, '.kimi-code', 'local.toml');
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(workDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    service = new CountingService(stubBootstrap(homeDir, {}, {}, homeDir), new HostFileSystem());
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeDir(name: string): string {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    return path;
  }

  function writeConfig(text: string): void {
    mkdirSync(join(root, '.kimi-code'), { recursive: true });
    writeFileSync(configPath, text, 'utf8');
  }

  function readConfig(): string {
    return readFileSync(configPath, 'utf8');
  }

  function serviceWithStatErrors(
    errors: Readonly<Record<string, string>>,
  ): CountingService {
    return new CountingService(
      stubBootstrap(homeDir, {}, {}, homeDir),
      withStatErrors(new HostFileSystem(), errors),
    );
  }

  function entriesOf(text: string): readonly string[] {
    const document = parseToml(text) as { workspace?: { additional_dir?: string[] } };
    return document.workspace?.additional_dir ?? [];
  }

  it('A1: drops entries whose stat yields ENOENT or ENOTDIR', async () => {
    const kept = makeDir('kept');
    const added = makeDir('added');
    writeConfig('[workspace]\nadditional_dir = ["kept", "gone", "blocker/child"]\n');
    service = serviceWithStatErrors({ [join(root, 'blocker/child')]: 'ENOTDIR' });

    const load = await service.appendAdditionalDir(workDir, added);

    const written = readConfig();
    expect(written).not.toContain('gone');
    expect(written).not.toContain('blocker/child');
    expect(entriesOf(written)).toEqual(['kept', added]);
    expect(load.additionalDirs).toEqual([kept, added]);
  });

  it('A2: keeps a file entry and entries whose stat yields EACCES or EPERM', async () => {
    const accepted = makeDir('accepted');
    const added = makeDir('added');
    writeFileSync(join(root, 'plain.txt'), 'x', 'utf8');
    writeConfig('[workspace]\nadditional_dir = ["accepted", "plain.txt", "denied", "forbidden"]\n');
    service = serviceWithStatErrors({
      [join(root, 'denied')]: 'EACCES',
      [join(root, 'forbidden')]: 'EPERM',
    });

    const load = await service.appendAdditionalDir(workDir, added);

    const written = readConfig();
    expect(written).toContain('plain.txt');
    expect(written).toContain('denied');
    expect(written).toContain('forbidden');
    expect(load.additionalDirs).toEqual([accepted, added]);
  });

  it('A3: appends a valid new entry as the last item', async () => {
    const existing = makeDir('existing');
    const added = makeDir('added');
    writeConfig('[workspace]\nadditional_dir = ["existing"]\n');

    const load = await service.appendAdditionalDir(workDir, added);

    const written = readConfig();
    expect(entriesOf(written)).toEqual(['existing', added]);
    expect(load.additionalDirs).toEqual([existing, added]);
    expect(load.projectRoot).toBe(root);
    expect(load.configPath).toBe(configPath);
    expect(service.commits).toHaveLength(1);
    expect(service.commits[0]?.path).toBe(configPath);
  });

  it('A4: writes nothing when the entry is already present', async () => {
    const existing = makeDir('existing');
    writeConfig('[workspace]\nadditional_dir = ["existing"]\n');
    const before = readConfig();

    const load = await service.appendAdditionalDir(workDir, existing);

    expect(service.commits).toHaveLength(0);
    expect(readConfig()).toBe(before);
    expect(load.additionalDirs).toEqual([existing]);
  });

  it('A5: rejects an entry that does not exist without writing', async () => {
    const existing = makeDir('existing');
    writeConfig('[workspace]\nadditional_dir = ["existing"]\n');
    const before = readConfig();

    const error = await rejection(service.appendAdditionalDir(workDir, join(root, 'absent')));

    expect(error.code).toBe(ErrorCodes.ADDITIONAL_DIR_UNAVAILABLE);
    expect(service.commits).toHaveLength(0);
    expect(readConfig()).toBe(before);
  });

  it('A6: rejects invalid TOML without writing', async () => {
    const added = makeDir('added');
    writeConfig('[workspace');

    const error = await rejection(service.appendAdditionalDir(workDir, added));

    expect(error.code).toBe(ErrorCodes.STORAGE_DECODE_FAILED);
    expect(service.commits).toHaveLength(0);
    expect(readConfig()).toBe('[workspace');
  });

  it('keeps an empty entry and reports it as an empty diagnostic', async () => {
    const existing = makeDir('existing');
    const added = makeDir('added');
    writeConfig('[workspace]\nadditional_dir = ["", "existing"]\n');

    const load = await service.appendAdditionalDir(workDir, added);

    expect(entriesOf(readConfig())).toEqual(['', 'existing', added]);
    expect(load.additionalDirs).toEqual([existing, added]);
    expect(load.diagnostics).toEqual([
      {
        scope: 'entry',
        index: 0,
        entry: '',
        category: 'empty',
        dir: undefined,
        code: ErrorCodes.CONFIG_INVALID,
        message: expect.any(String),
      },
    ]);
  });

  it('creates the config file with the workspace table when it is absent', async () => {
    const added = makeDir('added');

    const load = await service.appendAdditionalDir(workDir, added);

    const written = readConfig();
    expect(written).toContain('[workspace]');
    expect(entriesOf(written)).toEqual([added]);
    expect(load.additionalDirs).toEqual([added]);
  });

  it('A7: rejects an inline-table layout and leaves the bytes untouched', async () => {
    const existing = makeDir('existing');
    const added = makeDir('added');
    const before = `workspace = { additional_dir = ["${existing}"] }\n`;
    writeConfig(before);

    const error = await rejection(service.appendAdditionalDir(workDir, added));

    expect(error.code).toBe(ErrorCodes.ADDITIONAL_DIR_PERSIST_BLOCKED);
    expect(service.commits).toHaveLength(0);
    expect(readConfig()).toBe(before);

    const pure = rewriteAdditionalDirArray(before, [added]);
    expect(pure.ok).toBe(false);
    if (pure.ok) return;
    expect(error.details?.['reason']).toBe(pure.reason);
  });

  it('A8: keeps every byte outside the value range', async () => {
    const existing = makeDir('existing');
    const added = makeDir('added');
    const before = [
      '# project-local overrides',
      '[workspace]',
      `additional_dir = ["${existing}"] # keep me`,
      'other = 1',
      '',
      '[other]',
      'flag = true',
      '',
    ].join('\n');
    writeConfig(before);
    const { start, end } = valueRange(before);

    await service.appendAdditionalDir(workDir, added);

    const after = readConfig();
    expect(after.startsWith(before.slice(0, start))).toBe(true);
    expect(after.endsWith(before.slice(end + 1))).toBe(true);
    expect(entriesOf(after)).toEqual([existing, added]);
  });

  it('A9: leaves the old bytes in place when the commit fails', async () => {
    const existing = makeDir('existing');
    const added = makeDir('added');
    const before = '[workspace]\nadditional_dir = ["existing"]\n';
    writeConfig(before);
    service.failCommit = true;

    const error = await rejection(service.appendAdditionalDir(workDir, added));

    expect(error.message).toBe('commit failed');
    expect(readConfig()).toBe(before);
    expect(tempFiles(root)).toEqual([]);
  });

  it('A9: leaves no file behind when the commit fails on an absent file', async () => {
    const added = makeDir('added');
    service.failCommit = true;

    const error = await rejection(service.appendAdditionalDir(workDir, added));

    expect(error.message).toBe('commit failed');
    expect(existsSync(configPath)).toBe(false);
    expect(tempFiles(root)).toEqual([]);
  });

  it('leaves no temp file behind after a successful append', async () => {
    const existing = makeDir('existing');
    const added = makeDir('added');
    writeConfig('[workspace]\nadditional_dir = ["existing"]\n');

    await service.appendAdditionalDir(workDir, added);

    expect(entriesOf(readConfig())).toEqual(['existing', added]);
    expect(tempFiles(root)).toEqual([]);
  });

  it('reports a kept diagnostic with its file index, not its position after filtering', async () => {
    const existing = makeDir('existing');
    const added = makeDir('added');
    writeConfig('[workspace]\nadditional_dir = ["gone", "", "existing"]\n');

    const load = await service.appendAdditionalDir(workDir, added);

    expect(load.diagnostics).toEqual([
      {
        scope: 'entry',
        index: 1,
        entry: '',
        category: 'empty',
        dir: undefined,
        code: ErrorCodes.CONFIG_INVALID,
        message: expect.any(String),
      },
    ]);
  });

  it('reports a config path blocked by a file as a read failure, not as absent', async () => {
    const added = makeDir('added');
    writeFileSync(join(root, '.kimi-code'), 'not a directory', 'utf8');
    const enotdirIsVisible = process.platform !== 'win32';

    const load = await service.readAdditionalDirs(workDir);

    expect(load.source).toBe(enotdirIsVisible ? 'present' : 'absent');
    expect(load.diagnostics).toEqual(
      enotdirIsVisible
        ? [
            {
              scope: 'file',
              category: 'read_failed',
              code: ErrorCodes.STORAGE_IO_FAILED,
              message: expect.any(String),
            },
          ]
        : [],
    );

    const error = await rejection(service.appendAdditionalDir(workDir, added));

    expect(error.code).toBe(
      enotdirIsVisible ? ErrorCodes.STORAGE_IO_FAILED : 'os.fs.already_exists',
    );
  });

  it('A1 (integration): diagnoses both stale entries as missing', async () => {
    const hostFs = new HostFileSystem();
    const staleA = join(root, 'stale-a');
    const staleB = join(root, 'stale-b');
    writeConfig(fixture(staleA, staleB));

    const load = await readProjectLocalConfig(workDir, { fs: hostFs, homeDir });

    expect(load.additionalDirs).toEqual([]);
    expect(load.diagnostics).toHaveLength(2);
    expect(load.diagnostics).toMatchObject([
      { scope: 'entry', index: 0, entry: staleA, category: 'missing' },
      { scope: 'entry', index: 1, entry: staleB, category: 'missing' },
    ]);
  });

  it('A2 (integration): rewrites the stale fixture and keeps every other byte', async () => {
    const fresh = makeDir('fresh');
    const staleA = join(root, 'stale-a');
    const staleB = join(root, 'stale-b');
    const before = fixture(staleA, staleB);
    writeConfig(before);
    const { start, end } = valueRange(before);

    const load = await service.appendAdditionalDir(workDir, fresh);

    const after = readConfig();
    const entries = entriesOf(after);
    expect(after).not.toContain(staleA);
    expect(after).not.toContain(staleB);
    expect(entries.at(-1)).toBe(fresh);
    expect(after.startsWith(before.slice(0, start))).toBe(true);
    expect(after.endsWith(before.slice(end + 1))).toBe(true);
    expect(load.additionalDirs).toEqual([fresh]);
    recordEvidence([
      { title: 'fixture before', body: before },
      { title: 'fixture after', body: after },
    ]);
  });

  it('A3 (integration): the read path never writes', async () => {
    const hostFs = new HostFileSystem();
    writeConfig(fixture(join(root, 'stale-a'), join(root, 'stale-b')));
    const before = readConfig();

    await readProjectLocalConfig(workDir, { fs: hostFs, homeDir });
    await readProjectLocalConfig(workDir, { fs: hostFs, homeDir });

    expect(readConfig()).toBe(before);
    expect(tempFiles(root)).toEqual([]);
  });

  it('resolves a backslash home entry against the home dir', async () => {
    mkdirSync(join(homeDir, 'sub'), { recursive: true });

    const dirs = await service.resolveAdditionalDirs(workDir, ['~\\sub']);

    expect(dirs).toEqual([join(homeDir, 'sub')]);
  });

  it('keeps the raw home entry and appends the normalised directory', async () => {
    mkdirSync(join(homeDir, 'sub'), { recursive: true });
    const other = makeDir('other');
    writeConfig("[workspace]\nadditional_dir = ['~\\sub']\n");

    const load = await service.appendAdditionalDir(workDir, other);

    expect(entriesOf(readConfig())).toEqual(['~\\sub', other]);
    expect(load.additionalDirs).toEqual([join(homeDir, 'sub'), other]);
  });

  it('keeps the home entry readable across resolve, read and append', async () => {
    mkdirSync(join(homeDir, 'sub'), { recursive: true });
    const other = makeDir('other');
    writeConfig("[workspace]\nadditional_dir = ['~\\sub']\n");

    const resolved = await service.resolveAdditionalDirs(workDir, ['~\\sub']);
    const before = await service.readAdditionalDirs(workDir);
    await service.appendAdditionalDir(workDir, other);
    const after = await service.readAdditionalDirs(workDir);

    expect(resolved).toContain(join(homeDir, 'sub'));
    expect(before.additionalDirs).toContain(join(homeDir, 'sub'));
    expect(after.additionalDirs).toContain(join(homeDir, 'sub'));
    expect(entriesOf(readConfig())).toEqual(['~\\sub', other]);
  });

  it('reports the displaced path when the replacement and the restore both fail', async () => {
    const added = makeDir('added');
    const before = '[workspace]\nadditional_dir = ["existing"]\n';
    writeConfig(before);
    usePlatform('win32');
    const E = new Error('replacement failed');
    const R = new Error('restore failed');
    failRenameTo(configPath, [E, R]);

    const error = await rejection(service.appendAdditionalDir(workDir, added));

    const entries = readdirSync(join(root, '.kimi-code'));
    expect(entries).toHaveLength(1);
    const displacedPath = join(root, '.kimi-code', entries[0] as string);
    expect(displacedPath).not.toBe(configPath);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(displacedPath);
    expect(error.cause).toBe(E);
    expect(readFileSync(displacedPath, 'utf8')).toBe(before);
  });
});

describe('FileProjectLocalConfigService read and resolve', () => {
  let root: string;
  let workDir: string;
  let configPath: string;
  let homeDir: string;
  let service: FileProjectLocalConfigService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kimi-project-local-read-'));
    workDir = join(root, 'work');
    homeDir = join(root, 'home');
    configPath = join(root, '.kimi-code', 'local.toml');
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(workDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    service = new FileProjectLocalConfigService(
      stubBootstrap(homeDir, {}, {}, homeDir),
      new HostFileSystem(),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeDir(name: string): string {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    return path;
  }

  function writeConfig(text: string): void {
    mkdirSync(join(root, '.kimi-code'), { recursive: true });
    writeFileSync(configPath, text, 'utf8');
  }

  it('A2: rejects a path that does not exist as unavailable', async () => {
    const error = await rejection(
      service.resolveAdditionalDirs(workDir, [join(root, 'absent')]),
    );

    expect(error.code).toBe(ErrorCodes.ADDITIONAL_DIR_UNAVAILABLE);
  });

  it('A2: rejects an empty entry as invalid config', async () => {
    const error = await rejection(service.resolveAdditionalDirs(workDir, ['']));

    expect(error.code).toBe(ErrorCodes.CONFIG_INVALID);
  });

  it('A3: deep-equals the pure reader on a file with one valid and one stale entry', async () => {
    const valid = makeDir('valid');
    const stale = join(root, 'stale');
    writeConfig(`[workspace]\nadditional_dir = ["${valid}", "${stale}"]\n`);
    const hostFs = new HostFileSystem();
    const adapter: ProjectLocalConfigFs = {
      readText: (path) => hostFs.readText(path),
      stat: (path) => hostFs.stat(path),
      lstat: (path) => hostFs.lstat(path),
    };

    const expected = await readProjectLocalConfig(workDir, { fs: adapter, homeDir });

    expect(await service.readAdditionalDirs(workDir)).toEqual(expected);
  });

  it('A3: resolves on a stale-entry file and diagnoses both entries', async () => {
    writeConfig(fixture(join(root, 'stale-a'), join(root, 'stale-b')));

    const load = await service.readAdditionalDirs(workDir);

    expect(load.additionalDirs).toEqual([]);
    expect(load.diagnostics.map((diagnostic) => diagnostic.scope)).toEqual(['entry', 'entry']);
  });

  it('A3: resolves on invalid TOML with a single file diagnostic', async () => {
    writeConfig('[workspace');

    const load = await service.readAdditionalDirs(workDir);

    expect(load.additionalDirs).toEqual([]);
    expect(load.diagnostics).toHaveLength(1);
    expect(load.diagnostics[0]).toMatchObject({ scope: 'file', category: 'toml_invalid' });
  });
});

function fixture(staleA: string, staleB: string): string {
  return [
    '# hand written',
    '[workspace]',
    `additional_dir = [ "${staleA}", "${staleB}" ]`,
    '',
    '[other]',
    'x = 1',
    '',
  ].join('\n');
}

function recordEvidence(blocks: readonly { title: string; body: string }[]): void {
  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(
    EVIDENCE_PATH,
    blocks.map((block) => `=== ${block.title} ===\n${block.body}`).join('\n'),
    'utf8',
  );
}

const EVIDENCE_PATH = join(
  dirname(import.meta.filename),
  '../../../../..',
  '.tmp',
  'phase-2.8-evidence.txt',
);

function tempFiles(base: string): string[] {
  const dir = join(base, '.kimi-code');
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.includes('.tmp.')) : [];
}

function valueRange(text: string): { start: number; end: number } {
  const start = text.indexOf('[', text.indexOf('additional_dir'));
  let depth = 0;

  for (let index = start; index < text.length; index += 1) {
    const ch = text.charAt(index);
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return { start, end: index };
    }
  }

  throw new Error('no array value in the config');
}
