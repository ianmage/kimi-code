import { join, normalize, resolve } from 'pathe';
import { describe, expect, it } from 'vitest';
import { ErrorCodes, StorageErrors } from '#/errors';
import {
  findProjectRoot,
  projectLocalConfigPath,
  readProjectLocalConfig,
  readProjectLocalConfigSource,
  type ProjectLocalConfigFs,
} from '#/app/projectLocalConfig/projectLocalConfigReader';

const ROOT = '/repo';
const HOME = '/home/tester';
const CONFIG_PATH = join(ROOT, '.kimi-code', 'local.toml');

interface MemoryFsOptions {
  readonly files?: Readonly<Record<string, string>>;
  readonly dirs?: readonly string[];
  readonly readErrors?: Readonly<Record<string, unknown>>;
  readonly statErrors?: Readonly<Record<string, unknown>>;
}

function memoryFs(options: MemoryFsOptions = {}): ProjectLocalConfigFs {
  const files = new Map(
    Object.entries(options.files ?? {}).map(([path, text]) => [normalize(path), text]),
  );
  const dirs = new Set((options.dirs ?? []).map(normalize));
  const readErrors = new Map(
    Object.entries(options.readErrors ?? {}).map(([path, error]) => [normalize(path), error]),
  );
  const statErrors = new Map(
    Object.entries(options.statErrors ?? {}).map(([path, error]) => [normalize(path), error]),
  );
  const known = (path: string): boolean => files.has(path) || dirs.has(path);

  return {
    readText(path: string): Promise<string> {
      const key = normalize(path);
      const failure = readErrors.get(key);
      if (failure !== undefined) return Promise.reject(failure);
      const text = files.get(key);
      if (text === undefined) return Promise.reject({ code: 'ENOENT' });
      return Promise.resolve(text);
    },
    stat(path: string): Promise<{ readonly isDirectory: boolean }> {
      const key = normalize(path);
      const failure = statErrors.get(key);
      if (failure !== undefined) return Promise.reject(failure);
      if (!known(key)) return Promise.reject({ code: 'ENOENT' });
      return Promise.resolve({ isDirectory: dirs.has(key) });
    },
    lstat(path: string): Promise<unknown> {
      const key = normalize(path);
      if (!known(key)) return Promise.reject({ code: 'ENOENT' });
      return Promise.resolve({ isDirectory: dirs.has(key) });
    },
  };
}

function workspaceToml(entries: readonly string[]): string {
  return `[workspace]\nadditional_dir = [${entries.map((entry) => JSON.stringify(entry)).join(', ')}]\n`;
}

function readConfig(fs: ProjectLocalConfigFs): ReturnType<typeof readProjectLocalConfig> {
  return readProjectLocalConfig(ROOT, { fs, homeDir: HOME });
}

