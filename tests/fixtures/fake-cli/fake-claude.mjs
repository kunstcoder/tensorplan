#!/usr/bin/env node
// Stands in for the Claude Code CLI ("claude") in tests. It never contacts anything: it answers --version, and
// for -p it appends { argv, stdin, cwd, pid, tool? } as one JSON line to $FAKE_CLAUDE_LOG, then prints the
// stream-json lines serve.mjs reads from a real run: system init (with the session id), assistant messages
// (tool_use), and a result whose structured_output follows the answer schema.
// When $FAKE_CLAUDE_ENV_LOG is set it also appends { kind: 'version' | 'run', pid, env } as one JSON line (the names AND values of its
// own environment) for --version and for every -p run, which is how the tests see what serve.mjs hands to the CLI.
// What it does depends on the question it reads on stdin:
//   #tool <id>   runs "node modelmap/query.mjs params <id>" (a child process, in its working folder) and puts the
//                count that tool printed into the answer: question, CLI, tool, answer
//   #hang        waits (for /api/cancel to stop it)
//   #wait <file> logs { wait: true } and waits until <file> exists (the test makes it), then answers as for anything else; /api/cancel
//                stops it before that. Several can run at once.
//   #login       a result with is_error: "Not logged in · Please run /login"
//   #ratelimit   no result, "API Error: 429 rate limit exceeded" on stderr, exit 1
//   #crash       no result, "fake crash: something broke" on stderr, exit 3
//   anything else: a short answer
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const envLog = (kind) => { if (process.env.FAKE_CLAUDE_ENV_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_ENV_LOG, JSON.stringify({ kind, pid: process.pid, env: process.env }) + '\n'); };
if (argv[0] === '--version') { envLog('version'); console.log('9.9.9 (Fake Claude Code, test)'); process.exit(0); }
envLog('run');
const out = (ev) => process.stdout.write(JSON.stringify(ev) + '\n');
const log = (rec) => { if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(rec) + '\n'); };
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', async () => {
  // the session id is one `--resume=<id>` argument (a bare --resume is not read); a new one is a UUID, as the real CLI's
  const resume = argv.find((a) => a.startsWith('--resume='));
  const session = resume ? resume.slice('--resume='.length) : crypto.randomUUID();
  const rec = { argv, stdin, cwd: process.cwd(), pid: process.pid };
  const q = stdin.trim();
  out({ type: 'system', subtype: 'init', session_id: session, tools: ['Read', 'Grep', 'Glob', 'Bash'], mcp_servers: [] });
  if (q.startsWith('#hang')) { log({ ...rec, hang: true }); setTimeout(() => {}, 120000); return; }
  const wait = /^#wait\s+(\S+)/.exec(q);
  if (wait) { log({ ...rec, wait: true }); while (!fs.existsSync(wait[1])) await new Promise((r) => setTimeout(r, 50)); }
  if (q.startsWith('#login')) { log(rec); out({ type: 'result', subtype: 'success', is_error: true, session_id: session, result: 'Not logged in · Please run /login' }); process.exit(1); }
  if (q.startsWith('#ratelimit')) { log(rec); process.stderr.write('API Error: 429 rate limit exceeded\n'); process.exit(1); }
  if (q.startsWith('#crash')) { log(rec); process.stderr.write('fake crash: something broke\n'); process.exit(3); }
  let answer = { title: 'Fake answer', answer: 'Fake answer to: ' + q.slice(0, 200), items: [{ id: 'n:root', note: 'the model' }], steps: [], followups: [] };
  const tool = /^#tool\s+(\S+)/.exec(q);
  if (tool) {
    const command = 'node modelmap/query.mjs params ' + tool[1];
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command } }] } });
    // the same program and arguments the allowed Bash rule names, without a shell
    const run = spawnSync(process.execPath, ['modelmap/query.mjs', 'params', tool[1]], { encoding: 'utf8' });
    rec.tool = { command, exitCode: run.status, stdout: run.stdout };
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: run.stdout }] } });
    let data = null;
    try { data = JSON.parse(run.stdout); } catch {}
    answer = data && !data.error
      ? { title: 'Parameter count', answer: '[[' + data.id + ']] 의 파라미터(parameters)는 ' + data.params.shown + ' 개입니다 (출처 source: ' + data.params.src + ').', items: [{ id: data.id, note: 'the module asked about' }], steps: [], followups: ['가장 큰 자식 모듈(child module)은?'] }
      : { title: 'Lookup failed', answer: 'The lookup failed: ' + String(data?.error || run.stdout), items: [], steps: [], followups: [] };
  }
  log(rec);
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: JSON.stringify(answer), structured_output: answer });
});
