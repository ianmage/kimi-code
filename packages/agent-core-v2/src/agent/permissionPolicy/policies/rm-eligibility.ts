import { getShellPathBridge } from '#/_base/execEnv/shellPathBridge';
import { isWithinDirectory, isSensitiveFile, type PathClass } from '#/tool/path-access';
import { HostFsError } from '#/os/interface/hostFsErrors';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { ILogger } from '#/_base/log/log';
import type { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';

export const ARTIFACT_SEGMENTS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  '.tmp',
  '.cache',
  'coverage',
  '.nyc_output',
  '.turbo',
  '.vite',
  '.vite-temp',
  '.parcel-cache',
  'target',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  'bower_components',
]);

export const TEMP_SEGMENTS: ReadonlySet<string> = new Set(['tmp', 'temp', '.tmp']);

const UPSTREAM_FS_ERROR_CODES: ReadonlySet<string> = new Set([
  'os.fs.not_found',
  'os.fs.not_directory',
]);

export type CommandVerdict =
  | { readonly kind: 'dangerous'; readonly command: string }
  | { readonly kind: 'unanalyzable' }
  | { readonly kind: 'rm'; readonly candidate: RmCandidate };

export interface RmCandidate {
  readonly operands: readonly string[];
  readonly dropped: boolean;
  readonly cdChain?: readonly string[];
}

export interface RmEligibilityEnv {
  readonly view: RuntimeWorkspaceView;
  readonly fs: IHostFileSystem | undefined;
  readonly initialBase: string | undefined;
  readonly cdpathSet: boolean;
  readonly log?: ILogger;
}

export async function isRmEligible(
  candidate: RmCandidate,
  env: RmEligibilityEnv,
): Promise<boolean> {
  try {
    if (candidate.dropped || candidate.operands.length === 0) return false;
    const fs = env.fs;
    if (fs === undefined) return false;
    const pathClass = env.view.runtime.environment.pathClass as PathClass;
    const base = await resolveBase(env, fs, candidate.cdChain);
    const workDirReal = await resolveRealPath(env.view.workDir, fs, pathClass);
    if (workDirReal === undefined) return false;
    const rootReals: (string | undefined)[] = [workDirReal];
    for (const root of env.view.additionalDirs) {
      rootReals.push(await resolveRealPath(root, fs, pathClass));
    }
    for (const operand of candidate.operands) {
      const eligible = await operandEligible(
        operand,
        env,
        fs,
        pathClass,
        base,
        workDirReal,
        rootReals,
        candidate.cdChain,
      );
      if (!eligible) return false;
    }
    return true;
  } catch (error) {
    env.log?.warn('rm-eligibility: isRmEligible failed', { error });
    return false;
  }
}

async function operandEligible(
  operand: string,
  env: RmEligibilityEnv,
  fs: IHostFileSystem,
  pathClass: PathClass,
  base: string | undefined,
  workDirReal: string,
  rootReals: readonly (string | undefined)[],
  cdChain: readonly string[] | undefined,
): Promise<boolean> {
  if (operand.length === 0) return false;
  if (hasDotDotSegment(operand)) return false;
  let bridged = operand;
  if (pathClass === 'win32') {
    bridged = getShellPathBridge(env.view.runtime.environment).fromShellPath(operand);
    if (bridged.startsWith('/') && !bridged.startsWith('//')) return false;
  }
  const isAbsoluteOperand = env.view.runtime.path.isAbsolute(bridged);
  let target: string;
  if (isAbsoluteOperand) {
    target = env.view.resolve(operand);
  } else {
    if (base === undefined) return false;
    target = env.view.resolve(operand, base);
  }
  const realTarget = await resolveRealPath(target, fs, pathClass);
  if (realTarget === undefined) return false;
  for (const rootReal of rootReals) {
    if (rootReal === undefined) return false;
    if (isWithinDirectory(rootReal, realTarget, pathClass)) return false;
  }
  if (hasGitSegment(realTarget, pathClass)) return false;
  if (isSensitiveFile(realTarget)) return false;
  if (tempClassEligible(realTarget, pathClass, isAbsoluteOperand, cdChain)) return true;
  return artifactClassEligible(realTarget, workDirReal, pathClass, cdChain);
}

function hasDotDotSegment(operand: string): boolean {
  for (const segment of operand.split(/[\\/]/)) {
    if (segment === '..') return true;
  }
  return false;
}

