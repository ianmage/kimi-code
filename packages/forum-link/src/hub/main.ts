import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { formatStartupBanner } from './gate';
import { createHubServer } from './router';

const USAGE = `usage: hub [--port <number>] [--password <string>] [--bind <address>]
             [--heartbeat-interval-ms <number>] [--liveness-window-ms <number>]
             [--reap-interval-ms <number>] [--max-failures <number>] [--window-ms <number>]

options:
  --port <number>                   port to listen on (default 0)
  --password <string>               shared password for gate auth (default empty)
  --bind <address>                  address to bind (default 127.0.0.1)
  --heartbeat-interval-ms <number>  sse heartbeat cadence (default 30000)
  --liveness-window-ms <number>     thread liveness window (default 90000)
  --reap-interval-ms <number>       stale thread reap cadence (default 5000)
  --max-failures <number>           auth failures before rate limit (default 5)
  --window-ms <number>              rate limit window (default 60000)
  --help                            show this help
`;

interface CliOptions {
  port: number;
  password: string;
  bind: string;
  heartbeatIntervalMs?: number;
  livenessWindowMs?: number;
  reapIntervalMs?: number;
  maxFailures?: number;
  windowMs?: number;
}

const NUMBER_FLAGS = new Set([
  '--heartbeat-interval-ms',
  '--liveness-window-ms',
  '--reap-interval-ms',
  '--max-failures',
  '--window-ms',
]);

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`invalid value for ${flag}: ${value}`);
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { port: 0, password: '', bind: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--help') {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (arg === '--port') {
      const value = requireValue(argv, i, arg);
      const port = Number.parseInt(value, 10);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port: ${value}`);
      options.port = port;
      i++;
      continue;
    }
    if (arg === '--password') {
      options.password = requireValue(argv, i, arg);
      i++;
      continue;
    }
    if (arg === '--bind') {
      options.bind = requireValue(argv, i, arg);
      i++;
      continue;
    }
    if (NUMBER_FLAGS.has(arg)) {
      const value = requireValue(argv, i, arg);
      const parsed = parsePositiveInt(value, arg);
      if (arg === '--heartbeat-interval-ms') options.heartbeatIntervalMs = parsed;
      else if (arg === '--liveness-window-ms') options.livenessWindowMs = parsed;
      else if (arg === '--reap-interval-ms') options.reapIntervalMs = parsed;
      else if (arg === '--max-failures') options.maxFailures = parsed;
      else options.windowMs = parsed;
      i++;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  const hub = createHubServer({
    password: args.password,
    maxFailures: args.maxFailures,
    windowMs: args.windowMs,
    livenessWindowMs: args.livenessWindowMs,
    heartbeatIntervalMs: args.heartbeatIntervalMs,
    reapIntervalMs: args.reapIntervalMs,
  });
  hub.server.listen(args.port, args.bind, () => {
    const address = hub.server.address();
    if (address === null || typeof address === 'string') {
      process.stderr.write(`failed to bind ${args.bind}\n`);
      process.exit(1);
    }
    process.stdout.write(
      `${formatStartupBanner({ password: args.password, maxFailures: hub.gate.maxFailures, windowMs: hub.gate.windowMs })}\n`,
    );
    process.stdout.write(`listening on http://${args.bind}:${address.port}\n`);
  });
  const shutdown = () => {
    void hub.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
