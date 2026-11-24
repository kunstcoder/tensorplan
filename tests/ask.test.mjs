// Ask (plan claim 4.2): a question on the map goes to the Claude Code CLI with read-only tools and exactly one
// allowed command, node modelmap/query.mjs, and every number in the answer comes from that lookup tool.
// All of it runs against the FAKE CLI in tests/fixtures/fake-cli/fake-claude.mjs, passed with --claude. These tests
// prove what serve.mjs ASKS the CLI to do (its arguments, prompt and stdin) and how it handles what comes back;
// they do NOT prove how the real Claude Code CLI behaves with those flags.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hasPython, fixture } from './helpers.mjs';
import { buildMap, startServe, calls, ask, request, alive, waitFor } from './helpers-ask.mjs';

const skip = !hasPython && 'python3 (3.9+) is needed to scan the fixture';
let map, root, srv;
before(async () => {
  if (skip) return;
  ({ map, root } = buildMap(fixture('mini-model')));
  srv = await startServe(map);
});
after(async () => { if (srv) await srv.stop(); });

const after1 = (argv, flag) => argv[argv.indexOf(flag) + 1];
/** The values that follow a flag, up to the next --flag. */
const valuesOf = (argv, flag) => { const i = argv.indexOf(flag); const out = []; for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j]); return out; };
const lastCall = () => calls(srv.log).at(-1);
// the session id the real CLI hands out is a UUID; serve.mjs passes on nothing else
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('the whole chain: question, fake CLI, node modelmap/query.mjs params, answer with the number the tool printed', { skip }, async () => {
  const r = await ask(srv, { question: '#tool n:blocks' });
  assert.equal(r.status, 200);
  const names = r.events.map((e) => e.event);
  assert.deepEqual(names.filter((n) => n !== 'progress'), ['start', 'answer'], JSON.stringify(r.events));
  // the tool_use the fake printed is described in words for the page
  assert.ok(r.events.some((e) => e.event === 'progress' && /^Counting the parameters of /.test(e.data.text)), JSON.stringify(r.events));
  const call = lastCall();
  assert.equal(call.stdin, '#tool n:blocks', 'the question goes in on stdin');
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(root), 'the CLI runs in the repo root, the folder that holds modelmap/');
  assert.equal(call.tool.command, 'node modelmap/query.mjs params n:blocks');
  assert.equal(call.tool.exitCode, 0);
  const tool = JSON.parse(call.tool.stdout);
  assert.equal(tool.params.v, 9840);
  const answer = r.events.find((e) => e.event === 'answer').data;
  assert.ok(answer.answer.includes(tool.params.shown), 'the answer carries the count the tool printed: ' + answer.answer);
  assert.ok(answer.answer.includes('9,840'));
  assert.match(answer.answer, /\[\[n:blocks\]\]/);
  assert.deepEqual(answer.items.map((x) => x.id), ['n:blocks']);
  assert.ok(answer.session, 'the answer carries the session for a follow-up');
});

