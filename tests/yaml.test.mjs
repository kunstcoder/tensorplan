import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml } from '../skills/modelmap/scripts/lib/yaml.mjs';

const ok = (text) => {
  const r = parseYaml(text);
  assert.equal(r.error, undefined, 'unexpected error: ' + r.error + ' (line ' + r.line + ')');
  return r.value;
};
const stops = (text, re, line) => {
  const r = parseYaml(text);
  assert.ok(r.error, 'expected an error for ' + JSON.stringify(text.slice(0, 60)));
  assert.match(r.error, re);
  if (line !== undefined) assert.equal(r.line, line);
  assert.equal(r.value, undefined);
};

test('block maps, nested maps and scalars', () => {
  assert.deepEqual(ok('a: 1\nb:\n  c: 2\n  d:\n    e: x\nf: last\n'), { a: 1, b: { c: 2, d: { e: 'x' } }, f: 'last' });
});

test('scalars: ints, floats, bools, null, strings', () => {
  const v = ok([
    'i: 42', 'n: -7', 'p: +3', 'h: 0x1F', 'o: 0o17', 'f: 3.5', 'e: 1e-4', 'e2: 3.0e+2', 'd: .5', 'inf: .inf', 'ninf: -.inf',
    't: true', 'T: True', 'f2: false', 'z: null', 'tl: ~', 'empty:', 's: hello world', 'path: /a/b:c', 'url: http://x.y/z',
    'dq: "a\\tb\\n\\"q\\" \\u00e9"', "sq: 'it''s'", 'num_str: "12"', 'ver: 1.2.3',
  ].join('\n'));
  assert.deepEqual(v, {
    i: 42, n: -7, p: 3, h: 31, o: 15, f: 3.5, e: 1e-4, e2: 300, d: 0.5, inf: Infinity, ninf: -Infinity,
    t: true, T: true, f2: false, z: null, tl: null, empty: null, s: 'hello world', path: '/a/b:c', url: 'http://x.y/z',
    dq: 'a\tb\n"q" é', sq: "it's", num_str: '12', ver: '1.2.3',
  });
  assert.ok(Number.isNaN(ok('x: .nan').x));
});

test('block lists, lists of maps, lists of lists, a list under a key at the same indent', () => {
  assert.deepEqual(ok('- 1\n- two\n- 3.0\n'), [1, 'two', 3]);
  assert.deepEqual(ok('layers:\n  - name: a\n    dim: 4\n  - name: b\n    dim: 8\n'), { layers: [{ name: 'a', dim: 4 }, { name: 'b', dim: 8 }] });
  assert.deepEqual(ok('m:\n- - 1\n  - 2\n- - 3\n'), { m: [[1, 2], [3]] });
  assert.deepEqual(ok('a:\n- x\n- y\nb: 2\n'), { a: ['x', 'y'], b: 2 });
  assert.deepEqual(ok('-\n  k: 1\n- \n'), [{ k: 1 }, null]);
});

test('flow lists and flow maps on one line', () => {
  assert.deepEqual(ok('a: [1, 2, 3]\nb: {x: 1, y: [a, "b,c"]}\nc: []\nd: {}\ne: [1, 2,]\n'), { a: [1, 2, 3], b: { x: 1, y: ['a', 'b,c'] }, c: [], d: {}, e: [1, 2] });
  assert.deepEqual(ok('- [1, [2, [3]]]\n'), [[1, [2, [3]]]]);
  assert.deepEqual(ok('shape: [null, true, ~, 1.5]'), { shape: [null, true, null, 1.5] });
});

test('comments, blank lines, a leading document marker, CRLF and a BOM', () => {
  assert.deepEqual(ok('\uFEFF# head\n---\n\na: 1 # one\n  # indented comment\nb: "x # not a comment"\nc: don\'t # yes\nd: a#b\r\n'), { a: 1, b: 'x # not a comment', c: "don't", d: 'a#b' });
  assert.equal(ok(''), null);
  assert.equal(ok('# only a comment\n'), null);
});

test('a key named __proto__ stays a plain key', () => {
  const v = ok('__proto__:\n  polluted: 1\n');
  assert.equal(Object.getPrototypeOf(v), Object.prototype);
  assert.deepEqual(Object.keys(v), ['__proto__']);
  assert.equal({}.polluted, undefined);
});

test('a repeated key: the last one wins', () => {
  assert.deepEqual(ok('a: 1\na: 2\n'), { a: 2 });
});

