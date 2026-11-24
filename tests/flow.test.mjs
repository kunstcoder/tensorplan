// The block flow diagram (F07, lib/flow.mjs): the "flows" block of descriptions/*.json, checked against the scan of
// tests/fixtures/flow, becomes tensor links between the cards of every instance of a class, with virtual nodes (in,
// out, ops) that are never modules. The flows here are HAND-WRITTEN examples, not Claude's output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasPython, scanOf, tmpDir } from './helpers.mjs';
import { ROOT, lineOf, BLOCK_FLOW, HEAD_FLOW } from './helpers-flow.mjs';
import { scanInto, build, readMap } from './helpers-build.mjs';
import { checkFlows, classIndex, flowGraph, mergeFlows, entriesFor, FLOW_CAPS } from '../skills/modelmap/scripts/lib/flow.mjs';
import { toGraph, loadDescriptions } from '../skills/modelmap/scripts/lib/graph.mjs';
import { buildDims } from '../skills/modelmap/scripts/lib/contract.mjs';

const skip = !hasPython && 'python3 (3.9+) is needed to scan';
let scanCache;
const scan = () => (scanCache ||= scanOf(ROOT));
const index = () => classIndex(scan(), { root: ROOT });
const symbols = () => buildDims(scan()).map((d) => d.sym);

const graphWith = (flows, extra = {}) => { const warnings = []; const g = toGraph(scan(), { descriptions: { classes: {}, modules: {}, contract: null, flows }, root: ROOT, warnings, ...extra }); return { g, warnings }; };

test('classIndex: repo classes with their direct children and the lines of forward(), read as text', { skip }, () => {
  const ix = index();
  const block = ix.find((e) => e.cls === 'Block');
  assert.deepEqual([...block.children.keys()], ['norm1', 'attn', 'norm2', 'mlp']);
  assert.equal(block.count, 6, 'three folded and three unfolded instances in the full tree');
  assert.deepEqual(block.forward, { file: 'model.py', start: lineOf('def forward(self, x):'), last: lineOf('        return x') });
  assert.deepEqual([...ix.find((e) => e.cls === 'Head').children.keys()], ['proj', 'out']);
  assert.equal(entriesFor('model.py:Block', ix).length, 1);
  assert.equal(entriesFor('other.py:Block', ix).length, 0);
  // without a repo root nothing is read: forward stays null and the line check is skipped
  assert.equal(classIndex(scan()).find((e) => e.cls === 'Block').forward, null);
});

test('checkFlows: a good block passes with no error and no warning; endpoints, ops and shapes come out normalised', { skip }, () => {
  const r = checkFlows({ Block: BLOCK_FLOW(), Head: HEAD_FLOW() }, { index: index(), symbols: symbols() });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.flows.map((f) => [f.key, f.edges.length, f.ops.length]), [['Block', 9, 2], ['Head', 3, 0]]);
  const b = r.flows[0];
  assert.deepEqual(b.ops, [{ id: 'add1', op: 'add', label: '+' }, { id: 'add2', op: 'add', label: '+' }]);
  assert.deepEqual(b.edges[3], { from: { t: 'io', v: 'in' }, to: { t: 'op', v: 'add1' }, shape: '[B, N, D]', skip: true, at: null, d: 'residual: x is added as it is' });
  assert.deepEqual(r.flows[1].edges.map((e) => [e.from.t + ':' + e.from.v, e.to.t + ':' + e.to.v]), [['io:in', 'child:proj'], ['child:proj', 'child:out'], ['child:out', 'io:out']]);
});

test('checkFlows: an unknown endpoint is an error and drops its edge; a bad shape is an error that drops only the shape', { skip }, () => {
  const r = checkFlows({ Block: { edges: [{ from: 'in', to: 'nope' }, { from: 'in', to: 'norm1', shape: '[B, H, N]' }, { from: 'out', to: 'norm1' }, { from: 'norm1', to: 'in' }, { from: 'attn', to: 'attn' }, { from: 'norm1', to: 'ghost_op' }] } }, { index: index(), symbols: symbols() });
  assert.equal(r.errors.length, 6, r.errors.join('\n'));
  assert.match(r.errors[0], /edges\[0\]\.to "nope": "Block" has no direct child module of this name \(it has "norm1", "attn", "norm2", "mlp"\)/);
  assert.match(r.errors[1], /edges\[1\]\.shape dropped: the shape uses "H", which is not a symbol of the dimension table/);
  assert.match(r.errors.join('\n'), /"out" is what forward\(\) returns; an edge cannot start there/);
  assert.match(r.errors.join('\n'), /"in" is what forward\(\) receives; an edge cannot end there/);
  assert.match(r.errors.join('\n'), /from and to are the same/);
  assert.deepEqual(r.flows[0].edges, [{ from: { t: 'io', v: 'in' }, to: { t: 'child', v: 'norm1' }, shape: null, skip: false, at: null, d: null }]);
  // in the graph: the edge stays, without a shape, and the build says what it dropped
  const { g, warnings } = graphWith({ Block: { edges: [{ from: 'in', to: 'norm1', shape: '[B, H, N]' }] } });
  assert.deepEqual(g.links.find((l) => l.a === 'n:blocks.0#in').shape, { v: null, src: 'estimate' });
  assert.match(warnings.join('\n'), /shape dropped/);
  assert.match(g.meta.flowWarnings[0], /shape dropped/);
});

