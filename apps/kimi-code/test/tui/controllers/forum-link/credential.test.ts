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
  it('文件不存在 → reason "missing"，hint 含完整路径与 url+token 示例', () => {
    const result = loadCredential();
    expect(result).toEqual({
      ok: false,
      reason: 'missing',
      hint: `Create ${join(homeDir, 'remote_key')} with:\nurl=http://127.0.0.1:8787\ntoken=your-machine-token`,
    });
    expect(existsSync(getRemoteKeyFile())).toBe(false);
  });
});

describe('loadCredential — malformed', () => {
  it('缺 token 键 → reason "malformed"，hint 明确要求 url 与 token', () => {
    const file = writeRemoteKey('# comment\nurl=http://127.0.0.1:8787\n');
    const result = loadCredential();
    expect(result).toEqual({
      ok: false,
      reason: 'malformed',
      hint: `Missing "token" in ${file}. Expected: url=http://host:port and token=your-machine-token`,
    });
    expectDirectoryUnchanged();
  });

  it('缺 url 键 → reason "malformed"，hint 指向 url', () => {
    const file = writeRemoteKey('token=secret123\n');
    const result = loadCredential();
    expect(result).toEqual({
      ok: false,
      reason: 'malformed',
      hint: `Missing "url" in ${file}. Expected: url=http://host:port and token=your-machine-token`,
    });
    expectDirectoryUnchanged();
  });

  it('文件为空 → reason "malformed"', () => {
    writeRemoteKey('\n# only a comment\n');
    const result = loadCredential();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed');
    expectDirectoryUnchanged();
  });

  it('token 为空值行 → reason "malformed"（空 token 不是有效凭证）', () => {
    writeRemoteKey('url=http://127.0.0.1:8787\ntoken=\n');
    const result = loadCredential();
    expect(result).toEqual({
      ok: false,
      reason: 'malformed',
      hint: `Missing "token" in ${getRemoteKeyFile()}. Expected: url=http://host:port and token=your-machine-token`,
    });
    expectDirectoryUnchanged();
  });
});

describe('loadCredential — v1 password 兼容已移除', () => {
  it('仅含 password 字段（无 token）→ 不识别为有效凭证', () => {
    writeRemoteKey('url=http://127.0.0.1:8787\npassword=old-secret\n');
    const result = loadCredential();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed');
    expectDirectoryUnchanged();
  });

  it('password 与 token 并存 → 忽略 password，仅取 token', () => {
    writeRemoteKey('url=http://192.168.1.5:8787\ntoken=new-secret\npassword=old-secret\n');
    const result = loadCredential();
    expect(result).toEqual({ ok: true, url: 'http://192.168.1.5:8787', token: 'new-secret' });
    expectDirectoryUnchanged();
  });
});

describe('loadCredential — 正常凭证', () => {
  it('url 与 token 键值对 → ok:true 且值正确，目录零变更', () => {
    writeRemoteKey('url=http://192.168.1.5:8787\ntoken=secret123\n');
    const result = loadCredential();
    expect(result).toEqual({ ok: true, url: 'http://192.168.1.5:8787', token: 'secret123' });
    expectDirectoryUnchanged();
  });

  it('注释、空行与无等号行被忽略，仍解析成功', () => {
    writeRemoteKey('# url=http://ignored.example\n\nurl=http://10.0.0.2:9000\ngarbage-line\ntoken=t0k en\n');
    const result = loadCredential();
    expect(result).toEqual({ ok: true, url: 'http://10.0.0.2:9000', token: 't0k en' });
    expectDirectoryUnchanged();
  });

  it('CRLF 行尾（Windows）→ 正常解析', () => {
    writeRemoteKey('url=http://10.0.0.3:8787\r\ntoken=win-secret\r\n');
    const result = loadCredential();
    expect(result).toEqual({ ok: true, url: 'http://10.0.0.3:8787', token: 'win-secret' });
    expectDirectoryUnchanged();
  });
});

describe('loadCredential — invalid-url', () => {
  it('url 非 URL 字符串 → reason "invalid-url"，hint 含该 url 值', () => {
    writeRemoteKey('url=not-a-url\ntoken=secret\n');
    const result = loadCredential();
    expect(result).toEqual({
      ok: false,
      reason: 'invalid-url',
      hint: `Invalid url "not-a-url" in ${getRemoteKeyFile()}: must be an absolute http(s) URL`,
    });
    expectDirectoryUnchanged();
  });

  it('url 为非 http 协议 → reason "invalid-url"', () => {
    writeRemoteKey('url=ftp://x\ntoken=secret\n');
    const result = loadCredential();
    expect(result).toEqual({
      ok: false,
      reason: 'invalid-url',
      hint: `Invalid url "ftp://x" in ${getRemoteKeyFile()}: must be an absolute http(s) URL`,
    });
    expectDirectoryUnchanged();
  });
});
