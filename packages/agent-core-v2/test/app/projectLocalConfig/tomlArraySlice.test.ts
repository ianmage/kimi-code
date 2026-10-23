import { parse } from 'smol-toml';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  computeSkeleton,
  rewriteAdditionalDirArray,
  verifyRewrite,
  type TomlArraySliceInternalReason,
  type TomlArraySliceLayoutReason,
  type TomlArraySliceRejectReason,
  type TomlArraySliceResult,
} from '#/app/projectLocalConfig/tomlArraySlice';

type Doc = Record<string, unknown>;

function isPlainObject(value: unknown): value is Doc {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    const out: Doc = {};
    for (const key of Object.keys(value)) out[key] = clone(value[key]);
    return out;
  }
  return value;
}

function equal(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => equal(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left).toSorted();
    const rightKeys = Object.keys(right).toSorted();
    return equal(leftKeys, rightKeys) && leftKeys.every((key) => equal(left[key], right[key]));
  }
  return left === right;
}

function project(document: Doc, keepEmptyWorkspace: boolean): unknown {
  const copy = clone(document);
  if (!isPlainObject(copy)) return copy;
  const workspace = copy['workspace'];
  if (!isPlainObject(workspace)) return copy;
  delete workspace['additional_dir'];
  if (!keepEmptyWorkspace && Object.keys(workspace).length === 0) delete copy['workspace'];
  return copy;
}

function verify(source: string, output: string, next: readonly string[]): void {
  const keepEmptyWorkspace =
    /^[ \t]*\[[ \t]*(?:"workspace"|'workspace'|workspace)[ \t]*\][ \t]*\r?$/m.test(source);
  const before = parse(source) as Doc;
  const after = parse(output) as Doc;
  expect(project(after, keepEmptyWorkspace), 'projection outside workspace').toEqual(
    project(before, keepEmptyWorkspace),
  );
  const workspace = after['workspace'];
  expect(isPlainObject(workspace) ? workspace['additional_dir'] : undefined).toEqual(next);
}

function run(source: string, next: readonly string[]): TomlArraySliceResult {
  const result = rewriteAdditionalDirArray(source, next);
  if (result.ok) verify(source, result.text, next);
  return result;
}

function writtenValue(text: string): unknown {
  const workspace = (parse(text) as Doc)['workspace'];
  return isPlainObject(workspace) ? workspace['additional_dir'] : undefined;
}

const A1_SOURCE = [
  '# project local config',
  '',
  '[workspace]',
  'additional_dir = ["/old", "/older"] # keep me',
  '',
  '[other]',
  'name = "x"',
  '',
].join('\n');

const A1_VALUE_START = A1_SOURCE.indexOf('= [') + 2;
const A1_VALUE_END = A1_SOURCE.indexOf(']', A1_VALUE_START);

