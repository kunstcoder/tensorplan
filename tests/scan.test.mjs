import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hasPython, fixture, scanOf, at, script, tmpDir } from './helpers.mjs';
import { layerParams, Unknown } from '../skills/modelmap/scripts/lib/layers.mjs';
import { sum, annotate } from '../skills/modelmap/scripts/lib/params.mjs';
import { runScan, allNodes } from './helpers-scan.mjs';

const opts = { skip: hasPython ? false : 'python3 (3.9 or newer) is not available' };

// ---- the numbers below are worked by hand from the fixture, with dim = 16 ----
const lin = (i, o) => i * o + o;
const ln = (d) => 2 * d;
const mlp = lin(16, 64) + lin(64, 16);          // 1,088 + 1,040 = 2,128
const attn = lin(16, 48) + lin(16, 16);         //   816 +   272 = 1,088
const block = ln(16) + attn + ln(16) + mlp;     // 3,280

test('the scan picks the root class and counts every known part', opts, () => {
  const s = scanOf(fixture('mini-model'));
  assert.equal(s.rootClass, 'Net');
  const known = 100 * 16 /* embed */ + 8 * 16 /* pos */ + 3 * block /* blocks */ + 2 * block /* mixed */
    + (lin(16, 16) + lin(16, 4)) /* head */ + lin(16, 16) /* extra, made by a method */;
  assert.equal(known, 18740);
  assert.equal(s.root.params.v, known);
  assert.equal(s.root.params.lowerBound, true, 'two parts are unknown, so the total is a lower bound');
});

test('an unknown part is named, never guessed', opts, () => {
  const s = scanOf(fixture('mini-model'));
  assert.equal(at(s.root, 'drop').kind, 'external');
  assert.match(at(s.root, 'drop').why, /timm\.layers\.DropPath is not in the scanned repo/);
  assert.equal(at(s.root, 'mystery').kind, 'unknown');
  assert.equal(s.resolution.external, 1);
  assert.equal(s.resolution.unknown, 1);
});

test('a loop over a known string and an if on a known value unroll', opts, () => {
  const s = scanOf(fixture('mini-model'));
  const mixed = at(s.root, 'mixed');
  assert.deepEqual(mixed.children.map((c) => c.attn ?? c.children.find((k) => k.name === 'attn').cls), ['Attn', 'CrossAttn']);
});

test('a class with no __init__ of its own uses the one of its base', opts, () => {
  const s = scanOf(fixture('mini-model'));
  const cross = at(s.root, 'mixed.1.attn');
  assert.equal(cross.cls, 'CrossAttn');
  assert.equal(cross.params.v, attn);
});

test('a module under two names counts once', opts, () => {
  const s = scanOf(fixture('mini-model'));
  assert.equal(at(s.root, 'tied').alias, 'head.0');
  assert.equal(at(s.root, 'tied').params.v, 0);
  assert.equal(at(s.root, 'head').params.v, lin(16, 16) + lin(16, 4));
});

test('the scan writes nothing into the folder it reads when --out points elsewhere', opts, () => {
  const s = scanOf(fixture('mini-model'));
  assert.equal(s.errors.length, 0);
  assert.deepEqual(fs.readdirSync(fixture('mini-model')).sort(), ['model.py', 'tied.py']);
});

test('pyscan.py refuses a path that leaves the folder, and does not read it', opts, () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'repo'));
  fs.writeFileSync(path.join(root, 'outside.py'), 'class Evil: pass\n');
  fs.writeFileSync(path.join(root, 'repo', 'ok.py'), 'from torch import nn\nclass M(nn.Module):\n    def __init__(self):\n        super().__init__()\n        self.a = nn.Linear(2, 3)\n');
  const job = { root: path.join(root, 'repo'), files: ['../outside.py', 'ok.py'], rootClass: null, args: {} };
  const r = spawnSync('python3', ['-I', script('pyscan.py')], { input: JSON.stringify(job), encoding: 'utf8' });
  const out = JSON.parse(r.stdout);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0].error, /outside the repo folder/);
  assert.equal(out.stats.files, 1);
  assert.equal(out.root.cls, 'M');
});

