import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import { afterEach, describe, expect, it } from 'vitest';

import { SseMcpClient, isTerminalSseTransportError } from '#/mcpCore/client-sse';
import { deriveMcpRoots } from '#/mcpCore/roots';

import { startInProcessSseMcpServer } from './stubs';

interface RootsProbeResult {
  readonly capabilities: { roots?: { listChanged?: boolean } } | undefined;
  readonly roots: { readonly uri: string; readonly name?: string }[];
  readonly listChangedCount: number;
}

function parseRootsProbe(result: { content: { type: string; text?: string }[] }): RootsProbeResult {
  const text = result.content[0]?.text ?? '';
  return JSON.parse(text) as RootsProbeResult;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

describe('SseMcpClient', () => {
  it('connects, lists tools, and round-trips a call over real SSE', async () => {
    const server = await startInProcessSseMcpServer();
    cleanups.push(server.close);

    const client = new SseMcpClient({ transport: 'sse', url: server.url });
    try {
      await client.connect();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['echo']);

      const result = await client.callTool('echo', { text: 'hello sse' });
      expect(result.isError).toBe(false);
      expect(result.content).toEqual([{ type: 'text', text: 'hello sse' }]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('forwards bearer token from envLookup on the SSE and POST requests', async () => {
    const server = await startInProcessSseMcpServer({ authToken: 'good-token' });
    cleanups.push(server.close);

    const client = new SseMcpClient(
      {
        transport: 'sse',
        url: server.url,
        bearerTokenEnvVar: 'EXAMPLE_TOKEN',
      },
      { envLookup: (name) => (name === 'EXAMPLE_TOKEN' ? 'good-token' : undefined) },
    );
    try {
      await client.connect();
      const result = await client.callTool('echo', { text: 'with auth' });
      expect(result.content).toEqual([{ type: 'text', text: 'with auth' }]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('declares roots capability and answers roots/list with the derived snapshot', async () => {
    const server = await startInProcessSseMcpServer({ exposeRoots: true });
    cleanups.push(server.close);
    const dir = mkdtempSync(join(tmpdir(), 'kimi-mcp-roots-'));

    const client = new SseMcpClient({ transport: 'sse', url: server.url }, { rootDirectories: [dir] });
    try {
      await client.connect();
      const result = parseRootsProbe(await client.callTool('get_roots', {}));
      expect(result.capabilities?.roots?.listChanged).toBe(true);
      expect(result.roots).toEqual(deriveMcpRoots([dir]));
      expect(result.listChangedCount).toBe(0);
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  it('declares roots capability with an empty snapshot when no rootDirectories is given', async () => {
    const server = await startInProcessSseMcpServer({ exposeRoots: true });
    cleanups.push(server.close);

    const client = new SseMcpClient({ transport: 'sse', url: server.url });
    try {
      await client.connect();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('get_roots');
      const result = parseRootsProbe(await client.callTool('get_roots', {}));
      expect(result.capabilities?.roots?.listChanged).toBe(true);
      expect(result.roots).toEqual([]);
      expect(result.listChangedCount).toBe(0);
    } finally {
      await client.close();
    }
  }, 15000);

  it('classifies terminal SSE transport errors without treating reconnect flaps as terminal', () => {
    const unauthorized = new Error('Unauthorized');
    unauthorized.name = 'UnauthorizedError';
    expect(isTerminalSseTransportError(unauthorized)).toBe(true);
    expect(
      isTerminalSseTransportError(
        new SseError(
          204,
          'Server sent HTTP 204',
          {} as ConstructorParameters<typeof SseError>[2],
        ),
      ),
    ).toBe(true);
    expect(isTerminalSseTransportError(new Error('fetch failed'))).toBe(false);
  });
});
