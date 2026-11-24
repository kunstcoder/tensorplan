// open.mjs with a real server (the normal flow), the port of a record, and the browser (R7).
// A repo is untrusted and can commit anything under <repo>/modelmap/ (graph.json, .cache/server.json); our scripts read it before a
// build overwrites it. A value read from such a file must never become a git option, a path outside the repo, a process id that is
// killed, or an address that is requested or opened, without being checked first (UPSTREAM.md section 17). Everything runs in
// temporary folders, with the fake CLI, stand-in servers on 127.0.0.1 port 0 and harmless "sleep" children.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { script, hasPython } from './helpers.mjs';
import { posixOnly, sleep, alive, run, pool, sendJson, copyMap, mapSource, recordFile, goodRecord, plant, stopServer, openerShim, FAKE_CLAUDE, trial, MODELMAP_LINE, stopsAtOnce, sha12, ANSWERS } from './helpers-trusted.mjs';
import { readServerRecord, verifiedStatus } from '../skills/modelmap/scripts/lib/common.mjs';

const skipServer = posixOnly || (!hasPython && 'python3 (3.9+) is needed to scan');

test('open.mjs: the port of a stale record is not passed on to the new server, the port of the server it just stopped (which was checked) is', { skip: skipServer }, async () => {
  mapSource();
  // serve.mjs of the copy is a stand-in that writes the arguments it got, adds --port 0 when there is none (so no trial uses 4378), and runs the real one
  const stub = (ctx) => {
    fs.renameSync(path.join(ctx.w.map, 'serve.mjs'), path.join(ctx.w.map, 'serve.real.mjs'));
    const log = path.join(ctx.w.base, 'argv.log');
    fs.writeFileSync(path.join(ctx.w.map, 'serve.mjs'), "import fs from 'node:fs';\nfs.appendFileSync(" + JSON.stringify(log) + ", JSON.stringify(process.argv.slice(2)) + '\\n');\nif (!process.argv.includes('--port')) process.argv.push('--port', '0');\nawait import('./serve.real.mjs');\n");
    ctx.argvLog = log;
    plant(ctx.w.map, goodRecord(ctx.P, ctx.C));
  };
  const started = (ctx) => fs.readFileSync(ctx.argvLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((a) => a.includes('--no-open'));
  await trial({ setup: stub, noPort: true }, (ctx) => { // a stand-in that answers 403: stale
    assert.equal(ctx.r.status, 0, ctx.out);
    assert.ok(!started(ctx).includes('--port'), 'the port of a stale record was passed on: ' + started(ctx));
  });
  await trial({ setup: stub, noPort: true, answer: ANSWERS['the right pid and root, another hash'].a }, async (ctx) => { // the server it stopped
    assert.equal(ctx.r.status, 0, ctx.out);
    assert.ok(await ctx.child.gone());
    const a = started(ctx);
    assert.equal(a[a.indexOf('--port') + 1], String(ctx.P), 'the port of the stopped server is kept: ' + a);
  });
});

test('open.mjs: the browser (open, xdg-open) is given only the address of a server that passed the checks, never one from a record that did not', { skip: skipServer }, async () => {
  mapSource();
  const urlsOf = async (shim, want) => { for (let t = 0; t < 3000 && shim.urls().length < want; t += 100) await sleep(100); await sleep(150); return shim.urls(); };
  const hostile = {
    'a path': (c) => goodRecord(c.P, c.C, { url: 'http://127.0.0.1:' + c.P + '/evil?x=1' }),
    'localhost.': (c) => goodRecord(c.P, c.C, { url: 'http://localhost.:' + c.P }),
    'credentials': (c) => goodRecord(c.P, c.C, { url: 'http://evil:pw@127.0.0.1:' + c.P }),
    'pid 1': (c) => goodRecord(c.P, c.C, { pid: 1 }),
    'a token that is x': (c) => goodRecord(c.P, c.C, { token: 'x' }),
    'a 5 KB file': (c) => JSON.stringify(goodRecord(c.P, c.C)) + ' '.repeat(5000),
    'no record at all (the control: the shim does get the fresh server\'s address)': null,
  };
  const failures = [];
  await pool(Object.entries(hostile), stopsAtOnce, async ([name, make]) => {
    const shim = openerShim();
    try {
      // a stand-in that answers like the map's own server (right pid, right root, this serve.mjs), so only the record's form stands in the way
      const answer = (c) => (req, res) => sendJson(res, 200, { pid: make ? make(c).pid : c.C, root: c.w.root, hash: sha12(path.join(c.w.map, 'serve.mjs')), tabs: 0, editor: null, cli: true });
      await trial({ setup: (ctx) => { if (make) plant(ctx.w.map, make(ctx)); }, answer, args: ['--open'], env: shim.env }, async (ctx) => {
        assert.equal(ctx.r.status, 0, ctx.out);
        const m = MODELMAP_LINE.exec(ctx.r.stdout);
        assert.ok(m && /opened in the browser/.test(ctx.r.stdout), ctx.out);
        assert.deepEqual(await urlsOf(shim, 1), [m[1]], 'the browser got another address than the fresh server\'s');
        assert.deepEqual(ctx.stand.requests, [], 'the stand-in was asked');
      });
    } catch (e) { failures.push(name + ': ' + String(e.message).split('\n')[0]); } finally { shim.done(); }
  });
  assert.deepEqual(failures, []);
});

test('open.mjs: the normal flow with a real server still works: it starts one, shows it, reuses it, says "already open" for a tab, restarts it for a newer serve.mjs, and --stop stops it', { skip: skipServer }, async () => {
  const w = copyMap();
  const open = () => run(script('open.mjs'), [w.root, '--no-open', '--port', '0', '--claude', FAKE_CLAUDE]);
  let tab = null;
  try {
    const a = await open();
    assert.equal(a.status, 0, a.stderr);
    const A = MODELMAP_LINE.exec(a.stdout);
    assert.ok(A, a.stdout);
    assert.match(a.stdout, /^ASK  works: questions run through the Claude Code CLI \(.*\)/m);
    assert.match(a.stdout, /^SERVER  runs in the background, updates open tabs when the map is rebuilt, and stops 2 hours after the last tab closes\. Stop it now: node /m);
    const r1 = readServerRecord(recordFile(w.map)).rec;
    assert.equal(r1.url, A[1]);
    if (process.platform !== 'win32') assert.equal(fs.statSync(recordFile(w.map)).mode & 0o777, 0o600);
    // reused: the same server, the same address
    const b = await open();
    assert.equal(MODELMAP_LINE.exec(b.stdout)?.[1], A[1], b.stdout);
    assert.equal(readServerRecord(recordFile(w.map)).rec.pid, r1.pid);
    assert.ok(alive(r1.pid));
    // a tab is open (an events connection, as the page makes it): "already open"
    await new Promise((resolve) => { tab = http.get({ host: '127.0.0.1', port: r1.port, path: '/api/events?token=' + r1.token, headers: { host: '127.0.0.1:' + r1.port } }, (res) => { res.on('data', () => {}); resolve(); }); });
    const c = await open();
    assert.match(c.stdout, /\(already open in a browser tab, which reloaded with the latest map\)/);
    assert.equal(readServerRecord(recordFile(w.map)).rec.pid, r1.pid);
    tab.destroy();
    for (let t = 0; t < 3000; t += 100) { const s = await verifiedStatus(r1, path.dirname(w.map)); if (s?.tabs === 0) break; await sleep(100); }
    // a newer serve.mjs: the running one is stopped (its pid was checked) and a new one is started
    fs.appendFileSync(path.join(w.map, 'serve.mjs'), '\n// a newer serve.mjs\n');
    const d = await open();
    assert.equal(d.status, 0, d.stderr);
    const r2 = readServerRecord(recordFile(w.map)).rec;
    assert.ok(r2 && r2.pid !== r1.pid, 'a new server: ' + JSON.stringify(r2));
    assert.equal(MODELMAP_LINE.exec(d.stdout)?.[1], r2.url);
    for (let t = 0; t < 3000 && alive(r1.pid); t += 100) await sleep(100);
    assert.ok(!alive(r1.pid), 'the old server was not stopped');
    assert.ok(alive(r2.pid));
    // --stop: the real server answers for itself, so it is stopped and its record removed
    const s = await run(path.join(w.map, 'serve.mjs'), ['--stop']);
    assert.equal(s.stdout.trim(), 'Stopped the map server (' + r2.url + ').');
    for (let t = 0; t < 3000 && alive(r2.pid); t += 100) await sleep(100);
    assert.ok(!alive(r2.pid));
    assert.ok(!fs.existsSync(recordFile(w.map)));
    assert.equal((await run(path.join(w.map, 'serve.mjs'), ['--stop'])).stdout.trim(), 'The map server was not running.');
  } finally { tab?.destroy(); await stopServer(w.map); w.done(); }
});
test('open.mjs: a record that shows up while it waits for the new server is checked like the first one: a server that does not answer for this map is not shown or opened', { skip: skipServer }, async () => {
  mapSource();
  // serve.mjs of the copy is a stand-in: it writes a record that points at the stand-in server (right in form, pid of a live process),
  // waits, and then runs the real server, which replaces that record with its own
  const setup = (ctx) => {
    fs.renameSync(path.join(ctx.w.map, 'serve.mjs'), path.join(ctx.w.map, 'serve.real.mjs'));
    const rec = JSON.stringify(goodRecord(ctx.P, ctx.C));
    fs.writeFileSync(path.join(ctx.w.map, 'serve.mjs'), "import fs from 'node:fs';\nfs.mkdirSync(" + JSON.stringify(path.dirname(recordFile(ctx.w.map))) + ", { recursive: true });\nfs.writeFileSync(" + JSON.stringify(recordFile(ctx.w.map)) + ", " + JSON.stringify(rec) + ", { mode: 0o600 });\nawait new Promise((r) => setTimeout(r, 1500));\nawait import('./serve.real.mjs');\n");
  };
  // it answers 200 with another pid: not this record's server
  await trial({ setup, answer: ANSWERS['wrong pid, other hash'].a }, (ctx) => {
    assert.equal(ctx.r.status, 0, ctx.out);
    const m = MODELMAP_LINE.exec(ctx.r.stdout);
    assert.ok(m, ctx.out);
    assert.notEqual(Number(m[2]), ctx.P, 'the stand-in is shown as the map\'s server');
    assert.ok(ctx.stand.requests.length >= 1, 'the record that appeared was not looked at');
    assert.ok(ctx.child.alive());
  });
});
