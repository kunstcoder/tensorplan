// R18, the rest: one server per map folder. A second serve.mjs for the same map must not replace .cache/server.json (that is how --stop
// and open.mjs find the first): it writes the record only when there is none ('wx'), says so and exits 1 when a live server of this map
// has it, and replaces a record that is stale. Nothing is ever killed by a starting server. All on port 0, in temporary copies of a
// built map, with the fake CLI, stand-in servers on 127.0.0.1 and harmless "sleep" children (UPSTREAM.md section 19).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { hasPython } from './helpers.mjs';
import { startServe, request } from './helpers-ask.mjs';
import { posixOnly, sleep, alive, run, pool, standIn, sendJson, harmless, copyMap, mapSource, recordFile, goodRecord, plant, stopServer, FAKE_CLAUDE, GOOD_TOKEN, MODELMAP_LINE, pluginCopy, stopsAtOnce, HOSTILE, SYMLINKED, ANSWERS } from './helpers-trusted.mjs';
import { readServerRecord, verifiedStatus } from '../skills/modelmap/scripts/lib/common.mjs';

const skip = posixOnly || (!hasPython && 'python3 (3.9+) is needed to scan');

/** serve.mjs of a map, started by hand: { proc, out(), exit: promise of the exit code }. The caller stops it. */
function spawnServe(map, args = []) {
  const proc = spawn(process.execPath, [path.join(map, 'serve.mjs'), '--claude', FAKE_CLAUDE, '--no-open', '--port', '0', ...args], { cwd: path.dirname(map), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const exit = new Promise((r) => proc.once('exit', (code) => r(code)));
  const withTimeout = (ms) => Promise.race([exit, sleep(ms).then(() => 'still running')]);
  return { proc, out: () => out, exit, within: withTimeout, stop: () => { if (proc.exitCode === null) proc.kill('SIGKILL'); return exit; } };
}
const status = async (rec) => JSON.parse((await request(rec.port, { path: '/api/status', headers: { 'x-floorplan-token': rec.token } })).body);
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

test('a second server for the same map exits 1 within 5 s and names the first, which keeps its record (bytes and time), still answers and is stopped by --stop', { skip }, async () => {
  mapSource();
  const w = copyMap();
  let A, B;
  try {
    A = await startServe(w.map);
    const file = recordFile(w.map);
    const bytes = fs.readFileSync(file), mtime = fs.statSync(file).mtimeMs;
    B = spawnServe(w.map);
    assert.equal(await B.within(5000), 1, 'the second server did not exit with 1: ' + B.out());
    assert.equal(B.out().trim(), '✗ A map server for this folder is already running at ' + A.url + ' (pid ' + A.proc.pid + '). Stop it with node modelmap/serve.mjs --stop or open it with open.mjs.');
    assert.ok(!B.out().includes('modelmap: http'), 'the second server said it was serving');
    assert.ok(Buffer.from(fs.readFileSync(file)).equals(bytes), 'the record was rewritten');
    assert.equal(fs.statSync(file).mtimeMs, mtime, 'the record was touched');
    assert.equal((await status(A.state)).pid, A.proc.pid, 'the first server still answers');
    assert.ok(alive(A.proc.pid));
    // the first one is still the one --stop and open.mjs find
    const stop = await run(path.join(w.map, 'serve.mjs'), ['--stop']);
    assert.equal(stop.stdout.trim(), 'Stopped the map server (' + A.url + ').');
    for (let t = 0; t < 4000 && alive(A.proc.pid); t += 100) await sleep(100);
    assert.ok(!alive(A.proc.pid), 'the first server was not stopped');
    assert.ok(!fs.existsSync(file), 'the record is removed with it');
  } finally { await B?.stop(); await A?.stop(); w.done(); }
});

test('two servers started at the same instant (5 times): after 3 s exactly one lives, server.json holds its pid and it answers; the other exited 1', { skip }, async () => {
  mapSource();
  const trials = [1, 2, 3, 4, 5];
  const failures = [];
  await pool(trials, 5, async (n) => {
    const w = copyMap();
    const two = [spawnServe(w.map), spawnServe(w.map)];
    try {
      await sleep(3000);
      const live = two.filter((s) => s.proc.exitCode === null), dead = two.filter((s) => s.proc.exitCode !== null);
      const rec = readServerRecord(recordFile(w.map)).rec;
      if (live.length !== 1) return failures.push('trial ' + n + ': ' + live.length + ' servers alive: ' + two.map((s) => s.out().trim()).join(' | '));
      if (dead[0].proc.exitCode !== 1) failures.push('trial ' + n + ': the other exited with ' + dead[0].proc.exitCode + ': ' + dead[0].out());
      if (!rec || rec.pid !== live[0].proc.pid) failures.push('trial ' + n + ': the record is ' + JSON.stringify(rec) + ', the live server is ' + live[0].proc.pid);
      else if ((await status(rec)).pid !== rec.pid) failures.push('trial ' + n + ': the recorded server does not answer for itself');
      if (!/already running at http:\/\/127\.0\.0\.1:\d+ \(pid \d+\)/.test(dead[0].out())) failures.push('trial ' + n + ': no word from the second: ' + dead[0].out());
    } finally { for (const s of two) await s.stop(); w.done(); }
  });
  assert.deepEqual(failures, []);
});

// A record that is there and is not a live server of this map is stale: the new server starts, replaces it, and kills nothing.
const staleCases = {
  'a dead pid (nothing listens)': { make: async (c) => goodRecord(await freePort(), spawnSync(process.execPath, ['-e', '']).pid) },
  'the pid of a live process that listens on nothing': { make: async (c) => goodRecord(await freePort(), c.C) },
  ...Object.fromEntries(Object.entries(ANSWERS).filter(([, spec]) => !spec.kill).map(([name, spec]) => ['a stand-in server that answers: ' + name, { make: (c) => goodRecord(c.P, c.C), answer: spec.a, asked: 1 }])),
};
test('a stale record (' + Object.keys(staleCases).length + ' kinds: dead pid, a live process with nothing listening, a stand-in that answers another pid, another root, 403, a redirect) is replaced, the live process is not killed, and a stand-in is asked once at most', { skip }, async () => {
  mapSource();
  const failures = [];
  await pool(Object.entries(staleCases), stopsAtOnce, async ([name, spec]) => {
    const w = copyMap(), child = harmless();
    const ctx = { w, child, C: child.pid, own: [] };
    const stand = await standIn((req, res, n) => (spec.answer ? spec.answer(ctx)(req, res, n) : (res.writeHead(403), res.end())));
    ctx.stand = stand; ctx.P = stand.port;
    let srv;
    try {
      plant(w.map, await spec.make(ctx));
      srv = await startServe(w.map);
      const rec = readServerRecord(recordFile(w.map)).rec;
      if (!rec || rec.pid !== srv.proc.pid) failures.push(name + ': the record is not the new server\'s: ' + JSON.stringify(rec));
      else if ((await status(rec)).pid !== srv.proc.pid) failures.push(name + ': the new server does not answer');
      if (!child.alive()) failures.push(name + ': the live process was killed');
      if (fs.statSync(recordFile(w.map)).mode % 0o1000 !== 0o600) failures.push(name + ': the record is not 0600');
      const asked = stand.requests.length;
      if (asked !== (spec.asked || 0) || stand.requests.some((q) => q.url !== '/api/status' || q.token !== GOOD_TOKEN)) failures.push(name + ': the stand-in got ' + JSON.stringify(stand.requests));
      for (const o of ctx.own) if (o.requests.length) failures.push(name + ': a redirect was followed');
    } catch (e) { failures.push(name + ': ' + String(e.message).split('\n')[0]); } finally {
      await srv?.stop(); child.stop(); await stand.close(); for (const c of ctx.own) await c.close(); w.done();
    }
  });
  assert.deepEqual(failures, []);
});

test('the forms of server.json an untrusted repo could commit (' + Object.keys(HOSTILE).length + ' wrong in one way, a link, a folder): the new server starts over each of them without asking anyone, or refuses as before (a link) or says why it cannot (a folder); nothing is killed', { skip }, async () => {
  mapSource();
  const forms = [...Object.entries(HOSTILE), [SYMLINKED], ['a folder in place of the file']];
  const failures = [];
  await pool(forms, stopsAtOnce, async ([name, make]) => {
    const w = copyMap(), child = harmless();
    const ctx = { w, child, C: child.pid, own: [] };
    const stand = await standIn();
    ctx.stand = stand; ctx.P = stand.port;
    let srv, started;
    try {
      const file = recordFile(w.map);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (name === SYMLINKED) {
        fs.writeFileSync(path.join(w.map, 'record.json'), JSON.stringify(goodRecord(ctx.P, ctx.C)), { mode: 0o600 });
        fs.symlinkSync(path.join(w.map, 'record.json'), file);
      } else if (name === 'a folder in place of the file') fs.mkdirSync(file);
      else plant(w.map, make(ctx));
      if (name === SYMLINKED || name === 'a folder in place of the file') {
        started = spawnServe(w.map);
        const code = await started.within(8000);
        const said = started.out();
        if (code !== 1) failures.push(name + ': exit ' + code + ': ' + said);
        else if (name === SYMLINKED && !/is a symbolic link/.test(said)) failures.push(name + ': ' + said);
        else if (name !== SYMLINKED && !/Couldn't replace the old modelmap\/\.cache\/server\.json/.test(said)) failures.push(name + ': ' + said);
        if (name === SYMLINKED && !fs.lstatSync(file).isSymbolicLink()) failures.push(name + ': the link was replaced');
        if (name !== SYMLINKED && !fs.lstatSync(file).isDirectory()) failures.push(name + ': the folder is gone');
      } else {
        srv = await startServe(w.map);
        const rec = readServerRecord(recordFile(w.map)).rec;
        if (!rec || rec.pid !== srv.proc.pid) failures.push(name + ': the record is not the new server\'s');
      }
      if (stand.requests.length) failures.push(name + ': the stand-in was asked: ' + JSON.stringify(stand.requests));
      if (!child.alive()) failures.push(name + ': the live process was killed');
    } catch (e) { failures.push(name + ': ' + String(e.message).split('\n')[0]); } finally {
      await started?.stop(); await srv?.stop(); child.stop(); await stand.close(); w.done();
    }
  });
  assert.deepEqual(failures, []);
});

test('a process that answers /api/status as this map\'s server (its pid and root) is taken for it: the new server exits 1 and leaves the record (what this does not catch is in UPSTREAM.md section 19)', { skip }, async () => {
  mapSource();
  const w = copyMap(), child = harmless();
  const stand = await standIn((req, res) => sendJson(res, 200, { pid: child.pid, root: w.root, hash: 'x', tabs: 0, editor: null }));
  let B;
  try {
    plant(w.map, goodRecord(stand.port, child.pid));
    const before = fs.readFileSync(recordFile(w.map), 'utf8');
    B = spawnServe(w.map);
    assert.equal(await B.within(5000), 1, B.out());
    assert.match(B.out(), new RegExp('already running at http://127\\.0\\.0\\.1:' + stand.port + ' \\(pid ' + child.pid + '\\)'));
    assert.equal(fs.readFileSync(recordFile(w.map), 'utf8'), before);
    assert.ok(child.alive());
  } finally { await B?.stop(); child.stop(); await stand.close(); w.done(); }
});

test('serve.mjs writes server.json in one place, with wx (only when there is none), and removes it only for a stale one, for --stop, and when it is its own', () => {
  const text = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'skills', 'modelmap', 'assets', 'serve.mjs'), 'utf8');
  assert.deepEqual([...text.matchAll(/writeFileSync\(stateFile[^\n]*/g)].map((m) => m[0]), ["writeFileSync(stateFile, text, { flag: 'wx', mode: 0o600 });"]);
  assert.equal([...text.matchAll(/unlinkSync\(stateFile\)/g)].length, 3, 'the --stop block, the stale record, and forget (a record that holds this process\'s own pid)');
  assert.match(text, /const forget = \(\) => \{ try \{ if \(readState\(\)\?\.pid === process\.pid\) fs\.unlinkSync\(stateFile\); \} catch \{\} \};/);
  assert.match(text, /alive\(rec\.pid\) && await verifiedStatus\(rec\)/, 'a record is live only when its pid is alive and the server answers for this map');
});

// ---------- open.mjs ----------
test('open.mjs: when the server it starts finds a server of this map already running (a start by hand won the race), that server exits 1 and open.mjs shows the running one, as it is', { skip }, async () => {
  mapSource();
  // The serve.mjs that open.mjs writes into the copy is a stand-in (assets/serve.mjs of a plugin copy): it starts the real server by hand,
  // waits until that has its record, and then runs the real one itself, which finds the first and exits 1
  const stand = "import fs from 'node:fs';\nimport path from 'node:path';\nimport { spawn } from 'node:child_process';\nimport { fileURLToPath } from 'node:url';\n" +
    "const dir = path.dirname(fileURLToPath(import.meta.url));\n" +
    "spawn(process.execPath, [path.join(dir, 'serve.real.mjs'), '--claude', " + JSON.stringify(FAKE_CLAUDE) + ", '--no-open', '--port', '0'], { detached: true, stdio: 'ignore' }).unref();\n" +
    "const rec = path.join(dir, '.cache', 'server.json');\nfor (let i = 0; i < 200 && !(fs.existsSync(rec) && fs.statSync(rec).size > 0); i++) await new Promise((r) => setTimeout(r, 50));\nawait import('./serve.real.mjs');\n";
  const plugin = pluginCopy({ 'assets/serve.mjs': stand });
  const w = copyMap();
  try {
    fs.renameSync(path.join(w.map, 'serve.mjs'), path.join(w.map, 'serve.real.mjs'));
    const r = await run(plugin.script('open.mjs'), [w.root, '--no-open', '--port', '0', '--claude', FAKE_CLAUDE]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const m = MODELMAP_LINE.exec(r.stdout);
    assert.ok(m, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, /didn't start/);
    const rec = readServerRecord(recordFile(w.map)).rec;
    assert.equal(rec.url, m[1], 'the address shown is the running server\'s');
    assert.equal((await status(rec)).pid, rec.pid);
    // the one open.mjs started says why it stopped (it may still be on its way to that when open.mjs has the running one)
    const log = path.join(w.map, '.cache', 'server.log');
    for (let t = 0; t < 5000 && !/already running at/.test(fs.readFileSync(log, 'utf8')); t += 50) await sleep(50);
    assert.match(fs.readFileSync(log, 'utf8'), new RegExp('already running at ' + m[1].replace(/\./g, '\\.') + ' \\(pid ' + rec.pid + '\\)'));
  } finally { await stopServer(w.map); w.done(); plugin.done(); }
});

test('open.mjs: a server that did not stop when it was sent the stop for a newer serve.mjs keeps its record, is not killed by the new one, and is shown instead of a new server', { skip }, async () => {
  mapSource();
  const w = copyMap();
  const newer = pluginCopy({ 'assets/serve.mjs': (old) => old + '\n// a newer serve.mjs\n' });
  // a stand-in for a running server of this map that ignores SIGTERM: its own process, its own record, answers /api/status for this map
  const script = path.join(w.base, 'old-server.mjs');
  fs.writeFileSync(script, "import http from 'node:http';\nimport fs from 'node:fs';\nconst [root, file, token] = process.argv.slice(2);\nprocess.on('SIGTERM', () => {});\n" +
    "const s = http.createServer((req, res) => {\n  const ok = req.headers['x-floorplan-token'] === token;\n  if (ok && req.url === '/api/status') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ tabs: 0, pid: process.pid, hash: 'old', root, editor: null })); }\n" +
    "  else if (ok && req.url === '/api/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ cli: false, engine: 'claude', want: 'claude' })); }\n  else { res.writeHead(403); res.end(); }\n});\n" +
    "s.listen(0, '127.0.0.1', () => { const port = s.address().port; fs.writeFileSync(file, JSON.stringify({ pid: process.pid, port, url: 'http://127.0.0.1:' + port, token, hash: 'old', startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); console.log('ready'); });\n");
  fs.mkdirSync(path.join(w.map, '.cache'), { recursive: true });
  const old = spawn(process.execPath, [script, w.root, recordFile(w.map), GOOD_TOKEN], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve) => old.stdout.once('data', resolve));
    const rec = readServerRecord(recordFile(w.map)).rec;
    assert.equal(rec.pid, old.pid);
    const r = await run(newer.script('open.mjs'), [w.root, '--no-open', '--claude', FAKE_CLAUDE]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(MODELMAP_LINE.exec(r.stdout)?.[1], rec.url, r.stdout + r.stderr);
    assert.ok(alive(old.pid), 'the old server was killed');
    assert.equal(readServerRecord(recordFile(w.map)).rec?.pid, old.pid, 'its record is still its own');
    const log = path.join(w.map, '.cache', 'server.log');
    for (let t = 0; t < 5000 && !/already running at/.test(fs.readFileSync(log, 'utf8')); t += 50) await sleep(50);
    assert.match(fs.readFileSync(log, 'utf8'), /already running at/);
  } finally { old.kill('SIGKILL'); await sleep(100); w.done(); newer.done(); }
});

test('open.mjs: a server that stops at once (nothing else is running) is reported as "didn\'t start" without waiting the 20 seconds, and the stale record it found is gone', { skip }, async () => {
  mapSource();
  const plugin = pluginCopy({ 'assets/serve.mjs': 'process.exit(1);\n' });
  const w = copyMap();
  const child = harmless();
  try {
    const stand = await standIn();
    plant(w.map, goodRecord(stand.port, child.pid));
    const t0 = Date.now();
    const r = await run(plugin.script('open.mjs'), [w.root, '--no-open', '--port', '0', '--claude', FAKE_CLAUDE]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /✗ The map server didn't start\. Its log is in .*\.cache\/server\.log\./);
    assert.ok(Date.now() - t0 < 10000, 'it waited ' + (Date.now() - t0) + ' ms');
    assert.ok(child.alive());
    assert.equal(stand.requests.length, 1, 'the stand-in was asked once, by open.mjs');
    await stand.close();
  } finally { child.stop(); w.done(); plugin.done(); }
});
