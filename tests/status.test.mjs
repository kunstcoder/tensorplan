// status.mjs (states none | unbuilt | map, the git comparison, never writes), lib/claudemd.mjs (writes only
// what its options allow), lib/common.mjs (the helpers it gained and the exports that must not change),
// agent.mjs's MODELMAP_AGENT and open.mjs without a built map. Everything runs in temporary folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { script, node, tmp, snapshot, gitIn, hasGit, repo } from './helpers-plugin.mjs';
import { writeClaudeMd, START, END } from '../skills/modelmap/scripts/lib/claudemd.mjs';
import * as common from '../skills/modelmap/scripts/lib/common.mjs';
import { detectAgent } from '../skills/modelmap/scripts/lib/agent.mjs';

const STATUS = script('status.mjs');
const status = (dir, ...extra) => node(STATUS, [dir, ...extra]);
const statusJson = (dir, ...extra) => { const r = status(dir, '--json', ...extra); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
const skipNoGit = hasGit ? false : 'git is not installed';
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };
const graph = (meta = {}) => ({ schema: 'modelmap/graph@1', meta: { generatedAt: '2026-11-21T00:00:00.000Z', rootName: 'Net', root: 'net', agent: 'claude', counts: { modules: 62, params: 18740, unknownParts: 2 }, ...meta }, project: { name: 'net', summary: '' }, nodes: [{ id: 'root' }], files: [], routes: [], links: [], flows: [], tour: [] });

test('status: an empty folder is state none (text and --json with state and text), and status writes nothing', () => {
  const t = tmp();
  try {
    const r = status(t.dir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'none: no model map here yet (fresh run).');
    const j = statusJson(t.dir);
    assert.equal(j.schema, 'modelmap/status-result@1');
    assert.equal(j.state, 'none');
    assert.equal(j.text, 'none: no model map here yet (fresh run).');
    assert.deepEqual(snapshot(t.dir), {});
  } finally { t.done(); }
});

test('status: a scan.json without graph.json is state unbuilt and names the scanned class', () => {
  const t = tmp();
  try {
    writeJson(path.join(t.dir, 'modelmap', '.cache', 'scan.json'), { root: { cls: 'Net' }, meta: { generatedAt: '2026-11-21T01:02:03.000Z' } });
    const before = snapshot(t.dir);
    const j = statusJson(t.dir);
    assert.equal(j.state, 'unbuilt');
    assert.equal(j.rootClass, 'Net');
    assert.match(j.text, /^unbuilt: a scan of Net \(2026-11-21T01:02:03\.000Z\) is in modelmap\/\.cache\/scan\.json but no map was built/);
    assert.deepEqual(snapshot(t.dir), before);
  } finally { t.done(); }
});

test('status: --out points at a map folder elsewhere', () => {
  const t = tmp();
  try {
    writeJson(path.join(t.dir, 'elsewhere', 'graph.json'), graph());
    assert.equal(statusJson(t.dir).state, 'none');
    assert.equal(statusJson(t.dir, '--out', path.join(t.dir, 'elsewhere')).state, 'map');
  } finally { t.done(); }
});

test('status: a built map is state map with its counts, and an unreadable graph.json gives state unknown without failing', () => {
  const t = tmp();
  try {
    writeJson(path.join(t.dir, 'modelmap', 'graph.json'), graph());
    const j = statusJson(t.dir);
    assert.equal(j.state, 'map');
    assert.deepEqual([j.rootName, j.modules, j.params, j.unknownParts], ['Net', 62, 18740, 2]);
    assert.match(j.text, /^map of Net built 2026-11-21T00:00:00\.000Z: 62 modules, 18,740 parameters \(≥, 2 unknown parts\)\./);
    assert.match(j.text, /the map records no git commit/);
    fs.writeFileSync(path.join(t.dir, 'modelmap', 'graph.json'), '{ broken');
    const r = status(t.dir, '--json');
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).state, 'unknown');
  } finally { t.done(); }
});

test('status: compares the commit the map was built from with HEAD (same commit, files changed since, uncommitted) and writes nothing, .git included', { skip: skipNoGit }, () => {
  const t = tmp();
  try {
    gitIn(t.dir, 'init', '-q');
    fs.writeFileSync(path.join(t.dir, 'model.py'), 'x = 1\n');
    gitIn(t.dir, 'add', 'model.py');
    gitIn(t.dir, 'commit', '-q', '-m', 'one');
    const head = gitIn(t.dir, 'rev-parse', 'HEAD');
    writeJson(path.join(t.dir, 'modelmap', 'graph.json'), graph({ repos: [{ path: '.', head }] }));
    fs.writeFileSync(path.join(t.dir, 'modelmap', '.gitignore'), '*\n');
    let j = statusJson(t.dir);
    assert.deepEqual(j.repos, [{ path: '.', compared: true, sameCommit: true, changedFiles: 0, uncommitted: 0 }]);
    fs.writeFileSync(path.join(t.dir, 'model.py'), 'x = 2\n');
    gitIn(t.dir, 'commit', '-q', '-am', 'two');
    fs.writeFileSync(path.join(t.dir, 'new.py'), '');
    const before = snapshot(t.dir, { withGit: true });
    j = statusJson(t.dir);
    assert.deepEqual(j.repos, [{ path: '.', compared: true, sameCommit: false, changedFiles: 1, uncommitted: 1 }]);
    assert.match(j.text, /\.: 1 file\(s\) changed since [0-9a-f]{7}, 1 uncommitted\n {4}e\.g\. model\.py/);
    assert.deepEqual(snapshot(t.dir, { withGit: true }), before, 'status changed a file (the git index?)');
    // meta.head alone works too
    writeJson(path.join(t.dir, 'modelmap', 'graph.json'), graph({ head }));
    assert.equal(statusJson(t.dir).repos[0].changedFiles, 1);
  } finally { t.done(); }
});

