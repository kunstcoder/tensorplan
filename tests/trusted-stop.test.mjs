// serve.mjs --stop with a .cache/server.json the repo shipped (R7).
// A repo is untrusted and can commit anything under <repo>/modelmap/ (graph.json, .cache/server.json); our scripts read it before a
// build overwrites it. A value read from such a file must never become a git option, a path outside the repo, a process id that is
// killed, or an address that is requested or opened, without being checked first (UPSTREAM.md section 17). Everything runs in
// temporary folders, with the fake CLI, stand-in servers on 127.0.0.1 port 0 and harmless "sleep" children.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasPython } from './helpers.mjs';
import { posixOnly, pool, mapSource, recordFile, goodRecord, plant, GOOD_TOKEN, trial, planted, HOSTILE, SYMLINKED, hostileUrl, ANSWERS } from './helpers-trusted.mjs';

const skipServer = posixOnly || (!hasPython && 'python3 (3.9+) is needed to scan');

test('serve.mjs --stop: the same forms are stale: "The map server was not running.", nothing is requested, the live process is not killed, no url is printed', { skip: skipServer }, async () => {
  mapSource();
  const forms = [...Object.entries(HOSTILE), [SYMLINKED, (c) => goodRecord(c.P, c.C)]];
  const failures = [];
  await pool(forms, 8, async ([name, make]) => {
    try {
      await trial({
        kind: 'stop',
        setup: (ctx) => {
          if (name !== SYMLINKED) return plant(ctx.w.map, make(ctx));
          fs.mkdirSync(path.join(ctx.w.map, '.cache'), { recursive: true });
          fs.writeFileSync(path.join(ctx.w.map, 'record.json'), JSON.stringify(make(ctx)), { mode: 0o600 });
          fs.symlinkSync(path.join(ctx.w.map, 'record.json'), recordFile(ctx.w.map));
        },
      }, (ctx) => {
        assert.deepEqual(ctx.stand.requests, [], 'the stand-in was asked');
        assert.ok(ctx.child.alive(), 'the harmless process was killed');
        if (name === SYMLINKED) { assert.equal(ctx.r.status, 1); assert.match(ctx.out, /is a symbolic link/); } // serve.mjs refuses to touch a link
        else { assert.equal(ctx.r.status, 0, ctx.out); assert.equal(ctx.r.stdout.trim(), 'The map server was not running.'); }
        const shown = hostileUrl(make(ctx));
        for (const bad of [shown, 'localhost.', 'evil', 'user:pw', '[::1]', '127.0.0.2'].filter(Boolean)) assert.ok(!ctx.out.includes(bad), 'the output shows ' + bad + ': ' + ctx.out);
      });
    } catch (e) { failures.push(name + ': ' + String(e.message).split('\n')[0]); }
  });
  assert.deepEqual(failures, []);
});



test('serve.mjs --stop: a record that looks right is killed only when its server answers with its own pid and this map\'s root', { skip: skipServer }, async () => {
  mapSource();
  const failures = [];
  await pool(Object.entries(ANSWERS), 8, async ([name, spec]) => {
    try {
      await trial({ kind: 'stop', setup: planted((c) => goodRecord(c.P, c.C)), answer: spec.a }, async (ctx) => {
        assert.equal(ctx.r.status, 0, ctx.out);
        if (spec.kill) {
          assert.ok(await ctx.child.gone(), 'the server was not stopped');
          assert.equal(ctx.r.stdout.trim(), 'Stopped the map server (http://127.0.0.1:' + ctx.P + ').');
        } else {
          assert.ok(ctx.child.alive(), 'the process was killed');
          assert.equal(ctx.r.stdout.trim(), 'The map server was not running.');
          assert.equal(ctx.stand.requests.length, 1);
          if (ctx.other) assert.equal(ctx.other.requests.length, 0, 'a redirect was followed');
        }
        assert.ok(ctx.stand.requests.every((q) => q.url === '/api/status' && q.token === GOOD_TOKEN));
      });
    } catch (e) { failures.push(name + ': ' + String(e.message).split('\n')[0]); }
  });
  assert.deepEqual(failures, []);
});
