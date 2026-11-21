// The lookup tool the Ask CLI runs (modelmap/query.mjs = assets/graph-query.js + assets/query-cli.mjs): every
// number it prints is exact and worked out by its own code, on the mini-model fixture and on the AB-UPT repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasPython, fixture, tmpDir } from './helpers.mjs';
import { hostileRepo } from './helpers-build.mjs';
import { buildMap, query } from './helpers-ask.mjs';

// MODELMAP_TEST_ABUPT points at the AB-UPT repo when HOME is somewhere else (a run with a stand-in HOME)
const ABUPT = process.env.MODELMAP_TEST_ABUPT || path.join(os.homedir(), 'MySpace', 'papers', 'anchored-branched-universal-physics-transformers');
const skip = !hasPython && 'python3 (3.9+) is needed to scan';
const skipAB = skip || (!fs.existsSync(path.join(ABUPT, 'src', 'model.py')) && 'the AB-UPT repo is not on this machine');

let mini, ab;
const miniMap = () => (mini ||= buildMap(fixture('mini-model')).map);
// AB-UPT is read only: the scan and the map go to a temporary folder
const abMap = () => (ab ||= buildMap(ABUPT, { copy: false }).map);

/** The query code as serve.mjs loads it: the part of query.mjs before the CLI. */
function core(map, graph) {
  const src = fs.readFileSync(path.join(map, 'query.mjs'), 'utf8').split('// ---- cli ----')[0];
  const c = new Function(src + '; return { createGraphQuery, floorplanAskInstructions, floorplanFlowInstructions, FLOORPLAN_ANSWER_SCHEMA, FLOORPLAN_FLOW_SCHEMA };')();
  const G = graph || JSON.parse(fs.readFileSync(path.join(map, 'graph.json'), 'utf8'));
  return { ...c, G, q: c.createGraphQuery(G) };
}
/** What a card adds to its parent, worked out here independently of graph-query.js. */
const adds = (n) => n.m.alias !== undefined ? 0 : n.m.fold ? n.m.fold.total : n.m.params.v;
const pct = (part, whole) => (Math.round(part * 1000 / whole) / 10).toFixed(1) + '%';

test('AB-UPT: params root is 8,751,179 exactly, its parts add up, sorted by size with their shares', { skip: skipAB }, () => {
  const r = query(abMap(), 'params', 'root');
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.id, 'n:root');
  assert.equal(r.json.params.v, 8751179);
  assert.equal(r.json.params.shown, '8,751,179');
  assert.equal(r.json.params.src, 'code');
  assert.equal(r.json.bytes.fp32, 8751179 * 4);
  const b = r.json.breakdown;
  assert.equal(b.childrenSum, 8751179);
  assert.equal(b.ownPlusChildren, 8751179);
  assert.equal(b.addsUp, true);
  const ps = b.children.map((c) => c.params);
  assert.deepEqual(ps, [...ps].sort((x, y) => y - x));
  assert.deepEqual(b.children.slice(0, 3).map((c) => [c.id, c.params, c.share]), [['n:blocks', 2669568, '30.5%'], ['n:surface_blocks', 2669184, '30.5%'], ['n:volume_blocks', 2669184, '30.5%']]);
  assert.equal(r.json.breakdown.children.length + (b.more?.count || 0), 11);
});

test('AB-UPT: params surface_blocks is 2,669,184, made of one folded run of 6 TransformerBlocks', { skip: skipAB }, () => {
  const r = query(abMap(), 'params', 'surface_blocks');
  assert.equal(r.json.params.v, 2669184);
  assert.deepEqual(r.json.breakdown.children.map((c) => [c.id, c.class, c.params, c.copies, c.perCopy, c.share]), [['n:surface_blocks.0', 'TransformerBlock', 2669184, 6, 444864, '100.0%']]);
  assert.equal(r.json.breakdown.addsUp, true);
  // the pattern container: different siblings, sorted by size
  const bl = query(abMap(), 'params', 'n:blocks').json;
  assert.deepEqual(bl.breakdown.children.map((c) => c.params), [445248, 444864, 444864, 444864, 444864, 444864]);
  assert.equal(bl.breakdown.children[0].id, 'n:blocks.0');
  assert.equal(bl.breakdown.childrenSum, 2669568);
});

