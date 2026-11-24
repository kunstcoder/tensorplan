// A repo can carry symbolic links (git stores them, so does a zip): modelmap/ pointing at another folder, or a link inside
// it. scan.mjs, build.mjs, describe.mjs, open.mjs and serve.mjs must not write through one, and a refused run writes
// nothing. Everything runs in temporary folders; the "victim" folders stand for files elsewhere on the computer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { script, node, tmp, snapshot, hasPython } from './helpers-plugin.mjs';
import { FAKE_CLAUDE, buildMap } from './helpers-ask.mjs';
import { fixture } from './helpers.mjs';

const skip = process.platform === 'win32' ? 'creating symbolic links needs privileges on Windows' : !hasPython && 'python3 (3.9+) is needed';
const MODEL = ['from torch import nn', 'class Net(nn.Module):', '    def __init__(self):', '        super().__init__()', '        self.fc = nn.Linear(4, 4)', ''].join('\n');
const link = (target, at) => fs.symlinkSync(target, at);
const REFUSED = /symbolic link|leads to/;

// one scan of the model file, made once and copied to <repo>/modelmap/.cache/scan.json (what scan.mjs writes there), so that
// the tests that need a scan before the link is put in do not each run python
let scanText = null;
function seedScan(w) {
  if (!scanText) {
    const out = tmp('modelmap-links-scan-');
    try { assert.equal(node(script('scan.mjs'), [w.root, '--out', out.dir]).status, 0); scanText = fs.readFileSync(path.join(out.dir, 'scan.json'), 'utf8'); } finally { out.done(); }
  }
  fs.mkdirSync(path.join(w.map, '.cache'), { recursive: true });
  fs.writeFileSync(path.join(w.map, '.cache', 'scan.json'), scanText);
}

/** <tmp>/repo (one model file), <tmp>/victim (holds .gitignore "keep-me"), <tmp>/secret.txt. */
function world() {
  const t = tmp('modelmap-links-');
  const root = path.join(t.dir, 'repo'), victim = path.join(t.dir, 'victim'), secret = path.join(t.dir, 'secret.txt');
  fs.mkdirSync(root); fs.mkdirSync(victim);
  fs.writeFileSync(path.join(root, 'm.py'), MODEL);
  fs.writeFileSync(path.join(victim, '.gitignore'), 'keep-me');
  fs.writeFileSync(secret, 'TOP SECRET');
  const map = path.join(root, 'modelmap');
  /** what is on disk outside the repo's own map folder, and in it: a refused run changes neither */
  const state = () => ({ victim: snapshot(victim), secret: fs.readFileSync(secret, 'utf8'), outside: fs.readdirSync(t.dir).sort(), map: fs.existsSync(map) && !fs.lstatSync(map).isSymbolicLink() ? snapshot(map) : null, repo: fs.readdirSync(root).sort() });
  return { ...t, root, victim, secret, map, state };
}

function refuses(w, name, args, label) {
  const before = w.state();
  const r = node(script(name), args);
  assert.equal(r.status, 1, label + ': ' + name + ' should refuse, said: ' + r.stdout + r.stderr);
  assert.match(r.stderr, REFUSED, label + ': ' + name);
  assert.deepEqual(w.state(), before, label + ': ' + name + ' wrote something');
  return r;
}

test('links: modelmap -> ../victim: scan, build and describe refuse, and the victim folder is byte-identical afterwards', { skip }, () => {
  const w = world();
  try {
    link('../victim', w.map);
    for (const name of ['scan.mjs', 'build.mjs', 'describe.mjs']) {
      const r = refuses(w, name, [w.root], 'modelmap -> ../victim');
      assert.match(r.stderr, new RegExp('✗ ' + w.map.replace(/[.*+?^$()|[\]\\/]/g, '\\$&') + ' is a symbolic link\\. modelmap will not write through it\\. Remove it, or choose a folder with --out\\.'));
    }
    assert.deepEqual(fs.readdirSync(w.victim), ['.gitignore']);
    assert.equal(fs.readFileSync(path.join(w.victim, '.gitignore'), 'utf8'), 'keep-me');
  } finally { w.done(); }
});

test('links: a real modelmap/ with a link inside it: each of .cache, descriptions, .gitignore, index.html, graph.json, query.mjs, serve.mjs, page-safety.mjs is refused, and nothing outside it is written', { skip }, () => {
  const plants = [
    // [name inside modelmap/, what it points to, the script that would write through it]
    ['.cache', (w) => w.victim, 'scan.mjs'],
    ['.cache', (w) => w.victim, 'build.mjs'],
    ['.cache', (w) => w.victim, 'describe.mjs'],
    ['.cache/scan.json', (w) => path.join(w.victim, 'scan.json'), 'scan.mjs'],
    ['.cache/worksheet.md', (w) => w.secret, 'describe.mjs'],
    ['descriptions', (w) => w.victim, 'build.mjs'],
    ['.gitignore', (w) => path.join(w.victim, '.gitignore'), 'build.mjs'],
    ['index.html', (w) => w.secret, 'build.mjs'],
    ['graph.json', (w) => w.secret, 'build.mjs'],
    ['query.mjs', (w) => w.secret, 'build.mjs'],
    ['serve.mjs', (w) => w.secret, 'build.mjs'],
    ['page-safety.mjs', (w) => w.secret, 'build.mjs'],
    ['index.html', () => path.join('..', 'no-such-file'), 'build.mjs'], // broken link
  ];
  for (const [name, to, script_] of plants) {
    const w = world();
    try {
      seedScan(w); // the normal flow first: the scan is in modelmap/.cache
      const at = path.join(w.map, name);
      fs.rmSync(at, { recursive: true, force: true });
      link(to(w), at);
      refuses(w, script_, [w.root], name + ' (' + script_ + ')');
    } finally { w.done(); }
  }
});

