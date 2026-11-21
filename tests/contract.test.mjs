// The input and output contract of the model (plan claim 3, F06): pyscan.py reads forward() as text, lib/contract.mjs
// turns it into graph.contract, descriptions/*.json may add estimates. Facts from the code are exact; a shape is
// shown only from the docstring (doc) or an estimate, never guessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { hasPython } from './helpers.mjs';
import { contractFixture, mapOf, contractNotes, AB_UPT, hasAbUpt } from './helpers-contract.mjs';
import { checkShape, docShape, buildDims, buildContract, mergeEstimates, DIM_NAMES, symbolOf } from '../skills/modelmap/scripts/lib/contract.mjs';

const py = { skip: hasPython ? false : 'python3 (3.9 or newer) is not available' };
const ab = { skip: !hasPython ? 'python3 (3.9 or newer) is not available' : hasAbUpt ? false : 'the AB-UPT repo is not on this machine (' + AB_UPT + ')' };
const byName = (list) => Object.fromEntries(list.map((x) => [x.name, x]));
const dimOf = (ct, sym) => ct.dims.find((d) => d.sym === sym);

// ---------- lib/contract.mjs on its own ----------
test('checkShape: a bracketed list of dims symbols, B, N (with a subscript), integers and "..."; anything else is an error', () => {
  const syms = ['D', 'H', 'd_h'];
  for (const ok of ['[B, N, D]', '[B, N_s, 3]', '[N_g, 3]', '[..., d_h]', '[B,N,D]', '[B, [N, 3]]', '[B, H, N, d_h]']) assert.ok(checkShape(ok, syms).v, ok);
  assert.equal(checkShape('  [B,   N, D] ', syms).v, '[B, N, D]', 'spaces are normalised');
  for (const [bad, why] of [['[B, X]', /"X"/], ['[B, N, V]', /"V"/], ['B, N', /bracketed/], ['[B, N', /bracketed/], ['[[B, N]', /brackets of the shape do not match/], ['[B], N]', /brackets of the shape do not match/], ['[B,, N]', /empty item/], ['[B; N]', /only symbols/],
    ['[' + 'B, '.repeat(14) + 'N]', /at most 40/], ['[D_out]', /"D_out"/], ['', /empty/], [42, /string/], ['[B, N] <script>', /only symbols/]]) {
    assert.match(String(checkShape(bad, syms).error), why, JSON.stringify(bad));
  }
});

test('docShape: docstring words map to symbols; an unknown word leaves the shape unknown with the reason', () => {
  assert.deepEqual(docShape(['batch_size', 'seq_len', 'dim']), { v: '[B, N, D]', src: 'doc' });
  assert.deepEqual(docShape(['B', 'num_tokens', 'num_heads', 'head_dim']), { v: '[B, N, H, d_h]', src: 'doc' });
  assert.deepEqual(docShape(['batch', '3']), { v: '[B, 3]', src: 'doc' });
  const u = docShape(['batch', 'foo']);
  assert.equal(u.v, null);
  assert.match(u.why, /foo/);
  assert.deepEqual(docShape(null), { v: null, src: 'doc', why: 'no shape in the docstring' });
  assert.equal(symbolOf('n_embd'), 'D');
  assert.ok(DIM_NAMES.includes('dim_head') && DIM_NAMES.includes('image_size'));
});

