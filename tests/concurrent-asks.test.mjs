// R19: at most MAX_ASKS (2) CLI runs at once, a third question is refused at once (failure code 'busy', no CLI started, nothing queued),
// and /api/cancel stops the one run whose id (from that question's start event) it is given, nothing else. The fake CLI waits for a
// file the test makes (#wait <file>), so how many runs are alive, and which one finishes, is the test's to say. UPSTREAM.md section 19.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasPython, fixture, tmpDir, repo } from './helpers.mjs';
import { buildMap, startServe, calls, ask, askStream, cancel, request, alive, waitFor } from './helpers-ask.mjs';

const skip = !hasPython && 'python3 (3.9+) is needed to scan the fixture';
const BUSY = 'Two questions are already running. Try again when one has finished.';
let map, srv, work;
before(async () => {
  if (skip) return;
  ({ map } = buildMap(fixture('mini-model')));
  srv = await startServe(map);
  work = tmpDir('modelmap-asks-');
});
after(async () => { if (srv) await srv.stop(); if (work) fs.rmSync(work, { recursive: true, force: true }); });

let n = 0;
const pending = [];
// whatever a test leaves waiting is let go, so no fake CLI outlives it
afterEach(async () => { const ps = pending.splice(0); for (const p of ps) p.release(); await Promise.all(ps.map((p) => p.stream.done)); });
/** The fake CLIs that have started so far (one process each; a #wait one logs twice). */
const started = () => new Set(calls(srv.log).map((c) => c.pid)).size;
/** A question the fake CLI answers once the file is made: { release(), stream, id (the start event's), pid (of the fake) }. */
async function waiting() {
  for (let tries = 0; ; tries++) {
    const file = path.join(work, 'release-' + (++n));
    const before = calls(srv.log).length;
    const stream = askStream(srv, { question: '#wait ' + file });
    // A run that has answered is counted out a moment after its answer (when its process has exited): a question asked at that moment
    // can be refused once more. A refusal ends the stream without a start event: ask again.
    const first = await Promise.race([stream.started.then(() => 'started'), stream.done.then(() => 'ended')]);
    if (first !== 'started') {
      const busy = stream.events.some((e) => e.event === 'failure' && e.data.code === 'busy');
      assert.ok(busy && tries < 60, 'the question did not start: ' + JSON.stringify(stream.events));
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    return start(stream, file, before);
  }
}
async function start(stream, file, before) {
  const id = await stream.started;
  const call = await waitFor(() => calls(srv.log).slice(before).find((c) => c.wait && c.stdin === '#wait ' + file));
  assert.ok(call, 'the fake started');
  const w = { stream, id, pid: call.pid, release: () => fs.writeFileSync(file, ''), file };
  pending.push(w);
  return w;
}
const answered = (r) => r.events.some((e) => e.event === 'answer');

test('two questions run at once; a third is refused at once with the failure busy, starts no CLI and is not queued; when one is done a new question is accepted', { skip }, async () => {
  const a = await waiting(), b = await waiting();
  const before = started();
  const t0 = Date.now();
  const third = await ask(srv, { question: '#wait ' + path.join(work, 'never') });
  assert.ok(Date.now() - t0 < 2000, 'the third question waited');
  assert.deepEqual(third.events, [{ event: 'failure', data: { code: 'busy', message: BUSY } }]);
  assert.equal(third.status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(started(), before, 'a third CLI was started');
  assert.ok(alive(a.pid) && alive(b.pid), 'the two runs are untouched');
  // not queued: when a slot frees, nothing starts by itself
  a.release();
  assert.ok(answered(await a.stream.done), 'the first run answered');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(started(), before, 'the refused question was started later');
  // a slot is free: a new question is accepted (the run is done a moment before the server counts it out, so ask again until it is)
  const c = await waiting();
  assert.ok(alive(b.pid) && alive(c.pid));
  // two are running again
  assert.equal((await ask(srv, { question: 'one too many' })).events[0].data.code, 'busy');
  b.release(); c.release();
  assert.ok(answered(await b.stream.done) && answered(await c.stream.done));
  // all free: two at once again
  const d = await waiting(), e = await waiting();
  d.release(); e.release();
  assert.ok(answered(await d.stream.done) && answered(await e.stream.done));
});

test('/api/cancel with the id of one run stops that run only: the other still finishes and answers; a slot is free afterwards', { skip }, async () => {
  const a = await waiting(), b = await waiting();
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^[0-9a-f]{12}$/);
  assert.equal((await cancel(srv, { id: a.id })).status, 204);
  assert.ok(await waitFor(() => !alive(a.pid)), 'the first run was stopped');
  assert.ok(alive(b.pid), 'the second run was stopped too');
  assert.ok(!answered(await a.stream.done), 'the stopped run answered');
  b.release();
  assert.ok(answered(await b.stream.done), 'the second run did not answer');
  // the id of a run that is over stops nothing, and a new question starts
  assert.equal((await cancel(srv, { id: a.id })).status, 204);
  const c = await waiting();
  c.release();
  assert.ok(answered(await c.stream.done));
});

test('/api/cancel without an id, with a bad id, with the id of nothing that runs, or from a stranger stops nothing (204; 403 for a stranger)', { skip }, async () => {
  const a = await waiting(), b = await waiting();
  const bad = [undefined, '', '{}', '{"id":null}', '{"id":""}', 'not json', '[]', 'null', '"x"', '{"id":123}', '{"id":["' + a.id + '"]}', '{"id":{"toString":"x"}}',
    JSON.stringify({ id: a.id.toUpperCase() }), JSON.stringify({ id: a.id + '0' }), JSON.stringify({ id: ' ' + a.id }), JSON.stringify({ id: a.id.slice(1) }), JSON.stringify({ id: '*' }), JSON.stringify({ id: '__proto__' }),
    JSON.stringify({ id: '0'.repeat(12) }), JSON.stringify({ id: 'f'.repeat(12) }), JSON.stringify({ ids: [a.id, b.id] }), JSON.stringify({ all: true, pid: a.pid }), '{"id":"' + a.id + '", "id": 1}', 'x'.repeat(999) ];
  for (const body of bad) {
    const r = await cancel(srv, body);
    assert.equal(r.status, 204, String(JSON.stringify(body)).slice(0, 60));
  }
  // a body too long to be an id is dropped
  const big = await cancel(srv, JSON.stringify({ id: a.id, pad: 'x'.repeat(5000) }));
  assert.ok(big.error || big.status === 204, 'a long body: ' + JSON.stringify(big));
  // the token and the origin are still needed
  assert.equal((await request(srv.port, { method: 'POST', path: '/api/cancel', body: JSON.stringify({ id: a.id }) })).status, 403);
  assert.equal((await request(srv.port, { method: 'POST', path: '/api/cancel', headers: { 'x-floorplan-token': srv.token, origin: 'http://evil.example' }, body: JSON.stringify({ id: a.id }) })).status, 403);
  assert.equal((await request(srv.port, { method: 'POST', path: '/api/cancel', headers: { 'x-floorplan-token': 'x'.repeat(32) }, body: JSON.stringify({ id: a.id }) })).status, 403);
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(alive(a.pid) && alive(b.pid), 'a run was stopped');
  a.release(); b.release();
  assert.ok(answered(await a.stream.done) && answered(await b.stream.done), 'both runs answered');
});

test('a question whose page goes away (the connection closes) stops its own run only and frees its slot', { skip }, async () => {
  const a = await waiting(), b = await waiting();
  b.stream.abort();
  assert.ok(await waitFor(() => !alive(b.pid)), 'the run of the closed connection was not stopped');
  assert.ok(alive(a.pid), 'the other run was stopped');
  const c = await waiting(); // its slot is free again
  a.release(); c.release();
  assert.ok(answered(await a.stream.done) && answered(await c.stream.done));
});

// ---------- the page ----------
const viewer = fs.readFileSync(path.join(repo, 'skills', 'modelmap', 'assets', 'viewer.html'), 'utf8');
const fn = (name) => { const a = viewer.indexOf('function ' + name + '('); assert.ok(a >= 0, name); return viewer.slice(a, viewer.indexOf('\n}\n', a) + 3); };

test('the page remembers the id of its own run from the start event and sends it with the cancel; it shows a failure it has no text for by its message (busy)', () => {
  const ask = fn('askViaCli');
  assert.match(ask, /^function askViaCli\(question, progress, mode = 'ask'\) \{\n {2}askState\.runId = null;/, 'the id of an earlier run is forgotten when a run starts');
  assert.match(ask, /else if \(ev === 'start'\) askState\.runId = data\.id;/);
  const c = fn('cancelAsk');
  assert.match(c, /const id = askState\.runId;/);
  assert.match(c, /fetch\('\/api\/cancel', \{ method: 'POST', headers: \{ 'content-type': 'application\/json', 'x-floorplan-token': window\.FLOORPLAN_SERVER\.token \}, body: JSON\.stringify\(\{ id \}\) \}\)/);
  assert.equal([...viewer.matchAll(/\/api\/cancel/g)].length, 1, 'one place cancels');
  assert.match(viewer, /askState = \{[^}]*runId: null/);
  // a code the page has no copy for is shown as the server's message
  const failure = fn('showFailure');
  assert.doesNotMatch(failure, /\bbusy:/, 'busy has no copy of its own');
  assert.match(failure, /h\(copy \|\| message \|\| 'Something went wrong\.'\)/);
});

test('MAX_ASKS is one constant, 2, in serve.mjs, and the busy refusal comes before the CLI is started', () => {
  const text = fs.readFileSync(path.join(repo, 'skills', 'modelmap', 'assets', 'serve.mjs'), 'utf8');
  assert.equal(text.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n').match(/MAX_ASKS/g).length, 2, 'defined once and used once (outside comments)');
  assert.match(text, /^const MAX_ASKS = 2;$/m);
  assert.match(text, /if \(running\.size >= MAX_ASKS\) \{ send\('failure', \{ code: 'busy', message: BUSY \}\); return res\.end\(\); \}\n {2}runAgent\(/);
  assert.match(text, /const BUSY = 'Two questions are already running\. Try again when one has finished\.';/);
});
