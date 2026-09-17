import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { LifecycleScope } from '#/app/scopes';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { type RoutableImage, injectDescriptions } from '#/agent/capRoute/injector';
import {
  collectImages,
  dedupeByIdentity,
  deriveVisionParts,
} from '#/agent/capRoute/imageCollector';
import {
  DESCRIPTION_CACHE_SCOPE,
  DescriptionCache,
  type VisionIdentity,
} from '#/agent/capRoute/descriptionCache';
import { CAP_ROUTE_SECTION } from '#/agent/capRoute/configSection';
import { IAgentImageRouteService } from '#/agent/capRoute/imageRoute';
import { AgentImageRouteService } from '#/agent/capRoute/imageRouteService';
import {
  VISION_DESCRIPTION_INSTRUCTION,
  parseSlots,
  visionSlotOutputTemplate,
} from '#/agent/capRoute/slotParser';
import { VisionCallError, buildIntentAnchor, describeImages } from '#/agent/capRoute/visionCall';
import { readDaemonMediaBytes } from '#/agent/media/mediaBytes';
import type { DaemonFileRef } from '#/agent/media/mediaRef';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { AgentLLMRequestSource } from '#/agent/llmRequester/llmRequester';
import { IConfigService } from '#/app/config/config';
import { type GetResult, IFileService } from '#/app/file/fileService';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { IBlobStore } from '#/persistence/interface/blobStore';
import type { ModelCapability } from '#/llm-adapter/contract/capability';
import { APIStatusError, APITimeoutError } from '#/llm-adapter/contract/errors';
import type { ContentPart, Message } from '#/llm-adapter/contract/message';
import { type Model, IModelCatalog } from '#/llm-adapter/model/catalog';
import type {
  ModelRequestEvent,
  ModelRequestInput,
  ModelRequestParams,
  ModelRequester,
} from '#/llm-adapter/model/model-requester';
import type { LlmCredentialProvider } from '#human/llm/requester/requester';
import type { TokenUsage } from '#human/llm/usage';

const FILE_ID = 'file_abc';
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

function fileService(files: Map<string, { name: string; bytes: Buffer }>): IFileService {
  return {
    _serviceBrand: undefined,
    save: async () => {
      throw new Error('unused');
    },
    delete: async () => {},
    get: async (fileId): Promise<GetResult> => {
      const file = files.get(fileId);
      if (file === undefined) throw new Error(`file not found: ${fileId}`);
      return {
        meta: {
          id: fileId,
          name: file.name,
          media_type: 'image/png',
          size: file.bytes.length,
          created_at: new Date(0).toISOString(),
        },
        stream: () => Readable.from([file.bytes]),
      };
    },
  };
}

function stubMediaStore(read: ISessionMediaStore['read'] = async () => undefined): ISessionMediaStore {
  return {
    _serviceBrand: undefined,
    pathFor: () => undefined,
    resolveDisplayPath: async () => undefined,
    read,
    open: async () => undefined,
    materialize: async () => {
      throw new Error('unused');
    },
  };
}

function requester(): ModelRequester {
  return {
    model: {
      id: 'm',
      name: 'stub',
      aliases: [],
      protocol: 'openai',
      headers: {},
      capabilities: {
        video_in: true,
        image_in: true,
      } as unknown as ModelCapability,
      maxContextSize: 1000,
      alwaysThinking: false,
      providerName: 'p',
      providerType: 'kimi',
    },
    request: () => {
      throw new Error('unused');
    },
  };
}

describe('readDaemonMediaBytes', () => {
  const ref: DaemonFileRef = { fileId: FILE_ID };

  it('reads bytes and filename from the file service', async () => {
    const files = fileService(new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]));
    const read = vi.fn();
    const mediaStore = stubMediaStore(read);

    const out = await readDaemonMediaBytes(ref, files, mediaStore, undefined);

    expect(out.bytes).toEqual(PNG_BYTES);
    expect(out.filename).toBe('pic.png');
    expect(read).not.toHaveBeenCalled();
  });

  it('falls back to the session media store when the file service fails and is not aborted', async () => {
    const files = fileService(new Map());
    const read = vi.fn(async () => ({ data: PNG_BYTES, name: `${FILE_ID}.png` }));
    const mediaStore = stubMediaStore(read);

    const out = await readDaemonMediaBytes(ref, files, mediaStore, undefined);

    expect(out.bytes).toEqual(PNG_BYTES);
    expect(out.filename).toBe(`${FILE_ID}.png`);
    expect(read).toHaveBeenCalledWith(FILE_ID);
  });

  it('throws when both the file service and the media store fail', async () => {
    const files = fileService(new Map());
    const mediaStore = stubMediaStore();

    await expect(readDaemonMediaBytes(ref, files, mediaStore, undefined)).rejects.toThrow(
      `media ${FILE_ID} is unavailable`,
    );
  });

  it('rethrows a pre-existing abort without consulting the media store', async () => {
    const controller = new AbortController();
    controller.abort();
    const files = fileService(new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]));
    const read = vi.fn();
    const mediaStore = stubMediaStore(read);

    await expect(
      readDaemonMediaBytes(ref, files, mediaStore, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled();
  });

  it('rethrows when the stream breaks after an abort instead of falling back', async () => {
    const controller = new AbortController();
    const files: IFileService = {
      _serviceBrand: undefined,
      save: async () => {
        throw new Error('unused');
      },
      delete: async () => {},
      get: async (fileId): Promise<GetResult> => ({
        meta: {
          id: fileId,
          name: 'pic.png',
          media_type: 'image/png',
          size: PNG_BYTES.length,
          created_at: new Date(0).toISOString(),
        },
        stream: () =>
          Readable.from(
            (async function* () {
              yield PNG_BYTES;
              controller.abort();
              throw new Error('socket closed');
            })(),
          ),
      }),
    };
    const read = vi.fn();
    const mediaStore = stubMediaStore(read);

    await expect(
      readDaemonMediaBytes(ref, files, mediaStore, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled();
  });
});

function imagePart(url: string): ContentPart {
  return { type: 'image_url', imageUrl: { url } };
}

function textPart(text: string): ContentPart {
  return { type: 'text', text };
}

function urlIdentity(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

function countingFileService(files: Map<string, { name: string; bytes: Buffer }>): {
  service: IFileService;
  readCount: () => number;
} {
  let gets = 0;
  const base = fileService(files);
  return {
    service: {
      ...base,
      get: async (fileId) => {
        gets += 1;
        return base.get(fileId);
      },
    },
    readCount: () => gets,
  };
}

function countingMediaStore(read: ISessionMediaStore['read']): {
  store: ISessionMediaStore;
  readCount: () => number;
} {
  let reads = 0;
  const store = stubMediaStore(async (fileId) => {
    reads += 1;
    return read(fileId);
  });
  return { store, readCount: () => reads };
}

function memoryBlobStore(): IBlobStore & { data: Map<string, Uint8Array> } {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    _serviceBrand: undefined,
    put: async (scope, key, bytes) => {
      data.set(`${scope}/${key}`, bytes);
    },
    putStream: async (scope, key, source) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of source) chunks.push(chunk);
      data.set(`${scope}/${key}`, Buffer.concat(chunks));
    },
    get: async (scope, key) => data.get(`${scope}/${key}`),
    getStream: async function* () {},
    has: async (scope, key) => data.has(`${scope}/${key}`),
    delete: async (scope, key) => {
      data.delete(`${scope}/${key}`);
    },
    list: async () => [],
  };
}

function throwingBlobStore(): IBlobStore {
  const boom = async (): Promise<never> => {
    throw new Error('blob store unavailable');
  };
  return {
    _serviceBrand: undefined,
    put: boom,
    putStream: boom,
    get: boom,
    getStream: async function* () {},
    has: boom,
    delete: boom,
    list: async () => [],
  };
}

function seededBlobStore(scope: string, key: string, value: string): IBlobStore {
  const inner = memoryBlobStore();
  inner.data.set(`${scope}/${key}`, Buffer.from(value, 'utf8'));
  return inner;
}