test('buildDims: first name wins, others listed; d_h = D // H only when the code divides the two (or assigns head_dim) and no head_dim value exists', () => {
  const args = [{ name: 'dim', v: 64, at: 'm.py:3' }, { name: 'num_heads', v: 4, at: 'm.py:3', src: 'config' }];
  const attrs = [{ name: 'hidden_dim', v: 64, cls: 'Enc', at: 'e.py:9' }, { name: 'embed_dim', v: 128, cls: 'Mlp', at: 'f.py:2' }];
  // division present: d_h derived, tagged config because H came from a config
  let d = buildDims({ dims: { args, attrs, floordiv: [{ a: 'dim', b: 'num_heads', at: 'm.py:12' }], assigned: [] } });
  assert.deepEqual(d.map((x) => [x.sym, x.value]), [['D', 64], ['H', 4], ['d_h', 16]]);
  const D = d.find((x) => x.sym === 'D');
  assert.equal(D.name, 'dim');
  assert.match(D.expr, /also: hidden_dim/);
  assert.match(D.why, /embed_dim = 128 in Mlp differs/);
  const dh = d.find((x) => x.sym === 'd_h');
  assert.deepEqual([dh.expr, dh.src, dh.at, dh.name], ['dim // num_heads', 'config', 'm.py:12', 'dim // num_heads']);
  // division absent: no d_h, never computed
  d = buildDims({ dims: { args, attrs: [], floordiv: [], assigned: [] } });
  assert.deepEqual(d.map((x) => x.sym), ['D', 'H']);
  // a division of other names does not count
  d = buildDims({ dims: { args, attrs: [], floordiv: [{ a: 'dim', b: 'ndim', at: 'x.py:1' }], assigned: [] } });
  assert.equal(d.some((x) => x.sym === 'd_h'), false);
  // an assignment to an attribute head_dim (value not known) shows the code splits into heads
  d = buildDims({ dims: { args, attrs: [], floordiv: [], assigned: [{ name: 'head_dim', at: 'a.py:7' }] } });
  assert.deepEqual(d.filter((x) => x.sym === 'd_h').map((x) => [x.value, x.at, x.name]), [[16, 'a.py:7', 'head_dim']]);
  // a head_dim value wins over the division
  d = buildDims({ dims: { args, attrs: [{ name: 'head_dim', v: 32, cls: 'Attn', at: 'a.py:7', expr: 'dim // 2' }], floordiv: [{ a: 'dim', b: 'num_heads', at: 'm.py:12' }], assigned: [] } });
  assert.deepEqual(d.filter((x) => x.sym === 'd_h').map((x) => [x.value, x.expr]), [[32, 'dim // 2']]);
  // values that are not numbers make no entry
  assert.deepEqual(buildDims({ dims: { args: [{ name: 'dim', v: { unknown: 'required argument' } }], attrs: [] } }), []);
  assert.deepEqual(buildDims({}), []);
});

test('mergeEstimates: files merge field by field, a later file wins; only strings are kept', () => {
  let m = mergeEstimates(null, { inputs: { x: { shape: '[B]', d: 'first' } }, output: { d: 'o1', keys: { a: { shape: '[B]' } } } });
  m = mergeEstimates(m, { inputs: { x: { shape: '[B, N]', extra: 1 }, y: { d: 5 } }, output: { keys: { a: { d: 'key a' } } } });
  assert.deepEqual({ ...m.inputs.x }, { shape: '[B, N]', d: 'first' });
  assert.deepEqual({ ...m.inputs.y }, {});
  assert.deepEqual([m.output.d, { ...m.output.keys.a }], ['o1', { shape: '[B]', d: 'key a' }]);
  assert.equal(mergeEstimates(m, 'not an object'), m);
});

test('buildContract: null without forward; never throws on odd input', () => {
  assert.equal(buildContract({ root: {} }), null);
  assert.equal(buildContract(null), null);
  const ct = buildContract({ forward: { file: 'm.py', line: 3, owner: 'M', params: [{ name: 'x' }, 'junk'], output: { keys: ['a', 7] } } }, { contract: { inputs: 'no' } });
  assert.deepEqual(ct.inputs.map((x) => [x.name, x.optional, x.shape.v]), [['x', false, null]]);
  assert.deepEqual(ct.output.keys, [{ name: 'a' }]);
});

