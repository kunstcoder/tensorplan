// Helpers for tests/trusted-values.test.mjs: a map folder a hostile repo could have committed (graph.json, .cache/server.json),
// a stand-in HTTP server on 127.0.0.1 that counts the requests it gets, a harmless child process that must stay alive,
// and PATH shims (git, open, xdg-open) that log their arguments and then run the real program or nothing.
// The real claude is never started: servers get --claude <fake> (tests/fixtures/fake-cli/fake-claude.mjs). All on port 0.
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { tmpDir, fixture, script, repo } from './helpers.mjs';
import { buildMap, FAKE_CLAUDE } from './helpers-ask.mjs';
import { readServerRecord } from '../skills/modelmap/scripts/lib/common.mjs';

export { FAKE_CLAUDE };
export const posixOnly = process.platform === 'win32' ? 'needs a POSIX sh, sleep and file owners' : false;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export const GOOD_TOKEN = 'ab12cd34ef56ab12cd34ef56ab12cd34';

/** Runs a node script without blocking this process (a child of ours may have to be reaped meanwhile). */
export function run(file, args = [], { env, cwd, timeout = 90000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [file, ...args], { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

/** Runs fn over items, n at a time. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  }));
  return out;
}

/** A HTTP server on 127.0.0.1, port 0, that counts what it is asked. answer(req, res, n) replies (default: 403). */
export async function standIn(answer = (req, res) => { res.writeHead(403); res.end(); }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, token: req.headers['x-floorplan-token'], host: req.headers.host });
    answer(req, res, requests.length);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port, requests,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
export const sendJson = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

/** A child process that does nothing for 60 seconds: what a hostile record names as "the server", which must never be killed. */
export function harmless() {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  return {
    pid: child.pid,
    alive: () => child.exitCode === null && child.signalCode === null && alive(child.pid),
    // true once it is gone (waits up to ms for the exit event)
    async gone(ms = 3000) { for (let t = 0; t < ms; t += 50) { if (child.exitCode !== null || child.signalCode !== null) return true; await sleep(50); } return false; },
    stop: () => { try { child.kill('SIGKILL'); } catch {} },
  };
}

let built = null;
/** A map of the mini-model fixture, built once; copyMap() gives each trial its own copy, without a server record or log. */
export function mapSource() {
  if (!built) {
    built = buildMap(fixture('mini-model'));
    process.on('exit', () => fs.rmSync(path.dirname(built.root), { recursive: true, force: true }));
  }
  return built;
}
export function copyMap() {
  const src = mapSource();
  const base = tmpDir('modelmap-trusted-');
  const root = path.join(base, 'repo');
  fs.cpSync(src.root, root, { recursive: true, filter: (f) => !/\.cache[\\/]server\.(json|log)$/.test(f) });
  const map = path.join(root, 'modelmap');
  return { base, root, map, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

export const recordFile = (map) => path.join(map, '.cache', 'server.json');
/** A record in the form serve.mjs writes, pointing at the stand-in on port P and naming pid C. extra replaces or adds fields. */
export const goodRecord = (P, C, extra = {}) => ({ pid: C, port: P, url: 'http://127.0.0.1:' + P, token: GOOD_TOKEN, hash: 'abcdef123456', startedAt: new Date().toISOString(), ...extra });
/** Writes the record file as a repo would ship it (a string is written as it is). */
export function plant(map, record, { mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(recordFile(map)), { recursive: true });
  fs.writeFileSync(recordFile(map), typeof record === 'string' ? record : JSON.stringify(record), { mode });
}

/** Stops the server that open.mjs started for this map, with serve.mjs --stop (which checks it), and waits for it to be gone. */
export async function stopServer(map) {
  const pid = readServerRecord(recordFile(map)).rec?.pid;
  // a map whose serve.mjs is a stand-in that runs the real one (serve.real.mjs): the real one is the one to ask
  const real = path.join(map, 'serve.real.mjs');
  await run(fs.existsSync(real) ? real : path.join(map, 'serve.mjs'), ['--stop']);
  for (let t = 0; pid && alive(pid) && t < 4000; t += 100) await sleep(100);
}

/** A PATH folder with scripts; env is what to give a child process so that they come first. */
export function shims(files) {
  const dir = tmpDir('modelmap-shim-');
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text, { mode: 0o755 });
  return { dir, log: path.join(dir, 'log'), env: { PATH: dir + path.delimiter + process.env.PATH }, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
/** A git that writes its arguments (each ended by NUL, each call by RS) to a log, then runs the real git. */
export function gitShim() {
  const real = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim().split('\n')[0];
  const probe = shims({});
  const log = probe.log;
  fs.writeFileSync(path.join(probe.dir, 'git'), "#!/bin/sh\n{ for a in \"$@\"; do printf '%s\\0' \"$a\"; done; printf '\\036'; } >> '" + log + "'\nexec '" + real + "' \"$@\"\n", { mode: 0o755 });
  return {
    ...probe,
    /** [[argv...], ...] of every git call so far */
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').split('\x1e').filter(Boolean).map((c) => c.split('\0').slice(0, -1)),
    reset: () => fs.rmSync(log, { force: true }),
  };
}
/** open and xdg-open that log their argument and do nothing else. */
export function openerShim() {
  const text = "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$(dirname \"$0\")/log\"\nexit 0\n";
  const s = shims({ open: text, 'xdg-open': text });
  return { ...s, urls: () => (fs.existsSync(s.log) ? fs.readFileSync(s.log, 'utf8') : '').split('\n').filter(Boolean) };
}
// ---------- a trial: one copy of a map, a stand-in server, a harmless child and a planted record, then open.mjs or serve.mjs --stop ----------
// the `hash` a server reports (and open.mjs compares): sha1 over the bytes of serve.mjs, query.mjs and page-safety.mjs of the map folder, in this order
export const codeHash12 = (map) => { const h = crypto.createHash('sha1'); for (const n of ['serve.mjs', 'query.mjs', 'page-safety.mjs']) h.update(fs.readFileSync(path.join(map, n))); return h.digest('hex').slice(0, 12); };

/**
 * A copy of the plugin (skills/modelmap) in a temporary folder, with the files in change replaced: { 'assets/serve.mjs': text, ... }, the
 * path from skills/modelmap, the text or a function from the old text to the new. A stand-in for another plugin version, or for a server
 * whose start can be watched: open.mjs of the copy writes the copy's assets/serve.mjs, query-cli.mjs and page-safety.mjs into a map folder.
 * The worktree's own files are never changed by a test.
 */
export function pluginCopy(change = {}) {
  const dir = tmpDir('modelmap-plugin-');
  const skill = path.join(dir, 'modelmap');
  fs.cpSync(path.join(repo, 'skills', 'modelmap'), skill, { recursive: true });
  for (const [file, text] of Object.entries(change)) {
    const f = path.join(skill, ...file.split('/'));
    fs.writeFileSync(f, typeof text === 'function' ? text(fs.readFileSync(f, 'utf8')) : text);
  }
  return { dir, skill, script: (name) => path.join(skill, 'scripts', name), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * One trial in its own copy of the map, with a stand-in server (port P), a harmless child (pid C) and the record that setup(ctx)
 * plants. Then open.mjs (--no-open, --port 0, the fake CLI) or serve.mjs --stop runs, and check(ctx) looks at what happened.
 * The server that open.mjs starts is stopped, the child killed, the stand-in closed.
 */
export async function trial({ kind = 'open', setup, answer, args = [], env, noPort = false, plugin }, check) {
  const w = copyMap();
  const child = harmless();
  const ctx = { w, child, C: child.pid, own: [], kind };
  const stand = await standIn((req, res, n) => (answer ? answer(ctx)(req, res, n) : (res.writeHead(403), res.end())));
  ctx.stand = stand; ctx.P = stand.port;
  try {
    await setup(ctx);
    ctx.r = kind === 'open'
      ? await run(plugin ? plugin.script('open.mjs') : script('open.mjs'), [w.root, ...(args.includes('--open') ? [] : ['--no-open']), ...(noPort ? [] : ['--port', '0']), '--claude', FAKE_CLAUDE, ...args.filter((a) => a !== '--open')], { env })
      : await run(path.join(w.map, 'serve.mjs'), ['--stop', ...args], { env });
    ctx.out = ctx.r.stdout + ctx.r.stderr;
    await check(ctx);
  } finally {
    if (kind === 'open') await stopServer(w.map);
    child.stop();
    await stand.close();
    for (const c of ctx.own) await c.close();
    w.done();
  }
}
export const planted = (record) => (ctx) => plant(ctx.w.map, typeof record === 'function' ? record(ctx) : record);
export const fresh = (ctx) => readServerRecord(recordFile(ctx.w.map)).rec;
export const MODELMAP_LINE = /^MODELMAP  (http:\/\/127\.0\.0\.1:(\d+))  \(/m;


// What a repo could commit: each record is right in every way but one, so one check alone has to stop it.
export const HOSTILE = {
  'the committed example: pid 1, localhost., token x, no port': (c) => ({ pid: 1, url: 'http://localhost.:' + c.P, token: 'x' }),
  'pid 1': (c) => goodRecord(c.P, c.C, { pid: 1 }),
  'pid 0': (c) => goodRecord(c.P, c.C, { pid: 0 }),
  'a negative pid': (c) => goodRecord(c.P, c.C, { pid: -c.C }),
  'a float pid': (c) => goodRecord(c.P, c.C, { pid: c.C + 0.5 }),
  'a string pid': (c) => goodRecord(c.P, c.C, { pid: String(c.C) }),
  'a pid that is no safe integer': (c) => goodRecord(c.P, c.C, { pid: 2 ** 60 }),
  'the pid of the test process, which is the parent of the script': (c) => goodRecord(c.P, process.pid),
  'a live harmless child, url localhost.': (c) => goodRecord(c.P, c.C, { url: 'http://localhost.:' + c.P }),
  'a live harmless child, url localhost': (c) => goodRecord(c.P, c.C, { url: 'http://localhost:' + c.P }),
  'url with credentials': (c) => goodRecord(c.P, c.C, { url: 'http://user:pw@127.0.0.1:' + c.P }),
  'url https': (c) => goodRecord(c.P, c.C, { url: 'https://127.0.0.1:' + c.P }),
  'url with a path': (c) => goodRecord(c.P, c.C, { url: 'http://127.0.0.1:' + c.P + '/evil' }),
  'url with a query': (c) => goodRecord(c.P, c.C, { url: 'http://127.0.0.1:' + c.P + '/?evil=1' }),
  'url with a hash': (c) => goodRecord(c.P, c.C, { url: 'http://127.0.0.1:' + c.P + '/#evil' }),
  'url with a port that is not the port field': (c) => goodRecord(c.P, c.C, { port: c.P === 65535 ? 65534 : c.P + 1 }),
  'a port field that is a string': (c) => goodRecord(c.P, c.C, { port: String(c.P) }),
  'no port field': (c) => goodRecord(c.P, c.C, { port: undefined }),
  'url [::1]': (c) => goodRecord(c.P, c.C, { url: 'http://[::1]:' + c.P }),
  'url 127.0.0.1.evil.example': (c) => goodRecord(c.P, c.C, { url: 'http://127.0.0.1.evil.example:' + c.P }),
  'url 127.0.0.2': (c) => goodRecord(c.P, c.C, { url: 'http://127.0.0.2:' + c.P }),
  'a token that is too short': (c) => goodRecord(c.P, c.C, { token: 'abcdef012345678' }),
  'a token that is x': (c) => goodRecord(c.P, c.C, { token: 'x' }),
  'a token that is not hex': (c) => goodRecord(c.P, c.C, { token: 'z'.repeat(32) }),
  'an array instead of an object': (c) => [goodRecord(c.P, c.C)],
  'a string instead of an object': (c) => JSON.stringify(JSON.stringify(goodRecord(c.P, c.C))),
  'not JSON': () => 'pid=1 url=http://localhost.:1',
  'a good record in a file of 5 KB': (c) => JSON.stringify(goodRecord(c.P, c.C)) + ' '.repeat(5000),
  'a good record, one more key of 5 KB': (c) => goodRecord(c.P, c.C, { padding: 'x'.repeat(5000) }),
};
export const SYMLINKED = 'server.json is a symbolic link to a good record';
// a url the output must not show, for the checks that it is never printed
export const hostileUrl = (rec) => (rec && typeof rec === 'object' && !Array.isArray(rec) && typeof rec.url === 'string' ? rec.url : null);


// A record that is right in form and points at a server that answers: the answer decides, and a pid is killed only when the
// server says it is that pid and this map's root.
export const ANSWERS = {
  'wrong pid, other hash': { kill: false, a: (c) => (req, res) => sendJson(res, 200, { pid: c.C + 1, root: c.w.root, hash: 'other', tabs: 0, editor: null }) },
  'wrong root, other hash': { kill: false, a: (c) => (req, res) => sendJson(res, 200, { pid: c.C, root: path.dirname(c.w.root), hash: 'other', tabs: 0, editor: null }) },
  'no root, other hash': { kill: false, a: (c) => (req, res) => sendJson(res, 200, { pid: c.C, hash: 'other', tabs: 0, editor: null }) },
  'the pid as a string': { kill: false, a: (c) => (req, res) => sendJson(res, 200, { pid: String(c.C), root: c.w.root, hash: 'other', tabs: 0 }) },
  '403': { kill: false, a: () => (req, res) => { res.writeHead(403); res.end(); } },
  'a redirect to the right answer elsewhere': { kill: false, a: (c) => async (req, res) => {
    const other = await standIn((q, s) => sendJson(s, 200, { pid: c.C, root: c.w.root, hash: 'other', tabs: 0 }));
    c.own.push(other); c.other = other;
    res.writeHead(302, { Location: 'http://127.0.0.1:' + other.port + '/api/status' }); res.end();
  } },
  'the right pid and root, another hash': { kill: true, a: (c) => (req, res) => sendJson(res, 200, { pid: c.C, root: c.w.root, hash: 'other', tabs: 0, editor: null }) },
  'the right pid and root, this hash': { kill: 'stop only', a: (c) => (req, res) => sendJson(res, 200, { pid: c.C, root: c.w.root, hash: codeHash12(c.w.map), tabs: 0, editor: null, cli: false }) },
};


export const stopsAtOnce = process.env.MODELMAP_TEST_SERIAL ? 1 : 6;