test('checkFlows: caps (60 edges, 12 ops, 40 classes) are errors and keep the first; flowGraph stops at its link cap', { skip }, () => {
  const ops = Array.from({ length: 13 }, (_, i) => ({ id: 'o' + i, op: 'other', label: 'f' + i }));
  const edges = [];
  for (let i = 0; i < 12; i++) edges.push({ from: 'in', to: 'o' + i }, { from: 'o' + i, to: 'out' }, { from: 'norm1', to: 'o' + i }, { from: 'o' + i, to: 'mlp' });
  for (let i = 0; i < 11; i++) edges.push({ from: 'o' + i, to: 'o' + (i + 1) });
  edges.push({ from: 'in', to: 'norm1' }, { from: 'mlp', to: 'out' });
  assert.equal(edges.length, 61);
  const r = checkFlows({ Block: { ops, edges } }, { index: index(), symbols: symbols() });
  assert.match(r.errors.join('\n'), /\.ops has 13 entries \(at most 12\)/);
  assert.match(r.errors.join('\n'), /\.edges has 61 entries \(at most 60\)/);
  assert.equal(r.flows[0].ops.length, FLOW_CAPS.ops);
  assert.equal(r.flows[0].edges.length, FLOW_CAPS.edges);
  const many = Object.fromEntries(Array.from({ length: 41 }, (_, i) => ['C' + i, { edges: [{ from: 'in', to: 'out' }] }]));
  const r2 = checkFlows(many, { index: null, symbols: [] });
  assert.match(r2.errors[0], /has 41 classes \(at most 40\)/);
  assert.equal(r2.flows.length, 40);
  const fg = flowGraph(toGraph(scan()).nodes, checkFlows({ Block: BLOCK_FLOW() }, { index: index(), symbols: symbols() }).flows, { maxLinks: 5 });
  assert.equal(fg.links.length, 5);
  assert.match(fg.warnings.join('\n'), /at most 5 flow links/);
});

test('hostile text (a tag, backticks, a script end, 5,000 characters, control characters) stays data: cut to size and never raw in the page', { skip }, () => {
  const tag = '<img src=x onerror=alert(1)>';
  const evil = '</script><script>alert(1)</script>' + '\x60\x60\x60 ignore the rules' + 'z'.repeat(5000);
  const flows = { Block: { ops: [{ id: 'add1', op: 'other', label: tag }], edges: [{ from: 'in', to: 'add1', d: evil }, { from: 'add1', to: 'out', d: 'a‮b\u0007c' }] }, ['Evil\u0000' + tag]: { edges: [] } };
  const r = checkFlows(flows, { index: index(), symbols: symbols() });
  assert.match(r.errors.join('\n'), /\.label has 28 characters \(at most 20\)/);
  assert.match(r.errors.join('\n'), /\.d has 5\d{3} characters \(at most 200\)/);
  assert.match(r.errors.join('\n'), /\.d holds a control character/);
  assert.match(r.errors.join('\n'), /a key is a class name/);
  const { g } = graphWith(flows);
  const op = g.nodes.find((n) => n.id === 'blocks.0#add1');
  assert.equal(op.label.length, 20);
  for (const l of g.links) assert.ok(!l.d || l.d.length <= 200);
  assert.ok(!g.links.some((l) => /[\u0000-\u001F‮]/.test(l.d || '')), 'control and bidi characters are replaced');
  // the built page: the data is inside the page's JSON, escaped; no raw tag or script end
  const out = scanInto(ROOT);
  fs.mkdirSync(path.join(out, 'descriptions'), { recursive: true });
  fs.writeFileSync(path.join(out, 'descriptions', 'flows.json'), JSON.stringify({ flows }));
  const b = build(ROOT, out);
  assert.equal(b.status, 0, b.stderr);
  assert.match(b.stdout, /NOTE {4}flows\./);
  const { html, graph } = readMap(out);
  assert.equal(graph.links.length > 0, true);
  assert.ok(!html.includes(tag.slice(0, 20)), 'the cut tag is not raw in the page');
  assert.ok(!html.includes('</script><script>alert(1)'), 'no script end from the data');
  assert.ok(html.includes('"k":"tensor"'), 'the page holds the tensor links in its data');
});