test('lines mirror the value', () => {
  const r = parseYaml('# c\nmodel:\n  dim: 192\n  heads: [3, 6]\n  blocks:\n    - k: 1\n    - 2\nlr: 0.1\n', { lines: true });
  assert.deepEqual(r.value, { model: { dim: 192, heads: [3, 6], blocks: [{ k: 1 }, 2] }, lr: 0.1 });
  assert.deepEqual(r.lines, { model: { dim: 3, heads: [4, 4], blocks: [{ k: 6 }, 7] }, lr: 8 });
  assert.equal(parseYaml('a: 1').lines, undefined, 'lines only when asked');
});

test('stops: anchors, aliases and tags', () => {
  stops('a: &x 1\nb: *x\n', /anchors and aliases/, 1);
  stops('a: 1\nb: *x\n', /anchors and aliases/, 2);
  stops('a: [&x 1]', /anchors and aliases/, 1);
  stops('a: !!int 1', /tags/, 1);
  stops('a: !custom x', /tags/, 1);
  stops('- !x 1', /tags/, 1);
});

test('stops: a second document, block scalars, merge keys, directives', () => {
  stops('a: 1\n---\nb: 2\n', /second document/, 2);
  stops('a: 1\n...\n', /second document/, 2);
  stops('a: |\n  text\n', /block scalars/, 1);
  stops('a: >-\n  text\n', /block scalars/, 1);
  stops('base: {x: 1}\n<<: {y: 2}\n', /merge keys/, 2);
  stops('a: {<<: 1}', /merge keys/, 1);
  stops('%YAML 1.2\na: 1', /directives/, 1);
});

test('stops: tabs in indentation, flow over several lines, multi-line plain scalars', () => {
  stops('a:\n\tb: 1\n', /tabs/, 2);
  stops('a: [1,\n  2]\n', /flow collection must end on its line/, 1);
  stops('a: {x: 1,\n  y: 2}\n', /flow collection must end on its line/, 1);
  stops('a: some text\n  more text\n', /unexpected indentation/, 2);
  stops('- one\n  two\n', /unexpected indentation/, 2);
  stops('a: "open\n  close"\n', /quoted string must end/, 1);
  stops('a:\n    b: 1\n  c: 2\n', /indentation/, 3);
});

test('stops: other broken input', () => {
  stops('a: b: c', /map inside a plain value/, 1);
  stops('just: [1, 2] x', /text after a flow/, 1);
  stops('a: "x" y', /text after a quoted/, 1);
  stops('a: "\\q"', /unknown escape/, 1);
  stops('a: 1\nnot a pair\n', /unexpected indentation or a second value|expected/, 2);
});

test('limits: depth 32 and 1 MB', () => {
  let deep = '';
  for (let i = 0; i < 40; i++) deep += ' '.repeat(i * 2) + 'k' + i + ':\n';
  stops(deep, /nested deeper than 32/);
  stops('a: ' + '['.repeat(40) + ']'.repeat(40), /nested deeper than 32/);
  let ok31 = '';
  for (let i = 0; i < 30; i++) ok31 += ' '.repeat(i * 2) + 'k' + i + ':\n';
  assert.equal(parseYaml(ok31).error, undefined);
  stops('a: ' + 'x'.repeat(1024 * 1024 + 1), /larger than 1 MB/);
  assert.match(parseYaml(null).error, /not text/);
});

test('hostile input finishes fast (no backtracking): 100,000 character lines', () => {
  const N = 100000;
  const cases = [
    'a: ' + 'x'.repeat(N),
    'a: ' + '1'.repeat(N),
    'a: ' + '1.'.repeat(N / 2),
    'a: ' + '1e'.repeat(N / 2),
    'a: "' + '\\\\'.repeat(N / 2) + '"',
    'a: "' + 'x'.repeat(N),
    "a: '" + "''".repeat(N / 2) + "'",
    'a: [' + '1, '.repeat(N / 3) + ']',
    'a: [' + '['.repeat(N),
    'a: {' + 'k: ['.repeat(N / 4),
    'k'.repeat(N) + ': 1',
    ': '.repeat(N / 2),
    '- '.repeat(N / 2),
    '#'.repeat(N),
    'a: ' + ' #'.repeat(N / 2),
    'a: ' + '-'.repeat(N),
    ' '.repeat(N) + 'a: 1',
    ('a: 1\n').repeat(N / 5),
  ];
  for (const c of cases) {
    const t0 = process.hrtime.bigint();
    parseYaml(c);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1000, 'took ' + ms.toFixed(0) + ' ms on ' + JSON.stringify(c.slice(0, 20)));
  }
});
