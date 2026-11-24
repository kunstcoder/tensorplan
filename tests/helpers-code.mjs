// Helpers for tests/trusted-code.test.mjs (R28): a map built once with the clock stopped, a reference build of the same scan, hostile files
// that write a marker file named after themselves when they are loaded or run, and a listing of a folder (bytes, modes, times) to show
// that a run touched nothing. Everything is made at run time in temporary folders and never committed. The fake CLI only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpDir, fixture, script, repo } from './helpers.mjs';
import { recordFile } from './helpers-trusted.mjs';
import { readServerRecord, verifiedStatus } from '../skills/modelmap/scripts/lib/common.mjs';

export const FOUR = ['index.html', 'query.mjs', 'serve.mjs', 'page-safety.mjs'];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const ASSETS = path.join(repo, 'skills', 'modelmap', 'assets');

/** A preload (node --require) that stops the clock: new Date() is always 2026-01-01, so two builds of one scan write the same graph.json. */
let freeze = null;
export function freezePreload() {
  if (!freeze) {
    const dir = tmpDir('modelmap-freeze-');
    freeze = path.join(dir, 'freeze.cjs');
    fs.writeFileSync(freeze, "const D = Date; const T0 = new D('2026-01-01T00:00:00.000Z').getTime();\nclass F extends D { constructor(...a) { if (a.length === 0) super(T0); else super(...a); } static now() { return T0; } }\nglobalThis.Date = F;\n");
    process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  }
  return freeze;
}
/** node [--require freeze] script args, in a way that returns { status, stdout, stderr }. */
export function nodeRun(scriptPath, args, { frozen = false, env, cwd } = {}) {
  const r = spawnSync(process.execPath, [...(frozen ? ['--require', freezePreload()] : []), scriptPath, ...args], { encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env, cwd });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

let gold = null;
/**
 * The mini-model fixture scanned and built once (clock stopped): { root, map }, and in { ref } a folder built from a copy of the same
 * scan the same way, in another place: the four files in it are what any run of this plugin has to leave in the map folder.
 */
export function golden() {
  if (!gold) {
    const base = tmpDir('modelmap-code-');
    process.on('exit', () => fs.rmSync(base, { recursive: true, force: true }));
    const root = path.join(base, 'repo'), map = path.join(root, 'modelmap'), ref = path.join(base, 'ref');
    fs.cpSync(fixture('mini-model'), root, { recursive: true });
    const step = (r, what) => { if (r.status !== 0) throw new Error(what + ' failed: ' + r.stderr); };
    step(nodeRun(script('scan.mjs'), [root, '--out', path.join(map, '.cache')]), 'scan');
    step(nodeRun(script('build.mjs'), [root, '--out', map], { frozen: true }), 'build');
    fs.mkdirSync(path.join(ref, '.cache'), { recursive: true });
    fs.copyFileSync(path.join(map, '.cache', 'scan.json'), path.join(ref, '.cache', 'scan.json'));
    step(nodeRun(script('build.mjs'), [root, '--out', ref], { frozen: true }), 'reference build');
    gold = { base, root, map, ref };
  }
  return gold;
}
/** A copy of the golden repo in a folder of its own (no server record or log): { base, root, map, ref, marks, done }. */
export function copyGold() {
  const g = golden();
  const base = tmpDir('modelmap-code-run-');
  const root = path.join(base, 'repo');
  fs.cpSync(g.root, root, { recursive: true, filter: (f) => !/\.cache[\\/]server\.(json|log)$/.test(f) });
  const marks = path.join(base, 'marks');
  fs.mkdirSync(marks);
  return { base, root, map: path.join(root, 'modelmap'), ref: g.ref, marks, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

/**
 * Files a repo could commit under modelmap/, each of which writes a marker file named after itself into marks (an absolute path) when
 * it is loaded or run. serve.mjs and page-safety.mjs write it at the top; query.mjs writes 'query.mjs-core' in the part that serve.mjs
 * loads with new Function (and when it runs as a CLI), and 'query.mjs-cli' only when it runs as a CLI; index.html is a page whose script
 * would phone a counting stand-in (it is only fetched in a test, never run in a browser: the served bytes are checked). The query.mjs and
 * page-safety.mjs still work like the real ones (they are the real ones plus the marker), so a plugin that loaded them would show it.
 */
export function hostileFiles(marks, { beacon = 'http://127.0.0.1:9/beacon', queryText = fs.readFileSync(path.join(golden().map, 'query.mjs'), 'utf8') } = {}) {
  const mark = (name) => JSON.stringify(path.join(marks, name));
  const dyn = (name) => "import('node:fs').then((fs) => fs.writeFileSync(" + mark(name) + ", 'ran'));\n";
  return {
    'serve.mjs': "import fs from 'node:fs';\nfs.writeFileSync(" + mark('serve.mjs') + ", 'ran as ' + process.argv.slice(2).join(' '));\nprocess.exit(0);\n",
    'page-safety.mjs': dyn('page-safety.mjs') + fs.readFileSync(path.join(ASSETS, 'page-safety.mjs'), 'utf8'),
    'query.mjs': dyn('query.mjs-core') + queryText + '\n' + dyn('query.mjs-cli'),
    'index.html': '<!doctype html><html><head><meta charset="utf-8"><title>HOSTILE-PAGE-SENTINEL</title></head><body>HOSTILE-PAGE-SENTINEL<script>fetch(' + JSON.stringify(beacon) + ')</script></body></html>\n',
  };
}
/** Writes the hostile files into dir (a read-only serve.mjs when readOnly). */
export function plantHostile(dir, files, { only = FOUR, readOnly = [] } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (const n of only) { fs.writeFileSync(path.join(dir, n), files[n]); if (readOnly.includes(n)) fs.chmodSync(path.join(dir, n), 0o444); }
}
export const markers = (marks) => fs.readdirSync(marks).sort();

/** Every file and folder under dir: { 'a/b': { sha, mtimeMs, mode, size } }, folders as 'a/' with their times. A link is its target text. */
export function tree(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name), st = fs.lstatSync(p), r = rel + e.name;
      if (e.isDirectory()) { out[r + '/'] = { mtimeMs: st.mtimeMs, mode: st.mode }; walk(p, r + '/'); }
      else out[r] = { sha: e.isSymbolicLink() ? 'link:' + fs.readlinkSync(p) : crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'), mtimeMs: st.mtimeMs, mode: st.mode, size: st.size };
    }
  };
  walk(dir, '');
  return out;
}
export const same = (a, b) => fs.readFileSync(a).equals(fs.readFileSync(b));

/** Stops the server that open.mjs started for this map: only when its record is valid and the server itself answers for this map. */
export async function stopMap(map) {
  const rec = readServerRecord(recordFile(map)).rec;
  if (!rec) return;
  const st = await verifiedStatus(rec, path.dirname(map));
  if (!st) return;
  try { process.kill(rec.pid); } catch { return; }
  for (let t = 0; t < 4000; t += 100) { try { process.kill(rec.pid, 0); } catch { return; } await sleep(100); }
}
/** GET path of the map's server with its record's token (or none): { status, body }. */
export async function get(map, p, { token = true } = {}) {
  const rec = readServerRecord(recordFile(map)).rec;
  const r = await fetch(rec.url + p, { headers: token ? { 'x-floorplan-token': rec.token } : {} });
  return { status: r.status, body: await r.text(), rec };
}