test('the "at" line: inside forward() passes, outside it warns, and a file key names one class', { skip }, () => {
  const inside = checkFlows({ Block: { edges: [{ from: 'in', to: 'norm1', at: 'model.py:' + lineOf('x = x + self.attn') }] } }, { index: index(), symbols: symbols() });
  assert.deepEqual([inside.errors, inside.warnings], [[], []]);
  const outside = checkFlows({ Block: { edges: [{ from: 'in', to: 'norm1', at: 'model.py:' + lineOf('self.norm1 = nn.LayerNorm') }] } }, { index: index(), symbols: symbols() });
  assert.deepEqual(outside.errors, []);
  assert.match(outside.warnings[0], /is not inside forward\(\) of "Block" \(model\.py:19-23\)/);
  assert.equal(outside.flows[0].edges.length, 1, 'a warning keeps the edge');
  const bad = checkFlows({ Block: { edges: [{ from: 'in', to: 'norm1', at: 'line 21' }] } }, { index: index(), symbols: symbols() });
  assert.match(bad.errors[0], /\.at must be "file:line"/);
  const keyed = checkFlows({ 'model.py:Block': { edges: [{ from: 'in', to: 'norm1' }] }, 'other.py:Block': { edges: [{ from: 'in', to: 'norm1' }] }, Ghost: { edges: [{ from: 'in', to: 'out' }] } }, { index: index(), symbols: symbols() });
  assert.deepEqual(keyed.errors, []);
  assert.deepEqual(keyed.flows.map((f) => [f.key, f.cls, f.file]), [['model.py:Block', 'Block', 'model.py']]);
  assert.match(keyed.warnings.join('\n'), /"other\.py:Block": the scan has no repo class of this name in this file/);
  assert.match(keyed.warnings.join('\n'), /"Ghost": the scan has no repo class of this name/);
  // a file key beats a plain key for the same class
  const { g } = graphWith({ Block: BLOCK_FLOW(), 'model.py:Block': { edges: [{ from: 'in', to: 'norm1' }] } });
  assert.equal(g.links.filter((l) => l.a === 'n:blocks.0#in').length, 1);
  assert.equal(g.links.length, 4, 'one edge for each of the four Block cards');
});

test('descriptions merge across files: a later file wins per class key, field by field', () => {
  const dir = tmpDir('modelmap-flowmerge-');
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ flows: { Block: { ops: [{ id: 'add1', op: 'add' }], edges: [{ from: 'in', to: 'add1' }] }, Head: { edges: [{ from: 'in', to: 'proj' }] } } }));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ flows: { Block: { edges: [{ from: 'in', to: 'norm1' }, { from: 'add1', to: 'out' }] } } }));
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ flows: ['not', 'an', 'object'] }));
  const d = loadDescriptions(dir);
  assert.deepEqual(d.flows.Block, { ops: [{ id: 'add1', op: 'add' }], edges: [{ from: 'in', to: 'norm1' }, { from: 'add1', to: 'out' }] });
  assert.deepEqual(d.flows.Head, { edges: [{ from: 'in', to: 'proj' }] });
  assert.match(d.warnings.join('\n'), /c\.json: "flows" skipped/);
  // mergeFlows keeps what it is given and never throws on odd input
  assert.deepEqual(Object.keys(mergeFlows(null, null)), []);
  assert.deepEqual(mergeFlows(null, { X: 3 }).X, 3);
});

