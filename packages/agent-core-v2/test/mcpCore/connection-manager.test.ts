import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo as HttpAddress } from 'node:net';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'pathe';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCodes, Error2 } from '#/errors';
import { KIMI_MCP_CLIENT_NAME } from '#/mcpCore/client-shared';
import { McpConnectionManager, type McpConnectionManagerOptions, type McpServerEntry } from '#/mcpCore/connection-manager';
import { expandServerConfig, expandTemplateString } from '#/mcpCore/envExpand';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import { McpOAuthService } from '#/mcpCore/oauth/service';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import type { RuntimeBinding } from '#/runtime/runtime';

const testRuntimeBinding: RuntimeBinding = { workspaceId: 'test-workspace', runtimeId: 'local' };
const testProcess = new HostProcessService();
const testRuntime = Object.assign(
  new FakeRuntime({ ...testRuntimeBinding, generation: 'test-generation' }, {
    capabilities: ['process'],
  }),
  { process: testProcess },
);
const testRuntimeResolver = {
  _serviceBrand: undefined,
  inspect: () => testRuntime,
  acquire: () => ({
    runtime: testRuntime,
    track: <T extends { dispose(): void | Promise<void> }>(resource: T): T => resource,
    dispose: () => {},
  }),
};

function createManager(options: McpConnectionManagerOptions = {}): McpConnectionManager {
  return new McpConnectionManager({
    runtimeResolver: testRuntimeResolver,
    workspaceId: testRuntimeBinding.workspaceId,
    runtimeId: testRuntimeBinding.runtimeId,
    stdioCwd: process.cwd(),
    ...options,
  });
}

import {
  closeServer,
  crashAfterConnectFixture,
  createMemoryMcpOAuthStore,
  cwdStdioFixture,
  hangingListStdioFixture,
  slowStdioFixture,
  slowToolStdioFixture,
  startInProcessHttpMcpServer,
  stderrThenExitFixture,
  stdioFixture,
} from './stubs';

function stdioConfig(args: string[] = [stdioFixture]) {
  return {
    transport: 'stdio' as const,
    command: process.execPath,
    args,
  };
}

