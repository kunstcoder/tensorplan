import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasPython, fixture, tmpDir, at } from './helpers.mjs';
import { writeSafetensors, writeRaw, runScan } from './helpers-scan.mjs';
import { readHeader, readWeights, crossCheck, expectKeys, dtypeBytes, numel, MAX_TENSORS } from '../skills/modelmap/scripts/lib/safetensors.mjs';
import { layerKeys } from '../skills/modelmap/scripts/lib/layers.mjs';

const opts = { skip: hasPython ? false : 'python3 (3.9 or newer) is not available' };
const NANOGPT = '/private/tmp/claude-501/-Users-hyunj-macbook-orca-workspaces-modelmap-brill/110db30d-24b3-40ce-85b0-a30d4b711d7b/scratchpad/ext/nanoGPT';
const nanoOpts = { skip: !hasPython ? 'python3 is not available' : fs.existsSync(path.join(NANOGPT, 'model.py')) ? false : 'the nanoGPT clone is not on this machine' };
const tmp = (name) => path.join(tmpDir(), name);
const f32 = (entries) => entries.map(([k, s]) => [k, 'F32', s]);
const timed = (fn) => { const t0 = Date.now(); const r = fn(); return [r, Date.now() - t0]; };

// ---------- hand-written state_dict keys (NOT made by the code under test) ----------

// tests/fixtures/mini-model/model.py, class Net, dim 16
function miniKeys() {
  const block = (p) => [
    [p + 'norm1.weight', [16]], [p + 'norm1.bias', [16]],
    [p + 'attn.qkv.weight', [48, 16]], [p + 'attn.qkv.bias', [48]],
    [p + 'attn.proj.weight', [16, 16]], [p + 'attn.proj.bias', [16]],
    [p + 'norm2.weight', [16]], [p + 'norm2.bias', [16]],
    [p + 'mlp.fc1.weight', [64, 16]], [p + 'mlp.fc1.bias', [64]],
    [p + 'mlp.fc2.weight', [16, 64]], [p + 'mlp.fc2.bias', [16]],
  ];
  return [
    ['embed.weight', [100, 16]], ['pos', [1, 8, 16]],
    ...block('blocks.0.'), ...block('blocks.1.'), ...block('blocks.2.'), ...block('mixed.0.'), ...block('mixed.1.'),
    ['head.0.weight', [16, 16]], ['head.0.bias', [16]], ['head.2.weight', [4, 16]], ['head.2.bias', [4]],
    ['extra.weight', [16, 16]], ['extra.bias', [16]],
  ];
}

// tests/fixtures/gpt-mini/model.py, class TinyGPT with config.yaml (vocab 50, context 8, layers 2, width 16)
function tinyKeys({ tok = false } = {}) {
  const out = tok ? [['body.tok.weight', [50, 16]]] : [];
  out.push(['body.pos.weight', [8, 16]]);
  for (const i of [0, 1]) {
    const p = 'body.layers.' + i + '.';
    out.push([p + 'norm1.weight', [16]], [p + 'norm1.bias', [16]], [p + 'attn.qkv.weight', [48, 16]], [p + 'attn.qkv.bias', [48]],
      [p + 'attn.out.weight', [16, 16]], [p + 'attn.out.bias', [16]], [p + 'norm2.weight', [16]], [p + 'norm2.bias', [16]],
      [p + 'ff.up.weight', [64, 16]], [p + 'ff.up.bias', [64]], [p + 'ff.down.weight', [16, 64]], [p + 'ff.down.bias', [16]]);
  }
  out.push(['body.norm.weight', [16]], ['body.norm.bias', [16]], ['head.weight', [50, 16]]);
  return out;
}

