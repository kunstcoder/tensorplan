// The map's local server (serve.mjs) opens only on this computer: 127.0.0.1, a Host allow-list against DNS
// rebinding, a fresh token per run for /api/*, same-origin checks, static files only from inside the map folder,
// and the page keeps its Content-Security-Policy. It runs with the FAKE CLI (tests/fixtures/fake-cli).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasPython, fixture, tmpDir, node } from './helpers.mjs';
import { buildMap, startServe, request } from './helpers-ask.mjs';
import { policyFor, scriptBlocks, scriptHash, scriptJson } from '../skills/modelmap/assets/page-safety.mjs';

const skip = !hasPython && 'python3 (3.9+) is needed to scan the fixture';
const SECRET = 'secret-' + Math.random().toString(36).slice(2);
let map, root, srv;
before(async () => {
  if (skip) return;
  ({ map, root } = buildMap(fixture('mini-model')));
  // a file next to the map folder, and one next to the repo: neither may be served
  fs.writeFileSync(path.join(root, 'secret.txt'), SECRET);
  fs.writeFileSync(path.join(path.dirname(root), 'secret.txt'), SECRET);
  srv = await startServe(map);
});
after(async () => { if (srv) await srv.stop(); });
const tok = () => ({ 'x-floorplan-token': srv.token });

test('it listens on 127.0.0.1 only and records that address', { skip }, async () => {
  assert.equal(srv.state.url, 'http://127.0.0.1:' + srv.port);
  assert.equal((await request(srv.port, { path: '/api/status', headers: tok() })).status, 200);
  // the same port on IPv6 loopback and on this machine's network addresses is closed
  const other = ['::1', ...Object.values(os.networkInterfaces()).flat().filter((i) => i && !i.internal && i.family === 'IPv4').map((i) => i.address)];
  for (const host of other) {
    const r = await request(srv.port, { host, path: '/' });
    assert.ok(r.error, host + ' answered with ' + r.status);
  }
});

test('a Host header other than 127.0.0.1:<port> or localhost:<port> gets 403 (DNS rebinding)', { skip }, async () => {
  for (const host of ['evil.example', 'evil.example:' + srv.port, '127.0.0.1:1', '0.0.0.0:' + srv.port, '127.0.0.1.evil.example:' + srv.port]) {
    const r = await request(srv.port, { path: '/', headers: { host } });
    assert.equal(r.status, 403, 'Host ' + JSON.stringify(host));
    assert.doesNotMatch(r.body, /FLOORPLAN_SERVER/);
  }
  assert.equal((await request(srv.port, { path: '/', headers: { host: 'localhost:' + srv.port } })).status, 200);
  assert.equal((await request(srv.port, { path: '/api/status', headers: { host: 'evil.example:' + srv.port, ...tok() } })).status, 403);
});

test('/api/* without the token, with a wrong token or from another origin is refused', { skip }, async () => {
  for (const p of ['/api/status', '/api/health', '/api/flows', '/api/events']) {
    assert.equal((await request(srv.port, { path: p })).status, 403, p + ' without a token');
    assert.equal((await request(srv.port, { path: p, headers: { 'x-floorplan-token': 'x'.repeat(32) } })).status, 403, p + ' with a wrong token');
  }
  for (const [method, p] of [['POST', '/api/ask'], ['POST', '/api/cancel'], ['POST', '/api/export']]) {
    assert.equal((await request(srv.port, { method, path: p, body: '{}' })).status, 403, p);
    assert.equal((await request(srv.port, { method, path: p, body: '{}', headers: { ...tok(), origin: 'http://evil.example' } })).status, 403, p + ' from another origin');
  }
  // removed with the blueprint and health code
  for (const p of ['/api/plan/undo', '/api/health/dismissed']) assert.equal((await request(srv.port, { method: 'POST', path: p, headers: tok(), body: '{}' })).status, 404, p);
  assert.equal((await request(srv.port, { path: '/api/status', headers: { ...tok(), origin: 'http://127.0.0.1:' + srv.port } })).status, 200);
});

test('a static path cannot leave the map folder, and nothing under a dot folder is served', { skip }, async () => {
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%2e%2e%2fsecret.txt', '/..%2f..%2fsecret.txt', '/%2e%2e%2f%2e%2e%2fsecret.txt', '/..%5csecret.txt', '/./../secret.txt', '//../secret.txt', '/descriptions/..%2f..%2fsecret.txt', '/.cache/server.json', '/.cache%2fserver.json', '/.gitignore', '/%2fetc%2fpasswd', '/%00']) {
    const r = await request(srv.port, { path: p });
    assert.notEqual(r.status, 200, p + ' was served');
    assert.ok(!String(r.body).includes(SECRET) && !String(r.body).includes(srv.token), p + ' leaked');
  }
  // what is inside is served
  const g = await request(srv.port, { path: '/graph.json' });
  assert.equal(g.status, 200);
  assert.equal(JSON.parse(g.body).schema, 'modelmap/graph@1');
});

