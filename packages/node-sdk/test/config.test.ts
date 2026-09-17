import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createKimiConfigRpc } from '#/index';
import { configToTomlData, loadRuntimeConfig, parseConfigString } from '#/config/toml';
import { KimiConfigPatchSchema, KimiConfigSchema } from '#/config/schema';
import { KIMI_CONFIG_DOMAINS, resolvedConfigToKimiConfig } from '#/v2/config-mapper';

const toPosix = (p: string): string => p.replaceAll('\\', '/');

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-config-'));
  tempDirs.push(dir);
  return dir;
}

describe('SDK config TOML', () => {
  it('resolves config paths through the config RPC wrapper', async () => {
    const dir = await makeTempDir();
    const rpc = createKimiConfigRpc();

    await expect(rpc.resolveConfigPath({ homeDir: dir })).resolves.toBe(toPosix(join(dir, 'config.toml')));
  });

  it('returns structured validation issues through the config RPC wrapper', async () => {
    const rpc = createKimiConfigRpc();

    await expect(
      rpc.validateConfigToml({
        text: `
[providers.kimi]
type = "kimi"

[models.kimi]
provider = "kimi"
model = "kimi"
max_context_size = "large"
`,
        filePath: 'broken.toml',
      }),
    ).rejects.toMatchObject({
      details: {
        validationIssues: [
          {
            path: ['models', 'kimi', 'maxContextSize'],
          },
        ],
      },
    });
  });
});

describe('SDK capRoute config contract', () => {
  it('round-trips capRoute through loadRuntimeConfig and configToTomlData', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'config.toml');
    const toml = ['[cap_route]', 'image_route = "kimi-vision"', ''].join('\n');
    await writeFile(filePath, toml, 'utf-8');

    const config = loadRuntimeConfig(filePath, {});
    expect(config.capRoute).toEqual({ imageRoute: 'kimi-vision' });

    const roundTripped = configToTomlData(config);
    expect(roundTripped['cap_route']).toEqual({ image_route: 'kimi-vision' });

    const { stringify: stringifyToml } = await import('smol-toml');
    const roundTripPath = join(dir, 'roundtrip.toml');
    await writeFile(roundTripPath, `${stringifyToml(roundTripped)}\n`, 'utf-8');
    const reloaded = loadRuntimeConfig(roundTripPath, {});
    expect(reloaded.capRoute).toEqual({ imageRoute: 'kimi-vision' });
  });

  it('omits the cap_route section when capRoute is empty or missing', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'config.toml');
    await writeFile(filePath, 'default_model = "kimi-k2"\n', 'utf-8');

    const config = loadRuntimeConfig(filePath, {});
    expect(config.capRoute).toBeUndefined();
    const data = configToTomlData(config);
    expect(data['cap_route']).toBeUndefined();

    const emptyData = configToTomlData({ ...config, capRoute: {} });
    expect(emptyData['cap_route']).toBeUndefined();
  });

  it('accepts valid capRoute and rejects invalid capRoute in both schemas', () => {
    expect(KimiConfigSchema.safeParse({ capRoute: { imageRoute: 'kimi-vision' } }).success).toBe(true);
    expect(KimiConfigSchema.safeParse({ capRoute: {} }).success).toBe(true);
    expect(KimiConfigSchema.safeParse({ capRoute: { imageRoute: '' } }).success).toBe(false);
    expect(KimiConfigSchema.safeParse({ capRoute: { imageRoute: 42 } }).success).toBe(false);

    expect(KimiConfigPatchSchema.safeParse({ capRoute: { imageRoute: 'kimi-vision' } }).success).toBe(true);
    expect(KimiConfigPatchSchema.safeParse({ capRoute: { imageRoute: '' } }).success).toBe(false);
    expect(KimiConfigPatchSchema.safeParse({ capRoute: { imageRoute: 42 } }).success).toBe(false);
  });

  it('maps capRoute keys camelCase to snake_case preserving unknown keys', () => {
    const config = parseConfigString('[cap_route]\nimage_route = "kimi-vision"\n');
    const data = configToTomlData({
      ...config,
      capRoute: { imageRoute: 'next-vision' },
    });
    expect(data['cap_route']).toEqual({ image_route: 'next-vision' });

    const seeded = parseConfigString('[cap_route]\nimage_route = "a"\nfuture_key = "b"\n');
    expect(seeded.capRoute).toEqual({ imageRoute: 'a' });
    const rewritten = configToTomlData({ ...seeded, capRoute: { imageRoute: 'c' } });
    expect(rewritten['cap_route']).toEqual({ image_route: 'c', future_key: 'b' });
  });

  it('includes capRoute in KIMI_CONFIG_DOMAINS', () => {
    expect(KIMI_CONFIG_DOMAINS).toContain('capRoute');
    expect(resolvedConfigToKimiConfig({ capRoute: { imageRoute: 'x' } }).capRoute).toEqual({
      imageRoute: 'x',
    });
  });
});

