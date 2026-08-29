import { isAbsolute } from 'pathe';

import type { McpServerConfig } from '#/config/schema';
import { ErrorCodes, KimiError } from '#/errors';

/**
 * Expand `${NAME}` placeholders in a single string using a single-pass scan.
 *
 * Scans for `${` and matches up to the FIRST `}` — no recursion, no re-scan of
 * the output. An undefined or empty-string lookup result throws CONFIG_INVALID
 * whose message contains only the variable name and the field path, never any
 * env value. A `${` with no closing `}` before end-of-string is left as literal
 * text.
 */
export function expandTemplateString(
  template: string,
  fieldPath: string,
  envLookup: (name: string) => string | undefined,
): string {
  let result = '';
  let i = 0;
  while (i < template.length) {
    const dollar = template.indexOf('${', i);
    if (dollar === -1) {
      result += template.slice(i);
      break;
    }
    result += template.slice(i, dollar);
    const close = template.indexOf('}', dollar + 2);
    if (close === -1) {
      result += template.slice(dollar);
      break;
    }
    const name = template.slice(dollar + 2, close);
    const value = envLookup(name);
    if (value === undefined || value === '') {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Environment variable "${name}" is not set or is empty (field: ${fieldPath})`,
      );
    }
    result += value;
    i = close + 1;
  }
  return result;
}

/**
 * Expand `${VAR}` placeholders in the whitelisted string fields of an MCP
 * server config before it enters the connection path. Returns a new object;
 * never mutates the input.
 *
 * Whitelisted fields:
 * - stdio: `command`, each `args[]` entry, each `env{}` value, `cwd`
 * - remote (http/sse): each `headers{}` value
 *
 * All other fields are passed through byte-identical. After expanding a
 * stdio `cwd`, the result must be an absolute path (POSIX, drive-letter, or
 * UNC); a relative result throws CONFIG_INVALID naming only the `cwd` field.
 */
export function expandServerConfig<T extends McpServerConfig>(
  config: T,
  envLookup: (name: string) => string | undefined,
): T {
  if (config.transport === 'http' || config.transport === 'sse') {
    return expandRemoteConfig(config, envLookup) as T;
  }
  return expandStdioConfig(config, envLookup) as T;
}

function expandStdioConfig(
  config: Extract<McpServerConfig, { transport: 'stdio' }>,
  envLookup: (name: string) => string | undefined,
): McpServerConfig {
  const next: Record<string, unknown> = {
    ...config,
    command: expandTemplateString(config.command, 'command', envLookup),
  };
  if (config.args !== undefined) {
    next['args'] = config.args.map((arg, index) =>
      expandTemplateString(arg, `args[${index}]`, envLookup),
    );
  }
  if (config.env !== undefined) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.env)) {
      env[key] = expandTemplateString(value, `env.${key}`, envLookup);
    }
    next['env'] = env;
  }
  if (config.cwd !== undefined) {
    const cwd = expandTemplateString(config.cwd, 'cwd', envLookup);
    if (!isAbsolute(cwd)) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        'MCP stdio server cwd must resolve to an absolute path (field: cwd)',
      );
    }
    next['cwd'] = cwd;
  }
  return next as McpServerConfig;
}

function expandRemoteConfig(
  config: Extract<McpServerConfig, { transport: 'http' | 'sse' }>,
  envLookup: (name: string) => string | undefined,
): McpServerConfig {
  if (config.headers === undefined) return { ...config };
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.headers)) {
    headers[key] = expandTemplateString(value, `headers.${key}`, envLookup);
  }
  return { ...config, headers };
}
