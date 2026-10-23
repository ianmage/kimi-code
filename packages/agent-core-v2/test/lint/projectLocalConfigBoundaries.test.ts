import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = import.meta.dirname;
const UNIT_ROOT = join(__dirname, '..', '..', 'src', 'app', 'projectLocalConfig');

const SPECIFIER_RE = /(?:from|import)\s*['"]([^'"]+)['"]/g;

const ALLOWED: ReadonlyMap<string, readonly string[]> = new Map([
  ['additionalDirEntry.ts', ['pathe', '#/errors']],
  ['projectLocalConfigReader.ts', ['smol-toml', 'pathe', '#/errors', './additionalDirEntry']],
  ['tomlArraySlice.ts', ['smol-toml']],
]);

function readUnit(name: string): string {
  return readFileSync(join(UNIT_ROOT, name), 'utf8');
}

function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(SPECIFIER_RE)) {
    const specifier = match[1];
    if (specifier !== undefined) out.push(specifier);
  }
  return out;
}

function outsideAllowList(name: string, specifiers: readonly string[]): string[] {
  const allowed = ALLOWED.get(name) ?? [];
  return specifiers.filter((specifier) => !allowed.includes(specifier));
}

describe('projectLocalConfig unit boundaries', () => {
  it('keeps every unit off the DI and os layers', () => {
    const bad: string[] = [];
    for (const name of ALLOWED.keys()) {
      for (const specifier of importSpecifiers(readUnit(name))) {
        if (specifier.startsWith('#/_base/di/') || specifier.startsWith('#/os/')) {
          bad.push(`${name} imports '${specifier}'`);
        }
      }
    }
    expect(
      bad,
      'projectLocalConfig units must stay pure: no #/_base/di/ and no #/os/ imports — inject the fs and the DI wiring from the adapter',
    ).toEqual([]);
  });

  it('keeps tomlArraySlice dependent on smol-toml only', () => {
    const specifiers = importSpecifiers(readUnit('tomlArraySlice.ts'));
    const bad = specifiers.filter((specifier) => specifier !== 'smol-toml');
    expect(
      bad,
      `tomlArraySlice.ts must import only 'smol-toml' — found: ${bad.join(', ')}`,
    ).toEqual([]);
  });

  it('keeps every unit inside its allow-list', () => {
    const bad: string[] = [];
    for (const name of ALLOWED.keys()) {
      for (const specifier of outsideAllowList(name, importSpecifiers(readUnit(name)))) {
        bad.push(`${name} imports '${specifier}' (allowed: ${(ALLOWED.get(name) ?? []).join(', ')})`);
      }
    }
    expect(
      bad,
      'unexpected import in a projectLocalConfig unit — extend the design allow-list or drop the dependency',
    ).toEqual([]);
  });
});
