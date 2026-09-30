import { join, normalize } from 'pathe';
import ignore, { type Ignore } from 'ignore';

import { unwrapErrorCause } from '#/_base/errors/errors';
import type { ILogger } from '#/_base/log/log';
import type { PathClass } from '#/_base/execEnv/environmentProbe';

export interface ProjectIgnoreFs {
  readText(path: string): Promise<string>;
}

export interface ProjectIgnoreOptions {
  readonly roots: readonly string[];
  readonly pathClass: PathClass;
  readonly fs: ProjectIgnoreFs;
  readonly log: Pick<ILogger, 'warn'>;
}

export interface ProjectIgnore {
  hidden(absPath: string, isDirectory?: boolean): boolean;
  canPrune(absDir: string): boolean;
}

const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR']);

function canonicalKey(p: string, pathClass: PathClass): string {
  let key = normalize(p).replaceAll('\\', '/');
  while (key.length > 1 && key.endsWith('/')) key = key.slice(0, -1);
  if (key.length === 0) key = '/';
  return pathClass === 'win32' ? key.toLowerCase() : key;
}

function readErrorCode(error: unknown): unknown {
  const unwrapped = unwrapErrorCause(error);
  if (unwrapped === null || typeof unwrapped !== 'object' || !('code' in unwrapped)) return undefined;
  return (unwrapped as { code: unknown }).code;
}

function isMissingError(error: unknown): boolean {
  return MISSING_CODES.has(readErrorCode(error) as string);
}

function loadRootRules(
  root: string,
  options: ProjectIgnoreOptions,
): Promise<Ignore> {
  const rules = ignore();
  const path = join(root, '.kimi-code', 'ignore');
  return options.fs
    .readText(path)
    .then((content) => {
      rules.add(content);
      return rules;
    })
    .catch((error: unknown) => {
      if (!isMissingError(error)) {
        options.log.warn('project ignore rule file unreadable', { path, error });
      }
      return rules;
    });
}

export async function loadProjectIgnore(options: ProjectIgnoreOptions): Promise<ProjectIgnore> {
  const rootKeys = new Map<string, string>();
  for (const root of options.roots) {
    const key = canonicalKey(root, options.pathClass);
    if (!rootKeys.has(key)) rootKeys.set(key, root);
  }
  const rulesByRootKey = new Map<string, Ignore>();
  await Promise.all(
    [...rootKeys.entries()].map(async ([key, root]) => {
      rulesByRootKey.set(key, await loadRootRules(root, options));
    }),
  );
  const rootKeysList = [...rootKeys.keys()];

  const ownerOf = (key: string): string | undefined => {
    let owner: string | undefined;
    for (const rootKey of rootKeysList) {
      if (key === rootKey || (key.startsWith(`${rootKey}/`) && (owner === undefined || rootKey.length > owner.length))) {
        owner = rootKey;
      }
    }
    return owner;
  };

  const hidden = (absPath: string, isDirectory?: boolean): boolean => {
    try {
      const key = canonicalKey(absPath, options.pathClass);
      const owner = ownerOf(key);
      if (owner === undefined || key === owner) return false;
      const rel = key.slice(owner.length + 1);
      if (!ignore.isPathValid(rel)) return false;
      const rules = rulesByRootKey.get(owner)!;
      if (rules.ignores(rel)) return true;
      return isDirectory === true && rules.ignores(`${rel}/`);
    } catch {
      return false;
    }
  };

  const canPrune = (absDir: string): boolean => {
    try {
      const key = canonicalKey(absDir, options.pathClass);
      if (rootKeysList.some((rootKey) => rootKey !== key && rootKey.startsWith(`${key}/`))) return false;
      return hidden(absDir, true);
    } catch {
      return false;
    }
  };

  return { hidden, canPrune };
}
