import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasPython, fixture, tmpDir, at } from './helpers.mjs';
import { runScan, allNodes } from './helpers-scan.mjs';
import { loadConfig } from '../skills/modelmap/scripts/lib/config.mjs';

const opts = { skip: hasPython ? false : 'python3 (3.9 or newer) is not available' };
const fx = (f) => path.join(fixture('gpt-mini'), f);
const tmpFile = (name, text) => { const f = path.join(tmpDir(), name); fs.writeFileSync(f, text); return f; };

// ---- TinyGPT (tests/fixtures/gpt-mini/model.py) worked by hand with vocab 50, context 8, layers 2, width 16 ----
const lin = (i, o, bias = true) => i * o + (bias ? o : 0);
const layer = 2 * 16 + lin(16, 48) + lin(16, 16) + 2 * 16 + lin(16, 64) + lin(64, 16);   // 3,280
const TINY = 0 /* tok, tied to head */ + 8 * 16 /* pos */ + 2 * layer + 2 * 16 /* norm */ + lin(16, 50, false) /* head */;

test('json: a file, a BOM, a key', () => {
  assert.deepEqual(loadConfig(fx('config.json')), { data: { vocab: 50, context: 8, layers: 2, width: 16, bias: true }, file: fx('config.json') });
  const bom = tmpFile('c.json', '\uFEFF{"model": {"dim": 4, "list": [1, {"x": 2}]}}');
  assert.deepEqual(loadConfig(bom).data, { model: { dim: 4, list: [1, { x: 2 }] } });
  assert.deepEqual(loadConfig(bom, { key: 'model' }).data, { dim: 4, list: [1, { x: 2 }] });
  assert.equal(loadConfig(bom, { key: 'model.list.1.x' }).data, 2);
  assert.equal(loadConfig(bom).lines, undefined, 'JSON gives no lines');
});

test('yaml: values and their lines, a nested key', () => {
  const c = loadConfig(fx('config.yaml'));
  assert.deepEqual(c.data, { vocab: 50, context: 8, layers: 2, width: 16, bias: true });
  assert.deepEqual(c.lines, { vocab: 2, context: 3, layers: 4, width: 5, bias: 6 });
  const n = loadConfig(fx('nested.yaml'), { key: 'model.tiny' });
  assert.deepEqual(n.data, { vocab: 50, context: 8, layers: 2, width: 16, bias: true });
  assert.deepEqual(n.lines, { vocab: 6, context: 7, layers: 8, width: 9, bias: 10 });
  assert.equal(loadConfig(tmpFile('a.yml', 'x: 1\n')).data.x, 1, '.yml works too');
});

test('errors are returned, never thrown', () => {
  assert.match(loadConfig(fx('nested.yaml'), { key: 'model.big' }).error, /no section "model.big" \(stopped at "big"\)/);
  assert.match(loadConfig(fx('config.yaml'), { key: 'vocab.x' }).error, /no section/);
  assert.match(loadConfig(path.join(tmpDir(), 'none.yaml')).error, /not found/);
  assert.match(loadConfig(tmpDir() + '/x.json').error, /not found/);
  const dir = path.join(tmpDir(), 'd.json'); fs.mkdirSync(dir);
  assert.match(loadConfig(dir).error, /not a file/);
  assert.match(loadConfig(tmpFile('c.toml', 'a = 1')).error, /must end in .json, .yaml or .yml/);
  assert.match(loadConfig(tmpFile('c.json', '{"a": ')).error, /not valid JSON/);
  assert.match(loadConfig(tmpFile('c.yaml', 'a: 1\nb: &x 2\n')).error, /at line 2: anchors and aliases/);
  assert.match(loadConfig(tmpFile('big.json', '"' + 'x'.repeat(1024 * 1024 + 10) + '"')).error, /larger than 1 MB/);
  assert.doesNotThrow(() => loadConfig(null));
  assert.ok(loadConfig(undefined).error);
});

