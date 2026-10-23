import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Error2, ErrorCodes } from '#/errors';
import {
  classifyAdditionalDirEntry,
  sameAdditionalDir,
  toAdditionalDirError,
  type AdditionalDirEntryClass,
} from '#/app/projectLocalConfig/additionalDirEntry';

const baseDir = '/base/project';
const homeDir = '/home/tester';

type StatOutcome = { readonly isDirectory: boolean } | { readonly throws: unknown };

function statStub(behaviour: Record<string, StatOutcome>) {
  const calls: string[] = [];
  return {
    calls,
    fs: {
      stat(path: string): Promise<{ readonly isDirectory: boolean }> {
        calls.push(path);
        const outcome = behaviour[path];
        if (outcome === undefined) {
          throw new Error(`unexpected stat: ${path}`);
        }
        if ('throws' in outcome) throw outcome.throws;
        return Promise.resolve(outcome);
      },
    },
  };
}

function alwaysDirectory() {
  return {
    stat: (): Promise<{ readonly isDirectory: boolean }> => Promise.resolve({ isDirectory: true }),
  };
}

describe('classifyAdditionalDirEntry', () => {
  it('reports a blank entry as empty', async () => {
    const { fs } = statStub({});
    const cls = await classifyAdditionalDirEntry('  ', baseDir, homeDir, fs);
    expect(cls).toEqual({ kind: 'invalid', reason: 'empty' });
  });

  it('does not probe an empty entry', async () => {
    const { calls, fs } = statStub({});
    await classifyAdditionalDirEntry('   ', baseDir, homeDir, fs);
    expect(calls).toEqual([]);
  });

  it('classifies a stat rejection by its error code', async () => {
    const cases: ReadonlyArray<{
      readonly raw: string;
      readonly thrown: unknown;
      readonly reason: 'missing' | 'not_directory' | 'probe_failed';
    }> = [
      { raw: '/probe/enoent', thrown: { code: 'ENOENT' }, reason: 'missing' },
      { raw: '/probe/enotdir', thrown: { code: 'ENOTDIR' }, reason: 'missing' },
      { raw: '/probe/eacces', thrown: { code: 'EACCES' }, reason: 'probe_failed' },
      { raw: '/probe/eperm', thrown: { code: 'EPERM' }, reason: 'probe_failed' },
      {
        raw: '/probe/wrapped',
        thrown: new Error2(ErrorCodes.STORAGE_IO_FAILED, 'wrapped', { cause: { code: 'ENOENT' } }),
        reason: 'missing',
      },
      { raw: '/probe/no-code', thrown: new Error('boom'), reason: 'probe_failed' },
      { raw: '/probe/null', thrown: null, reason: 'probe_failed' },
    ];

    for (const { raw, thrown, reason } of cases) {
      const { fs } = statStub({ [raw]: { throws: thrown } });
      const cls = await classifyAdditionalDirEntry(raw, baseDir, homeDir, fs);
      expect(cls, raw).toEqual({ kind: 'unavailable', reason, dir: raw, cause: thrown });
    }
  });

  it('classifies a non-directory probe result', async () => {
    const { fs } = statStub({ '/probe/file.txt': { isDirectory: false } });
    const cls = await classifyAdditionalDirEntry('/probe/file.txt', baseDir, homeDir, fs);
    expect(cls).toEqual({ kind: 'unavailable', reason: 'not_directory', dir: '/probe/file.txt' });
  });

  it('accepts a directory probe result', async () => {
    const { fs } = statStub({ '/probe/dir': { isDirectory: true } });
    const cls = await classifyAdditionalDirEntry('/probe/dir', baseDir, homeDir, fs);
    expect(cls).toEqual({ kind: 'accepted', dir: '/probe/dir' });
  });

  it('expands the bare home shorthand', async () => {
    const cls = await classifyAdditionalDirEntry('~', baseDir, homeDir, alwaysDirectory());
    expect(cls).toEqual({ kind: 'accepted', dir: homeDir });
  });

  it('expands the home prefix', async () => {
    const cls = await classifyAdditionalDirEntry('~/x', baseDir, homeDir, alwaysDirectory());
    expect(cls).toEqual({ kind: 'accepted', dir: join(homeDir, 'x') });
  });

  it('resolves a relative entry against the base dir', async () => {
    const cls = await classifyAdditionalDirEntry('rel', baseDir, homeDir, alwaysDirectory());
    expect(cls).toEqual({ kind: 'accepted', dir: resolve(baseDir, 'rel') });
  });

  it('normalizes an absolute entry', async () => {
    const cls = await classifyAdditionalDirEntry('/a//b/../c', baseDir, homeDir, alwaysDirectory());
    expect(cls).toEqual({ kind: 'accepted', dir: '/a/c' });
  });

  it('trims the entry before resolving', async () => {
    const cls = await classifyAdditionalDirEntry('  ~/x  ', baseDir, homeDir, alwaysDirectory());
    expect(cls).toEqual({ kind: 'accepted', dir: join(homeDir, 'x') });
  });
});

