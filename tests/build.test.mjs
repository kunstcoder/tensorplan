import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hasPython, fixture, tmpDir, node, script } from './helpers.mjs';
import { scanInto, build, readMap, hostileRepo, twoBlockRepo } from './helpers-build.mjs';
import { writeSafetensors } from './helpers-scan.mjs';
import { toGraph, loadDescriptions, kindOf } from '../skills/modelmap/scripts/lib/graph.mjs';
import { scriptBlocks } from '../skills/modelmap/assets/page-safety.mjs';

const opts = { skip: hasPython ? false : 'python3 (3.9 or newer) is not available' };
const EVIL = '</script><img src=x onerror=1>';
const assets = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'skills', 'modelmap', 'assets');

// one scan and one build of the fixture, shared by the tests below
let mini = null;
const miniMap = () => {
  if (mini) return mini;
  const out = scanInto(fixture('mini-model'));
  const r = build(fixture('mini-model'), out);
  assert.equal(r.status, 0, r.stderr);
  mini = { out, r, ...readMap(out) };
  return mini;
};

test('build.mjs without a scan stops and says to run scan.mjs first', () => {
  const out = tmpDir('modelmap-noscan-');
  const r = build(fixture('mini-model'), out);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Run scan\.mjs first/);
  assert.equal(fs.existsSync(path.join(out, 'index.html')), false);
});

test('every module instance path is a node id, under its parent', opts, () => {
  const { graph, byId } = miniMap();
  assert.equal(graph.schema, 'modelmap/graph@1');
  const root = graph.nodes[0];
  assert.deepEqual([root.id, root.parent, root.label, root.kind], ['root', null, 'Net', 'model']);
  assert.equal(new Set(graph.nodes.map((n) => n.id)).size, graph.nodes.length, 'ids are unique');
  for (const n of graph.nodes.slice(1)) assert.ok(byId.has(n.parent), n.id + ' has a parent in the graph');
  assert.equal(byId.get('embed').parent, 'root');
  assert.equal(byId.get('blocks.0.attn').parent, 'blocks.0');
  assert.equal(byId.get('blocks.0.attn.qkv').parent, 'blocks.0.attn');
  assert.equal(byId.get('mixed.1.attn').m.cls, 'CrossAttn');
  assert.deepEqual([graph.project.name, graph.meta.counts.modules, graph.meta.counts.params, graph.meta.counts.unknownParts], ['Net', 62, 18740, 2]);
  for (const k of ['files', 'routes', 'links', 'flows', 'tour']) assert.deepEqual(graph[k], []);
});

test('equal blocks fold into one node; members are not emitted', opts, () => {
  const { graph, byId } = miniMap();
  const kids = graph.nodes.filter((n) => n.parent === 'blocks');
  assert.deepEqual(kids.map((n) => n.id), ['blocks.0']);
  const f = byId.get('blocks.0');
  assert.equal(f.label, '0…2');
  assert.deepEqual(f.m.fold, { n: 3, members: ['blocks.0', 'blocks.1', 'blocks.2'], total: 3 * 3280 });
  assert.equal(f.m.params.v, 3280);
  assert.deepEqual(graph.nodes.filter((n) => n.parent === 'blocks.0').map((n) => n.label), ['norm1', 'attn', 'norm2', 'mlp']);
  assert.equal(byId.has('blocks.1'), false);
  assert.equal(byId.has('blocks.1.attn'), false);
});

test('different siblings are not folded; a repeating run gets letters and a pattern', opts, () => {
  const { byId } = miniMap();
  // mixed holds Block(Attn), Block(CrossAttn): different, and nothing repeats, so lib/fold.mjs gives no letters
  assert.deepEqual(['mixed.0', 'mixed.1'].map((id) => byId.get(id).parent), ['mixed', 'mixed']);
  assert.equal(byId.get('mixed.0').m.fold, undefined);
  assert.equal(byId.get('mixed').m.pattern, undefined);
  const out = scanInto(fixture('mini-model'), ['--arg', 'pattern="scs"']);
  assert.equal(build(fixture('mini-model'), out).status, 0);
  const { byId: b2 } = readMap(out);
  assert.equal(b2.get('mixed').m.pattern, 'ABA');
  assert.deepEqual(['mixed.0', 'mixed.1', 'mixed.2'].map((id) => b2.get(id).m.letter), ['A', 'B', 'A']);
});