test('links: a link to a file or folder inside the map folder is refused as well (no symbolic links at all)', { skip }, () => {
  const w = world();
  try {
    seedScan(w);
    fs.writeFileSync(path.join(w.map, 'notes.txt'), 'inside');
    fs.mkdirSync(path.join(w.map, 'real-descriptions'));
    link('notes.txt', path.join(w.map, 'graph.json'));
    refuses(w, 'build.mjs', [w.root], 'graph.json -> notes.txt');
    fs.rmSync(path.join(w.map, 'graph.json'));
    link('real-descriptions', path.join(w.map, 'descriptions'));
    refuses(w, 'build.mjs', [w.root], 'descriptions -> real-descriptions');
  } finally { w.done(); }
});

test('links: open.mjs does not start the server or write its log through a link in .cache', { skip }, () => {
  const w = world();
  try {
    fs.mkdirSync(w.map);
    fs.writeFileSync(path.join(w.map, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(w.map, 'serve.mjs'), 'process.exit(0);\n'); // a stand-in: the real server is never started here
    link(w.victim, path.join(w.map, '.cache'));
    refuses(w, 'open.mjs', [w.root, '--no-open'], '.cache -> victim (open)');
  } finally { w.done(); }
});

test('links: the normal flow (no links) works in the default place: scan, describe, build, and a second build over the first', { skip }, () => {
  const w = world();
  try {
    for (const name of ['scan.mjs', 'describe.mjs', 'build.mjs', 'build.mjs']) {
      const r = node(script(name), [w.root]);
      assert.equal(r.status, 0, name + ': ' + r.stderr);
    }
    for (const f of ['.cache/scan.json', '.cache/worksheet.md', 'graph.json', 'index.html', 'query.mjs', 'serve.mjs', 'page-safety.mjs']) assert.ok(fs.existsSync(path.join(w.map, f)), f);
    assert.equal(fs.readFileSync(path.join(w.map, '.gitignore'), 'utf8'), '*\n');
    assert.ok(fs.existsSync(path.join(w.map, 'descriptions')));
    assert.deepEqual(fs.readdirSync(w.victim), ['.gitignore']);
  } finally { w.done(); }
});

test('links: --out <folder> still works, also when the folder itself is a link (the person chose it); a link inside it is still refused', { skip }, () => {
  const w = world();
  try {
    const real = path.join(w.dir, 'chosen'), viaLink = path.join(w.dir, 'chosen-link');
    fs.mkdirSync(real);
    link(real, viaLink);
    // scan.json goes to the folder itself; build and describe use it as the map folder
    let r = node(script('scan.mjs'), [w.root, '--out', viaLink]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(real, 'scan.json')));
    r = node(script('scan.mjs'), [w.root, '--out', path.join(real, '.cache')]);
    assert.equal(r.status, 0, r.stderr);
    for (const [name, args] of [['describe.mjs', [w.root, '--out', viaLink]], ['build.mjs', [w.root, '--out', viaLink]]]) {
      r = node(script(name), args);
      assert.equal(r.status, 0, name + ': ' + r.stderr);
    }
    assert.ok(fs.existsSync(path.join(real, 'graph.json')) && fs.existsSync(path.join(real, 'index.html')));
    assert.deepEqual(fs.readdirSync(w.root).sort(), ['m.py'], 'nothing was written into the repo');
    // a link inside the chosen folder is refused
    fs.rmSync(path.join(real, 'index.html'));
    link(w.secret, path.join(real, 'index.html'));
    refuses(w, 'build.mjs', [w.root, '--out', viaLink], '--out folder with index.html -> secret');
    fs.rmSync(path.join(real, 'scan.json'));
    link(w.secret, path.join(real, 'scan.json'));
    refuses(w, 'scan.mjs', [w.root, '--out', real], '--out folder with scan.json -> secret');
  } finally { w.done(); }
});

test('links: serve.mjs refuses to start when index.html, graph.json, query.mjs, .cache or custom-flows.json in the map folder is a symbolic link', { skip }, () => {
  const { map: built } = buildMap(fixture('mini-model'));
  for (const name of ['index.html', 'graph.json', 'query.mjs', '.cache', 'custom-flows.json']) {
    const w = world();
    try {
      const copy = path.join(w.dir, 'modelmap');
      fs.cpSync(built, copy, { recursive: true, filter: (f) => !f.includes(path.sep + '.cache') });
      const at = path.join(copy, name);
      fs.rmSync(at, { recursive: true, force: true });
      link(name === '.cache' ? w.victim : w.secret, at);
      const before = { victim: snapshot(w.victim), secret: fs.readFileSync(w.secret, 'utf8') };
      // the fake CLI only: the real claude is never started
      const r = spawnSync(process.execPath, [path.join(copy, 'serve.mjs'), '--claude', FAKE_CLAUDE, '--no-open', '--port', '0'], { encoding: 'utf8', timeout: 20000, cwd: w.dir });
      assert.equal(r.status, 1, name + ': serve.mjs should refuse, said: ' + r.stdout + r.stderr);
      assert.match(r.stderr, new RegExp('✗ .*' + name.replace('.', '\\.') + ' is a symbolic link\\. modelmap will not serve or write through it'));
      assert.doesNotMatch(r.stdout, /modelmap: http/);
      assert.deepEqual({ victim: snapshot(w.victim), secret: fs.readFileSync(w.secret, 'utf8') }, before);
    } finally { w.done(); }
  }
});
