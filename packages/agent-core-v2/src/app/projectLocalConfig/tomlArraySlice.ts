import { parse } from 'smol-toml';

export type TomlArraySliceLayoutReason = 'inline_table' | 'dotted_key';

export type TomlArraySliceLocateDefectReason =
  | 'duplicate_key'
  | 'not_an_array'
  | 'unterminated'
  | 'unrecognized_statement';

export type TomlArraySliceVerifyReason = 'source_invalid' | 'output_invalid' | 'content_changed';

export type TomlArraySliceInternalReason =
  | TomlArraySliceLocateDefectReason
  | TomlArraySliceVerifyReason;

export type TomlArraySliceRejectReason =
  | TomlArraySliceLayoutReason
  | TomlArraySliceInternalReason;

export type TomlArraySliceResult =
  | { ok: true; text: string }
  | { ok: false; reason: TomlArraySliceRejectReason };

type Document = Record<string, unknown>;

const KEY = 'additional_dir';
const WORKSPACE = 'workspace';
const HEADER = `[${WORKSPACE}]`;

type HeaderEnd = { readonly at: number; readonly terminated: boolean };

type LocateResult =
  | { readonly kind: 'found'; readonly valueStart: number; readonly valueEnd: number }
  | { readonly kind: 'absent'; readonly headerEnd: HeaderEnd | null }
  | { readonly kind: 'reject'; readonly reason: TomlArraySliceRejectReason };

type Statement =
  | { readonly kind: 'blank' | 'array_table'; readonly next: number }
  | { readonly kind: 'table'; readonly next: number; readonly path: readonly string[] }
  | {
      readonly kind: 'key_value';
      readonly next: number;
      readonly scope: readonly string[] | null;
      readonly path: readonly string[];
      readonly valueStart: number;
      readonly valueClose: number | undefined;
    };

type ScanReject = {
  readonly kind: 'reject';
  readonly reason: 'unterminated' | 'unrecognized_statement';
};

type ValueScan = { readonly next: number; readonly close: number | null };

export function rewriteAdditionalDirArray(
  source: string,
  next: readonly string[],
): TomlArraySliceResult {
  const located = locate(source, computeSkeleton(source));
  if (located.kind === 'reject') return { ok: false, reason: located.reason };

  const serialized = serialize(next);
  const output =
    located.kind === 'found'
      ? source.slice(0, located.valueStart) + serialized + source.slice(located.valueEnd + 1)
      : generate(source, serialized, located.headerEnd);

  const keepEmptyWorkspace = located.kind === 'found' || located.headerEnd !== null;
  const reason = verifyRewrite(source, output, next, keepEmptyWorkspace);
  return reason === null ? { ok: true, text: output } : { ok: false, reason };
}

export function computeSkeleton(source: string): string {
  const out = source.split('');
  const length = source.length;
  let index = 0;

  while (index < length) {
    const ch = source.charAt(index);

    if (ch === '#') {
      while (index < length && source.charAt(index) !== '\n') {
        maskAt(out, source, index);
        index += 1;
      }
      continue;
    }

    if (ch !== '"' && ch !== "'") {
      index += 1;
      continue;
    }

    const triple = source.charAt(index + 1) === ch && source.charAt(index + 2) === ch;
    const escapes = ch === '"';
    index += triple ? 3 : 1;

    while (index < length) {
      const current = source.charAt(index);
      if (escapes && current === '\\') {
        maskAt(out, source, index);
        index += 1;
        if (index < length) {
          maskAt(out, source, index);
          index += 1;
        }
        continue;
      }
      if (current === ch) {
        if (!triple) {
          index += 1;
          break;
        }
        if (source.charAt(index + 1) === ch && source.charAt(index + 2) === ch) {
          index += 3;
          break;
        }
        maskAt(out, source, index);
        index += 1;
        continue;
      }
      if (!triple && current === '\n') break;
      maskAt(out, source, index);
      index += 1;
    }
  }

  return out.join('');
}

function maskAt(out: string[], source: string, index: number): void {
  const ch = source.charAt(index);
  if (ch === '\n' || ch === '\r') return;
  out[index] = ' ';
}