test('code is read, never run: a file with side effects at import time does nothing', opts, () => {
  const root = tmpDir();
  const marker = path.join(root, 'ran.txt');
  fs.writeFileSync(path.join(root, 'bad.py'), 'import os\nopen(' + JSON.stringify(marker) + ', "w").write("x")\nfrom torch import nn\nclass M(nn.Module):\n    def __init__(self):\n        super().__init__()\n        open(' + JSON.stringify(marker) + ', "w").write("y")\n        self.a = nn.Linear(2, 3)\n');
  const s = scanOf(root);
  assert.equal(s.root.params.v, 9);
  assert.equal(fs.existsSync(marker), false, 'the scan must not run the code it reads');
});

test('helpers, star unpacking, dataclass configs and a tied weight', opts, () => {
  const s = scanOf(fixture('mini-model'), ['--root-class', 'tied.py:Tied', '--arg', 'config={"vocab":50,"dim":8,"layers":2}']);
  assert.equal(s.root.cls, 'Tied');
  // embed 0 (tied) + 2 Linear(8,8) + pool Linear(16*1*2, 8, no bias) + out Linear(8, 50, no bias)
  assert.equal(s.root.params.v, 0 + 2 * (8 * 8 + 8) + 32 * 8 + 8 * 50);
  assert.equal(s.root.params.lowerBound, undefined, 'every part is known');
  assert.equal(at(s.root, 'embed').tied.weight, 'out');
});

test('a class of another package that holds no parameters counts as zero; others stay unknown', opts, () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'm.py'), 'from torch import nn\nfrom einops.layers.torch import Rearrange\nfrom timm.layers import DropPath\nclass M(nn.Module):\n    def __init__(self):\n        super().__init__()\n        self.r = Rearrange("b c -> b c")\n        self.a = nn.Linear(2, 3)\n        self.d = DropPath(0.1)\n');
  const s = scanOf(root);
  assert.equal(at(s.root, 'r').params.v, 0);
  assert.equal(at(s.root, 'r').params.lowerBound, undefined);
  assert.equal(at(s.root, 'd').params.lowerBound, true);
  assert.equal(s.root.params.v, 9);
});

test('layer formulas', () => {
  const r = (v) => ({ v });
  assert.equal(layerParams('Linear', [r(10), r(5)]), 55);
  assert.equal(layerParams('Linear', [r(10), r(5)], { bias: r(false) }), 50);
  assert.equal(layerParams('LayerNorm', [r(192)], { eps: r(1e-6) }), 384);
  assert.equal(layerParams('LayerNorm', [r([4, 8])]), 64);
  assert.equal(layerParams('BatchNorm2d', [r(8)]), 16);
  assert.equal(layerParams('Conv2d', [r(3), r(8), r(3)]), 8 * 3 * 9 + 8);
  assert.equal(layerParams('Conv1d', [r(4), r(8), r(3)], { groups: r(2) }), 8 * 2 * 3 + 8);
  assert.equal(layerParams('Embedding', [r(100), r(16)]), 1600);
  assert.equal(layerParams('MultiheadAttention', [r(8), r(2)]), 3 * 64 + 24 + 64 + 8);
  assert.equal(layerParams('GELU'), 0);
  assert.equal(layerParams('Sequential'), 0);
  assert.throws(() => layerParams('LSTM', [r(1), r(1)]), Unknown);
  assert.throws(() => layerParams('Linear', [{ v: { unknown: 'cfg.hidden is not known' } }, r(5)]), /cfg.hidden/);
});

