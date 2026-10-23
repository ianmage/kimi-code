import { mkdirSync, mkdtempSync } from 'node:fs';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ILogService } from '#/_base/log/log';
import type {
  IProjectLocalConfigService,
  ProjectLocalConfigDiagnostic,
  ProjectLocalConfigLoad,
} from '#/app/projectLocalConfig/projectLocalConfig';
import { AppStateService } from '#/app/state/appStateService';
import { ErrorCodes } from '#/errors';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { FileProjectLocalConfigService } from '#/persistence/backends/node-fs/projectLocalConfigService';
import { WorkspaceStateService } from '#/workspace/state/workspaceStateService';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { WorkspaceDirsService } from '#/workspace/workspaceDirs/workspaceDirsService';

import { stubBootstrap } from '../../app/bootstrap/stubs';

const watchState = vi.hoisted(() => {
  const listeners: ((change: unknown) => void)[] = [];
  const handle = {
    ready: Promise.resolve(),
    onDidChange: (listener: (change: unknown) => void) => {
      listeners.push(listener);
      return { dispose: () => {} };
    },
    dispose: () => {},
  };
  return { listeners, handle };
});

vi.mock('#human/utils/watch', () => ({
  watch: () => watchState.handle,
  watchCandidates: () => watchState.handle,
}));