// ---------- the scan of small fixtures ----------
test('a Google style docstring with shapes, an optional input and a dict built with outputs[...]: exact names, types, defaults, doc shapes, keys in order', py, () => {
  const { graph, scan } = mapOf(contractFixture('dict-out'));
  const ct = graph.contract;
  assert.deepEqual(ct.forward, { file: 'model.py', line: 22, owner: 'Net' });
  assert.equal(graph.meta.counts.contractInputs, 5);
  // optional: has a default; nullable: the type allows None
  assert.deepEqual(ct.inputs.map((x) => [x.name, x.type, x.default, x.optional, x.nullable]), [
    ['tokens', 'torch.Tensor', null, false, false],
    ['positions', 'torch.Tensor | None', null, false, true], // no default: required, though it accepts None
    ['mask', 'Optional[torch.Tensor]', 'None', true, true],
    ['scale', 'float', '1.0', true, false],
    ['cache', "'torch.Tensor | None'", 'None', true, true],
  ]);
  const I = byName(ct.inputs);
  assert.deepEqual(I.tokens.shape, { v: '[B, N]', src: 'doc' });
  assert.deepEqual(I.positions.shape, { v: '[B, N, 3]', src: 'doc' });
  assert.equal(I.positions.doc, 'coordinates, [batch, tokens, 3] one per token.', 'continuation lines join the entry');
  assert.deepEqual(I.mask.shape, { v: '[B, N]', src: 'doc' });
  assert.deepEqual(I.scale.shape, { v: null, src: 'doc', why: 'no shape in the docstring' }, '"(default 1.0)" is not a shape');
  // the returned dict: keys in the order they first appear; a dict that is not returned and a nested function do not count
  assert.deepEqual(ct.output.keys.map((k) => k.name), ['hidden', 'logits', 'extra']);
  assert.deepEqual(ct.output.keys.map((k) => k.shape?.v ?? null), ['[B, N, D]', '[B, N, V]', null], 'key shapes from the Returns text');
  assert.equal(ct.output.type, 'dict[str, torch.Tensor]');
  assert.equal(ct.output.names, undefined);
  // dims: from the root's arguments, d_h from the attribute of Attention (not computed)
  assert.deepEqual(ct.dims.map((d) => [d.sym, d.name, d.value, d.src]), [['D', 'dim', 32, 'code'], ['H', 'num_heads', 4, 'code'], ['d_h', 'head_dim', 8, 'code'], ['V', 'vocab_size', 100, 'code']]);
  assert.deepEqual([dimOf(ct, 'd_h').at, dimOf(ct, 'd_h').expr], ['model.py:11', 'dim // num_heads']);
  assert.equal(dimOf(ct, 'D').at, 'model.py:16');
  // scan.json only gains fields: the old forward fields keep their meaning
  assert.deepEqual(Object.keys(scan.forward.params[0]).slice(0, 3), ['name', 'annotation', 'default']);
  assert.equal(scan.forward.params[4].kwonly, true);
});

test('a NumPy style docstring and a tuple return: output.names, no keys; d_h derived because the code divides hidden_size by n_heads', py, () => {
  const { graph } = mapOf(contractFixture('tuple-out'));
  const ct = graph.contract;
  assert.deepEqual(ct.inputs.map((x) => [x.name, x.type, x.default, x.optional, x.nullable, x.shape.v]), [['idx', null, null, false, false, '[B, T]'], ['targets', null, 'None', true, false, '[B, T]']]);
  assert.deepEqual(ct.output.names, ['logits', 'loss']);
  assert.deepEqual(ct.output.keys, []);
  assert.equal(ct.output.type, null);
  assert.deepEqual(ct.dims.map((d) => [d.sym, d.name, d.value]), [['D', 'hidden_size', 48], ['H', 'n_heads', 6], ['d_h', 'hidden_size // n_heads', 8], ['L', 'n_layer', 2]]);
  assert.deepEqual([dimOf(ct, 'd_h').expr, dimOf(ct, 'd_h').at], ['hidden_size // n_heads', 'model.py:8']);
});

test('no division of dim by heads in the code: no d_h; dict literals and dict(...) returns give the keys', py, () => {
  const { graph } = mapOf(contractFixture('no-div'));
  const ct = graph.contract;
  assert.deepEqual(ct.dims.map((d) => [d.sym, d.name, d.value]), [['D', 'dim', 16], ['H', 'heads', 2]]);
  assert.deepEqual(ct.output.keys.map((k) => k.name), ['out', 'aux', 'extra']);
  assert.deepEqual(ct.inputs.map((x) => [x.name, x.optional, x.shape.v]), [['x', false, null]]);
});