test('a shared module is a leaf that names the first path', opts, () => {
  const { graph, byId } = miniMap();
  const t = byId.get('tied');
  assert.equal(t.kind, 'other');
  assert.equal(t.m.alias, 'head.0');
  assert.equal(t.m.params.v, 0);
  assert.equal(graph.nodes.some((n) => n.parent === 'tied'), false);
});

test('params, kinds, classes and arguments come over from the scan', opts, () => {
  const { byId } = miniMap();
  const root = byId.get('root');
  assert.deepEqual(root.m.params, { v: 18740, src: 'code', lowerBound: true, why: 'class timm.layers.DropPath is not in the scanned repo' });
  assert.deepEqual(byId.get('head').m.params, { v: 340, src: 'code' });
  assert.equal(byId.get('blocks.0.attn.qkv').m.bytes.fp32, 816 * 4);
  assert.deepEqual(root.m.def, { file: 'model.py', line: 35 });
  assert.deepEqual(root.m.args.dim, { v: 16, at: 'model.py:36' });
  assert.deepEqual(byId.get('embed').m.args, { 0: { v: 100, at: 'model.py:38' }, 1: { v: 16, at: 'model.py:38' } });
  const kinds = Object.fromEntries(['blocks.0', 'blocks.0.attn', 'blocks.0.mlp', 'blocks.0.norm1', 'embed', 'extra', 'drop', 'mystery', 'blocks'].map((id) => [id, byId.get(id).kind]));
  assert.deepEqual(kinds, { 'blocks.0': 'block', 'blocks.0.attn': 'attention', 'blocks.0.mlp': 'mlp', 'blocks.0.norm1': 'norm', embed: 'embed', extra: 'linear', drop: 'external', mystery: 'external', blocks: 'other' });
  assert.equal(byId.get('blocks').m.container, 'list');
});

test('the page: graph inside, no placeholder left, 25-recent.js out, 70-model.js in, a policy', opts, () => {
  const { html, graph } = miniMap();
  assert.equal(html.includes('__FLOORPLAN_'), false);
  for (const p of ['/*__GRAPH_QUERY__*/', '<!--__ELK_SCRIPT__-->', '/*__FONTS__*/', '<!--__UI_EXTENSIONS__-->', '/*__FLOORPLAN_DATA__*/']) assert.equal(html.includes(p), false, p);
  assert.equal(html.includes('/* ui/25-recent.js */'), false);
  assert.ok(html.includes('/* ui/70-model.js */'));
  assert.match(html, /<meta http-equiv="Content-Security-Policy" data-floorplan-policy="local" content="default-src 'none'; script-src 'sha256-/);
  assert.match(html, /<link rel="icon" type="image\/png" href="data:image\/svg\+xml;base64,/);
  assert.match(html, /alt="modelmap"/);
  const data = scriptBlocks(html).find((b) => b.body.startsWith('window.FLOORPLAN = '));
  assert.ok(data, 'the graph is in the page');
  const inPage = JSON.parse(data.body.slice('window.FLOORPLAN = '.length).replace(/;$/, ''));
  assert.deepEqual(inPage, graph);
});

test('the map folder: .gitignore, descriptions/, query.mjs, fresh serve.mjs and page-safety.mjs', opts, () => {
  const { out } = miniMap();
  assert.equal(fs.readFileSync(path.join(out, '.gitignore'), 'utf8'), '*\n');
  assert.ok(fs.statSync(path.join(out, 'descriptions')).isDirectory());
  const q = fs.readFileSync(path.join(out, 'query.mjs'), 'utf8');
  assert.ok(q.includes('\n// ---- cli ----\n'));
  assert.ok(q.startsWith(fs.readFileSync(path.join(assets, 'graph-query.js'), 'utf8')));
  for (const n of ['serve.mjs', 'page-safety.mjs']) assert.ok(fs.readFileSync(path.join(out, n)).equals(fs.readFileSync(path.join(assets, n))), n);
});

test('building twice works, also when serve.mjs was left read-only', opts, () => {
  const out = scanInto(fixture('mini-model'));
  assert.equal(build(fixture('mini-model'), out).status, 0);
  fs.chmodSync(path.join(out, 'serve.mjs'), 0o444);
  fs.chmodSync(path.join(out, 'page-safety.mjs'), 0o444);
  const r = build(fixture('mini-model'), out);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.statSync(path.join(out, 'serve.mjs')).mode & 0o200, 'the new serve.mjs is writable');
});

test('descriptions merge by file name; a module text beats its class text; a bad file is skipped with a warning', opts, () => {
  const out = scanInto(fixture('mini-model'));
  const dir = path.join(out, 'descriptions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '10-classes.json'), JSON.stringify({ classes: { Block: { name: '블록 (Block)', d: 'class text', details: 'longer' }, Attn: { d: 'old attn' } } }));
  fs.writeFileSync(path.join(dir, '20-modules.json'), JSON.stringify({ classes: { Attn: { d: 'new attn' } }, modules: { 'blocks.0': { d: 'module text' }, '': { d: 'the root' } } }));
  fs.writeFileSync(path.join(dir, '30-bad.json'), '{ not json');
  fs.writeFileSync(path.join(dir, '40-shape.json'), JSON.stringify({ classes: ['wrong'] }));
  const r = build(fixture('mini-model'), out);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /30-bad\.json skipped/);
  assert.match(r.stdout, /40-shape\.json skipped/);
  const { byId, graph } = readMap(out);
  assert.equal(byId.get('blocks.0').summary, 'module text', 'module level wins over class level');
  assert.equal(byId.get('blocks.0').details, 'longer');
  assert.equal(byId.get('blocks.0').title, '블록 (Block)');
  assert.equal(byId.get('mixed.0').summary, 'class text');
  assert.equal(byId.get('blocks.0.attn').summary, 'new attn', 'a later file wins');
  assert.equal(graph.project.summary, 'the root');
  assert.equal(byId.get('embed').summary, '');
});

test('loadDescriptions never throws', () => {
  const missing = loadDescriptions(path.join(tmpDir(), 'nope'));
  assert.deepEqual([missing.files, missing.warnings], [[], []]);
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.json'), 'null');
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ classes: { X: { d: 1 }, constructor: { d: 'ok' } }, modules: { y: 'text' } }));
  const d = loadDescriptions(dir);
  assert.equal(d.warnings.length, 2);
  assert.deepEqual(d.files, ['b.json']);
  assert.equal(d.classes.constructor.d, 'ok');
  assert.equal(Object.hasOwn(d.classes, 'X'), false);
});