// nanoGPT model.py, GPT-2 small: the real state_dict names
function nanoKeys({ lmHead = true } = {}) {
  const E = 768;
  const out = [['transformer.wte.weight', [50304, E]], ['transformer.wpe.weight', [1024, E]]];
  for (let i = 0; i < 12; i++) {
    const h = 'transformer.h.' + i + '.';
    out.push([h + 'ln_1.weight', [E]], [h + 'ln_1.bias', [E]], [h + 'attn.c_attn.weight', [2304, E]], [h + 'attn.c_attn.bias', [2304]],
      [h + 'attn.c_proj.weight', [E, E]], [h + 'attn.c_proj.bias', [E]], [h + 'ln_2.weight', [E]], [h + 'ln_2.bias', [E]],
      [h + 'mlp.c_fc.weight', [3072, E]], [h + 'mlp.c_fc.bias', [3072]], [h + 'mlp.c_proj.weight', [E, 3072]], [h + 'mlp.c_proj.bias', [E]]);
  }
  out.push(['transformer.ln_f.weight', [E]], ['transformer.ln_f.bias', [E]]);
  if (lmHead) out.push(['lm_head.weight', [50304, E]]);
  return out;
}

// ---------- dtypes and headers ----------

test('dtype byte sizes and numel', () => {
  const want = { F64: 8, F32: 4, F16: 2, BF16: 2, I64: 8, I32: 4, I16: 2, I8: 1, U8: 1, BOOL: 1, F8_E4M3: 1, F8_E5M2: 1 };
  for (const [k, v] of Object.entries(want)) assert.equal(dtypeBytes(k), v, k);
  assert.equal(dtypeBytes('Q4_K'), null);
  assert.equal(dtypeBytes('constructor'), null);
  assert.equal(numel([]), 1);
  assert.equal(numel([3, 0, 2]), 0);
  assert.equal(numel([2, 3, 4]), 24);
});

test('readHeader returns the tensors and drops __metadata__', () => {
  const f = writeSafetensors(tmp('a.safetensors'), [['w', 'F16', [2, 3]], ['b', 'I64', [3]], ['s', 'F32', []]]);
  assert.deepEqual(readHeader(f), {
    w: { dtype: 'F16', shape: [2, 3], data_offsets: [0, 12] },
    b: { dtype: 'I64', shape: [3], data_offsets: [12, 36] },
    s: { dtype: 'F32', shape: [], data_offsets: [36, 40] },
  });
});

test('an unknown dtype: read, bytes unknown, a note', () => {
  const f = tmp('q.safetensors');
  writeRaw(f, JSON.stringify({ q: { dtype: 'Q4_K', shape: [4], data_offsets: [0, 3] } }), { dataBytes: 3 });
  const w = readWeights([f]);
  assert.deepEqual(w.errors, []);
  assert.equal(w.tensors.q.bytes, null);
  assert.equal(w.tensors.q.numel, 4);
  assert.match(w.notes.join(' '), /dtype Q4_K is not known/);
});