test('optional means "has a default", nothing else; nullable means "the type allows None": a required X | None is not optional', py, () => {
  const { graph, scanStdout } = mapOf(contractFixture('nullable'));
  assert.deepEqual(graph.contract.inputs.map((x) => [x.name, x.type, x.default, x.optional, x.nullable]), [
    ['required_or_none', 'torch.Tensor | None', null, false, true],
    ['none_first', 'None | torch.Tensor', null, false, true],
    ['five', null, '5', true, false],
    ['both', 'Optional[int]', 'None', true, true],
    ['kw_union', 'Union[int, None]', null, false, true],
    ['kw_plain', 'int', '3', true, false],
  ]);
  // the summary marks only what a caller may leave out
  assert.match(scanStdout, /^INPUTS {2}6 {2}\(required_or_none, none_first, five\?, both\?, kw_union, kw_plain\?\)/m);
  // a scan written before nullable existed: optional is recomputed from the default, nullable from the type text
  const old = buildContract({ forward: { file: 'm.py', line: 1, owner: 'M', params: [{ name: 'a', annotation: 'torch.Tensor | None', default: null, optional: true }, { name: 'b', annotation: null, default: '5', optional: false }] } });
  assert.deepEqual(old.inputs.map((x) => [x.name, x.optional, x.nullable]), [['a', false, true], ['b', true, false]]);
});

// ---------- estimates from descriptions/*.json ----------
test('estimates: fill an unknown shape (src estimate), never override a doc shape, bad shapes and unknown names are dropped with a warning, a later file wins', py, () => {
  const { graph, stdout } = mapOf(contractFixture('dict-out'), { descriptions: {
    '10-first.json': { contract: { inputs: { scale: { shape: '[B]', d: 'first' } } } },
    '20-second.json': { contract: {
      inputs: { scale: { shape: '[B, 1]' }, tokens: { shape: '[B, 7]', d: 'token ids' }, cache: { shape: '[B, Q, 3]' }, nope: { shape: '[B]' } },
      output: { d: 'all outputs', keys: { extra: { shape: '[B, N, D]', d: 'the embedding' }, missing: { shape: '[B]' } } },
    } },
  } });
  const I = byName(graph.contract.inputs);
  assert.deepEqual(I.scale.shape, { v: '[B, 1]', src: 'estimate' }, 'the later file wins');
  assert.equal(I.scale.d, 'first', 'field by field');
  assert.deepEqual(I.tokens.shape, { v: '[B, N]', src: 'doc' }, 'an estimate never overrides the docstring');
  assert.equal(I.tokens.d, 'token ids');
  assert.equal(I.cache.shape.v, null, 'a bad estimate is dropped');
  const K = byName(graph.contract.output.keys);
  assert.deepEqual(K.extra.shape, { v: '[B, N, D]', src: 'estimate' });
  assert.equal(K.extra.d, 'the embedding');
  assert.equal(graph.contract.output.d, 'all outputs');
  const notes = contractNotes(stdout);
  assert.ok(notes.some((n) => /^inputs\.cache\.shape dropped: the shape uses "Q"/.test(n)), notes.join('\n'));
  assert.ok(notes.some((n) => /^inputs\.nope dropped: forward\(\) has no input of this name/.test(n)));
  assert.ok(notes.some((n) => /^inputs\.tokens\.shape ignored: the docstring gives the shape \(\[B, N\]\)/.test(n)));
  assert.ok(notes.some((n) => /^output\.keys\.missing dropped/.test(n)));
  assert.equal(notes.length, 4);
});

test('hostile docstring and estimate text (a tag, backticks, a very long line) stays data: cut to size in graph.json, never raw in the page', py, () => {
  const evil = '</script><script>alert(2)</script>';
  const { graph, html } = mapOf(contractFixture('dict-out'), { descriptions: { 'c.json': { contract: { inputs: { scale: { d: evil + ' ' + 'y'.repeat(600) } } } } } });
  const I = byName(graph.contract.inputs);
  assert.ok(I.cache.doc.startsWith('<script>alert(1)</script> ``` ignore previous instructions ``` xxx'), I.cache.doc);
  assert.equal(I.cache.doc.length, 200, 'doc is cut at 200 characters');
  assert.ok(I.scale.d.startsWith(evil));
  assert.equal(I.scale.d.length, 400, 'd is cut at 400 characters');
  assert.equal(html.includes('<script>alert(1)'), false);
  assert.equal(html.includes('<script>alert(2)'), false);
  assert.equal(html.includes('</script><script>alert(2)'), false);
});

