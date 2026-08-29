import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';

import { ErrorCodes, Error2 } from '#/errors';
import { loadMcpServers, resolveMcpJsonPaths } from '#/app/mcpConfig/configLoader';
import {
  McpServerConfigSchema,
  McpServerHttpConfigSchema,
  McpServerSseConfigSchema,
} from '#/mcpCore/config-schema';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';

const fs = new HostFileSystem();

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-mcp-loader-'));
  tempDirs.push(dir);
  return dir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value), 'utf-8');
}

describe('resolveMcpJsonPaths', () => {
  it('returns the canonical user, project-root, and project-local paths', async () => {
    const repoRoot = makeTempDir();
    const cwd = join(repoRoot, 'packages', 'agent-core');
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    await mkdir(cwd, { recursive: true });

    const paths = await resolveMcpJsonPaths({ fs, cwd, homeDir: '/home/user/.kimi-code' });

    expect(paths.user).toBe('/home/user/.kimi-code/mcp.json');
    expect(paths.projectRoot).toBe(join(repoRoot, '.mcp.json'));
    expect(paths.project).toBe(join(cwd, '.kimi-code', 'mcp.json'));
  });
});

describe('loadMcpServers', () => {
  it('returns an empty map when no files exist', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    const servers = await loadMcpServers({ fs, cwd, homeDir: home });
    expect(servers).toEqual({});
  });

  it('treats empty JSON files as empty maps', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeFile(join(home, 'mcp.json'), '   \n');
    const servers = await loadMcpServers({ fs, cwd, homeDir: home });
    expect(servers).toEqual({});
  });

  it('rejects a null mcpServers field', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), { mcpServers: null });

    await expect(loadMcpServers({ fs, cwd, homeDir: home })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    });
  });

  it('merges project-local mcp.json with user-global, project overriding on conflict', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();

    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        shared: { transport: 'stdio', command: 'shared-user' },
        userOnly: { transport: 'stdio', command: 'user-only' },
      },
    });
    await writeJson(join(cwd, '.kimi-code', 'mcp.json'), {
      mcpServers: {
        shared: { transport: 'stdio', command: 'shared-project' },
        local: { transport: 'http', url: 'http://localhost:8080/mcp' },
      },
    });

    const servers = await loadMcpServers({ fs, cwd, homeDir: home });

    expect(Object.keys(servers).toSorted()).toEqual(['local', 'shared', 'userOnly']);
    expect(servers['shared']).toEqual({
      transport: 'stdio',
      command: 'shared-project',
    });
    expect(servers['userOnly']).toEqual({
      transport: 'stdio',
      command: 'user-only',
    });
    expect(servers['local']).toEqual({
      transport: 'http',
      url: 'http://localhost:8080/mcp',
    });
  });

  it('loads only the user file when includeProject is false (untrusted workspace)', async () => {
    const home = makeTempDir();
    const repoRoot = makeTempDir();
    const cwd = join(repoRoot, 'packages', 'agent-core');
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    await mkdir(cwd, { recursive: true });

    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        shared: { transport: 'stdio', command: 'shared-user' },
        userOnly: { transport: 'stdio', command: 'user-only' },
      },
    });
    await writeJson(join(repoRoot, '.mcp.json'), {
      mcpServers: {
        shared: { transport: 'stdio', command: 'shared-root' },
        rootOnly: { command: 'root-only' },
      },
    });
    await writeJson(join(cwd, '.kimi-code', 'mcp.json'), {
      mcpServers: {
        shared: { transport: 'stdio', command: 'shared-project' },
        projectOnly: { transport: 'http', url: 'https://mcp.example.com' },
      },
    });

    const servers = await loadMcpServers({ fs, cwd, homeDir: home, includeProject: false });

    expect(Object.keys(servers).toSorted()).toEqual(['shared', 'userOnly']);
    expect(servers['shared']).toEqual({
      transport: 'stdio',
      command: 'shared-user',
    });
  });

  it('loads root .mcp.json from the repo root and lets project-local override it', async () => {
    const home = makeTempDir();
    const repoRoot = makeTempDir();
    const cwd = join(repoRoot, 'packages', 'agent-core');
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    await mkdir(cwd, { recursive: true });

    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        shared: { transport: 'stdio', command: 'shared-user' },
        userOnly: { transport: 'stdio', command: 'user-only' },
      },
    });
    await writeJson(join(repoRoot, '.mcp.json'), {
      mcpServers: {
        shared: { transport: 'stdio', command: 'shared-root' },
        rootOnly: { command: 'root-only' },
      },
    });
    await writeJson(join(cwd, '.kimi-code', 'mcp.json'), {
      mcpServers: {
        shared: { transport: 'stdio', command: 'shared-project' },
        projectOnly: { transport: 'http', url: 'https://mcp.example.com' },
      },
    });

    const servers = await loadMcpServers({ fs, cwd, homeDir: home });

    expect(Object.keys(servers).toSorted()).toEqual([
      'projectOnly',
      'rootOnly',
      'shared',
      'userOnly',
    ]);
    expect(servers['shared']).toEqual({
      transport: 'stdio',
      command: 'shared-project',
    });
    expect(servers['rootOnly']).toEqual({ transport: 'stdio', command: 'root-only', cwd: repoRoot });
    expect(servers['userOnly']).toEqual({ transport: 'stdio', command: 'user-only' });
    expect(servers['projectOnly']).toEqual({ transport: 'http', url: 'https://mcp.example.com' });
  });

  it('resolves project-root stdio cwd relative to the root .mcp.json directory', async () => {
    const home = makeTempDir();
    const repoRoot = makeTempDir();
    const cwd = join(repoRoot, 'packages', 'agent-core');
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    await mkdir(cwd, { recursive: true });

    await writeJson(join(repoRoot, '.mcp.json'), {
      mcpServers: {
        implicitRoot: { command: './bin/mcp-server' },
        explicitDot: { command: './bin/mcp-server', cwd: '.' },
        nested: { command: 'node', cwd: 'tools/mcp' },
        absolute: { command: 'node', cwd: '/tmp/mcp-workdir' },
        remote: { url: 'https://mcp.example.com' },
      },
    });

    const servers = await loadMcpServers({ fs, cwd, homeDir: home });

    expect(servers['implicitRoot']).toEqual({
      transport: 'stdio',
      command: './bin/mcp-server',
      cwd: repoRoot,
    });
    expect(servers['explicitDot']).toEqual({
      transport: 'stdio',
      command: './bin/mcp-server',
      cwd: repoRoot,
    });
    expect(servers['nested']).toEqual({
      transport: 'stdio',
      command: 'node',
      cwd: join(repoRoot, 'tools', 'mcp'),
    });
    expect(servers['absolute']).toEqual({
      transport: 'stdio',
      command: 'node',
      cwd: '/tmp/mcp-workdir',
    });
    expect(servers['remote']).toEqual({
      transport: 'http',
      url: 'https://mcp.example.com',
    });
  });

  it('keeps Windows drive-letter and UNC stdio cwd values resolved on any host', async () => {
    const home = makeTempDir();
    const repoRoot = makeTempDir();
    const cwd = join(repoRoot, 'packages', 'agent-core');
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    await mkdir(cwd, { recursive: true });

    await writeJson(join(repoRoot, '.mcp.json'), {
      mcpServers: {
        drive: { command: 'node', cwd: 'C:/tools' },
        driveBackslash: { command: 'node', cwd: 'C:\\tools\\bin' },
        unc: { command: 'node', cwd: '//server/share/tools' },
      },
    });

    const servers = await loadMcpServers({ fs, cwd, homeDir: home });

    expect(servers['drive']).toMatchObject({ cwd: 'C:/tools' });
    expect(servers['driveBackslash']).toMatchObject({ cwd: 'C:/tools/bin' });
    expect(servers['unc']).toMatchObject({ cwd: '//server/share/tools' });
  });

  it('throws Error2(config.invalid) on invalid JSON', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeFile(join(home, 'mcp.json'), '{not json}', 'utf-8');
    await expect(loadMcpServers({ fs, cwd, homeDir: home })).rejects.toBeInstanceOf(Error2);
    await expect(loadMcpServers({ fs, cwd, homeDir: home })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    });
  });

  it('throws Error2(config.invalid) on schema violation with unknown transport', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: { bad: { transport: 'websocket', url: 'https://x.example.com' } },
    });
    await expect(loadMcpServers({ fs, cwd, homeDir: home })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    });
  });

  it('throws Error2(config.invalid) on schema violation with missing required field', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: { bad: { transport: 'stdio' } },
    });
    await expect(loadMcpServers({ fs, cwd, homeDir: home })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    });
  });

  it('throws Error2(config.invalid) when an MCP timeout exceeds the Node.js timer limit', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        bad: {
          transport: 'stdio',
          command: 'node',
          startupTimeoutMs: 2_147_483_648,
          toolTimeoutMs: 2_147_483_648,
        },
      },
    });
    await expect(loadMcpServers({ fs, cwd, homeDir: home })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    });
  });

  it('loads MCP timeouts at the Node.js timer upper boundary', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        boundary: {
          transport: 'stdio',
          command: 'node',
          startupTimeoutMs: 2_147_483_647,
          toolTimeoutMs: 2_147_483_647,
        },
      },
    });
    await expect(loadMcpServers({ fs, cwd, homeDir: home })).resolves.toEqual({
      boundary: {
        transport: 'stdio',
        command: 'node',
        startupTimeoutMs: 2_147_483_647,
        toolTimeoutMs: 2_147_483_647,
      },
    });
  });

  it('infers transport=stdio when an entry omits transport but has command', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        gh: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
      },
    });
    const servers = await loadMcpServers({ fs, cwd, homeDir: home });
    expect(servers['gh']).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
    });
  });

  it('infers transport=http when an entry omits transport but has url', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        remote: { url: 'https://mcp.example.com/sse' },
      },
    });
    const servers = await loadMcpServers({ fs, cwd, homeDir: home });
    expect(servers['remote']).toEqual({
      transport: 'http',
      url: 'https://mcp.example.com/sse',
    });
  });

  it('loads explicit SSE server config', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        legacy: {
          transport: 'sse',
          url: 'https://mcp.example.com/sse',
          headers: { 'X-Tenant': 'kimi' },
          bearerTokenEnvVar: 'LEGACY_MCP_TOKEN',
        },
      },
    });
    const servers = await loadMcpServers({ fs, cwd, homeDir: home });
    expect(servers['legacy']).toEqual({
      transport: 'sse',
      url: 'https://mcp.example.com/sse',
      headers: { 'X-Tenant': 'kimi' },
      bearerTokenEnvVar: 'LEGACY_MCP_TOKEN',
    });
  });

  it('honors KIMI_CODE_HOME env var when homeDir is not supplied', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: { from_env: { transport: 'stdio', command: 'env-cmd' } },
    });
    const saved = process.env['KIMI_CODE_HOME'];
    process.env['KIMI_CODE_HOME'] = home;
    try {
      const servers = await loadMcpServers({ fs, cwd });
      expect(servers['from_env']).toEqual({ transport: 'stdio', command: 'env-cmd' });
    } finally {
      if (saved === undefined) delete process.env['KIMI_CODE_HOME'];
      else process.env['KIMI_CODE_HOME'] = saved;
    }
  });

  it('drops a remote url containing env template expansion (bare placeholder) and warns', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        bad: { transport: 'http', url: 'https://base/${PATH_SEG}' },
        ok: { transport: 'stdio', command: 'node' },
      },
    });
    const warnings: string[] = [];
    const servers = await loadMcpServers({
      fs,
      cwd,
      homeDir: home,
      onWarn: (m) => warnings.push(m),
    });
    expect(Object.keys(servers)).toEqual(['ok']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('bad');
    expect(warnings[0]).toContain('url');
  });

  it('drops a remote url containing env template expansion (interpolated) and warns', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: { bad: { transport: 'http', url: 'https://x.com/${P}' } },
    });
    const warnings: string[] = [];
    const servers = await loadMcpServers({
      fs,
      cwd,
      homeDir: home,
      onWarn: (m) => warnings.push(m),
    });
    expect(servers).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('bad');
  });

  it('keeps other entries when one remote url contains a placeholder (per-layer isolation)', async () => {
    const home = makeTempDir();
    const repoRoot = makeTempDir();
    const cwd = join(repoRoot, 'pkg');
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        userOk: { transport: 'stdio', command: 'node' },
        userBad: { transport: 'http', url: 'https://x.com/${P}' },
      },
    });
    await writeJson(join(repoRoot, '.mcp.json'), {
      mcpServers: {
        rootOk: { transport: 'http', url: 'https://mcp.example.com/mcp' },
      },
    });
    await writeJson(join(cwd, '.kimi-code', 'mcp.json'), {
      mcpServers: {
        projBad: { transport: 'sse', url: 'https://y.com/${Q}' },
        projOk: { transport: 'stdio', command: 'node' },
      },
    });
    const warnings: string[] = [];
    const servers = await loadMcpServers({
      fs,
      cwd,
      homeDir: home,
      onWarn: (m) => warnings.push(m),
    });
    expect(Object.keys(servers).toSorted()).toEqual(['projOk', 'rootOk', 'userOk']);
    expect(warnings).toHaveLength(2);
    expect(warnings.some((m) => m.includes('userBad'))).toBe(true);
    expect(warnings.some((m) => m.includes('projBad'))).toBe(true);
  });

  it('loads a valid remote url without env template expansion', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: { ok: { transport: 'http', url: 'https://mcp.example.com/mcp' } },
    });
    const servers = await loadMcpServers({ fs, cwd, homeDir: home });
    expect(servers['ok']).toEqual({ transport: 'http', url: 'https://mcp.example.com/mcp' });
  });

  it('keeps a stdio cwd and env with env template placeholders verbatim', async () => {
    const home = makeTempDir();
    const repoRoot = makeTempDir();
    const cwd = join(repoRoot, 'packages', 'agent-core');
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    await mkdir(cwd, { recursive: true });

    await writeJson(join(repoRoot, '.mcp.json'), {
      mcpServers: {
        templated: { command: 'node', cwd: '${ROOT}/s', env: { K: '${V}' } },
      },
    });

    const servers = await loadMcpServers({ fs, cwd, homeDir: home });

    expect(servers['templated']).toEqual({
      transport: 'stdio',
      command: 'node',
      cwd: '${ROOT}/s',
      env: { K: '${V}' },
    });
  });

  it('keeps the headered entry and drops only the placeholder-url entry when they coexist', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        headered: {
          transport: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: 'Bearer ${T}' },
        },
        urlExpanded: {
          transport: 'http',
          url: 'https://base/${BASE}',
        },
      },
    });
    const warnings: string[] = [];
    const servers = await loadMcpServers({
      fs,
      cwd,
      homeDir: home,
      onWarn: (m) => warnings.push(m),
    });
    expect(Object.keys(servers)).toEqual(['headered']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('urlExpanded');
  });
});