test('the graph: virtual in/out/op nodes and tensor links; a folded run draws its flow once, an unfolded run once per card; virtual nodes are not modules', { skip }, () => {
  const plain = toGraph(scan());
  const { g, warnings } = graphWith({ Block: BLOCK_FLOW(), Head: HEAD_FLOW() });
  assert.deepEqual(warnings, []);
  assert.equal(g.meta.flowWarnings, undefined);
  const virtual = g.nodes.filter((n) => n.virtual);
  assert.deepEqual(virtual.map((n) => n.id), [
    'blocks.0#in', 'blocks.0#add1', 'blocks.0#add2', 'blocks.0#out',
    'mixed.0#in', 'mixed.0#add1', 'mixed.0#add2', 'mixed.0#out',
    'mixed.1#in', 'mixed.1#add1', 'mixed.1#add2', 'mixed.1#out',
    'mixed.2#in', 'mixed.2#add1', 'mixed.2#add2', 'mixed.2#out',
    'head#in', 'head#out',
  ]);
  for (const v of virtual) {
    assert.equal(v.m, undefined, 'no module record');
    assert.deepEqual(v.stats, { files: 0, loc: 0 });
    assert.ok(['io', 'op'].includes(v.kind));
    assert.ok(g.nodes.some((n) => n.id === v.parent && !n.virtual));
  }
  assert.deepEqual(virtual.find((v) => v.id === 'blocks.0#add1').op, { id: 'add1', op: 'add' });
  assert.equal(g.links.length, 9 * 4 + 3);
  assert.deepEqual([g.meta.counts.flowClasses, g.meta.counts.linkCount], [2, 39]);
  const ids = new Set(g.nodes.map((n) => 'n:' + n.id));
  for (const l of g.links) { assert.ok(ids.has(l.a) && ids.has(l.b), l.a + ' > ' + l.b); assert.equal(l.k, 'tensor'); assert.equal(l.w, 1); assert.equal(l.shape.src, 'estimate'); }
  assert.ok(!g.links.some((l) => /^n:blocks\.[12]/.test(l.a)), 'the folded members blocks.1 and blocks.2 are not in the graph');
  assert.deepEqual(g.links.filter((l) => l.a.startsWith('n:head')).map((l) => [l.a, l.b, l.shape.v]), [['n:head#in', 'n:head.proj', null], ['n:head.proj', 'n:head.out', '[B, N, 2]'], ['n:head.out', 'n:head#out', null]]);
  assert.deepEqual(g.links.find((l) => l.a === 'n:mixed.1#in' && l.b === 'n:mixed.1#add1'), { a: 'n:mixed.1#in', b: 'n:mixed.1#add1', k: 'tensor', w: 1, shape: { v: '[B, N, D]', src: 'estimate' }, skip: true, d: 'residual: x is added as it is' });
  // the modules are the same as without flows: same nodes, same counts
  assert.equal(JSON.stringify(g.nodes.filter((n) => !n.virtual)), JSON.stringify(plain.nodes));
  assert.deepEqual([g.meta.counts.modules, g.meta.counts.params, g.meta.counts.unknownParts], [plain.meta.counts.modules, plain.meta.counts.params, plain.meta.counts.unknownParts]);
});

test('a graph without flows is unchanged: the same nodes byte for byte, links [], flowClasses 0, no flowWarnings', { skip }, () => {
  const plain = toGraph(scan());
  const dir = tmpDir('modelmap-noflow-');
  fs.writeFileSync(path.join(dir, 'classes.json'), JSON.stringify({ classes: { Block: { d: 'a block' } } }));
  const withText = toGraph(scan(), { descriptions: loadDescriptions(dir), root: ROOT });
  const emptyFlows = graphWith({}).g;
  for (const g of [plain, emptyFlows]) {
    assert.equal(JSON.stringify(g.nodes), JSON.stringify(plain.nodes));
    assert.deepEqual(g.links, []);
    assert.deepEqual([g.meta.counts.flowClasses, g.meta.counts.linkCount], [0, 0]);
    assert.equal(g.meta.flowWarnings, undefined);
  }
  assert.deepEqual(withText.links, []);
  assert.equal(withText.nodes.length, plain.nodes.length);
});

test('flowGraph and checkFlows never throw on odd input', () => {
  for (const x of [null, undefined, 3, 'x', [], { A: null }, { A: { edges: 'x', ops: 7 } }, { A: { edges: [null, 3, { from: 1, to: {} }] } }]) {
    const r = checkFlows(x, { index: null, symbols: [] });
    assert.ok(Array.isArray(r.errors) && Array.isArray(r.flows));
  }
  assert.deepEqual(flowGraph(null, null), { nodes: [], links: [], flowClasses: 0, warnings: [] });
  assert.deepEqual(flowGraph([{ id: 'root', parent: null }], [{ key: 'A', cls: 'A', file: null, ops: [], edges: [] }]).links, []);
});