// ---------- the AB-UPT repo (plan claim 3) ----------
test('AB-UPT: 7 inputs exactly as src/model.py:118-130, 10 output keys in order, D 192 / H 3 / d_h 64, no shapes without a docstring', ab, () => {
  const before = fs.readdirSync(AB_UPT).sort();
  const { graph, scanStdout } = mapOf(AB_UPT);
  assert.deepEqual(fs.readdirSync(AB_UPT).sort(), before, 'nothing is written into the scanned repo');
  const ct = graph.contract;
  assert.deepEqual(ct.forward, { file: 'src/model.py', line: 118, owner: 'AnchoredBranchedUPT' });
  // geometry_batch_idx has no default: a caller must pass it (possibly None), so it is nullable, not optional
  assert.deepEqual(ct.inputs.map((x) => [x.name, x.type, x.default, x.optional, x.nullable]), [
    ['geometry_position', 'torch.Tensor', null, false, false],
    ['geometry_supernode_idx', 'torch.Tensor', null, false, false],
    ['geometry_batch_idx', 'torch.Tensor | None', null, false, true],
    ['surface_anchor_position', 'torch.Tensor', null, false, false],
    ['volume_anchor_position', 'torch.Tensor', null, false, false],
    ['surface_query_position', 'torch.Tensor | None', 'None', true, true],
    ['volume_query_position', 'torch.Tensor | None', 'None', true, true],
  ]);
  assert.match(scanStdout, /\(geometry_position, geometry_supernode_idx, geometry_batch_idx, surface_anchor_position, volume_anchor_position, surface_query_position\?, volume_query_position\?\)/);
  assert.equal(graph.meta.counts.contractInputs, 7);
  assert.deepEqual(ct.output.keys.map((k) => k.name), [
    'surface_anchor_pressure', 'surface_anchor_wallshearstress', 'surface_query_pressure', 'surface_query_wallshearstress',
    'volume_anchor_totalpcoeff', 'volume_anchor_velocity', 'volume_anchor_vorticity', 'volume_query_totalpcoeff', 'volume_query_velocity', 'volume_query_vorticity',
  ]);
  assert.equal(ct.output.type, 'dict[str, torch.Tensor]');
  assert.deepEqual(ct.dims.map((d) => [d.sym, d.name, d.value, d.src]), [['D', 'dim', 192, 'code'], ['H', 'num_heads', 3, 'code'], ['d_h', 'head_dim', 64, 'code']]);
  assert.deepEqual([dimOf(ct, 'd_h').at, dimOf(ct, 'd_h').expr], ['src/modules/attention/dot_product_attention.py:22', 'dim // num_heads']);
  assert.ok([...ct.inputs, ...ct.output.keys].every((x) => !x.shape || x.shape.v === null), 'the repo has no shape docstring for forward');
  assert.match(scanStdout, /^INPUTS {2}7 /m);
  assert.match(scanStdout, /^DIMS {4}D=192 \(dim\) {2}H=3 \(num_heads\) {2}d_h=64 \(head_dim\)$/m);
});

test('AB-UPT with a hand-written descriptions file: the estimated shapes appear with src estimate', ab, () => {
  const { graph } = mapOf(AB_UPT, { descriptions: { 'contract.json': { contract: {
    inputs: { geometry_position: { shape: '[N_g, 3]' }, geometry_supernode_idx: { shape: '[N_s]' }, surface_anchor_position: { shape: '[B, N, 3]' } },
    output: { keys: { surface_anchor_pressure: { shape: '[N_a, 1]' } } },
  } } } });
  const I = byName(graph.contract.inputs);
  assert.deepEqual([I.geometry_position.shape, I.geometry_supernode_idx.shape, I.surface_anchor_position.shape], [{ v: '[N_g, 3]', src: 'estimate' }, { v: '[N_s]', src: 'estimate' }, { v: '[B, N, 3]', src: 'estimate' }]);
  assert.equal(I.geometry_batch_idx.shape.v, null);
  assert.deepEqual(graph.contract.output.keys[0].shape, { v: '[N_a, 1]', src: 'estimate' });
});
