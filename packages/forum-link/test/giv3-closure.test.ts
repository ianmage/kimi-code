import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const HUB_MJS = fileURLToPath(new URL('../dist/hub.mjs', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));
const LINK_TS = fileURLToPath(new URL('../../../apps/kimi-code/src/tui/controllers/forum-link/link.ts', import.meta.url));

interface Timing {
  startTimeoutMs: number;
  pollIntervalMs: number;
  exitTimeoutMs: number;
}

const DEFAULT_TIMING: Timing = {
  startTimeoutMs: 8000,
  pollIntervalMs: 20,
  exitTimeoutMs: 5000,
};

interface HubProcess {
  child: ChildProcess;
  baseUrl: string;
  dataDir: string;
}

async function spawnHub(timing: Timing = DEFAULT_TIMING): Promise<HubProcess> {
  const dataDir = mkdtempSync(join(tmpdir(), 'forum-link-giv3-'));
  const child = spawn(process.execPath, [HUB_MJS, 'serve', '--data-dir', dataDir, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    output += chunk;
  });
  const deadline = Date.now() + timing.startTimeoutMs;
  for (;;) {
    const match = /listening on http:\/\/(\S+):(\d+)/.exec(output);
    if (match !== null) {
      return { child, baseUrl: `http://127.0.0.1:${match[2]}`, dataDir };
    }
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill();
      throw new Error(`hub process failed to start: ${output}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, timing.pollIntervalMs);
    });
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (hasExited(child)) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('hub process did not exit after shutdown'));
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else files.push(full);
    }
  }
  return files;
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /import\s+[^;('"]*?from\s*['"]([^'"]+)['"]/g,
    /import\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /export\s+[^;('"]*?from\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  }
  return specifiers;
}

function specifiersIn(files: string[]): { file: string; specifiers: string[] }[] {
  return files.map((file) => ({ file, specifiers: importSpecifiers(readFileSync(file, 'utf8')) }));
}

describe('Phase 1.3 Layer 1 closure matrix', () => {
  let running: HubProcess | undefined;

  afterEach(async () => {
    if (running === undefined) return;
    const { child, dataDir } = running;
    running = undefined;
    child.kill();
    await waitForExit(child, DEFAULT_TIMING.exitTimeoutMs);
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('build artifact', () => {
    it('dist/hub.mjs exists after build', () => {
      expect(existsSync(HUB_MJS), 'run `pnpm -F @moonshot-ai/forum-link build` before this suite').toBe(true);
    });
  });

  describe('dist import scan', () => {
    it('hub.mjs imports only node: builtins', () => {
      const specifiers = importSpecifiers(readFileSync(HUB_MJS, 'utf8'));
      expect(specifiers.length).toBeGreaterThan(0);
      const offenders = specifiers.filter((specifier) => !specifier.startsWith('node:'));
      expect(offenders).toEqual([]);
    });
  });

  describe('serve subprocess', () => {
    it('listens on loopback and answers the public page', { timeout: 15000 }, async () => {
      const hub = await spawnHub();
      running = hub;
      const res = await fetch(`${hub.baseUrl}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Forum Link');
    });

    it('rejects unauthenticated worker face with 401', { timeout: 15000 }, async () => {
      const hub = await spawnHub();
      running = hub;
      const res = await fetch(`${hub.baseUrl}/api/worker/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(401);
    });

    it('exits after shutdown signal', { timeout: 15000 }, async () => {
      const hub = await spawnHub();
      running = hub;
      const res = await fetch(`${hub.baseUrl}/`);
      expect(res.status).toBe(200);
      hub.child.kill();
      await waitForExit(hub.child, DEFAULT_TIMING.exitTimeoutMs);
      expect(hasExited(hub.child)).toBe(true);
      running = undefined;
      rmSync(hub.dataDir, { recursive: true, force: true });
    });
  });

  describe('token CLI on the build artifact', () => {
    interface CliResult {
      code: number | null;
      stdout: string;
      stderr: string;
    }

    function runCli(args: string[]): Promise<CliResult> {
      const child = spawn(process.execPath, [HUB_MJS, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      return new Promise((resolve, reject) => {
        child.once('exit', (code) => {
          resolve({ code, stdout, stderr });
        });
        setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`CLI did not exit: hub ${args.join(' ')}`));
        }, 8000).unref?.();
      });
    }

    it('token subcommands issue, list, and revoke against a running hub', { timeout: 15000 }, async () => {
      const hub = await spawnHub();
      running = hub;
      try {
        const issue = await runCli(['token', 'issue', 'device', 'phone-cli', '--data-dir', hub.dataDir]);
        expect(issue.code).toBe(0);
        const secret = /^secret: (\S+)$/m.exec(issue.stdout)?.[1];
        expect(secret).toBeTruthy();
        const login = await fetch(`${hub.baseUrl}/api/browser/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: secret }),
        });
        expect(login.status).toBe(204);

        const list = await runCli(['token', 'list', '--data-dir', hub.dataDir]);
        expect(list.code).toBe(0);
        const tokenId = /^\S+\tdevice\tphone-cli\t/m.exec(list.stdout)?.[0]?.split('\t')[0];
        expect(tokenId).toBeTruthy();

        const revoke = await runCli(['token', 'revoke', tokenId!, '--data-dir', hub.dataDir]);
        expect(revoke.code).toBe(0);
        const after = await fetch(`${hub.baseUrl}/api/browser/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: secret }),
        });
        expect(after.status).toBe(401);
      } finally {
        running = undefined;
        hub.child.kill();
        await waitForExit(hub.child, DEFAULT_TIMING.exitTimeoutMs);
        rmSync(hub.dataDir, { recursive: true, force: true });
      }
    });

    it('token subcommands fail with a clear error when no hub is running', { timeout: 15000 }, async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'forum-link-cli-none-'));
      try {
        const result = await runCli(['token', 'list', '--data-dir', dataDir]);
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain('hub serve');
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });
  });

  describe('boundary scans', () => {
    it('forum-link src has no v1 module references', () => {
      const pattern = /password|OPEN mode|registry|ThreadBuffer/;
      const offenders = listFiles(SRC_DIR)
        .map((file) => ({ file, content: readFileSync(file, 'utf8') }))
        .filter(({ content }) => pattern.test(content))
        .map(({ file }) => file);
      expect(offenders).toEqual([]);
    });

    it('contract files do not import hub or page modules', () => {
      const pattern = /(?:^|\/)(?:hub|page)\//;
      const offenders = specifiersIn(listFiles(join(SRC_DIR, 'contract')).filter((file) => file.endsWith('.ts')))
        .flatMap(({ file, specifiers }) =>
          specifiers.filter((specifier) => pattern.test(specifier)).map((specifier) => `${file}: ${specifier}`),
        );
      expect(offenders).toEqual([]);
    });

    it('apps link.ts does not import tui modules', () => {
      const pattern = /(?:^|\/)tui\//;
      const offenders = importSpecifiers(readFileSync(LINK_TS, 'utf8')).filter((specifier) => pattern.test(specifier));
      expect(offenders).toEqual([]);
    });

    it('forum-link src does not import apps/kimi-code', () => {
      const offenders = specifiersIn(listFiles(SRC_DIR))
        .flatMap(({ file, specifiers }) =>
          specifiers.filter((specifier) => specifier.includes('kimi-code')).map((specifier) => `${file}: ${specifier}`),
        );
      expect(offenders).toEqual([]);
    });

    it('page files do not import zod', () => {
      const offenders = specifiersIn(listFiles(join(SRC_DIR, 'page')))
        .flatMap(({ file, specifiers }) =>
          specifiers.filter((specifier) => specifier.includes('zod')).map((specifier) => `${file}: ${specifier}`),
        );
      expect(offenders).toEqual([]);
    });
  });
});
