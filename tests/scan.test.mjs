import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hasPython, fixture, scanOf, at, script, tmpDir } from './helpers.mjs';
import { layerParams, Unknown } from '../skills/modelmap/scripts/lib/layers.mjs';
import { sum, annotate } from '../skills/modelmap/scripts/lib/params.mjs';

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