test('a sum with an unknown part is a lower bound, and a lower bound spreads upward', () => {
  assert.deepEqual(sum([{ v: 2, src: 'code' }, { v: 3, src: 'code' }]), { v: 5, src: 'code' });
  const s = sum([{ v: 2, src: 'code' }, { v: null, why: 'x is unknown' }]);
  assert.equal(s.v, 2);
  assert.equal(s.lowerBound, true);
  const inner = { kind: 'repo', children: [{ kind: 'unknown', why: 'y', children: [] }], params: [] };
  const outer = { kind: 'repo', children: [inner], params: [] };
  assert.equal(annotate(outer).lowerBound, true);
  assert.equal(sum([{ v: 1, src: 'code' }, { v: 1, src: 'weights' }]).src, 'code', 'the weakest source wins');
});

// ---- source tags (src) ----

const records = (n) => [...(n.pos || []), ...Object.values(n.kw || {}), ...Object.values(n.args || {})];

test('a scan with no config and no --arg tags everything code, with the same numbers as before', opts, () => {
  const s = scanOf(fixture('mini-model'));
  assert.equal(s.root.params.v, 18740);
  for (const n of allNodes(s.root)) {
    if (n.params) assert.equal(n.params.src, 'code', n.path);
    for (const r of records(n)) assert.equal(r.src, undefined, n.path);
  }
  assert.equal(s.config, undefined);
  assert.equal(s.weights, undefined);
});

test('--arg values are tagged config, at "command line", and survive arithmetic', opts, () => {
  const s = scanOf(fixture('mini-model'), ['--root-class', 'tied.py:Tied', '--arg', 'config={"vocab":50,"dim":8,"layers":2}']);
  assert.deepEqual(at(s.root, 'embed').pos[0], { v: 50, src: 'config', at: 'command line' });
  assert.deepEqual(at(s.root, 'stack.1').pos, [{ v: 8, src: 'config', at: 'command line' }, { v: 8, src: 'config', at: 'command line' }]);
  assert.equal(at(s.root, 'stack').params.src, 'config');
  assert.equal(at(s.root, 'out').params.src, 'config');
  // pool = Linear(h * w * first * len(rest), config.dim): in_features comes from the code, so pool is code
  assert.equal(at(s.root, 'pool').pos[0].src, undefined);
  assert.equal(at(s.root, 'pool').params.src, 'code');
  assert.equal(s.root.params.src, 'code', 'a total is only as sure as its weakest part');
  assert.equal(s.root.args.config.src, 'config', 'a dict of tagged values is tagged');
  assert.equal(s.root.args.size.src, undefined);
});

test('layerParams reports the weakest source of the arguments it used; bools and layers without values are neutral', () => {
  const c = (v) => ({ v, src: 'config', at: 'c.yaml:1' });
  const k = (v) => ({ v });
  const info = {};
  assert.equal(layerParams('Linear', [c(10), c(5)], { bias: k(true) }, info), 55);
  assert.equal(info.src, 'config');
  layerParams('Linear', [c(10), k(5)], {}, info);
  assert.equal(info.src, 'code');
  layerParams('GELU', [], {}, info);
  assert.equal(info.src, null);
  layerParams('Dropout', [c(0.1)], {}, info);
  assert.equal(info.src, null, 'an argument that does not change the count is not read');
  assert.equal(layerParams('Linear', [c(10), c(5)]), 55, 'the 3-argument form still returns a number');
  const tree = { kind: 'repo', params: [], children: [
    { kind: 'torch', cls: 'Linear', pos: [c(4), c(4)], kw: {}, children: [] },
    { kind: 'torch', cls: 'GELU', pos: [], kw: {}, children: [] },
  ] };
  assert.deepEqual(annotate(tree), { v: 20, src: 'config' });
  assert.equal(tree.children[1].params.src, 'code', 'a neutral node shows code');
  const mixed = { kind: 'repo', params: [{ name: 'p', shape: [3] }], children: [{ kind: 'torch', cls: 'Linear', pos: [c(4), c(4)], kw: {}, children: [] }] };
  assert.equal(annotate(mixed).src, 'code');
  const tagged = { kind: 'repo', params: [{ name: 'p', shape: [3], src: 'config' }], children: [] };
  assert.equal(annotate(tagged).src, 'config');
  assert.equal(sum([{ v: 0 }, { v: 0 }]).src, 'code', 'parts without a source give code, not run');
});

