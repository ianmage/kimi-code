import { isAbsolute, join, resolve } from 'node:path/posix';
import * as win32Path from 'node:path/win32';
import { Readable, Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LifecycleScope } from '#/app/scopes';
import {
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { IGitService } from '#/app/git/git';
import { ILogService } from '#/_base/log/log';
import { ErrorCodes, Error2, unwrapErrorCause } from '#/errors';
import { type HostDirEntry, IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFsError, toHostFsError } from '#/os/interface/hostFsErrors';
import { IHostProcessService, type IHostProcess } from '#/os/interface/hostProcess';
import { type FsListRequest, IWorkspaceFsService } from '#/workspace/workspaceFs/fs';
import { WorkspaceFsService } from '#/workspace/workspaceFs/fsService';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { ITelemetryService, type TelemetryProperties } from '#/app/telemetry/telemetry';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { IWorkspaceGitService } from '#/workspace/workspaceGit/workspaceGit';
import { stubLog } from '../../_base/log/stubs';
import { loadProjectIgnore, type ProjectIgnoreOptions } from '#/_base/utils/projectIgnore';
import { join as patheJoin, normalize as patheNormalize } from 'pathe';

const WORK_DIR = '/repo';

function stubWorkspaceContext(): IWorkspaceContext {
  return {
    _serviceBrand: undefined,
    workspaceId: 'w',
    cwd: WORK_DIR,
    source: 'local',
    meta: { id: 'w', root: WORK_DIR, name: 'proj', createdAt: 1, lastOpenedAt: 1 },
    persistenceScope: 'sessions/w',
  };
}

function stubWorkspaceDirs(additionalDirs: readonly string[] = []): IWorkspaceDirs {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    additionalDirs: [...additionalDirs],
    onDidChange: () => ({ dispose: () => {} }),
    addDir: () => Promise.reject(new Error('not supported in tests')),
    mergeAdditionalDirs: () => Promise.resolve(),
    sessionInfo: () => {
      throw new Error('not supported in tests');
    },
  };
}

function workspaceGitStub(git: IGitService): IWorkspaceGitService {
  return {
    _serviceBrand: undefined,
    status: (filter) => git.status(WORK_DIR, filter),
    diff: (rel, abs) => git.diff(WORK_DIR, rel, abs),
  };
}

interface FakeFsHandle {
  readonly readTextCalls: Map<string, number>;
  readonly readdirCalls: Map<string, number>;
  readonly setFile: (relOrAbs: string, content: string | Buffer) => void;
  readonly removeFile: (relOrAbs: string) => void;
  readonly failReadText: (relOrAbs: string, error: Error) => void;
}

function fakeFs(
  files: Record<string, string | Buffer>,
  symlinks: readonly string[] = [],
  symlinkTargets: Record<string, string> = {},
): IHostFileSystem & FakeFsHandle {
  const fileMap = new Map<string, string | Buffer>();
  const dirSet = new Set<string>([WORK_DIR]);
  const readTextCalls = new Map<string, number>();
  const readdirCalls = new Map<string, number>();
  const readTextFailures = new Map<string, Error>();
  const toAbs = (relOrAbs: string): string =>
    relOrAbs.startsWith('/') ? relOrAbs : join(WORK_DIR, relOrAbs);
  const addAncestors = (rel: string): void => {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirSet.add(join(WORK_DIR, parts.slice(0, i).join('/')));
    }
  };
  const addAbsAncestors = (abs: string): void => {
    let dir = abs.slice(0, abs.lastIndexOf('/'));
    while (dir.length > 0 && !dirSet.has(dir)) {
      dirSet.add(dir);
      dir = dir.slice(0, dir.lastIndexOf('/'));
    }
  };
  const setFile = (relOrAbs: string, content: string | Buffer): void => {
    if (relOrAbs.startsWith('/')) {
      fileMap.set(relOrAbs, content);
      addAbsAncestors(relOrAbs);
    } else {
      fileMap.set(join(WORK_DIR, relOrAbs), content);
      addAncestors(relOrAbs);
    }
  };
  const removeFile = (relOrAbs: string): void => {
    fileMap.delete(toAbs(relOrAbs));
  };
  const failReadText = (relOrAbs: string, error: Error): void => {
    readTextFailures.set(toAbs(relOrAbs), error);
  };
  const count = (calls: Map<string, number>, p: string): void => {
    calls.set(p, (calls.get(p) ?? 0) + 1);
  };
  const recordReadText = async (p: string): Promise<string> => {
    count(readTextCalls, p);
    const injected = readTextFailures.get(p);
    if (injected !== undefined) throw injected;
    const c = fileMap.get(p);
    if (c === undefined) throw toHostFsError(enoent(p), { path: p, op: 'read' });
    return typeof c === 'string' ? c : c.toString('utf8');
  };
  for (const [rel, content] of Object.entries(files)) {
    setFile(rel, content);
  }
  const symlinkSet = new Set<string>();
  for (const rel of symlinks) {
    symlinkSet.add(join(WORK_DIR, rel));
    addAncestors(rel);
  }
  const symlinkTargetMap = new Map<string, string>();
  for (const [rel, target] of Object.entries(symlinkTargets)) {
    const abs = join(WORK_DIR, rel);
    symlinkTargetMap.set(abs, target);
    symlinkSet.add(abs);
    addAncestors(rel);
  }
  const isDir = (p: string): boolean => p === WORK_DIR || dirSet.has(p);
  const enoent = (p: string): NodeJS.ErrnoException => {
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    return err;
  };
  const lstatImpl = async (p: string) => {
    if (fileMap.has(p)) {
      const c = fileMap.get(p)!;
      return {
        isFile: true,
        isDirectory: false,
        size: Buffer.isBuffer(c) ? c.length : Buffer.byteLength(c),
        mtimeMs: 1000,
        ino: 1,
      };
    }
    if (symlinkSet.has(p)) {
      return { isFile: false, isDirectory: false, isSymbolicLink: true, size: 0, mtimeMs: 1000, ino: 1 };
    }
    if (isDir(p)) {
      return { isFile: false, isDirectory: true, size: 0, mtimeMs: 1000, ino: 1 };
    }
    throw enoent(p);
  };
  return {
    _serviceBrand: undefined,
    readText: recordReadText,
    writeText: async () => {},
    appendText: async () => {},
    readBytes: async (p, n) => {
      const c = fileMap.get(p);
      if (c === undefined) throw enoent(p);
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      return buf.subarray(0, n ?? buf.length);
    },
    readLines: async function* (): AsyncGenerator<string> {
    },
    writeBytes: async () => {},
    createExclusive: async () => false,
    lstat: lstatImpl,
    stat: async (p) => {
      let cur = p;
      for (let hops = 0; hops < 10 && symlinkSet.has(cur); hops += 1) {
        const target = symlinkTargetMap.get(cur);
        if (target === undefined) break;
        cur = isAbsolute(target) ? target : join(cur, '..', target);
      }
      return lstatImpl(cur);
    },
    readdir: async (p) => {
      count(readdirCalls, p);
      if (!isDir(p)) throw enoent(p);
      const prefix = `${p}/`;
      const children = new Map<string, HostDirEntry>();
      const addDir = (name: string): void => {
        if (!children.has(name)) {
          children.set(name, { name, isFile: false, isDirectory: true });
        }
      };
      const addFile = (name: string): void => {
        if (!children.has(name)) {
          children.set(name, { name, isFile: true, isDirectory: false });
        }
      };
      const addSymlink = (name: string): void => {
        if (!children.has(name)) {
          children.set(name, { name, isFile: false, isDirectory: false, isSymbolicLink: true });
        }
      };
      const visit = (key: string, kind: 'file' | 'dir' | 'symlink'): void => {
        if (key === p || !key.startsWith(prefix)) return;
        const rest = key.slice(prefix.length);
        const first = rest.split('/')[0];
        if (first === undefined || first.length === 0) return;
        if (rest.includes('/')) addDir(first);
        else if (kind === 'symlink') addSymlink(first);
        else if (kind === 'file') addFile(first);
        else addDir(first);
      };
      for (const d of dirSet) visit(d, 'dir');
      for (const f of fileMap.keys()) visit(f, 'file');
      for (const s of symlinkSet) visit(s, 'symlink');
      return [...children.values()];
    },
    mkdir: async (p, options) => {
      const recursive = options?.recursive ?? false;
      const exists = isDir(p) || fileMap.has(p);
      if (recursive) {
        let current = p;
        while (current !== WORK_DIR && current.length > WORK_DIR.length) {
          dirSet.add(current);
          const next = current.slice(0, current.lastIndexOf('/'));
          if (next === current || next === '') break;
          current = next;
        }
        dirSet.add(p);
        return;
      }
      if (exists) {
        const err = new Error(`EEXIST: ${p}`) as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        throw err;
      }
      const parent = p.slice(0, p.lastIndexOf('/'));
      if (parent !== '' && parent !== WORK_DIR && !isDir(parent)) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      dirSet.add(p);
    },
    remove: async () => {},
    realpath: async (p) => {
      let current = p;
      for (let i = 0; i < 40; i++) {
        let longest: string | undefined;
        for (const linkPath of symlinkTargetMap.keys()) {
          if (
            (current === linkPath || current.startsWith(`${linkPath}/`)) &&
            (longest === undefined || linkPath.length > longest.length)
          ) {
            longest = linkPath;
          }
        }
        if (longest === undefined) {
          if (current === p) {
            if (p === WORK_DIR || fileMap.has(p) || isDir(p) || symlinkSet.has(p)) return p;
            throw enoent(p);
          }
          return current;
        }
        current = symlinkTargetMap.get(longest)! + current.slice(longest.length);
      }
      return current;
    },
    readTextCalls,
    readdirCalls,
    setFile,
    removeFile,
    failReadText,
  };
}

function fakeProcess(stdout: string, stderr: string, exitCode: number): IHostProcess {
  return {
    _serviceBrand: undefined,
    stdin: new Writable({ write(_c, _e, cb) { cb(); } }),
    stdout: Readable.from([stdout]),
    stderr: Readable.from([stderr]),
    pid: 1,
    exitCode,
    wait: () => Promise.resolve(exitCode),
    kill: () => Promise.resolve(),
    dispose: () => undefined,
  };
}

type RunHandler = (args: readonly string[]) => {
  stdout: string;
  stderr?: string;
  exitCode: number;
};

function fakeRunner(handler: RunHandler): IHostProcessService {
  return {
    _serviceBrand: undefined,
    spawn: async (command, args) => {
      const r = handler([command, ...(args ?? [])]);
      return fakeProcess(r.stdout, r.stderr ?? '', r.exitCode);
    },
  };
}

function makeStreamingProcess(lines: readonly string[]): {
  proc: IHostProcess;
  wasKilled: () => boolean;
  yieldedLines: () => number;
} {
  let killed = false;
  let yielded = 0;
  let resolveWait: (code: number) => void = () => {};
  const waitP = new Promise<number>((res) => {
    resolveWait = res;
  });
  async function* gen(): AsyncGenerator<string> {
    for (const line of lines) {
      if (killed) break;
      yielded += 1;
      yield `${line}\n`;
      await new Promise((r) => setImmediate(r));
    }
    resolveWait(0);
  }
  const proc: IHostProcess = {
    _serviceBrand: undefined,
    stdin: new Writable({ write(_c, _e, cb) { cb(); } }),
    stdout: Readable.from(gen()),
    stderr: Readable.from(['']),
    pid: 1,
    exitCode: null,
    wait: () => waitP,
    kill: async () => {
      killed = true;
      resolveWait(0);
    },
    dispose: () => undefined,
  };
  return { proc, wasKilled: () => killed, yieldedLines: () => yielded };
}

function telemetryStub(events: Array<{ event: string; properties: Record<string, unknown> }>): ITelemetryService {
  return {
    _serviceBrand: undefined,
    track2: (event, properties) => {
      events.push({ event, properties: (properties as TelemetryProperties | undefined) ?? {} });
    },
    withContext: () => telemetryStub(events),
    setContext: () => {},
    getContext: () => ({}),
    addAppender: () => ({ dispose: () => {} }),
    removeAppender: () => {},
    setEnabled: () => {},
    flush: async () => {},
    shutdown: async () => {},
  };
}

beforeEach(() => {
  _clearScopedRegistryForTests();
  registerScopedService(
    'program',
    IWorkspaceFsService,
    WorkspaceFsService,
    ScopeActivation.OnDemand,
    'workspaceFs',
  );
});

let host: ReturnType<typeof createScopedTestHost> | undefined;

afterEach(() => {
  host?.dispose();
  host = undefined;
});

function defaultGitStub(): IGitService {
  return {
    _serviceBrand: undefined,
    status: async () => ({
      branch: '',
      ahead: 0,
      behind: 0,
      entries: {},
      additions: 0,
      deletions: 0,
      pullRequest: null,
    }),
    diff: async () => ({ path: '', diff: '', truncated: false }),
    findWorkTree: async () => null,
  };
}

function recordingLog(warns: Array<{ message: string; payload: unknown }>): ILogService {
  const log: ILogService = {
    ...stubLog(),
    warn: (message, payload) => {
      warns.push({ message, payload });
    },
    child: () => log,
  };
  return log;
}

