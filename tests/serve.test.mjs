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