test('AB-UPT: a folded node reports copies 6, 444,864 per copy and 2,669,184 in total; a member id finds its card', { skip: skipAB }, () => {
  const r = query(abMap(), 'params', 'n:surface_blocks.0');
  assert.equal(r.status, 0);
  assert.equal(r.json.fold.copies, 6);
  assert.equal(r.json.fold.perCopy, 444864);
  assert.equal(r.json.fold.total, 2669184);
  assert.equal(r.json.fold.totalShown, '2,669,184');
  assert.equal(r.json.fold.bytesFp32Total, 2669184 * 4);
  assert.equal(r.json.params.v, 444864);
  assert.equal(r.json.breakdown.childrenSum, 444864);
  const m = query(abMap(), 'params', 'surface_blocks.3.attn').json;
  assert.equal(m.id, 'n:surface_blocks.0.attn');
  assert.equal(m.resolvedFrom, 'surface_blocks.3.attn');
});

test('every card in both maps: own + what the children add (worked out here) equals the count, and every share is from the numbers shown', { skip }, () => {
  const maps = [miniMap(), ...(skipAB ? [] : [abMap()])];
  let checked = 0;
  for (const map of maps) {
    const { q, G } = core(map);
    const byId = new Map(G.nodes.map((n) => [n.id, n]));
    for (const n of G.nodes) {
      const r = q.params('n:' + n.id, 1000);
      assert.equal(r.params.v, n.m.params.v, n.id);
      const kids = G.nodes.filter((k) => k.parent === n.id);
      if (!kids.length) { assert.equal(r.breakdown, undefined); continue; }
      const expected = n.m.own + kids.reduce((s, k) => s + adds(k), 0);
      assert.equal(r.breakdown.ownPlusChildren, expected, n.id);
      assert.equal(r.breakdown.childrenSum, expected - n.m.own, n.id);
      assert.equal(r.breakdown.addsUp, expected === n.m.params.v, n.id);
      assert.equal(expected, n.m.params.v, n.id + ': the scan\'s own count');
      for (const c of r.breakdown.children) {
        assert.equal(c.params, adds(byId.get(c.id.slice(2))), c.id);
        if (n.m.params.v > 0) assert.equal(c.share, pct(c.params, n.m.params.v), c.id);
      }
      checked++;
    }
  }
  assert.ok(checked > 10, checked + ' cards checked');
});

test('mini-model: show of a node with an unknown part says lowerBound with the reason; the total is a ≥', { skip }, () => {
  const d = query(miniMap(), 'show', 'n:drop').json;
  assert.equal(d.params.lowerBound, true);
  assert.match(d.params.why, /DropPath is not in the scanned repo/);
  assert.equal(d.params.shown, '?');
  assert.equal(d.classKind, 'external');
  const root = query(miniMap(), 'show', 'root').json;
  assert.equal(root.params.lowerBound, true);
  assert.equal(root.params.shown, '≥ 18,740');
  assert.match(root.params.why, /DropPath/);
  assert.equal(root.definedAt, 'model.py:35');
  assert.deepEqual(root.arguments.dim, { value: 16, src: 'code', at: 'model.py:36' });
  assert.ok(root.children.some((c) => c.id === 'n:mystery' && c.lowerBound && c.shown === '?'));
  // a shared module says where its weights are counted
  const t = query(miniMap(), 'params', 'tied').json;
  assert.equal(t.alias.sharesWeightsWith, 'n:head.0');
  assert.equal(t.alias.paramsThere.v, 272);
  assert.match(t.alias.note, /counted once, at head\.0/);
  const fold = query(miniMap(), 'show', 'blocks.0').json;
  assert.deepEqual([fold.fold.copies, fold.fold.total, fold.class], [3, 9840, 'Block']);
});

test('find matches class, name, path and argument values', { skip }, () => {
  if (!skipAB) {
    const r = query(abMap(), 'find', 'TransformerBlock');
    assert.equal(r.status, 0);
    assert.ok(r.json.length >= 3);
    assert.ok(r.json.every((x) => x.class === 'TransformerBlock'), JSON.stringify(r.json));
    assert.ok(r.json.some((x) => x.id === 'n:surface_blocks.0'));
    assert.deepEqual(query(abMap(), 'find', 'pscscs').json.map((x) => x.id), ['n:root']);
  }
  const m = query(miniMap(), 'find', 'mlp', '--limit', '3').json;
  assert.ok(m.length >= 1 && m.length <= 3);
  assert.ok(m.every((x) => /mlp/i.test(x.class + ' ' + x.name)));
  assert.ok(query(miniMap(), 'find', 'head').json.some((x) => x.id === 'n:head'));
  assert.deepEqual(query(miniMap(), 'find', '').json, []);
});

