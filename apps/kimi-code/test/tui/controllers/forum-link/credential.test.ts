import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadCredential } from '#/tui/controllers/forum-link/credential';
import { getRemoteKeyFile } from '#/utils/paths';

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'forum-cred-'));
  vi.stubEnv('KIMI_CODE_HOME', homeDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(homeDir, { recursive: true, force: true });
});

function writeRemoteKey(content: string): string {
  const file = getRemoteKeyFile();
  writeFileSync(file, content, 'utf-8');
  return file;
}

function expectDirectoryUnchanged(): void {
  expect(readdirSync(homeDir)).toEqual(['remote_key']);
}

describe('loadCredential — missing', () => {
  it('文件不存在 → reason "missing"，hint 含完整路径与两行示例内容', () => {
    const result = loadCredential();
    expect(result).toEqual({
      ok: false,
      reason: 'missing',
      hint: `Create ${join(homeDir, 'remote_key')} with:\nurl=http://127.0.0.1:8787\npassword=your-secret`,
    });
    expect(existsSync(getRemoteKeyFile())).toBe(false);
  });
});

describe('loadCredential — malformed', () => {
  it('缺 url 键 → reason "malformed"，hint 含路径与 url 示例', () => {
    const file = writeRemoteKey('# comment\npassword=x\n');
    const result = loadCredential();
    expect(result).toEqual({
      ok: false,
      reason: 'malformed',
      hint: `Missing "url" in ${file}. Expected: url=http://host:port and optionally password=your-secret`,
    });
    expectDirectoryUnchanged();
  });
});

describe('loadCredential — 正常凭证', () => {
  it('url 与 password 键值对 → ok:true 且值正确，目录零变更', () => {
    writeRemoteKey('url=http://192.168.1.5:8787\npassword=secret123\n');
    const result = loadCredential();
    expect(result).toEqual({ ok: true, url: 'http://192.168.1.5:8787', password: 'secret123' });
    expectDirectoryUnchanged();
  });

  it('无 password 行 → ok:true password 空串（开放模式）', () => {
    writeRemoteKey('url=http://127.0.0.1:8787\n');
    const result = loadCredential();
    expect(result).toEqual({ ok: true, url: 'http://127.0.0.1:8787', password: '' });
    expectDirectoryUnchanged();
  });

  it('password 为空值行 → ok:true password 空串', () => {
    writeRemoteKey('url=http://127.0.0.1:8787\npassword=\n');
    const result = loadCredential();
    expect(result).toEqual({ ok: true, url: 'http://127.0.0.1:8787', password: '' });
    expectDirectoryUnchanged();
  });

  it('注释、空行与无等号行被忽略，仍解析成功', () => {
    writeRemoteKey(
      '# url=http://ignored.example\n\nurl=http://10.0.0.2:9000\ngarbage-line\npassword=p@ss word\n',
    );
    const result = loadCredential();
    expect(result).toEqual({ ok: true, url: 'http://10.0.0.2:9000', password: 'p@ss word' });
    expectDirectoryUnchanged();
  });

  it('CRLF 行尾（Windows）→ 正常解析', () => {
    writeRemoteKey('url=http://10.0.0.3:8787\r\npassword=win-secret\r\n');
    const result = loadCredential();
    expect(result).toEqual({ ok: true, url: 'http://10.0.0.3:8787', password: 'win-secret' });
    expectDirectoryUnchanged();
  });
});

describe('loadCredential — invalid-url', () => {
  it('url 非 URL 字符串 → reason "invalid-url"，hint 含该 url 值', () => {
    const file = writeRemoteKey('url=not-a-url\n');
    const result = loadCredential();
    expect(result).toEqual({
      ok: false,
      reason: 'invalid-url',
      hint: `Invalid url "not-a-url" in ${file}: must be an absolute http(s) URL`,
    });
    expectDirectoryUnchanged();
  });

  it('url 为非 http 协议 → reason "invalid-url"', () => {
    writeRemoteKey('url=ftp://x\n');
    const result = loadCredential();
    expect(result).toEqual({
      ok: false,
      reason: 'invalid-url',
      hint: `Invalid url "ftp://x" in ${getRemoteKeyFile()}: must be an absolute http(s) URL`,
    });
    expectDirectoryUnchanged();
  });
});
