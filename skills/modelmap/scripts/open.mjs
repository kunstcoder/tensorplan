#!/usr/bin/env node
// Derived from floorplan v0.11.0 (MIT): skills/floorplan/scripts/open.mjs
// Show the map to the user after a build or refresh. First it makes the map folder's index.html, query.mjs, serve.mjs and
// page-safety.mjs what this plugin writes (lib/mapfiles.mjs): the folder can come with a repo, so a file found there is data,
// never code to run or a page to serve. Then it reuses this map's server if it's running (open tabs have already reloaded
// themselves), restarts it if its code (serve.mjs, query.mjs, page-safety.mjs) changed, otherwise starts it in the
// background and opens a browser tab. Prints the URL and how to stop it.
// usage: node open.mjs [root] [--out DIR] [--no-open] [--port N] [--engine claude|codex] [--model M] [--claude PATH] [--codex PATH]
//                      [--editor NAME|LINK]   (the editor "Open in editor" opens, e.g. cursor or "zed://file/{path}:{line}")
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs, mapDir, unattendedMode, refuseSymlinks, readServerRecord, verifiedStatus, SERVER_URL } from './lib/common.mjs';
import { MAP_FILES, writeMapFiles, codeHash, readGraphFile } from './lib/mapfiles.mjs';
import { editorTemplate } from '../assets/page-safety.mjs';
import { cliLabel } from './lib/agent.mjs';

const args = parseArgs(process.argv.slice(2), { flags: ['no-open', 'unattended'] });
const root = path.resolve(args._[0] || '.');
// unattended: nobody is there to look, so start nothing and open nothing
if (unattendedMode(args)) {
  console.log('Unattended mode: not starting the map\'s server or opening a browser. The map is modelmap/index.html; to look around in it with Ask, run node modelmap/serve.mjs in the repo, but only after build.mjs (or open.mjs without --unattended) has run on this computer: a modelmap/ that came with a repo is not trusted before that.');
  process.exit(0);
}
const dir = args.out ? path.resolve(String(args.out)) : mapDir(root);
const serveFile = path.join(dir, 'serve.mjs');
const stateFile = path.join(dir, '.cache', 'server.json');
const rel = path.relative(process.cwd(), dir).replace(/\\/g, '/') || '.';
const IDLE_MINUTES = 120;

// A repo can ship the map folder (or a file in it) as a symbolic link. Nothing in it is read as the map or written until no link is in
// the way (--out: the person chose the folder, so only what is inside is checked). The server's log and state go under .cache too.
refuseSymlinks(dir, ['graph.json', ...MAP_FILES, '.cache', path.join('.cache', 'server.log')].map((f) => path.join(dir, f)), { strict: !args.out });
// graph.json is data: it has to be a regular file that holds a map's graph, and that is all it is used for here
const graph = readGraphFile(path.join(dir, 'graph.json'));
if (!graph) {
  console.error('✗ No built map here yet. Run build.mjs first.');
  if (fs.existsSync(path.join(dir, 'graph.json'))) console.error(`  (${rel}/graph.json is not the graph of a built map: it needs a list of nodes and a project name)`);
  process.exit(1);
}

// --editor: checked here too, so a mistake is named now rather than in the server's log
const editor = args.editor === undefined ? null : editorTemplate(args.editor === true ? '' : String(args.editor));
if (editor?.error) { console.error(`✗ --editor ${editor.error}`); process.exit(1); }