// ---------- claudemd.mjs ----------

function project(withGit = true) {
  const t = tmp();
  if (withGit && hasGit) gitIn(t.dir, 'init', '-q');
  return t;
}
const local = (t) => path.join(t.dir, 'CLAUDE.local.md');
const exclude = (t) => fs.readFileSync(path.join(t.dir, '.git', 'info', 'exclude'), 'utf8');

test('claudemd: with no options it writes nothing at all (no CLAUDE.local.md, no .git/info/exclude change) and says it was not added', { skip: skipNoGit }, () => {
  const t = project();
  try {
    const before = snapshot(t.dir, { withGit: true });
    const r = writeClaudeMd(t.dir, path.join(t.dir, 'modelmap'));
    assert.match(r, /^not added \(offer it to the user/);
    assert.deepEqual(snapshot(t.dir, { withGit: true }), before);
  } finally { t.done(); }
});

test('claudemd: add writes the block between <!-- modelmap:start --> and <!-- modelmap:end --> and leaves .git/info/exclude alone unless exclude is given', { skip: skipNoGit }, () => {
  const t = project();
  try {
    const ex = exclude(t);
    assert.match(writeClaudeMd(t.dir, path.join(t.dir, 'modelmap'), { add: true }), /^created CLAUDE\.local\.md$/);
    const text = fs.readFileSync(local(t), 'utf8');
    assert.ok(text.startsWith(START) && text.trimEnd().endsWith(END));
    assert.match(text, /node modelmap\/query\.mjs overview/);
    assert.doesNotMatch(text, /floorplan/i);
    assert.equal(exclude(t), ex, 'exclude untouched');
    assert.match(writeClaudeMd(t.dir, path.join(t.dir, 'modelmap'), { add: true, exclude: true }), /CLAUDE\.local\.md unchanged; ignored locally via \.git\/info\/exclude/);
    assert.match(exclude(t), /# personal Claude Code notes \(added by modelmap\)\n\/CLAUDE\.local\.md\n$/);
  } finally { t.done(); }
});

test('claudemd: an existing block is rewritten only with refresh or add, in place, keeping the rest of the file; <!-- modelmap:off --> opts out', { skip: skipNoGit }, () => {
  const t = project();
  try {
    fs.writeFileSync(local(t), 'my notes\n\n' + START + '\nold text\n' + END + '\n\ntail\n');
    const before = fs.readFileSync(local(t), 'utf8');
    assert.match(writeClaudeMd(t.dir, path.join(t.dir, 'modelmap')), /has a modelmap block; not rewritten/);
    assert.equal(fs.readFileSync(local(t), 'utf8'), before);
    assert.match(writeClaudeMd(t.dir, path.join(t.dir, 'modelmap'), { refresh: true }), /^updated CLAUDE\.local\.md$/);
    const after = fs.readFileSync(local(t), 'utf8');
    assert.ok(after.startsWith('my notes\n\n' + START) && after.endsWith(END + '\n\ntail\n'));
    assert.doesNotMatch(after, /old text/);
    fs.writeFileSync(local(t), 'x\n<!-- modelmap:off -->\n');
    assert.match(writeClaudeMd(t.dir, path.join(t.dir, 'modelmap'), { add: true }), /^skipped \(opted out\)/);
    assert.equal(fs.readFileSync(local(t), 'utf8'), 'x\n<!-- modelmap:off -->\n');
  } finally { t.done(); }
});

test('claudemd: a block in CLAUDE.md is removed only with removeOld, keeping the rest of CLAUDE.md', { skip: skipNoGit }, () => {
  const t = project();
  try {
    const md = path.join(t.dir, 'CLAUDE.md');
    fs.writeFileSync(md, '# Project\n\n' + START + '\nold\n' + END + '\n');
    writeClaudeMd(t.dir, path.join(t.dir, 'modelmap'), { add: true });
    assert.match(fs.readFileSync(md, 'utf8'), /modelmap:start/, 'kept without removeOld');
    const r = writeClaudeMd(t.dir, path.join(t.dir, 'modelmap'), { removeOld: true });
    assert.match(r, /moved the modelmap section out of CLAUDE\.md/);
    assert.equal(fs.readFileSync(md, 'utf8'), '# Project\n');
  } finally { t.done(); }
});

test('claudemd: a map folder outside the codebase is skipped', () => {
  const t = tmp();
  try {
    assert.match(writeClaudeMd(path.join(t.dir, 'a'), path.join(t.dir, 'b')), /^skipped \(map is outside the codebase\)/);
    assert.deepEqual(snapshot(t.dir), {});
  } finally { t.done(); }
});

// ---------- common.mjs ----------

test('common: keepOutOfGit writes <dir>/.gitignore holding "*", returns null when git tracks nothing there, and a warning with the untrack command when it does', { skip: skipNoGit }, () => {
  const t = project();
  try {
    const dir = path.join(t.dir, 'modelmap');
    assert.equal(common.keepOutOfGit(dir), null);
    assert.ok(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').split('\n').includes('*'));
    fs.writeFileSync(path.join(dir, 'graph.json'), '{}');
    gitIn(t.dir, 'add', '-f', 'modelmap/graph.json');
    gitIn(t.dir, 'commit', '-q', '-m', 'tracked by mistake');
    assert.match(common.keepOutOfGit(dir), /^1 file\(s\) in modelmap\/ were committed to git before; they stay tracked until you run: git rm -r --cached modelmap/);
  } finally { t.done(); }
});

test('common: git() returns trimmed output or null, isMapDir knows graph.json, .cache and descriptions, printJson is exported', { skip: skipNoGit }, () => {
  const t = project();
  try {
    assert.equal(common.git(t.dir, ['rev-parse', '--is-inside-work-tree']), 'true');
    assert.equal(common.git(t.dir, ['rev-parse', 'HEAD']), null, 'no commit yet');
    assert.equal(common.gitRun(t.dir, ['no-such-command']).out, null);
    assert.equal(common.isMapDir(t.dir), false);
    fs.mkdirSync(path.join(t.dir, 'descriptions'));
    assert.equal(common.isMapDir(t.dir), true);
    assert.equal(typeof common.printJson, 'function');
  } finally { t.done(); }
});

test('common: MODELMAP_UNATTENDED and --unattended turn on unattended mode; agent.mjs reads MODELMAP_AGENT and ignores FLOORPLAN_AGENT', () => {
  assert.equal(common.isUnattended({}), false);
  assert.equal(common.isUnattended({ MODELMAP_UNATTENDED: '1' }), true);
  assert.equal(common.isUnattended({ FLOORPLAN_UNATTENDED: '1' }), false);
  const env = {};
  assert.equal(common.unattendedMode({ unattended: true }, env), true);
  assert.equal(env.MODELMAP_UNATTENDED, '1');
  assert.equal(detectAgent({}, { MODELMAP_AGENT: 'codex' }), 'codex');
  assert.equal(detectAgent({}, { FLOORPLAN_AGENT: 'codex' }), 'claude');
  assert.equal(detectAgent({}, { MODELMAP_UNATTENDED: '1' }), 'none');
});

test('common: the exports the scanner uses behave as before (MAP_DIR, mapDir, toPosix, fmtNum, readJsonFile, parseArgs, listPythonFiles)', () => {
  assert.equal(common.MAP_DIR, 'modelmap');
  assert.equal(common.mapDir('/r'), path.join('/r', 'modelmap'));
  assert.equal(common.toPosix(['a', 'b', 'c'].join(path.sep)), 'a/b/c');
  assert.equal(common.fmtNum(8751179), '8,751,179');
  const t = tmp();
  try {
    fs.writeFileSync(path.join(t.dir, 'a.json'), '﻿{"x":1}');
    assert.deepEqual(common.readJsonFile(path.join(t.dir, 'a.json')), { x: 1 });
  } finally { t.done(); }
  assert.deepEqual(common.parseArgs(['r', '--out', 'o', '--arg', 'a=1', '--arg=b=2', '--json', 'x'], { multi: ['arg'], flags: ['json'] }), { _: ['r', 'x'], out: 'o', arg: ['a=1', 'b=2'], json: true });
  assert.deepEqual(common.parseArgs(['--flag']), { _: [], flag: true });
  const l = common.listPythonFiles(path.join(repo, 'tests', 'fixtures', 'mini-model'));
  assert.deepEqual(l.files, ['model.py', 'tied.py']);
  assert.equal(l.truncated, false);
});

// ---------- open.mjs ----------

test('open: without a built map it prints "No built map" and exits 1; unattended it starts nothing and names modelmap/index.html', () => {
  const t = tmp();
  try {
    const r = node(script('open.mjs'), [t.dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No built map here yet\. Run build\.mjs first\./);
    const u = node(script('open.mjs'), [t.dir, '--unattended']);
    assert.equal(u.status, 0);
    assert.match(u.stdout, /modelmap\/index\.html/);
    assert.deepEqual(snapshot(t.dir), {});
  } finally { t.done(); }
});