test('hostile headers are refused with a clear message, quickly', () => {
  const refuse = (name, make, re) => {
    const f = tmp(name);
    make(f);
    const [err, ms] = timed(() => { try { readHeader(f); return null; } catch (e) { return e; } });
    assert.ok(err, name + ' was accepted');
    assert.match(err.message, re, name);
    assert.ok(ms < 2000, name + ' took ' + ms + ' ms');
  };
  refuse('size63.safetensors', (f) => writeRaw(f, '{}', { sizeField: 2n ** 63n }), /larger than 100 MiB/);
  refuse('size64.safetensors', (f) => writeRaw(f, '{}', { sizeField: 2n ** 64n - 1n }), /larger than 100 MiB/);
  refuse('cut.safetensors', (f) => writeRaw(f, '{"a":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}', { sizeField: 5000n }), /cut short/);
  refuse('short.safetensors', (f) => fs.writeFileSync(f, Buffer.alloc(5)), /too short/);
  refuse('bomb.safetensors', (f) => writeRaw(f, '['.repeat(5000000) + ']'.repeat(5000000)), /nested deeper than 16/);
  refuse('bomb2.safetensors', (f) => writeRaw(f, '{"a":' + '{"a":'.repeat(100000) + '1' + '}'.repeat(100001)), /nested deeper than 16/);
  refuse('notjson.safetensors', (f) => writeRaw(f, '{"a": '), /not valid JSON/);
  refuse('array.safetensors', (f) => writeRaw(f, '[1,2]'), /not a JSON object/);
  refuse('offs.safetensors', (f) => writeRaw(f, '{"a":{"dtype":"F32","shape":[1],"data_offsets":["0","4"]}}', { dataBytes: 4 }), /data_offsets is not two integers/);
  refuse('offs2.safetensors', (f) => writeRaw(f, '{"a":{"dtype":"F32","shape":[1],"data_offsets":[4,0]}}', { dataBytes: 4 }), /a <= b/);
  refuse('offs3.safetensors', (f) => writeRaw(f, '{"a":{"dtype":"F32","shape":[1],"data_offsets":[0,4,8]}}', { dataBytes: 8 }), /data_offsets/);
  refuse('past.safetensors', (f) => writeRaw(f, '{"a":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}'), /past the end/);
  refuse('neg.safetensors', (f) => writeRaw(f, '{"a":{"dtype":"F32","shape":[-1],"data_offsets":[0,4]}}', { dataBytes: 4 }), /shape is not a list of integers >= 0/);
  refuse('frac.safetensors', (f) => writeRaw(f, '{"a":{"dtype":"F32","shape":[1.5],"data_offsets":[0,4]}}', { dataBytes: 4 }), /shape/);
  refuse('strshape.safetensors', (f) => writeRaw(f, '{"a":{"dtype":"F32","shape":"[1]","data_offsets":[0,4]}}', { dataBytes: 4 }), /shape/);
  refuse('nodtype.safetensors', (f) => writeRaw(f, '{"a":{"dtype":4,"shape":[1],"data_offsets":[0,4]}}', { dataBytes: 4 }), /dtype is not a string/);
  refuse('huge.safetensors', (f) => writeRaw(f, '{"a":{"dtype":"F32","shape":[1000000000,1000000000],"data_offsets":[0,4]}}', { dataBytes: 4 }), /too large|need/);
  refuse('lie.safetensors', (f) => writeRaw(f, '{"a":{"dtype":"F32","shape":[100],"data_offsets":[0,4]}}', { dataBytes: 4 }), /need 400 bytes, data_offsets give 4/);
  refuse('many.safetensors', (f) => {
    const parts = [];
    for (let i = 0; i < 200000; i++) parts.push('"t' + i + '":{"dtype":"U8","shape":[0],"data_offsets":[0,0]}');
    writeRaw(f, '{' + parts.join(',') + '}');
  }, new RegExp('more than ' + MAX_TENSORS + ' tensors'));
});

test('a header with exactly 100,000 tensors is read', () => {
  const parts = [];
  for (let i = 0; i < 100000; i++) parts.push('"t' + i + '":{"dtype":"U8","shape":[0],"data_offsets":[0,0]}');
  const f = writeRaw(tmp('max.safetensors'), '{' + parts.join(',') + '}');
  assert.equal(Object.keys(readHeader(f)).length, 100000);
});

// ---------- files, folders, shards ----------

test('a sharded checkpoint: the index names shards in its own folder', () => {
  const dir = tmpDir();
  writeSafetensors(path.join(dir, 'model-00001-of-00002.safetensors'), [['a.weight', 'F32', [2, 2]]]);
  writeSafetensors(path.join(dir, 'model-00002-of-00002.safetensors'), [['b.weight', 'BF16', [3]]]);
  fs.writeFileSync(path.join(dir, 'model.safetensors.index.json'), JSON.stringify({ metadata: { total_size: 22 }, weight_map: { 'a.weight': 'model-00001-of-00002.safetensors', 'b.weight': 'model-00002-of-00002.safetensors' } }));
  for (const w of [readWeights([dir]), readWeights([path.join(dir, 'model.safetensors.index.json')])]) {
    assert.deepEqual(w.errors, []);
    assert.deepEqual(w.files, ['model.safetensors.index.json', 'model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors']);
    assert.deepEqual(Object.keys(w.tensors).sort(), ['a.weight', 'b.weight']);
    assert.equal(w.tensors['b.weight'].bytes, 6);
    assert.equal(w.tensors['b.weight'].file, 'model-00002-of-00002.safetensors');
  }
});

