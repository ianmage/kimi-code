import { isAbsolute } from 'pathe';

import type { McpServerConfig } from './config-schema';
import { ErrorCodes, Error2 } from '#/errors';

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
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `Environment variable "${name}" is not set or is empty (field: ${fieldPath})`,
      );
    }
    result += value;
    i = close + 1;
  }
  return result;
}

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
      throw new Error2(
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
