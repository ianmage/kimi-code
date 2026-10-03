import process from 'node:process';
import { readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { pathToFileURL } from 'node:url';

import { createHubServer } from './router';
import { logLine } from './log';
import { readOrGenerateAdminKey, relaxAdminKeyPermissions } from './store';

const USAGE = `usage: hub serve [--data-dir <path>] [--port <number>] [--bind <address>] [--trusted-proxy <address>...]
                   [--heartbeat-interval-ms <number>] [--ntfy-url <url>] [--ntfy-topic <topic>]
                   [--ntfy-token <token>] [--public-url <url>]
       hub token issue <machine|device> <name> [--data-dir <path>]
       hub token list [--data-dir <path>]
       hub token revoke <tokenId> [--data-dir <path>]

options:
  --data-dir <path>          directory for state.json and admin.key
  --port <number>            port to listen on (default 0)
  --bind <address>           address to bind (default 127.0.0.1)
  --trusted-proxy <address>  treat this address as a trusted proxy for
                             X-Forwarded-For resolution (repeatable, loopback
                             is always trusted)
  --heartbeat-interval-ms <number>
                             SSE comment heartbeat interval in milliseconds
                             (default 15000)
  --write-interval-ms <number>
                             state.json write debounce interval in milliseconds
                             (default 500)
  --ntfy-url <url>           ntfy server base url
  --ntfy-topic <topic>       ntfy topic for new-card notifications
  --ntfy-token <token>       ntfy bearer token
  --public-url <url>         public base url used in notification deep links
  --help                     show this help
`;

const TOKEN_USAGE = `usage: hub token <command> [options]

commands:
  issue <machine|device> <name>   issue a new token and print its secret once
  list                            list issued tokens
  revoke <tokenId>                revoke a token

options:
  --data-dir <path>               directory containing admin.key (default .forum-link)
  --help                          show this help
`;

interface ServeOptions {
  command: 'serve';
  dataDir: string;
  port: number;
  bind: string;
  trustedProxies: string[];
  heartbeatIntervalMs: number;
  writeIntervalMs?: number;
  ntfyUrl?: string;
  ntfyTopic?: string;
  ntfyToken?: string;
  publicUrl?: string;
}

type TokenOptions =
  | { command: 'token'; action: 'issue'; dataDir: string; role: 'machine' | 'device'; name: string }
  | { command: 'token'; action: 'list'; dataDir: string }
  | { command: 'token'; action: 'revoke'; dataDir: string; tokenId: string };

const DEFAULT_DATA_DIR = '.forum-link';

interface AdminEndpoint {
  key: string;
  port: number;
}

function readAdminEndpoint(dataDir: string): AdminEndpoint {
  try {
    const key = readFileSync(`${dataDir}/admin.key`, 'utf8').trim();
    if (key.length === 0) throw new Error('empty');
    const port = Number.parseInt(readFileSync(`${dataDir}/hub.port`, 'utf8').trim(), 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('invalid');
    return { key, port };
  } catch {
    throw new Error(`admin.key or hub.port not found or unreadable in ${dataDir}; start hub serve first`);
  }
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`${flag} requires a value`);
  return value;
}

function parseServeArgs(argv: string[]): ServeOptions {
  const options: ServeOptions = {
    command: 'serve',
    dataDir: DEFAULT_DATA_DIR,
    port: 0,
    bind: '127.0.0.1',
    trustedProxies: [],
    heartbeatIntervalMs: 15000,
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help') {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (arg === '--data-dir') {
      options.dataDir = requireValue(argv, i, arg);
      i++;
      continue;
    }
    if (arg === '--port') {
      const value = requireValue(argv, i, arg);
      const port = Number.parseInt(value, 10);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port: ${value}`);
      options.port = port;
      i++;
      continue;
    }
    if (arg === '--bind') {
      options.bind = requireValue(argv, i, arg);
      i++;
      continue;
    }
    if (arg === '--trusted-proxy') {
      options.trustedProxies.push(requireValue(argv, i, arg));
      i++;
      continue;
    }
    if (arg === '--heartbeat-interval-ms') {
      const value = requireValue(argv, i, arg);
      const interval = Number.parseInt(value, 10);
      if (!Number.isInteger(interval) || interval <= 0) throw new Error(`invalid heartbeat interval: ${value}`);
      options.heartbeatIntervalMs = interval;
      i++;
      continue;
    }
    if (arg === '--write-interval-ms') {
      const value = requireValue(argv, i, arg);
      const interval = Number.parseInt(value, 10);
      if (!Number.isInteger(interval) || interval <= 0) throw new Error(`invalid write interval: ${value}`);
      options.writeIntervalMs = interval;
      i++;
      continue;
    }
    if (arg === '--ntfy-url') {
      options.ntfyUrl = requireValue(argv, i, arg);
      i++;
      continue;
    }
    if (arg === '--ntfy-topic') {
      options.ntfyTopic = requireValue(argv, i, arg);
      i++;
      continue;
    }
    if (arg === '--ntfy-token') {
      options.ntfyToken = requireValue(argv, i, arg);
      i++;
      continue;
    }
    if (arg === '--public-url') {
      options.publicUrl = requireValue(argv, i, arg);
      i++;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function parseTokenArgs(argv: string[]): TokenOptions {
  const rest = argv.slice(1);
  const positionals: string[] = [];
  let dataDir = DEFAULT_DATA_DIR;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--help') {
      process.stdout.write(TOKEN_USAGE);
      process.exit(0);
    }
    if (arg === '--data-dir') {
      dataDir = requireValue(rest, i, arg);
      i++;
      continue;
    }
    positionals.push(arg);
  }
  const action = positionals[0];
  if (action === 'issue') {
    const role = positionals[1];
    const name = positionals[2];
    if (role !== 'machine' && role !== 'device') throw new Error('issue requires a role: machine or device');
    if (name === undefined || name.length === 0) throw new Error('issue requires a name');
    if (positionals.length > 3) throw new Error('unexpected arguments after name');
    return { command: 'token', action: 'issue', dataDir, role, name };
  }
  if (action === 'list') {
    if (positionals.length > 1) throw new Error('list takes no arguments');
    return { command: 'token', action: 'list', dataDir };
  }
  if (action === 'revoke') {
    const tokenId = positionals[1];
    if (tokenId === undefined || tokenId.length === 0) throw new Error('revoke requires a tokenId');
    if (positionals.length > 2) throw new Error('unexpected arguments after tokenId');
    return { command: 'token', action: 'revoke', dataDir, tokenId };
  }
  throw new Error(`unknown token subcommand: ${action ?? '(none)'}`);
}

function parseArgs(argv: string[]): ServeOptions | TokenOptions {
  if (argv[0] === undefined || argv[0] === 'serve') return parseServeArgs(argv);
  if (argv[0] === 'token') return parseTokenArgs(argv);
  throw new Error(`unknown command: ${argv[0]}`);
}

interface AdminResponse {
  status: number;
  body: string;
}

function adminRequest(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<AdminResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', (error) => {
      reject(new Error(`cannot reach hub at http://127.0.0.1:${port} (is hub serve running?): ${String(error)}`));
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function runTokenCommand(args: TokenOptions): Promise<void> {
  const endpoint = readAdminEndpoint(args.dataDir);
  const headers = { authorization: `Bearer ${endpoint.key}`, 'content-type': 'application/json' };
  if (args.action === 'issue') {
    const res = await adminRequest(
      endpoint.port,
      'POST',
      '/api/admin/tokens',
      headers,
      JSON.stringify({ role: args.role, name: args.name }),
    );
    if (res.status !== 200) throw new Error(`issue failed: ${res.status} ${res.body}`);
    const parsed = JSON.parse(res.body) as { tokenId: string; secret: string };
    process.stdout.write(`tokenId: ${parsed.tokenId}\nsecret: ${parsed.secret}\n`);
    return;
  }
  if (args.action === 'list') {
    const res = await adminRequest(endpoint.port, 'GET', '/api/admin/tokens', headers);
    if (res.status !== 200) throw new Error(`list failed: ${res.status} ${res.body}`);
    const tokens = JSON.parse(res.body) as { tokenId: string; name: string; role: string; createdAt: number }[];
    for (const token of tokens) {
      process.stdout.write(`${token.tokenId}\t${token.role}\t${token.name}\t${new Date(token.createdAt).toISOString()}\n`);
    }
    return;
  }
  const res = await adminRequest(endpoint.port, 'DELETE', `/api/admin/tokens/${encodeURIComponent(args.tokenId)}`, headers);
  if (res.status !== 204) throw new Error(`revoke failed: ${res.status} ${res.body}`);
  process.stdout.write(`revoked ${args.tokenId}\n`);
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  if (args.command === 'token') {
    void runTokenCommand(args).then(
      () => {},
      (error) => {
        process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
        process.exitCode = 1;
      },
    );
    return;
  }
  const adminKey = readOrGenerateAdminKey(args.dataDir);
  if (!adminKey.ok) {
    process.stderr.write(`failed to prepare admin key: ${adminKey.error}\n`);
    process.exit(1);
  }
  relaxAdminKeyPermissions(`${args.dataDir}/admin.key`);
  let hub: ReturnType<typeof createHubServer>;
  try {
    hub = createHubServer({
      dataDir: args.dataDir,
      port: args.port,
      bind: args.bind,
      trustedProxies: args.trustedProxies,
      heartbeatIntervalMs: args.heartbeatIntervalMs,
      writeIntervalMs: args.writeIntervalMs,
      adminKey: adminKey.ok ? adminKey.key : undefined,
      ntfyUrl: args.ntfyUrl,
      ntfyTopic: args.ntfyTopic,
      ntfyToken: args.ntfyToken,
      publicUrl: args.publicUrl,
    });
  } catch (error) {
    logLine('start-refused', String(error));
    process.exit(1);
  }
  hub.server.listen(args.port, args.bind, () => {
    const address = hub.server.address();
    if (address === null || typeof address === 'string') {
      process.stderr.write(`failed to bind ${args.bind}\n`);
      process.exit(1);
    }
    process.stdout.write(`listening on http://${args.bind}:${address.port}\n`);
    writeFileSync(`${args.dataDir}/hub.port`, String(address.port), 'utf8');
  });
  const shutdown = () => {
    void hub.close().then((result) => {
      process.exit(result.ok ? 0 : 1);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (process.env['FORUM_LINK_GRACEFUL_SHUTDOWN_STDIN'] === '1') {
    process.stdin.resume();
    process.stdin.once('data', () => {
      shutdown();
    });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