describe('readProjectLocalConfig', () => {
  it('A1: reports an absent file as an empty load', async () => {
    const load = await readConfig(memoryFs());

    expect(load.projectRoot).toBe(ROOT);
    expect(load.configPath).toBe(CONFIG_PATH);
    expect(load.additionalDirs).toEqual([]);
    expect(load.diagnostics).toEqual([]);
    expect(load.source).toBe('absent');
  });

  it('marks a present file as such', async () => {
    const fs = memoryFs({ files: { [CONFIG_PATH]: workspaceToml([]) } });

    const load = await readConfig(fs);

    expect(load.source).toBe('present');
  });

  it('A2: keeps the valid entries around a missing one and reports it by index', async () => {
    const fs = memoryFs({
      files: { [CONFIG_PATH]: workspaceToml(['A', 'B', 'C']) },
      dirs: [join(ROOT, 'A'), join(ROOT, 'C')],
    });

    const load = await readConfig(fs);

    expect(load.additionalDirs).toEqual([resolve(ROOT, 'A'), resolve(ROOT, 'C')]);
    expect(load.diagnostics).toHaveLength(1);
    expect(load.diagnostics[0]).toMatchObject({
      scope: 'entry',
      index: 1,
      entry: 'B',
      category: 'missing',
      dir: resolve(ROOT, 'B'),
    });
  });

  it('A3a: reports invalid TOML as one file diagnostic', async () => {
    const fs = memoryFs({ files: { [CONFIG_PATH]: '[workspace' } });

    await expect(readConfig(fs)).resolves.toBeDefined();
    const load = await readConfig(fs);

    expect(load.additionalDirs).toEqual([]);
    expect(load.diagnostics).toHaveLength(1);
    expect(load.diagnostics[0]).toEqual({
      scope: 'file',
      category: 'toml_invalid',
      code: StorageErrors.codes.STORAGE_DECODE_FAILED,
      message: `Invalid TOML in ${CONFIG_PATH}`,
    });
  });

  it('A3b: reports a non-string additional_dir as one file diagnostic', async () => {
    const fs = memoryFs({ files: { [CONFIG_PATH]: '[workspace]\nadditional_dir = [1]\n' } });

    await expect(readConfig(fs)).resolves.toBeDefined();
    const load = await readConfig(fs);

    expect(load.additionalDirs).toEqual([]);
    expect(load.diagnostics).toHaveLength(1);
    expect(load.diagnostics[0]).toEqual({
      scope: 'file',
      category: 'schema_invalid',
      code: ErrorCodes.CONFIG_INVALID,
      message: 'workspace.additional_dir must be an array of strings',
    });
  });

  it('A3c: reports a non-table workspace as one file diagnostic', async () => {
    const fs = memoryFs({ files: { [CONFIG_PATH]: 'workspace = 3\n' } });

    await expect(readConfig(fs)).resolves.toBeDefined();
    const load = await readConfig(fs);

    expect(load.additionalDirs).toEqual([]);
    expect(load.diagnostics).toHaveLength(1);
    expect(load.diagnostics[0]).toEqual({
      scope: 'file',
      category: 'schema_invalid',
      code: ErrorCodes.CONFIG_INVALID,
      message: 'workspace must be a table',
    });
  });

  it('A3d: reports an unreadable file as one file diagnostic', async () => {
    const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const fs = memoryFs({ readErrors: { [CONFIG_PATH]: failure } });

    await expect(readConfig(fs)).resolves.toBeDefined();
    const load = await readConfig(fs);

    expect(load.additionalDirs).toEqual([]);
    expect(load.diagnostics).toHaveLength(1);
    expect(load.diagnostics[0]).toEqual({
      scope: 'file',
      category: 'read_failed',
      code: ErrorCodes.STORAGE_IO_FAILED,
      message: 'permission denied',
    });
  });

  it('A4: collapses duplicate entries without a diagnostic', async () => {
    const fs = memoryFs({
      files: { [CONFIG_PATH]: workspaceToml(['A', 'A/']) },
      dirs: [join(ROOT, 'A')],
    });

    const load = await readConfig(fs);

    expect(load.additionalDirs).toEqual([resolve(ROOT, 'A')]);
    expect(load.diagnostics).toEqual([]);
  });

  it('A5: reports an empty entry and keeps the valid one', async () => {
    const fs = memoryFs({
      files: { [CONFIG_PATH]: workspaceToml(['', 'A']) },
      dirs: [join(ROOT, 'A')],
    });

    const load = await readConfig(fs);

    expect(load.additionalDirs).toEqual([resolve(ROOT, 'A')]);
    expect(load.diagnostics).toHaveLength(1);
    expect(load.diagnostics[0]).toEqual({
      scope: 'entry',
      index: 0,
      entry: '',
      category: 'empty',
      code: ErrorCodes.CONFIG_INVALID,
      message: expect.any(String),
      dir: undefined,
    });
  });

  it('reports a non-directory entry with its resolved dir', async () => {
    const fs = memoryFs({
      files: { [CONFIG_PATH]: workspaceToml(['file.txt']), [join(ROOT, 'file.txt')]: 'x' },
    });

    const load = await readConfig(fs);

    expect(load.additionalDirs).toEqual([]);
    expect(load.diagnostics).toEqual([
      {
        scope: 'entry',
        index: 0,
        entry: 'file.txt',
        category: 'not_directory',
        dir: resolve(ROOT, 'file.txt'),
        code: ErrorCodes.ADDITIONAL_DIR_UNAVAILABLE,
        message: expect.any(String),
      },
    ]);
  });

  it('reports a failed probe as an entry diagnostic and keeps going', async () => {
    const locked = resolve(ROOT, 'locked');
    const fs = memoryFs({
      files: { [CONFIG_PATH]: workspaceToml(['locked', 'A']) },
      dirs: [join(ROOT, 'A')],
      statErrors: { [locked]: Object.assign(new Error('denied'), { code: 'EACCES' }) },
    });

    const load = await readConfig(fs);

    expect(load.additionalDirs).toEqual([resolve(ROOT, 'A')]);
    expect(load.diagnostics).toEqual([
      {
        scope: 'entry',
        index: 0,
        entry: 'locked',
        category: 'probe_failed',
        dir: locked,
        code: ErrorCodes.STORAGE_IO_FAILED,
        message: expect.any(String),
      },
    ]);
  });

  it('A6: accepts a bare read-only fs object', async () => {
    const fs: ProjectLocalConfigFs = {
      readText: () => Promise.resolve(''),
      stat: () => Promise.resolve({ isDirectory: true }),
      lstat: () => Promise.reject({ code: 'ENOENT' }),
    };

    const load = await readConfig(fs);

    expect(load.additionalDirs).toEqual([]);
    expect(load.diagnostics).toEqual([]);
  });

  it('expands a backslash home entry against the home dir', async () => {
    const fs = memoryFs({
      files: { [CONFIG_PATH]: "[workspace]\nadditional_dir = ['~\\sub']\n" },
      dirs: [join(HOME, 'sub')],
    });

    const load = await readConfig(fs);

    expect(load.additionalDirs).toContain(join(HOME, 'sub'));
    const indexes = load.diagnostics.flatMap((diagnostic) =>
      diagnostic.scope === 'entry' ? [diagnostic.index] : [],
    );
    expect(indexes).not.toContain(0);
  });

  it('A7: falls back to the work dir when no ancestor has a .git entry', async () => {
    const workDir = join(ROOT, 'sub', 'deep');
    const fs = memoryFs({ dirs: [workDir] });

    const load = await readProjectLocalConfig(workDir, { fs, homeDir: HOME });

    expect(load.projectRoot).toBe(normalize(workDir));
    expect(load.configPath).toBe(join(normalize(workDir), '.kimi-code', 'local.toml'));
  });

  it('A7: stops at the nearest ancestor that has a .git entry', async () => {
    const workDir = join(ROOT, 'sub');
    const fs = memoryFs({ dirs: [ROOT, workDir, join(ROOT, '.git')] });

    const load = await readProjectLocalConfig(workDir, { fs, homeDir: HOME });

    expect(load.projectRoot).toBe(ROOT);
    expect(load.configPath).toBe(CONFIG_PATH);
  });

  it('treats a .git file as a project marker too', async () => {
    const workDir = join(ROOT, 'sub');
    const fs = memoryFs({ dirs: [ROOT, workDir], files: { [join(ROOT, '.git')]: 'gitdir: x' } });

    const load = await readProjectLocalConfig(workDir, { fs, homeDir: HOME });

    expect(load.projectRoot).toBe(ROOT);
  });
});