describe('collectImages', () => {
  it('collects daemon, data, and http images with derived identities', async () => {
    const daemon = imagePart('kimi-file://file_daemon');
    const data = imagePart('data:image/png;base64,QUJD');
    const remote = imagePart('https://example.test/cat.png');
    const unknown = imagePart('ftp://example.test/cat.png');
    const messages: Message[] = [
      { role: 'user', content: [textPart('hi'), daemon], toolCalls: [] },
      { role: 'user', content: [unknown, data, textPart('mid'), remote], toolCalls: [] },
    ];
    const mediaStore = stubMediaStore();
    mediaStore.resolveDisplayPath = async () => '/session/media/file_daemon.png';

    const images = await collectImages(messages, mediaStore);

    expect(images).toHaveLength(3);
    expect(images[0]).toMatchObject({
      messageIndex: 0,
      partIndex: 1,
      identity: 'file_daemon',
      displayPath: '/session/media/file_daemon.png',
      part: daemon,
    });
    expect(images[1]).toMatchObject({
      messageIndex: 1,
      partIndex: 1,
      identity: urlIdentity('data:image/png;base64,QUJD'),
      part: data,
    });
    expect(images[1]!.displayPath).toBeUndefined();
    expect(images[2]).toMatchObject({
      messageIndex: 1,
      partIndex: 3,
      identity: urlIdentity('https://example.test/cat.png'),
      part: remote,
    });
    expect(images[2]!.displayPath).toBeUndefined();
  });

  it('swallows display path resolution failures as no path', async () => {
    const mediaStore = stubMediaStore();
    mediaStore.resolveDisplayPath = async () => {
      throw new Error('display path exploded');
    };
    const messages: Message[] = [
      { role: 'user', content: [imagePart('kimi-file://file_daemon')], toolCalls: [] },
    ];

    const images = await collectImages(messages, mediaStore);

    expect(images).toHaveLength(1);
    expect(images[0]!.identity).toBe('file_daemon');
    expect(images[0]!.displayPath).toBeUndefined();
  });

  it('keeps every occurrence of the same image as its own entry', async () => {
    const part = imagePart('kimi-file://file_x');
    const messages: Message[] = [
      { role: 'user', content: [part, textPart('mid'), part], toolCalls: [] },
    ];

    const images = await collectImages(messages, stubMediaStore());

    expect(images).toHaveLength(2);
    expect(images[0]).toMatchObject({ messageIndex: 0, partIndex: 0, identity: 'file_x' });
    expect(images[1]).toMatchObject({ messageIndex: 0, partIndex: 2, identity: 'file_x' });
  });

  it('returns an empty list for messages without recognized images', async () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [textPart('hi'), imagePart('ftp://example.test/x.png')],
        toolCalls: [],
      },
    ];

    const images = await collectImages(messages, stubMediaStore());

    expect(images).toEqual([]);
  });
});

describe('dedupeByIdentity', () => {
  it('keeps the first occurrence per identity preserving order', () => {
    const a = routable(0, 0, 'id-a', imagePart('kimi-file://a'));
    const b = routable(0, 1, 'id-b', imagePart('kimi-file://b'));
    const a2 = routable(1, 0, 'id-a', imagePart('kimi-file://a'));

    const out = dedupeByIdentity([a, b, a2]);

    expect(out).toEqual([a, b]);
  });

  it('returns an empty array for empty input', () => {
    expect(dedupeByIdentity([])).toEqual([]);
  });
});