function makeSession(
  files: Record<string, string | Buffer>,
  handler: RunHandler,
  events: Array<{ event: string; properties: Record<string, unknown> }> = [],
  git: IGitService = defaultGitStub(),
  symlinks: readonly string[] = [],
  runner?: IHostProcessService,
  symlinkTargets: Record<string, string> = {},
  additionalDirs: readonly string[] = [],
  pathClass: 'posix' | 'win32' = 'posix',
  log: ILogService = stubLog(),
  fs?: IHostFileSystem & FakeFsHandle,
): IWorkspaceFsService {
  host = createScopedTestHost([
    stubPair(IHostEnvironment, {
      _serviceBrand: undefined,
      osKind: 'Linux',
      osArch: 'x64',
      osVersion: 'test',
      shellName: 'bash',
      shellPath: '/bin/bash',
      pathClass: 'posix',
      homeDir: '/home/test',
      ready: Promise.resolve(),
    }),
    stubPair(ILogService, log),
  ]);
  const runtime = new FakeRuntime({ workspaceId: 'w', runtimeId: 'local', generation: 'test' }, { capabilities: ['process'], pathClass });
  Object.defineProperty(runtime, 'process', { value: runner ?? fakeRunner(handler) });
  host.app.instantiation.provide(IRuntimeResolver, {
    _serviceBrand: undefined,
    inspect: () => runtime,
    acquire: () => ({ runtime, track: (resource) => resource, dispose: () => {} }),
  });
  const workspace = host.child('program', 'w1', [
    stubPair(IWorkspaceContext, stubWorkspaceContext()),
    stubPair(IWorkspaceDirs, stubWorkspaceDirs(additionalDirs)),
    stubPair(IHostFileSystem, fs ?? fakeFs(files, symlinks, symlinkTargets)),
    stubPair(IHostProcessService, runner ?? fakeRunner(handler)),
    stubPair(ITelemetryService, telemetryStub(events)),
    stubPair(IWorkspaceGitService, workspaceGitStub(git)),
  ]);
  return workspace.accessor.get(IWorkspaceFsService);
}

const emptyHandler: RunHandler = () => ({ stdout: '', exitCode: 0 });

