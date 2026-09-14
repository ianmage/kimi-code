import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { Descriptor } from '#/contract/frames';

const HUB_MJS = fileURLToPath(new URL('../dist/hub.mjs', import.meta.url));
const PASSWORD = 'secret';
const AUTH = { Authorization: `Bearer ${PASSWORD}`, 'content-type': 'application/json' };

interface HubProcess {
  child: ChildProcess;
  baseUrl: string;
}

async function spawnHub(): Promise<HubProcess> {
  const child = spawn(process.execPath, [HUB_MJS, '--port', '0', '--password', PASSWORD], {
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
  const deadline = Date.now() + 5000;
  for (;;) {
    const match = /listening on http:\/\/(\S+):(\d+)/.exec(output);
    if (match !== null) {
      return { child, baseUrl: `http://127.0.0.1:${match[2]}` };
    }
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill();
      throw new Error(`hub process failed to start: ${output}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

async function registerThread(baseUrl: string): Promise<string> {
  const descriptor: Descriptor = {
    sessionId: 'giv3-closure',
    machineName: 'machine-1',
    projectName: 'project-1',
    title: 'GIV3 closure audit',
    status: 'running',
  };
  const res = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify(descriptor),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

async function postAction(baseUrl: string, payload: unknown, headers: Record<string, string> = AUTH): Promise<Response> {
  return fetch(`${baseUrl}/api/action`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
}

async function readFor(res: Response, ms: number): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const read = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      text += decoder.decode(value, { stream: true });
    }
  })();
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
  await reader.cancel();
  return text;
}

describe('Finalization GIV3 hub closure matrix', () => {
  let running: HubProcess | undefined;

  afterEach(async () => {
    if (running === undefined) return;
    const child = running.child;
    running = undefined;
    child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => {
        resolve();
      });
      setTimeout(resolve, 3000);
    });
  });

  it('rejects escalation-shaped payloads with 400 and keeps the downstream stream empty', { timeout: 15000 }, async () => {
    const hub = await spawnHub();
    running = hub;
    const threadId = await registerThread(hub.baseUrl);
    const stream = await fetch(`${hub.baseUrl}/api/stream/${threadId}`, { headers: AUTH });
    expect(stream.status).toBe(200);

    const payloads: unknown[] = [
      { type: 'approve', target: threadId, cardId: 'c1', approved_for_session: true },
      { type: 'approve', target: threadId, cardId: 'c1', permissionMode: 'never-ask' },
      { type: 'restart-session', target: threadId },
      { type: 'pause' },
    ];
    for (const payload of payloads) {
      const res = await postAction(hub.baseUrl, payload);
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('{"error":"invalid action"}');
    }

    const recorded = await readFor(stream, 300);
    expect(recorded).not.toContain('data: ');
  });

  it('answers 401 five times then 429 on the sixth wrong-password attempt', { timeout: 15000 }, async () => {
    const hub = await spawnHub();
    running = hub;
    const wrongAuth = { Authorization: 'Bearer wrong-password', 'content-type': 'application/json' };
    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await postAction(hub.baseUrl, { type: 'pause', target: 'any-thread' }, wrongAuth);
      expect(res.status).toBe(401);
    }
    const sixth = await postAction(hub.baseUrl, { type: 'pause', target: 'any-thread' }, wrongAuth);
    expect(sixth.status).toBe(429);
  });
});
