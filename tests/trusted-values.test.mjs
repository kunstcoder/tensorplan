// R24: status.mjs gave graph.json's meta.repos[].head and .path to git (head = "--output=<file>" wrote a file). A scanned repo is untrusted and
// can commit what is under <repo>/modelmap/; a value read from there must never become a git option or a path outside the repo without being
// checked first (UPSTREAM.md section 17). A real git repo is scanned and built in a temporary folder, graph.json is changed to carry each hostile
// value, and a PATH shim named git records every call, so "git ran with it" is a line in a log. The checks themselves: trusted-checks.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { script, node, fixture, hasPython, tmpDir } from './helpers.mjs';
import { gitIn, hasGit } from './helpers-plugin.mjs';
import { scanInto, build } from './helpers-build.mjs';
import { posixOnly, gitShim } from './helpers-trusted.mjs';

const skipStatus = posixOnly || (!hasGit && 'git is not installed') || (!hasPython && 'python3 (3.9+) is needed to scan');
const STATUS = script('status.mjs');

// ---------- R24: status.mjs ----------

/** A git repo with a model, scanned and built, so graph.json carries meta.repos with the real commit. */
function statusWorld() {
  const base = fs.realpathSync(tmpDir('modelmap-r24-'));
  const root = path.join(base, 'repo');
  fs.mkdirSync(root);
  fs.copyFileSync(path.join(fixture('mini-model'), 'model.py'), path.join(root, 'model.py'));
  gitIn(root, 'init', '-q');
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-q', '-m', 'one');
  const head = gitIn(root, 'rev-parse', 'HEAD');
  const map = path.join(root, 'modelmap');
  scanInto(root, [], map);
  const b = build(root, map);
  assert.equal(b.status, 0, b.stderr);
  const graphFile = path.join(map, 'graph.json');
  const g0 = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
  assert.equal(g0.meta.repos[0].head, head, 'build recorded the commit');
  // graph.json as the repo could have shipped it: the first repo entry changed
  const setRepo = (patch) => fs.writeFileSync(graphFile, JSON.stringify({ ...g0, meta: { ...g0.meta, repos: [{ ...g0.meta.repos[0], ...patch }] } }));
  const cwd = path.join(base, 'cwd');
  fs.mkdirSync(cwd);
  return { base, root, map, head, setRepo, cwd, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}
const pwned = (dirs) => dirs.flatMap((d) => fs.readdirSync(d, { recursive: true }).filter((n) => /PWNED/.test(String(n))).map((n) => path.join(d, String(n))));

test('R24 status: a commit id that is not lowercase hex of 7 to 64 characters is never given to git, the repo is "not compared" and nothing is written', { skip: skipStatus }, () => {
  const w = statusWorld();
  const shim = gitShim();
  try {
    const out = path.join(w.base, 'PWNED');
    const HEADS = [
      ['--output=<file>', '--output=' + out], ['--output=<file>, relative', '--output=PWNED'], ['--stat', '--stat'], ['-p', '-p'],
      ['uppercase hex', w.head.toUpperCase()], ['6 hex characters', w.head.slice(0, 6)], ['65 hex characters', w.head + 'a'.repeat(25)],
      ['a path', '../../etc/passwd'], ['an absolute path', '/etc/passwd'], ['an empty string', ''], ['a number', 1234567], ['true', true],
      ['an array', [w.head]], ['an object', { sha: w.head }], ['HEAD', 'HEAD'], ['HEAD~1', 'HEAD~1'], ['main', 'main'],
      ['a newline', w.head + '\n--output=' + out], ['a leading space', ' ' + w.head], ['a trailing newline', w.head + '\n'],
    ];
    for (const [name, head] of HEADS) {
      w.setRepo({ head });
      shim.reset();
      const r = node(STATUS, [w.root, '--json'], { cwd: w.cwd, env: { ...process.env, ...shim.env } });
      assert.equal(r.status, 0, name + ': ' + r.stderr);
      const j = JSON.parse(r.stdout);
      assert.equal(j.state, 'map', name);
      assert.deepEqual(j.repos, [{ path: '.', compared: false, reason: 'invalid commit' }], name);
      assert.match(j.text, /: not compared \(the commit the map recorded is not a valid commit id\)/, name);
      assert.ok(!j.text.includes('--output') && !j.text.includes('/etc/passwd'), name + ': the value is not echoed');
      assert.deepEqual(shim.calls(), [], name + ': git ran with a repo\'s value: ' + JSON.stringify(shim.calls()));
      assert.deepEqual(pwned([w.base, w.cwd, os.tmpdir() === w.base ? w.base : w.root]), [], name + ': a file was written');
    }
    assert.ok(!fs.existsSync(out));
    // no commit recorded (a map built without git) is not a hostile value: it is the old answer, and git only runs rev-parse HEAD
    w.setRepo({ head: null });
    shim.reset();
    const r = node(STATUS, [w.root, '--json'], { cwd: w.cwd, env: { ...process.env, ...shim.env } });
    assert.deepEqual(JSON.parse(r.stdout).repos, [{ path: '.', compared: false }]);
    // (git config --list is the hardening of lib/common.mjs gitRun, which runs once per folder)
    assert.deepEqual(shim.calls().map((c) => c.slice(-2).join(' ')).filter((c) => c !== '-z --show-scope'), ['rev-parse HEAD']);
  } finally { shim.done(); w.done(); }
});

test('R24 status: a path that is not a plain folder inside the repo is never used with git, the repo is "not compared" and nothing is written', { skip: skipStatus }, () => {
  const w = statusWorld();
  const shim = gitShim();
  try {
    // a folder inside the repo that is a link to a git repo outside it
    const outside = path.join(w.base, 'outside');
    fs.mkdirSync(outside);
    gitIn(outside, 'init', '-q');
    fs.writeFileSync(path.join(outside, 'x.py'), 'x = 1\n');
    gitIn(outside, 'add', '-A');
    gitIn(outside, 'commit', '-q', '-m', 'o');
    fs.symlinkSync(outside, path.join(w.root, 'outlink'));
    fs.mkdirSync(path.join(w.root, 'a'));
    fs.symlinkSync(outside, path.join(w.root, 'a', 'up'));
    const PATHS = [
      ['..', '..'], ['../..', '../..'], ['an absolute path', fs.realpathSync(os.tmpdir())], ['the root of the disk', '/'], ['-x', '-x'], ['--output=<file>', '--output=' + path.join(w.base, 'PWNED2')],
      ['--output=PWNED2', '--output=PWNED2'], ['a/../../b', 'a/../../b'], ['a\\..\\..\\b', 'a\\..\\..\\b'], ['a folder that is a link out', 'outlink'], ['a link out below a folder', 'a/up'],
      ['a drive letter', 'C:\\Windows'], ['a drive letter, no slash', 'C:'], ['a UNC path', '\\\\host\\share'], ['a NUL', 'a\u0000b'],
      ['a number', 5], ['an array', ['.']], ['an object', {}], ['true', true], ['a leading slash', '/a'],
    ];
    for (const [name, p] of PATHS) {
      w.setRepo({ path: p });
      shim.reset();
      const r = node(STATUS, [w.root, '--json'], { cwd: w.cwd, env: { ...process.env, ...shim.env } });
      assert.equal(r.status, 0, name + ': ' + r.stderr);
      const j = JSON.parse(r.stdout);
      assert.deepEqual(j.repos, [{ path: null, compared: false, reason: 'invalid path' }], name);
      assert.match(j.text, /: not compared \(the folder the map recorded is not a folder inside this repo\)/, name);
      assert.deepEqual(shim.calls(), [], name + ': git ran: ' + JSON.stringify(shim.calls()));
      assert.deepEqual(pwned([w.base, w.cwd]), [], name + ': a file was written');
    }
    // plain folders inside the repo are used: the root in its spellings, and a folder that is there
    fs.mkdirSync(path.join(w.root, 'sub'));
    for (const p of [undefined, '', '.', './', 'sub/..', 'a/..', 'sub', './sub/', 'sub/../sub', 'outlink/..']) {
      w.setRepo({ path: p });
      const j = JSON.parse(node(STATUS, [w.root, '--json'], { cwd: w.cwd }).stdout);
      assert.equal(j.repos[0].compared, true, JSON.stringify(p));
      assert.equal(j.repos[0].sameCommit, true, JSON.stringify(p));
    }
    // a folder that does not exist: git fails there, as before ("not a git repo now"), without an invalid path
    w.setRepo({ path: 'no-such-folder' });
    assert.deepEqual(JSON.parse(node(STATUS, [w.root, '--json'], { cwd: w.cwd }).stdout).repos, [{ path: 'no-such-folder', compared: false }]);
    // a map entry that is not an object at all
    for (const entry of [null, 'x', 5, ['.']]) {
      fs.writeFileSync(path.join(w.map, 'graph.json'), JSON.stringify({ meta: { rootName: 'Net', repos: [entry] }, nodes: [] }));
      const r = node(STATUS, [w.root, '--json'], { cwd: w.cwd, env: { ...process.env, ...shim.env } });
      assert.equal(r.status, 0);
      assert.equal(JSON.parse(r.stdout).repos[0].compared, false, JSON.stringify(entry));
    }
    assert.deepEqual(pwned([w.base, w.cwd]), []);
  } finally { shim.done(); w.done(); }
});

test('R24 status: a real map of a real git repo still shows "same commit", "N file(s) changed since <7 hex>" and the uncommitted count, and git gets the commit ids after --end-of-options and before --', { skip: skipStatus }, () => {
  const w = statusWorld();
  const shim = gitShim();
  const status = () => node(STATUS, [w.root], { cwd: w.cwd, env: { ...process.env, ...shim.env } }).stdout;
  try {
    assert.match(status(), /\n {2}\.: same commit\n/);
    fs.writeFileSync(path.join(w.root, 'model.py'), fs.readFileSync(path.join(w.root, 'model.py'), 'utf8') + '\n# changed\n');
    gitIn(w.root, 'commit', '-q', '-am', 'two');
    fs.writeFileSync(path.join(w.root, 'new.py'), '');
    shim.reset();
    const text = status();
    assert.match(text, /\n {2}\.: 1 file\(s\) changed since [0-9a-f]{7}, 1 uncommitted\n {4}e\.g\. model\.py\n/);
    assert.ok(text.includes('since ' + w.head.slice(0, 7)));
    const diff = shim.calls().find((c) => c.includes('diff'));
    assert.deepEqual(diff.slice(diff.indexOf('diff')), ['diff', '--name-only', '--end-of-options', w.head, gitIn(w.root, 'rev-parse', 'HEAD'), '--']);
  } finally { shim.done(); w.done(); }
});
