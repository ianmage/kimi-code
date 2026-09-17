import { createHash } from 'node:crypto';

import type { IBlobStore } from '#/persistence/interface/blobStore';

export const DESCRIPTION_CACHE_SCOPE = 'cap-route-descriptions';

export interface VisionIdentity {
  readonly providerType: string;
  readonly modelName: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class DescriptionCache {
  constructor(private readonly blobs: IBlobStore) {}

  async get(identity: string, vision: VisionIdentity): Promise<string | undefined> {
    const data = await this.blobs
      .get(DESCRIPTION_CACHE_SCOPE, descriptionCacheKey(identity, vision))
      .catch(() => undefined);
    if (data === undefined) return undefined;
    return textDecoder.decode(data);
  }

  async put(identity: string, vision: VisionIdentity, text: string): Promise<void> {
    await this.blobs
      .put(DESCRIPTION_CACHE_SCOPE, descriptionCacheKey(identity, vision), textEncoder.encode(text))
      .catch(() => undefined);
  }
}

function descriptionCacheKey(identity: string, vision: VisionIdentity): string {
  return createHash('sha256')
    .update(`${identity}\0${vision.providerType}\0${vision.modelName}`)
    .digest('hex');
}