test('an index that points outside its folder is refused, and the file there is not read', () => {
  const root = tmpDir();
  const dir = path.join(root, 'ckpt');
  fs.mkdirSync(dir);
  writeSafetensors(path.join(root, 'evil.safetensors'), [['x', 'F32', [1]]]);
  for (const bad of ['../evil.safetensors', 'sub/x.safetensors', '..', '/etc/passwd', 'a\\b.safetensors']) {
    fs.writeFileSync(path.join(dir, 'model.safetensors.index.json'), JSON.stringify({ weight_map: { x: bad } }));
    const w = readWeights([dir]);
    assert.match(w.errors.join(' '), /outside its folder/, bad);
    assert.deepEqual(Object.keys(w.tensors), [], bad);
  }
  fs.writeFileSync(path.join(dir, 'model.safetensors.index.json'), JSON.stringify({ nope: 1 }));
  assert.match(readWeights([dir]).errors.join(' '), /no weight_map/);
});

test('a folder is read without going into subfolders; pickle files are skipped, never opened', () => {
  const dir = tmpDir();
  writeSafetensors(path.join(dir, 'a.safetensors'), [['a', 'F32', [1]]]);
  fs.mkdirSync(path.join(dir, 'sub'));
  writeSafetensors(path.join(dir, 'sub', 'b.safetensors'), [['b', 'F32', [1]]]);
  fs.writeFileSync(path.join(dir, 'model.pt'), 'not read');
  fs.writeFileSync(path.join(dir, 'pytorch_model.bin'), 'not read');
  const w = readWeights([dir, path.join(dir, 'other.ckpt')]);
  assert.deepEqual(Object.keys(w.tensors), ['a']);
  assert.deepEqual(w.skipped.map((s) => path.basename(s)).sort(), ['model.pt', 'other.ckpt', 'pytorch_model.bin']);
  assert.match(readWeights([path.join(dir, 'missing.safetensors')]).errors[0], /not found/);
});

// ---------- expected keys of torch layers (shapes worked by hand) ----------

test('layer keys: Linear, Conv, norms with buffers, Embedding, MultiheadAttention, PReLU', () => {
  const r = (v) => ({ v });
  const keys = (name, pos, kw) => layerKeys(name, pos.map(r), Object.fromEntries(Object.entries(kw || {}).map(([k, v]) => [k, r(v)])));
  assert.deepEqual(keys('Linear', [10, 5]), [{ key: 'weight', shape: [5, 10] }, { key: 'bias', shape: [5] }]);
  assert.deepEqual(keys('Linear', [10, 5], { bias: false }), [{ key: 'weight', shape: [5, 10] }]);
  assert.deepEqual(keys('Conv2d', [4, 8, 3], { groups: 2 }), [{ key: 'weight', shape: [8, 2, 3, 3] }, { key: 'bias', shape: [8] }]);
  assert.deepEqual(keys('Conv1d', [3, 6, [5]], { bias: false }), [{ key: 'weight', shape: [6, 3, 5] }]);
  assert.deepEqual(keys('Conv3d', [2, 4, [1, 2, 3]]), [{ key: 'weight', shape: [4, 2, 1, 2, 3] }, { key: 'bias', shape: [4] }]);
  assert.deepEqual(keys('LayerNorm', [[4, 8]]), [{ key: 'weight', shape: [4, 8] }, { key: 'bias', shape: [4, 8] }]);
  assert.deepEqual(keys('LayerNorm', [8], { bias: false }), [{ key: 'weight', shape: [8] }]);
  assert.deepEqual(keys('LayerNorm', [8], { elementwise_affine: false }), []);
  assert.deepEqual(keys('RMSNorm', [8]), [{ key: 'weight', shape: [8] }]);
  assert.deepEqual(keys('GroupNorm', [2, 6]), [{ key: 'weight', shape: [6] }, { key: 'bias', shape: [6] }]);
  assert.deepEqual(keys('BatchNorm2d', [3]), [{ key: 'weight', shape: [3] }, { key: 'bias', shape: [3] },
    { key: 'running_mean', shape: [3], buffer: true }, { key: 'running_var', shape: [3], buffer: true }, { key: 'num_batches_tracked', shape: [], buffer: true }]);
  assert.deepEqual(keys('Embedding', [100, 16]), [{ key: 'weight', shape: [100, 16] }]);
  assert.deepEqual(keys('MultiheadAttention', [8, 2]), [{ key: 'in_proj_weight', shape: [24, 8] }, { key: 'in_proj_bias', shape: [24] },
    { key: 'out_proj.weight', shape: [8, 8] }, { key: 'out_proj.bias', shape: [8] }]);
  assert.deepEqual(keys('MultiheadAttention', [8, 2], { kdim: 4, vdim: 6, bias: false }), [{ key: 'q_proj_weight', shape: [8, 8] },
    { key: 'k_proj_weight', shape: [8, 4] }, { key: 'v_proj_weight', shape: [8, 6] }, { key: 'out_proj.weight', shape: [8, 8] }]);
  assert.deepEqual(keys('PReLU', []), [{ key: 'weight', shape: [1] }]);
  assert.deepEqual(keys('PReLU', [12]), [{ key: 'weight', shape: [12] }]);
  assert.deepEqual(keys('GELU', []), []);
  assert.throws(() => keys('LSTM', [1, 1]), /not in the layer table/);
});

