import { dirname, join, normalize } from 'pathe';
import { parse as parseToml } from 'smol-toml';
import { ErrorCodes, StorageErrors, unwrapErrorCause, type ErrorCode } from '#/errors';
import {
  classifyAdditionalDirEntry,
  sameAdditionalDir,
  toAdditionalDirError,
} from './additionalDirEntry';

export interface ProjectLocalConfigFs {
  readText(path: string): Promise<string>;
  stat(path: string): Promise<{ readonly isDirectory: boolean }>;
  lstat(path: string): Promise<unknown>;
}

export type ProjectLocalConfigDiagnostic =
  | {
      scope: 'file';
      category: 'read_failed' | 'toml_invalid' | 'schema_invalid';
      code: ErrorCode;
      message: string;
    }
  | {
      scope: 'entry';
      index: number;
      entry: string;
      category: 'empty' | 'missing' | 'not_directory' | 'probe_failed';
      dir?: string;
      code: ErrorCode;
      message: string;
    };

export interface ProjectLocalConfigLoad {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly additionalDirs: readonly string[];
  readonly diagnostics: readonly ProjectLocalConfigDiagnostic[];
  readonly source: 'absent' | 'present';
}

export type ProjectLocalConfigSource =
  | { kind: 'absent' }
  | { kind: 'ok'; text: string; entries: readonly string[] }
  | { kind: 'error'; diagnostic: ProjectLocalConfigDiagnostic };

type DocumentValidation =
  | { kind: 'ok'; entries: readonly string[] }
  | { kind: 'error'; diagnostic: ProjectLocalConfigDiagnostic };

export async function findProjectRoot(
  workDir: string,
  fs: ProjectLocalConfigFs,
): Promise<string> {
  const initial = normalize(workDir);
  let current = initial;

  while (true) {
    if (await pathExists(join(current, '.git'), fs)) return current;
    const parent = dirname(current);
    if (parent === current) return initial;
    current = parent;
  }
}

export function projectLocalConfigPath(projectRoot: string): string {
  return join(projectRoot, '.kimi-code', 'local.toml');
}

export async function readProjectLocalConfigSource(
  configPath: string,
  fs: ProjectLocalConfigFs,
): Promise<ProjectLocalConfigSource> {
  let text: string;
  try {
    text = await fs.readText(configPath);
  } catch (error: unknown) {
    if (isPathMissing(error)) return { kind: 'absent' };
    return {
      kind: 'error',
      diagnostic: fileDiagnostic(
        'read_failed',
        ErrorCodes.STORAGE_IO_FAILED,
        describeError(error),
      ),
    };
  }

  if (text.trim().length === 0) return { kind: 'ok', text, entries: [] };

  let document: unknown;
  try {
    document = parseToml(text);
  } catch {
    return {
      kind: 'error',
      diagnostic: fileDiagnostic(
        'toml_invalid',
        StorageErrors.codes.STORAGE_DECODE_FAILED,
        `Invalid TOML in ${configPath}`,
      ),
    };
  }

  const validation = validateDocument(document, configPath);
  if (validation.kind === 'error') return validation;
  return { kind: 'ok', text, entries: validation.entries };
}

export async function readProjectLocalConfig(
  workDir: string,
  deps: { fs: ProjectLocalConfigFs; homeDir: string },
): Promise<ProjectLocalConfigLoad> {
  const projectRoot = await findProjectRoot(workDir, deps.fs);
  const configPath = projectLocalConfigPath(projectRoot);
  const source = await readProjectLocalConfigSource(configPath, deps.fs);

  if (source.kind === 'absent') {
    return { projectRoot, configPath, additionalDirs: [], diagnostics: [], source: 'absent' };
  }
  if (source.kind === 'error') {
    return {
      projectRoot,
      configPath,
      additionalDirs: [],
      diagnostics: [source.diagnostic],
      source: 'present',
    };
  }

  const additionalDirs: string[] = [];
  const diagnostics: ProjectLocalConfigDiagnostic[] = [];

  for (const [index, entry] of source.entries.entries()) {
    const cls = await classifyAdditionalDirEntry(entry, projectRoot, deps.homeDir, deps.fs);

    if (cls.kind === 'accepted') {
      if (!additionalDirs.some((dir) => sameAdditionalDir(dir, cls.dir))) {
        additionalDirs.push(cls.dir);
      }
      continue;
    }

    const error = toAdditionalDirError(cls, entry);
    diagnostics.push({
      scope: 'entry',
      index,
      entry,
      category: cls.reason,
      dir: cls.kind === 'unavailable' ? cls.dir : undefined,
      code: error.code,
      message: error.message,
    });
  }

  return { projectRoot, configPath, additionalDirs, diagnostics, source: 'present' };
}

function validateDocument(document: unknown, configPath: string): DocumentValidation {
  if (!isPlainObject(document)) {
    return schemaError(`Invalid project local config in ${configPath}`);
  }
  if (!('workspace' in document)) return { kind: 'ok', entries: [] };

  const workspace = document['workspace'];
  if (!isPlainObject(workspace)) return schemaError('workspace must be a table');
  if (!('additional_dir' in workspace)) return { kind: 'ok', entries: [] };

  const entries = workspace['additional_dir'];
  if (!isStringArray(entries)) {
    return schemaError('workspace.additional_dir must be an array of strings');
  }

  return { kind: 'ok', entries };
}

function schemaError(message: string): DocumentValidation {
  return {
    kind: 'error',
    diagnostic: fileDiagnostic('schema_invalid', ErrorCodes.CONFIG_INVALID, message),
  };
}

function fileDiagnostic(
  category: 'read_failed' | 'toml_invalid' | 'schema_invalid',
  code: ErrorCode,
  message: string,
): ProjectLocalConfigDiagnostic {
  return { scope: 'file', category, code, message };
}

async function pathExists(
  path: string,
  fs: { lstat(path: string): Promise<unknown> },
): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

function isPathMissing(error: unknown): boolean {
  const unwrapped = unwrapErrorCause(error);
  const code = isPlainObject(unwrapped) ? unwrapped['code'] : undefined;
  return code === 'ENOENT';
}

function describeError(error: unknown): string {
  const unwrapped = unwrapErrorCause(error);
  const message = isPlainObject(unwrapped) ? unwrapped['message'] : undefined;
  return typeof message === 'string' ? message : String(unwrapped);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((element) => typeof element === 'string');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