function locate(source: string, skeleton: string): LocateResult {
  let found: { valueStart: number; valueEnd: number } | null = null;
  let header: HeaderEnd | null = null;

  for (const statement of scan(source, skeleton)) {
    if (statement.kind === 'reject') return { kind: 'reject', reason: statement.reason };

    switch (statement.kind) {
      case 'blank':
      case 'array_table':
        continue;
      case 'table': {
        if (!isWorkspacePath(statement.path)) continue;
        const terminated = skeleton.charAt(statement.next - 1) === '\n';
        header ??= { at: terminated ? statement.next : skeleton.length, terminated };
        continue;
      }
      case 'key_value': {
        const { path, valueStart, scope } = statement;
        if (scope === null) continue;

        if (scope.length === 0 && path[0] === WORKSPACE) {
          if (path.length > 1) return { kind: 'reject', reason: 'dotted_key' };
          if (skeleton.charAt(valueStart) === '{') {
            return { kind: 'reject', reason: 'inline_table' };
          }
          continue;
        }

        if (scope.length === 1 && scope[0] === WORKSPACE && path.length === 1 && path[0] === KEY) {
          if (found !== null) return { kind: 'reject', reason: 'duplicate_key' };
          if (skeleton.charAt(valueStart) !== '[') {
            return { kind: 'reject', reason: 'not_an_array' };
          }
          found = { valueStart, valueEnd: statement.valueClose ?? statement.valueStart };
        }
      }
    }
  }

  if (found !== null) {
    return { kind: 'found', valueStart: found.valueStart, valueEnd: found.valueEnd };
  }
  return { kind: 'absent', headerEnd: header };
}

function isWorkspacePath(path: readonly string[]): boolean {
  return path.length === 1 && path[0] === WORKSPACE;
}

function scan(source: string, skeleton: string): readonly (Statement | ScanReject)[] {
  const length = skeleton.length;
  const statements: (Statement | ScanReject)[] = [];
  let scope: readonly string[] | null = [];
  let cursor = 0;

  while (cursor < length) {
    const newline = skeleton.indexOf('\n', cursor);
    const terminated = newline !== -1;
    const lineEnd = terminated ? newline : length;
    const line = skeleton.slice(cursor, lineEnd);
    const lead = line.length - line.trimStart().length;
    const trimmed = line.trim();
    const next = terminated ? lineEnd + 1 : length;

    if (trimmed === '') {
      statements.push({ kind: 'blank', next });
      cursor = next;
      continue;
    }

    if (trimmed.startsWith('[[')) {
      if (!trimmed.includes(']]')) {
        statements.push({ kind: 'reject', reason: 'unrecognized_statement' });
        break;
      }
      statements.push({ kind: 'array_table', next });
      scope = null;
      cursor = next;
      continue;
    }

    if (trimmed.startsWith('[')) {
      const path = fragmentPath(
        source.slice(cursor + lead + 1, cursor + lead + trimmed.length - 1),
        'table',
      );
      if (path === null) {
        statements.push({ kind: 'reject', reason: 'unrecognized_statement' });
        break;
      }
      statements.push({ kind: 'table', next, path });
      scope = path;
      cursor = next;
      continue;
    }

    const equals = trimmed.indexOf('=');
    const path =
      equals === -1
        ? null
        : fragmentPath(source.slice(cursor + lead, cursor + lead + equals), 'key');
    if (path === null) {
      statements.push({ kind: 'reject', reason: 'unrecognized_statement' });
      break;
    }

    const valueStart = skipBlanks(skeleton, cursor + lead + equals + 1);
    const value = scanValue(skeleton, valueStart);
    if (value === null) {
      statements.push({ kind: 'reject', reason: 'unterminated' });
      break;
    }
    statements.push({
      kind: 'key_value',
      next: value.next,
      scope,
      path,
      valueStart,
      valueClose: value.close ?? undefined,
    });
    cursor = value.next;
  }

  return statements;
}

function scanValue(skeleton: string, start: number): ValueScan | null {
  const ch = skeleton.charAt(start);

  if (ch === '"' || ch === "'") {
    if (skeleton.charAt(start + 1) !== ch || skeleton.charAt(start + 2) !== ch) {
      return { next: nextLine(skeleton, start), close: null };
    }
    const close = closingTriple(skeleton, start + 3, ch);
    return close === -1 ? null : { next: nextLine(skeleton, close), close };
  }

  if (ch === '[' || ch === '{') {
    const close = closingBracket(skeleton, start);
    return close === -1 ? null : { next: nextLine(skeleton, close), close };
  }

  return { next: nextLine(skeleton, start), close: null };
}