test('the CLI is started read-only: -p, stream-json, exactly one allowed Bash command, Read/Grep/Glob, the map\'s own files closed, no MCP servers, no permission bypass', { skip }, async () => {
  await ask(srv, { question: 'what is this model?' });
  const { argv } = lastCall();
  assert.ok(argv.includes('-p'));
  assert.equal(after1(argv, '--output-format'), 'stream-json');
  assert.equal(argv.filter((a) => a === '--allowedTools').length, 1);
  assert.deepEqual(valuesOf(argv, '--allowedTools'), ['Bash(node modelmap/query.mjs:*)', 'Read', 'Grep', 'Glob']);
  assert.deepEqual(argv.filter((a) => /^Bash\(/.test(a)), ['Bash(node modelmap/query.mjs:*)'], 'no other Bash rule anywhere');
  assert.equal(after1(argv, '--tools'), 'Read,Grep,Glob,Bash');
  assert.deepEqual(valuesOf(argv, '--disallowedTools'), ['Read(modelmap/index.html)', 'Read(modelmap/serve.mjs)', 'Read(modelmap/page-safety.mjs)', 'Read(modelmap/.cache/**)']);
  assert.ok(argv.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(after1(argv, '--mcp-config')), { mcpServers: {} });
  for (const a of argv) {
    assert.doesNotMatch(a, /dangerously|bypassPermissions|acceptEdits/i);
    assert.doesNotMatch(a, /floorplan\//, 'no floorplan/ path is left: ' + a);
  }
  assert.ok(!argv.includes('--permission-mode') && !argv.includes('--add-dir') && !argv.some((a) => a.startsWith('--resume')), 'a new conversation resumes nothing');
  // the answer schema
  const schema = JSON.parse(after1(argv, '--json-schema'));
  assert.deepEqual(schema.required, ['title', 'answer', 'items']);
  assert.match(schema.properties.items.description, /n:blocks/);
  // the instructions
  const prompt = after1(argv, '--append-system-prompt');
  assert.match(prompt, /the model "Net"/);
  assert.match(prompt, /Never state a number that no lookup printed/);
  assert.match(prompt, /Do no arithmetic yourself/);
  assert.match(prompt, /lowerBound is written with ≥/);
  assert.match(prompt, /what-if values yet/);
  assert.match(prompt, /Markdown in Korean, with the English term next to the Korean word/);
  for (const c of ['overview', 'find', 'show', 'params', 'contract']) assert.ok(prompt.includes('node modelmap/query.mjs ' + c), c);
  assert.doesNotMatch(prompt, /floorplan|endpoint|blueprint/i);
  assert.ok(prompt.length < 3000, 'the instructions stay compact: ' + prompt.length + ' characters');
});

test('a follow-up with the session id resumes that session', { skip }, async () => {
  const first = await ask(srv, { question: 'first question' });
  const session = first.events.find((e) => e.event === 'answer').data.session;
  assert.match(session, UUID, 'the fake CLI hands out a UUID, as the real one does');
  const second = await ask(srv, { question: 'and then?', session });
  assert.deepEqual(lastCall().argv.filter((a) => a.startsWith('--resume')), ['--resume=' + session]);
  assert.equal(second.events.find((e) => e.event === 'answer').data.session, session);
});

test('only the user\'s own settings load: the repo is untrusted, so its project and local settings (hooks, permissions, env) never apply to Ask', { skip }, async () => {
  await ask(srv, { question: 'what is this model?' });
  const { argv } = lastCall();
  assert.equal(argv.filter((a) => a === '--setting-sources').length, 1);
  assert.equal(argv[argv.indexOf('--setting-sources') + 1], 'user');
  assert.ok(!argv.some((a) => a.startsWith('--setting-sources=') || a === '--settings'), 'no second way to name settings');
  // no other token names a settings source
  assert.deepEqual(argv.filter((a) => /^[a-z,]+$/.test(a) && /(^|,)(project|local)(,|$)/.test(a)), []);
});

test('a follow-up passes a valid UUID as the one argument --resume=<id>, never as a separate --resume', { skip }, async () => {
  for (const session of [crypto.randomUUID(), crypto.randomUUID().toUpperCase()]) {
    const before = calls(srv.log).length;
    const r = await ask(srv, { question: 'and then?', session });
    assert.equal(calls(srv.log).length, before + 1, 'one CLI call');
    const { argv } = lastCall();
    assert.equal(argv.filter((a) => a === '--resume=' + session).length, 1);
    assert.ok(!argv.includes('--resume'), 'no bare --resume token');
    assert.deepEqual(argv.filter((a) => a.startsWith('--resume')), ['--resume=' + session], 'the only --resume argument');
    assert.equal(r.events.find((e) => e.event === 'answer').data.session, session);
  }
});

test('a session that is not a UUID is refused as bad_session: no CLI starts, and nothing of it reaches any argument', { skip }, async () => {
  const uuid = crypto.randomUUID();
  const hostile = [
    '--dangerously-skip-permissions', '--settings={"hooks":{}}', '-r', 'abc', uuid + 'x', 'x' + uuid, '-' + uuid, ' ' + uuid, uuid + ' ', uuid + '\n',
    uuid + '\n--dangerously-skip-permissions', '--resume=' + uuid, [uuid], { a: 1 }, 123, true, false, 0, [],
  ];
  for (const session of hostile) {
    const label = JSON.stringify(session);
    const before = calls(srv.log).length;
    const r = await ask(srv, { question: 'and then?', session });
    assert.equal(r.status, 200, label);
    assert.deepEqual(r.events.map((e) => e.event), ['failure'], label + ' ' + JSON.stringify(r.events));
    assert.equal(r.events[0].data.code, 'bad_session', label);
    assert.match(r.events[0].data.message, /follow-up id is not valid/, label);
    if (typeof session === 'string') assert.ok(!r.body.includes(session.trim()), 'the answer does not repeat it: ' + label);
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(calls(srv.log).length, before, 'no CLI started for ' + label);
    // the server still answers the next question
    const next = await ask(srv, { question: 'is it still up?' });
    assert.ok(next.events.some((e) => e.event === 'answer'), label);
  }
  // across every call the fake CLI ever got: no argument holds a hostile value, and every --resume is one canonical --resume=<uuid>
  const all = calls(srv.log).flatMap((c) => c.argv);
  for (const s of hostile.map((x) => typeof x === 'string' ? x : JSON.stringify(x))) {
    assert.ok(!all.some((a) => a === s || a === '--resume=' + s || (s.length > 5 && a.includes(s))), 'argv holds ' + JSON.stringify(s));
  }
  assert.ok(!all.includes('--resume'));
  for (const a of all.filter((x) => x.startsWith('--resume'))) assert.match(a, /^--resume=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

test('no session, an empty string and null are all a new conversation: no --resume argument at all', { skip }, async () => {
  for (const body of [{ question: 'fresh' }, { question: 'fresh', session: '' }, { question: 'fresh', session: null }]) {
    const before = calls(srv.log).length;
    const r = await ask(srv, body);
    assert.equal(calls(srv.log).length, before + 1, JSON.stringify(body));
    assert.ok(!lastCall().argv.some((a) => a.startsWith('--resume')), JSON.stringify(body));
    assert.match(r.events.find((e) => e.event === 'answer').data.session, UUID, JSON.stringify(body));
  }
});

test('/api/cancel stops a running CLI', { skip }, async () => {
  const before = calls(srv.log).length;
  const pending = ask(srv, { question: '#hang' });
  const call = await waitFor(() => calls(srv.log).slice(before).find((c) => c.hang));
  assert.ok(call, 'the fake started');
  assert.ok(alive(call.pid));
  const c = await request(srv.port, { method: 'POST', path: '/api/cancel', headers: { 'x-floorplan-token': srv.token } });
  assert.equal(c.status, 204);
  assert.ok(await waitFor(() => !alive(call.pid)), 'the fake was stopped');
  const r = await pending;
  assert.ok(!r.events.some((e) => e.event === 'answer'));
});

test('a CLI that fails gives the codes the page knows: not_logged_in, rate_limited, cli_error', { skip }, async () => {
  const code = async (q) => (await ask(srv, { question: q })).events.find((e) => e.event === 'failure')?.data;
  assert.equal((await code('#login')).code, 'not_logged_in');
  assert.equal((await code('#ratelimit')).code, 'rate_limited');
  const crash = await code('#crash');
  assert.equal(crash.code, 'cli_error');
  assert.match(crash.message, /fake crash: something broke/);
});

test('an oversized question body is refused and starts no CLI', { skip }, async () => {
  const before = calls(srv.log).length;
  const r = await ask(srv, { question: 'x'.repeat(30000) });
  assert.ok(r.error || !r.events.some((e) => e.event === 'start'), 'refused: ' + JSON.stringify({ status: r.status, error: r.error }));
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(calls(srv.log).length, before);
  // the server is still up
  assert.equal((await request(srv.port, { path: '/api/health', headers: { 'x-floorplan-token': srv.token } })).status, 200);
});

test('a long question is cut to 4000 characters before it reaches the CLI', { skip }, async () => {
  await ask(srv, { question: 'y'.repeat(9000) });
  assert.equal(lastCall().stdin.length, 4000);
});

test('/api/health names the fake CLI, and the page is told which engine answers', { skip }, async () => {
  const h = JSON.parse((await request(srv.port, { path: '/api/health', headers: { 'x-floorplan-token': srv.token } })).body);
  assert.equal(h.cli, true);
  assert.equal(h.engine, 'claude');
  assert.match(h.version, /Fake Claude Code/);
  assert.equal(h.path, path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'fake-cli', 'fake-claude.mjs'));
  const page = (await request(srv.port, { path: '/' })).body;
  const injected = JSON.parse(/<script>window\.FLOORPLAN_SERVER=(\{.*?\});<\/script>/.exec(page)[1]);
  assert.equal(injected.token, srv.token);
  assert.equal(injected.change, false, 'a model map has no blueprint Change mode');
});