// Everything under the map folder can be committed by the scanned repo, so what runs and what the browser gets is made by this plugin
// from graph.json, not found there: index.html, query.mjs, serve.mjs and page-safety.mjs are written here, before a server is looked
// for, started or restarted. A file that already is what the plugin writes is not touched (a second open changes nothing: no tab
// reloads, no restart); any other is replaced, and said so.
let mapFiles;
try { mapFiles = writeMapFiles(dir, graph, { onlyIfDifferent: true }); } catch (e) {
  console.error(`✗ Couldn't write the map's files in ${rel}/: ${e.message}`);
  process.exit(1);
}
for (const name of mapFiles.written) console.log(`NOTE  ${rel}/${name} ${mapFiles.missing.includes(name) ? 'was missing; wrote it' : 'was not what this plugin writes; replaced it'}`);
// what the running server's code (serve.mjs, query.mjs, page-safety.mjs) must be for it to be reused, the files that were just written
const hash = codeHash(mapFiles.files);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// .cache/server.json can be a file the scanned repo shipped. Nothing in it is used until the file and its values are checked
// (readServerRecord: a regular file of this user, an address that is exactly http://127.0.0.1:<port>) and the server it
// names has answered for this map with its token (verifiedStatus). A record that fails is stale: it is not requested, not
// opened, its pid is not killed, its port is not passed on, and a new server is started as if there was none.
// serve.mjs --stop makes the same checks (it keeps a copy of them).
const mapRoot = path.dirname(fs.realpathSync.native(dir)); // what serve.mjs reports as root: the folder that holds the map folder
// EPERM is a process of another user: not this map's server
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// only called with a record that passed the checks above
async function api(s, p) {
  try {
    const r = await fetch(s.url + p, { headers: { 'x-floorplan-token': s.token }, signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
function openBrowser(u) {
  if (!SERVER_URL.test(u)) return false; // only a map server's own address
  const [cmd, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', u]] : process.platform === 'darwin' ? ['open', [u]] : ['xdg-open', [u]];
  try { spawn(cmd, a, { stdio: 'ignore', detached: true, windowsHide: true }).unref(); return true; } catch { return false; }
}

const found = readServerRecord(stateFile);
let s = found.rec;
let status = s && alive(s.pid) ? await verifiedStatus(s, mapRoot) : null;
if (!status) s = null; // stale: nothing of it is used from here on
let restarted = false;
const hadTabs = status?.tabs > 0;

// newer code (serve.mjs, query.mjs or page-safety.mjs) came with this plugin, or a different --editor was asked for: restart so the
// map gets it; open tabs reconnect and reload
if (status && (status.hash !== hash || (editor?.template && status.editor !== editor.template))) {
  try { process.kill(s.pid); } catch {}
  for (let i = 0; i < 20 && alive(s.pid); i++) await sleep(150);
  status = null;
  restarted = true;
}

if (!status) {
  const pass = ['port', 'engine', 'model', 'claude', 'codex', 'editor'].flatMap((k) => (args[k] ? ['--' + k, String(args[k])] : []));
  if (!args.port && s?.port) pass.push('--port', String(s.port)); // keep the address people have open (s: the server just stopped, which was checked)
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  // serve.mjs will not start over a symbolic link at its record: take the link away (never what it points to)
  try { if (fs.lstatSync(stateFile).isSymbolicLink()) fs.unlinkSync(stateFile); } catch {}
  // The record found above is stale, or its server was just stopped: take it away too, so the new server, which writes its record only
  // when there is none (one server per map folder), does not have to judge it again. Only the file that was judged, and not when the
  // server of it (s: checked above, and sent the stop) is still running: it keeps its record, and the new server will find it there.
  if (found.raw !== null && !(s && alive(s.pid))) { try { if (fs.readFileSync(stateFile, 'utf8') === found.raw) fs.unlinkSync(stateFile); } catch {} }
  const log = fs.openSync(path.join(dir, '.cache', 'server.log'), 'w');
  const prev = s?.pid;
  const child = spawn(process.execPath, [serveFile, '--no-open', '--idle-exit', String(IDLE_MINUTES), ...pass], {
    cwd: root, detached: true, stdio: ['ignore', log, log], windowsHide: true,
  });
  child.unref();
  let exited = false;
  child.on('exit', () => { exited = true; });
  // finding the Claude Code or Codex CLI takes a few seconds before the server listens
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    // the new server's own record: not the one that was there before (a stale record is not read again), and it has to pass the same checks
    const n = readServerRecord(stateFile);
    if (n.rec && n.raw !== found.raw && n.rec.pid !== prev && alive(n.rec.pid)) {
      const st = await verifiedStatus(n.rec, mapRoot);
      if (st) { s = n.rec; status = st; break; }
    }
    // The server started here stopped by itself: serve.mjs does that, with a line in its log, when a server of this map is already
    // running (one per map folder; a start by hand raced this one). That server is the map's: if its record checks out, it is shown
    // as it is, and nothing says a new one was started. Otherwise this is the usual "didn't start" below, without waiting any longer.
    if (exited) {
      const o = readServerRecord(stateFile);
      const st = o.rec && alive(o.rec.pid) ? await verifiedStatus(o.rec, mapRoot) : null;
      if (st) { s = o.rec; status = st; }
      break;
    }
  }
  if (!status) {
    console.error(`✗ The map server didn't start. Its log is in ${rel}/.cache/server.log. The map still opens as a file: ${rel}/index.html`);
    process.exit(1);
  }
  // tabs from before a restart come back on their own within a few seconds
  if (restarted && hadTabs) for (let i = 0; i < 50 && !(status?.tabs > 0); i++) { await sleep(200); status = await api(s, '/api/status'); }
}

const health = await api(s, '/api/health');
let shown;
if (status.tabs > 0) shown = `already open in ${status.tabs === 1 ? 'a browser tab' : status.tabs + ' browser tabs'}, which reloaded with the latest map`;
else if (args['no-open']) shown = 'not opened in a browser (--no-open): open the URL yourself';
else shown = openBrowser(s.url) ? 'opened in the browser' : 'could not open a browser: open the URL yourself';

console.log(`MODELMAP  ${s.url}  (${shown})`);
const CLI = {
  claude: { name: 'the Claude Code CLI', docs: 'https://docs.claude.com/en/docs/claude-code' },
  codex: { name: 'Codex', docs: 'https://developers.openai.com/codex' },
};
console.log(health?.cli
  ? `ASK  works: questions run through ${cliLabel(health.engine, health.version)}${health.version ? ' (' + health.version + ')' : ''}`
  : `ASK  needs ${(CLI[health?.want] || CLI.claude).name}, which was not found; the map itself works (${(CLI[health?.want] || CLI.claude).docs})`);
// the file named here is the plugin's own copy: it was just written (or was already the same) by writeMapFiles above
console.log(`SERVER  runs in the background, updates open tabs when the map is rebuilt, and stops ${IDLE_MINUTES / 60} hours after the last tab closes. Stop it now: node ${rel}/serve.mjs --stop`);
