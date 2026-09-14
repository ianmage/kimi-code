import { existsSync, readFileSync } from 'node:fs';

import { getRemoteKeyFile } from '#/utils/paths';

export type CredentialResult =
  | { ok: true; url: string; password: string }
  | { ok: false; reason: 'missing' | 'malformed' | 'invalid-url'; hint: string };

/**
 * Parse the forum-link credential file (`<dataDir>/remote_key`) read-only.
 * Line format is `key=value`; `#` comment lines and blank lines are skipped,
 * and lines without `=` are ignored leniently. `url` is required and must be
 * an absolute http(s) URL; `password` is optional (empty string means the
 * hub's open mode). Every failure carries a one-shot actionable hint.
 */
export function loadCredential(): CredentialResult {
  const file = getRemoteKeyFile();
  if (!existsSync(file)) {
    return {
      ok: false,
      reason: 'missing',
      hint: `Create ${file} with:\nurl=http://127.0.0.1:8787\npassword=your-secret`,
    };
  }
  const values = parseKeyValueFile(readFileSync(file, 'utf-8'));
  const url = values.get('url');
  if (url === undefined) {
    return {
      ok: false,
      reason: 'malformed',
      hint: `Missing "url" in ${file}. Expected: url=http://host:port and optionally password=your-secret`,
    };
  }
  if (!isAbsoluteHttpUrl(url)) {
    return {
      ok: false,
      reason: 'invalid-url',
      hint: `Invalid url "${url}" in ${file}: must be an absolute http(s) URL`,
    };
  }
  return { ok: true, url, password: values.get('password') ?? '' };
}

function parseKeyValueFile(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return values;
}

function isAbsoluteHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}