test('crossCheck on a hand-built tree: a container index is a path segment, a direct nn.Parameter sits at its module', () => {
  const r = (v) => ({ v });
  const tree = { path: '', kind: 'repo', cls: 'M', params: [{ name: 'cls_token', shape: [1, 1, 4] }], children: [
    { name: 'layers', path: 'layers', kind: 'torch', cls: 'ModuleList', container: 'list', pos: [], kw: {}, children: [
      { name: '0', path: 'layers.0', kind: 'torch', cls: 'Linear', pos: [r(4), r(4)], kw: {}, children: [] },
      { name: '1', path: 'layers.1', kind: 'torch', cls: 'BatchNorm1d', pos: [r(4)], kw: {}, children: [] },
    ] },
    { name: 'blocks', path: 'blocks', kind: 'torch', cls: 'ModuleDict', container: 'dict', pos: [], kw: {}, children: [
      { name: 'enc', path: 'blocks.enc', kind: 'torch', cls: 'Linear', pos: [r(4), r(2)], kw: { bias: r(false) }, children: [] },
    ] },
    { name: 'ext', path: 'ext', kind: 'external', cls: 'Thing', why: 'not in the repo', children: [] },
  ] };
  const exp = expectKeys(tree);
  const file = writeSafetensors(tmp('m.safetensors'), f32([['cls_token', [1, 1, 4]], ['layers.0.weight', [4, 4]], ['layers.0.bias', [4]],
    ['layers.1.weight', [4]], ['layers.1.bias', [4]], ['layers.1.running_mean', [4]], ['layers.1.running_var', [4]],
    ['blocks.enc.weight', [2, 4]], ['ext.w', [3, 3]], ['stray', [2]]]));
  const s = crossCheck(tree, readWeights([file]), { expected: exp });
  assert.equal(tree.check.ok, true);
  assert.equal(tree.check.partial, true, 'ext has no expectation');
  assert.equal(tree.check.expectedKeys, 6, 'cls_token, 2 Linear, 2 BatchNorm, 1 Linear without bias');
  assert.equal(tree.children[2].check, undefined, 'no check on a module the scan does not know');
  assert.equal(tree.children[2].weights.params, 9, 'its weights are still counted');
  assert.equal(tree.children[0].children[1].weights.params, 8, 'running statistics are buffers, not parameters');
  assert.equal(tree.children[0].children[1].check.expectedKeys, 2);
  assert.deepEqual(s.unmatchedSample, ['ext.w', 'stray']);
  assert.equal(s.unmatchedKeys, 2);
  assert.equal(s.tensors, 10);
});

