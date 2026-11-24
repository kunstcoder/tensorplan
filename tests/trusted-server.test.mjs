// open.mjs and serve.mjs --stop with a .cache/server.json the repo shipped (R7).
// A repo is untrusted and can commit anything under <repo>/modelmap/ (graph.json, .cache/server.json); our scripts read it before a
// build overwrites it. A value read from such a file must never become a git option, a path outside the repo, a process id that is
// killed, or an address that is requested or opened, without being checked first (UPSTREAM.md section 17). Everything runs in
// temporary folders, with the fake CLI, stand-in servers on 127.0.0.1 port 0 and harmless "sleep" children.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hasPython } from './helpers.mjs';
import { posixOnly, pool, mapSource, recordFile, goodRecord, plant, trial, planted, fresh, MODELMAP_LINE, stopsAtOnce, HOSTILE, SYMLINKED, hostileUrl, ANSWERS } from './helpers-trusted.mjs';

const skipServer = posixOnly || (!hasPython && 'python3 (3.9+) is needed to scan');

test('open.mjs: a server.json the repo shipped (' + Object.keys(HOSTILE).length + ' forms, each wrong in one way, and a link) is stale: nothing is requested, the pid of a live process is not killed, its url is not printed, and a fresh server starts and is shown', { skip: skipServer }, async () => {
  mapSource();
  const forms = [...Object.entries(HOSTILE), [SYMLINKED, (c) => goodRecord(c.P, c.C)]];
  const failures = [];
  await pool(forms, stopsAtOnce, async ([name, make]) => {
    try {
      await trial({
        setup: (ctx) => {
          if (name !== SYMLINKED) return plant(ctx.w.map, make(ctx));
          fs.mkdirSync(path.join(ctx.w.map, '.cache'), { recursive: true });
          fs.writeFileSync(path.join(ctx.w.map, 'record.json'), JSON.stringify(make(ctx)), { mode: 0o600 });
          fs.symlinkSync(path.join(ctx.w.map, 'record.json'), recordFile(ctx.w.map));
        },
      }, (ctx) => {
        const said = ctx.out;
        assert.equal(ctx.r.status, 0, said);
        assert.deepEqual(ctx.stand.requests, [], 'the stand-in was asked');
        assert.ok(ctx.child.alive(), 'the harmless process was killed');
        const m = MODELMAP_LINE.exec(ctx.r.stdout);
        assert.ok(m, 'no fresh server shown: ' + said);
        assert.notEqual(Number(m[2]), ctx.P);
        const rec = fresh(ctx);
        assert.ok(rec && rec.url === m[1] && rec.pid !== ctx.C, 'the record is not the fresh server\'s: ' + JSON.stringify(rec));
        const shown = hostileUrl(make(ctx));
        for (const bad of [shown, 'localhost.', 'evil', 'user:pw', '[::1]', '127.0.0.2'].filter(Boolean)) assert.ok(!said.includes(bad), 'the output shows ' + bad + ': ' + said);
        assert.ok(!said.includes('127.0.0.1:' + ctx.P), 'the output shows the stand-in\'s address');
      });
    } catch (e) { failures.push(name + ': ' + String(e.message).split('\n')[0]); }
  });
  assert.deepEqual(failures, []);
});


test('open.mjs: a record that looks right is trusted only when its server answers with its own pid and this map\'s root: the pid is killed only then, and only to restart the server for a newer serve.mjs', { skip: skipServer }, async () => {
  mapSource();
  const failures = [];
  await pool(Object.entries(ANSWERS), stopsAtOnce, async ([name, spec]) => {
    try {
      await trial({ setup: planted((c) => goodRecord(c.P, c.C)), answer: spec.a }, async (ctx) => {
        const shown = MODELMAP_LINE.exec(ctx.r.stdout);
        assert.equal(ctx.r.status, 0, ctx.out);
        assert.ok(shown, ctx.out);
        if (spec.kill === true) {
          assert.ok(await ctx.child.gone(), 'the server of the record was not stopped');
          assert.notEqual(Number(shown[2]), ctx.P, 'the new server is shown');
          assert.ok(ctx.stand.requests.length >= 1);
        } else if (spec.kill === 'stop only') {
          assert.ok(ctx.child.alive(), 'a server with the current serve.mjs is left running');
          assert.equal(Number(shown[2]), ctx.P, 'the record\'s server is reused');
        } else {
          assert.ok(ctx.child.alive(), 'the process was killed');
          assert.notEqual(Number(shown[2]), ctx.P, 'a fresh server is shown, not the stand-in');
          assert.equal(ctx.stand.requests.length, 1, 'the record was read again while waiting for the new server: ' + JSON.stringify(ctx.stand.requests));
          if (ctx.other) assert.equal(ctx.other.requests.length, 0, 'a redirect was followed');
        }
      });
    } catch (e) { failures.push(name + ': ' + String(e.message).split('\n')[0]); }
  });
  assert.deepEqual(failures, []);
});


test('open.mjs: a process of another user counts as no server (EPERM is not "alive"): it is not asked about, and nothing of its record is used', { skip: skipServer || (typeof process.getuid === 'function' && process.getuid() === 0 && 'root can signal every process') }, async () => {
  // a live process that this user may not signal
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,user=']).stdout?.toString() || '';
  const foreign = ps.split('\n').map((l) => l.trim().split(/\s+/)).filter(([pid, user]) => Number(pid) > 1 && user === 'root' && Number(pid) !== process.pid)
    .map(([pid]) => Number(pid)).find((pid) => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'EPERM'; } });
  if (!foreign) return; // no such process here: nothing to try (stays a pass; the CI runners have many)
  await trial({ setup: planted((c) => goodRecord(c.P, foreign)) }, (ctx) => {
    assert.equal(ctx.r.status, 0, ctx.out);
    assert.deepEqual(ctx.stand.requests, [], 'the stand-in was asked about a process that is not ours');
    assert.ok(MODELMAP_LINE.test(ctx.r.stdout));
  });
});