function nextLine(skeleton: string, from: number): number {
  const newline = skeleton.indexOf('\n', from);
  return newline === -1 ? skeleton.length : newline + 1;
}

function closingTriple(skeleton: string, from: number, ch: string): number {
  for (let index = from; index < skeleton.length; index += 1) {
    if (skeleton.charAt(index) !== ch) continue;
    if (skeleton.charAt(index + 1) === ch && skeleton.charAt(index + 2) === ch) return index + 2;
  }
  return -1;
}

function closingBracket(skeleton: string, start: number): number {
  let depth = 0;
  for (let index = start; index < skeleton.length; index += 1) {
    const ch = skeleton.charAt(index);
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function fragmentPath(raw: string, kind: 'table' | 'key'): string[] | null {
  let root: unknown;
  try {
    root = parse(kind === 'table' ? `[${raw}]` : `${raw} = 0`);
  } catch {
    return null;
  }

  const path: string[] = [];
  let level = root;
  while (isPlainObject(level)) {
    const keys = Object.keys(level);
    if (keys.length > 1) return null;
    const key = keys[0];
    if (key === undefined) break;
    path.push(key);
    level = level[key];
  }
  return path.length === 0 ? null : path;
}

function isBlank(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r';
}

function skipBlanks(skeleton: string, from: number): number {
  let index = from;
  while (index < skeleton.length && isBlank(skeleton.charAt(index))) index += 1;
  return index;
}

function generate(
  source: string,
  serialized: string,
  headerEnd: HeaderEnd | null,
): string {
  const newline = newlineOf(source);
  const keyLine = `${KEY} = ${serialized}`;
  if (source.trim() === '') return `${HEADER}${newline}${keyLine}${newline}`;
  if (headerEnd !== null) {
    const head = source.slice(0, headerEnd.at);
    if (!headerEnd.terminated) return `${head}${newline}${keyLine}${newline}`;
    return `${head}${keyLine}${newline}${source.slice(headerEnd.at)}`;
  }
  const head = source.endsWith('\n') ? source : `${source}${newline}`;
  return `${head}${HEADER}${newline}${keyLine}${newline}`;
}

function newlineOf(source: string): string {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

function serialize(next: readonly string[]): string {
  if (next.length === 0) return '[]';
  return `[ ${next.map(quoteBasic).join(', ')} ]`;
}

function quoteBasic(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\r') out += '\\r';
    else if (code < 0x20 || code === 0x7f) {
      out += `\\u${code.toString(16).padStart(4, '0').toUpperCase()}`;
    } else out += ch;
  }
  return `${out}"`;
}

export function verifyRewrite(
  source: string,
  output: string,
  next: readonly string[],
  keepEmptyWorkspace: boolean,
): TomlArraySliceVerifyReason | null {
  let before: Document;
  try {
    before = parse(source) as Document;
  } catch {
    return 'source_invalid';
  }

  let after: Document;
  try {
    after = parse(output) as Document;
  } catch {
    return 'output_invalid';
  }

  if (!equal(project(after, keepEmptyWorkspace), project(before, keepEmptyWorkspace))) {
    return 'content_changed';
  }

  const workspace = after['workspace'];
  const written = isPlainObject(workspace) ? workspace[KEY] : undefined;
  return equal(written, next) ? null : 'content_changed';
}

function project(document: Document, keepEmptyWorkspace: boolean): unknown {
  const copy = deepCopy(document);
  if (!isPlainObject(copy)) return copy;
  const workspace = copy['workspace'];
  if (!isPlainObject(workspace)) return copy;
  delete workspace[KEY];
  if (!keepEmptyWorkspace && Object.keys(workspace).length === 0) delete copy['workspace'];
  return copy;
}

function deepCopy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepCopy);
  if (isPlainObject(value)) {
    const out: Document = {};
    for (const key of Object.keys(value)) out[key] = deepCopy(value[key]);
    return out;
  }
  return value;
}

function equal(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return left.length === right.length && left.every((item, index) => equal(item, right[index]));
  }
  if (left instanceof Date || right instanceof Date) {
    return (
      left instanceof Date && right instanceof Date && Object.is(left.getTime(), right.getTime())
    );
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    if (leftKeys.length !== Object.keys(right).length) return false;
    return leftKeys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]));
  }
  return Object.is(left, right);
}

function isPlainObject(value: unknown): value is Document {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}