// ---------- end to end through scan.mjs ----------

test('mini-model: a file with every key gives ok; a wrong shape names the key and both shapes; a missing key is named', opts, () => {
  const keys = miniKeys();
  assert.equal(keys.length, 68);
  const good = writeSafetensors(tmp('mini.safetensors'), f32(keys));
  const s = runScan(fixture('mini-model'), ['--weights', good]);
  assert.equal(s.status, 0, s.stderr);
  const root = s.json.root;
  assert.equal(root.check.ok, true);
  assert.equal(root.check.expectedKeys, 68);
  assert.equal(root.check.foundKeys, 68);
  assert.equal(root.check.partial, true, 'drop and mystery are not known');
  assert.equal(root.check.file, 'mini.safetensors');
  assert.equal(root.check.codeParams, 18740);
  assert.equal(root.check.weightParams, 18740);
  assert.equal(root.params.v, 18740, 'node.params stays the code count');
  assert.equal(root.params.src, 'code');
  assert.equal(at(root, 'drop').check, undefined);
  assert.equal(at(root, 'mystery').check, undefined);
  assert.equal(at(root, 'blocks.1.attn').check.ok, true);
  assert.equal(at(root, 'blocks.1.attn').weights.params, 16 * 48 + 48 + 16 * 16 + 16);
  assert.deepEqual(at(root, 'blocks.1.attn.qkv').weights.dtypes, { F32: 16 * 48 + 48 });
  assert.equal(s.json.weights.tensors, 68);
  assert.equal(s.json.weights.totalParams, 18740);
  assert.equal(s.json.weights.unmatchedKeys, 0);
  assert.match(s.stdout, /WEIGHTS ✓ \d+ modules match/);

  const wrong = keys.map(([k, sh]) => [k, k === 'mixed.1.mlp.fc2.weight' ? [16, 32] : sh]).filter(([k]) => k !== 'pos');
  wrong.push(['mixed.1.mlp.fc2.extra', [5]]);
  const bad = runScan(fixture('mini-model'), ['--weights', writeSafetensors(tmp('bad.safetensors'), f32(wrong))]);
  const br = bad.json.root;
  assert.equal(br.check.ok, false);
  assert.deepEqual(br.check.missing, ['pos']);
  assert.deepEqual(br.check.mismatched, [{ key: 'mixed.1.mlp.fc2.weight', expected: [16, 64], found: [16, 32] }]);
  assert.equal(at(br, 'mixed.1.mlp').check.ok, false);
  assert.equal(at(br, 'mixed.0').check.ok, true, 'a sibling that matches stays ok');
  assert.equal(at(br, 'blocks').check.ok, true);
  assert.deepEqual(bad.json.weights.unmatchedSample, ['mixed.1.mlp.fc2.extra']);
  assert.match(bad.stdout, /WEIGHTS ✗ 2 modules differ/);
  assert.match(bad.stdout, /mixed\.1\.mlp\.fc2\.weight: expected \[16,64\] found \[16,32\]/);
  assert.match(bad.stdout, /pos: missing/);
});

test('mini-model: a module shared under two paths may be stored under both', opts, () => {
  const keys = [...miniKeys(), ['tied.weight', [16, 16]], ['tied.bias', [16]]];
  const s = runScan(fixture('mini-model'), ['--weights', writeSafetensors(tmp('both.safetensors'), f32(keys)), '--json']).json;
  assert.equal(s.root.check.ok, true);
  assert.equal(s.weights.unmatchedKeys, 0);
  assert.equal(s.root.weights.params, 18740, 'the copy is counted once');
  assert.equal(s.weights.totalParams, 18740 + 16 * 16 + 16, 'the file total counts every tensor');
});