describe('MCP server config schema: bearerTokenEnvVar deprecation', () => {
  it('marks bearerTokenEnvVar as deprecated with a headers migration example', () => {
    const httpDesc = McpServerHttpConfigSchema.shape.bearerTokenEnvVar?.description ?? '';
    const sseDesc = McpServerSseConfigSchema.shape.bearerTokenEnvVar?.description ?? '';

    expect(httpDesc).toMatch(/deprecated/i);
    expect(httpDesc).toContain('headers: {"Authorization": "Bearer ${TOKEN}"}');
    expect(sseDesc).toMatch(/deprecated/i);
    expect(sseDesc).toContain('headers: {"Authorization": "Bearer ${TOKEN}"}');
  });

  it('still validates bearerTokenEnvVar on http/sse MCP server configs', () => {
    expect(McpServerConfigSchema.safeParse({
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      bearerTokenEnvVar: 'MY_TOKEN',
    }).success).toBe(true);
    expect(McpServerConfigSchema.safeParse({
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
    }).success).toBe(true);
    expect(McpServerConfigSchema.safeParse({
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      bearerTokenEnvVar: '',
    }).success).toBe(false);

    expect(McpServerConfigSchema.safeParse({
      transport: 'sse',
      url: 'https://mcp.example.com/sse',
      bearerTokenEnvVar: 'MY_TOKEN',
    }).success).toBe(true);
    expect(McpServerConfigSchema.safeParse({
      transport: 'sse',
      url: 'https://mcp.example.com/sse',
    }).success).toBe(true);
    expect(McpServerConfigSchema.safeParse({
      transport: 'sse',
      url: 'https://mcp.example.com/sse',
      bearerTokenEnvVar: '',
    }).success).toBe(false);
  });
});