test('a scan with a config.yaml: totals and every value tagged config with file:line', opts, () => {
  const r = runScan(fixture('gpt-mini'), ['--config', fx('config.yaml')]);
  assert.equal(r.status, 0, r.stderr);
  const s = r.json;
  assert.equal(TINY, 7520);
  assert.equal(s.root.cls, 'TinyGPT');
  assert.equal(s.root.params.v, TINY);
  assert.equal(s.root.params.lowerBound, undefined);
  assert.equal(s.root.params.src, 'config');
  assert.deepEqual(s.config, { file: 'config.yaml', arg: 'cfg' });
  const qkv = at(s.root, 'body.layers.0.attn.qkv');
  assert.deepEqual(qkv.pos[0], { v: 16, src: 'config', at: 'config.yaml:5' });
  assert.deepEqual(qkv.pos[1], { v: 48, src: 'config', at: 'config.yaml:5' }, '3 * cfg.width stays tagged');
  assert.equal(qkv.kw.bias.src, undefined, 'bool values are not tracked');
  assert.deepEqual(at(s.root, 'body.tok').pos[0], { v: 50, src: 'config', at: 'config.yaml:2' });
  assert.equal(at(s.root, 'body.layers.0.norm1').params.src, 'config', 'nn.Parameter(torch.ones(width)) is tagged');
  assert.equal(at(s.root, 'body.layers').children.length, 2, 'range(cfg.layers) unrolls');
  for (const n of allNodes(s.root)) if (n.params.v > 0) assert.equal(n.params.src, 'config', n.path);
  assert.match(r.stdout, /PARAMS {2}7,520 {2}\[config\]/);
  assert.match(r.stdout, /CONFIG {2}config\.yaml {2}-> argument cfg of TinyGPT/);
});

test('the same config as JSON gives the same total; a nested section is picked with --config-key', opts, () => {
  const j = runScan(fixture('gpt-mini'), ['--config', fx('config.json'), '--json']).json;
  assert.equal(j.root.params.v, TINY);
  assert.equal(j.root.params.src, 'config');
  assert.deepEqual(at(j.root, 'body.tok').pos[0], { v: 50, src: 'config', at: 'config.json' });
  const n = runScan(fixture('gpt-mini'), ['--config', fx('nested.yaml'), '--config-key', 'model.tiny']);
  assert.equal(n.json.root.params.v, TINY);
  assert.deepEqual(n.json.config, { file: 'nested.yaml', arg: 'cfg', key: 'model.tiny' });
  assert.equal(at(n.json.root, 'body.tok').pos[0].at, 'nested.yaml:6');
  assert.match(n.stdout, /CONFIG {2}nested\.yaml \(key model\.tiny\)/);
});

test('--config-arg names the parameter; ** passes the keys; no guess when nothing fits', opts, () => {
  const named = runScan(fixture('gpt-mini'), ['--config', fx('config.yaml'), '--config-arg', 'cfg', '--json']).json;
  assert.equal(named.root.params.v, TINY);
  const star = runScan(fixture('gpt-mini'), ['--root-class', 'Wide', '--config', fx('wide.json'), '--config-arg', '**']);
  assert.equal(star.json.root.params.v, 3 * lin(4, 4));
  assert.equal(star.json.root.params.src, 'config');
  assert.deepEqual(star.json.root.args.depth, { v: 3, src: 'config', at: 'wide.json' });
  const none = runScan(fixture('gpt-mini'), ['--root-class', 'Wide', '--config', fx('wide.json')]);
  assert.equal(none.status, 0);
  assert.equal(none.json.config.arg, null);
  assert.match(none.json.config.note, /no parameter of Wide.__init__ looks like a config/);
  assert.match(none.stdout, /CONFIG {2}wide\.json {2}not used: no parameter/);
  assert.equal(none.json.root.params.lowerBound, true, 'width stays unknown: the scan does not guess');
  const wrong = runScan(fixture('gpt-mini'), ['--config', fx('config.yaml'), '--config-arg', 'nope', '--json']);
  assert.match(wrong.json.config.note, /has no parameter nope/);
  assert.match(wrong.stderr, /config: TinyGPT.__init__ has no parameter nope/);
});

test('bad config flags stop the scan with a message', opts, () => {
  const a = runScan(fixture('gpt-mini'), ['--config', fx('missing.yaml')]);
  assert.equal(a.status, 1);
  assert.match(a.stderr, /config file not found/);
  const b = runScan(fixture('gpt-mini'), ['--config-key', 'model']);
  assert.equal(b.status, 1);
  assert.match(b.stderr, /need --config FILE/);
  const c = runScan(fixture('gpt-mini'), ['--config', fx('config.yaml'), '--config-key', 'x.y']);
  assert.equal(c.status, 1);
  assert.match(c.stderr, /no section "x.y"/);
});