describe('findProjectRoot', () => {
  it('returns the start dir when it already holds a .git entry', async () => {
    const fs = memoryFs({ dirs: [ROOT, join(ROOT, '.git')] });

    await expect(findProjectRoot(ROOT, fs)).resolves.toBe(ROOT);
  });

  it('normalizes the start dir before walking', async () => {
    const fs = memoryFs({ dirs: [ROOT, join(ROOT, '.git')] });

    await expect(findProjectRoot('/repo//./', fs)).resolves.toBe(normalize('/repo//./'));
  });
});

describe('projectLocalConfigPath', () => {
  it('points at the local config inside the project root', () => {
    expect(projectLocalConfigPath(ROOT)).toBe(CONFIG_PATH);
  });
});

describe('readProjectLocalConfigSource', () => {
  it('reports ENOENT as absent', async () => {
    const missing = memoryFs();

    await expect(readProjectLocalConfigSource(CONFIG_PATH, missing)).resolves.toEqual({
      kind: 'absent',
    });
  });

  it('reports ENOTDIR as a read failure', async () => {
    const notDir = memoryFs({ readErrors: { [CONFIG_PATH]: { code: 'ENOTDIR' } } });

    const source = await readProjectLocalConfigSource(CONFIG_PATH, notDir);

    expect(source).toEqual({
      kind: 'error',
      diagnostic: {
        scope: 'file',
        category: 'read_failed',
        code: ErrorCodes.STORAGE_IO_FAILED,
        message: expect.any(String),
      },
    });
  });

  it('reports a blank file as an empty entry list', async () => {
    const fs = memoryFs({ files: { [CONFIG_PATH]: '  \n\t\n' } });

    await expect(readProjectLocalConfigSource(CONFIG_PATH, fs)).resolves.toEqual({
      kind: 'ok',
      text: '  \n\t\n',
      entries: [],
    });
  });

  it('returns the raw entries untouched', async () => {
    const text = workspaceToml([' ./A ', '~/B']);
    const fs = memoryFs({ files: { [CONFIG_PATH]: text } });

    await expect(readProjectLocalConfigSource(CONFIG_PATH, fs)).resolves.toEqual({
      kind: 'ok',
      text,
      entries: [' ./A ', '~/B'],
    });
  });

  it('reports an array-of-tables workspace as a schema error', async () => {
    const fs = memoryFs({ files: { [CONFIG_PATH]: '[[workspace]]\nname = "x"\n' } });

    const source = await readProjectLocalConfigSource(CONFIG_PATH, fs);

    expect(source).toEqual({
      kind: 'error',
      diagnostic: {
        scope: 'file',
        category: 'schema_invalid',
        code: ErrorCodes.CONFIG_INVALID,
        message: 'workspace must be a table',
      },
    });
  });

  it('reports an absent additional_dir as an empty entry list', async () => {
    const text = '[workspace]\nother = 1\n';
    const fs = memoryFs({ files: { [CONFIG_PATH]: text } });

    await expect(readProjectLocalConfigSource(CONFIG_PATH, fs)).resolves.toEqual({
      kind: 'ok',
      text,
      entries: [],
    });
  });
});