function rgLinesHandler(lines: readonly string[], captured?: string[][]): RunHandler {
  return (args) => {
    captured?.push([...args]);
    if (args[0] === 'rg' && args[1] === '--version') {
      return { stdout: 'ripgrep 15.0.0', exitCode: 0 };
    }
    if (args[0] === 'rg' && args.includes('--files')) {
      return { stdout: lines.map((l) => `${l}\n`).join(''), exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 };
  };
}

function rgMultiRootHandler(perRoot: Record<string, readonly string[]>, captured?: string[][]): RunHandler {
  return (args) => {
    captured?.push([...args]);
    if (args[0] === 'rg' && args[1] === '--version') {
      return { stdout: 'ripgrep 15.0.0', exitCode: 0 };
    }
    if (args[0] === 'rg' && args.includes('--files')) {
      const lines: string[] = [];
      for (const arg of args) {
        const rootLines = perRoot[arg];
        if (rootLines !== undefined) {
          for (const line of rootLines) lines.push(`${arg === '/' ? '' : arg}/${line}`);
        }
      }
      return { stdout: lines.map((l) => `${l}\n`).join(''), exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 };
  };
}

function rgMissingHandler(args: readonly string[]): { stdout: string; exitCode: number } {
  if (args[0] === 'rg' && args[1] === '--version') return { stdout: '', exitCode: 1 };
  return { stdout: '', exitCode: 0 };
}

describe('WorkspaceFsService.gitStatus', () => {
  it('delegates to IWorkspaceGitService with the handler root and a confined filter', async () => {
    const calls: Array<{ cwd: string; filter: ReadonlySet<string> | undefined }> = [];
    const git: IGitService = {
      _serviceBrand: undefined,
      status: async (cwd, filter) => {
        calls.push({ cwd, filter });
        return {
          branch: 'main',
          ahead: 0,
          behind: 0,
          entries: { 'src/a.ts': 'modified' },
          additions: 3,
          deletions: 1,
          pullRequest: null,
        };
      },
      diff: async () => ({ path: '', diff: '', truncated: false }),
      findWorkTree: async () => null,
    };
    const fs = makeSession({}, emptyHandler, [], git);
    const result = await fs.gitStatus({ paths: ['src/a.ts'] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(WORK_DIR);
    expect(calls[0]?.filter).toEqual(new Set(['src/a.ts']));
    expect(result.branch).toBe('main');
    expect(result.entries).toEqual({ 'src/a.ts': 'modified' });
    expect(result.additions).toBe(3);
  });

  it('propagates FS_GIT_UNAVAILABLE thrown by IGitService', async () => {
    const git: IGitService = {
      _serviceBrand: undefined,
      status: async () => {
        throw new Error2(ErrorCodes.FS_GIT_UNAVAILABLE, 'git unavailable at /repo: not a repo');
      },
      diff: async () => ({ path: '', diff: '', truncated: false }),
      findWorkTree: async () => null,
    };
    const fs = makeSession({}, emptyHandler, [], git);
    await expect(fs.gitStatus({})).rejects.toMatchObject({ code: 'fs.git_unavailable' });
  });
});

describe('WorkspaceFsService.diff', () => {
  it('delegates to IWorkspaceGitService with confined rel and abs paths', async () => {
    const calls: Array<{ cwd: string; rel: string; abs: string }> = [];
    const git: IGitService = {
      _serviceBrand: undefined,
      status: async () => ({
        branch: '',
        ahead: 0,
        behind: 0,
        entries: {},
        additions: 0,
        deletions: 0,
        pullRequest: null,
      }),
      diff: async (cwd, rel, abs) => {
        calls.push({ cwd, rel, abs });
        return { path: rel, diff: '-old\n+new\n', truncated: false };
      },
      findWorkTree: async () => null,
    };
    const fs = makeSession({ 'src/a.ts': 'content' }, emptyHandler, [], git);
    const result = await fs.diff({ path: 'src/a.ts' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(WORK_DIR);
    expect(calls[0]?.rel).toBe('src/a.ts');
    expect(calls[0]?.abs).toBe(resolve(WORK_DIR, 'src/a.ts'));
    expect(result.diff).toContain('+new');
    expect(result.truncated).toBe(false);
  });

  it('rejects paths that escape the workspace', async () => {
    const fs = makeSession({}, emptyHandler);
    await expect(fs.diff({ path: '../etc/passwd' })).rejects.toMatchObject({
      code: 'fs.path_escapes',
    });
  });
});

describe('WorkspaceFsService.search', () => {
  it('finds files by fuzzy query and respects the result cap', async () => {
    const fs = makeSession(
      { 'src/foo.ts': '', 'src/bar.ts': '', 'README.md': '' },
      emptyHandler,
    );
    const result = await fs.search({ query: 'foo', limit: 50, follow_gitignore: false });
    const paths = result.items.map((i) => i.path);
    expect(paths).toContain('src/foo.ts');
    expect(paths).not.toContain('src/bar.ts');
  });

  it('reports symlinks as kind symlink and does not recurse into them', async () => {
    const fs = makeSession(
      { 'src/real.ts': '', 'src/target/inside.ts': '' },
      emptyHandler,
      [],
      defaultGitStub(),
      ['src/link'],
    );
    const result = await fs.search({ query: 'link', limit: 50, follow_gitignore: false });
    const paths = result.items.map((i) => i.path);
    expect(paths).toContain('src/link');
    expect(result.items.find((i) => i.path === 'src/link')?.kind).toBe('symlink');
    expect(paths.some((p) => p.startsWith('src/link/'))).toBe(false);
  });

  it('lists the workspace root top-level entries when the query is empty', async () => {
    const fs = makeSession(
      { 'src/foo.ts': '', 'src/nested/deep.ts': '', 'README.md': '', '.hidden.ts': '' },
      emptyHandler,
    );
    const result = await fs.search({ query: '', limit: 50, follow_gitignore: false });
    expect(result.items.map((i) => i.path)).toEqual(['src', 'README.md']);
    expect(result.items[0]).toMatchObject({
      name: 'src',
      kind: 'directory',
      score: 1,
      match_positions: [],
    });
    expect(result.truncated).toBe(false);
  });

  it('truncates the empty-query listing at the limit', async () => {
    const fs = makeSession({ 'a.ts': '', 'b.ts': '', 'c.ts': '' }, emptyHandler);
    const result = await fs.search({ query: '', limit: 2, follow_gitignore: false });
    expect(result.items.map((i) => i.path)).toEqual(['a.ts', 'b.ts']);
    expect(result.truncated).toBe(true);
  });

  it('respects .gitignore in the empty-query listing', async () => {
    const fs = makeSession(
      { '.gitignore': 'ignored.ts\n', 'ignored.ts': '', 'kept.ts': '' },
      emptyHandler,
    );
    const result = await fs.search({ query: '', limit: 50, follow_gitignore: true });
    expect(result.items.map((i) => i.path)).toEqual(['kept.ts']);
  });
});

describe('WorkspaceFsService.suggest', () => {
  it('matches path segments in order and ranks the matched directory first', async () => {
    const fs = makeSession(
      {},
      rgLinesHandler(['apps/desktop/package.json', 'apps/mobile/app.ts', 'src/api/index.ts']),
    );
    const result = await fs.suggest({
      query: 'apps/de',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items[0]).toMatchObject({
      path: 'apps/desktop',
      name: 'desktop',
      kind: 'directory',
    });
    expect(result.items.map((i) => i.path)).toContain('apps/desktop/package.json');
  });

  it('allows skipping segments when consuming the query', async () => {
    const fs = makeSession(
      {},
      rgLinesHandler(['apps/desktop/package.json', 'src/api/index.ts']),
    );
    const result = await fs.suggest({
      query: 'ap/de',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items[0]?.path).toBe('apps/desktop');
    expect(result.items.map((i) => i.path)).toContain('src/api/index.ts');
  });

  it('matches a file several segments deep', async () => {
    const fs = makeSession({}, rgLinesHandler(['apps/desktop/package.json']));
    const result = await fs.suggest({
      query: 'apps/pack',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items.map((i) => i.path)).toContain('apps/desktop/package.json');
  });

  it('ignores an empty last query segment', async () => {
    const fs = makeSession(
      {},
      rgLinesHandler(['apps/desktop/package.json', 'src/app.ts']),
    );
    const result = await fs.suggest({
      query: 'apps/',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items[0]?.path).toBe('apps');
  });

  it('returns an empty list when a path-form query has no match', async () => {
    const fs = makeSession({}, rgLinesHandler(['apps/desktop/package.json']));
    const result = await fs.suggest({
      query: 'zzz/qqq',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('matches basenames across the whole workspace in name mode', async () => {
    const fs = makeSession({}, rgLinesHandler(['docs/README.md', 'src/app.ts']));
    const result = await fs.suggest({
      query: 'readme',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items.map((i) => i.path)).toEqual(['docs/README.md']);
    expect(result.items[0]).toMatchObject({ name: 'README.md', kind: 'file' });
    expect(result.items[0]?.match_positions).toEqual([5, 6, 7, 8, 9, 10]);
  });

  it('ranks a shallow prefix hit before a deeper one and varies scores', async () => {
    const fs = makeSession({}, rgLinesHandler(['apps/index.ts', 'src/deep/api.ts']));
    const result = await fs.suggest({
      query: 'a',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    const paths = result.items.map((i) => i.path);
    expect(paths).toContain('apps');
    expect(paths.indexOf('apps')).toBeLessThan(paths.indexOf('src/deep/api.ts'));
    expect(new Set(result.items.map((i) => i.score)).size).toBeGreaterThan(1);
  });

  it('ranks an exact short hit before weaker longer or deeper hits', async () => {
    const fs = makeSession({}, rgLinesHandler(['apps/x.ts', 'xapps/y.ts']));
    const result = await fs.suggest({
      query: 'apps',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items[0]?.path).toBe('apps');
  });

  it('passes gitignore and hidden flags to rg', async () => {
    const captured: string[][] = [];
    const fs = makeSession({}, rgLinesHandler([], captured));
    await fs.suggest({ query: 'x', limit: 50, follow_gitignore: true, show_hidden: true });
    const filesArgs = captured.find((a) => a.includes('--files'))!;
    expect(filesArgs).toContain('--no-require-git');
    expect(filesArgs).toContain('--hidden');
    expect(filesArgs).not.toContain('--no-ignore');
    expect(filesArgs).toContain('!.git/**');
  });

  it('passes --no-ignore to rg when follow_gitignore is false', async () => {
    const captured: string[][] = [];
    const fs = makeSession({}, rgLinesHandler([], captured));
    await fs.suggest({ query: 'x', limit: 50, follow_gitignore: false, show_hidden: false });
    const filesArgs = captured.find((a) => a.includes('--files'))!;
    expect(filesArgs).toContain('--no-ignore');
    expect(filesArgs).not.toContain('--no-require-git');
    expect(filesArgs).not.toContain('--hidden');
  });

  it('hides dot-prefixed entries at any depth unless show_hidden is set', async () => {
    const fs = makeSession(
      {},
      rgLinesHandler(['visible.ts', '.env.ts', 'sub/.secret/x.ts']),
    );
    const off = await fs.suggest({
      query: 'ts',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(off.items.map((i) => i.path)).toEqual(['visible.ts']);
    const on = await fs.suggest({
      query: 'ts',
      limit: 50,
      follow_gitignore: true,
      show_hidden: true,
    });
    expect(on.items.map((i) => i.path)).toContain('.env.ts');
    expect(on.items.map((i) => i.path)).toContain('sub/.secret/x.ts');
  });

  it('never returns VCS metadata entries even with show_hidden', async () => {
    const fs = makeSession({}, rgLinesHandler(['.git/x.ts', 'src/.jj/y.ts', 'ok.ts']));
    const result = await fs.suggest({
      query: 'ts',
      limit: 50,
      follow_gitignore: true,
      show_hidden: true,
    });
    expect(result.items.map((i) => i.path)).toEqual(['ok.ts']);
  });

  it('lists root entries for an empty query and never lists VCS dirs', async () => {
    const fs = makeSession(
      { 'kept.ts': '', '.hidden.ts': '', '.git/config': '' },
      emptyHandler,
      [],
      defaultGitStub(),
      ['link'],
    );
    const shown = await fs.suggest({
      query: '',
      limit: 50,
      follow_gitignore: false,
      show_hidden: true,
    });
    const paths = shown.items.map((i) => i.path);
    expect(paths).toContain('.hidden.ts');
    expect(paths).toContain('kept.ts');
    expect(paths).not.toContain('.git');
    expect(shown.items.find((i) => i.path === 'link')?.kind).toBe('symlink');

    const hidden = await fs.suggest({
      query: '',
      limit: 50,
      follow_gitignore: false,
      show_hidden: false,
    });
    expect(hidden.items.map((i) => i.path)).not.toContain('.hidden.ts');
  });

  it('truncates at the limit and reports it', async () => {
    const fs = makeSession({}, rgLinesHandler(['a1.ts', 'a2.ts', 'a3.ts', 'a4.ts']));
    const result = await fs.suggest({
      query: 'a',
      limit: 2,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('applies include_globs and exclude_globs after matching', async () => {
    const fs = makeSession({}, rgLinesHandler(['src/a.ts', 'src/a.md', 'dist/a.ts']));
    const included = await fs.suggest({
      query: 'a',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
      include_globs: ['**/*.ts'],
    });
    expect(included.items.map((i) => i.path)).toContain('src/a.ts');
    expect(included.items.map((i) => i.path)).not.toContain('src/a.md');
    const excluded = await fs.suggest({
      query: 'a',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
      exclude_globs: ['dist/**'],
    });
    expect(excluded.items.map((i) => i.path)).not.toContain('dist/a.ts');
  });

  it('falls back to the node walk when rg is unavailable', async () => {
    const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
    const fs = makeSession(
      {
        'src/foo.ts': '',
        'src/nested/bar.ts': '',
        '.gitignore': 'ignored.ts\n',
        'ignored.ts': '',
      },
      rgMissingHandler,
      events,
      defaultGitStub(),
      ['src/link'],
    );
    const result = await fs.suggest({
      query: 'foo',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items.map((i) => i.path)).toContain('src/foo.ts');
    expect(events).toContainEqual({
      event: 'fs_suggest_node_fallback',
      properties: { reason: 'rg_missing' },
    });

    const pathResult = await fs.suggest({
      query: 'src/nested',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(pathResult.items.map((i) => i.path)).toContain('src/nested/bar.ts');

    const linkResult = await fs.suggest({
      query: 'link',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(linkResult.items.find((i) => i.path === 'src/link')?.kind).toBe('symlink');
    expect(linkResult.items.some((i) => i.path.startsWith('src/link/'))).toBe(false);

    const ignored = await fs.suggest({
      query: 'ignored',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(ignored.items.map((i) => i.path)).not.toContain('ignored.ts');
  });

  it('hides dot entries in the fallback walk unless show_hidden is set', async () => {
    const fs = makeSession({ '.secret.ts': '', 'plain.ts': '' }, rgMissingHandler);
    const off = await fs.suggest({
      query: 'ts',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(off.items.map((i) => i.path)).toEqual(['plain.ts']);
    const on = await fs.suggest({
      query: 'ts',
      limit: 50,
      follow_gitignore: true,
      show_hidden: true,
    });
    expect(on.items.map((i) => i.path)).toContain('.secret.ts');
  });

  it('falls back to the node walk when rg fails to spawn', async () => {
    const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
    const runner: IHostProcessService = {
      _serviceBrand: undefined,
      spawn: async (command, args) => {
        const all = [command, ...(args ?? [])];
        if (all[0] === 'rg' && all[1] === '--version') {
          return fakeProcess('ripgrep 15.0.0', '', 0);
        }
        throw new Error('spawn EAGAIN');
      },
    };
    const fs = makeSession({ 'src/foo.ts': '' }, emptyHandler, events, defaultGitStub(), [], runner);
    const result = await fs.suggest({
      query: 'foo',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items.map((i) => i.path)).toContain('src/foo.ts');
    expect(events).toContainEqual({
      event: 'fs_suggest_node_fallback',
      properties: { reason: 'rg_error' },
    });
  });

  it('falls back to the node walk when rg exits with an error status', async () => {
    const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
    const runner: IHostProcessService = {
      _serviceBrand: undefined,
      spawn: async (command, args) => {
        const all = [command, ...(args ?? [])];
        if (all[0] === 'rg' && all[1] === '--version') {
          return fakeProcess('ripgrep 15.0.0', '', 0);
        }
        return fakeProcess('', 'permission denied', 2);
      },
    };
    const fs = makeSession({ 'src/foo.ts': '' }, emptyHandler, events, defaultGitStub(), [], runner);
    const result = await fs.suggest({
      query: 'foo',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items.map((i) => i.path)).toContain('src/foo.ts');
    expect(events).toContainEqual({
      event: 'fs_suggest_node_fallback',
      properties: { reason: 'rg_error' },
    });
  });

  it('filters the root listing before applying the limit', async () => {
    const fs = makeSession({ 'aaa/x.ts': '', 'y.ts': '', 'z.ts': '' }, emptyHandler);
    const result = await fs.suggest({
      query: '',
      limit: 1,
      follow_gitignore: true,
      show_hidden: false,
      include_globs: ['**/*.ts'],
    });
    expect(result.items.map((i) => i.path)).toEqual(['y.ts']);
    expect(result.truncated).toBe(true);
  });

  it('merges rg candidates across roots with relative paths for the primary root only', async () => {
    const fs = makeSession(
      {
        'apps/desktop/package.json': '',
        '/extra/lib/util.ts': '',
        '/extra/README.md': '',
      },
      rgMultiRootHandler({
        '/repo': ['apps/desktop/package.json'],
        '/extra': ['lib/util.ts', 'README.md'],
      }),
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/extra'],
    );
    const pathResult = await fs.suggest({
      query: 'apps/de',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(pathResult.items[0]?.path).toBe('apps/desktop');
    const nameResult = await fs.suggest({
      query: 'util',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(nameResult.items.map((i) => i.path)).toContain('/extra/lib/util.ts');
    const readme = await fs.suggest({
      query: 'readme',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    const item = readme.items.find((i) => i.path === '/extra/README.md');
    expect(item?.match_positions).toEqual([7, 8, 9, 10, 11, 12]);
  });

  it('passes every root to rg as a path argument', async () => {
    const captured: string[][] = [];
    const fs = makeSession(
      { '/extra/x.ts': '' },
      rgMultiRootHandler({ '/repo': [], '/extra': ['x.ts'] }, captured),
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/extra'],
    );
    await fs.suggest({ query: 'x', limit: 50, follow_gitignore: true, show_hidden: false });
    const filesArgs = captured.find((a) => a.includes('--files'))!;
    expect(filesArgs).toContain('/repo');
    expect(filesArgs).toContain('/extra');
  });

  it('parses multi-root rg output joined with the windows path separator', async () => {
    const primaryRoot = win32Path.resolve(WORK_DIR);
    const extraRoot = win32Path.resolve('/extra');
    const fs = makeSession(
      { 'src/a.ts': '', '/extra/lib/util.ts': '' },
      (args) => {
        if (args[0] === 'rg' && args[1] === '--version') return { stdout: 'ripgrep 15.0.0', exitCode: 0 };
        if (args[0] === 'rg' && args.includes('--files')) {
          return { stdout: `${primaryRoot}\\src\\a.ts\n${extraRoot}\\lib\\util.ts\n`, exitCode: 0 };
        }
        return { stdout: '', exitCode: 0 };
      },
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/extra'],
      'win32',
    );
    const primary = await fs.suggest({ query: 'a.ts', limit: 50, follow_gitignore: true, show_hidden: false });
    expect(primary.items.map((i) => i.path)).toContain('src/a.ts');
    const extra = await fs.suggest({ query: 'util', limit: 50, follow_gitignore: true, show_hidden: false });
    expect(extra.items.map((i) => i.path)).toContain(`${extraRoot.split('\\').join('/')}/lib/util.ts`);
  });

  it('parses single-root rg output joined with the windows path separator', async () => {
    const fs = makeSession(
      { 'src/a.ts': '' },
      (args) => {
        if (args[0] === 'rg' && args[1] === '--version') return { stdout: 'ripgrep 15.0.0', exitCode: 0 };
        if (args[0] === 'rg' && args.includes('--files')) {
          return { stdout: 'src\\a.ts\n', exitCode: 0 };
        }
        return { stdout: '', exitCode: 0 };
      },
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      [],
      'win32',
    );
    const result = await fs.suggest({ query: 'a.ts', limit: 50, follow_gitignore: true, show_hidden: false });
    expect(result.items.map((i) => i.path)).toContain('src/a.ts');
  });

  it('deduplicates candidates when roots overlap', async () => {
    const fs = makeSession(
      { 'src/a.ts': '', '/other.ts': '' },
      rgMultiRootHandler({
        '/repo': ['src/a.ts'],
        '/': ['repo/src/a.ts', 'other.ts'],
      }),
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/'],
    );
    const result = await fs.suggest({
      query: 'ts',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    const paths = result.items.map((i) => i.path);
    expect(paths.filter((p) => p === 'src/a.ts')).toHaveLength(1);
    expect(paths).toContain('/other.ts');
  });

  it('skips an additional root contained in the primary root', async () => {
    const fs = makeSession(
      {},
      rgLinesHandler(['apps/desktop/package.json']),
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/repo/apps'],
    );
    const result = await fs.suggest({
      query: 'apps/de',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items.filter((i) => i.path === 'apps/desktop')).toHaveLength(1);
  });

  it('does not treat dot segments of an additional root itself as hidden', async () => {
    const fs = makeSession(
      { '/x/.config/kimi/foo.ts': '' },
      rgMultiRootHandler({
        '/repo': [],
        '/x/.config/kimi': ['foo.ts'],
      }),
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/x/.config/kimi'],
    );
    const result = await fs.suggest({
      query: 'foo',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items.map((i) => i.path)).toEqual(['/x/.config/kimi/foo.ts']);
  });

  it('applies the limit to the merged ranking across roots', async () => {
    const fs = makeSession(
      { 'a1.ts': '', '/extra/a2.ts': '', '/extra/a3.ts': '' },
      rgMultiRootHandler({
        '/repo': ['a1.ts'],
        '/extra': ['a2.ts', 'a3.ts'],
      }),
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/extra'],
    );
    const result = await fs.suggest({
      query: 'a',
      limit: 2,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('merges node-fallback candidates across roots with per-root gitignore', async () => {
    const fs = makeSession(
      {
        'src/foo.ts': '',
        '/extra/lib/foo-util.ts': '',
        '/extra/.gitignore': 'skip.ts\n',
        '/extra/skip.ts': '',
      },
      rgMissingHandler,
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/extra'],
    );
    const result = await fs.suggest({
      query: 'foo',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    const paths = result.items.map((i) => i.path);
    expect(paths).toContain('src/foo.ts');
    expect(paths).toContain('/extra/lib/foo-util.ts');
    const skipped = await fs.suggest({
      query: 'skip',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(skipped.items.map((i) => i.path)).toEqual([]);
  });

  it('lists top-level entries of every root for an empty query', async () => {
    const fs = makeSession(
      { 'src/foo.ts': '', 'README.md': '', '/extra/lib/util.ts': '', '/extra/notes.md': '' },
      emptyHandler,
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/extra'],
    );
    const result = await fs.suggest({
      query: '',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items.map((i) => i.path)).toEqual([
      'src',
      'README.md',
      '/extra/lib',
      '/extra/notes.md',
    ]);
    expect(result.truncated).toBe(false);
  });
});

describe('WorkspaceFsService.grep', () => {
  it('falls back to the node implementation when rg is unavailable', async () => {
    const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
    const fs = makeSession(
      { 'src/a.ts': 'hello world\nfoo bar\nhello again\n' },
      (args) => {
        if (args[0] === 'rg' && args[1] === '--version') return { stdout: '', exitCode: 1 };
        return { stdout: '', exitCode: 0 };
      },
      events,
    );
    const result = await fs.grep({
      pattern: 'hello',
      regex: false,
      case_sensitive: true,
      follow_gitignore: false,
      max_files: 200,
      max_matches_per_file: 50,
      max_total_matches: 5000,
      context_lines: 0,
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.matches).toHaveLength(2);
    expect(events).toContainEqual({
      event: 'fs_grep_node_fallback',
      properties: { reason: 'rg_missing' },
    });
  });

  it('uses rg when available and parses its JSON output', async () => {
    const rgJson = [
      JSON.stringify({ type: 'begin', data: { path: { text: 'src/a.ts' } } }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: 'src/a.ts' },
          lines: { text: 'hello world\n' },
          line_number: 1,
          submatches: [{ start: 0, end: 5 }],
        },
      }),
      JSON.stringify({ type: 'end', data: { path: { text: 'src/a.ts' } } }),
      '',
    ].join('\n');
    const fs = makeSession({}, (args) => {
      if (args[0] === 'rg' && args[1] === '--version') {
        return { stdout: 'ripgrep 14.1.0', exitCode: 0 };
      }
      if (args[0] === 'rg' && args.includes('--json')) return { stdout: rgJson, exitCode: 0 };
      return { stdout: '', exitCode: 0 };
    });
    const result = await fs.grep({
      pattern: 'hello',
      regex: false,
      case_sensitive: true,
      follow_gitignore: true,
      max_files: 200,
      max_matches_per_file: 50,
      max_total_matches: 5000,
      context_lines: 0,
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.matches[0]?.text).toBe('hello world');
  });

  it('stops rg as soon as max_total_matches is reached', async () => {
    const TOTAL = 200;
    const CAP = 5;
    const lines: string[] = [
      JSON.stringify({ type: 'begin', data: { path: { text: 'big.ts' } } }),
    ];
    for (let i = 0; i < TOTAL; i++) {
      lines.push(
        JSON.stringify({
          type: 'match',
          data: {
            path: { text: 'big.ts' },
            lines: { text: `hit ${i}\n` },
            line_number: i + 1,
            submatches: [{ start: 0, end: 3 }],
          },
        }),
      );
    }
    lines.push(JSON.stringify({ type: 'end', data: { path: { text: 'big.ts' } } }));

    let streaming: ReturnType<typeof makeStreamingProcess> | undefined;
    const runner: IHostProcessService = {
      _serviceBrand: undefined,
      spawn: async (command, args) => {
        const allArgs = [command, ...(args ?? [])];
        if (allArgs[0] === 'rg' && allArgs[1] === '--version') {
          return fakeProcess('ripgrep 14.1.0', '', 0);
        }
        streaming = makeStreamingProcess(lines);
        return streaming.proc;
      },
    };
    const fs = makeSession({}, emptyHandler, [], defaultGitStub(), [], runner);
    const result = await fs.grep({
      pattern: 'hit',
      regex: false,
      case_sensitive: true,
      follow_gitignore: true,
      max_files: 200,
      max_matches_per_file: 50,
      max_total_matches: CAP,
      context_lines: 0,
    });
    expect(result.truncated).toBe(true);
    expect(result.files[0]?.matches).toHaveLength(CAP);
    expect(streaming?.wasKilled()).toBe(true);
    expect(streaming?.yieldedLines()).toBeLessThan(TOTAL);
  });
});

describe('WorkspaceFsService.list', () => {
  it('lists files and directories with kinds', async () => {
    const fs = makeSession(
      { 'src/a.ts': '', 'src/sub/b.ts': '', 'README.md': '' },
      emptyHandler,
    );
    const result = await fs.list({
      path: '.',
      depth: 1,
      limit: 200,
      show_hidden: false,
      follow_gitignore: false,
      sort: 'name_asc',
      include_git_status: false,
    });
    const names = result.items.map((i) => i.name).toSorted();
    expect(names).toEqual(['README.md', 'src']);
    expect(result.items.find((i) => i.name === 'src')?.kind).toBe('directory');
  });

  it('returns children_by_path for depth > 1', async () => {
    const fs = makeSession({ 'src/a.ts': '', 'src/sub/b.ts': '' }, emptyHandler);
    const result = await fs.list({
      path: '.',
      depth: 2,
      limit: 200,
      show_hidden: false,
      follow_gitignore: false,
      sort: 'name_asc',
      include_git_status: false,
    });
    expect(result.children_by_path?.['src']?.map((i) => i.name).toSorted()).toEqual([
      'a.ts',
      'sub',
    ]);
  });

  it('rejects paths that escape the workspace', async () => {
    const fs = makeSession({}, emptyHandler);
    await expect(
      fs.list({
        path: '../etc',
        depth: 1,
        limit: 200,
        show_hidden: false,
        follow_gitignore: false,
        sort: 'name_asc',
        include_git_status: false,
      }),
    ).rejects.toMatchObject({ code: 'fs.path_escapes' });
  });
});

describe('fakeFs and makeSession infrastructure', () => {
  it('counts readText and readdir calls per path', async () => {
    const fsHandle = fakeFs({ 'src/a.ts': 'one', '.gitignore': 'b.ts\n', 'b.ts': '' });
    const fs = makeSession({}, rgMissingHandler, [], defaultGitStub(), [], undefined, {}, [], 'posix', stubLog(), fsHandle);
    await fs.search({ query: 'a', limit: 50, follow_gitignore: true });
    expect(fsHandle.readTextCalls.get(join(WORK_DIR, '.gitignore'))).toBe(1);
    expect(fsHandle.readdirCalls.get(WORK_DIR)).toBe(1);
    expect(fsHandle.readdirCalls.get(join(WORK_DIR, 'src'))).toBe(1);
    await fs.search({ query: 'a', limit: 50, follow_gitignore: true });
    expect(fsHandle.readTextCalls.get(join(WORK_DIR, '.gitignore'))).toBe(1);
    expect(fsHandle.readdirCalls.get(WORK_DIR)).toBe(2);
  });

  it('applies mid-test file rewrites and removals immediately', async () => {
    const fsHandle = fakeFs({ 'a.ts': '', 'b.ts': '' });
    const fs = makeSession({}, rgMissingHandler, [], defaultGitStub(), [], undefined, {}, [], 'posix', stubLog(), fsHandle);
    const first = await fs.search({ query: 'ts', limit: 50, follow_gitignore: false });
    expect(first.items.map((i) => i.path)).toEqual(['a.ts', 'b.ts']);
    fsHandle.setFile('c.ts', '');
    fsHandle.removeFile('a.ts');
    const second = await fs.search({ query: 'ts', limit: 50, follow_gitignore: false });
    expect(second.items.map((i) => i.path)).toEqual(['b.ts', 'c.ts']);
  });

  it('captures warn calls through the recording log stub injected via makeSession', async () => {
    const warns: Array<{ message: string; payload: unknown }> = [];
    const log = recordingLog(warns);
    const fs = makeSession({}, emptyHandler, [], defaultGitStub(), [], undefined, {}, [], 'posix', log);
    expect(host?.app.accessor.get(ILogService)).toBe(log);
    log.warn('project ignore rule file unreadable', { path: `${WORK_DIR}/.kimi-code/ignore` });
    expect(warns).toEqual([
      {
        message: 'project ignore rule file unreadable',
        payload: { path: `${WORK_DIR}/.kimi-code/ignore` },
      },
    ]);
    log.child({ scope: 'x' }).warn('nested warn');
    expect(warns).toHaveLength(2);
    expect(typeof fs.search).toBe('function');
  });

  it('injects a non-ENOENT readText error that propagates and is distinguishable from ENOENT', async () => {
    const fsHandle = fakeFs({ 'a.ts': 'keep', 'secret.ts': 'x' });
    const eacces = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
    eacces.code = 'EACCES';
    const permissionError = toHostFsError(eacces, { path: join(WORK_DIR, 'secret.ts'), op: 'read' });
    fsHandle.failReadText('secret.ts', permissionError);
    await expect(fsHandle.readText(join(WORK_DIR, 'secret.ts'))).rejects.toThrow(permissionError);
    const missing = await fsHandle.readText(join(WORK_DIR, 'missing.ts')).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(missing).toBeInstanceOf(HostFsError);
    expect((missing as HostFsError).code).toBe('os.fs.not_found');
    const unwrappedInjected = unwrapErrorCause(permissionError);
    expect((unwrappedInjected as NodeJS.ErrnoException).code).toBe('EACCES');
    const unwrappedMissing = unwrapErrorCause(missing);
    expect((unwrappedMissing as NodeJS.ErrnoException).code).toBe('ENOENT');
  });
});

describe('projectIgnore loading', () => {
  function rulePath(root: string): string {
    return patheJoin(root, '.kimi-code', 'ignore');
  }

  function load(
    fs: IHostFileSystem & FakeFsHandle,
    roots: readonly string[],
    pathClass: 'posix' | 'win32' = 'posix',
    log: Pick<ILogService, 'warn'> = stubLog(),
  ) {
    const options: ProjectIgnoreOptions = {
      roots,
      pathClass,
      fs: { readText: (p) => fs.readText(p) },
      log,
    };
    return loadProjectIgnore(options);
  }

  it('returns a non-hiding snapshot without warnings when rule files are missing', async () => {
    const warns: Array<{ message: string; payload: unknown }> = [];
    const fsHandle = fakeFs({ 'a.ts': '' });
    const snapshot = await load(fsHandle, [WORK_DIR, '/extra'], 'posix', recordingLog(warns));
    expect(snapshot.hidden(join(WORK_DIR, 'a.ts'))).toBe(false);
    expect(snapshot.hidden(`${WORK_DIR}/vendor/x`)).toBe(false);
    expect(warns).toHaveLength(0);
  });

  it('returns a non-hiding snapshot without warnings when the rule path is inside a file (ENOTDIR)', async () => {
    const warns: Array<{ message: string; payload: unknown }> = [];
    const fsHandle = fakeFs({ '.kimi-code': 'not a dir' });
    const snapshot = await load(fsHandle, [WORK_DIR], 'posix', recordingLog(warns));
    expect(snapshot.hidden(join(WORK_DIR, 'a.ts'))).toBe(false);
    expect(warns).toHaveLength(0);
  });

  it('empties the failing root, warns exactly once, and keeps other roots working without rejecting', async () => {
    const warns: Array<{ message: string; payload: unknown }> = [];
    const fsHandle = fakeFs({ '/extra/.kimi-code/ignore': 'vendor/\n' });
    const eacces = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
    eacces.code = 'EACCES';
    fsHandle.failReadText('.kimi-code/ignore', toHostFsError(eacces, { path: rulePath(WORK_DIR), op: 'read' }));
    const snapshot = await load(fsHandle, [WORK_DIR, '/extra'], 'posix', recordingLog(warns));
    expect(snapshot.hidden(join(WORK_DIR, 'vendor/x'))).toBe(false);
    expect(snapshot.hidden('/extra/vendor/x')).toBe(true);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.payload).toMatchObject({
      path: rulePath(WORK_DIR),
      error: expect.anything(),
    });
  });

  it('reads each deduplicated root exactly once', async () => {
    const fsHandle = fakeFs({ '.kimi-code/ignore': 'vendor/\n' });
    const snapshot = await load(fsHandle, [
      WORK_DIR,
      `${WORK_DIR}/`,
      patheNormalize(`${WORK_DIR}/sub/..`),
      '/extra',
    ]);
    expect(snapshot.hidden(join(WORK_DIR, 'vendor/x'))).toBe(true);
    expect(fsHandle.readTextCalls.get(rulePath(WORK_DIR))).toBe(1);
    expect(fsHandle.readTextCalls.get(rulePath('/extra'))).toBe(1);
  });

  it('does not hide anything for empty, comment-only, or negation-only rule files', async () => {
    const fsHandle = fakeFs({
      '.kimi-code/ignore': '',
      '/empty2/.kimi-code/ignore': '# only a comment\n',
      '/empty3/.kimi-code/ignore': '!keep\n',
      'vendor/x': '',
    });
    const snapshot = await load(fsHandle, [WORK_DIR, '/empty2', '/empty3']);
    expect(snapshot.hidden(join(WORK_DIR, 'vendor/x'))).toBe(false);
    expect(snapshot.hidden('/empty2/vendor/x')).toBe(false);
    expect(snapshot.hidden('/empty3/keep/x')).toBe(false);
  });

  it('ignores .gitignore content in the same root', async () => {
    const plain = fakeFs({ 'vendor/x': '' });
    const withGitignore = fakeFs({ '.gitignore': 'vendor/\n', 'vendor/x': '' });
    const plainSnapshot = await load(plain, [WORK_DIR]);
    const gitSnapshot = await load(withGitignore, [WORK_DIR]);
    expect(gitSnapshot.hidden(join(WORK_DIR, 'vendor/x'))).toBe(plainSnapshot.hidden(join(WORK_DIR, 'vendor/x')));
    expect(gitSnapshot.hidden(join(WORK_DIR, 'vendor/x'))).toBe(false);
  });

  it('reflects rule file rewrites on a second load', async () => {
    const fsHandle = fakeFs({ '.kimi-code/ignore': 'vendor/\n' });
    const first = await load(fsHandle, [WORK_DIR]);
    expect(first.hidden(join(WORK_DIR, 'vendor/x'))).toBe(true);
    fsHandle.setFile('.kimi-code/ignore', 'dist/\n');
    const second = await load(fsHandle, [WORK_DIR]);
    expect(second.hidden(join(WORK_DIR, 'vendor/x'))).toBe(false);
    expect(second.hidden(join(WORK_DIR, 'dist/x'))).toBe(true);
    expect(first.hidden(join(WORK_DIR, 'vendor/x'))).toBe(true);
  });

  it('reads each rule file from pathe.join(root, .kimi-code, ignore)', async () => {
    const fsHandle = fakeFs({ '/extra/.kimi-code/ignore': '' });
    await load(fsHandle, [WORK_DIR, '/extra']);
    expect([...fsHandle.readTextCalls.keys()]).toEqual([rulePath(WORK_DIR), rulePath('/extra')]);
  });
});

describe('projectIgnore predicates', () => {
  function load(
    fs: IHostFileSystem & FakeFsHandle,
    roots: readonly string[],
    pathClass: 'posix' | 'win32' = 'posix',
  ) {
    return loadProjectIgnore({
      roots,
      pathClass,
      fs: { readText: (p) => fs.readText(p) },
      log: stubLog(),
    });
  }

  it('hides directory-rule descendants and nested matches but not a same-named file', async () => {
    const fsHandle = fakeFs({ '.kimi-code/ignore': 'vendor/\n' });
    const snapshot = await load(fsHandle, [WORK_DIR]);
    expect(snapshot.hidden(join(WORK_DIR, 'vendor/v.txt'))).toBe(true);
    expect(snapshot.hidden(join(WORK_DIR, 'sub/vendor/x'))).toBe(true);
    expect(snapshot.hidden(join(WORK_DIR, 'vendor'))).toBe(false);
  });

  it('anchors root-level rules to the owning root', async () => {
    const fsHandle = fakeFs({ '.kimi-code/ignore': '/data/\n' });
    const snapshot = await load(fsHandle, [WORK_DIR]);
    expect(snapshot.hidden(join(WORK_DIR, 'data/a'))).toBe(true);
    expect(snapshot.hidden(join(WORK_DIR, 'sub/data/a'))).toBe(false);
  });

  it('assigns nested roots to their own rules only', async () => {
    const r1 = WORK_DIR;
    const r2 = `${WORK_DIR}/libs/x`;
    const fsHandle = fakeFs({ '.kimi-code/ignore': 'libs/\n' });
    const snapshot = await load(fsHandle, [r1, r2]);
    expect(snapshot.hidden(`${r2}/b.ts`)).toBe(false);
    expect(snapshot.hidden(join(WORK_DIR, 'libs/y/z'))).toBe(true);
    const nestedHandle = fakeFs({ '.kimi-code/ignore': 'libs/\n', 'libs/x/.kimi-code/ignore': 'secret/\n' });
    const nestedSnapshot = await load(nestedHandle, [r1, r2]);
    expect(nestedSnapshot.hidden(join(WORK_DIR, 'secret/f'))).toBe(false);
    expect(nestedSnapshot.hidden(`${r2}/secret/f`)).toBe(true);
  });

  it('never hides out-of-root paths or the root itself, even with a wildcard rule', async () => {
    const fsHandle = fakeFs({ '.kimi-code/ignore': '*\n' });
    const snapshot = await load(fsHandle, [WORK_DIR]);
    expect(snapshot.hidden('/elsewhere/a.ts')).toBe(false);
    expect(snapshot.hidden(WORK_DIR)).toBe(false);
    expect(snapshot.hidden(join(WORK_DIR, 'a.ts'))).toBe(true);
    expect(snapshot.hidden(join(WORK_DIR, 'sub/a.ts'))).toBe(true);
  });

  it('matches win32 roots case-insensitively across separators and posix roots case-sensitively', async () => {
    const fsHandle = fakeFs({ '.kimi-code/ignore': 'vendor/\n' });
    const winSnapshot = await load(fsHandle, [WORK_DIR], 'win32');
    expect(winSnapshot.hidden(`${WORK_DIR.replace('/repo', '/REPO')}\\vendor\\x`)).toBe(true);
    const posixSnapshot = await load(fsHandle, [WORK_DIR], 'posix');
    expect(posixSnapshot.hidden('/REPO/vendor/x')).toBe(false);
  });

  it('denies pruning when a root lies strictly inside the directory', async () => {
    const fsHandle = fakeFs({ '.kimi-code/ignore': 'libs/\n' });
    const withNested = await load(fsHandle, [WORK_DIR, `${WORK_DIR}/libs/x`]);
    expect(withNested.canPrune(join(WORK_DIR, 'libs'))).toBe(false);
    const withoutNested = await load(fsHandle, [WORK_DIR]);
    expect(withoutNested.canPrune(join(WORK_DIR, 'libs'))).toBe(true);
  });

  it('returns false without throwing for invalid relative forms', async () => {
    const fsHandle = fakeFs({ '.kimi-code/ignore': 'vendor/\n' });
    const snapshot = await load(fsHandle, [WORK_DIR]);
    expect(snapshot.hidden(join(WORK_DIR, '...'))).toBe(false);
    expect(snapshot.hidden(join(WORK_DIR, '.../x'))).toBe(false);
    expect(snapshot.hidden(join(WORK_DIR, '...'), true)).toBe(false);
  });

  it('never throws for arbitrary inputs', async () => {
    const fsHandle = fakeFs({ '.kimi-code/ignore': 'vendor/\n' });
    const snapshot = await load(fsHandle, [WORK_DIR, `${WORK_DIR}/libs/x`]);
    expect(() => snapshot.hidden('')).not.toThrow();
    expect(snapshot.hidden('')).toBe(false);
    expect(() => snapshot.hidden('/abs/path')).not.toThrow();
    expect(() => snapshot.hidden('relative/path')).not.toThrow();
    expect(() => snapshot.canPrune('')).not.toThrow();
    expect(() => snapshot.canPrune(join(WORK_DIR, 'libs'))).not.toThrow();
    expect(() => snapshot.canPrune('C:\\')).not.toThrow();
  });
});

describe('WorkspaceFsService.read', () => {
  it('reads utf-8 content with metadata', async () => {
    const fs = makeSession({ 'src/a.ts': 'hello\nworld\n' }, emptyHandler);
    const result = await fs.read({
      path: 'src/a.ts',
      offset: 0,
      length: 1024,
      encoding: 'utf-8',
    });
    expect(result.content).toBe('hello\nworld\n');
    expect(result.encoding).toBe('utf-8');
    expect(result.size).toBe('hello\nworld\n'.length);
    expect(result.line_count).toBe(2);
    expect(result.mime).toBe('text/typescript');
    expect(result.is_binary).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('honors offset and length and sets truncated', async () => {
    const fs = makeSession({ 'a.txt': 'hello world' }, emptyHandler);
    const result = await fs.read({ path: 'a.txt', offset: 0, length: 5, encoding: 'utf-8' });
    expect(result.content).toBe('hello');
    expect(result.truncated).toBe(true);
  });

  it('returns base64 for binary content in auto mode', async () => {
    const fs = makeSession({ 'bin.dat': 'abc\u0000def' }, emptyHandler);
    const result = await fs.read({ path: 'bin.dat', offset: 0, length: 1024, encoding: 'auto' });
    expect(result.encoding).toBe('base64');
    expect(result.is_binary).toBe(true);
    expect(result.content).toBe(Buffer.from('abc\u0000def').toString('base64'));
  });

  it('throws fs.is_binary for binary content in utf-8 mode', async () => {
    const fs = makeSession({ 'bin.dat': 'abc\u0000def' }, emptyHandler);
    await expect(
      fs.read({ path: 'bin.dat', offset: 0, length: 1024, encoding: 'utf-8' }),
    ).rejects.toMatchObject({ code: 'fs.is_binary' });
  });

  it('transcodes UTF-16 text with a BOM instead of throwing fs.is_binary', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello\nworld\n', 'utf16le')]);
    const fs = makeSession({ 'notes.txt': utf16 }, emptyHandler);
    const result = await fs.read({ path: 'notes.txt', offset: 0, length: 1024, encoding: 'utf-8' });
    expect(result.content).toBe('hello\nworld\n');
    expect(result.encoding).toBe('utf-8');
    expect(result.is_binary).toBe(false);
    expect(result.line_count).toBe(2);
    expect(result.mime).toBe('text/plain');
    expect(result.truncated).toBe(false);
  });

  it('transcodes BOM-less UTF-16 text in auto mode', async () => {
    const fs = makeSession({ 'notes.txt': Buffer.from('hello\n', 'utf16le') }, emptyHandler);
    const result = await fs.read({ path: 'notes.txt', offset: 0, length: 1024, encoding: 'auto' });
    expect(result.content).toBe('hello\n');
    expect(result.encoding).toBe('utf-8');
    expect(result.is_binary).toBe(false);
  });

  it('transcodes BOM-marked UTF-16 content that never looks binary (CJK-only)', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('你好世界', 'utf16le')]);
    const fs = makeSession({ 'notes.txt': utf16 }, emptyHandler);
    const result = await fs.read({ path: 'notes.txt', offset: 0, length: 1024, encoding: 'utf-8' });
    expect(result.content).toBe('你好世界');
    expect(result.encoding).toBe('utf-8');
    expect(result.is_binary).toBe(false);
  });

  it('windows the decoded UTF-8 bytes when transcoding', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello world', 'utf16le')]);
    const fs = makeSession({ 'notes.txt': utf16 }, emptyHandler);
    const result = await fs.read({ path: 'notes.txt', offset: 0, length: 5, encoding: 'utf-8' });
    expect(result.content).toBe('hello');
    expect(result.truncated).toBe(true);
  });

  it('keeps raw bytes for base64 requests on UTF-16 files', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')]);
    const fs = makeSession({ 'notes.txt': utf16 }, emptyHandler);
    const result = await fs.read({ path: 'notes.txt', offset: 0, length: 1024, encoding: 'base64' });
    expect(result.encoding).toBe('base64');
    expect(result.is_binary).toBe(true);
    expect(result.content).toBe(utf16.toString('base64'));
  });

  it('reads UTF-8 Chinese log content as text instead of throwing fs.is_binary', async () => {
    const log = '2026-08-16 INFO 启动完成 ✅\n2026-08-16 INFO 处理请求 🚀 成功\n'.repeat(50);
    const fs = makeSession({ 'app.log': log }, emptyHandler);
    const result = await fs.read({
      path: 'app.log',
      offset: 0,
      length: 1024 * 1024,
      encoding: 'utf-8',
    });
    expect(result.content).toBe(log);
    expect(result.encoding).toBe('utf-8');
    expect(result.is_binary).toBe(false);
    expect(result.mime).toBe('text/plain');
    expect(result.truncated).toBe(false);
  });

  it('returns utf-8 rather than base64 for UTF-8 Chinese text in auto mode', async () => {
    const fs = makeSession({ 'app.log': '中文日志 ✅\n' }, emptyHandler);
    const result = await fs.read({ path: 'app.log', offset: 0, length: 1024, encoding: 'auto' });
    expect(result.content).toBe('中文日志 ✅\n');
    expect(result.encoding).toBe('utf-8');
    expect(result.is_binary).toBe(false);
  });

  it('throws fs.is_directory for a directory', async () => {
    const fs = makeSession({ 'src/a.ts': '' }, emptyHandler);
    await expect(
      fs.read({ path: 'src', offset: 0, length: 1024, encoding: 'auto' }),
    ).rejects.toMatchObject({ code: 'fs.is_directory' });
  });
});

describe('WorkspaceFsService.stat', () => {
  it('returns a file entry with mime', async () => {
    const fs = makeSession({ 'src/a.ts': 'content' }, emptyHandler);
    const entry = await fs.stat({ path: 'src/a.ts' });
    expect(entry.kind).toBe('file');
    expect(entry.size).toBe('content'.length);
    expect(entry.mime).toBe('text/typescript');
    expect(entry.name).toBe('a.ts');
  });

  it('throws fs.path_not_found for a missing path', async () => {
    const fs = makeSession({}, emptyHandler);
    await expect(fs.stat({ path: 'nope' })).rejects.toMatchObject({ code: 'fs.path_not_found' });
  });
});

describe('WorkspaceFsService.statMany', () => {
  it('returns null per missing path and entries for present ones', async () => {
    const fs = makeSession({ 'a.txt': 'hi' }, emptyHandler);
    const result = await fs.statMany({ paths: ['a.txt', 'missing.txt'] });
    expect(result.entries['a.txt']?.kind).toBe('file');
    expect(result.entries['missing.txt']).toBeNull();
  });
});

describe('WorkspaceFsService.listMany', () => {
  it('returns results per path and partial_errors for failures', async () => {
    const fs = makeSession({ 'a.txt': '' }, emptyHandler);
    const result = await fs.listMany({
      paths: ['.', 'missing'],
      depth: 1,
      limit: 200,
      show_hidden: false,
      follow_gitignore: false,
      sort: 'name_asc',
      include_git_status: false,
    });
    expect(result.results['.']?.map((i) => i.name)).toContain('a.txt');
    expect(result.partial_errors?.['missing']).toMatchObject({ code: 40409 });
  });
});

describe('WorkspaceFsService.mkdir', () => {
  it('creates a directory and returns its entry', async () => {
    const fs = makeSession({}, emptyHandler);
    const entry = await fs.mkdir({ path: 'newdir', recursive: false });
    expect(entry.kind).toBe('directory');
    expect(entry.name).toBe('newdir');
  });

  it('throws fs.already_exists when the directory exists (non-recursive)', async () => {
    const fs = makeSession({ 'src/a.ts': '' }, emptyHandler);
    await expect(fs.mkdir({ path: 'src', recursive: false })).rejects.toMatchObject({
      code: 'fs.already_exists',
    });
  });
});

describe('WorkspaceFsService.resolvePath', () => {
  it('returns absolute, relative, and isDirectory', async () => {
    const fs = makeSession({ 'src/a.ts': '' }, emptyHandler);
    const res = await fs.resolvePath('src/a.ts');
    expect(res.relative).toBe('src/a.ts');
    expect(res.isDirectory).toBe(false);
    expect(res.absolute).toContain('src/a.ts');
  });
});

describe('WorkspaceFsService.resolveDownload', () => {
  it('returns size, etag, mime, modifiedAt', async () => {
    const fs = makeSession({ 'a.txt': 'hello' }, emptyHandler);
    const res = await fs.resolveDownload('a.txt');
    expect(res.size).toBe('hello'.length);
    expect(res.mime).toBe('text/plain');
    expect(res.etag).toBeTypeOf('string');
    expect(res.modifiedAt).toBeInstanceOf(Date);
  });

  it('resolves a UTF-8 Chinese log as text/plain', async () => {
    const fs = makeSession({ 'app.log': '启动完成 ✅ 中文日志内容\n'.repeat(20) }, emptyHandler);
    const res = await fs.resolveDownload('app.log');
    expect(res.mime).toBe('text/plain');
  });

  it('throws fs.is_directory for a directory', async () => {
    const fs = makeSession({ 'src/a.ts': '' }, emptyHandler);
    await expect(fs.resolveDownload('src')).rejects.toMatchObject({ code: 'fs.is_directory' });
  });
});

describe('WorkspaceFsService symlink confinement', () => {
  const escapeTargets = { docs: '/outside' };

  function escapeSession(): IWorkspaceFsService {
    return makeSession(
      { 'src/a.ts': '' },
      emptyHandler,
      [],
      defaultGitStub(),
      [],
      undefined,
      escapeTargets,
    );
  }

  it('rejects reads that escape through a symlinked directory', async () => {
    const fs = escapeSession();
    await expect(
      fs.read({ path: 'docs/secret.txt', offset: 0, length: 1024, encoding: 'utf-8' }),
    ).rejects.toMatchObject({ code: 'fs.path_escapes' });
  });

  it('rejects list through a symlinked directory', async () => {
    const fs = escapeSession();
    await expect(
      fs.list({
        path: 'docs',
        depth: 1,
        limit: 200,
        show_hidden: false,
        follow_gitignore: false,
        sort: 'name_asc',
        include_git_status: false,
      }),
    ).rejects.toMatchObject({ code: 'fs.path_escapes' });
  });

  it('rejects stat, mkdir, resolvePath and resolveDownload through a symlinked directory', async () => {
    const fs = escapeSession();
    await expect(fs.stat({ path: 'docs/secret.txt' })).rejects.toMatchObject({
      code: 'fs.path_escapes',
    });
    await expect(fs.mkdir({ path: 'docs/newdir', recursive: true })).rejects.toMatchObject({
      code: 'fs.path_escapes',
    });
    await expect(fs.resolvePath('docs/secret.txt')).rejects.toMatchObject({
      code: 'fs.path_escapes',
    });
    await expect(fs.resolveDownload('docs/secret.txt')).rejects.toMatchObject({
      code: 'fs.path_escapes',
    });
  });

  it('rejects statMany when any path escapes through a symlinked directory', async () => {
    const fs = escapeSession();
    await expect(fs.statMany({ paths: ['docs/secret.txt'] })).rejects.toMatchObject({
      code: 'fs.path_escapes',
    });
  });

  it('still allows a symlink whose target stays inside the workspace', async () => {
    const fs = makeSession(
      { 'real/a.txt': 'hi' },
      emptyHandler,
      [],
      defaultGitStub(),
      [],
      undefined,
      { link: '/repo/real' },
    );
    const entry = await fs.stat({ path: 'link' });
    expect(entry.kind).toBe('symlink');
  });

  it('still resolves ordinary in-workspace paths', async () => {
    const fs = makeSession({ 'src/a.ts': 'content' }, emptyHandler);
    const res = await fs.read({ path: 'src/a.ts', offset: 0, length: 1024, encoding: 'utf-8' });
    expect(res.content).toBe('content');
  });
});

describe('WorkspaceFsService project ignore (rg replay)', () => {
  function rgJsonHandler(records: readonly object[]): RunHandler {
    return (args) => {
      if (args[0] === 'rg' && args[1] === '--version') {
        return { stdout: 'ripgrep 15.0.0', exitCode: 0 };
      }
      if (args[0] === 'rg' && args.includes('--json')) {
        return { stdout: `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, exitCode: 0 };
      }
      return { stdout: '', exitCode: 0 };
    };
  }

  function replaySession(
    handler: RunHandler,
    fsHandle: IHostFileSystem & FakeFsHandle,
    additionalDirs: readonly string[] = [],
  ): IWorkspaceFsService {
    return makeSession({}, handler, [], defaultGitStub(), [], undefined, {}, additionalDirs, 'posix', stubLog(), fsHandle);
  }

  function suggestRequest(query: string, followGitignore: boolean) {
    return {
      query,
      limit: 50,
      follow_gitignore: followGitignore,
      show_hidden: false,
    };
  }

  function grepRequest() {
    return {
      pattern: 'hello',
      regex: false,
      case_sensitive: true,
      follow_gitignore: true,
      max_files: 200,
      max_matches_per_file: 50,
      max_total_matches: 5000,
      context_lines: 0,
    };
  }

  function grepRecords(paths: readonly string[]): object[] {
    const records: object[] = [];
    for (const p of paths) {
      records.push({ type: 'begin', data: { path: { text: p } } });
      records.push({
        type: 'match',
        data: {
          path: { text: p } as never,
          lines: { text: 'hello\n' },
          line_number: 1,
          submatches: [{ start: 0, end: 5 }],
        },
      });
      records.push({ type: 'end', data: { path: { text: p } } });
    }
    return records;
  }

  it('A1: suggest filters vendor files and vendor directory candidates for a vendor/ rule', async () => {
    const fsHandle = fakeFs({ '.kimi-code/ignore': 'vendor/\n', 'src/a.ts': '' });
    const fs = replaySession(
      rgLinesHandler(['src/a.ts', 'vendor/lib.js', 'vendor/sub/v.js']),
      fsHandle,
    );
    const on = await fs.suggest(suggestRequest('vendor', true));
    const onPaths = on.items.map((i) => i.path);
    expect(onPaths).not.toContain('vendor');
    expect(onPaths).not.toContain('vendor/lib.js');
    expect(onPaths).not.toContain('vendor/sub');
    expect(onPaths).not.toContain('vendor/sub/v.js');

    const off = await fs.suggest(suggestRequest('vendor', false));
    const offPaths = off.items.map((i) => i.path);
    expect(offPaths).not.toContain('vendor');
    expect(offPaths).not.toContain('vendor/lib.js');
    expect(offPaths).not.toContain('vendor/sub/v.js');

    const files = await fs.suggest(suggestRequest('ts', true));
    expect(files.items.map((i) => i.path)).toContain('src/a.ts');
  });

  it('A2: grep filters vendor hits and does not count vendor files in files_scanned', async () => {
    const fsHandle = fakeFs({ '.kimi-code/ignore': 'vendor/\n', 'src/a.ts': 'hello\n' });
    const fs = replaySession(
      rgJsonHandler(grepRecords(['src/a.ts', 'vendor/v.ts'])),
      fsHandle,
    );
    const result = await fs.grep(grepRequest());
    expect(result.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(result.files_scanned).toBe(1);
    expect(result.files[0]?.matches[0]?.text).toBe('hello');
  });

  it('A3: nested additional dir under a libs/ rule stays visible while siblings are hidden', async () => {
    const fsHandle = fakeFs({
      '.kimi-code/ignore': 'libs/\n',
      'libs/x/b.ts': '',
      'libs/y/c.ts': '',
      'src/a.ts': '',
    });
    const fs = replaySession(
      rgLinesHandler(['libs/x/b.ts', 'libs/y/c.ts', 'src/a.ts']),
      fsHandle,
      ['/repo/libs/x'],
    );
    const byName = await fs.suggest(suggestRequest('b', true));
    const namePaths = byName.items.map((i) => i.path);
    expect(namePaths).toContain('libs/x/b.ts');
    expect(namePaths).not.toContain('libs/y/c.ts');
    expect(namePaths).not.toContain('libs');
    expect(namePaths).not.toContain('libs/y');
    const byPath = await fs.suggest(suggestRequest('ts', true));
    const tsPaths = byPath.items.map((i) => i.path);
    expect(tsPaths).toContain('libs/x/b.ts');
    expect(tsPaths).toContain('src/a.ts');
    expect(tsPaths).not.toContain('libs/y/c.ts');
    const dirOnly = await fs.suggest(suggestRequest('libs', true));
    expect(dirOnly.items.map((i) => i.path)).toEqual([]);
  });

  it('A3: a non-nested additional dir is not affected by the primary root rule', async () => {
    const fsHandle = fakeFs({
      '.kimi-code/ignore': 'libs/\n',
      'libs/y/c.ts': '',
      '/extra/libs/z.ts': '',
    });
    const fs = replaySession(
      rgMultiRootHandler({
        '/repo': ['libs/y/c.ts'],
        '/extra': ['libs/z.ts'],
      }),
      fsHandle,
      ['/extra'],
    );
    const result = await fs.suggest(suggestRequest('ts', true));
    const paths = result.items.map((i) => i.path);
    expect(paths).toContain('/extra/libs/z.ts');
    expect(paths).not.toContain('libs/y/c.ts');
    expect(paths).not.toContain('libs/y');
  });

  it('A4: a gitignore negation does not unhide entries blocked by the rule file', async () => {
    const fsHandle = fakeFs({
      '.gitignore': '!keep/\n',
      '.kimi-code/ignore': 'keep/\n',
      'keep/k.ts': '',
      'src/a.ts': '',
    });
    const fs = replaySession(rgLinesHandler(['keep/k.ts', 'src/a.ts']), fsHandle);
    const kept = await fs.suggest(suggestRequest('keep', true));
    expect(kept.items.map((i) => i.path)).toEqual([]);
    const files = await fs.suggest(suggestRequest('ts', true));
    expect(files.items.map((i) => i.path)).toEqual(['src/a.ts']);
  });

  it('A5: a *.log rule still returns directory candidates containing only blocked files', async () => {
    const fsHandle = fakeFs({ '.kimi-code/ignore': '*.log\n', 'logs/a.log': '', 'logs/keep.ts': '' });
    const fs = replaySession(
      rgLinesHandler(['logs/a.log', 'logs/keep.ts', 'src/b.ts']),
      fsHandle,
    );
    const byName = await fs.suggest(suggestRequest('keep', true));
    expect(byName.items.map((i) => i.path)).toEqual(['logs/keep.ts']);
    const byPath = await fs.suggest(suggestRequest('logs/', true));
    const paths = byPath.items.map((i) => i.path);
    expect(paths).toContain('logs');
    expect(paths).toContain('logs/keep.ts');
    expect(paths).not.toContain('logs/a.log');
  });

  it('A6: without a rule file the rg output is unchanged', async () => {
    const fsHandle = fakeFs({ 'vendor/v.ts': '', 'src/a.ts': '' });
    const fs = replaySession(rgLinesHandler(['vendor/v.ts', 'src/a.ts']), fsHandle);
    const byName = await fs.suggest(suggestRequest('vendor', true));
    expect(byName.items.map((i) => i.path)).toContain('vendor');
    const byPath = await fs.suggest(suggestRequest('vendor/', true));
    const paths = byPath.items.map((i) => i.path);
    expect(paths).toContain('vendor');
    expect(paths).toContain('vendor/v.ts');
    const files = await fs.suggest(suggestRequest('ts', true));
    expect(files.items.map((i) => i.path)).toContain('src/a.ts');
  });

  it('A7: suggest reads each root rule file exactly once per call', async () => {
    const fsHandle = fakeFs({ '.kimi-code/ignore': 'vendor/\n', 'src/foo.ts': '' });
    const fs = replaySession(rgLinesHandler(['src/foo.ts']), fsHandle);
    await fs.suggest(suggestRequest('foo', true));
    expect(fsHandle.readTextCalls.get(join(WORK_DIR, '.kimi-code', 'ignore'))).toBe(1);
    await fs.suggest(suggestRequest('foo', true));
    expect(fsHandle.readTextCalls.get(join(WORK_DIR, '.kimi-code', 'ignore'))).toBe(2);
  });

  it('A7: grep reads each root rule file exactly once per call', async () => {
    const fsHandle = fakeFs({ '.kimi-code/ignore': 'vendor/\n', 'src/a.ts': 'hello\n' });
    const fs = replaySession(rgJsonHandler(grepRecords(['src/a.ts'])), fsHandle);
    await fs.grep(grepRequest());
    expect(fsHandle.readTextCalls.get(join(WORK_DIR, '.kimi-code', 'ignore'))).toBe(1);
    await fs.grep(grepRequest());
    expect(fsHandle.readTextCalls.get(join(WORK_DIR, '.kimi-code', 'ignore'))).toBe(2);
  });

  it('A7: both roots are read exactly once for a multi-root call', async () => {
    const fsHandle = fakeFs({
      '.kimi-code/ignore': 'vendor/\n',
      '/extra/.kimi-code/ignore': '',
      'src/foo.ts': '',
      '/extra/bar.ts': '',
    });
    const fs = replaySession(
      rgMultiRootHandler({ '/repo': ['src/foo.ts'], '/extra': ['bar.ts'] }),
      fsHandle,
      ['/extra'],
    );
    await fs.suggest(suggestRequest('foo', true));
    expect(fsHandle.readTextCalls.get(join(WORK_DIR, '.kimi-code', 'ignore'))).toBe(1);
    expect(fsHandle.readTextCalls.get('/extra/.kimi-code/ignore')).toBe(1);
  });

  it('A7: a suggest call falling back to the node walk still loads the snapshot once per root', async () => {
    const fsHandle = fakeFs({ '.kimi-code/ignore': 'vendor/\n', 'src/foo.ts': '' });
    const fs = replaySession(rgMissingHandler, fsHandle);
    const result = await fs.suggest(suggestRequest('foo', true));
    expect(result.items.map((i) => i.path)).toContain('src/foo.ts');
    expect(fsHandle.readTextCalls.get(join(WORK_DIR, '.kimi-code', 'ignore'))).toBe(1);
  });

  it('cross-carrier: nested root under a main-root libs/ rule keeps libs/x visible and libs/y hidden (suggest)', async () => {
    const fsHandle = fakeFs({
      '.kimi-code/ignore': 'libs/\n',
      'libs/x/b.ts': '',
      'libs/y/c.ts': '',
    });
    const fs = replaySession(
      rgLinesHandler(['libs/x/b.ts', 'libs/y/c.ts']),
      fsHandle,
      ['/repo/libs/x'],
    );
    const result = await fs.suggest(suggestRequest('ts', true));
    expect(result.items.map((i) => i.path)).toEqual(['libs/x/b.ts']);
  });

  it('cross-carrier: nested root under a main-root libs/ rule keeps libs/x visible and libs/y hidden (grep)', async () => {
    const fsHandle = fakeFs({
      '.kimi-code/ignore': 'libs/\n',
      'libs/x/b.ts': 'hello\n',
      'libs/y/c.ts': 'hello\n',
    });
    const fs = replaySession(
      rgJsonHandler(grepRecords(['libs/x/b.ts', 'libs/y/c.ts'])),
      fsHandle,
      ['/repo/libs/x'],
    );
    const result = await fs.grep(grepRequest());
    expect(result.files.map((f) => f.path)).toEqual(['libs/x/b.ts']);
    expect(result.files_scanned).toBe(1);
  });

  it('A7: a grep call falling back to the node walk still loads the snapshot once per root', async () => {
    const fsHandle = fakeFs({ '/extra/.kimi-code/ignore': 'vendor/\n', 'src/a.ts': 'hello\n' });
    const fs = replaySession(rgMissingHandler, fsHandle, ['/extra']);
    const result = await fs.grep(grepRequest());
    expect(result.files.map((f) => f.path)).toContain('src/a.ts');
    expect(fsHandle.readTextCalls.get('/extra/.kimi-code/ignore')).toBe(1);
  });

  it('A3: a non-ENOENT rule read warns exactly once with the rule path and returns the no-rule result', async () => {
    const warns: Array<{ message: string; payload: unknown }> = [];
    const ruleFile = join(WORK_DIR, '.kimi-code', 'ignore');
    const files = { 'vendor/v.ts': '', 'src/a.ts': '' };
    const failingHandle = fakeFs(files);
    const eacces = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
    eacces.code = 'EACCES';
    failingHandle.failReadText('.kimi-code/ignore', toHostFsError(eacces, { path: ruleFile, op: 'read' }));
    const failing = makeSession(
      {},
      rgLinesHandler(['vendor/v.ts', 'src/a.ts']),
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      [],
      'posix',
      recordingLog(warns),
      failingHandle,
    );
    const plain = makeSession(
      {},
      rgLinesHandler(['vendor/v.ts', 'src/a.ts']),
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      [],
      'posix',
      recordingLog([]),
      fakeFs(files),
    );

    const failingResult = await failing.suggest(suggestRequest('ts', false));
    const plainResult = await plain.suggest(suggestRequest('ts', false));

    expect(failingResult.items.map((i) => i.path)).toEqual(plainResult.items.map((i) => i.path));
    expect(failingResult.items.map((i) => i.path)).toContain('vendor/v.ts');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.message).toBe('project ignore rule file unreadable');
    const payload = warns[0]?.payload as { path: string; error: unknown };
    expect(payload.path).toBe(ruleFile);
    expect((unwrapErrorCause(payload.error) as NodeJS.ErrnoException).code).toBe('EACCES');
  });
});

describe('WorkspaceFsService project ignore (JS paths and lifecycle)', () => {
  const RULE_FILE = `${WORK_DIR}/.kimi-code/ignore`;

  function listRequest(partial: Partial<FsListRequest> = {}): FsListRequest {
    return {
      path: '.',
      depth: 1,
      limit: 200,
      show_hidden: false,
      follow_gitignore: false,
      sort: 'name_asc',
      include_git_status: false,
      ...partial,
    };
  }

  function jsSession(
    fsHandle: IHostFileSystem & FakeFsHandle,
    additionalDirs: readonly string[] = [],
  ): IWorkspaceFsService {
    return makeSession({}, rgMissingHandler, [], defaultGitStub(), [], undefined, {}, additionalDirs, 'posix', stubLog(), fsHandle);
  }

  it('A1: nested root under a main-root libs/ rule stays visible in search, suggest, and grep', async () => {
    const fsHandle = fakeFs({
      '.kimi-code/ignore': 'libs/\n',
      'libs/x/b.ts': 'hello\n',
      'libs/y/c.ts': 'hello\n',
      'src/a.ts': 'hello\n',
    });
    const fs = jsSession(fsHandle, [`${WORK_DIR}/libs/x`]);

    const searched = await fs.search({ query: 'ts', limit: 50, follow_gitignore: false });
    const searchPaths = searched.items.map((i) => i.path);
    expect(searchPaths).toContain('libs/x/b.ts');
    expect(searchPaths).toContain('src/a.ts');
    expect(searchPaths).not.toContain('libs');
    expect(searchPaths).not.toContain('libs/y');
    expect(searchPaths).not.toContain('libs/y/c.ts');

    const suggested = await fs.suggest({
      query: 'ts',
      limit: 50,
      follow_gitignore: false,
      show_hidden: false,
    });
    const suggestPaths = suggested.items.map((i) => i.path);
    expect(suggestPaths).toContain('libs/x/b.ts');
    expect(suggestPaths).toContain('src/a.ts');
    expect(suggestPaths).not.toContain('libs');
    expect(suggestPaths).not.toContain('libs/y');
    expect(suggestPaths).not.toContain('libs/y/c.ts');

    const grepped = await fs.grep({
      pattern: 'hello',
      regex: false,
      case_sensitive: true,
      follow_gitignore: false,
      max_files: 200,
      max_matches_per_file: 50,
      max_total_matches: 5000,
      context_lines: 0,
    });
    expect(grepped.files.map((f) => f.path)).toEqual(['libs/x/b.ts', 'src/a.ts']);
  });

  it('A1: without a nested root the walk never readdirs a prunable libs directory', async () => {
    const fsHandle = fakeFs({
      '.kimi-code/ignore': 'libs/\n',
      'libs/y/c.ts': '',
      'src/a.ts': '',
    });
    const fs = jsSession(fsHandle);
    const result = await fs.search({ query: 'ts', limit: 50, follow_gitignore: false });
    expect(result.items.map((i) => i.path)).toEqual(['src/a.ts']);
    expect(fsHandle.readdirCalls.get(`${WORK_DIR}/libs`)).toBeUndefined();

    const suggested = await fs.suggest({
      query: 'ts',
      limit: 50,
      follow_gitignore: false,
      show_hidden: false,
    });
    expect(suggested.items.map((i) => i.path)).toEqual(['src/a.ts']);
    expect(fsHandle.readdirCalls.get(`${WORK_DIR}/libs`)).toBeUndefined();
  });

  it('A2: list omits hidden entries, counts limit and truncated over visible entries only', async () => {
    const fsHandle = fakeFs({
      '.kimi-code/ignore': 'libs/\n',
      'libs/y/c.ts': '',
      'a.ts': '',
      'b.ts': '',
      'z.ts': '',
    });
    const fs = jsSession(fsHandle);
    const result = await fs.list(listRequest({ limit: 3 }));
    expect(result.items.map((i) => i.path)).toEqual(['a.ts', 'b.ts', 'z.ts']);
    expect(result.truncated).toBe(false);
  });

  it('A2: a wildcard rule empties the root listing without failing', async () => {
    const fsHandle = fakeFs({ '.kimi-code/ignore': '*\n', 'a.ts': '', 'src/b.ts': '' });
    const fs = jsSession(fsHandle);
    const result = await fs.list(listRequest());
    expect(result.items).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('A3: the empty-query suggest top level omits hidden entries', async () => {
    const fsHandle = fakeFs({
      '.kimi-code/ignore': 'libs/\n',
      'libs/y/c.ts': '',
      'src/a.ts': '',
      'README.md': '',
    });
    const fs = jsSession(fsHandle);
    const result = await fs.suggest({
      query: '',
      limit: 50,
      follow_gitignore: false,
      show_hidden: false,
    });
    const paths = result.items.map((i) => i.path);
    expect(paths).toContain('src');
    expect(paths).toContain('README.md');
    expect(paths).not.toContain('libs');
  });

  it('A4: a hidden unprunable dir matched by exclude_globs is not descended into', async () => {
    const fsHandle = fakeFs({
      '.kimi-code/ignore': 'libs/\n',
      'libs/x/b.ts': '',
      'libs/y/c.ts': '',
      'src/a.ts': '',
    });
    const fs = jsSession(fsHandle, [`${WORK_DIR}/libs/x`]);
    const result = await fs.list(listRequest({ depth: 2, exclude_globs: ['libs'] }));
    expect(result.items.map((i) => i.path)).toEqual(['src']);
    expect(result.children_by_path?.['libs']).toBeUndefined();
    expect(fsHandle.readdirCalls.get(`${WORK_DIR}/libs`)).toBeUndefined();
  });

  it('A4: a hidden unprunable dir matched by gitignore is not descended into', async () => {
    const fsHandle = fakeFs({
      '.gitignore': 'libs/\n',
      '.kimi-code/ignore': 'libs/\n',
      'libs/x/b.ts': '',
      'libs/y/c.ts': '',
    });
    const fs = jsSession(fsHandle, [`${WORK_DIR}/libs/x`]);
    const result = await fs.search({ query: 'ts', limit: 50, follow_gitignore: true });
    expect(result.items).toEqual([]);
    const suggested = await fs.suggest({
      query: 'ts',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(suggested.items.map((i) => i.path)).toEqual([]);
    expect(fsHandle.readdirCalls.get(`${WORK_DIR}/libs`)).toBeUndefined();
  });

  it('A5: hidden entries stay hidden with follow_gitignore false and show_hidden true', async () => {
    const fsHandle = fakeFs({
      '.kimi-code/ignore': 'libs/\n',
      'libs/y/c.ts': '',
      'src/a.ts': '',
    });
    const fs = jsSession(fsHandle);
    const searched = await fs.search({ query: 'ts', limit: 50, follow_gitignore: false });
    expect(searched.items.map((i) => i.path)).toEqual(['src/a.ts']);
    const suggested = await fs.suggest({
      query: 'ts',
      limit: 50,
      follow_gitignore: false,
      show_hidden: true,
    });
    expect(suggested.items.map((i) => i.path)).toEqual(['src/a.ts']);
    const listed = await fs.list(listRequest({ show_hidden: true }));
    expect(listed.items.map((i) => i.path)).toEqual(['.kimi-code', 'src']);
  });

  it('A6: list, listMany, search, suggest, and grep each load the snapshot once per root', async () => {
    const fsHandle = fakeFs({
      '.kimi-code/ignore': 'libs/\n',
      'libs/y/c.ts': 'hello\n',
      'src/a.ts': 'hello\n',
      '/extra/.kimi-code/ignore': '',
      '/extra/e.ts': '',
    });
    const fs = jsSession(fsHandle, ['/extra']);

    await fs.list(listRequest());
    expect(fsHandle.readTextCalls.get(RULE_FILE)).toBe(1);
    expect(fsHandle.readTextCalls.get('/extra/.kimi-code/ignore')).toBe(1);

    await fs.listMany({
      paths: ['.', 'src', 'src'],
      depth: 1,
      limit: 200,
      show_hidden: false,
      follow_gitignore: false,
      sort: 'name_asc',
      include_git_status: false,
    });
    expect(fsHandle.readTextCalls.get(RULE_FILE)).toBe(2);
    expect(fsHandle.readTextCalls.get('/extra/.kimi-code/ignore')).toBe(2);

    await fs.search({ query: 'ts', limit: 50, follow_gitignore: false });
    expect(fsHandle.readTextCalls.get(RULE_FILE)).toBe(3);
    expect(fsHandle.readTextCalls.get('/extra/.kimi-code/ignore')).toBe(3);

    await fs.suggest({
      query: 'ts',
      limit: 50,
      follow_gitignore: false,
      show_hidden: false,
    });
    expect(fsHandle.readTextCalls.get(RULE_FILE)).toBe(4);
    expect(fsHandle.readTextCalls.get('/extra/.kimi-code/ignore')).toBe(4);

    await fs.grep({
      pattern: 'hello',
      regex: false,
      case_sensitive: true,
      follow_gitignore: false,
      max_files: 200,
      max_matches_per_file: 50,
      max_total_matches: 5000,
      context_lines: 0,
    });
    expect(fsHandle.readTextCalls.get(RULE_FILE)).toBe(6);
    expect(fsHandle.readTextCalls.get('/extra/.kimi-code/ignore')).toBe(5);
  });

  it('A6: search with an empty query shares the snapshot between list calls', async () => {
    const fsHandle = fakeFs({
      '.kimi-code/ignore': 'libs/\n',
      'libs/y/c.ts': '',
      'a.ts': '',
      '/extra/.kimi-code/ignore': '',
      '/extra/e.ts': '',
    });
    const fs = jsSession(fsHandle, ['/extra']);
    const listed = await fs.search({ query: '', limit: 50, follow_gitignore: false });
    expect(listed.items.map((i) => i.path)).toEqual(['a.ts']);
    expect(fsHandle.readTextCalls.get(RULE_FILE)).toBe(1);
    expect(fsHandle.readTextCalls.get('/extra/.kimi-code/ignore')).toBe(1);
  });

  it('A6: a suggest falling back from rg to node reuses the same snapshot', async () => {
    const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
    const fsHandle = fakeFs({ '.kimi-code/ignore': 'libs/\n', 'libs/y/c.ts': '', 'src/foo.ts': '' });
    let spawnCount = 0;
    const runner: IHostProcessService = {
      _serviceBrand: undefined,
      spawn: async (command, args) => {
        const all = [command, ...(args ?? [])];
        if (all[0] === 'rg' && all[1] === '--version') {
          spawnCount += 1;
          return fakeProcess('ripgrep 15.0.0', '', 0);
        }
        return fakeProcess('', 'spawn failure', 2);
      },
    };
    const fs = makeSession({}, emptyHandler, events, defaultGitStub(), [], runner, {}, [], 'posix', stubLog(), fsHandle);
    const result = await fs.suggest({
      query: 'foo',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items.map((i) => i.path)).toContain('src/foo.ts');
    expect(result.items.map((i) => i.path)).not.toContain('libs/y/c.ts');
    expect(events).toContainEqual({
      event: 'fs_suggest_node_fallback',
      properties: { reason: 'rg_error' },
    });
    expect(spawnCount).toBe(1);
    expect(fsHandle.readTextCalls.get(RULE_FILE)).toBe(1);
  });

  it('A7: rule rewrites between calls take effect on both rg and JS paths', async () => {
    const fsHandle = fakeFs({
      '.kimi-code/ignore': 'libs/\n',
      'libs/y/c.ts': 'hello\n',
      'dist/d.ts': 'hello\n',
      'src/a.ts': 'hello\n',
    });
    const fs = jsSession(fsHandle);
    const first = await fs.search({ query: 'ts', limit: 50, follow_gitignore: false });
    expect(first.items.map((i) => i.path)).toEqual(['dist/d.ts', 'src/a.ts']);
    fsHandle.setFile('.kimi-code/ignore', 'dist/\n');
    const second = await fs.search({ query: 'ts', limit: 50, follow_gitignore: false });
    expect(second.items.map((i) => i.path)).toEqual(['libs/y/c.ts', 'src/a.ts']);
    fsHandle.removeFile('.kimi-code/ignore');
    const third = await fs.search({ query: 'ts', limit: 50, follow_gitignore: false });
    expect(third.items.map((i) => i.path)).toEqual(['dist/d.ts', 'libs/y/c.ts', 'src/a.ts']);
  });

  it('A8: rg replay and the JS walk return the same path sets for suggest and grep', async () => {
    const fsHandle = fakeFs({
      '.kimi-code/ignore': 'libs/\n',
      'libs/x/b.ts': 'hello\n',
      'libs/y/c.ts': 'hello\n',
      'src/a.ts': 'hello\n',
    });

    const rgSuggest = makeSession(
      {},
      rgLinesHandler(['libs/x/b.ts', 'libs/y/c.ts', 'src/a.ts']),
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      [`${WORK_DIR}/libs/x`],
      'posix',
      stubLog(),
      fsHandle,
    );
    const jsSuggest = jsSession(fsHandle, [`${WORK_DIR}/libs/x`]);
    const suggestRequest = {
      query: 'ts',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    };
    const rgSuggested = await rgSuggest.suggest(suggestRequest);
    const jsSuggested = await jsSuggest.suggest(suggestRequest);
    expect(new Set(rgSuggested.items.map((i) => i.path))).toEqual(
      new Set(jsSuggested.items.map((i) => i.path)),
    );
    expect(new Set(rgSuggested.items.map((i) => i.path))).toEqual(
      new Set(['libs/x/b.ts', 'src/a.ts']),
    );

    const rgJson = [
      ...['libs/x/b.ts', 'libs/y/c.ts', 'src/a.ts'].flatMap((p) => [
        JSON.stringify({ type: 'begin', data: { path: { text: p } } }),
        JSON.stringify({
          type: 'match',
          data: {
            path: { text: p },
            lines: { text: 'hello\n' },
            line_number: 1,
            submatches: [{ start: 0, end: 5 }],
          },
        }),
        JSON.stringify({ type: 'end', data: { path: { text: p } } }),
      ]),
    ].join('\n');
    const rgGrep = makeSession(
      {},
      (args) => {
        if (args[0] === 'rg' && args[1] === '--version') return { stdout: 'ripgrep 15.0.0', exitCode: 0 };
        if (args[0] === 'rg' && args.includes('--json')) return { stdout: rgJson, exitCode: 0 };
        return { stdout: '', exitCode: 0 };
      },
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      [`${WORK_DIR}/libs/x`],
      'posix',
      stubLog(),
      fsHandle,
    );
    const jsGrep = jsSession(fsHandle, [`${WORK_DIR}/libs/x`]);
    const grepRequest = {
      pattern: 'hello',
      regex: false,
      case_sensitive: true,
      follow_gitignore: true,
      max_files: 200,
      max_matches_per_file: 50,
      max_total_matches: 5000,
      context_lines: 0,
    };
    const rgGrepped = await rgGrep.grep(grepRequest);
    const jsGrepped = await jsGrep.grep(grepRequest);
    expect(new Set(rgGrepped.files.map((f) => f.path))).toEqual(
      new Set(jsGrepped.files.map((f) => f.path)),
    );
    expect(new Set(rgGrepped.files.map((f) => f.path))).toEqual(
      new Set(['libs/x/b.ts', 'src/a.ts']),
    );
  });

  it('A9: gitignore changes keep taking effect through the instance-level cache', async () => {
    const fsHandle = fakeFs({
      '.gitignore': 'vendor/\n',
      '.kimi-code/ignore': 'dist/\n',
      'vendor/v.ts': '',
      'dist/d.ts': '',
      'src/a.ts': '',
    });
    const fs = jsSession(fsHandle);
    const first = await fs.search({ query: 'ts', limit: 50, follow_gitignore: true });
    expect(first.items.map((i) => i.path)).toEqual(['src/a.ts']);
    const withoutGitignore = await fs.search({ query: 'ts', limit: 50, follow_gitignore: false });
    expect(withoutGitignore.items.map((i) => i.path)).toEqual(['src/a.ts', 'vendor/v.ts']);
    fsHandle.setFile('.gitignore', '');
    const cached = await fs.search({ query: 'ts', limit: 50, follow_gitignore: true });
    expect(cached.items.map((i) => i.path)).toEqual(['src/a.ts']);
    const fresh = jsSession(fsHandle);
    const uncached = await fresh.search({ query: 'ts', limit: 50, follow_gitignore: true });
    expect(uncached.items.map((i) => i.path)).toEqual(['src/a.ts', 'vendor/v.ts']);
    fsHandle.setFile('.gitignore', 'src/\n');
    const srcIgnored = jsSession(fsHandle);
    const fourth = await srcIgnored.search({ query: 'ts', limit: 50, follow_gitignore: true });
    expect(fourth.items.map((i) => i.path)).toEqual(['vendor/v.ts']);
  });
});

describe('WorkspaceFsService project ignore (cross-path consistency)', () => {
  const NESTED_ROOT = `${WORK_DIR}/libs/x`;
  const EXPECTED_PATHS = ['libs/x/keep.ts', 'src/a.ts'];

  function overlayFixture(): IHostFileSystem & FakeFsHandle {
    return fakeFs({
      '.gitignore': 'secret/\n',
      '.kimi-code/ignore': 'libs/\n',
      'libs/x/keep.ts': 'hello\n',
      'libs/y/c.ts': 'hello\n',
      'secret/s.ts': 'hello\n',
      'src/a.ts': 'hello\n',
      'tmp/t.ts': 'hello\n',
    });
  }

  function overlaySession(
    handler: RunHandler,
    fsHandle: IHostFileSystem & FakeFsHandle,
  ): IWorkspaceFsService {
    return makeSession(
      {},
      handler,
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      [NESTED_ROOT],
      'posix',
      stubLog(),
      fsHandle,
    );
  }

  function rgGrepJsonHandler(paths: readonly string[]): RunHandler {
    const records = paths.flatMap((p) => [
      JSON.stringify({ type: 'begin', data: { path: { text: p } } }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: p },
          lines: { text: 'hello\n' },
          line_number: 1,
          submatches: [{ start: 0, end: 5 }],
        },
      }),
      JSON.stringify({ type: 'end', data: { path: { text: p } } }),
    ]);
    return (args) => {
      if (args[0] === 'rg' && args[1] === '--version') {
        return { stdout: 'ripgrep 15.0.0', exitCode: 0 };
      }
      if (args[0] === 'rg' && args.includes('--json')) {
        return { stdout: `${records.join('\n')}\n`, exitCode: 0 };
      }
      return { stdout: '', exitCode: 0 };
    };
  }

  it('CP3: suggest returns the same visible set on the rg replay and JS walk for nested root + gitignore + exclude_globs', async () => {
    const fsHandle = overlayFixture();
    const rgPath = overlaySession(
      rgLinesHandler(['libs/x/keep.ts', 'libs/y/c.ts', 'src/a.ts', 'tmp/t.ts']),
      fsHandle,
    );
    const jsPath = overlaySession(rgMissingHandler, fsHandle);
    const request = {
      query: 'ts',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
      exclude_globs: ['tmp/**'],
    };
    const rgResult = await rgPath.suggest(request);
    const jsResult = await jsPath.suggest(request);
    expect(new Set(rgResult.items.map((i) => i.path))).toEqual(
      new Set(jsResult.items.map((i) => i.path)),
    );
    expect([...rgResult.items.map((i) => i.path)].toSorted()).toEqual(EXPECTED_PATHS);
    expect([...jsResult.items.map((i) => i.path)].toSorted()).toEqual(EXPECTED_PATHS);
  });

  it('CP3: grep returns the same visible set on the rg replay and JS walk for nested root + gitignore + exclude_globs', async () => {
    const fsHandle = overlayFixture();
    const rgPath = overlaySession(rgGrepJsonHandler(['libs/x/keep.ts', 'src/a.ts']), fsHandle);
    const jsPath = overlaySession(rgMissingHandler, fsHandle);
    const request = {
      pattern: 'hello',
      regex: false,
      case_sensitive: true,
      follow_gitignore: true,
      exclude_globs: ['tmp/**'],
      max_files: 200,
      max_matches_per_file: 50,
      max_total_matches: 5000,
      context_lines: 0,
    };
    const rgResult = await rgPath.grep(request);
    const jsResult = await jsPath.grep(request);
    expect(new Set(rgResult.files.map((f) => f.path))).toEqual(
      new Set(jsResult.files.map((f) => f.path)),
    );
    expect([...rgResult.files.map((f) => f.path)].toSorted()).toEqual(EXPECTED_PATHS);
    expect([...jsResult.files.map((f) => f.path)].toSorted()).toEqual(EXPECTED_PATHS);
  });

  it('CP3: search returns the same visible set with rg present or missing for nested root + gitignore + exclude_globs', async () => {
    const fsHandle = overlayFixture();
    const rgPresent = overlaySession(emptyHandler, fsHandle);
    const rgMissing = overlaySession(rgMissingHandler, fsHandle);
    const request = { query: 'ts', limit: 50, follow_gitignore: true, exclude_globs: ['tmp/**'] };
    const present = await rgPresent.search(request);
    const missing = await rgMissing.search(request);
    expect(new Set(present.items.map((i) => i.path))).toEqual(
      new Set(missing.items.map((i) => i.path)),
    );
    expect([...present.items.map((i) => i.path)].toSorted()).toEqual(EXPECTED_PATHS);
    expect([...missing.items.map((i) => i.path)].toSorted()).toEqual(EXPECTED_PATHS);
  });
});
