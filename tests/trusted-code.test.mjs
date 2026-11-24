// R28: the scanned repo is untrusted, and everything under <repo>/modelmap/ can be committed by it (past the "*" .gitignore, or shipped in
// a clone): index.html, serve.mjs, query.mjs, page-safety.mjs, graph.json, .cache/*. A code file or a page found there that this plugin did
// not write is data at best: open.mjs makes the four generated files (index.html, query.mjs, serve.mjs, page-safety.mjs) from the plugin
// and graph.json before it looks for or starts a server, and the running server refuses a query.mjs that is no longer the one it started with
// (UPSTREAM.md section 18). Hostile files are made here, at run time, in temporary folders; each writes a marker file named after itself
// when it is loaded or run. Only the fake CLI runs (tests/fixtures/fake-cli), on port 0.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { script, hasPython, tmpDir, repo, fixture } from './helpers.mjs';
import { FAKE_CLAUDE, buildMap, startServe, ask, calls, waitFor } from './helpers-ask.mjs';
import { posixOnly, run, standIn, recordFile, codeHash12, pluginCopy, MODELMAP_LINE, alive, pool } from './helpers-trusted.mjs';
import { FOUR, sleep, golden, copyGold, hostileFiles, plantHostile, markers, tree, same, stopMap, get, nodeRun } from './helpers-code.mjs';
import { readServerRecord } from '../skills/modelmap/scripts/lib/common.mjs';

const skipPosix = posixOnly;
const skipServer = posixOnly || (!hasPython && 'python3 (3.9+) is needed to scan');
const NOTE = (name) => new RegExp('^NOTE  .*' + name.replace('.', '\\.') + ' was not what this plugin writes; replaced it$', 'm');
const OPEN_ARGS = (root, extra = []) => [root, '--no-open', '--port', '0', '--claude', FAKE_CLAUDE, ...extra];

