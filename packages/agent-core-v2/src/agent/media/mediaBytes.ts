import type { IFileService } from '#/app/file/fileService';

import type { DaemonFileRef } from './mediaRef';
import type { ISessionMediaStore } from './sessionMediaStore';

export async function readDaemonMediaBytes(
  ref: DaemonFileRef,
  files: IFileService,
  mediaStore: ISessionMediaStore,
  signal: AbortSignal | undefined,
): Promise<{ readonly bytes: Buffer; readonly filename: string }> {
  try {
    signal?.throwIfAborted();
    const file = await files.get(ref.fileId);
    const bytes = await readStream(file.stream(), signal);
    return { bytes, filename: file.meta.name };
  } catch {
    signal?.throwIfAborted();
    const canonical = await mediaStore.read(ref.fileId);
    if (canonical === undefined) throw new Error(`media ${ref.fileId} is unavailable`);
    return { bytes: Buffer.from(canonical.data), filename: canonical.name };
  }
}

async function readStream(stream: NodeJS.ReadableStream, signal?: AbortSignal): Promise<Buffer> {
  const onAbort = (): void => {
    const reason = signal?.reason instanceof Error ? signal.reason : undefined;
    (stream as NodeJS.ReadableStream & { destroy?(error?: Error): void }).destroy?.(reason);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const chunks: Buffer[] = [];
  try {
    signal?.throwIfAborted();
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      chunks.push(Buffer.from(chunk as string | Uint8Array));
    }
    return Buffer.concat(chunks);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
