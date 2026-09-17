import { createHash } from 'node:crypto';

import { isAbortError } from '#/_base/utils/abort';
import type { RoutableImage } from '#/agent/capRoute/injector';
import type { IFileService } from '#/app/file/fileService';
import type { ContentPart, Message } from '#/llm-adapter/contract/message';
import { readDaemonMediaBytes } from '#/agent/media/mediaBytes';
import { type DaemonFileRef, parseDaemonFileUrl } from '#/agent/media/mediaRef';
import type { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { detectFileType, MEDIA_SNIFF_BYTES } from '#/agent/media/file-type';

const DATA_URL_PREFIX = 'data:';
const HTTP_PREFIX = 'http://';
const HTTPS_PREFIX = 'https://';

export async function collectImages(
  messages: readonly Message[],
  mediaStore: ISessionMediaStore,
): Promise<readonly RoutableImage[]> {
  const images: RoutableImage[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    for (const [partIndex, part] of message.content.entries()) {
      const daemon = daemonRefOfImagePart(part);
      if (daemon !== undefined) {
        images.push({
          messageIndex,
          partIndex,
          identity: daemon.fileId,
          displayPath: await displayPathOf(mediaStore, daemon),
          part,
        });
        continue;
      }
      if (part.type !== 'image_url') continue;
      const url = part.imageUrl.url;
      if (!isDirectImageUrl(url)) continue;
      images.push({
        messageIndex,
        partIndex,
        identity: createHash('sha256').update(url).digest('hex'),
        part,
      });
    }
  }
  return images;
}

export function dedupeByIdentity(images: readonly RoutableImage[]): RoutableImage[] {
  const seen = new Set<string>();
  const out: RoutableImage[] = [];
  for (const image of images) {
    if (seen.has(image.identity)) continue;
    seen.add(image.identity);
    out.push(image);
  }
  return out;
}

export async function deriveVisionParts(
  images: readonly RoutableImage[],
  media: { files: IFileService; mediaStore: ISessionMediaStore },
  signal: AbortSignal | undefined,
): Promise<readonly (RoutableImage & { visionPart: ContentPart })[]> {
  const out: (RoutableImage & { visionPart: ContentPart })[] = [];
  for (const image of images) {
    try {
      const visionPart = await deriveVisionPart(image, media, signal);
      out.push({ ...image, visionPart });
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
  }
  return out;
}

async function deriveVisionPart(
  image: RoutableImage,
  media: { files: IFileService; mediaStore: ISessionMediaStore },
  signal: AbortSignal | undefined,
): Promise<ContentPart> {
  const url = imageUrlOf(image.part);
  if (url === undefined) throw new Error('unroutable image part');
  if (isDaemonFileUrl(url)) {
    const ref = parseDaemonFileUrl(url);
    if (ref === undefined) throw new Error(`malformed daemon url: ${url}`);
    const source = await readDaemonMediaBytes(ref, media.files, media.mediaStore, signal);
    return dataUrlPart(source.bytes, source.filename);
  }
  if (isDataUrl(url)) return image.part;
  if (isHttpUrl(url)) return fetchImagePart(url, signal);
  throw new Error(`unsupported image url scheme: ${url}`);
}

async function fetchImagePart(url: string, signal: AbortSignal | undefined): Promise<ContentPart> {
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`image fetch failed: HTTP ${resp.status} ${resp.statusText}`);
  const bytes = Buffer.from(await resp.arrayBuffer());
  return dataUrlPart(bytes, url);
}

function dataUrlPart(bytes: Buffer, filename: string): ContentPart {
  const mimeType = sniffImageMime(bytes, filename);
  return {
    type: 'image_url',
    imageUrl: { url: `data:${mimeType};base64,${bytes.toString('base64')}` },
  };
}

function sniffImageMime(bytes: Buffer, filename: string): string {
  const fileType = detectFileType(filename, bytes.subarray(0, MEDIA_SNIFF_BYTES), 'media');
  return fileType.mimeType;
}

function daemonRefOfImagePart(part: ContentPart): DaemonFileRef | undefined {
  if (part.type !== 'image_url') return undefined;
  return parseDaemonFileUrl(part.imageUrl.url);
}

async function displayPathOf(
  mediaStore: ISessionMediaStore,
  ref: DaemonFileRef,
): Promise<string | undefined> {
  try {
    return await mediaStore.resolveDisplayPath(ref.fileId);
  } catch {
    return undefined;
  }
}

function imageUrlOf(part: ContentPart): string | undefined {
  return part.type === 'image_url' ? part.imageUrl.url : undefined;
}

function isDirectImageUrl(url: string): boolean {
  return isDataUrl(url) || isHttpUrl(url);
}

function isDataUrl(url: string): boolean {
  return url.startsWith(DATA_URL_PREFIX);
}

function isHttpUrl(url: string): boolean {
  return url.startsWith(HTTP_PREFIX) || url.startsWith(HTTPS_PREFIX);
}

function isDaemonFileUrl(url: string): boolean {
  return parseDaemonFileUrl(url) !== undefined;
}