// the tests wait for servers, file watchers and "nothing happened" (seconds each): they run side by side, each in folders of its own, on port 0
describe('R28: nothing the repo committed in modelmap/ runs or is served', { concurrency: true }, () => {
  test('R28 repro: a modelmap/ with only index.html and a serve.mjs the repo committed is not run: open.mjs says "No built map here yet", exits 1, and writes nothing', { skip: skipPosix }, async () => {
    const base = tmpDir('modelmap-code-repro-');
    try {
      const root = path.join(base, 'repo'), map = path.join(root, 'modelmap'), marks = path.join(base, 'marks');
      fs.mkdirSync(marks);
      const stand = await standIn();
      try {
        plantHostile(map, hostileFiles(marks, { beacon: 'http://127.0.0.1:' + stand.port + '/beacon', queryText: '// not a real query.mjs\n' }), { only: ['index.html', 'serve.mjs'] });
        const before = tree(root);
        const r = await run(script('open.mjs'), OPEN_ARGS(root));
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stderr, /No built map here yet\. Run build\.mjs first\./);
        assert.deepEqual(tree(root), before, 'something was written, or changed');
        await sleep(1500); // a serve.mjs that was started would have written its marker by now
        assert.deepEqual(markers(marks), []);
        assert.deepEqual(stand.requests, []);
      } finally { await stopMap(map); await stand.close(); }
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  test('graph.json that is no map graph (missing, not JSON, an array, no nodes, no project name, a folder, an empty file) or a link: exit 1, nothing written, no marker', { skip: skipPosix }, async () => {
    const GOOD = JSON.stringify({ nodes: [], project: { name: 'x' } });
    const forms = {
      'no graph.json': () => {},
      'not JSON': (f) => fs.writeFileSync(f, '{ not json'),
      'an empty file': (f) => fs.writeFileSync(f, ''),
      'null': (f) => fs.writeFileSync(f, 'null'),
      'an array': (f) => fs.writeFileSync(f, '[]'),
      'a string': (f) => fs.writeFileSync(f, '"x"'),
      'no nodes': (f) => fs.writeFileSync(f, '{"project":{"name":"x"}}'),
      'nodes is an object': (f) => fs.writeFileSync(f, '{"nodes":{},"project":{"name":"x"}}'),
      'no project': (f) => fs.writeFileSync(f, '{"nodes":[]}'),
      'project is a string': (f) => fs.writeFileSync(f, '{"nodes":[],"project":"x"}'),
      'project.name is a number': (f) => fs.writeFileSync(f, '{"nodes":[],"project":{"name":5}}'),
      'a folder': (f) => fs.mkdirSync(f),
      'a link to a real graph.json': (f) => { fs.writeFileSync(path.join(path.dirname(f), '..', 'real-graph.json'), GOOD); fs.symlinkSync('../real-graph.json', f); },
      'a link to a graph.json that is not there': (f) => fs.symlinkSync('../nothing.json', f),
    };
    const failures = [];
    await pool(Object.entries(forms), 6, async ([name, make]) => {
      const base = tmpDir('modelmap-code-graph-');
      try {
        const root = path.join(base, 'repo'), map = path.join(root, 'modelmap'), marks = path.join(base, 'marks');
        fs.mkdirSync(marks);
        plantHostile(map, hostileFiles(marks, { queryText: '// not a real query.mjs\n' }));
        make(path.join(map, 'graph.json'));
        const before = tree(root), outside = fs.readdirSync(base).sort();
        const r = await run(script('open.mjs'), OPEN_ARGS(root));
        try {
          assert.equal(r.status, 1, r.stdout + r.stderr);
          assert.match(r.stderr, /No built map here yet\. Run build\.mjs first\.|is a symbolic link/);
          assert.deepEqual(tree(root), before, 'something was written, or changed');
          assert.deepEqual(fs.readdirSync(base).sort(), outside);
          await sleep(300);
          assert.deepEqual(markers(marks), []);
        } catch (e) { failures.push(name + ': ' + String(e.message).split('\n')[0]); }
      } finally { await stopMap(path.join(base, 'repo', 'modelmap')); fs.rmSync(base, { recursive: true, force: true }); }
    });
    assert.deepEqual(failures, []);
  });

  // ---------- hostile files over a real map: the plugin's own come back, and nothing the repo shipped runs ----------

  /** open.mjs over a copy of the golden map whose four files were replaced by hostile ones (out: the map is in a folder the person chose). */
  async function hostileOpen({ out = false, readOnly = [], only = FOUR } = {}) {
    const w = copyGold();
    const stand = await standIn();
    try {
      const map = out ? path.join(w.base, 'chosen') : w.map;
      if (out) fs.cpSync(w.map, map, { recursive: true });
      const files = hostileFiles(w.marks, { beacon: 'http://127.0.0.1:' + stand.port + '/beacon' });
      plantHostile(map, files, { only, readOnly });
      const before = Object.fromEntries(FOUR.map((n) => [n, fs.readFileSync(path.join(map, n))]));
      const r = await run(script('open.mjs'), OPEN_ARGS(w.root, out ? ['--out', map] : []));
      return { w, map, stand, r, files, before, out: r.stdout + r.stderr };
    } catch (e) { await stand.close(); w.done(); throw e; }
  }
  const cleanup = async (x) => { await stopMap(x.map); await x.stand.close(); x.w.done(); };

  for (const out of [false, true]) {
    test('R28: ' + (out ? '--out DIR: ' : '') + 'a built map whose index.html, query.mjs, serve.mjs and page-safety.mjs were replaced by hostile files (serve.mjs read-only): open.mjs writes the plugin\'s own, one NOTE each, and the server serves and runs those', { skip: skipServer }, async () => {
      const x = await hostileOpen({ out, readOnly: ['serve.mjs'] });
      try {
        assert.equal(x.r.status, 0, x.out);
        // the four files are what build.mjs writes for the same scan (byte for byte, from another folder)
        for (const n of FOUR) assert.ok(same(path.join(x.map, n), path.join(x.w.ref, n)), n + ' is not what the plugin writes');
        for (const n of FOUR) assert.match(x.r.stdout, NOTE(n));
        assert.equal(x.r.stdout.split('\n').filter((l) => /^NOTE /.test(l)).length, 4, x.r.stdout);
        assert.ok(fs.statSync(path.join(x.map, 'serve.mjs')).mode & 0o200, 'the read-only leftover was replaced by a file that can be written');
        const shown = MODELMAP_LINE.exec(x.r.stdout);
        assert.ok(shown, x.out);
        // nothing the repo shipped ran: not at once, not later
        assert.deepEqual(markers(x.w.marks), []);
        await sleep(3000);
        assert.deepEqual(markers(x.w.marks), []);
        // the running server: its page is the plugin's, and it reports this map's root and the plugin's code hash
        const page = await get(x.map, '/', { token: false });
        assert.equal(page.status, 200);
        assert.ok(!page.body.includes('HOSTILE-PAGE-SENTINEL') && !page.body.includes('127.0.0.1:' + x.stand.port), 'the hostile page was served');
        assert.ok(page.body.includes('window.FLOORPLAN_SERVER') && page.body.includes('modelmap/graph@1'));
        assert.deepEqual(x.stand.requests, []);
        const st = JSON.parse((await get(x.map, '/api/status')).body);
        assert.equal(fs.realpathSync(st.root), fs.realpathSync(path.dirname(x.map)));
        assert.equal(st.hash, codeHash12(x.w.ref));
        assert.equal(st.hash, readServerRecord(recordFile(x.map)).rec && JSON.parse(fs.readFileSync(recordFile(x.map), 'utf8')).hash);
        // Ask runs the plugin's query.mjs (the CLI is the fake one, which runs node modelmap/query.mjs): the lookup works, no hostile marker is written
        if (!out) {
          const rec = readServerRecord(recordFile(x.map)).rec;
          const a = await ask({ port: rec.port, token: rec.token }, { question: '#tool n:blocks' });
          assert.ok(a.events.some((e) => e.event === 'answer' && e.data.answer.includes('9,840')), a.body);
          await sleep(500);
          assert.deepEqual(markers(x.w.marks), []);
        }
      } finally { await cleanup(x); }
    });
  }

  test('open.mjs writes the files that are missing (graph.json alone is enough), says so, and starts nothing from the folder', { skip: skipServer }, async () => {
    const x = await hostileOpen({ only: ['index.html'] });
    const w = x.w;
    try {
      await stopMap(x.map);
      for (const n of ['query.mjs', 'serve.mjs', 'page-safety.mjs']) fs.rmSync(path.join(x.map, n));
      fs.rmSync(path.join(x.map, '.cache'), { recursive: true, force: true });
      const r = await run(script('open.mjs'), OPEN_ARGS(w.root));
      assert.equal(r.status, 0, r.stdout + r.stderr);
      for (const n of ['query.mjs', 'serve.mjs', 'page-safety.mjs']) assert.match(r.stdout, new RegExp('^NOTE  .*' + n.replace('.', '\\.') + ' was missing; wrote it$', 'm'));
      assert.doesNotMatch(r.stdout, /index\.html was/, 'index.html was already the plugin\'s');
      for (const n of FOUR) assert.ok(same(path.join(x.map, n), path.join(w.ref, n)), n);
    } finally { await cleanup(x); }
  });

  test('the unattended message of open.mjs says a modelmap/ that came with a repo is not trusted until build.mjs or open.mjs has written it, and starts nothing', () => {
    const r = spawnSync(process.execPath, [script('open.mjs'), '.', '--unattended'], { encoding: 'utf8', cwd: tmpDir('modelmap-code-unattended-') });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /modelmap\/index\.html/);
    assert.match(r.stdout, /only after build\.mjs \(or open\.mjs without --unattended\) has run on this computer: a modelmap\/ that came with a repo is not trusted before that\./);
  });

  // ---------- the normal flow, a restart when only part of the code changed ----------

  const open = (root, plugin) => run(plugin ? plugin.script('open.mjs') : script('open.mjs'), OPEN_ARGS(root));

  test('the normal flow: scan, build, open, open again: the second open changes no file (bytes and times), keeps the server, prints the same, and says no NOTE', { skip: skipServer }, async () => {
    const { map, root } = buildMap(fixture('mini-model'));
    try {
      const built = tree(map);
      const a = await open(root);
      assert.equal(a.status, 0, a.stdout + a.stderr);
      assert.doesNotMatch(a.stdout + a.stderr, /NOTE/, 'a map the plugin built is what the plugin writes');
      const afterFirst = tree(map);
      for (const n of [...FOUR, 'graph.json', '.gitignore']) assert.deepEqual(afterFirst[n], built[n], n + ' was touched by the first open');
      const pid = readServerRecord(recordFile(map)).rec.pid;
      const b = await open(root);
      assert.equal(b.status, 0, b.stdout + b.stderr);
      assert.deepEqual(tree(map), afterFirst, 'the second open changed something');
      assert.equal(readServerRecord(recordFile(map)).rec.pid, pid, 'the server was restarted');
      assert.equal(b.stdout, a.stdout);
      assert.doesNotMatch(b.stdout + b.stderr, /NOTE/);
    } finally { await stopMap(map); fs.rmSync(path.dirname(root), { recursive: true, force: true }); }
  });

  test('a plugin version that changes only query.mjs, only page-safety.mjs or only serve.mjs restarts the server (the hash covers all three), and no other file is touched', { skip: skipServer }, async () => {
    const variants = {
      'query.mjs': { 'assets/query-cli.mjs': (old) => old + '\n// a newer query-cli\n' },
      'page-safety.mjs': { 'assets/page-safety.mjs': (old) => old + '\n// a newer page-safety\n' },
      'serve.mjs': { 'assets/serve.mjs': (old) => old + '\n// a newer serve\n' },
    };
    const failures = [];
    await pool(Object.entries(variants), 3, async ([name, change]) => {
      const w = copyGold();
      const plugin = pluginCopy(change);
      try {
        const a = await open(w.root);
        assert.equal(a.status, 0, a.stdout + a.stderr);
        const first = readServerRecord(recordFile(w.map)).rec, hash1 = JSON.parse((await get(w.map, '/api/status')).body).hash;
        const before = tree(w.map);
        const b = await open(w.root, plugin);
        try {
          assert.equal(b.status, 0, b.stdout + b.stderr);
          assert.equal(b.stdout.split('\n').filter((l) => /^NOTE /.test(l)).length, 1, b.stdout);
          assert.match(b.stdout, NOTE(name));
          const second = readServerRecord(recordFile(w.map)).rec;
          assert.notEqual(second.pid, first.pid, 'the server was not restarted');
          for (let t = 0; t < 3000 && alive(first.pid); t += 100) await sleep(100);
          assert.ok(!alive(first.pid), 'the old server is still running');
          const hash2 = JSON.parse((await get(w.map, '/api/status')).body).hash;
          assert.notEqual(hash2, hash1);
          assert.equal(hash2, codeHash12(w.map));
          const after = tree(w.map);
          for (const n of FOUR.filter((f) => f !== name && f !== 'index.html')) assert.deepEqual(after[n], before[n], n + ' was touched');
          assert.match(fs.readFileSync(path.join(w.map, name), 'utf8'), /\/\/ a newer (query-cli|page-safety|serve)\n$/);
        } catch (e) { failures.push(name + ': ' + String(e.message).split('\n')[0]); }
      } finally { await stopMap(w.map); plugin.done(); w.done(); }
    });
    assert.deepEqual(failures, []);
  });

  // ---------- the running server and a query.mjs that is replaced under it ----------

  const QUERY_CHANGED = 'modelmap/query.mjs changed after this server started, so Ask is off. Run open.mjs again.';
  const text = (f) => fs.readFileSync(f, 'utf8');
  /** The server-sent events of the map's server (what an open tab gets), collected: { text(), close() }. */
  function tab(srv) {
    let got = '';
    const req = http.get({ host: '127.0.0.1', port: srv.port, path: '/api/events?token=' + srv.token, headers: { host: '127.0.0.1:' + srv.port } }, (res) => { res.on('data', (d) => { got += d; }); });
    req.on('error', () => {});
    return { text: () => got, close: () => req.destroy() };
  }
  const pageOf = async (srv) => (await fetch('http://127.0.0.1:' + srv.port + '/')).text();
  const PROBE = '<!-- reload-probe -->';

  test('server: a query.mjs that is replaced while it runs is not loaded when index.html changes (no marker, the old map stays, one log line); the right bytes again, or a rebuild by the same plugin, reload as before and Ask works', { skip: skipServer }, async () => {
    const w = copyGold();
    const tabs = [];
    let srv;
    try {
      srv = await startServe(w.map);
      const t = tab(srv); tabs.push(t);
      assert.match((await ask(srv, { question: 'before' })).body, /event: answer/);
      const good = text(path.join(w.map, 'query.mjs')), html = text(path.join(w.map, 'index.html'));
      // a git pull (or anything else) puts a different query.mjs there, and the page changes with it
      fs.writeFileSync(path.join(w.map, 'query.mjs'), hostileFiles(w.marks)['query.mjs']);
      fs.writeFileSync(path.join(w.map, 'index.html'), html + '\n' + PROBE + '\n');
      assert.ok(await waitFor(() => srv.output().includes(QUERY_CHANGED + ' The map was not reloaded.'), 8000), 'no log line: ' + srv.output());
      await sleep(800);
      assert.deepEqual(markers(w.marks), [], 'the hostile query.mjs ran');
      assert.ok(!(await pageOf(srv)).includes(PROBE), 'the changed map was loaded');
      assert.ok(!t.text().includes('event: reload'), 'open tabs were told to reload');
      assert.equal((srv.output().match(/changed after this server started/g) || []).length, 1, 'one log line: ' + srv.output());
      assert.equal((await fetch('http://127.0.0.1:' + srv.port + '/api/status', { headers: { 'x-floorplan-token': srv.token } })).status, 200, 'the server keeps answering');
      // the right bytes again and a new mtime: it loads the map it was holding back, and tells the tabs
      fs.writeFileSync(path.join(w.map, 'query.mjs'), good);
      fs.writeFileSync(path.join(w.map, 'index.html'), html + '\n' + PROBE + '\n');
      assert.ok(await waitFor(() => t.text().includes('event: reload'), 8000), 'no reload after the file was right again');
      assert.ok((await pageOf(srv)).includes(PROBE));
      assert.match((await ask(srv, { question: 'after' })).body, /event: answer/);
      // a rebuild by this same plugin writes the same query.mjs again: the tabs reload, Ask works
      const reloads = () => (t.text().match(/event: reload/g) || []).length, seen = reloads();
      const b = nodeRun(script('build.mjs'), [w.root, '--out', w.map]);
      assert.equal(b.status, 0, b.stderr);
      assert.ok(await waitFor(() => reloads() > seen, 8000), 'a rebuild by the same plugin did not reload the tabs: ' + srv.output());
      assert.ok(!(await pageOf(srv)).includes(PROBE), 'the rebuilt page is the new one');
      assert.match((await ask(srv, { question: 'after the rebuild' })).body, /event: answer/);
      assert.equal(calls(srv.log).length, 3);
      assert.deepEqual(markers(w.marks), []);
    } finally { tabs.forEach((x) => x.close()); await srv?.stop(); w.done(); }
  });

  for (const engine of ['claude', 'codex']) {
    test('server: with a query.mjs that is no longer the one it started with, an Ask (' + engine + ' path) does not start the CLI and ends with the failure event; the one before it worked', { skip: skipServer }, async () => {
      const w = copyGold();
      let srv;
      try {
        srv = await startServe(w.map, { args: engine === 'codex' ? ['--engine', 'codex', '--codex', FAKE_CLAUDE] : [] });
        // the control: before the file changes the CLI is started (the fake one speaks Claude's protocol only, so Codex's answer is a failure of its own)
        const first = await ask(srv, { question: '#tool n:blocks' });
        if (engine === 'claude') assert.match(first.body, /event: answer/);
        assert.equal(calls(srv.log).length, 1, first.body);
        fs.writeFileSync(path.join(w.map, 'query.mjs'), hostileFiles(w.marks)['query.mjs']); // index.html is not touched: no reload happens
        const r = await ask(srv, { question: '#tool n:blocks' });
        assert.deepEqual(r.events.filter((e) => e.event !== 'progress'), [{ event: 'failure', data: { code: 'query_changed', message: QUERY_CHANGED } }], r.body);
        assert.equal(calls(srv.log).length, 1, 'the CLI was started');
        await sleep(500);
        assert.deepEqual(markers(w.marks), [], 'the hostile query.mjs ran');
        // once the file is right again, Ask works again
        fs.writeFileSync(path.join(w.map, 'query.mjs'), text(path.join(w.ref, 'query.mjs')));
        const again = await ask(srv, { question: '#tool n:blocks' });
        if (engine === 'claude') assert.match(again.body, /event: answer/);
        assert.equal(calls(srv.log).length, 2, again.body);
      } finally { await srv?.stop(); w.done(); }
    });
  }

  // ---------- build.mjs writes what it wrote before ----------

  const BEFORE = '1f1a6bf'; // the commit before the shared function: build.mjs of that commit is the reference
  const hasBefore = spawnSync('git', ['-C', repo, 'cat-file', '-e', BEFORE + '^{commit}'], { stdio: 'ignore' }).status === 0;
  test('build.mjs writes the same bytes as at ' + BEFORE + ' for the same scan: index.html, query.mjs, serve.mjs, page-safety.mjs, graph.json and .gitignore, and prints the same report', { skip: skipServer || (!hasBefore && 'not a git checkout that has commit ' + BEFORE) }, () => {
    const g = golden();
    // the plugin of this tree, with the build.mjs of that commit (its page code is in build.mjs itself, so it does not use lib/mapfiles.mjs)
    const old = spawnSync('git', ['-C', repo, 'show', BEFORE + ':skills/modelmap/scripts/build.mjs'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    assert.equal(old.status, 0, old.stderr);
    const plugin = pluginCopy({ 'scripts/build.mjs': old.stdout });
    const base = tmpDir('modelmap-code-build-');
    try {
      const out = { old: path.join(base, 'old'), now: path.join(base, 'now') };
      for (const d of Object.values(out)) { fs.mkdirSync(path.join(d, '.cache'), { recursive: true }); fs.copyFileSync(path.join(g.map, '.cache', 'scan.json'), path.join(d, '.cache', 'scan.json')); }
      const a = nodeRun(plugin.script('build.mjs'), [g.root, '--out', out.old], { frozen: true });
      const b = nodeRun(script('build.mjs'), [g.root, '--out', out.now], { frozen: true });
      assert.equal(a.status, 0, a.stderr);
      assert.equal(b.status, 0, b.stderr);
      for (const n of [...FOUR, 'graph.json', '.gitignore']) assert.ok(same(path.join(out.old, n), path.join(out.now, n)), n + ' differs from what ' + BEFORE + ' wrote');
      assert.equal(b.stdout.split(out.now).join('<out>'), a.stdout.split(out.old).join('<out>'));
      assert.ok(a.stdout.includes('MODEL') && a.stdout.includes('wrote'), 'the reference build ran: ' + a.stdout);
    } finally { plugin.done(); fs.rmSync(base, { recursive: true, force: true }); }
  });
});