test('hostile text from the repo or a description never reaches the page as markup', opts, () => {
  const root = hostileRepo(EVIL);
  const out = scanInto(root);
  fs.mkdirSync(path.join(out, 'descriptions'), { recursive: true });
  fs.writeFileSync(path.join(out, 'descriptions', 'x.json'), JSON.stringify({ classes: { Part: { name: EVIL, d: EVIL + '<!--<script>' } }, modules: { part: { d: '<script>alert(1)</script>' } } }));
  const r = build(root, out);
  assert.equal(r.status, 0, r.stderr);
  const { html, byId } = readMap(out);
  assert.equal(byId.get('part').m.args.name.v, EVIL, 'the value is kept as it is in graph.json');
  assert.equal(html.includes(EVIL), false);
  assert.equal(html.includes('<img src=x'), false);
  assert.equal(html.includes('<script>alert(1)'), false);
  assert.equal(html.includes('<!--<script>'), false);
  // the same scripts as the page of the clean fixture: nothing in the data opened or closed a block
  assert.equal(scriptBlocks(html).length, scriptBlocks(miniMap().html).length);
  assert.equal((html.match(/<\/script>/gi) || []).length, (miniMap().html.match(/<\/script>/gi) || []).length);
  // arguments are capped: 12 per module, 200 characters per value
  const args = byId.get('part').m.args;
  assert.equal(Object.keys(args).length, 12);
  assert.equal(byId.get('part').m.argsMore, 17 - 12);
  assert.equal(args.note.v, 'z'.repeat(200) + '...');
});

test('toGraph on a hand-made scan: kinds by class name, a module named root, no python needed', () => {
  const leaf = (name, cls, kind = 'torch', extra = {}) => ({ name, path: name, cls, kind, children: [], params: { v: 1, src: 'code' }, own: 1, bytes: { fp32: 4 }, ...extra });
  const scan = { root: { name: '', path: '', cls: 'Model', kind: 'repo', params: { v: 5, src: 'config' }, own: 0, bytes: { fp32: 20 }, children: [
    leaf('root', 'RMSNorm'), leaf('a', 'FeedForward', 'repo'), leaf('b', 'PatchEmbed', 'repo'), leaf('c', 'Conv2d'), leaf('d', 'TransformerLayer', 'repo'), leaf('e', 'Thing', 'external', { why: 'class x.Thing is not in the scanned repo' }),
  ] }, resolution: { unknown: 0, external: 1, incomplete: 0 }, meta: { root: 'r' } };
  const g = toGraph(scan, {});
  assert.deepEqual(g.nodes.map((n) => [n.id, n.kind]), [['root', 'model'], ['root~', 'norm'], ['a', 'mlp'], ['b', 'embed'], ['c', 'linear'], ['d', 'block'], ['e', 'external']]);
  assert.equal(g.nodes[1].parent, 'root');
  assert.equal(g.nodes[6].m.why, 'class x.Thing is not in the scanned repo');
  assert.equal(g.meta.counts.unknownParts, 1);
  assert.equal(g.nodes[0].m.params.src, 'config');
  assert.equal(kindOf({ cls: 'CrossAttention', kind: 'repo' }), 'attention');
});