test('the summary shows the source of the total', opts, () => {
  const a = runScan(fixture('mini-model'));
  assert.match(a.stdout, /PARAMS {2}≥ 18,740 {2}\[code\]/);
  assert.doesNotMatch(a.stdout, /CONFIG|WEIGHTS/);
});

// ---------- the input and output contract of forward (new fields only) ----------
test('pyscan.py: forward gains optional, nullable, docText, shapeHint and output keys; dims appear only when the job names dimension names', opts, () => {
  const root = fixture('contract/dict-out');
  const run = (extra) => JSON.parse(spawnSync('python3', ['-I', script('pyscan.py')], { input: JSON.stringify({ root, files: ['model.py'], rootClass: null, args: {}, ...extra }), encoding: 'utf8' }).stdout);
  const plainJob = run({});
  assert.equal(plainJob.dims, undefined, 'no dimNames, no dims');
  const fw = plainJob.forward;
  // optional: has a default; nullable: the type allows None
  assert.deepEqual(fw.params.map((p) => [p.name, p.annotation, p.default, p.optional, p.nullable]), [['tokens', 'torch.Tensor', null, false, false], ['positions', 'torch.Tensor | None', null, false, true], ['mask', 'Optional[torch.Tensor]', 'None', true, true], ['scale', 'float', '1.0', true, false], ['cache', "'torch.Tensor | None'", 'None', true, true]]);
  assert.deepEqual(fw.params[0].shapeHint, ['batch_size', 'seq_len']);
  assert.equal(fw.params[3].shapeHint, undefined);
  assert.deepEqual(fw.output.keys, ['hidden', 'logits', 'extra']);
  assert.deepEqual(fw.output.keyShapes, { hidden: ['B', 'N', 'D'], logits: ['B', 'N', 'V'] });
  assert.equal(fw.end, 60);
  const withDims = run({ dimNames: ['dim', 'num_heads', 'head_dim'], dimAttrs: ['head_dim'] });
  assert.deepEqual(withDims.dims.args.map((a) => [a.name, a.v, a.at]), [['dim', 32, 'model.py:16'], ['num_heads', 4, 'model.py:16']]);
  assert.deepEqual(withDims.dims.attrs.map((a) => [a.name, a.cls, a.path, a.v, a.at, a.expr]), [['num_heads', 'Attention', 'attn', 4, 'model.py:10', 'num_heads'], ['head_dim', 'Attention', 'attn', 8, 'model.py:11', 'dim // num_heads']]);
  assert.deepEqual(withDims.dims.floordiv, [{ a: 'dim', b: 'num_heads', at: 'model.py:11' }]);
  assert.deepEqual(withDims.dims.assigned, [{ name: 'head_dim', at: 'model.py:11' }]);
  assert.deepEqual(withDims.root, plainJob.root, 'the module tree does not change');
});

test('the scan summary names the inputs, the output and the dims', opts, () => {
  const r = runScan(fixture('contract/tuple-out'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^INPUTS {2}2 {2}\(idx, targets\?\) {2}forward\(\) at model\.py:16$/m);
  assert.match(r.stdout, /^OUTPUT {2}\(no annotation\) {2}\(logits, loss\)$/m);
  assert.match(r.stdout, /^DIMS {4}D=48 \(hidden_size\) {2}H=6 \(n_heads\) {2}d_h=8 \(hidden_size \/\/ n_heads\) {2}L=2 \(n_layer\)$/m);
  assert.ok(r.json.dims && r.json.forward.output, 'scan.json keeps what the summary used');
});
