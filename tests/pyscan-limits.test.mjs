// pyscan.py reads Python source as text and works out values with a small interpreter. A hostile repo must not be able to
// make that interpreter build values of any size (a string that doubles in a loop, 1 << 10**10, pow(10, 10**9),
// sum(range(10**12))) or run for minutes. Each case below is a repo built here at run time; the scan has to finish quickly,
// exit 0, still give the tree, and show the hostile value as unknown (with the reason) while the rest of the model keeps its
// exact numbers. The sizes are chosen so that the scan WITHOUT the limits stays under 1 GB and under a minute.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasPython } from './helpers.mjs';
import { limitsRepo, scanTimed, jobFor, pyscanMeasured } from './helpers-limits.mjs';

const skip = !hasPython && 'python3 (3.9+) is needed';
// the wrapper that measures memory imports resource, which Windows does not have (pyscan.py then skips its memory backstop)
const skipWrap = skip || (process.platform === 'win32' && 'the memory wrapper needs the resource module');
const MB = 1024 * 1024;
const kid = (json, name) => json.root.children.find((c) => c.name === name);
const HUGE = /not known: .*(too large|too long)/;

// each case: lines of Net.__init__ that end in self.bad = nn.Linear(4, <the hostile value>)
const BAD = [
  ['str + str doubles', ["s = 'a' * 100000", 'for i in range(9):', '    s = s + s', 'self.bad = nn.Linear(4, s)']],
  ['str += str doubles', ["s = 'a' * 100000", 'for i in range(9):', '    s += s', 'self.bad = nn.Linear(4, s)']],
  ['list + list doubles', ['l = [0] * 100000', 'for i in range(9):', '    l = l + l', 'self.bad = nn.Linear(4, l)']],
  ['list += list doubles', ['l = [0] * 100000', 'for i in range(9):', '    l += l', 'self.bad = nn.Linear(4, l)']],
  ['1 << 8*10**8', ['x = 1 << (8 * 10**8)', 'self.bad = nn.Linear(4, x)']],
  ['x <<= 8*10**8', ['x = 1', 'x <<= 8 * 10**8', 'self.bad = nn.Linear(4, x)']],
  ['pow(10, 10**7)', ['x = pow(10, 10**7)', 'self.bad = nn.Linear(4, x)']],
  ['sum(range(10**8))', ['x = sum(range(10**8))', 'self.bad = nn.Linear(4, x)']],
  ['min(range(10**8))', ['x = min(range(10**8))', 'self.bad = nn.Linear(4, x)']],
  ['max(range(10**8))', ['x = max(range(10**8))', 'self.bad = nn.Linear(4, x)']],
  ['sum of lists with a list start', ['x = sum([[0] * 50000] * 50, [])', 'self.bad = nn.Linear(4, x)']],
  ['x = x * x, repeated squaring', ['x = 3', 'for i in range(22):', '    x = x * x', 'self.bad = nn.Linear(4, x)']],
  ['x *= x, repeated squaring', ['x = 3', 'for i in range(22):', '    x *= x', 'self.bad = nn.Linear(4, x)']],
  ['x = x + x grows past 1024 bits', ['x = 1 << 1000', 'for i in range(40):', '    x = x + x', 'self.bad = nn.Linear(4, x)']],
  ['huge int ** 60 (exponent within 64)', ['x = (1 << 1000) ** 60', 'self.bad = nn.Linear(4, x)']],
  ['int * str (the sequence on the right)', ["s = 'ab' * 50000", 'x = 10 * s', 'self.bad = nn.Linear(4, x)']],
  ['int * list (the sequence on the right)', ['l = [0] * 50000', 'x = 10 * l', 'self.bad = nn.Linear(4, x)']],
  ["'%100000000d' % 5", ["x = '%100000000d' % 5", 'self.bad = nn.Linear(4, x)']],
  ["'%*d' % (10**8, 5)", ["x = '%*d' % (10**8, 5)", 'self.bad = nn.Linear(4, x)']],
  // an f-string with an unknown part says that, not why the part is unknown
  ['f-string doubles', ["s = 'a' * 100000", 'for i in range(9):', "    s = f'{s}{s}'", 'self.bad = nn.Linear(4, s)'], /not known: (value too large|f-string with an unknown part)/],
  ['[*l, *l] with 120,000 elements', ['l = [0] * 60000', 'l = [*l, *l]', 'self.bad = nn.Linear(4, l)']],
  ['l.extend(l) doubles', ['l = [0] * 20000', 'for i in range(8):', '    l.extend(l)', 'self.bad = nn.Linear(4, l)']],
  ['a comprehension over two ranges of 4096', ['l = [0 for a in range(4096) for b in range(4096)]', 'self.bad = nn.Linear(4, l)']],
  ["int('9' * 100000)", ["x = int('9' * 100000)", 'self.bad = nn.Linear(4, x)']],
  ['round(5, -10**7)', ['x = round(5, -10**7)', 'self.bad = nn.Linear(4, x)']],
  ['an int literal of 400 digits', ['x = 1' + '0'.repeat(400), 'self.bad = nn.Linear(4, x)']],
  ['str() of a shared nested list (262,144 elements)', ['big = [[[0] * 64] * 64] * 64', 'x = str(big)', 'self.bad = nn.Linear(4, x)']],
  // these were unknown before and must stay so
  ['list(range(10**9))', ['x = list(range(10**9))', 'self.bad = nn.Linear(4, x)'], /not known/],
  ['list() of a literal list of 100,001 elements', ['l = [' + '0,'.repeat(100001) + ']', 'x = list(l)', 'self.bad = nn.Linear(4, x)'], /not known/],
  ['x ** 65', ['x = 3 ** 65', 'self.bad = nn.Linear(4, x)'], /not known: power too large/],
  ['a list of 100,000 times 2', ['x = [0] * 100000 * 2', 'self.bad = nn.Linear(4, x)'], /not known: sequence too long/],
];