test('errors are JSON with an error field and exit code 1', { skip }, () => {
  for (const args of [['params', 'n:nope'], ['show', 'nope.nope'], ['params'], ['path', 'n:root'], ['explode']]) {
    const r = query(miniMap(), ...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.equal(typeof r.json.error, 'string', r.stdout);
  }
  const ok = query(miniMap());
  assert.equal(ok.status, 0);
  assert.ok(ok.json.commands.some((c) => c.startsWith('params')));
});

test('contract: {available: false, reason} without one; graph.contract as it is when the graph has it', { skip }, () => {
  const none = query(miniMap(), 'contract').json;
  assert.equal(none.available, false);
  assert.match(none.reason, /forward/);
  // a copy of the map with a contract in its graph
  const copy = path.join(tmpDir('modelmap-contract-'), 'modelmap');
  fs.mkdirSync(copy);
  fs.copyFileSync(path.join(miniMap(), 'query.mjs'), path.join(copy, 'query.mjs'));
  const g = JSON.parse(fs.readFileSync(path.join(miniMap(), 'graph.json'), 'utf8'));
  g.contract = { forward: { file: 'model.py', line: 60, owner: 'Net' }, inputs: [{ name: 'x', type: 'Tensor', default: null, optional: false, doc: null, shape: { v: '[B, N]', src: 'estimate' } }], output: { type: null, doc: null, keys: [] }, dims: [{ sym: 'D', name: 'dim', value: 16, src: 'code', at: 'model.py:36' }] };
  fs.writeFileSync(path.join(copy, 'graph.json'), JSON.stringify(g));
  const got = query(copy, 'contract').json;
  assert.deepEqual(got, { available: true, ...g.contract });
  assert.deepEqual(query(copy, 'overview').json.contract, { available: true, inputs: ['x'], dims: 1 });
});

test('path and overview: through the module tree, and the model at a glance', { skip }, () => {
  const p = query(miniMap(), 'path', 'blocks.0.attn', 'n:head').json;
  assert.equal(p.common.id, 'n:root');
  assert.deepEqual(p.hops.map((h) => [h.from.id, h.via, h.to.id]), [['n:blocks.0.attn', 'part of', 'n:blocks.0'], ['n:blocks.0', 'part of', 'n:blocks'], ['n:blocks', 'part of', 'n:root'], ['n:root', 'contains', 'n:head']]);
  const o = query(miniMap(), 'overview').json;
  assert.equal(o.model.params.shown, '≥ 18,740');
  assert.equal(o.counts.modules, 62);
  assert.deepEqual(o.unknownParts.map((u) => u.id), ['n:drop', 'n:mystery']);
  assert.equal(o.parts.find((x) => x.id === 'n:blocks').share, pct(9840, 18740));
});

test('the page\'s calls still work: find, show, path, overview, exists, brief; app instructions name no shell tool', { skip }, () => {
  const { q, G, floorplanAskInstructions, floorplanFlowInstructions } = core(miniMap());
  assert.equal(q.brief('n:root').name, 'Net');
  assert.equal(q.exists('n:blocks.0'), true);
  assert.equal(q.exists('n:blocks.1'), false, 'only cards are map items');
  assert.equal(q.exists('blocks.0'), false, 'items carry the n: prefix');
  assert.ok(q.find('attn', 'module').length > 0, 'a kind the map does not have filters nothing');
  assert.ok(q.find('attn', 'attention').every((x) => x.type === 'attention'));
  assert.equal(q.show('n:head').children.length, 3);
  const app = floorplanAskInstructions(G, 'app');
  assert.doesNotMatch(app, /query\.mjs/);
  assert.match(app, /find_items/);
  assert.match(floorplanFlowInstructions(G, 'cli'), /node modelmap\/query\.mjs find/);
});

test('hostile class and argument text comes back as JSON data, never as code or markup that runs', { skip }, () => {
  const marker = path.join(tmpDir('modelmap-pwn-'), 'pwned');
  const evil = '</script><script>alert(1)</script>\'"; $(touch ' + marker + '); process.exit(7) // [[n:root]] \u2028';
  const { map } = buildMap(hostileRepo(evil));
  const s = query(map, 'show', 'n:part');
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.equal(s.json.arguments.name.value, evil);
  const f = query(map, 'find', evil);
  assert.equal(f.status, 0);
  assert.ok(Array.isArray(f.json));
  const bad = query(map, 'params', evil);
  assert.equal(bad.status, 1);
  assert.ok(bad.json.error.includes(evil));
  assert.ok(!fs.existsSync(marker));
  // one JSON document and nothing else on stdout
  for (const r of [s, f, bad]) assert.doesNotThrow(() => JSON.parse(r.stdout));
});