const modeOf = (f) => fs.statSync(f).mode & 0o777;
const posix = process.platform !== 'win32' ? false : 'file modes are POSIX';

test('server.json holds the Ask token and records the run: this user reads it only, and the token in it works', { skip: skip || posix }, async () => {
  const file = path.join(map, '.cache', 'server.json');
  assert.equal(modeOf(file), 0o600);
  // the content is what it was: this run's pid, port, address, token, script hash and start time
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(s).sort(), ['hash', 'pid', 'port', 'startedAt', 'token', 'url']);
  assert.equal(s.pid, srv.proc.pid);
  assert.equal(s.port, srv.port);
  assert.equal(s.url, 'http://127.0.0.1:' + srv.port);
  assert.match(s.token, /^[0-9a-f]{32}$/);
  assert.match(s.hash, /^[0-9a-f]{12}$/);
  assert.ok(!Number.isNaN(Date.parse(s.startedAt)));
  const status = await request(srv.port, { path: '/api/status', headers: { 'x-floorplan-token': s.token } });
  assert.equal(status.status, 200);
  assert.equal(JSON.parse(status.body).pid, s.pid);
  // a map folder with no .cache yet: the server makes it for this user only
  const fresh = path.join(tmpDir('modelmap-state-'), 'modelmap');
  fs.cpSync(map, fresh, { recursive: true, filter: (f) => !f.includes(path.sep + '.cache') });
  const second = await startServe(fresh);
  try {
    assert.equal(modeOf(path.join(fresh, '.cache')), 0o700);
    assert.equal(modeOf(path.join(fresh, '.cache', 'server.json')), 0o600);
  } finally { await second.stop(); }
});

test('a server.json an earlier run left with a looser mode is 0600 again once the server has started', { skip: skip || posix }, async () => {
  const copy = path.join(tmpDir('modelmap-state-'), 'modelmap');
  fs.cpSync(map, copy, { recursive: true, filter: (f) => !f.includes(path.sep + '.cache') });
  const old = path.join(copy, '.cache', 'server.json');
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, JSON.stringify({ pid: 999999, port: 1, url: 'http://127.0.0.1:1', token: 'old-token', hash: 'x', startedAt: new Date(0).toISOString() }));
  fs.chmodSync(old, 0o644);
  assert.equal(modeOf(old), 0o644);
  const second = await startServe(copy);
  try {
    assert.equal(modeOf(old), 0o600);
    const s = JSON.parse(fs.readFileSync(old, 'utf8'));
    assert.equal(s.pid, second.proc.pid, 'the file is this run\'s');
    assert.equal(s.token, second.token);
  } finally { await second.stop(); }
});

test('each run makes a new token, and the old one stops working', { skip }, async () => {
  const second = await startServe(map);
  try {
    assert.notEqual(second.token, srv.token);
    assert.match(second.token, /^[0-9a-f]{32}$/);
    assert.equal((await request(second.port, { path: '/api/status', headers: tok() })).status, 403);
    assert.equal((await request(second.port, { path: '/api/status', headers: { 'x-floorplan-token': second.token } })).status, 200);
  } finally { await second.stop(); }
});

test('the served page keeps its Content-Security-Policy, and the policy covers the injected server script', { skip }, async () => {
  const r = await request(srv.port, { path: '/' });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  const metas = r.body.match(/<meta http-equiv="Content-Security-Policy"[^>]*>/g) || [];
  assert.equal(metas.length, 1);
  const content = /content="([^"]*)"/.exec(metas[0])[1];
  assert.match(content, /default-src 'none'/);
  assert.match(content, /connect-src 'self'/);
  assert.match(content, /form-action 'none'/);
  assert.doesNotMatch(content, /unsafe-eval|script-src[^;]*unsafe-inline/);
  // every inline script runs by hash, the injected one included, and nothing else does
  assert.equal(content, policyFor(r.body, 'local'));
  const inject = scriptBlocks(r.body).find((b) => b.body.startsWith('window.FLOORPLAN_SERVER='));
  assert.ok(inject, 'the server injects window.FLOORPLAN_SERVER');
  assert.ok(content.includes(scriptHash(inject.body)));
  assert.equal(JSON.parse(inject.body.slice('window.FLOORPLAN_SERVER='.length, -1)).token, srv.token);
  // the file on disk carries no token
  assert.ok(!fs.readFileSync(path.join(map, 'index.html'), 'utf8').includes(srv.token));
});