describe('deriveVisionParts', () => {
  it('derives a data part with sniffed MIME for daemon references', async () => {
    const files = fileService(new Map([['file_daemon', { name: 'pic.png', bytes: PNG_BYTES }]]));
    const mediaStore = stubMediaStore();
    const collected = await collectImages(
      [{ role: 'user', content: [imagePart('kimi-file://file_daemon')], toolCalls: [] }],
      mediaStore,
    );

    const out = await deriveVisionParts(collected, { files, mediaStore }, undefined);

    expect(out).toHaveLength(1);
    expect(out[0]!.visionPart).toEqual({
      type: 'image_url',
      imageUrl: {
        url: `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
      },
    });
  });

  it('sniffs MIME from bytes over the filename hint', async () => {
    const files = fileService(
      new Map([['file_daemon', { name: 'mislabeled.jpg', bytes: PNG_BYTES }]]),
    );
    const mediaStore = stubMediaStore();
    const collected = await collectImages(
      [{ role: 'user', content: [imagePart('kimi-file://file_daemon')], toolCalls: [] }],
      mediaStore,
    );

    const out = await deriveVisionParts(collected, { files, mediaStore }, undefined);

    expect((out[0]!.visionPart as { type: string; imageUrl: { url: string } }).imageUrl.url).toBe(
      `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
    );
  });

  it('passes data URL parts through unchanged', async () => {
    const part = imagePart('data:image/png;base64,QUJD');
    const collected = await collectImages(
      [{ role: 'user', content: [part], toolCalls: [] }],
      stubMediaStore(),
    );
    const media = { files: fileService(new Map()), mediaStore: stubMediaStore() };

    const out = await deriveVisionParts(collected, media, undefined);

    expect(out).toHaveLength(1);
    expect(out[0]!.visionPart).toBe(part);
  });

  it('fetches http images into data URL parts', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array(PNG_BYTES)));
    try {
      const part = imagePart('https://example.test/cat.png');
      const collected = await collectImages(
        [{ role: 'user', content: [part], toolCalls: [] }],
        stubMediaStore(),
      );

      const out = await deriveVisionParts(
        collected,
        { files: fileService(new Map()), mediaStore: stubMediaStore() },
        undefined,
      );

      expect(fetchMock).toHaveBeenCalledWith('https://example.test/cat.png', { signal: undefined });
      expect(out).toHaveLength(1);
      expect(out[0]!.visionPart).toEqual({
        type: 'image_url',
        imageUrl: {
          url: `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
        },
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('reads bytes once per identity for a deduplicated miss set', async () => {
    const { service: files, readCount } = countingFileService(
      new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]),
    );
    const mediaStore = stubMediaStore();
    const part = imagePart(`kimi-file://${FILE_ID}`);
    const collected = await collectImages(
      [{ role: 'user', content: [part, textPart('mid'), part], toolCalls: [] }],
      mediaStore,
    );
    expect(collected).toHaveLength(2);

    const missSet = dedupeByIdentity(collected);

    const out = await deriveVisionParts(missSet, { files, mediaStore }, undefined);

    expect(out).toHaveLength(1);
    expect(readCount()).toBe(1);
  });

  it('absorbs daemon read failures by dropping the image from the output', async () => {
    const files = fileService(new Map());
    const mediaStore = stubMediaStore();
    const collected = await collectImages(
      [{ role: 'user', content: [imagePart('kimi-file://file_missing')], toolCalls: [] }],
      mediaStore,
    );

    const out = await deriveVisionParts(collected, { files, mediaStore }, undefined);

    expect(out).toEqual([]);
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({ messageIndex: 0, partIndex: 0, identity: 'file_missing' });
  });

  it('absorbs fetch failures by dropping the image from the output', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network unreachable'));
    try {
      const collected = await collectImages(
        [{ role: 'user', content: [imagePart('https://example.test/down.png')], toolCalls: [] }],
        stubMediaStore(),
      );

      const out = await deriveVisionParts(
        collected,
        { files: fileService(new Map()), mediaStore: stubMediaStore() },
        undefined,
      );

      expect(out).toEqual([]);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('absorbs a non-ok fetch response by dropping the image', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 404 }));
    try {
      const collected = await collectImages(
        [{ role: 'user', content: [imagePart('https://example.test/gone.png')], toolCalls: [] }],
        stubMediaStore(),
      );

      const out = await deriveVisionParts(
        collected,
        { files: fileService(new Map()), mediaStore: stubMediaStore() },
        undefined,
      );

      expect(out).toEqual([]);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('absorbs one failing image without dropping the successful ones', async () => {
    const files = fileService(new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]));
    const mediaStore = stubMediaStore();
    const good = imagePart(`kimi-file://${FILE_ID}`);
    const bad = imagePart('kimi-file://file_missing');
    const collected = await collectImages(
      [{ role: 'user', content: [good, bad], toolCalls: [] }],
      mediaStore,
    );

    const out = await deriveVisionParts(collected, { files, mediaStore }, undefined);

    expect(out).toHaveLength(1);
    expect(out[0]!.identity).toBe(FILE_ID);
  });

  it('propagates abort errors from daemon reads', async () => {
    const controller = new AbortController();
    controller.abort();
    const files = fileService(new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]));
    const mediaStore = stubMediaStore();
    const collected = await collectImages(
      [{ role: 'user', content: [imagePart(`kimi-file://${FILE_ID}`)], toolCalls: [] }],
      mediaStore,
    );

    await expect(
      deriveVisionParts(collected, { files, mediaStore }, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('propagates abort errors from fetches', async () => {
    const abort = new Error('Aborted');
    abort.name = 'AbortError';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(abort);
    try {
      const collected = await collectImages(
        [{ role: 'user', content: [imagePart('https://example.test/cat.png')], toolCalls: [] }],
        stubMediaStore(),
      );

      await expect(
        deriveVisionParts(
          collected,
          { files: fileService(new Map()), mediaStore: stubMediaStore() },
          undefined,
        ),
      ).rejects.toBe(abort);
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe('DescriptionCache', () => {
  const VISION = { providerType: 'kimi', modelName: 'vision-stub' };

  function cacheKey(identity: string, vision: { providerType: string; modelName: string }): string {
    return createHash('sha256')
      .update(`${identity}\0${vision.providerType}\0${vision.modelName}`)
      .digest('hex');
  }

  it('round-trips a description through put and get', async () => {
    const cache = new DescriptionCache(memoryBlobStore());

    await cache.put('id-a', VISION, 'a red square');

    await expect(cache.get('id-a', VISION)).resolves.toBe('a red square');
  });

  it('uses the cap-route-descriptions scope with the sha256 composite key', async () => {
    const blobs = memoryBlobStore();

    const cache = new DescriptionCache(blobs);
    await cache.put('id-a', VISION, 'a red square');

    const key = cacheKey('id-a', VISION);
    expect([...blobs.data.keys()]).toEqual([`${DESCRIPTION_CACHE_SCOPE}/${key}`]);
    expect(DESCRIPTION_CACHE_SCOPE).toBe('cap-route-descriptions');
    expect(new TextDecoder().decode(blobs.data.get(`${DESCRIPTION_CACHE_SCOPE}/${key}`))).toBe(
      'a red square',
    );
  });

  it('returns undefined on a miss', async () => {
    const cache = new DescriptionCache(memoryBlobStore());

    await expect(cache.get('id-a', VISION)).resolves.toBeUndefined();
  });

  it('treats a blob read error as a miss', async () => {
    const cache = new DescriptionCache(throwingBlobStore());

    await expect(cache.get('id-a', VISION)).resolves.toBeUndefined();
  });

  it('swallows put failures', async () => {
    const cache = new DescriptionCache(throwingBlobStore());

    await expect(cache.put('id-a', VISION, 'a red square')).resolves.toBeUndefined();
  });

  it('hits for the same identity and model, misses after a vision identity change', async () => {
    const cache = new DescriptionCache(memoryBlobStore());

    await cache.put('id-a', VISION, 'a red square');
    await expect(cache.get('id-a', VISION)).resolves.toBe('a red square');

    const repointed = { providerType: 'openai', modelName: 'other-vision' };
    await expect(cache.get('id-a', repointed)).resolves.toBeUndefined();
  });

  it('misses for a different identity under the same vision identity', async () => {
    const cache = new DescriptionCache(memoryBlobStore());

    await cache.put('id-a', VISION, 'a red square');
    await expect(cache.get('id-b', VISION)).resolves.toBeUndefined();
  });

  it('supports an empty-string providerType as a distinct key component', async () => {
    const blobs = memoryBlobStore();
    const cache = new DescriptionCache(blobs);
    const fallback = { providerType: '', modelName: 'vision-stub' };

    await cache.put('id-a', fallback, 'fallback description');

    const key = cacheKey('id-a', fallback);
    expect([...blobs.data.keys()]).toEqual([`${DESCRIPTION_CACHE_SCOPE}/${key}`]);
    await expect(cache.get('id-a', fallback)).resolves.toBe('fallback description');
  });

  it('returns the seeded value on a pre-seeded cache hit', async () => {
    const key = cacheKey('id-a', VISION);
    const blobs = seededBlobStore(DESCRIPTION_CACHE_SCOPE, key, 'a pre-seeded description');

    const cache = new DescriptionCache(blobs);

    await expect(cache.get('id-a', VISION)).resolves.toBe('a pre-seeded description');
  });
});

function routable(
  messageIndex: number,
  partIndex: number,
  identity: string,
  part: ContentPart,
  displayPath?: string,
): RoutableImage {
  return { messageIndex, partIndex, identity, part, displayPath };
}

describe('injectDescriptions', () => {
  const A = imagePart('kimi-file://file_a');
  const B = imagePart('data:image/png;base64,AAAA');
  const C = imagePart('kimi-file://file_c');

  it.each`
    name                       | messages                                                                                                    | images                                                                                          | descriptions
    ${'multi-message multi-part'} | ${[{ role: 'user', content: [textPart('hi'), A] }, { role: 'user', content: [B, textPart('there'), C] }]} | ${[routable(0, 1, 'id-a', A, '/tmp/a.png'), routable(1, 0, 'id-b', B), routable(1, 2, 'id-c', C, '/tmp/c.png')]} | ${new Map([['id-a', 'a red square'], ['id-c', 'a blue circle']])}
    ${'partial hit'}           | ${[{ role: 'user', content: [A, B] }]}                                                                       | ${[routable(0, 0, 'id-a', A, '/tmp/a.png'), routable(0, 1, 'id-b', B)]}                          | ${new Map([['id-a', 'a red square']])}
    ${'all hit'}               | ${[{ role: 'user', content: [A, B] }]}                                                                       | ${[routable(0, 0, 'id-a', A, '/tmp/a.png'), routable(0, 1, 'id-b', B)]}                          | ${new Map([['id-a', 'a red square'], ['id-b', 'a blue circle']])}
    ${'zero hit'}              | ${[{ role: 'user', content: [A, B] }]}                                                                       | ${[routable(0, 0, 'id-a', A, '/tmp/a.png'), routable(0, 1, 'id-b', B)]}                          | ${new Map([])}
    ${'same identity multiple parts'} | ${[{ role: 'user', content: [A, textPart('mid'), A] }]}                                              | ${[routable(0, 0, 'id-a', A, '/tmp/a.png'), routable(0, 2, 'id-a', A, '/tmp/a.png')]}             | ${new Map([['id-a', 'a red square']])}
    ${'derive-failed not in descriptions'} | ${[{ role: 'user', content: [A, B] }]}                                                        | ${[routable(0, 0, 'id-a', A, '/tmp/a.png'), routable(0, 1, 'id-b', B)]}                          | ${new Map([['id-a', 'a red square']])}
  `('$name: structure conserved and injection applied', ({ messages, images, descriptions }) => {
    const original = messages as Message[];
    const snapshot = original.map((m) => ({ role: m.role, parts: [...m.content] }));

    const out = injectDescriptions(original, images, descriptions);

    expect(out).toHaveLength(snapshot.length);
    out.forEach((m, i) => {
      expect(m.role).toBe(snapshot[i]!.role);
      expect(m.content).toHaveLength(snapshot[i]!.parts.length);
    });

    for (const img of images) {
      const originalPart = snapshot[img.messageIndex]!.parts[img.partIndex]!;
      const outPart = out[img.messageIndex]!.content[img.partIndex]!;
      if (descriptions.has(img.identity)) {
        expect(outPart.type).toBe('text');
        expect(outPart).not.toBe(originalPart);
        if (outPart.type === 'text') {
          const description = descriptions.get(img.identity)!;
          expect(outPart.text).toContain(description);
          expect(outPart.text).not.toMatch(/model|vision/i);
          if (img.displayPath !== undefined) {
            expect(outPart.text).toContain(`<image path="${img.displayPath}"></image>`);
          } else {
            expect(outPart.text).toMatch(/^<image><\/image>/);
          }
        }
      } else {
        expect(outPart).toBe(originalPart);
      }
    }

    original.forEach((m, i) => {
      const replaced = images.some(
        (img: RoutableImage) => img.messageIndex === i && descriptions.has(img.identity),
      );
      if (replaced) {
        expect(out[i]).not.toBe(m);
      } else {
        expect(out[i]).toBe(m);
      }
      expect(m.content).toEqual(snapshot[i]!.parts);
    });
  });

  it('returns the identical array reference when no replacement occurs', () => {
    const messages: Message[] = [
      { role: 'user', content: [textPart('hi'), A], toolCalls: [] },
      { role: 'user', content: [B], toolCalls: [] },
    ];
    const images = [
      routable(0, 1, 'id-a', A, '/tmp/a.png'),
      routable(1, 0, 'id-b', B),
    ];

    const out = injectDescriptions(messages, images, new Map());

    expect(out).toBe(messages);
  });

  it('replaces same-identity parts at every location with the shared description', () => {
    const messages: Message[] = [
      { role: 'user', content: [A, textPart('mid'), A], toolCalls: [] },
    ];
    const images = [
      routable(0, 0, 'id-a', A, '/tmp/a.png'),
      routable(0, 2, 'id-a', A, '/tmp/a.png'),
    ];

    const out = injectDescriptions(messages, images, new Map([['id-a', 'a red square']]));

    expect((out[0]!.content[0] as { type: string; text: string }).text).toBe(
      '<image path="/tmp/a.png"></image>a red square',
    );
    expect((out[0]!.content[2] as { type: string; text: string }).text).toBe(
      '<image path="/tmp/a.png"></image>a red square',
    );
  });

  it('wraps direct-pass images without a path attribute', () => {
    const messages: Message[] = [{ role: 'user', content: [B], toolCalls: [] }];
    const images = [routable(0, 0, 'id-b', B)];

    const out = injectDescriptions(messages, images, new Map([['id-b', 'a blue circle']]));

    expect((out[0]!.content[0] as { type: string; text: string }).text).toBe(
      '<image></image>a blue circle',
    );
  });

  it('escapes the path attribute', () => {
    const messages: Message[] = [{ role: 'user', content: [A], toolCalls: [] }];
    const images = [routable(0, 0, 'id-a', A, '/tmp/a&b"c.png')];

    const out = injectDescriptions(messages, images, new Map([['id-a', 'a red square']]));

    expect((out[0]!.content[0] as { type: string; text: string }).text).toBe(
      '<image path="/tmp/a&amp;b&quot;c.png"></image>a red square',
    );
  });

  it('treats a blank description as absent', () => {
    const messages: Message[] = [{ role: 'user', content: [A], toolCalls: [] }];
    const images = [routable(0, 0, 'id-a', A, '/tmp/a.png')];

    const out = injectDescriptions(messages, images, new Map([['id-a', '   ']]));

    expect(out).toBe(messages);
  });
});

describe('AgentImageRouteService route', () => {
  const ALIAS = 'vision';
  const TURN: AgentLLMRequestSource = { type: 'turn', turnId: 1 };
  const OPERATION: AgentLLMRequestSource = { type: 'operation', requestKind: 'full_compaction' };
  const DATA_A = 'data:image/png;base64,QUJD';
  const DATA_B = 'data:image/png;base64,QkJD';
  const VISION_ID: VisionIdentity = { providerType: 'kimi', modelName: 'vision-stub' };

  let host: ReturnType<typeof createScopedTestHost> | undefined;

  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Agent,
      IAgentImageRouteService,
      AgentImageRouteService,
      ScopeActivation.OnScopeCreated,
      'capRoute',
    );
  });

  afterEach(() => {
    host?.dispose();
    host = undefined;
  });

  function spyLogService(): ILogService & {
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  } {
    const log = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      child: () => log,
    };
    return {
      ...log,
      _serviceBrand: undefined,
      level: 'info',
      setLevel: () => {},
      flush: async () => {},
    } as unknown as ILogService & {
      warn: ReturnType<typeof vi.fn>;
      debug: ReturnType<typeof vi.fn>;
    };
  }

  function spyTelemetryService(): ITelemetryService & { track2: ReturnType<typeof vi.fn> } {
    return {
      ...noopTelemetryService,
      track2: vi.fn(),
    } as unknown as ITelemetryService & { track2: ReturnType<typeof vi.fn> };
  }

  function stubUsageService(): ISessionUsageService & { record: ReturnType<typeof vi.fn> } {
    return {
      _serviceBrand: undefined,
      record: vi.fn(async () => {}),
      status: () => undefined,
      onDidRecord: () => ({ dispose: () => {} }),
    } as unknown as ISessionUsageService & { record: ReturnType<typeof vi.fn> };
  }

  function stubModelCatalog(resolve: (alias: string) => ModelRequester): IModelCatalog {
    return {
      _serviceBrand: undefined,
      getRequester: (alias: string) => resolve(alias),
    } as unknown as IModelCatalog;
  }

  function stubRouteConfig(sections: Record<string, unknown>): IConfigService {
    return {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (domain: string) => sections[domain],
    } as unknown as IConfigService;
  }

  function textOnlyRequester(): ModelRequester {
    const model = requester().model;
    return {
      model: { ...model, capabilities: { ...model.capabilities, image_in: false } },
      request: () => {
        throw new Error('unused');
      },
    };
  }

  function requesterWithoutImageIn(): ModelRequester {
    const base = stubVisionRequester({});
    const model = base.requester.model;
    return {
      model: { ...model, capabilities: { ...model.capabilities, image_in: false } },
      request: base.requester.request,
    };
  }

  function userMessages(...parts: ContentPart[]): Message[] {
    return [{ role: 'user', content: [...parts], toolCalls: [] }];
  }

  function hostileMessages(messages: Message[], error: Error): Message[] {
    return new Proxy(messages, {
      get(target, prop, receiver) {
        if (prop === 'entries') throw error;
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  function seedDescription(
    blobs: IBlobStore & { data: Map<string, Uint8Array> },
    identity: string,
    text: string,
  ): void {
    const key = createHash('sha256')
      .update(`${identity}\0${VISION_ID.providerType}\0${VISION_ID.modelName}`)
      .digest('hex');
    blobs.data.set(`${DESCRIPTION_CACHE_SCOPE}/${key}`, Buffer.from(text, 'utf8'));
  }

  function trackedVisionRequester(
    vision: { requester: ModelRequester },
    order: string[],
  ): ModelRequester {
    return {
      model: vision.requester.model,
      request: (input, signal, params) => {
        order.push('vision');
        return vision.requester.request(input, signal, params);
      },
    };
  }

  function harness(options: {
    readonly sections?: Record<string, unknown>;
    readonly resolveAlias?: (alias: string) => ModelRequester;
    readonly files?: Map<string, { name: string; bytes: Buffer }>;
    readonly mediaRead?: ISessionMediaStore['read'];
  } = {}) {
    const order: string[] = [];
    const log = spyLogService();
    const telemetry = spyTelemetryService();
    const usage = stubUsageService();
    const blobs = memoryBlobStore();
    const trackedBlobs: IBlobStore = {
      ...blobs,
      get: async (scope, key) => {
        order.push('cache-get');
        return blobs.get(scope, key);
      },
      put: async (scope, key, bytes) => {
        order.push('cache-put');
        await blobs.put(scope, key, bytes);
      },
    };
    const baseFiles = fileService(options.files ?? new Map());
    const trackedFiles: IFileService = {
      ...baseFiles,
      get: async (fileId) => {
        order.push('derive');
        return baseFiles.get(fileId);
      },
    };
    const baseStore = stubMediaStore(options.mediaRead);
    const trackedStore: ISessionMediaStore = {
      ...baseStore,
      resolveDisplayPath: async (fileId: string) => {
        order.push('collect');
        return baseStore.resolveDisplayPath(fileId);
      },
    };
    host = createScopedTestHost([
      stubPair(IConfigService, stubRouteConfig(options.sections ?? {})),
      stubPair(
        IModelCatalog,
        stubModelCatalog(
          options.resolveAlias ??
            (() => {
              throw new Error(`Model "${ALIAS}" is not configured in config.toml.`);
            }),
        ),
      ),
      stubPair(ILogService, log),
      stubPair(IBlobStore, trackedBlobs),
      stubPair(IFileService, trackedFiles),
      stubPair(ITelemetryService, telemetry),
      stubPair(ISessionUsageService, usage),
    ]);
    const agentScope = makeAgentScopeContext({ agentId: 'main', agentScope: 'agents/main' });
    const agent = host.child(LifecycleScope.Agent, 'main', [
      stubPair(ISessionMediaStore, trackedStore),
      stubPair(IAgentScopeContext, agentScope),
    ]);
    return {
      svc: agent.accessor.get(IAgentImageRouteService),
      log,
      blobs,
      order,
      telemetry,
      usage,
      scopeContext: agentScope,
    };
  }

  it('resolves the image route token through the agent scope tree', () => {
    const { svc } = harness();

    expect(svc).toBeInstanceOf(AgentImageRouteService);
  });

  it('routes messages back as the identical array reference when unconfigured', async () => {
    const { svc, log } = harness();
    const messages = userMessages(textPart('hello'));

    const out = await svc.route(messages, textOnlyRequester(), TURN, undefined);

    expect(out).toBe(messages);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('treats an empty config object as unconfigured without warning', async () => {
    const { svc, log } = harness({ sections: { [CAP_ROUTE_SECTION]: {} } });
    const messages = userMessages(imagePart(DATA_A));

    const out = await svc.route(messages, textOnlyRequester(), TURN, undefined);

    expect(out).toBe(messages);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('bypasses before any work when the main model has image_in', async () => {
    const vision = stubVisionRequester({ events: [textEvent('<image-1>x</image-1>')] });
    const { svc, log, order } = harness({
      sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
      resolveAlias: () => vision.requester,
    });
    const messages = userMessages(imagePart(DATA_A));

    const out = await svc.route(messages, requester(), TURN, undefined);

    expect(out).toBe(messages);
    expect(vision.calls).toHaveLength(0);
    expect(order).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('bypasses when the source is not a turn', async () => {
    const vision = stubVisionRequester({ events: [textEvent('<image-1>x</image-1>')] });
    const { svc, order } = harness({
      sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
      resolveAlias: () => vision.requester,
    });
    const messages = userMessages(imagePart(DATA_A));

    const out = await svc.route(messages, textOnlyRequester(), OPERATION, undefined);
    const outUndefinedSource = await svc.route(messages, textOnlyRequester(), undefined, undefined);

    expect(out).toBe(messages);
    expect(outUndefinedSource).toBe(messages);
    expect(order).toEqual([]);
  });

  it('warns once and bypasses when the alias is unresolved', async () => {
    const { svc, log } = harness({
      sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
    });
    const messages = userMessages(imagePart(DATA_A));

    for (let round = 0; round < 3; round += 1) {
      const out = await svc.route(messages, textOnlyRequester(), TURN, undefined);
      expect(out).toBe(messages);
    }

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), {
      alias: ALIAS,
      reason: 'unresolved',
    });
  });

  it('warns once and bypasses when the alias model lacks image_in', async () => {
    const { svc, log } = harness({
      sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
      resolveAlias: () => requesterWithoutImageIn(),
    });
    const messages = userMessages(imagePart(DATA_A));

    const out = await svc.route(messages, textOnlyRequester(), TURN, undefined);
    const outAgain = await svc.route(messages, textOnlyRequester(), TURN, undefined);

    expect(out).toBe(messages);
    expect(outAgain).toBe(messages);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), {
      alias: ALIAS,
      reason: 'no_image_in',
    });
  });

  it('returns the original reference when nothing contributes a description', async () => {
    const vision = stubVisionRequester({ events: [textEvent('<image-1>x</image-1>')] });
    const { svc } = harness({
      sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
      resolveAlias: () => vision.requester,
    });
    const messages = userMessages(imagePart('kimi-file://file_missing'));

    const out = await svc.route(messages, textOnlyRequester(), TURN, undefined);

    expect(out).toBe(messages);
    expect(vision.calls).toHaveLength(0);
  });

  it('returns a new array when a cache hit injects a description', async () => {
    const vision = stubVisionRequester({ events: [textEvent('<image-1>x</image-1>')] });
    const { svc, blobs } = harness({
      sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
      resolveAlias: () => vision.requester,
    });
    seedDescription(blobs, urlIdentity(DATA_A), 'a red square');
    const messages = userMessages(imagePart(DATA_A));

    const out = await svc.route(messages, textOnlyRequester(), TURN, undefined);

    expect(out).not.toBe(messages);
    expect((out[0]!.content[0] as { type: string; text: string }).text).toBe(
      '<image></image>a red square',
    );
    expect(vision.calls).toHaveLength(0);
  });

  it('propagates an abort from the derive stage', async () => {
    const controller = new AbortController();
    controller.abort();
    const vision = stubVisionRequester({ events: [textEvent('<image-1>x</image-1>')] });
    const { svc } = harness({
      sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
      resolveAlias: () => vision.requester,
      files: new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]),
    });
    const messages = userMessages(imagePart(`kimi-file://${FILE_ID}`));

    await expect(
      svc.route(messages, textOnlyRequester(), TURN, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(vision.calls).toHaveLength(0);
  });

  it('propagates an abort from the vision call', async () => {
    const abort = new Error('Aborted');
    abort.name = 'AbortError';
    const vision = stubVisionRequester({ error: abort });
    const { svc } = harness({
      sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
      resolveAlias: () => vision.requester,
    });
    const messages = userMessages(imagePart(DATA_A));

    await expect(svc.route(messages, textOnlyRequester(), TURN, undefined)).rejects.toBe(abort);
  });

  it('propagates a 401 from the vision call', async () => {
    const unauthorized = new APIStatusError(401, 'account rejected');
    const vision = stubVisionRequester({ error: unauthorized });
    const { svc } = harness({
      sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
      resolveAlias: () => vision.requester,
    });
    const messages = userMessages(imagePart(DATA_A));

    await expect(svc.route(messages, textOnlyRequester(), TURN, undefined)).rejects.toBe(
      unauthorized,
    );
  });

  it('absorbs a collect-stage failure into the identity reference', async () => {
    const vision = stubVisionRequester({ events: [textEvent('<image-1>x</image-1>')] });
    const { svc } = harness({
      sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
      resolveAlias: () => vision.requester,
    });
    const messages = hostileMessages(
      userMessages(imagePart(DATA_A)),
      new Error('collect exploded'),
    );

    const out = await svc.route(messages, textOnlyRequester(), TURN, undefined);

    expect(out).toBe(messages);
    expect(vision.calls).toHaveLength(0);
  });

  it('propagates a collect-stage abort', async () => {
    const abort = new Error('Aborted');
    abort.name = 'AbortError';
    const vision = stubVisionRequester({ events: [textEvent('<image-1>x</image-1>')] });
    const { svc } = harness({
      sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
      resolveAlias: () => vision.requester,
    });
    const messages = hostileMessages(userMessages(imagePart(DATA_A)), abort);

    await expect(svc.route(messages, textOnlyRequester(), TURN, undefined)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('propagates a collect-stage 401', async () => {
    const unauthorized = new APIStatusError(401, 'account rejected');
    const vision = stubVisionRequester({ events: [textEvent('<image-1>x</image-1>')] });
    const { svc } = harness({
      sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
      resolveAlias: () => vision.requester,
    });
    const messages = hostileMessages(userMessages(imagePart(DATA_A)), unauthorized);

    await expect(svc.route(messages, textOnlyRequester(), TURN, undefined)).rejects.toBe(
      unauthorized,
    );
  });

  it('injects the cache hit set when the vision call fails non-penetratingly', async () => {
    const vision = stubVisionRequester({ error: new APITimeoutError('too slow') });
    const { svc, blobs } = harness({
      sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
      resolveAlias: () => vision.requester,
    });
    seedDescription(blobs, urlIdentity(DATA_A), 'a red square');
    const partB = imagePart(DATA_B);
    const messages = userMessages(imagePart(DATA_A), partB);

    const out = await svc.route(messages, textOnlyRequester(), TURN, undefined);

    expect(out).not.toBe(messages);
    expect(out[0]!.content[0]!.type).toBe('text');
    expect((out[0]!.content[0] as { type: string; text: string }).text).toContain('a red square');
    expect(out[0]!.content[1]).toBe(partB);
  });

  it('issues at most one vision request per route', async () => {
    const vision = stubVisionRequester({
      events: [textEvent('<image-1>a red square</image-1><image-2>a cat</image-2>')],
    });
    const { svc } = harness({
      sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
      resolveAlias: () => vision.requester,
      files: new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]),
    });
    const messages = userMessages(
      imagePart(DATA_A),
      imagePart(`kimi-file://${FILE_ID}`),
      imagePart(DATA_A),
    );

    const out = await svc.route(messages, textOnlyRequester(), TURN, undefined);

    expect(vision.calls).toHaveLength(1);
    expect(out).not.toBe(messages);
    expect((out[0]!.content[0] as { type: string; text: string }).text).toContain('a red square');
    expect((out[0]!.content[1] as { type: string; text: string }).text).toContain('a cat');
    expect((out[0]!.content[2] as { type: string; text: string }).text).toContain('a red square');
  });

  it('runs collect, cache split, derive, call, and writeback in order', async () => {
    const vision = stubVisionRequester({ events: [textEvent('<image-1>a cat</image-1>')] });
    const { svc, blobs, order } = harness({
      sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
      resolveAlias: () => trackedVisionRequester(vision, order),
      files: new Map([['file_miss', { name: 'pic.png', bytes: PNG_BYTES }]]),
    });
    seedDescription(blobs, 'file_hit', 'a seeded square');
    const messages = userMessages(
      textPart('hi'),
      imagePart('kimi-file://file_hit'),
      imagePart('kimi-file://file_miss'),
    );

    const out = await svc.route(messages, textOnlyRequester(), TURN, undefined);

    expect(order).toEqual([
      'collect',
      'collect',
      'cache-get',
      'cache-get',
      'derive',
      'vision',
      'cache-put',
    ]);
    expect(out).not.toBe(messages);
    expect((out[0]!.content[1] as { type: string; text: string }).text).toContain(
      'a seeded square',
    );
    expect((out[0]!.content[2] as { type: string; text: string }).text).toContain('a cat');
  });

  it('skips the vision call when the post-derive call set is empty', async () => {
    const vision = stubVisionRequester({ events: [textEvent('<image-1>x</image-1>')] });
    const { svc, blobs, order } = harness({
      sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
      resolveAlias: () => trackedVisionRequester(vision, order),
    });
    seedDescription(blobs, 'file_hit', 'a seeded square');
    const messages = userMessages(
      imagePart('kimi-file://file_hit'),
      imagePart('kimi-file://file_missing'),
    );

    const out = await svc.route(messages, textOnlyRequester(), TURN, undefined);

    expect(order).toEqual(['collect', 'collect', 'cache-get', 'cache-get', 'derive']);
    expect(out).not.toBe(messages);
    expect((out[0]!.content[0] as { type: string; text: string }).text).toContain(
      'a seeded square',
    );
    expect(out[0]!.content[1]!.type).toBe('image_url');
  });

  it('describes and injects on the first route, then hits the cache on the second', async () => {
    const vision = stubVisionRequester({ events: [textEvent('<image-1>a red square</image-1>')] });
    const { svc, blobs } = harness({
      sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
      resolveAlias: () => vision.requester,
    });
    const first = userMessages(imagePart(DATA_A));

    const out1 = await svc.route(first, textOnlyRequester(), TURN, undefined);

    expect(vision.calls).toHaveLength(1);
    expect(out1).not.toBe(first);
    expect((out1[0]!.content[0] as { type: string; text: string }).text).toBe(
      '<image></image>a red square',
    );
    expect(blobs.data.size).toBe(1);

    const second = userMessages(imagePart(DATA_A));

    const out2 = await svc.route(second, textOnlyRequester(), TURN, undefined);

    expect(vision.calls).toHaveLength(1);
    expect(out2).not.toBe(second);
    expect((out2[0]!.content[0] as { type: string; text: string }).text).toBe(
      '<image></image>a red square',
    );
  });

  it('writes back only non-blank slot descriptions', async () => {
    const vision = stubVisionRequester({
      events: [textEvent('<image-1>a red square</image-1><image-2>   </image-2>')],
    });
    const { svc, order } = harness({
      sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
      resolveAlias: () => vision.requester,
    });
    const partB = imagePart(DATA_B);
    const messages = userMessages(imagePart(DATA_A), partB);

    const out = await svc.route(messages, textOnlyRequester(), TURN, undefined);

    expect(order.filter((entry) => entry === 'cache-put')).toHaveLength(1);
    expect(out[0]!.content[0]!.type).toBe('text');
    expect(out[0]!.content[1]).toBe(partB);
  });

  describe('route outcome observability', () => {
    const USAGE: TokenUsage = {
      inputOther: 12,
      output: 7,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    };

    function lastOutcomePayload(
      telemetry: { track2: ReturnType<typeof vi.fn> },
    ): Record<string, unknown> {
      expect(telemetry.track2).toHaveBeenCalledTimes(1);
      expect(telemetry.track2).toHaveBeenCalledWith('image_route_outcome', expect.anything());
      return telemetry.track2.mock.calls[0]![1] as Record<string, unknown>;
    }

    it('reports gate_bypassed with zero counters when the main model has image_in', async () => {
      const vision = stubVisionRequester({ events: [textEvent('<image-1>x</image-1>')] });
      const { svc, telemetry, usage, log } = harness({
        sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
        resolveAlias: () => vision.requester,
      });
      const messages = userMessages(imagePart(DATA_A));

      const out = await svc.route(messages, requester(), TURN, undefined);

      expect(out).toBe(messages);
      const payload = lastOutcomePayload(telemetry);
      expect(payload).toMatchObject({
        vision_model: ALIAS,
        outcome: 'gate_bypassed',
        image_count: 0,
        cache_hit_count: 0,
        described_count: 0,
        derive_failed_count: 0,
      });
      expect(typeof payload['duration_ms']).toBe('number');
      expect(usage.record).not.toHaveBeenCalled();
      expect(log.debug).toHaveBeenCalled();
    });

    it('reports gate_bypassed when nothing was collected', async () => {
      const vision = stubVisionRequester({ events: [textEvent('<image-1>x</image-1>')] });
      const { svc, telemetry } = harness({
        sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
        resolveAlias: () => vision.requester,
      });
      const messages = userMessages(textPart('no images'));

      const out = await svc.route(messages, textOnlyRequester(), TURN, undefined);

      expect(out).toBe(messages);
      expect(lastOutcomePayload(telemetry)['outcome']).toBe('gate_bypassed');
    });

    it('reports all_cached when the miss set is empty', async () => {
      const vision = stubVisionRequester({ events: [textEvent('<image-1>x</image-1>')] });
      const { svc, blobs, telemetry, usage } = harness({
        sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
        resolveAlias: () => vision.requester,
      });
      seedDescription(blobs, urlIdentity(DATA_A), 'a red square');
      const messages = userMessages(imagePart(DATA_A));

      await svc.route(messages, textOnlyRequester(), TURN, undefined);

      expect(lastOutcomePayload(telemetry)).toMatchObject({
        outcome: 'all_cached',
        image_count: 1,
        cache_hit_count: 1,
        described_count: 0,
        derive_failed_count: 0,
      });
      expect(usage.record).not.toHaveBeenCalled();
    });

    it('reports derive_failed with derive-failed identities excluded from image_count', async () => {
      const vision = stubVisionRequester({ events: [textEvent('<image-1>x</image-1>')] });
      const { svc, telemetry, usage } = harness({
        sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
        resolveAlias: () => vision.requester,
      });
      const messages = userMessages(
        imagePart('kimi-file://file_missing_a'),
        imagePart('kimi-file://file_missing_b'),
      );

      const out = await svc.route(messages, textOnlyRequester(), TURN, undefined);

      expect(out).toBe(messages);
      expect(lastOutcomePayload(telemetry)).toMatchObject({
        outcome: 'derive_failed',
        image_count: 0,
        cache_hit_count: 0,
        described_count: 0,
        derive_failed_count: 2,
      });
      expect(usage.record).not.toHaveBeenCalled();
    });

    it('reports call_failed and skips usage accounting when the vision call fails', async () => {
      const vision = stubVisionRequester({ error: new APITimeoutError('too slow') });
      const { svc, telemetry, usage } = harness({
        sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
        resolveAlias: () => vision.requester,
      });
      const messages = userMessages(imagePart(DATA_A));

      const out = await svc.route(messages, textOnlyRequester(), TURN, undefined);

      expect(out).toBe(messages);
      expect(lastOutcomePayload(telemetry)).toMatchObject({
        outcome: 'call_failed',
        image_count: 1,
        cache_hit_count: 0,
        described_count: 0,
        derive_failed_count: 0,
      });
      expect(usage.record).not.toHaveBeenCalled();
    });

    it('reports partial_described when a slot is missing', async () => {
      const vision = stubVisionRequester({
        events: [
          textEvent('<image-1>a red square</image-1>'),
          { type: 'usage', usage: USAGE },
        ],
      });
      const { svc, telemetry, usage, scopeContext } = harness({
        sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
        resolveAlias: () => vision.requester,
      });
      const messages = userMessages(imagePart(DATA_A), imagePart(DATA_B));

      const out = await svc.route(messages, textOnlyRequester(), TURN, undefined);

      expect(out).not.toBe(messages);
      expect(lastOutcomePayload(telemetry)).toMatchObject({
        outcome: 'partial_described',
        image_count: 2,
        cache_hit_count: 0,
        described_count: 1,
        derive_failed_count: 0,
      });
      expect(usage.record).toHaveBeenCalledWith(
        scopeContext.agentContext,
        ALIAS,
        USAGE,
        { type: 'operation', turnId: 1, requestKind: 'image_route' },
      );
    });

    it('reports all_described and records usage for the vision call', async () => {
      const vision = stubVisionRequester({
        events: [
          textEvent('<image-1>a red square</image-1><image-2>a blue circle</image-2>'),
          { type: 'usage', usage: USAGE },
        ],
      });
      const { svc, telemetry, usage, scopeContext } = harness({
        sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
        resolveAlias: () => vision.requester,
      });
      const messages = userMessages(imagePart(DATA_A), imagePart(DATA_B));

      await svc.route(messages, textOnlyRequester(), TURN, undefined);

      expect(lastOutcomePayload(telemetry)).toMatchObject({
        outcome: 'all_described',
        image_count: 2,
        cache_hit_count: 0,
        described_count: 2,
        derive_failed_count: 0,
      });
      expect(usage.record).toHaveBeenCalledTimes(1);
      expect(usage.record).toHaveBeenCalledWith(
        scopeContext.agentContext,
        ALIAS,
        USAGE,
        { type: 'operation', turnId: 1, requestKind: 'image_route' },
      );
    });

    it('does not record usage when the vision call returns no usage event', async () => {
      const vision = stubVisionRequester({ events: [textEvent('<image-1>a red square</image-1>')] });
      const { svc, usage } = harness({
        sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
        resolveAlias: () => vision.requester,
      });
      const messages = userMessages(imagePart(DATA_A));

      await svc.route(messages, textOnlyRequester(), TURN, undefined);

      expect(usage.record).not.toHaveBeenCalled();
    });

    it('logs the outcome fields and per-image description texts at debug level', async () => {
      const vision = stubVisionRequester({
        events: [textEvent('<image-1>a red square</image-1>')],
      });
      const { svc, log } = harness({
        sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
        resolveAlias: () => vision.requester,
      });
      const messages = userMessages(imagePart(DATA_A));

      await svc.route(messages, textOnlyRequester(), TURN, undefined);

      expect(log.debug).toHaveBeenCalledTimes(1);
      const payload = log.debug.mock.calls[0]![1] as Record<string, unknown>;
      expect(payload).toMatchObject({
        vision_model: ALIAS,
        outcome: 'all_described',
        image_count: 1,
        cache_hit_count: 0,
        described_count: 1,
        derive_failed_count: 0,
      });
      expect(JSON.stringify(payload)).toContain('a red square');
    });

    it('does not observe a run that ends in a penetrating error', async () => {
      const abort = new Error('Aborted');
      abort.name = 'AbortError';
      const vision = stubVisionRequester({ error: abort });
      const { svc, telemetry } = harness({
        sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
        resolveAlias: () => vision.requester,
      });
      const messages = userMessages(imagePart(DATA_A));

      await expect(svc.route(messages, textOnlyRequester(), TURN, undefined)).rejects.toMatchObject({
        name: 'AbortError',
      });

      expect(telemetry.track2).not.toHaveBeenCalled();
    });
  });

  describe('cross-unit linkage', () => {
    it('replaces mixed daemon and direct image parts with described text parts end to end', async () => {
      const vision = stubVisionRequester({
        events: [
          textEvent('<image-1>a cat photo</image-1><image-2>a red square</image-2>'),
          { type: 'usage', usage: { inputOther: 3, output: 4, inputCacheRead: 0, inputCacheCreation: 0 } },
        ],
      });
      const { svc } = harness({
        sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
        resolveAlias: () => vision.requester,
        files: new Map([[FILE_ID, { name: 'pic.png', bytes: PNG_BYTES }]]),
      });
      const daemonPart = imagePart(`kimi-file://${FILE_ID}`);
      const directPart = imagePart(DATA_A);
      const messages: Message[] = [
        { role: 'user', content: [textPart('what is in these?'), daemonPart], toolCalls: [] },
        { role: 'assistant', content: [textPart('hmm')], toolCalls: [] },
        { role: 'user', content: [directPart, textPart('and this?')], toolCalls: [] },
      ];

      const out = await svc.route(messages, textOnlyRequester(), TURN, undefined);

      expect(out).toHaveLength(3);
      expect(vision.calls).toHaveLength(1);
      const first = out[0]!.content[1] as { type: string; text: string };
      const second = out[2]!.content[0] as { type: string; text: string };
      expect(first.type).toBe('text');
      expect(first.text).toContain('a cat photo');
      expect(second.type).toBe('text');
      expect(second.text).toContain('a red square');
      expect(out[0]!.content[0]).toBe(messages[0]!.content[0]);
      expect(out[0]!.content).toHaveLength(2);
      expect(out[1]!.content).toHaveLength(1);
      expect(out[2]!.content).toHaveLength(2);
      expect(out[2]!.content[1]).toBe(messages[2]!.content[1]);
    });

    it('serves the same image on the second round from cache with zero new vision calls', async () => {
      const vision = stubVisionRequester({
        events: [textEvent('<image-1>a red square</image-1>')],
      });
      const { svc, telemetry } = harness({
        sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
        resolveAlias: () => vision.requester,
      });

      await svc.route(userMessages(imagePart(DATA_A)), textOnlyRequester(), TURN, undefined);
      await svc.route(userMessages(imagePart(DATA_A)), textOnlyRequester(), TURN, undefined);

      expect(vision.calls).toHaveLength(1);
      const secondPayload = telemetry.track2.mock.calls[1]![1] as Record<string, unknown>;
      expect(secondPayload['outcome']).toBe('all_cached');
    });

    it('injects from a pre-seeded cache while the daemon read fails with zero byte reads', async () => {
      const vision = stubVisionRequester({ events: [textEvent('<image-1>x</image-1>')] });
      const { svc, blobs, order } = harness({
        sections: { [CAP_ROUTE_SECTION]: { imageRoute: ALIAS } },
        resolveAlias: () => vision.requester,
        mediaRead: async () => {
          throw new Error('media store read failed');
        },
      });
      seedDescription(blobs, FILE_ID, 'a seeded square');
      const messages = userMessages(imagePart(`kimi-file://${FILE_ID}`));

      const out = await svc.route(messages, textOnlyRequester(), TURN, undefined);

      expect(vision.calls).toHaveLength(0);
      expect(order).toEqual(['collect', 'cache-get']);
      expect(out).not.toBe(messages);
      expect((out[0]!.content[0] as { type: string; text: string }).text).toContain(
        'a seeded square',
      );
    });
  });
});

describe('parseSlots', () => {
  it.each`
    name                        | text                                                            | count | expected
    ${'missing label'}          | ${'<image-1>desc one</image-1>'}                                | ${2}  | ${['desc one', undefined]}
    ${'blank description'}      | ${'<image-1>desc one</image-1><image-2>   </image-2>'}          | ${2}  | ${['desc one', undefined]}
    ${'out-of-range label'}     | ${'<image-1>desc one</image-1><image-9>far out</image-9>'}      | ${2}  | ${['desc one', undefined]}
    ${'duplicate first wins'}   | ${'<image-1>first</image-1><image-1>second</image-1>'}          | ${1}  | ${['first']}
    ${'out-of-order by label'}  | ${'<image-2>two</image-2><image-1>one</image-1>'}               | ${2}  | ${['one', 'two']}
    ${'zero valid blocks'}      | ${'no labels here'}                                             | ${2}  | ${[undefined, undefined]}
    ${'zero count'}             | ${'<image-1>ignored</image-1>'}                                 | ${0}  | ${[]}
    ${'label zero'}             | ${'<image-0>nope</image-0><image-1>one</image-1>'}              | ${1}  | ${['one']}
    ${'malformed label'}        | ${'<image-x>nope</image-x><image-1>one</image-1>'}              | ${1}  | ${['one']}
    ${'unclosed block'}         | ${'<image-1>one</image-1><image-2>never closed'}                | ${2}  | ${['one', undefined]}
    ${'multiline description'}  | ${'<image-1>line one\nline two</image-1>'}                      | ${1}  | ${['line one\nline two']}
  `('$name', ({ text, count, expected }) => {
    expect(parseSlots(text, count)).toEqual(expected);
  });

  it('exposes a slot template that renders one labeled block per image', () => {
    expect(visionSlotOutputTemplate(0)).toBe('');
    expect(visionSlotOutputTemplate(1)).toBe('<image-1></image-1>');
    expect(visionSlotOutputTemplate(3)).toBe(
      '<image-1></image-1>\n<image-2></image-2>\n<image-3></image-3>',
    );
  });

  it('round-trips its own template output for empty descriptions', () => {
    const template = visionSlotOutputTemplate(2);
    expect(parseSlots(template, 2)).toEqual([undefined, undefined]);
  });

  it('exposes a non-empty fixed instruction constant', () => {
    expect(VISION_DESCRIPTION_INSTRUCTION.length).toBeGreaterThan(0);
  });
});

function visionModel(credentials?: LlmCredentialProvider): Model {
  return {
    id: 'vision',
    name: 'vision-stub',
    aliases: [],
    protocol: 'openai',
    headers: {},
    capabilities: {
      video_in: true,
      image_in: true,
    } as unknown as ModelCapability,
    maxContextSize: 1000,
    alwaysThinking: false,
    providerName: 'p',
    providerType: 'kimi',
    credentials,
  };
}

interface StubRequesterOptions {
  readonly events?: readonly ModelRequestEvent[];
  readonly credentials?: LlmCredentialProvider;
  readonly error?: Error;
}

function stubVisionRequester(options: StubRequesterOptions = {}): {
  requester: ModelRequester;
  calls: {
    input: ModelRequestInput;
    signal: AbortSignal | undefined;
    params: ModelRequestParams | undefined;
  }[];
} {
  const calls: {
    input: ModelRequestInput;
    signal: AbortSignal | undefined;
    params: ModelRequestParams | undefined;
  }[] = [];
  const requester: ModelRequester = {
    model: visionModel(options.credentials),
    request: (input, signal, params) => {
      calls.push({ input, signal, params });
      async function* respond(): AsyncGenerator<ModelRequestEvent> {
        if (options.error !== undefined) throw options.error;
        for (const event of options.events ?? []) yield event;
      }
      return respond();
    },
  };
  return { requester, calls };
}

function visionImage(
  identity: string,
  visionPart: ContentPart,
): RoutableImage & { visionPart: ContentPart } {
  return {
    messageIndex: 0,
    partIndex: 0,
    identity,
    part: visionPart,
    visionPart,
  };
}

function textEvent(text: string): ModelRequestEvent {
  return { type: 'part', part: { type: 'text', text } };
}

describe('describeImages', () => {
  const USAGE: TokenUsage = {
    inputOther: 10,
    output: 5,
    inputCacheRead: 0,
    inputCacheCreation: 0,
  };

  it('issues exactly one request with tools, no thinking params, and exhausts the stream', async () => {
    const { requester, calls } = stubVisionRequester({
      events: [textEvent('<image-1>red square</image-1>'), { type: 'usage', usage: USAGE }],
    });
    const images = [visionImage('id-a', imagePart('data:image/png;base64,AAAA'))];

    const out = await describeImages(requester, images, 'what is this?', undefined);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.tools).toEqual([]);
    expect(calls[0]!.params).toBeUndefined();
    expect(out.text).toBe('<image-1>red square</image-1>');
    expect(out.usage).toEqual(USAGE);
  });

  it('builds a single user message with anchor then vision parts in call-set order', async () => {
    const { requester, calls } = stubVisionRequester({ events: [textEvent('x')] });
    const partA = imagePart('data:image/png;base64,AAAA');
    const partB = imagePart('data:image/png;base64,BBBB');
    const images = [visionImage('id-a', partA), visionImage('id-b', partB)];

    await describeImages(requester, images, 'what color?', undefined);

    const input = calls[0]!.input;
    expect(input.systemPrompt).toBe(
      `${VISION_DESCRIPTION_INSTRUCTION}${visionSlotOutputTemplate(2)}`,
    );
    expect(input.messages).toHaveLength(1);
    const [message] = input.messages;
    expect(message?.role).toBe('user');
    expect(message?.content).toEqual([
      textPart('what color?'),
      partA,
      partB,
    ]);
  });

  it('omits the anchor part when no intent anchor is given', async () => {
    const { requester, calls } = stubVisionRequester({ events: [textEvent('x')] });
    const partA = imagePart('data:image/png;base64,AAAA');
    const images = [visionImage('id-a', partA)];

    await describeImages(requester, images, undefined, undefined);

    expect(calls[0]!.input.messages[0]!.content).toEqual([partA]);
  });

  it('forwards the signal to the requester', async () => {
    const { requester, calls } = stubVisionRequester({ events: [textEvent('x')] });
    const controller = new AbortController();
    const images = [visionImage('id-a', imagePart('data:image/png;base64,AAAA'))];

    await describeImages(requester, images, undefined, controller.signal);

    expect(calls[0]!.signal).toBe(controller.signal);
  });

  it('propagates abort errors', async () => {
    const abort = new Error('Aborted');
    abort.name = 'AbortError';
    const { requester } = stubVisionRequester({ error: abort });
    const images = [visionImage('id-a', imagePart('data:image/png;base64,AAAA'))];

    await expect(describeImages(requester, images, undefined, undefined)).rejects.toBe(abort);
  });

  it('propagates 401-class errors thrown as status errors', async () => {
    const unauthorized = new APIStatusError(401, 'account rejected');
    const { requester } = stubVisionRequester({ error: unauthorized });
    const images = [visionImage('id-a', imagePart('data:image/png;base64,AAAA'))];

    await expect(describeImages(requester, images, undefined, undefined)).rejects.toBe(
      unauthorized,
    );
  });

  it('absorbs timeout errors as overall failure', async () => {
    const { requester } = stubVisionRequester({ error: new APITimeoutError('too slow') });
    const images = [visionImage('id-a', imagePart('data:image/png;base64,AAAA'))];

    await expect(describeImages(requester, images, undefined, undefined)).rejects.toBeInstanceOf(
      VisionCallError,
    );
  });

  it('absorbs protocol errors as overall failure', async () => {
    const { requester } = stubVisionRequester({ error: new APIStatusError(500, 'boom') });
    const images = [visionImage('id-a', imagePart('data:image/png;base64,AAAA'))];

    await expect(describeImages(requester, images, undefined, undefined)).rejects.toBeInstanceOf(
      VisionCallError,
    );
  });

  it('absorbs empty responses as overall failure', async () => {
    const { requester } = stubVisionRequester({ events: [] });
    const images = [visionImage('id-a', imagePart('data:image/png;base64,AAAA'))];

    await expect(describeImages(requester, images, undefined, undefined)).rejects.toBeInstanceOf(
      VisionCallError,
    );
  });

  it('absorbs generic errors as overall failure', async () => {
    const { requester } = stubVisionRequester({ error: new Error('socket closed') });
    const images = [visionImage('id-a', imagePart('data:image/png;base64,AAAA'))];

    await expect(describeImages(requester, images, undefined, undefined)).rejects.toBeInstanceOf(
      VisionCallError,
    );
  });

  it('retries through credential recovery and succeeds on the second attempt', async () => {
    const invalidate = vi.fn();
    let resolveCount = 0;
    const credentials: LlmCredentialProvider = {
      resolve: async () => {
        resolveCount += 1;
        return { apiKey: `key-${resolveCount}` };
      },
      canRecover: (error) => (error as { statusCode?: number }).statusCode === 401,
      invalidate,
    };
    const first = new APIStatusError(401, 'expired');
    const calls: ModelRequestInput[] = [];
    const requester: ModelRequester = {
      model: visionModel(credentials),
      request: (input) => {
        calls.push(input);
        async function* respond(): AsyncGenerator<ModelRequestEvent> {
          if (calls.length === 1) throw first;
          yield textEvent('<image-1>ok</image-1>');
        }
        return respond();
      },
    };
    const images = [visionImage('id-a', imagePart('data:image/png;base64,AAAA'))];

    const out = await describeImages(requester, images, undefined, undefined);

    expect(calls).toHaveLength(2);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(out.text).toBe('<image-1>ok</image-1>');
  });
});

describe('buildIntentAnchor', () => {
  it('takes the last user message text scanning backwards', () => {
    const messages: Message[] = [
      { role: 'user', content: [textPart('first question')], toolCalls: [] },
      { role: 'assistant', content: [textPart('an answer')], toolCalls: [] },
      { role: 'user', content: [textPart('second '), textPart('question')], toolCalls: [] },
    ];

    expect(buildIntentAnchor(messages)).toBe('second question');
  });

  it('returns undefined when no user message exists', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [textPart('hi')], toolCalls: [] },
    ];

    expect(buildIntentAnchor(messages)).toBeUndefined();
  });

  it('returns undefined when the last user message has no text parts', () => {
    const messages: Message[] = [
      { role: 'user', content: [imagePart('data:image/png;base64,AAAA')], toolCalls: [] },
    ];

    expect(buildIntentAnchor(messages)).toBeUndefined();
  });

  it('truncates an overlong anchor keeping the head plus an ellipsis marker', () => {
    const long = 'x'.repeat(3000);
    const messages: Message[] = [
      { role: 'user', content: [textPart(long)], toolCalls: [] },
    ];

    const anchor = buildIntentAnchor(messages);

    expect(anchor).toBeDefined();
    expect(anchor!.length).toBeLessThanOrEqual(2000);
    expect(anchor!.startsWith('x'.repeat(1997))).toBe(true);
    expect(anchor!.endsWith('...')).toBe(true);
  });

  it('keeps a short anchor verbatim', () => {
    const messages: Message[] = [{ role: 'user', content: [textPart('short')], toolCalls: [] }];

    expect(buildIntentAnchor(messages)).toBe('short');
  });
});