function hasGitSegment(path: string, pathClass: PathClass): boolean {
  const segments = pathClass === 'win32' ? path.split(/[\\/]/) : path.split('/');
  return segments.some((segment) => segment.toLowerCase() === '.git');
}

function tempClassEligible(
  realTarget: string,
  pathClass: PathClass,
  isAbsoluteOperand: boolean,
  cdChain: readonly string[] | undefined,
): boolean {
  if (!isAbsoluteOperand && cdChain === undefined) return false;
  const segments = pathClass === 'win32' ? realTarget.split(/[\\/]/) : realTarget.split('/');
  const nonLeaf = segments.slice(0, -1);
  return nonLeaf.some((segment) => TEMP_SEGMENTS.has(segment.toLowerCase()));
}

function artifactClassEligible(
  realTarget: string,
  workDirReal: string,
  pathClass: PathClass,
  cdChain: readonly string[] | undefined,
): boolean {
  if (cdChain === undefined) return false;
  if (realTarget === workDirReal) return false;
  if (!isWithinDirectory(realTarget, workDirReal, pathClass)) return false;
  const relative = relativeSegments(realTarget, workDirReal, pathClass);
  return relative.some((segment) => ARTIFACT_SEGMENTS.has(segment.toLowerCase()));
}

function relativeSegments(target: string, base: string, pathClass: PathClass): readonly string[] {
  if (pathClass === 'win32') {
    const normalizedTarget = target.replaceAll('\\', '/').toLowerCase();
    const normalizedBase = base.replaceAll('\\', '/').toLowerCase();
    const prefix = normalizedBase.endsWith('/') ? normalizedBase : `${normalizedBase}/`;
    return normalizedTarget.startsWith(prefix)
      ? normalizedTarget.slice(prefix.length).split('/')
      : [];
  }
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return target.startsWith(prefix) ? target.slice(prefix.length).split('/') : [];
}

async function resolveBase(
  env: RmEligibilityEnv,
  fs: IHostFileSystem,
  cdChain: readonly string[] | undefined,
): Promise<string | undefined> {
  if (env.initialBase === undefined) return undefined;
  if (cdChain === undefined) return undefined;
  let current = env.initialBase;
  for (const target of cdChain) {
    const isAbsolute = env.view.runtime.path.isAbsolute(target);
    if (!isAbsolute && env.cdpathSet) return undefined;
    const next = env.view.resolve(target, current);
    const stat = await fs.stat(next);
    if (!stat.isDirectory) return undefined;
    current = next;
  }
  return current;
}

async function resolveRealPath(
  absolutePath: string,
  fs: IHostFileSystem,
  pathClass: PathClass,
): Promise<string | undefined> {
  let current = pathClass === 'win32' ? absolutePath.replaceAll('\\', '/') : absolutePath;
  const tail: string[] = [];
  for (;;) {
    let real: string;
    try {
      real = await fs.realpath(current);
    } catch (error) {
      if (!isUpstreamFsError(error)) return undefined;
      const parent = dirnameOf(current, pathClass);
      if (parent === current) return undefined;
      tail.unshift(basenameOf(current, pathClass));
      current = parent;
      continue;
    }
    const normalizedReal = pathClass === 'win32' ? real.replaceAll('\\', '/') : real;
    return tail.length === 0 ? normalizedReal : `${normalizedReal}/${tail.join('/')}`;
  }
}

function isUpstreamFsError(error: unknown): boolean {
  return error instanceof HostFsError && UPSTREAM_FS_ERROR_CODES.has(error.code);
}

function dirnameOf(path: string, pathClass: PathClass): string {
  if (pathClass === 'win32') path = path.replaceAll('\\', '/');
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const index = trimmed.lastIndexOf('/');
  if (index < 0) return path;
  if (index === 0) return '/';
  if (pathClass === 'win32' && /^[A-Za-z]:$/.test(trimmed.slice(0, index))) {
    return `${trimmed.slice(0, index)}/`;
  }
  return trimmed.slice(0, index);
}

function basenameOf(path: string, pathClass: PathClass): string {
  if (pathClass === 'win32') path = path.replaceAll('\\', '/');
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const index = trimmed.lastIndexOf('/');
  return index < 0 ? trimmed : trimmed.slice(index + 1);
}