test('Export sends modelmap-<project>.html: only a-z, 0-9 and -, and modelmap.html when nothing of the name is left', { skip }, async () => {
  const exp = async (s) => request(s.port, { method: 'POST', path: '/api/export', headers: { 'content-type': 'application/json', 'x-floorplan-token': s.token }, body: { include: ['flows'] } });
  const r = await exp(srv);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-disposition'], 'attachment; filename="modelmap-net.html"');
  assert.match(r.body, /data-floorplan-policy="export"/);
  assert.ok(!r.body.includes(srv.token), 'the copy carries no token');
  // a copy of the map whose page names the project differently
  const copy = path.join(tmpDir('modelmap-export-'), 'modelmap');
  fs.cpSync(map, copy, { recursive: true, filter: (f) => !f.includes(path.sep + '.cache') });
  const second = await startServe(copy);
  try {
    const page = path.join(copy, 'index.html');
    const html = fs.readFileSync(page, 'utf8');
    const START = '<script>window.FLOORPLAN = ', a = html.indexOf(START) + START.length, b = html.indexOf(';</script>', a);
    const g = JSON.parse(html.slice(a, b));
    for (const [name, want] of [
      ['Anchored Branched UPT', 'modelmap-anchored-branched-upt.html'],
      ['../evil"; rm -rf / <script>\r\nX-Injected: 1', 'modelmap-evil-rm-rf-script-x-injected-1.html'],
      ['모델 (Korean)', 'modelmap-korean.html'],
      ['모델', 'modelmap.html'],
      ['', 'modelmap.html'],
      ['x'.repeat(300), 'modelmap-' + 'x'.repeat(80) + '.html'],
    ]) {
      fs.writeFileSync(page, html.slice(0, a) + scriptJson({ ...g, project: { ...g.project, name } }) + html.slice(b));
      const r2 = await exp(second);
      assert.equal(r2.status, 200, JSON.stringify(name));
      const file = /^attachment; filename="([^"]*)"$/.exec(r2.headers['content-disposition'])?.[1];
      assert.equal(file, want, JSON.stringify(name));
      assert.match(file, /^modelmap(-[a-z0-9]+)*\.html$/);
      assert.equal(r2.headers['x-injected'], undefined);
    }
  } finally { await second.stop(); }
  // the command line export writes the same name next to the map
  const cli = node(path.join(map, 'serve.mjs'), ['--export']);
  assert.equal(cli.status, 0, cli.stderr);
  assert.ok(fs.existsSync(path.join(map, 'modelmap-net.html')), cli.stdout);
});

// Static files need no token, so a symbolic link in the map folder (a repo can carry one) must never be followed: not to a
// file outside the folder, not to .cache/server.json (the Ask token), not through a folder link, not along a chain.
const linksSkip = skip || (process.platform === 'win32' && 'creating symbolic links needs privileges on Windows');
test('static files: a symbolic link is never followed (outside file, .cache/server.json, a folder link, a chain, a broken link, a link inside the folder), and normal files still load', { skip: linksSkip }, async () => {
  const w = tmpDir('modelmap-staticlinks-');
  const outside = path.join(w, 'outside'), copy = path.join(w, 'modelmap');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), SECRET);
  fs.cpSync(map, copy, { recursive: true, filter: (f) => !f.includes(path.sep + '.cache') });
  const second = await startServe(copy);
  try {
    const at = (n) => path.join(copy, n);
    // links, all made after the server started: the check is made per request
    fs.symlinkSync(path.join(outside, 'secret.txt'), at('leak.json'));            // a file outside the folder
    fs.symlinkSync(path.join('.cache', 'server.json'), at('token.json'));         // the Ask token, from inside the folder
    fs.symlinkSync('.cache', at('dotlink'));                                      // a folder link to .cache
    fs.symlinkSync(outside, at('linkdir'));                                       // a folder outside, with a file under it
    fs.symlinkSync('b.json', at('a.json'));                                       // a chain: a -> b -> outside
    fs.symlinkSync(path.join(outside, 'secret.txt'), at('b.json'));
    fs.symlinkSync('no-such-file', at('broken.json'));                            // a broken link
    fs.symlinkSync('graph.json', at('alias.json'));                               // a link to a file inside the folder
    fs.symlinkSync('descriptions', at('inner'));                                  // a link to a folder inside the folder
    fs.mkdirSync(at('descriptions'), { recursive: true });
    fs.writeFileSync(path.join(at('descriptions'), 'x.json'), '{}');
    fs.writeFileSync(at('notes.json'), '{"plain":true}');
    for (const p of ['/leak.json', '/token.json', '/dotlink/server.json', '/linkdir/secret.txt', '/a.json', '/b.json', '/broken.json', '/alias.json', '/inner/x.json', '/linkdir', '/linkdir/', '/dotlink']) {
      const r = await request(second.port, { path: p });
      assert.equal(r.status, 404, p + ' was served: ' + r.body.slice(0, 80));
      assert.equal(r.body, 'not found', p);
      assert.ok(!r.body.includes(SECRET) && !r.body.includes(second.token), p + ' leaked');
    }
    // what is a plain file in the folder is served, as before
    for (const [p, type] of [['/graph.json', /json/], ['/index.html', /html/], ['/query.mjs', /javascript/], ['/notes.json', /json/], ['/descriptions/x.json', /json/]]) {
      const r = await request(second.port, { path: p });
      assert.equal(r.status, 200, p);
      assert.match(r.headers['content-type'], type, p);
    }
    assert.deepEqual(JSON.parse((await request(second.port, { path: '/notes.json' })).body), { plain: true });
  } finally { await second.stop(); fs.rmSync(w, { recursive: true, force: true }); }
});
