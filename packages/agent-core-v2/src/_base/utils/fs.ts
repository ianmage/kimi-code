import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'pathe';

export async function syncDir(dirPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  const dirFh = await open(dirPath, 'r');
  try {
    await dirFh.sync();
  } finally {
    await dirFh.close();
  }
}

export function syncDirSync(dirPath: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(dirPath, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function replaceFile(tmpPath: string, filePath: string): Promise<void> {
  if (process.platform !== 'win32') {
    await rename(tmpPath, filePath);
    return;
  }
  const displacedPath =
    `${filePath}.tmp.displaced.${process.pid}.${randomBytes(4).toString('hex')}`;
  let displaced = false;
  try {
    await rename(filePath, displacedPath);
    displaced = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await rename(tmpPath, filePath);
  } catch (error) {
    if (!displaced) throw error;
    try {
      await rename(displacedPath, filePath);
    } catch {
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
      throw Object.assign(
        new Error(
          `could not replace ${filePath} (${code}); ` +
            `the previous bytes are stranded at ${displacedPath}`,
          { cause: error },
        ),
        { code: 'EIO' },
      );
    }
    throw error;
  }
  try {
    await unlink(displacedPath);
  } catch {
  }
}

export async function writeFileAtomicDurable(
  filePath: string,
  content: string | Uint8Array,
): Promise<void> {
  const tmpPath = filePath + '.tmp';
  let renamed = false;
  try {
    const fh = await open(tmpPath, 'w');
    try {
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await replaceFile(tmpPath, filePath);
    renamed = true;
    await syncDir(dirname(filePath));
  } finally {
    if (!renamed) {
      try {
        await unlink(tmpPath);
      } catch {
      }
    }
  }
}

function syncFd(fd: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    nodeFs.fsync(fd, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

export async function atomicWrite(
  filePath: string,
  content: string | Uint8Array,
  _syncOverride?: (fd: number) => Promise<void>,
  mode?: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const hex = randomBytes(4).toString('hex');
  const tmpPath = `${filePath}.tmp.${process.pid}.${hex}`;
  let renamed = false;
  try {
    const fh = await open(tmpPath, 'w', mode);
    try {
      signal?.throwIfAborted();
      await fh.writeFile(content);
      signal?.throwIfAborted();
      await (_syncOverride ?? syncFd)(fh.fd);
    } finally {
      await fh.close();
    }
    signal?.throwIfAborted();
    await replaceFile(tmpPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        await unlink(tmpPath);
      } catch {
      }
    }
  }
}

export async function atomicWriteStream(
  filePath: string,
  source: AsyncIterable<Uint8Array>,
  mode?: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const hex = randomBytes(4).toString('hex');
  const tmpPath = `${filePath}.tmp.${process.pid}.${hex}`;
  let renamed = false;
  const destroyable = source as AsyncIterable<Uint8Array> & {
    destroy?(error?: Error): void;
  };
  const onAbort = (): void => {
    const reason = signal?.reason instanceof Error ? signal.reason : undefined;
    destroyable.destroy?.(reason);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const fh = await open(tmpPath, 'w', mode);
    try {
      for await (const chunk of source) {
        signal?.throwIfAborted();
        if (chunk.byteLength > 0) {
          await fh.writeFile(chunk);
        }
      }
      signal?.throwIfAborted();
      await fh.sync();
    } finally {
      await fh.close();
    }
    signal?.throwIfAborted();
    await replaceFile(tmpPath, filePath);
    renamed = true;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!renamed) {
      try {
        await unlink(tmpPath);
      } catch {
      }
    }
  }
}