// ---------- a folded run is checked over every member; the map records its commit ----------

test('a folded run with one wrong member shows a failed check, with the member and the key', opts, () => {
  const { root, weights } = twoBlockRepo(writeSafetensors);
  const out = scanInto(root, ['--weights', weights]);
  assert.equal(build(root, out).status, 0);
  const { byId, graph } = readMap(out);
  const f = byId.get('blocks.0');
  assert.equal(f.m.fold.n, 2);
  assert.equal(f.m.check.ok, false, 'one member differs, so the folded card is not ok');
  assert.deepEqual(f.m.fold.failing, [{ member: 'blocks.1', key: 'blocks.1.fc.weight', expected: [4, 4], found: [4, 2] }]);
  assert.equal(f.m.fold.failingCount, 1);
  assert.equal(f.m.check.foundKeys, 2, 'the other check fields are the first member\'s');
  assert.equal(byId.get('blocks.0.fc').m.check.ok, true, 'the shown subtree is the first member\'s');
  assert.deepEqual(f.m.fold.weights, { params: 20 + 12, bytes: 4 * 32, keys: 4, members: 2 });
  assert.equal(f.m.fold.total, 40);
  assert.equal(byId.get('blocks').m.check.ok, false);
  assert.equal(graph.meta.weights.differModules, 1);
  assert.deepEqual(graph.meta.weights.files, ['w.safetensors']);
});

test('a folded run whose members all match stays ok', opts, () => {
  const { root, weights } = twoBlockRepo(writeSafetensors, { bad: false });
  const out = scanInto(root, ['--weights', weights]);
  assert.equal(build(root, out).status, 0);
  const f = readMap(out).byId.get('blocks.0');
  assert.equal(f.m.check.ok, true);
  assert.equal(f.m.fold.failing, undefined);
});

test('toGraph: a lower bound, notes or skipped code in any member reach the folded node', () => {
  const lin = (p, extra = {}) => ({ name: p.split('.').pop(), path: p, cls: 'Linear', kind: 'torch', pos: [{ v: 2 }, { v: 2 }], kw: {}, children: [], params: { v: 6, src: 'code' }, own: 6, bytes: { fp32: 24 }, ...extra });
  const blk = (i, inner, extra = {}) => ({ name: String(i), path: 'b.' + i, cls: 'B', kind: 'repo', args: { d: { v: 2 } }, children: [inner], params: inner.params, own: 0, bytes: { fp32: 24 }, ...extra });
  const scan = { root: { name: '', path: '', cls: 'M', kind: 'repo', params: { v: 12, src: 'code', lowerBound: true, why: 'x' }, own: 0, bytes: { fp32: 48 }, children: [
    { name: 'b', path: 'b', cls: 'ModuleList', kind: 'torch', container: 'list', pos: [], kw: {}, params: { v: 12, src: 'code', lowerBound: true, why: 'x' }, own: 0, bytes: { fp32: 48 }, children: [
      blk(0, lin('b.0.fc')),
      blk(1, lin('b.1.fc', { notes: ['a loop was cut short'], incomplete: true, params: { v: 6, src: 'code', lowerBound: true, why: 'x' } }), { params: { v: 6, src: 'code', lowerBound: true, why: 'x' } }),
    ] },
  ] }, resolution: {}, meta: { root: 'r' } };
  const f = toGraph(scan, {}).nodes.find((n) => n.id === 'b.0');
  assert.equal(f.m.fold.n, 2);
  assert.equal(f.m.params.lowerBound, true);
  assert.match(f.m.params.why, /^b\.1: x/);
  assert.deepEqual(f.m.fold.notes, ['b.1.fc: a loop was cut short', 'b.1.fc: part of the constructor was skipped']);
});

const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' }).trim();