describe('rewriteAdditionalDirArray preserving layout', () => {
  it('rewrites only the array bytes of a commented file', () => {
    const result = run(A1_SOURCE, ['/new']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.text.slice(0, A1_VALUE_START)).toBe(A1_SOURCE.slice(0, A1_VALUE_START));
    const suffixLength = A1_SOURCE.length - A1_VALUE_END - 1;
    expect(result.text.slice(result.text.length - suffixLength)).toBe(
      A1_SOURCE.slice(A1_VALUE_END + 1),
    );
    expect(result.text).toBe(
      `${A1_SOURCE.slice(0, A1_VALUE_START)}[ "/new" ]${A1_SOURCE.slice(A1_VALUE_END + 1)}`,
    );
    expect(result.text).toContain('# project local config');
    expect(result.text).toContain('# keep me');
  });

  it('keeps trailing whitespace after the value untouched', () => {
    const source = '[workspace]\nadditional_dir = ["/a"]   \n[other]\n';
    const result = run(source, ['/b']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('[workspace]\nadditional_dir = [ "/b" ]   \n[other]\n');
  });

  it('recognises a header with inner spaces', () => {
    const source = '[ workspace ]\nadditional_dir = ["/a"]\n';
    const result = run(source, ['/b']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('[ workspace ]\nadditional_dir = [ "/b" ]\n');
  });

  it('recognises a quoted header', () => {
    const source = '[ "workspace" ]\n';
    const result = run(source, ['/x']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('[ "workspace" ]\nadditional_dir = [ "/x" ]\n');
  });

  it('recognises a header with a trailing comment', () => {
    const source = '[workspace] # mine\nadditional_dir = ["/a"]\n';
    const result = run(source, ['/b']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('[workspace] # mine\nadditional_dir = [ "/b" ]\n');
  });

  it('rejects an array-of-tables workspace', () => {
    expect(rewriteAdditionalDirArray('[[workspace]]\nname = "x"\n', ['/a'])).toEqual({
      ok: false,
      reason: 'output_invalid',
    });
  });

  it('leaves an additional_dir of another table alone', () => {
    const source = '[other]\nadditional_dir = ["/a"]\n[workspace]\nadditional_dir = ["/b"]\n';
    const result = run(source, ['/c']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(
      '[other]\nadditional_dir = ["/a"]\n[workspace]\nadditional_dir = [ "/c" ]\n',
    );
  });
});

describe('rewriteAdditionalDirArray rejections', () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly source: string;
    readonly reason: TomlArraySliceRejectReason;
  }> = [
    {
      name: 'inline table',
      source: 'workspace = { additional_dir = ["/a"] }\n',
      reason: 'inline_table',
    },
    {
      name: 'dotted key',
      source: 'workspace.additional_dir = ["/a"]\n',
      reason: 'dotted_key',
    },
    {
      name: 'duplicate key',
      source: '[workspace]\nadditional_dir = ["/a"]\nadditional_dir = ["/b"]\n',
      reason: 'duplicate_key',
    },
    {
      name: 'unterminated array',
      source: '[workspace]\nadditional_dir = ["/a"\n',
      reason: 'unterminated',
    },
    {
      name: 'unterminated string in array',
      source: '[workspace]\nadditional_dir = ["/a\n',
      reason: 'unterminated',
    },
    {
      name: 'value is not an array',
      source: '[workspace]\nadditional_dir = "/a"\n',
      reason: 'not_an_array',
    },
    {
      name: 'key without a value',
      source: '[workspace]\nadditional_dir =\n',
      reason: 'not_an_array',
    },
  ];

  for (const { name, source, reason } of cases) {
    it(`rejects ${name}`, () => {
      expect(rewriteAdditionalDirArray(source, ['/x'])).toEqual({ ok: false, reason });
    });
  }

  it('reports the first rejection in document order', () => {
    const source = 'workspace.additional_dir = ["/a"]\n[workspace]\nadditional_dir = ["/b"]\n';
    expect(rewriteAdditionalDirArray(source, ['/x'])).toEqual({ ok: false, reason: 'dotted_key' });
  });
});

describe('rewriteAdditionalDirArray on hard layouts', () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly source: string;
    readonly next: readonly string[];
    readonly expected: readonly string[];
  }> = [
    {
      name: 'brackets and hashes inside string bodies',
      source: '[workspace]\nadditional_dir = ["/a]b", "/c#d"]\n',
      next: ['/x'],
      expected: ['/x'],
    },
    {
      name: 'array spanning lines with comments inside',
      source: '[workspace]\nadditional_dir = [\n  "/a", # one ]\n  "/b",\n]\n',
      next: ['/x', '/y'],
      expected: ['/x', '/y'],
    },
    {
      name: 'multi-line basic strings',
      source: '[workspace]\nadditional_dir = [\n  """\n  /a]b\n  """,\n  "/c",\n]\n',
      next: ['/z'],
      expected: ['/z'],
    },
    {
      name: 'multi-line literal strings',
      source: "[workspace]\nadditional_dir = [\n  '''/a#b''',\n  '/c',\n]\n",
      next: ['/z'],
      expected: ['/z'],
    },
    {
      name: 'comment holding a header lookalike and a bracket',
      source: '[workspace]\n# [not_a_header] ]\nadditional_dir = ["/a"]\n',
      next: ['/x'],
      expected: ['/x'],
    },
    {
      name: 'escaped quote inside a basic string',
      source: '[workspace]\nadditional_dir = ["/a\\"]b"]\n',
      next: ['/x'],
      expected: ['/x'],
    },
  ];

  for (const { name, source, next, expected } of cases) {
    it(`handles ${name}`, () => {
      const result = run(source, next);
      if (!result.ok) {
        expect(result.ok, `rejected with ${result.reason}`).toBe(true);
        return;
      }
      expect(writtenValue(result.text)).toEqual(expected);
    });
  }
});

describe('rewriteAdditionalDirArray generating the key', () => {
  it('inserts the key on the line after an existing header', () => {
    const source = '[workspace]\nname = "x"\n';
    const result = run(source, ['/a']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('[workspace]\nadditional_dir = [ "/a" ]\nname = "x"\n');
    expect(writtenValue(result.text)).toEqual(['/a']);
  });

  it('appends a header and the key when no header exists', () => {
    const source = '[other]\nname = "x"\n';
    const result = run(source, ['/a']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('[other]\nname = "x"\n[workspace]\nadditional_dir = [ "/a" ]\n');
    expect(writtenValue(result.text)).toEqual(['/a']);
  });

  it('separates appended lines from an unterminated last line', () => {
    const source = '[other]\nname = "x"';
    const result = run(source, ['/a']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('[other]\nname = "x"\n[workspace]\nadditional_dir = [ "/a" ]\n');
  });

  it('writes only the header and the key for empty input', () => {
    const result = run('', ['/a']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('[workspace]\nadditional_dir = [ "/a" ]\n');
  });

  it('writes only the header and the key for whitespace-only input', () => {
    const result = run('  \n\t\n', ['/a']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('[workspace]\nadditional_dir = [ "/a" ]\n');
  });
});

describe('rewriteAdditionalDirArray table survival', () => {
  it('keeps the workspace table and its other keys', () => {
    const source = '[workspace]\nname = "x"\nadditional_dir = ["/a"]\n';
    const result = run(source, ['/b']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((parse(result.text) as Doc)['workspace']).toEqual({
      name: 'x',
      additional_dir: ['/b'],
    });
  });

  it('keeps the workspace table when generating the key', () => {
    const source = '[workspace]\nname = "x"\n';
    const result = run(source, ['/b']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((parse(result.text) as Doc)['workspace']).toEqual({
      name: 'x',
      additional_dir: ['/b'],
    });
  });
});

describe('rewriteAdditionalDirArray newline style', () => {
  it('inserts a CRLF terminated line into a CRLF file', () => {
    const source = '[workspace]\r\nname = "x"\r\n';
    const result = run(source, ['/a']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('[workspace]\r\nadditional_dir = [ "/a" ]\r\nname = "x"\r\n');
  });

  it('appends CRLF terminated lines to a CRLF file without a header', () => {
    const source = '[other]\r\nname = "x"\r\n';
    const result = run(source, ['/a']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(
      '[other]\r\nname = "x"\r\n[workspace]\r\nadditional_dir = [ "/a" ]\r\n',
    );
  });

  it('keeps CRLF on a replacement', () => {
    const source = '[workspace]\r\nadditional_dir = ["/a"]\r\n';
    const result = run(source, ['/b']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('[workspace]\r\nadditional_dir = [ "/b" ]\r\n');
  });
});

describe('rewriteAdditionalDirArray serialization', () => {
  it('writes an empty array as []', () => {
    const source = '[workspace]\nadditional_dir = ["/a"]\n';
    const result = run(source, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('[workspace]\nadditional_dir = []\n');
    expect(writtenValue(result.text)).toEqual([]);
  });

  it('writes an empty array for a generated key', () => {
    const result = run('[workspace]\n', []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('[workspace]\nadditional_dir = []\n');
  });

  it('round-trips characters that need escaping', () => {
    const items = ['a"b', 'c\\d', 'tab\there', 'nl\nhere', 'ctrl\u0001', 'del\u007F'];
    const result = run('[workspace]\nadditional_dir = []\n', items);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(writtenValue(result.text)).toEqual(items);
    expect(result.text).toContain('\\"');
    expect(result.text).toContain('\\\\');
    expect(result.text).not.toContain('\n\t');
  });

  it('uses one space after the bracket and between items', () => {
    const result = run('[workspace]\nadditional_dir = []\n', ['/a', '/b']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('[workspace]\nadditional_dir = [ "/a", "/b" ]\n');
  });
});

describe('rewriteAdditionalDirArray SameValue comparison', () => {
  it('rewrites past a NaN at the root', () => {
    const source = 'value = nan\n[workspace]\nadditional_dir = []\n';
    const result = run(source, ['/x']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('value = nan\n[workspace]\nadditional_dir = [ "/x" ]\n');
  });

  it('rewrites past a NaN in the window table', () => {
    const source = '[workspace]\nvalue = nan\nadditional_dir = []\n';
    const result = run(source, ['/x']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('[workspace]\nvalue = nan\nadditional_dir = [ "/x" ]\n');
  });

  it('rewrites past a NaN inside an array', () => {
    const source = '[workspace]\nv = [nan]\nadditional_dir = []\n';
    const result = run(source, ['/x']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('[workspace]\nv = [nan]\nadditional_dir = [ "/x" ]\n');
  });
});

describe('rewriteAdditionalDirArray fragment identity', () => {
  const cases: ReadonlyArray<{ readonly name: string; readonly source: string }> = [
    { name: 'a quoted key', source: '[workspace]\n"additional_dir" = []\n' },
    { name: 'a literal quoted key', source: "[workspace]\n'additional_dir' = []\n" },
    { name: 'a quoted header', source: '[ "workspace" ]\nadditional_dir = []\n' },
  ];

  for (const { name, source } of cases) {
    it(`rewrites the array behind ${name}`, () => {
      const result = run(source, ['/x']);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.text).toBe(source.replace('[]', '[ "/x" ]'));
      expect(() => parse(result.text)).not.toThrow();
    });
  }

  it('keeps a quoted dotted root key intact', () => {
    const source = '"workspace.x" = 1\n[workspace]\nadditional_dir = []\n';
    const result = run(source, ['/x']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((parse(result.text) as Doc)['workspace.x']).toBe(1);
  });

  it('rejects a keyless statement in the window table', () => {
    expect(rewriteAdditionalDirArray('[workspace]\n= []\n', ['/x'])).toEqual({
      ok: false,
      reason: 'unrecognized_statement',
    });
  });
});

describe('rewriteAdditionalDirArray combined layers', () => {
  it('rewrites a quoted key past a NaN array', () => {
    const source = '[workspace]\nv = [nan]\n"additional_dir" = []\n';
    const result = run(source, ['/x']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('[workspace]\nv = [nan]\n"additional_dir" = [ "/x" ]\n');
  });

  it('accepts a quoted key that already holds the next entries', () => {
    expect(
      verifyRewrite(
        '[workspace]\n"additional_dir" = [ "/x" ]\n',
        '[workspace]\n"additional_dir" = [ "/x" ]\n',
        ['/x'],
        true,
      ),
    ).toBeNull();
  });
});

describe('reason families', () => {
  it('splits the layout reasons from the internal reasons', () => {
    expectTypeOf<Extract<TomlArraySliceLayoutReason, TomlArraySliceInternalReason>>().toBeNever();
    expectTypeOf<
      TomlArraySliceLayoutReason | TomlArraySliceInternalReason
    >().toEqualTypeOf<TomlArraySliceRejectReason>();
  });

  it('drops the removed reason member', () => {
    expectTypeOf<Extract<TomlArraySliceRejectReason, 'verify_failed'>>().toBeNever();
  });
});

describe('verifyRewrite', () => {
  it('reports an unparsable source', () => {
    expect(verifyRewrite('x = \n', '[workspace]\nadditional_dir = []\n', [], true)).toBe(
      'source_invalid',
    );
  });

  it('reports an unparsable output', () => {
    expect(verifyRewrite('[workspace]\nadditional_dir = []\n', 'x = \n', [], true)).toBe(
      'output_invalid',
    );
  });

  it('reports a projection that lost content', () => {
    const source = 'a = 1\n[workspace]\nadditional_dir = []\n';
    const output = 'a = 2\n[workspace]\nadditional_dir = ["/x"]\n';
    expect(verifyRewrite(source, output, ['/x'], true)).toBe('content_changed');
  });

  it('reports a written value that differs from the next entries', () => {
    expect(
      verifyRewrite(
        '[workspace]\nadditional_dir = []\n',
        '[workspace]\nadditional_dir = ["/y"]\n',
        ['/x'],
        true,
      ),
    ).toBe('content_changed');
  });

  it('accepts a faithful rewrite', () => {
    expect(
      verifyRewrite(
        '[workspace]\nadditional_dir = ["/a"]\n',
        '[workspace]\nadditional_dir = ["/b"]\n',
        ['/b'],
        true,
      ),
    ).toBeNull();
  });

  it('reports -0.0 against 0.0 as a change', () => {
    expect(
      verifyRewrite(
        'x = -0.0\n[workspace]\nadditional_dir = []\n',
        'x = 0.0\n[workspace]\nadditional_dir = []\n',
        [],
        true,
      ),
    ).toBe('content_changed');
  });

  it('accepts NaN on both sides', () => {
    expect(
      verifyRewrite(
        'x = nan\n[workspace]\nadditional_dir = []\n',
        'x = nan\n[workspace]\nadditional_dir = []\n',
        [],
        true,
      ),
    ).toBeNull();
  });

  it('accepts an unchanged document', () => {
    expect(
      verifyRewrite(
        '[workspace]\nadditional_dir = []\n',
        '[workspace]\nadditional_dir = []\n',
        [],
        true,
      ),
    ).toBeNull();
  });
});

describe('computeSkeleton', () => {
  it('masks comments and string interiors while keeping length and newlines', () => {
    const source = '[workspace]\nadditional_dir = ["/a]b", "/c#d"]\nnote = """\n[other]\n"""\n';
    const skeleton = computeSkeleton(source);

    expect(skeleton).toHaveLength(source.length);
    for (let index = 0; index < source.length; index += 1) {
      if (source.charAt(index) === '\n') expect(skeleton.charAt(index)).toBe('\n');
    }
    expect(skeleton).toContain('additional_dir = ["    ", "    "]');
    expect(skeleton).toContain('"""\n       \n"""');
  });
});

describe('rewriteAdditionalDirArray statement scanning', () => {
  function inPlace(source: string): string {
    const at = source.lastIndexOf('[]');
    return `${source.slice(0, at)}[ "/x" ]${source.slice(at + 2)}`;
  }

  it('rewrites past a nested array value', () => {
    const source = '[workspace]\nother = [\n  [1],\n]\nadditional_dir = []\n';
    const result = run(source, ['/x']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(inPlace(source));
    expect((parse(result.text) as Doc)['workspace']).toEqual({
      other: [[1]],
      additional_dir: ['/x'],
    });
  });

  it('rewrites past a multi-line inline table value', () => {
    const source = '[workspace]\nx = {\n a = [\n[1],\n]\n}\nadditional_dir = []\n';
    const result = run(source, ['/x']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(inPlace(source));
  });

  it('rewrites past a multi-line basic string value', () => {
    const source = '[workspace]\nnote = """\n[other]\n"""\nadditional_dir = []\n';
    const result = run(source, ['/x']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(inPlace(source));
  });

  it('rewrites past a multi-line literal string value', () => {
    const source = "[workspace]\nnote = '''\n[other]\n'''\nadditional_dir = []\n";
    const result = run(source, ['/x']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(inPlace(source));
  });

  it('still reports an unterminated array', () => {
    expect(rewriteAdditionalDirArray('[workspace]\nadditional_dir = ["/a"\n', ['/x'])).toEqual({
      ok: false,
      reason: 'unterminated',
    });
  });

  it('still reports an unterminated string inside an array', () => {
    expect(rewriteAdditionalDirArray('[workspace]\nadditional_dir = ["/a\n', ['/x'])).toEqual({
      ok: false,
      reason: 'unterminated',
    });
  });
});

describe('rewriteAdditionalDirArray root workspace forms', () => {
  it('rejects a dotted workspace key', () => {
    expect(rewriteAdditionalDirArray('"workspace".x = 1\n', ['/x'])).toEqual({
      ok: false,
      reason: 'dotted_key',
    });
  });

  it('rejects an inline workspace table', () => {
    expect(rewriteAdditionalDirArray('"workspace" = { additional_dir = [] }\n', ['/x'])).toEqual({
      ok: false,
      reason: 'inline_table',
    });
  });

  it('rejects a duplicate key behind a quoted key', () => {
    const source = "[workspace]\nadditional_dir = []\n'additional_dir' = []\n";
    expect(rewriteAdditionalDirArray(source, ['/x'])).toEqual({
      ok: false,
      reason: 'duplicate_key',
    });
  });

  it('reports a dotted key before a later not_an_array', () => {
    const source = 'workspace.x = 1\n[workspace]\nadditional_dir = "a"\n';
    expect(rewriteAdditionalDirArray(source, ['/x'])).toEqual({
      ok: false,
      reason: 'dotted_key',
    });
  });
});

describe('rewriteAdditionalDirArray layer integration', () => {
  const head =
    '# c\r\n[workspace]\r\nnote = """\r\n[x]\r\n"""\r\n"additional_dir" = ["/a"]   # keep\r\n';
  const tail = '[other]\r\nk = {\r\n a = [\r\n[1],\r\n]\r\n}\r\n';
  const source = `${head}${tail}`;

  it('rewrites only the array bytes of a layered document', () => {
    const result = run(source, ['/b']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(source.replace('["/a"]', '[ "/b" ]'));
    expect(result.text).toContain('# keep');
    expect(result.text).toContain('a = [\r\n[1],\r\n]');
  });

  it('rejects a duplicate key added to the layered workspace table', () => {
    expect(rewriteAdditionalDirArray(`${head}additional_dir = []\n${tail}`, ['/b'])).toEqual({
      ok: false,
      reason: 'duplicate_key',
    });
  });
});