test('limits: each hostile value is unknown with its reason, the scan is quick and exits 0, and the Linear after it keeps its exact count', { skip }, async () => {
  const runs = await Promise.all(BAD.map(async ([name, lines, why = HUGE]) => ({ name, why, r: await scanTimed(limitsRepo(lines)) })));
  const problems = [];
  for (const { name, why, r } of runs) {
    if (r.status !== 0 || !r.json?.root) { problems.push(name + ': exit ' + r.status + ' ' + r.stderr); continue; }
    if (r.ms > 20000) problems.push(name + ': took ' + r.ms + ' ms');
    const bad = kid(r.json, 'bad'), fc = kid(r.json, 'fc');
    if (!(bad?.params.v === 0 && bad.params.lowerBound && why.test(bad.params.why))) problems.push(name + ': bad is ' + JSON.stringify(bad?.params));
    if (!(fc?.params.v === 20 && !fc.params.lowerBound)) problems.push(name + ': fc is ' + JSON.stringify(fc?.params));
  }
  assert.deepEqual(problems, []);
});

test('limits: one list of modules keeps at most 100,000 (extend that doubles it stops there), and a list of 100,000 modules still scans in seconds', { skip }, async () => {
  const [grow, wide] = await Promise.all([
    // 18 doublings of a list of one module: 262,144 without the cap
    scanTimed(limitsRepo(['self.layers = nn.ModuleList([nn.Linear(2, 2)])', 'for i in range(18):', '    self.layers.extend(self.layers)'])),
    scanTimed(limitsRepo(['self.layers = nn.ModuleList([nn.Linear(2, 2)] * 100000)'])),
  ]);
  for (const r of [grow, wide]) { assert.equal(r.status, 0, r.stderr); assert.ok(r.ms < 20000, r.ms + ' ms'); assert.equal(kid(r.json, 'fc').params.v, 20); }
  const g = kid(grow.json, 'layers');
  assert.ok(g.children.length > 0 && g.children.length <= 100000, 'children: ' + g.children.length);
  assert.equal(g.incomplete, true);
  assert.match(g.notes.join(' '), /more than 100000 modules in one list.*value too large/);
  assert.equal(kid(wide.json, 'layers').children.length, 100000);
});

test('limits: a call with two * arguments of 60,000 elements each is unknown, not a Sequential of 120,000 modules', { skip }, async () => {
  const r = await scanTimed(limitsRepo(['l = [nn.ReLU()] * 60000', 'self.bad = nn.Sequential(*l, *l)']));
  assert.equal(r.status, 0, r.stderr);
  const bad = kid(r.json, 'bad');
  assert.equal(bad.kind, 'unknown');
  assert.match(bad.why, /value too large/);
  assert.equal(kid(r.json, 'fc').params.v, 20);
});

test('limits: a value that is small at every step but huge to write out (a list of 64 lists of 64 lists of 64) is cut in the output, not expanded', { skip }, async () => {
  const r = await scanTimed(limitsRepo(['big = [[[0] * 64] * 64] * 64', 'self.wide = nn.Linear(4, 4, bias=big)']));
  assert.equal(r.status, 0, r.stderr);
  const wide = kid(r.json, 'wide');
  const text = JSON.stringify(wide.kw);
  assert.match(text, /"unknown":"too large"/);
  assert.ok(text.length < 200000, 'the value took ' + text.length + ' bytes');
  assert.equal(kid(r.json, 'fc').params.v, 20);
});