test('meta.repos records the commit of a git repo, and status.mjs compares with it', opts, () => {
  const root = tmpDir('modelmap-git-');
  fs.cpSync(fixture('mini-model'), root, { recursive: true });
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'x');
  const out = scanInto(root);
  assert.equal(build(root, out).status, 0);
  const { graph } = readMap(out);
  assert.deepEqual(graph.meta.repos, [{ path: '.', name: path.basename(root), branch: git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), head: git(root, 'rev-parse', 'HEAD') }]);
  const st = node(script('status.mjs'), [root, '--out', out]);
  assert.equal(st.status, 0);
  assert.doesNotMatch(st.stdout, /records no git commit/);
  assert.match(st.stdout, /same commit/);
});

test('meta.repos without git has no commit', opts, () => {
  const root = tmpDir('modelmap-nogit-');
  fs.cpSync(fixture('mini-model'), root, { recursive: true });
  const out = scanInto(root);
  assert.equal(build(root, out).status, 0);
  assert.deepEqual(readMap(out).graph.meta.repos, [{ path: '.', name: path.basename(root) }]);
  assert.doesNotMatch(node(script('status.mjs'), [root, '--out', out]).stdout, /records no git commit/);
});

// ---------- the input and output contract (graph.contract) ----------
test('graph.contract and meta.counts.contractInputs come from the root forward(); a root without forward has no contract and counts 0', opts, () => {
  const out = scanInto(fixture('contract/no-div'));
  assert.equal(build(fixture('contract/no-div'), out).status, 0);
  const { graph } = readMap(out);
  assert.deepEqual(Object.keys(graph.contract), ['forward', 'inputs', 'output', 'dims']);
  assert.equal(graph.meta.counts.contractInputs, 1);
  assert.deepEqual(graph.contract.inputs.map((x) => [x.name, x.optional, x.nullable]), [['x', false, false]]);
  const root = tmpDir('modelmap-noforward-');
  fs.writeFileSync(path.join(root, 'm.py'), 'from torch import nn\nclass Net(nn.Module):\n    def __init__(self):\n        super().__init__()\n        self.fc = nn.Linear(2, 2)\n');
  const out2 = scanInto(root);
  const r = build(root, out2);
  assert.equal(r.status, 0, r.stderr);
  const g2 = readMap(out2).graph;
  assert.equal('contract' in g2, false);
  assert.equal(g2.meta.counts.contractInputs, 0);
  assert.doesNotMatch(r.stdout, /^INPUTS/m);
});

test('loadDescriptions reads a contract block (a later file wins); a contract that is not an object is skipped with a note; toGraph reports dropped estimates', () => {
  const dir = tmpDir('modelmap-desc-');
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ contract: { inputs: { x: { shape: '[B]', d: 'a' } } } }));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ classes: { Net: { d: 'net' } }, contract: { inputs: { x: { shape: '[B, N]' }, y: { shape: '[B]' } } } }));
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ contract: 'nope' }));
  const D = loadDescriptions(dir);
  assert.deepEqual({ ...D.contract.inputs.x }, { shape: '[B, N]', d: 'a' });
  assert.ok(D.warnings.some((w) => /c\.json: "contract" skipped/.test(w)));
  assert.deepEqual(D.files, ['a.json', 'b.json', 'c.json']);
  const scan = { root: { name: 'Net', path: '', cls: 'Net', kind: 'repo', params: { v: 6, src: 'code' }, children: [] }, forward: { file: 'm.py', line: 9, owner: 'Net', params: [{ name: 'x', annotation: null, default: null }] } };
  const warnings = [];
  const g = toGraph(scan, { descriptions: D, warnings });
  assert.deepEqual(g.contract.inputs[0].shape, { v: '[B, N]', src: 'estimate' });
  assert.equal(g.contract.inputs[0].d, 'a');
  assert.deepEqual(warnings, ['contract: inputs.y dropped: forward() has no input of this name']);
  assert.equal(toGraph(scan).contract.inputs[0].shape.v, null, 'no descriptions, no estimate');
});

test('the page shows the contract: the overview script renders inputs, output keys and dims from graph.contract with the viewer escaping', opts, () => {
  const out = scanInto(fixture('contract/dict-out'));
  assert.equal(build(fixture('contract/dict-out'), out).status, 0);
  const { html, graph } = readMap(out);
  assert.match(html, /function contractSections\(ct\)/);
  assert.ok(graph.contract.inputs.length === 5 && html.includes('"contractInputs":5'));
  assert.equal(html.includes('<script>alert(1)'), false, 'docstring text is data in the page');
});