describe('WorkspaceDirsService', () => {
  let root: string;
  let home: string;
  let configPath: string;
  let readLoad: () => Promise<ProjectLocalConfigLoad>;
  let appendLoad: (inputPath: string) => Promise<ProjectLocalConfigLoad>;
  let created: WorkspaceDirsService[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kimi-workspace-dirs-'));
    home = mkdtempSync(join(tmpdir(), 'kimi-workspace-dirs-home-'));
    configPath = join(root, '.kimi-code', 'local.toml');
    created = [];
    watchState.listeners.length = 0;
    watchState.handle.ready = Promise.resolve();
    readLoad = () => Promise.reject(new Error('readAdditionalDirs is not stubbed'));
    appendLoad = () => Promise.reject(new Error('appendAdditionalDir is not stubbed'));
    vi.useFakeTimers();
  });

  afterEach(async () => {
    for (const service of created) service.dispose();
    vi.useRealTimers();
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(home, { recursive: true, force: true }),
    ]);
  });

  function dir(name: string): string {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    return path;
  }

  function load(
    additionalDirs: readonly string[],
    diagnostics: readonly ProjectLocalConfigDiagnostic[] = [],
  ): ProjectLocalConfigLoad {
    return { projectRoot: root, configPath, additionalDirs, diagnostics, source: 'present' };
  }

  function fileDiagnostic(
    category: 'read_failed' | 'toml_invalid' | 'schema_invalid',
  ): ProjectLocalConfigDiagnostic {
    return {
      scope: 'file',
      category,
      code: ErrorCodes.STORAGE_DECODE_FAILED,
      message: `${category} in ${configPath}`,
    };
  }

  function missingEntry(index: number, entry: string): ProjectLocalConfigDiagnostic {
    return {
      scope: 'entry',
      index,
      entry,
      category: 'missing',
      code: ErrorCodes.ADDITIONAL_DIR_UNAVAILABLE,
      message: `workspace.additional_dir entry does not exist: ${entry}`,
    };
  }

  async function resolveAdditionalDirs(
    baseDir: string,
    dirs: readonly string[],
  ): Promise<string[]> {
    const resolved: string[] = [];
    for (const entry of dirs) {
      const path = isAbsolute(entry) ? entry : join(baseDir, entry);
      const stats = await stat(path);
      if (!stats.isDirectory()) throw new Error(`not a directory: ${path}`);
      resolved.push(path);
    }
    return resolved;
  }

  function createService(): { service: WorkspaceDirsService; warn: ReturnType<typeof vi.fn> } {
    const warn = vi.fn();
    const workspace = { cwd: root } as unknown as IWorkspaceContext;
    const localConfig = {
      readAdditionalDirs: () => readLoad(),
      appendAdditionalDir: (_workDir: string, inputPath: string) => appendLoad(inputPath),
      resolveAdditionalDirs,
    } as unknown as IProjectLocalConfigService;
    const log = { warn } as unknown as ILogService;
    const states = new WorkspaceStateService(new AppStateService());
    const service = new WorkspaceDirsService(workspace, localConfig, log, states);
    created.push(service);
    return { service, warn };
  }

  async function drain(): Promise<void> {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  }

  function createRealService(): {
    service: WorkspaceDirsService;
    warn: ReturnType<typeof vi.fn>;
  } {
    const warn = vi.fn();
    const workspace = { cwd: root } as unknown as IWorkspaceContext;
    const localConfig = new FileProjectLocalConfigService(
      stubBootstrap(home, {}, {}, home),
      new HostFileSystem(),
    );
    const log = { warn } as unknown as ILogService;
    const states = new WorkspaceStateService(new AppStateService());
    const service = new WorkspaceDirsService(workspace, localConfig, log, states);
    created.push(service);
    return { service, warn };
  }

  async function writeLocalToml(entries: readonly string[]): Promise<void> {
    mkdirSync(join(root, '.kimi-code'), { recursive: true });
    const list = entries.map((entry) => `"${entry}"`).join(', ');
    await writeFile(configPath, `[workspace]\nadditional_dir = [ ${list} ]\n`, 'utf8');
  }

  async function fireWatch(): Promise<void> {
    for (const listener of [...watchState.listeners]) {
      listener({ path: configPath, action: 'modified', kind: 'file' });
    }
    await vi.advanceTimersByTimeAsync(200);
    await drain();
  }

  it('resolves ready for a toml_invalid file diagnostic', async () => {
    readLoad = () => Promise.resolve(load([], [fileDiagnostic('toml_invalid')]));
    const { service } = createService();

    await expect(service.ready).resolves.toBeUndefined();
    expect(service.additionalDirs).toEqual([]);
  });

  it('resolves ready for a missing entry diagnostic', async () => {
    const missing = join(root, 'gone');
    readLoad = () => Promise.resolve(load([], [missingEntry(0, missing)]));
    const { service } = createService();

    await expect(service.ready).resolves.toBeUndefined();
    expect(service.additionalDirs).toEqual([]);
  });

  it('resolves ready for a read_failed file diagnostic', async () => {
    readLoad = () => Promise.resolve(load([], [fileDiagnostic('read_failed')]));
    const { service } = createService();

    await expect(service.ready).resolves.toBeUndefined();
    expect(service.additionalDirs).toEqual([]);
  });

  it('still watches after an unusable first load and applies the next valid one', async () => {
    const a = dir('a');
    readLoad = () => Promise.resolve(load([], [fileDiagnostic('toml_invalid')]));
    const { service } = createService();
    await service.ready;

    expect(service.additionalDirs).toEqual([]);
    expect(watchState.listeners).toHaveLength(1);

    readLoad = () => Promise.resolve(load([a]));
    await fireWatch();

    expect(service.additionalDirs).toEqual([a]);
  });

  it('empties the file contribution and fires once when the file becomes unusable', async () => {
    const a = dir('a');
    readLoad = () => Promise.resolve(load([a]));
    const { service } = createService();
    await service.ready;

    let fired = 0;
    service.onDidChange(() => {
      fired += 1;
    });

    readLoad = () => Promise.resolve(load([], [fileDiagnostic('toml_invalid')]));
    await fireWatch();

    expect(service.additionalDirs).toEqual([]);
    expect(fired).toBe(1);
  });

  it('adds a non-persistent dir while the file load carries a missing entry', async () => {
    const a = dir('a');
    const missing = join(root, 'gone');
    readLoad = () => Promise.resolve(load([], [missingEntry(0, missing)]));
    const { service } = createService();
    await service.ready;

    const result = await service.addDir({ path: a, persist: false });

    expect(result.persisted).toBe(false);
    expect(result.additionalDirs).toEqual([a]);
    expect(service.additionalDirs).toEqual([a]);
  });

  it('persists a dir and takes the appended load as the file contribution', async () => {
    const a = dir('a');
    readLoad = () => Promise.resolve(load([]));
    appendLoad = () => Promise.resolve(load([a]));
    const { service } = createService();
    await service.ready;

    const result = await service.addDir({ path: a });

    expect(result.persisted).toBe(true);
    expect(result.additionalDirs).toEqual([a]);
    expect(service.additionalDirs).toEqual([a]);
  });

  it('keeps the usable entries of a load with a missing entry in between', async () => {
    const a = dir('a');
    const c = dir('c');
    const missing = join(root, 'gone');
    readLoad = () => Promise.resolve(load([a, c], [missingEntry(1, missing)]));
    const { service } = createService();
    await service.ready;

    expect(service.additionalDirs).toEqual([a, c]);
    expect(service.additionalDirs).not.toContain(missing);
  });

  it('does not fire when a reload yields the same effective set', async () => {
    const a = dir('a');
    readLoad = () => Promise.resolve(load([a]));
    const { service } = createService();
    await service.ready;

    let fired = 0;
    service.onDidChange(() => {
      fired += 1;
    });

    readLoad = () => Promise.resolve(load([a], [missingEntry(1, join(root, 'gone'))]));
    await fireWatch();

    expect(fired).toBe(0);
    expect(service.additionalDirs).toEqual([a]);
  });

  it('warns once per entry diagnostic', async () => {
    const a = dir('a');
    const c = dir('c');
    const missing = join(root, 'gone');
    readLoad = () => Promise.resolve(load([a, c], [missingEntry(1, missing)]));
    const { service, warn } = createService();
    await service.ready;

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain(missing);
    expect(message).toContain(configPath);
    expect(message).toContain('missing');
    expect(message).toContain('entry #1');
  });

  it('warns when the watcher cannot be created', async () => {
    const a = dir('a');
    readLoad = () => Promise.resolve(load([a]));
    const ready = Promise.reject(new Error('watch failed'));
    void ready.catch(() => {});
    watchState.handle.ready = ready;
    const { service, warn } = createService();

    await service.ready;
    await drain();

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain(configPath);
    expect(message).toContain('watch failed');
  });

  it('warns once for an unusable file', async () => {
    readLoad = () => Promise.resolve(load([], [fileDiagnostic('toml_invalid')]));
    const { service, warn } = createService();
    await service.ready;

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain(configPath);
    expect(message).toContain('toml_invalid');
  });

  it('does not warn when the load has no diagnostics', async () => {
    const a = dir('a');
    readLoad = () => Promise.resolve(load([a]));
    const { service, warn } = createService();
    await service.ready;

    expect(warn).toHaveBeenCalledTimes(0);
    expect(service.additionalDirs).toEqual([a]);
  });

  it('keeps a stale entry out of the boundary and warns once on a real startup', async () => {
    const a = dir('a');
    const c = dir('c');
    const missing = join(root, 'gone');
    await writeLocalToml([a, missing, c]);

    const { service, warn } = createRealService();
    await expect(service.ready).resolves.toBeUndefined();

    expect(service.additionalDirs).toContain(a);
    expect(service.additionalDirs).toContain(c);
    expect(service.additionalDirs).not.toContain(missing);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain(missing);
    expect(message).toContain(configPath);
    expect(message).toContain('missing');
  });

  it('remember drops the stale entry from the file without a second warning', async () => {
    const a = dir('a');
    const c = dir('c');
    const e = dir('e');
    const missing = join(root, 'gone');
    await writeLocalToml([a, missing, c]);

    const { service, warn } = createRealService();
    await service.ready;
    expect(warn).toHaveBeenCalledTimes(1);

    let fired = 0;
    service.onDidChange(() => {
      fired += 1;
    });

    const result = await service.addDir({ path: e, persist: true });

    const text = await readFile(configPath, 'utf8');
    expect(text).not.toContain(missing);
    expect(text).toContain(e);
    expect(text).toContain(a);
    expect(text).toContain(c);
    expect(result.additionalDirs).toContain(e);
    expect(fired).toBeGreaterThanOrEqual(1);
    expect(warn).toHaveBeenCalledTimes(1);

    const evidence = join(import.meta.dirname, '../../../../../.tmp/phase-4.3-evidence.txt');
    mkdirSync(join(import.meta.dirname, '../../../../../.tmp'), { recursive: true });
    await writeFile(evidence, `=== local.toml after remember ===\n${text}\n`, 'utf8');
  });
});
