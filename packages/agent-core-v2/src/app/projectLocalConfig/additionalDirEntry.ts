import { isAbsolute, join, normalize, resolve } from 'pathe';
import { Error2, ErrorCodes, unwrapErrorCause } from '#/errors';

export type AdditionalDirEntryClass =
  | { kind: 'accepted'; dir: string }
  | { kind: 'invalid'; reason: 'empty' }
  | {
      kind: 'unavailable';
      reason: 'missing' | 'not_directory' | 'probe_failed';
      dir: string;
      cause?: unknown;
    };

const UNAVAILABLE_SPECS = {
  missing: { code: ErrorCodes.ADDITIONAL_DIR_UNAVAILABLE, text: 'does not exist' },
  not_directory: { code: ErrorCodes.ADDITIONAL_DIR_UNAVAILABLE, text: 'is not a directory' },
  probe_failed: { code: ErrorCodes.STORAGE_IO_FAILED, text: 'could not be inspected' },
} as const;

export async function classifyAdditionalDirEntry(
  raw: string,
  baseDir: string,
  homeDir: string,
  fs: { stat(path: string): Promise<{ readonly isDirectory: boolean }> },
): Promise<AdditionalDirEntryClass> {
  const trimmed = raw.trim();
  if (trimmed === '') return { kind: 'invalid', reason: 'empty' };

  const unified = trimmed.replaceAll('\\', '/');
  const expanded = expandHome(unified, homeDir);
  const dir = isAbsolute(expanded) ? normalize(expanded) : resolve(baseDir, expanded);

  let stat: { readonly isDirectory: boolean };
  try {
    stat = await fs.stat(dir);
  } catch (error: unknown) {
    return { kind: 'unavailable', reason: probeFailureReason(error), dir, cause: error };
  }

  if (!stat.isDirectory) return { kind: 'unavailable', reason: 'not_directory', dir };
  return { kind: 'accepted', dir };
}

export function toAdditionalDirError(
  cls: Exclude<AdditionalDirEntryClass, { kind: 'accepted' }>,
  raw: string,
): Error2 {
  if (cls.kind === 'invalid') {
    return new Error2(ErrorCodes.CONFIG_INVALID, 'workspace.additional_dir contains an empty entry', {
      details: { path: raw, reason: cls.reason },
    });
  }

  const spec = UNAVAILABLE_SPECS[cls.reason];
  return new Error2(spec.code, `workspace.additional_dir entry ${spec.text}: ${cls.dir}`, {
    details: { path: cls.dir, reason: cls.reason },
    cause: cls.cause,
  });
}

export function sameAdditionalDir(a: string, b: string): boolean {
  const normalizedA = normalize(a);
  const normalizedB = normalize(b);
  const left = normalizedA.length > 1 ? normalizedA.replace(/\/+$/, '') : normalizedA;
  const right = normalizedB.length > 1 ? normalizedB.replace(/\/+$/, '') : normalizedB;
  if (process.platform !== 'win32') return left === right;
  return left.toLowerCase() === right.toLowerCase();
}

function expandHome(value: string, homeDir: string): string {
  if (value === '~') return homeDir;
  if (value.startsWith('~/')) return join(homeDir, value.slice(2));
  return value;
}

function probeFailureReason(cause: unknown): 'missing' | 'probe_failed' {
  const unwrapped = unwrapErrorCause(cause);
  const code = isObject(unwrapped) ? unwrapped['code'] : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'probe_failed';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
