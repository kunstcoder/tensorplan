// Helpers for tests/ask.test.mjs, tests/serve.test.mjs and tests/query.test.mjs: build a map into a temporary
// copy of a fixture repo, start its serve.mjs with the FAKE Claude CLI (tests/fixtures/fake-cli/fake-claude.mjs),
// and talk to it over HTTP. The real claude binary is never started: serve.mjs gets --claude <fake> explicitly.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { node, script, tmpDir, repo } from './helpers.mjs';

export const FAKE_CLAUDE = path.join(repo, 'tests', 'fixtures', 'fake-cli', 'fake-claude.mjs');

/** Copy a repo (a fixture, or the hostile repo) to <tmp>/repo, scan it and build its map into <tmp>/repo/modelmap,
 *  where serve.mjs expects it. Returns { root, map }. Throws when a step fails. */
export function buildMap(source, { copy = true } = {}) {
  const base = tmpDir('modelmap-ask-');
  const root = copy ? path.join(base, 'repo') : source;
  if (copy) fs.cpSync(source, root, { recursive: true });
  const map = path.join(copy ? root : base, 'modelmap');
  const s = node(script('scan.mjs'), [root, '--out', path.join(map, '.cache')]);
  if (s.status !== 0) throw new Error('scan failed: ' + s.stderr);
  const b = node(script('build.mjs'), [root, '--out', map]);
  if (b.status !== 0) throw new Error('build failed: ' + b.stderr);
  return { root, map };
}

/** node <map>/query.mjs ...args, from the map's parent folder (as the CLI runs it). Returns { status, json, stdout }. */
export function query(map, ...args) {
  const r = spawnSync(process.execPath, [path.join(map, 'query.mjs'), ...args], { encoding: 'utf8', cwd: path.dirname(map) });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

/** Start <map>/serve.mjs on a free port with the fake CLI. Resolves { port, token, url, proc, log, stop }. */
export function startServe(map, { args = [], env = {}, claude = FAKE_CLAUDE } = {}) {
  const log = path.join(tmpDir('modelmap-fakelog-'), 'calls.jsonl');
  const proc = spawn(process.execPath, [path.join(map, 'serve.mjs'), '--claude', claude, '--no-open', '--port', '0', ...args], {
    cwd: path.dirname(map), env: { ...process.env, FAKE_CLAUDE_LOG: log, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { proc.kill(); reject(new Error('serve.mjs did not start: ' + out)); }, 15000);
    proc.stderr.on('data', (d) => { out += d; });
    proc.stdout.on('data', (d) => {
      out += d;
      const m = /modelmap: (http:\/\/127\.0\.0\.1:(\d+))/.exec(out);
      if (!m) return;
      clearTimeout(timer);
      const state = JSON.parse(fs.readFileSync(path.join(map, '.cache', 'server.json'), 'utf8'));
      const stop = () => new Promise((r) => { if (proc.exitCode !== null) return r(); proc.once('exit', () => r()); proc.kill(); });
      resolve({ port: +m[2], url: m[1], token: state.token, state, proc, log, output: () => out, stop });
    });
    proc.on('exit', (code) => { clearTimeout(timer); if (!/modelmap: http/.test(out)) reject(new Error('serve.mjs exited ' + code + ': ' + out)); });
  });
}

/** The fake CLI's calls so far: [{ argv, stdin, cwd, pid, tool? }]. */
export const calls = (log) => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

/** One HTTP request to 127.0.0.1:port with any Host header. Resolves { status, headers, body } or { error }. */
export function request(port, { method = 'GET', path: p = '/', headers = {}, body, host = '127.0.0.1' } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, method, path: p, headers: { host: '127.0.0.1:' + port, ...headers }, timeout: 20000 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      res.on('error', (e) => resolve({ error: e.code || e.message, status: res.statusCode, body: data }));
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

/** The server-sent events of a response body: [{ event, data }]. */
export const events = (text) => String(text || '').split('\n\n').filter(Boolean).map((b) => {
  const ev = /^event: (.*)$/m.exec(b)?.[1], data = /^data: (.*)$/m.exec(b)?.[1];
  let parsed = data; try { parsed = JSON.parse(data); } catch {}
  return ev ? { event: ev, data: parsed } : null;
}).filter(Boolean);

/** POST /api/ask with the token; resolves the events of the answer stream. */
export async function ask(srv, body) {
  const r = await request(srv.port, { method: 'POST', path: '/api/ask', headers: { 'content-type': 'application/json', 'x-floorplan-token': srv.token }, body });
  return { ...r, events: events(r.body) };
}

export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } return null; };
