import { O_RDONLY } from 'node:constants';
import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicWrite, atomicWriteStream, writeFileAtomicDurable } from '#/_base/utils/fs';

const UV_FS_O_EXLOCK = 0x10000000;

type FsHook = (...args: string[]) => boolean | undefined;

const hooks = vi.hoisted(() => ({
  rename: null as FsHook | null,
  unlink: null as FsHook | null,
  calls: { rename: [] as Array<[string, string]>, unlink: [] as string[] },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string): Promise<void> => {
      hooks.calls.rename.push([from, to]);
      const hook = hooks.rename;
      if (hook !== null && hook(from, to) === true) return;
      await actual.rename(from, to);
    },
    unlink: async (path: string): Promise<void> => {
      hooks.calls.unlink.push(path);
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

type Writer = (path: string, content: string) => Promise<void>;

const WRITERS: ReadonlyArray<{ readonly name: string; readonly write: Writer }> = [
  { name: 'atomicWrite', write: (path, content) => atomicWrite(path, content) },
  {
    name: 'atomicWriteStream',
    write: (path, content) => atomicWriteStream(path, oneChunk(content)),
  },
  {
    name: 'writeFileAtomicDurable',
    write: (path, content) => writeFileAtomicDurable(path, content),
  },
];

async function* oneChunk(content: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(content);
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to reject');
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

let dir: string;
let target: string;

const ABSENT_PLATFORMS: readonly NodeJS.Platform[] =
  process.platform === 'win32' ? ['win32'] : ['win32', process.platform];

beforeEach(async () => {
  hooks.calls.rename = [];
  hooks.calls.unlink = [];
  dir = await mkdtemp(join(tmpdir(), 'kimi-atomic-'));
  target = join(dir, 'local.toml');
});

afterEach(async () => {
  hooks.rename = null;
  hooks.unlink = null;
  if (platformDescriptor !== undefined) {
    Object.defineProperty(process, 'platform', platformDescriptor);
  }
  await rm(dir, { recursive: true, force: true });
});

describe.each(WRITERS)('$name', ({ write }) => {
  it('replaces the bytes of an existing file and leaves the directory clean', async () => {
    await writeFile(target, 'old');
    await write(target, 'new');

    expect(await readFile(target, 'utf8')).toBe('new');
    expect(await readdir(dir)).toEqual(['local.toml']);
  });

  it('replaces a target another handle holds open', async () => {
    await writeFile(target, 'old');
    usePlatform('win32');
    const handle = await open(target, 'r');

    await write(target, 'new');
    await handle.close();

    expect(await readFile(target, 'utf8')).toBe('new');
  });

  it.each(ABSENT_PLATFORMS)('creates an absent target on %s', async (platform) => {
    usePlatform(platform);

    await write(target, 'new');

    expect(await readFile(target, 'utf8')).toBe('new');
    expect(await readdir(dir)).toEqual([basename(target)]);
  });

  it('keeps the write succeeding when the displaced copy cannot be removed', async () => {
    await writeFile(target, 'old');
    usePlatform('win32');
    hooks.unlink = () => {
      throw new Error('unlink failed');
    };

    await write(target, 'new');

    expect(await readFile(target, 'utf8')).toBe('new');
    const displaced = (await readdir(dir)).filter((entry) => entry.includes('.displaced.'));
    expect(displaced).toHaveLength(1);
  });

  it('replaces the target with a single rename off win32', async () => {
    await writeFile(target, 'old');
    usePlatform('linux');

    const failure = await write(target, 'new').catch((error: unknown) => error);

    expect(failure === undefined || (failure as NodeJS.ErrnoException).code === 'EPERM').toBe(true);
    expect(hooks.calls.rename).toEqual([[expect.stringContaining('.tmp'), target]]);
    expect(await readFile(target, 'utf8')).toBe('new');
  });

  it('displaces the target before the replacement rename on win32', async () => {
    await writeFile(target, 'old');
    usePlatform('win32');

    await write(target, 'new');

    expect(await readFile(target, 'utf8')).toBe('new');
    expect(hooks.calls.rename).toHaveLength(2);
    const [displace, replace] = hooks.calls.rename;
    expect(displace).toEqual([target, expect.stringContaining('.displaced.')]);
    expect(replace).toEqual([expect.stringContaining('.tmp'), target]);
  });

  it('puts the old bytes back when the replacement rename fails', async () => {
    await writeFile(target, 'old');
    usePlatform('win32');
    const E = new Error('rename failed');
    failRenameTo(target, [E]);

    const error = await failure(write(target, 'new'));

    expect(error).toBe(E);
    expect(await readFile(target, 'utf8')).toBe('old');
    expect(await readdir(dir)).toEqual([basename(target)]);
  });

  it.runIf(process.platform === 'win32')(
    'rejects with EBUSY while an exclusive lock is held',
    async () => {
      await writeFile(target, 'old');
      const handle = await open(target, O_RDONLY | UV_FS_O_EXLOCK);

      const error = await failure(write(target, 'new'));
      await handle.close();

      expect((error as NodeJS.ErrnoException).code).toBe('EBUSY');
      expect(await readFile(target, 'utf8')).toBe('old');
      expect(await readdir(dir)).toEqual([basename(target)]);
    },
  );

  it('reports the stranded copy when both the replacement and the restore fail', async () => {
    await writeFile(target, 'old');
    usePlatform('win32');
    const E = new Error('replacement failed');
    const R = new Error('restore failed');
    failRenameTo(target, [E, R]);

    const error = await failure(write(target, 'new'));

    const entries = await readdir(dir);
    expect(entries).toHaveLength(1);
    const displacedPath = join(dir, entries[0] as string);
    expect(displacedPath).not.toBe(target);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(displacedPath);
    expect(error.message).toContain(target);
    expect(error.cause).toBe(E);
    expect(await readFile(displacedPath, 'utf8')).toBe('old');
  });
});