test('limits: a range longer than the machine int (for i in range(10**30)) no longer stops the scan', { skip }, async () => {
  const r = await scanTimed(limitsRepo(['for i in range(10**30):', '    pass']));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(kid(r.json, 'fc').params.v, 20);
});

test('limits: real values stay exact: a dim of 10**6, a vocab of 50257 * 4096, 2**62, 3**40, 1 << 100', { skip: skipWrap }, () => {
  const root = limitsRepo([
    'self.emb = nn.Embedding(50257, 4096)', 'self.wide = nn.Linear(dim, 4)', 'self.tab = nn.Embedding(vocab // 4096, 2)',
    'self.keep = Keep(big, big3, mask, 1 << 100)',
  ], { top: ['class Keep(nn.Module):', '    def __init__(self, a, b, c, d):', '        super().__init__()', '', 'dim = 10**6', 'vocab = 50257 * 4096', 'big = 2**62', 'big3 = 3**40', 'mask = (1 << 100) - 1'] });
  const run = pyscanMeasured(jobFor(root));
  assert.equal(run.status, 0, run.stderr);
  const kids = Object.fromEntries(run.result.root.children.map((c) => [c.name, c]));
  assert.equal(kids.emb.pos.length, 2);
  // the numbers as pyscan.py writes them: exact, beyond 2**53 as well
  assert.match(run.stdout, /"v": 4611686018427387904\b/);
  assert.match(run.stdout, /"v": 12157665459056928801\b/);
  assert.match(run.stdout, /"v": 1267650600228229401496703205375\b/);
  const scan = JSON.parse(run.stdout);
  const byName = (n) => scan.root.children.find((c) => c.name === n);
  assert.deepEqual(byName('wide').pos.map((p) => p.v), [1000000, 4]);
  assert.deepEqual(byName('tab').pos.map((p) => p.v), [50257, 2]);
});

test('limits: the memory of pyscan.py stays under 300 MB on the str + str bomb (12 doublings of 100,000 characters: 843 MB without the limits)', { skip: skipWrap }, () => {
  const root = limitsRepo(["s = 'a' * 100000", 'for i in range(12):', '    s = s + s', 'self.bad = nn.Linear(4, 2)']);
  const run = pyscanMeasured(jobFor(root));
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.peak > 0, 'the wrapper reported no peak memory: ' + run.stderr);
  assert.ok(run.peak < 300 * MB, 'peak memory ' + Math.round(run.peak / MB) + ' MB');
  assert.ok(run.result.root, 'the tree is still produced');
});

test('limits: the memory backstop in tick() stops a scan that grows past the limit by many values that are each small enough, and the test knob can only lower the limit', { skip: skipWrap }, () => {
  // 200 lists of 100,000 elements: 160 MB alive, each list within the limits; then enough steps for the check (every 2048)
  const grow = limitsRepo(['keep = [[0] * 100000 for _ in range(200)]', 'for i in range(4096):', '    pass', 'self.n = nn.Linear(4, 4)']);
  const plain = limitsRepo(['for i in range(4096):', '    pass', 'self.n = nn.Linear(4, 4)']);
  const low = { MODELMAP_PYSCAN_MAX_RSS_MB: '100' };
  const control = pyscanMeasured(jobFor(plain), { env: low });
  assert.equal(control.status, 0, control.stderr);
  assert.ok(control.result.root && !control.result.warnings, 'a small scan is under the lowered limit: ' + control.peak / MB + ' MB, ' + JSON.stringify(control.result.warnings));
  const stopped = pyscanMeasured(jobFor(grow), { env: low });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.result.root, null);
  assert.deepEqual(stopped.result.warnings, ['memory limit exceeded; the tree may be partial']);
  // the knob does not raise or disable the limit: a high value or one that is not a number leaves the 1.5 GB limit, and this scan (160 MB) runs through
  for (const v of ['100000', 'abc', '', '-5', 'nan', 'inf']) {
    const r = pyscanMeasured(jobFor(grow), { env: { MODELMAP_PYSCAN_MAX_RSS_MB: v } });
    assert.ok(r.result.root && !r.result.warnings, 'MODELMAP_PYSCAN_MAX_RSS_MB=' + JSON.stringify(v) + ' changed the limit: ' + JSON.stringify(r.result.warnings));
  }
});
