import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { deriveMcpRoots } from '#/mcpCore/roots';

describe('deriveMcpRoots (win32 host)', () => {
  it.runIf(process.platform === 'win32')('percent-encodes spaces and non-ASCII and derives name from basename', () => {
    const input = 'D:\\a b\\中文';
    expect(deriveMcpRoots([input])).toEqual([{ uri: 'file:///D:/a%20b/%E4%B8%AD%E6%96%87', name: '中文' }]);
    expect(fileURLToPath('file:///D:/a%20b/%E4%B8%AD%E6%96%87')).toBe(input);
  });

  it.runIf(process.platform === 'win32')('converts UNC paths to a file:// URL with an authority', () => {
    const input = '\\\\srv\\share\\x';
    expect(deriveMcpRoots([input])).toEqual([{ uri: 'file://srv/share/x', name: 'x' }]);
    expect(fileURLToPath('file://srv/share/x')).toBe(input);
  });

  it.runIf(process.platform === 'win32')('omits name for a drive root', () => {
    expect(deriveMcpRoots(['D:\\'])).toEqual([{ uri: 'file:///D:/' }]);
    expect(fileURLToPath('file:///D:/')).toBe('D:\\');
  });
});

describe('deriveMcpRoots (POSIX host)', () => {
  it.skipIf(process.platform === 'win32')('percent-encodes spaces and non-ASCII and derives name from basename', () => {
    const input = '/tmp/a b/中文';
    expect(deriveMcpRoots([input])).toEqual([{ uri: 'file:///tmp/a%20b/%E4%B8%AD%E6%96%87', name: '中文' }]);
    expect(fileURLToPath('file:///tmp/a%20b/%E4%B8%AD%E6%96%87')).toBe(input);
  });

  it.skipIf(process.platform === 'win32')('omits name for the filesystem root', () => {
    expect(deriveMcpRoots(['/'])).toEqual([{ uri: 'file:///' }]);
    expect(fileURLToPath('file:///')).toBe('/');
  });
});

describe('deriveMcpRoots (host-independent)', () => {
  it('returns one Root per distinct directory, preserving input order', () => {
    const a = process.platform === 'win32' ? 'C:\\a' : '/a';
    const b = process.platform === 'win32' ? 'C:\\b' : '/b';
    const c = process.platform === 'win32' ? 'C:\\c' : '/c';
    expect(deriveMcpRoots([a, b, c])).toEqual([
      { uri: pathToFileUrl(a), name: 'a' },
      { uri: pathToFileUrl(b), name: 'b' },
      { uri: pathToFileUrl(c), name: 'c' },
    ]);
  });

  it('keeps only the first occurrence of duplicate directories', () => {
    const a = process.platform === 'win32' ? 'C:\\x' : '/x';
    const b = process.platform === 'win32' ? 'C:\\y' : '/y';
    expect(deriveMcpRoots([a, b, a])).toEqual([
      { uri: pathToFileUrl(a), name: 'x' },
      { uri: pathToFileUrl(b), name: 'y' },
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(deriveMcpRoots([])).toEqual([]);
  });

  it('sets name to the directory basename', () => {
    const dir = process.platform === 'win32' ? 'C:\\proj\\repo' : '/proj/repo';
    expect(deriveMcpRoots([dir])).toEqual([{ uri: pathToFileUrl(dir), name: 'repo' }]);
  });
});

function pathToFileUrl(directory: string): string {
  const root = deriveMcpRoots([directory])[0]!;
  return root.uri;
}