test('TinyGPT with a config: a tied weight may be stored once or twice', opts, () => {
  const cfg = path.join(fixture('gpt-mini'), 'config.yaml');
  for (const tok of [false, true]) {
    const s = runScan(fixture('gpt-mini'), ['--config', cfg, '--weights', writeSafetensors(tmp('t.safetensors'), f32(tinyKeys({ tok })))]);
    assert.equal(s.status, 0, s.stderr);
    assert.equal(s.json.root.check.ok, true, 'tok stored: ' + tok);
    assert.equal(s.json.root.check.partial, undefined);
    assert.equal(s.json.root.weights.params, 7520);
    assert.equal(s.json.root.params.v, 7520);
    assert.equal(s.json.weights.unmatchedKeys, 0);
  }
  const noHead = tinyKeys({ tok: true }).filter(([k]) => k !== 'head.weight');
  const s = runScan(fixture('gpt-mini'), ['--config', cfg, '--weights', writeSafetensors(tmp('t2.safetensors'), f32(noHead)), '--json']).json;
  assert.equal(s.root.check.ok, true, 'the head weight lives under its twin');
  const none = tinyKeys().filter(([k]) => k !== 'head.weight');
  const s2 = runScan(fixture('gpt-mini'), ['--config', cfg, '--weights', writeSafetensors(tmp('t3.safetensors'), f32(none)), '--json']).json;
  assert.equal(s2.root.check.ok, false);
  assert.deepEqual(s2.root.check.missing, ['body.tok.weight', 'head.weight'], 'neither twin is stored: both are missing');
});

test('scan.mjs: a pickle checkpoint is skipped with a message; a broken file is reported, the scan goes on', opts, () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'model.pt'), 'x');
  const s = runScan(fixture('mini-model'), ['--weights', path.join(dir, 'model.pt')]);
  assert.equal(s.status, 0);
  assert.match(s.stdout, /pickle checkpoints are not read in the MVP/);
  assert.match(s.stdout, /WEIGHTS ✗ nothing checked/);
  const j = runScan(fixture('mini-model'), ['--weights', path.join(dir, 'model.pt'), '--json']);
  assert.match(j.stderr, /pickle checkpoints are not read in the MVP/);
  JSON.parse(j.stdout);
  const broken = writeRaw(path.join(dir, 'x.safetensors'), '{}', { sizeField: 2n ** 63n });
  const b = runScan(fixture('mini-model'), ['--weights', broken]);
  assert.equal(b.status, 0);
  assert.match(b.stdout, /✗ x\.safetensors: header size \d+ is larger than 100 MiB/);
  assert.equal(b.json.root.check, undefined);
});

test('nanoGPT GPT-2 small: config.yaml and a header-only weights file give the check mark; one flipped shape is named', nanoOpts, () => {
  const dir = tmpDir();
  const cfg = path.join(dir, 'config.yaml');
  fs.writeFileSync(cfg, 'block_size: 1024\nvocab_size: 50304\nn_layer: 12\nn_head: 12\nn_embd: 768\ndropout: 0.0\nbias: true\n');
  const keys = nanoKeys({ lmHead: false });
  const good = writeSafetensors(path.join(dir, 'model.safetensors'), f32(keys));
  const s = runScan(NANOGPT, ['--config', cfg, '--weights', good]);
  assert.equal(s.status, 0, s.stderr);
  assert.equal(s.json.root.params.v, 124475904);
  assert.equal(s.json.root.params.src, 'config');
  assert.equal(s.json.root.check.ok, true);
  assert.equal(s.json.root.check.weightParams, 124475904);
  assert.equal(s.json.weights.unmatchedKeys, 0);
  assert.match(s.stdout, /WEIGHTS ✓ 76 modules match/);
  const flipped = keys.map(([k, sh]) => [k, k === 'transformer.h.7.mlp.c_proj.weight' ? [3072, 768] : sh]);
  const b = runScan(NANOGPT, ['--config', cfg, '--weights', writeSafetensors(path.join(dir, 'flip.safetensors'), f32(flipped))]);
  assert.equal(b.json.root.check.ok, false);
  assert.match(b.stdout, /WEIGHTS ✗ 1 module differs/);
  assert.match(b.stdout, /transformer\.h\.7\.mlp\.c_proj\.weight: expected \[768,3072\] found \[3072,768\]/);
});