describe('classifyAdditionalDirEntry on a real tree', () => {
  let root: string;
  let home: string;
  let baseA: string;
  let baseB: string;

  const fs = {
    async stat(path: string): Promise<{ readonly isDirectory: boolean }> {
      const stats = await stat(path);
      return { isDirectory: stats.isDirectory() };
    },
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kimi-additional-dir-'));
    home = join(root, 'home');
    baseA = join(root, 'baseA');
    baseB = join(root, 'baseB');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(home, 'sub'), { recursive: true });
    mkdirSync(join(dirname(home), 'x'), { recursive: true });
    mkdirSync(baseA, { recursive: true });
    mkdirSync(baseB, { recursive: true });
    mkdirSync(join(baseA, '~user', 'x'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function acceptedDir(raw: string, baseDir: string): Promise<string> {
    const cls = await classifyAdditionalDirEntry(raw, baseDir, home, fs);
    if (cls.kind !== 'accepted') throw new Error(`expected ${raw} to be accepted`);
    return cls.dir;
  }

  it('expands a backslash home prefix', async () => {
    const cls = await classifyAdditionalDirEntry('~\\sub', baseA, home, fs);
    expect(cls).toEqual({ kind: 'accepted', dir: join(home, 'sub') });
  });

  it('expands the bare home shorthand to the home dir', async () => {
    expect(await acceptedDir('~', baseA)).toBe(home);
  });

  it('expands a forward-slash home prefix', async () => {
    expect(await acceptedDir('~/sub', baseA)).toBe(join(home, 'sub'));
  });

  it('climbs out of the home dir before resolving the rest', async () => {
    const dir = await acceptedDir('~/../x', baseA);
    expect(dir).toBe(join(dirname(home), 'x'));
    expect(dir).not.toBe(resolve(baseA, 'x'));
  });

  it('leaves a named home prefix relative to the base dir', async () => {
    expect(await acceptedDir('~user/x', baseA)).toBe(resolve(baseA, '~user/x'));
  });

  it('classifies its own output identically under any base dir', async () => {
    const dir = await acceptedDir('~\\sub', baseA);
    expect(await acceptedDir(dir, baseA)).toBe(dir);
    expect(await acceptedDir(dir, baseB)).toBe(dir);
  });
});

describe('toAdditionalDirError', () => {
  const cause = new Error('probe boom');

  const classes: ReadonlyArray<{
    readonly cls: Exclude<AdditionalDirEntryClass, { kind: 'accepted' }>;
    readonly raw: string;
    readonly code: string;
    readonly path: string;
    readonly reason: string;
    readonly hasCause: boolean;
  }> = [
    {
      cls: { kind: 'invalid', reason: 'empty' },
      raw: '   ',
      code: ErrorCodes.CONFIG_INVALID,
      path: '   ',
      reason: 'empty',
      hasCause: false,
    },
    {
      cls: { kind: 'unavailable', reason: 'missing', dir: '/gone', cause },
      raw: '/gone',
      code: ErrorCodes.ADDITIONAL_DIR_UNAVAILABLE,
      path: '/gone',
      reason: 'missing',
      hasCause: true,
    },
    {
      cls: { kind: 'unavailable', reason: 'not_directory', dir: '/file.txt' },
      raw: '/file.txt',
      code: ErrorCodes.ADDITIONAL_DIR_UNAVAILABLE,
      path: '/file.txt',
      reason: 'not_directory',
      hasCause: false,
    },
    {
      cls: { kind: 'unavailable', reason: 'probe_failed', dir: '/locked', cause },
      raw: '/locked',
      code: ErrorCodes.STORAGE_IO_FAILED,
      path: '/locked',
      reason: 'probe_failed',
      hasCause: true,
    },
  ];

  it('maps every class to its own code', () => {
    const codes = classes.map(({ cls, raw }) => toAdditionalDirError(cls, raw).code);
    expect(codes).toEqual(classes.map(({ code }) => code));
  });

  it('gives every class a pairwise distinct message', () => {
    const messages = classes.map(({ cls, raw }) => toAdditionalDirError(cls, raw).message);
    for (let i = 0; i < messages.length; i += 1) {
      for (let j = i + 1; j < messages.length; j += 1) {
        expect(messages[i], `${messages[i]} vs ${messages[j]}`).not.toBe(messages[j]);
      }
    }
  });

  it('carries the path and the reason in details', () => {
    for (const { cls, raw, path, reason } of classes) {
      const error = toAdditionalDirError(cls, raw);
      expect(error.details).toEqual({ path, reason });
    }
  });

  it('passes the cause through only when the class has one', () => {
    for (const { cls, raw, hasCause } of classes) {
      const error = toAdditionalDirError(cls, raw);
      expect('cause' in error, `${cls.kind}/${cls.reason}`).toBe(hasCause);
      if (hasCause) expect(error.cause).toBe(cause);
    }
  });
});

describe('sameAdditionalDir', () => {
  it('treats a trailing separator as the same entry', () => {
    expect(sameAdditionalDir('A', 'A/')).toBe(true);
  });

  it('distinguishes different entries', () => {
    expect(sameAdditionalDir('A', 'B')).toBe(false);
  });

  it('ignores case on win32 only', () => {
    expect(sameAdditionalDir('C:/A', 'c:/a')).toBe(process.platform === 'win32');
  });
});