describe('McpConnectionManager', () => {
  it('connects servers in parallel and exposes connected entries with their tool count', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({ alpha: stdioConfig(), beta: stdioConfig() });
      const entries = cm.list();
      expect(entries.map((e) => e.name).toSorted()).toEqual(['alpha', 'beta']);
      for (const entry of entries) {
        expect(entry.status).toBe('connected');
        expect(entry.toolCount).toBe(4);
        expect(entry.transport).toBe('stdio');
      }
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('isolates failures: a bad server is marked failed without blocking the rest', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({
        good: stdioConfig(),
        bad: { transport: 'stdio', command: '/this/path/does/not/exist/anywhere' },
      });
      expect(cm.get('good')?.status).toBe('connected');
      expect(cm.get('bad')?.status).toBe('failed');
      expect(cm.get('bad')?.error).toBeDefined();
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('markRemoved tombstones the entry: client closed, entry kept, reconnect rejected, re-connect revives', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({ alpha: stdioConfig() });
      expect(cm.get('alpha')?.status).toBe('connected');

      const statuses: string[] = [];
      cm.onStatusChange((entry) => statuses.push(`${entry.name}:${entry.status}`));

      expect(await cm.markRemoved('alpha')).toBe(true);
      const entry = cm.get('alpha');
      expect(entry?.status).toBe('removed');
      expect(entry?.toolCount).toBe(0);
      expect(cm.resolved('alpha')).toBeUndefined();
      expect(cm.list().map((e) => e.name)).toEqual(['alpha']);
      expect(statuses).toContain('alpha:removed');
      await expect(cm.reconnect('alpha')).rejects.toThrow('Unknown MCP server: alpha');

      expect(await cm.markRemoved('missing')).toBe(false);

      await cm.connect('alpha', stdioConfig());
      expect(cm.get('alpha')?.status).toBe('connected');
      expect(cm.resolved('alpha')).toBeDefined();
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('connect with the identical config is a no-op for a live entry', async () => {
    const cm = createManager();
    const statuses: string[] = [];
    cm.onStatusChange((entry) => statuses.push(`${entry.name}:${entry.status}`));
    try {
      await cm.connect('alpha', stdioConfig());
      expect(cm.get('alpha')?.status).toBe('connected');
      statuses.length = 0;

      await cm.connect('alpha', stdioConfig());
      expect(cm.get('alpha')?.status).toBe('connected');
      expect(statuses).toEqual([]);

      await cm.connect('alpha', { ...stdioConfig(), startupTimeoutMs: 5_000 });
      expect(cm.get('alpha')?.status).toBe('connected');
      expect(statuses).toEqual(['alpha:pending', 'alpha:connected']);
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('marks HTTP servers failed when configured bearer token env var is missing', async () => {
    const cm = createManager({ envLookup: () => undefined });
    try {
      await cm.connectAll({
        remote: {
          transport: 'http',
          url: 'https://example.invalid/mcp',
          bearerTokenEnvVar: 'REMOTE_MCP_TOKEN',
        },
      });
      const entry = cm.get('remote');
      expect(entry?.status).toBe('failed');
      expect(entry?.error).toContain('"REMOTE_MCP_TOKEN" is not set or is empty');
    } finally {
      await cm.shutdown();
    }
  });

  it('marks SSE servers failed when configured bearer token env var is missing', async () => {
    const cm = createManager({ envLookup: () => undefined });
    try {
      await cm.connectAll({
        legacy: {
          transport: 'sse',
          url: 'https://example.invalid/sse',
          bearerTokenEnvVar: 'LEGACY_MCP_TOKEN',
        },
      });
      const entry = cm.get('legacy');
      expect(entry?.transport).toBe('sse');
      expect(entry?.status).toBe('failed');
      expect(entry?.error).toContain('"LEGACY_MCP_TOKEN" is not set or is empty');
    } finally {
      await cm.shutdown();
    }
  });

  it('marks disabled servers without attempting a connection', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({
        off: { ...stdioConfig(), enabled: false },
      });
      const entry = cm.get('off');
      expect(entry?.status).toBe('disabled');
      expect(entry?.toolCount).toBe(0);
    } finally {
      await cm.shutdown();
    }
  });

  it('applies enabledTools / disabledTools filters to the resolved tool set', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({
        filtered: { ...stdioConfig(), enabledTools: ['echo'], disabledTools: ['boom'] },
      });
      const resolved = cm.resolved('filtered');
      expect([...(resolved?.enabledNames ?? [])]).toEqual(['echo']);
      expect(cm.get('filtered')?.toolCount).toBe(1);
    } finally {
      await cm.shutdown();
    }
  }, 15000);

  it('starts stdio servers in stdioCwd when config.cwd is omitted', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-manager-cwd-'));
    const cm = createManager({ stdioCwd: cwd });
    try {
      await cm.connectAll({
        cwd: stdioConfig([cwdStdioFixture]),
      });
      const resolved = cm.resolved('cwd');
      if (resolved === undefined) throw new Error('Expected cwd MCP server to connect');
      const result = await resolved.client.callTool('get_cwd', {});
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(realpathSync(text)).toBe(realpathSync(cwd));
    } finally {
      await cm.shutdown();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 15000);

  it('announces the resolved custom identity as the MCP client name', async () => {
    const cm = createManager({ resolveClientName: () => 'acme-dev' });
    try {
      await cm.connectAll({ mock: stdioConfig() });
      const resolved = cm.resolved('mock');
      if (resolved === undefined) throw new Error('Expected mock MCP server to connect');
      const result = await resolved.client.callTool('whoami', {});
      expect((result.content[0] as { type: 'text'; text: string }).text).toBe('acme-dev');
    } finally {
      await cm.shutdown();
    }
  }, 15000);

  it('keeps the builtin MCP client name when no identity is configured', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({ mock: stdioConfig() });
      const resolved = cm.resolved('mock');
      if (resolved === undefined) throw new Error('Expected mock MCP server to connect');
      const result = await resolved.client.callTool('whoami', {});
      expect((result.content[0] as { type: 'text'; text: string }).text).toBe(
        KIMI_MCP_CLIENT_NAME,
      );
    } finally {
      await cm.shutdown();
    }
  }, 15000);

  it('emits status transitions in order per server', async () => {
    const cm = createManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((e) => seen.push({ name: e.name, status: e.status }));
    try {
      await cm.connectAll({ alpha: stdioConfig() });
      expect(seen.filter((s) => s.name === 'alpha').map((s) => s.status)).toEqual([
        'pending',
        'connected',
      ]);
    } finally {
      await cm.shutdown();
    }
  }, 15000);

  it('reconnect cycles a failed server back through pending and into connected when fixed', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({
        flaky: { transport: 'stdio', command: '/no/such/binary' },
      });
      expect(cm.get('flaky')?.status).toBe('failed');

      await cm.shutdown();
      await cm.connectAll({ flaky: stdioConfig() });
      await cm.reconnect('flaky');
      expect(cm.get('flaky')?.status).toBe('connected');
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('does not let stale in-flight startup failures overwrite a reconnect attempt', async () => {
    const cm = createManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((entry) => {
      seen.push({ name: entry.name, status: entry.status });
    });
    const delayedMockServer = `setTimeout(() => import(${JSON.stringify(
      pathToFileURL(stdioFixture).href,
    )}), 250)`;

    const connect = cm.connectAll({
      slow: {
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', delayedMockServer],
        startupTimeoutMs: 2_000,
      },
    });

    try {
      await sleep(50);
      await cm.reconnect('slow');
      await connect;

      expect(cm.get('slow')).toMatchObject({
        status: 'connected',
        toolCount: 4,
      });
      expect(seen.filter((event) => event.name === 'slow').map((event) => event.status)).toEqual([
        'pending',
        'pending',
        'connected',
      ]);
    } finally {
      await cm.shutdown();
      await Promise.race([connect.catch(() => {}), sleep(1_000)]);
    }
  }, 7000);

  it('reconnect throws a coded Error2 when the server name is unknown', async () => {
    const cm = createManager();
    try {
      await expect(cm.reconnect('nope')).rejects.toBeInstanceOf(Error2);
      await expect(cm.reconnect('nope')).rejects.toMatchObject({ code: 'mcp.server_not_found' });
    } finally {
      await cm.shutdown();
    }
  });

  it('reconnect rejects disabled servers without connecting them', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({
        off: { ...stdioConfig(), enabled: false },
      });

      await expect(cm.reconnect('off')).rejects.toBeInstanceOf(Error2);
      await expect(cm.reconnect('off')).rejects.toMatchObject({ code: 'mcp.server_disabled' });
      expect(cm.get('off')).toMatchObject({
        status: 'disabled',
        toolCount: 0,
      });
    } finally {
      await cm.shutdown();
    }
  });

  it('reconnectAndJoin joins an in-flight reconnect instead of starting a second one', async () => {
    const cm = createManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((entry) => {
      seen.push({ name: entry.name, status: entry.status });
    });
    const delayedMockServer = `setTimeout(() => import(${JSON.stringify(
      pathToFileURL(stdioFixture).href,
    )}), 250)`;

    try {
      await cm.connectAll({
        slow: {
          transport: 'stdio',
          command: process.execPath,
          args: ['-e', delayedMockServer],
          startupTimeoutMs: 5_000,
        },
      });
      seen.length = 0;

      await Promise.all([cm.reconnectAndJoin('slow'), cm.reconnectAndJoin('slow')]);

      expect(cm.get('slow')?.status).toBe('connected');
      expect(seen.filter((event) => event.name === 'slow').map((event) => event.status)).toEqual([
        'pending',
        'connected',
      ]);
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('reconnectAndJoin rejects for unknown servers', async () => {
    const cm = createManager();
    try {
      await expect(cm.reconnectAndJoin('nope')).rejects.toBeInstanceOf(Error2);
      await expect(cm.reconnectAndJoin('nope')).rejects.toMatchObject({
        code: 'mcp.server_not_found',
      });
    } finally {
      await cm.shutdown();
    }
  });

  it('shutdown clears entries and is idempotent', async () => {
    const cm = createManager();
    await cm.connectAll({ alpha: stdioConfig() });
    expect(cm.list()).toHaveLength(1);
    await cm.shutdown();
    expect(cm.list()).toEqual([]);
    await cm.shutdown();
  }, 15000);

  it('shutdown cancels in-flight startup without late status updates', async () => {
    const cm = createManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((entry) => {
      seen.push({ name: entry.name, status: entry.status });
    });

    const connectPromise = cm.connectAll({
      slowList: {
        transport: 'stdio',
        command: process.execPath,
        args: [hangingListStdioFixture],
        startupTimeoutMs: 5_000,
      },
    });

    await sleep(50);
    await cm.shutdown();

    const result = await Promise.race([
      connectPromise.then(() => 'resolved' as const),
      sleep(1_000).then(() => 'hung' as const),
    ]);
    expect(result).toBe('resolved');
    expect(cm.list()).toEqual([]);
    expect(seen).toEqual([{ name: 'slowList', status: 'pending' }]);
  }, 2000);

  it('honors startupTimeoutMs by marking slow servers failed', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({
        slow: {
          transport: 'stdio',
          command: process.execPath,
          args: [slowStdioFixture],
          startupTimeoutMs: 100,
        },
      });
      const entry = cm.get('slow');
      expect(entry?.status).toBe('failed');
      expect(entry?.error?.toLowerCase()).toContain('timed out');
    } finally {
      await cm.shutdown();
    }
  }, 15000);

  it('honors startupTimeoutMs while discovering tools', async () => {
    const cm = createManager();
    const connectPromise = cm.connectAll({
      slowList: {
        transport: 'stdio',
        command: process.execPath,
        args: [hangingListStdioFixture],
        startupTimeoutMs: 100,
      },
    });
    try {
      const result = await Promise.race([
        connectPromise.then(() => 'resolved' as const),
        sleep(1_000).then(() => 'hung' as const),
      ]);
      expect(result).toBe('resolved');

      const entry = cm.get('slowList');
      expect(entry?.status).toBe('failed');
      expect(entry?.error?.toLowerCase()).toContain('timed out');
    } finally {
      await cm.shutdown();
      await Promise.race([connectPromise.catch(() => {}), sleep(1_000)]);
    }
  }, 7000);

  it('applies the resolved default startup timeout when the server entry omits startupTimeoutMs', async () => {
    const cm = createManager({
      resolveDefaultTimeouts: () => ({ startupTimeoutMs: 100 }),
    });
    try {
      await cm.connectAll({
        slow: {
          transport: 'stdio',
          command: process.execPath,
          args: [slowStdioFixture],
        },
      });
      const entry = cm.get('slow');
      expect(entry?.status).toBe('failed');
      expect(entry?.error?.toLowerCase()).toContain('timed out');
    } finally {
      await cm.shutdown();
    }
  }, 15000);

  it.each([
    ['stdio', stdioConfig()],
    ['http', { transport: 'http' as const, url: 'https://example.test/mcp' }],
    ['sse', { transport: 'sse' as const, url: 'https://example.test/sse' }],
  ])(
    'forwards the resolved default startup timeout above the SDK default over %s',
    async (_transport, config) => {
      const connect = vi.spyOn(Client.prototype, 'connect').mockResolvedValue();
      const listTools = vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] });
      const cm = createManager({
        resolveDefaultTimeouts: () => ({ startupTimeoutMs: 120_000 }),
      });
      try {
        await cm.connectAll({ server: config });
        expect(connect).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ timeout: 120_000 }),
        );
        expect(listTools).toHaveBeenCalledWith(
          undefined,
          expect.objectContaining({ timeout: 120_000 }),
        );
      } finally {
        await cm.shutdown();
        connect.mockRestore();
        listTools.mockRestore();
      }
    },
  );

  it.each([
    ['stdio', stdioConfig()],
    ['http', { transport: 'http' as const, url: 'https://example.test/mcp' }],
    ['sse', { transport: 'sse' as const, url: 'https://example.test/sse' }],
  ])(
    'forwards per-server startupTimeoutMs above the SDK default over %s',
    async (_transport, config) => {
      const connect = vi.spyOn(Client.prototype, 'connect').mockResolvedValue();
      const listTools = vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] });
      const cm = createManager({
        resolveDefaultTimeouts: () => ({ startupTimeoutMs: 120_000 }),
      });
      try {
        await cm.connectAll({
          server: { ...config, startupTimeoutMs: 180_000 },
        });
        expect(connect).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ timeout: 180_000 }),
        );
        expect(listTools).toHaveBeenCalledWith(
          undefined,
          expect.objectContaining({ timeout: 180_000 }),
        );
      } finally {
        await cm.shutdown();
        connect.mockRestore();
        listTools.mockRestore();
      }
    },
  );

  it('applies the resolved default tool timeout when the server entry omits toolTimeoutMs', async () => {
    const cm = createManager({
      resolveDefaultTimeouts: () => ({ toolTimeoutMs: 100 }),
    });
    try {
      await cm.connectAll({
        slowTool: {
          transport: 'stdio',
          command: process.execPath,
          args: [slowToolStdioFixture],
        },
      });
      const client = cm.resolved('slowTool')?.client;
      if (client === undefined) throw new Error('expected a connected client');
      await expect(client.callTool('slow_echo', { text: 'hi' })).rejects.toThrow(/timed out/i);
    } finally {
      await cm.shutdown();
    }
  }, 15000);

  it('lets a per-server toolTimeoutMs override the resolved default tool timeout', async () => {
    const cm = createManager({
      resolveDefaultTimeouts: () => ({ toolTimeoutMs: 100 }),
    });
    try {
      await cm.connectAll({
        slowTool: {
          transport: 'stdio',
          command: process.execPath,
          args: [slowToolStdioFixture],
          toolTimeoutMs: 10_000,
        },
      });
      const client = cm.resolved('slowTool')?.client;
      if (client === undefined) throw new Error('expected a connected client');
      const result = await client.callTool('slow_echo', { text: 'hi' });
      expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('flips HTTP servers into needs-auth when the server returns 401 and no static token is set', async () => {
    const server: HttpServer = createHttpServer((_req, res) => {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate':
          'Bearer realm="mcp", resource_metadata="http://x/.well-known/oauth-protected-resource"',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as HttpAddress).port;
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const cm = createManager({ oauthService });
    try {
      await cm.connectAll({
        gated: {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          startupTimeoutMs: 5_000,
        },
      });
      const entry = cm.get('gated');
      expect(entry?.status).toBe('needs-auth');
      expect(entry?.error).toContain('run /mcp-config login gated');
      expect(entry?.toolCount).toBe(0);
    } finally {
      await cm.shutdown();
      await closeServer(server);
    }
  }, 15000);

  it('marks an explicitly OAuth HTTP server as needs-auth when non-auth headers accompany a 401', async () => {
    const server: HttpServer = createHttpServer((_req, res) => {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate':
          'Bearer realm="mcp", resource_metadata="http://x/.well-known/oauth-protected-resource"',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as HttpAddress).port;
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const cm = createManager({ oauthService });
    try {
      await cm.connectAll({
        gated: {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { 'X-Tenant': 'example' },
          auth: 'oauth',
          startupTimeoutMs: 5_000,
        },
      });
      const entry = cm.get('gated');
      expect(entry?.status).toBe('needs-auth');
      expect(entry?.error).toContain('run /mcp-config login gated');
      expect(entry?.toolCount).toBe(0);
    } finally {
      await cm.shutdown();
      await closeServer(server);
    }
  }, 15000);

  it('keeps a headers-only HTTP server failed (not needs-auth) on 401', async () => {
    const server: HttpServer = createHttpServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as HttpAddress).port;
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const cm = createManager({ oauthService });
    try {
      await cm.connectAll({
        keyed: {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: 'Bearer static-key' },
          startupTimeoutMs: 5_000,
        },
      });
      const entry = cm.get('keyed');
      expect(entry?.status).toBe('failed');
    } finally {
      await cm.shutdown();
      await closeServer(server);
    }
  }, 15000);

  it('flips SSE servers into needs-auth when the server returns 401 and no static token is set', async () => {
    const server: HttpServer = createHttpServer((_req, res) => {
      res.writeHead(401, {
        'content-type': 'text/plain',
        'www-authenticate':
          'Bearer realm="mcp", resource_metadata="http://x/.well-known/oauth-protected-resource"',
      });
      res.end('unauthorized');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as HttpAddress).port;
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const cm = createManager({ oauthService });
    try {
      await cm.connectAll({
        legacy: {
          transport: 'sse',
          url: `http://127.0.0.1:${port}/sse`,
          startupTimeoutMs: 5_000,
        },
      });
      const entry = cm.get('legacy');
      expect(entry?.transport).toBe('sse');
      expect(entry?.status).toBe('needs-auth');
      expect(entry?.error).toContain('run /mcp-config login legacy');
      expect(entry?.toolCount).toBe(0);
    } finally {
      await cm.shutdown();
      await closeServer(server);
    }
  }, 15000);

  it('flips cached OAuth credentials that require reauth into needs-auth', async () => {
    const server: HttpServer = createHttpServer((req, res) => {
      if (req.url === '/token') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer realm="mcp"',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as HttpAddress).port;
    const serverUrl = `http://127.0.0.1:${port}/mcp`;
    const authServerUrl = `http://127.0.0.1:${port}`;
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const provider = oauthService.getProvider('notion', serverUrl);
    await provider.saveDiscoveryState({
      authorizationServerUrl: authServerUrl,
      authorizationServerMetadata: {
        issuer: authServerUrl,
        authorization_endpoint: `${authServerUrl}/authorize`,
        token_endpoint: `${authServerUrl}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
      },
    });
    await provider.saveClientInformation({
      client_id: 'cached-client',
      redirect_uris: ['http://127.0.0.1:45678/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    } satisfies OAuthClientInformationFull);
    await provider.saveTokens({
      access_token: 'stale-access-token',
      refresh_token: 'stale-refresh-token',
      token_type: 'Bearer',
    } satisfies OAuthTokens);

    const cm = createManager({ oauthService });
    try {
      await cm.connectAll({
        notion: {
          transport: 'http',
          url: serverUrl,
          startupTimeoutMs: 5_000,
        },
      });
      const entry = cm.get('notion');
      expect(entry).toMatchObject({
        status: 'needs-auth',
        error: expect.stringContaining('run /mcp-config login notion'),
      });
      expect(entry?.error).not.toContain('redirectUrl must be set');
    } finally {
      await cm.shutdown();
      await closeServer(server);
    }
  }, 15000);

  it('marks HTTP 401 as failed when no OAuth service is configured', async () => {
    const server: HttpServer = createHttpServer((_req, res) => {
      res.writeHead(401).end('nope');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as HttpAddress).port;
    const cm = createManager();
    try {
      await cm.connectAll({
        gated: {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          startupTimeoutMs: 5_000,
        },
      });
      expect(cm.get('gated')?.status).toBe('failed');
    } finally {
      await cm.shutdown();
      await closeServer(server);
    }
  }, 15000);

  it('flips connected stdio servers to failed when the child exits unexpectedly', async () => {
    const cm = createManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((e) => seen.push({ name: e.name, status: e.status }));
    try {
      await cm.connectAll({
        crashy: {
          transport: 'stdio',
          command: process.execPath,
          args: [crashAfterConnectFixture],
          env: { KIMI_TEST_MCP_EXIT_AFTER_MS: '500', KIMI_TEST_MCP_STDERR: 'fatal: out of memory' },
          startupTimeoutMs: 4_000,
        },
      });
      expect(cm.get('crashy')?.status).toBe('connected');

      for (let i = 0; i < 100; i++) {
        if (cm.get('crashy')?.status === 'failed') break;
        await sleep(50);
      }
      const entry = cm.get('crashy');
      expect(entry?.status).toBe('failed');
      expect(entry?.toolCount).toBe(0);
      expect(entry?.error?.toLowerCase()).toContain('closed');
      expect(entry?.error).toContain('fatal: out of memory');
      expect(seen.filter((s) => s.name === 'crashy').map((s) => s.status)).toEqual([
        'pending',
        'connected',
        'failed',
      ]);
    } finally {
      await cm.shutdown();
    }
  }, 10000);

  it('includes captured stderr in the error when stdio connect fails before handshake', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({
        nope: {
          transport: 'stdio',
          command: process.execPath,
          args: [stderrThenExitFixture],
          env: { KIMI_TEST_MCP_STDERR: 'fatal: missing API token KIMI_X' },
          startupTimeoutMs: 4_000,
        },
      });
      const entry = cm.get('nope');
      expect(entry?.status).toBe('failed');
      expect(entry?.error).toContain('fatal: missing API token KIMI_X');
    } finally {
      await cm.shutdown();
    }
  }, 10000);

  it('does not flip to failed when the manager intentionally closes the client', async () => {
    const cm = createManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((e) => seen.push({ name: e.name, status: e.status }));
    try {
      await cm.connectAll({ alpha: stdioConfig() });
      expect(cm.get('alpha')?.status).toBe('connected');
      await cm.shutdown();
      await sleep(100);
      expect(seen.filter((s) => s.name === 'alpha').map((s) => s.status)).toEqual([
        'pending',
        'connected',
      ]);
    } finally {
      await cm.shutdown();
    }
  }, 10000);

  it('flips connected HTTP servers to failed when the SDK reports a terminal transport error', async () => {
    const mcpServer = new McpServer({ name: 'cm-terminal', version: '0.0.1' });
    mcpServer.registerTool(
      'echo',
      { description: 'Echoes text', inputSchema: { text: z.string() } },
      ({ text }) => ({ content: [{ type: 'text', text }] }),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await mcpServer.connect(transport);
    const httpServer = createHttpServer((req, res) => {
      void transport.handleRequest(req, res);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as HttpAddress).port;

    const cm = createManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((e) => seen.push({ name: e.name, status: e.status }));
    try {
      await cm.connectAll({
        remote: {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          startupTimeoutMs: 5_000,
        },
      });
      expect(cm.get('remote')?.status).toBe('connected');

      const internalClient = (cm as unknown as {
        entries: Map<string, { client?: { client: { onerror?: (e: Error) => void } } }>;
      }).entries.get('remote')?.client?.client;
      internalClient?.onerror?.(new Error('Maximum reconnection attempts (3) exceeded.'));

      for (let i = 0; i < 50; i++) {
        if (cm.get('remote')?.status === 'failed') break;
        await sleep(25);
      }
      const entry = cm.get('remote');
      expect(entry?.status).toBe('failed');
      expect(entry?.toolCount).toBe(0);
      expect(entry?.error).toContain('Maximum reconnection attempts');
      expect(seen.filter((s) => s.name === 'remote').map((s) => s.status)).toEqual([
        'pending',
        'connected',
        'failed',
      ]);
    } finally {
      await cm.shutdown();
      await closeServer(httpServer);
    }
  }, 15000);

  it('marks HTTP 401 as failed when the user pinned static headers', async () => {
    const server: HttpServer = createHttpServer((_req, res) => {
      res.writeHead(401).end('nope');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as HttpAddress).port;
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const cm = createManager({ oauthService });
    try {
      await cm.connectAll({
        keyed: {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { 'X-API-Key': 'wrong' },
          startupTimeoutMs: 5_000,
        },
      });
      expect(cm.get('keyed')?.status).toBe('failed');
    } finally {
      await cm.shutdown();
      await closeServer(server);
    }
  }, 15000);
});

describe('connectOne env expansion', () => {
  it('marks the entry failed with the variable name and field path when a variable is missing in command', async () => {
    const cm = createManager({ envLookup: () => undefined });
    try {
      await cm.connectAll({
        missing: {
          transport: 'stdio',
          command: '${NOPE}',
        },
      });
      const entry = cm.get('missing');
      expect(entry?.status).toBe('failed');
      expect(entry?.error).toContain('NOPE');
      expect(entry?.error).toContain('command');
    } finally {
      await cm.shutdown();
    }
  });

  it('marks the entry failed with args field path when a variable is missing in args', async () => {
    const cm = createManager({ envLookup: () => undefined });
    try {
      await cm.connectAll({
        missing: {
          transport: 'stdio',
          command: process.execPath,
          args: ['${MISSING_ARG}'],
        },
      });
      const entry = cm.get('missing');
      expect(entry?.status).toBe('failed');
      expect(entry?.error).toContain('MISSING_ARG');
      expect(entry?.error).toContain('args[0]');
    } finally {
      await cm.shutdown();
    }
  });

  it('marks the entry failed with env field path when a variable is missing in env', async () => {
    const cm = createManager({ envLookup: () => undefined });
    try {
      await cm.connectAll({
        missing: {
          transport: 'stdio',
          command: process.execPath,
          env: { TOKEN: '${MISSING_ENV}' },
        },
      });
      const entry = cm.get('missing');
      expect(entry?.status).toBe('failed');
      expect(entry?.error).toContain('MISSING_ENV');
      expect(entry?.error).toContain('env.TOKEN');
    } finally {
      await cm.shutdown();
    }
  });

  it('preserves the raw config in configOf after expansion fails', async () => {
    const cm = createManager({ envLookup: () => undefined });
    try {
      await cm.connectAll({
        templated: {
          transport: 'stdio',
          command: '${NOPE}',
        },
      });
      expect(cm.get('templated')?.status).toBe('failed');
      expect((cm.configOf('templated') as { command?: string })?.command).toBe('${NOPE}');
    } finally {
      await cm.shutdown();
    }
  });

  it('expands ${VAR} in remote headers and connects with the resolved value', async () => {
    const { url, close } = await startInProcessHttpMcpServer({ authToken: 'tok' });
    const cm = createManager({ envLookup: (name) => (name === 'T' ? 'tok' : undefined) });
    try {
      await cm.connectAll({
        remote: {
          transport: 'http',
          url,
          headers: { Authorization: 'Bearer ${T}' },
          startupTimeoutMs: 5_000,
        },
      });
      expect(cm.get('remote')?.status).toBe('connected');
    } finally {
      await cm.shutdown();
      await close();
    }
  }, 15000);

  it('marks remote failed when a header variable is missing', async () => {
    const cm = createManager({ envLookup: () => undefined });
    try {
      await cm.connectAll({
        remote: {
          transport: 'http',
          url: 'https://example.invalid/mcp',
          headers: { Authorization: 'Bearer ${MISSING_HEADER}' },
        },
      });
      const entry = cm.get('remote');
      expect(entry?.status).toBe('failed');
      expect(entry?.error).toContain('MISSING_HEADER');
      expect(entry?.error).toContain('headers.Authorization');
    } finally {
      await cm.shutdown();
    }
  });

  it('preserves the raw cwd and env templates in configOf after cwd expansion fails', async () => {
    const cm = createManager({ envLookup: () => undefined });
    try {
      await cm.connectAll({
        templated: {
          transport: 'stdio',
          command: process.execPath,
          cwd: '${ROOT}/s',
          env: { K: '${V}' },
        },
      });
      expect(cm.get('templated')?.status).toBe('failed');
      const raw = cm.configOf('templated') as { cwd?: string; env?: Record<string, string> };
      expect(raw?.cwd).toBe('${ROOT}/s');
      expect(raw?.env?.['K']).toBe('${V}');
    } finally {
      await cm.shutdown();
    }
  });

  it('fails with a cwd field-path error when an expanded cwd is relative, even with stdioCwd provided', async () => {
    const cm = createManager({
      envLookup: (name) => (name === 'ROOT' ? 'rel/path' : undefined),
      stdioCwd: process.cwd(),
    });
    try {
      await cm.connectAll({
        relative: {
          transport: 'stdio',
          command: process.execPath,
          cwd: '${ROOT}/s',
        },
      });
      const entry = cm.get('relative');
      expect(entry?.status).toBe('failed');
      expect(entry?.error).toContain('cwd');
      expect(entry?.error).not.toContain('rel/path');
      const raw = cm.configOf('relative') as { cwd?: string };
      expect(raw?.cwd).toBe('${ROOT}/s');
    } finally {
      await cm.shutdown();
    }
  });
});

describe('env expand', () => {
  describe('expandTemplateString', () => {
    it('returns a string without ${ unchanged', () => {
      const envLookup = (name: string) => (name === 'X' ? '1' : undefined);
      expect(expandTemplateString('plain text', 'command', envLookup)).toBe('plain text');
    });

    it('expands a single placeholder', () => {
      const envLookup = (name: string) => (name === 'X' ? '1' : undefined);
      expect(expandTemplateString('${X}', 'command', envLookup)).toBe('1');
    });

    it('expands multiple placeholders in one pass (A3)', () => {
      const envLookup = (name: string) => {
        if (name === 'X') return '1';
        if (name === 'Y') return '2';
        return undefined;
      };
      expect(expandTemplateString('a${X}b${Y}c', 'command', envLookup)).toBe('a1b2c');
    });

    it('throws CONFIG_INVALID when a variable is undefined (A1)', () => {
      const envLookup = () => undefined;
      expect(() => expandTemplateString('${K}', 'env.K', envLookup)).toThrowError(
        expect.objectContaining({ code: ErrorCodes.CONFIG_INVALID }),
      );
      try {
        expandTemplateString('${K}', 'env.K', envLookup);
      } catch (error) {
        expect(error).toBeInstanceOf(Error2);
        expect((error as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
        expect((error as Error).message).toContain('K');
        expect((error as Error).message).toContain('env.K');
      }
    });

    it('throws CONFIG_INVALID when a variable resolves to empty string (A2)', () => {
      const envLookup = () => '';
      try {
        expandTemplateString('${K}', 'env.K', envLookup);
      } catch (error) {
        expect(error).toBeInstanceOf(Error2);
        expect((error as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
        expect((error as Error).message).toContain('K');
        expect((error as Error).message).toContain('env.K');
      }
    });

    it('does not recursively expand ${${X}} — captures ${X as the name (A3)', () => {
      const envLookup = (name: string) => (name === 'X' ? '1' : undefined);
      try {
        expandTemplateString('${${X}}', 'command', envLookup);
        throw new Error('expected throw');
      } catch (error) {
        if (!(error instanceof Error2)) throw error;
        expect(error.code).toBe(ErrorCodes.CONFIG_INVALID);
        expect(error.message).toContain('${X');
        expect(error.message).not.toBe('1');
      }
    });

    it('treats an unclosed ${ as literal text', () => {
      const envLookup = () => undefined;
      expect(expandTemplateString('no close ${here', 'command', envLookup)).toBe(
        'no close ${here',
      );
    });

    it('does not leak env values into the error message (A6)', () => {
      const SECRET = 'super-secret-value-xyz';
      const envLookup = () => undefined;
      try {
        expandTemplateString('${TOKEN}', 'headers.Authorization', envLookup);
      } catch (error) {
        expect((error as Error).message).not.toContain(SECRET);
      }
      const envLookupWithValue = (name: string) => (name === 'TOKEN' ? SECRET : undefined);
      try {
        expandTemplateString('${OTHER}', 'headers.Authorization', envLookupWithValue);
      } catch (error) {
        expect((error as Error).message).not.toContain(SECRET);
      }
    });
  });

  describe('expandServerConfig', () => {
    it('returns a deep-equal config when there are no placeholders (A4)', () => {
      const envLookup = () => undefined;
      const config: McpServerConfig = {
        transport: 'stdio',
        command: '/usr/bin/node',
        args: ['server.mjs', '--port', '3000'],
        env: { NODE_ENV: 'production' },
        cwd: '/app',
      };
      expect(expandServerConfig(config, envLookup)).toEqual(config);
    });

    it('returns a new object and does not mutate the input (A5)', () => {
      const envLookup = (name: string) => (name === 'X' ? 'expanded' : undefined);
      const config: McpServerConfig = {
        transport: 'stdio',
        command: '${X}-cmd',
        args: ['${X}-arg'],
        env: { KEY: '${X}-val' },
        cwd: '/abs/${X}-cwd',
      };
      const snapshot = structuredClone(config);
      const result = expandServerConfig(config, envLookup);
      expect(result).not.toBe(config);
      expect(config).toEqual(snapshot);
      expect(result).toEqual({
        transport: 'stdio',
        command: 'expanded-cmd',
        args: ['expanded-arg'],
        env: { KEY: 'expanded-val' },
        cwd: '/abs/expanded-cwd',
      });
    });

    it('expands stdio fields: command, args[], env{}, cwd', () => {
      const envLookup = (name: string) => {
        const map: Record<string, string> = { CMD: 'node', A1: 'a1', A2: 'a2', EV: 'secret', CWD: '/work' };
        return map[name];
      };
      const config: McpServerConfig = {
        transport: 'stdio',
        command: '${CMD}',
        args: ['server.mjs', '${A1}', '${A2}'],
        env: { TOKEN: '${EV}' },
        cwd: '${CWD}',
      };
      const result = expandServerConfig(config, envLookup);
      expect(result).toEqual({
        transport: 'stdio',
        command: 'node',
        args: ['server.mjs', 'a1', 'a2'],
        env: { TOKEN: 'secret' },
        cwd: '/work',
      });
    });

    it('expands remote (http) headers{} values', () => {
      const envLookup = (name: string) => (name === 'AUTH' ? 'tok' : undefined);
      const config: McpServerConfig = {
        transport: 'http',
        url: 'https://example.test/mcp',
        headers: { Authorization: 'Bearer ${AUTH}', 'X-Other': 'static' },
      };
      const result = expandServerConfig(config, envLookup);
      expect(result).toEqual({
        transport: 'http',
        url: 'https://example.test/mcp',
        headers: { Authorization: 'Bearer tok', 'X-Other': 'static' },
      });
    });

    it('expands remote (sse) headers{} values', () => {
      const envLookup = (name: string) => (name === 'AUTH' ? 'Bearer tok' : undefined);
      const config: McpServerConfig = {
        transport: 'sse',
        url: 'https://example.test/sse',
        headers: { Authorization: '${AUTH}' },
      };
      const result = expandServerConfig(config, envLookup);
      expect(result).toEqual({
        transport: 'sse',
        url: 'https://example.test/sse',
        headers: { Authorization: 'Bearer tok' },
      });
    });

    it('passes through non-whitelist fields byte-identical (A5)', () => {
      const envLookup = (name: string) => (name === 'CMD' ? 'node' : undefined);
      const config: McpServerConfig = {
        transport: 'http',
        url: 'https://example.test/mcp',
        headers: { Authorization: 'Bearer ${CMD}' },
        enabledTools: ['echo', 'boom'],
        disabledTools: ['bad'],
        startupTimeoutMs: 5_000,
        toolTimeoutMs: 10_000,
        enabled: false,
        auth: 'oauth',
        bearerTokenEnvVar: 'REMOTE_TOKEN',
      };
      const result = expandServerConfig(config, envLookup);
      expect(result.url).toBe('https://example.test/mcp');
      expect(result.enabledTools).toBe(config.enabledTools);
      expect(result.disabledTools).toBe(config.disabledTools);
      expect(result.startupTimeoutMs).toBe(5_000);
      expect(result.toolTimeoutMs).toBe(10_000);
      expect(result.enabled).toBe(false);
      expect(result.auth).toBe('oauth');
      expect(result.bearerTokenEnvVar).toBe('REMOTE_TOKEN');
    });

    it('passes through stdio executor and runtime_id byte-identical', () => {
      const envLookup = () => undefined;
      const config: McpServerConfig = {
        transport: 'stdio',
        command: 'node',
        executor: 'kaos',
        runtime_id: 'local-1',
      };
      const result = expandServerConfig(config, envLookup);
      expect(result.executor).toBe('kaos');
      expect(result.runtime_id).toBe('local-1');
    });

    it('throws CONFIG_INVALID mentioning the fieldPath for undefined env var (A1)', () => {
      const envLookup = () => undefined;
      const cases: Array<{ config: McpServerConfig; fieldPath: string }> = [
        { config: { transport: 'stdio', command: '${MISSING}' }, fieldPath: 'command' },
        { config: { transport: 'stdio', command: 'node', args: ['a', 'b', '${MISSING}'] }, fieldPath: 'args[2]' },
        { config: { transport: 'stdio', command: 'node', env: { K: '${MISSING}' } }, fieldPath: 'env.K' },
        { config: { transport: 'stdio', command: 'node', cwd: '${MISSING}' }, fieldPath: 'cwd' },
        {
          config: { transport: 'http', url: 'https://x.test', headers: { Authorization: '${MISSING}' } },
          fieldPath: 'headers.Authorization',
        },
      ];
      for (const { config, fieldPath } of cases) {
        try {
          expandServerConfig(config, envLookup);
          throw new Error(`expected throw for ${fieldPath}`);
        } catch (error) {
          expect(error).toBeInstanceOf(Error2);
          expect((error as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
          expect((error as Error).message).toContain(fieldPath);
        }
      }
    });

    it('throws CONFIG_INVALID for empty-string env var (A2)', () => {
      const envLookup = () => '';
      try {
        expandServerConfig(
          { transport: 'stdio', command: '${EMPTY}' },
          envLookup,
        );
      } catch (error) {
        expect(error).toBeInstanceOf(Error2);
        expect((error as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
        expect((error as Error).message).toContain('command');
      }
    });

    it('throws CONFIG_INVALID when an expanded cwd is a relative path', () => {
      const envLookup = (name: string) => (name === 'ROOT' ? 'rel/path' : undefined);
      try {
        expandServerConfig(
          { transport: 'stdio', command: 'node', cwd: '${ROOT}/s' },
          envLookup,
        );
        throw new Error('expected throw');
      } catch (error) {
        expect(error).toBeInstanceOf(Error2);
        expect((error as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
        expect((error as Error).message).toContain('cwd');
        expect((error as Error).message).not.toContain('rel/path');
      }
    });

    it('accepts POSIX, drive-letter, and UNC absolute expanded cwds', () => {
      const map: Record<string, string> = {
        POSIX: '/abs/work',
        DRIVE: 'C:/Users/x/work',
        UNC: '//server/share/work',
      };
      for (const expected of Object.values(map)) {
        const result = expandServerConfig(
          { transport: 'stdio', command: 'node', cwd: '${X}' },
          (name) => (name === 'X' ? expected : undefined),
        );
        expect(result.cwd).toBe(expected);
      }
    });

    it('does not leak env values in error messages for any field (A6)', () => {
      const SECRET = 'leak-me-if-you-can-12345';
      const envLookup = (name: string) => (name === 'PRESENT' ? SECRET : undefined);
      const configs: McpServerConfig[] = [
        { transport: 'stdio', command: '${ABSENT}' },
        { transport: 'stdio', command: 'node', env: { K: '${ABSENT}' } },
        { transport: 'http', url: 'https://x.test', headers: { Authorization: '${ABSENT}' } },
      ];
      for (const config of configs) {
        try {
          expandServerConfig(config, envLookup);
        } catch (error) {
          expect((error as Error).message).not.toContain(SECRET);
        }
      }
    });
  });
});
