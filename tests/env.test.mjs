// R16: the CLI that answers an Ask (and every process it starts, such as node modelmap/query.mjs) gets the environment it needs and
// nothing else. serve.mjs builds it from an allow-list in one function (cliEnv), used for the --version check, the Claude run and the
// Codex run. What is checked here is what serve.mjs hands over, with the FAKE CLI (tests/fixtures/fake-cli, which logs its own
// environment when FAKE_CLAUDE_ENV_LOG is set) and with the function itself on tables of names; whether the real Claude Code and Codex
// CLIs still sign in and answer with this environment was NOT checked (UPSTREAM.md section 19).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { hasPython, fixture, tmpDir, repo } from './helpers.mjs';
import { buildMap, startServe, calls, ask, FAKE_CLAUDE } from './helpers-ask.mjs';

const skip = !hasPython && 'python3 (3.9+) is needed to scan the fixture';
const SERVE = path.join(repo, 'skills', 'modelmap', 'assets', 'serve.mjs');
const posix = process.platform === 'win32' ? 'the hook and the hostile variables are POSIX' : false;

// ---------- cliEnv on tables of names: the block of serve.mjs between its two marker lines, run on a made-up process ----------
const BLOCK = (() => {
  const text = fs.readFileSync(SERVE, 'utf8');
  const a = text.indexOf('// ---------- the environment the CLI gets (cliEnv) ----------');
  const b = text.indexOf('// ---------- end of the environment the CLI gets ----------');
  assert.ok(a > 0 && b > a, 'the cliEnv block of serve.mjs has its two marker lines');
  return text.slice(a, b);
})();
/** { cliEnv, passNote } as they are when this server's own environment is env (on the platform). */
function envOf(env, platform = 'linux') {
  const ctx = vm.createContext({ process: { env, platform } });
  vm.runInContext(BLOCK + '\nthis.out = { cliEnv, passNote };', ctx);
  return ctx.out;
}
const give = (env, platform) => Object.keys(envOf(env, platform).cliEnv()).sort();

const PASS = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TMPDIR', 'TEMP', 'TMP', 'TZ', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME'];
const NOT = ['GITHUB_TOKEN', 'GH_TOKEN', 'NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_PROFILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'GCLOUD_PROJECT', 'CLOUD_ML_REGION', 'AZURE_API_KEY',
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_HISTORY', 'NODE_ENV', 'PYTHONSTARTUP', 'PYTHONPATH', 'PYTHONHOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'BASH_ENV', 'ENV', 'PS4',
  'GIT_DIR', 'GIT_CONFIG_GLOBAL', 'GIT_SSH_COMMAND', 'SSH_AUTH_SOCK', 'SOMETHING_SECRET', 'MY_PASSWORD', 'STRIPE_KEY', 'aws_secret_access_key', 'PWD', 'OLDPWD', 'SHLVL', 'EDITOR', 'DISPLAY', 'LANGUAGE', '_', 'MODELMAP_MODEL', 'FAKE_CLAUDE_LOG',
  // this server was started from a Claude Code or Codex session: the CLI must not think it is nested in it
  'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI', 'CODEX_SANDBOX_NETWORK_DISABLED'];
const table = () => Object.fromEntries([...PASS, ...NOT].map((k) => [k, 'v-' + k]));

test('cliEnv: the system, network and the CLIs\' own variables pass; secrets, code-loading variables and the nested-session ones do not', () => {
  assert.deepEqual(give(table()), [...PASS].sort());
  const env = envOf(table()).cliEnv();
  for (const k of PASS) assert.equal(env[k], 'v-' + k, 'the value of ' + k);
  assert.deepEqual(Object.keys(envOf({}).cliEnv()), []);
});

test('cliEnv: MODELMAP_PASS_ENV passes a named variable and a prefix, but never what is never passed, and says its names (not values) once', () => {
  const env = {
    ...table(), MODELMAP_PASS_ENV: 'MY_VAR, PREFIX_* ,NODE_OPTIONS,GIT_DIR,TOKENISH_KEY,CUSTOM_*,PYTHON*,N*,LD_*,DYLD_*,bad name,*,x-y',
    MY_VAR: 'secret-value-1', PREFIX_A: 'secret-value-2', PREFIX_B: 'v', CUSTOM_X: 'v', CUSTOM_SECRET: 'v', TOKENISH_KEY: 'v', MY_VARIANT: 'v',
  };
  const got = give(env);
  for (const k of ['MY_VAR', 'PREFIX_A', 'PREFIX_B', 'CUSTOM_X']) assert.ok(got.includes(k), k + ' passes');
  for (const k of ['MY_VARIANT', 'NODE_OPTIONS', 'NODE_PATH', 'GIT_DIR', 'TOKENISH_KEY', 'CUSTOM_SECRET', 'PYTHONSTARTUP', 'PYTHONPATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY']) {
    assert.ok(!got.includes(k), k + ' must not pass');
  }
  assert.ok(got.includes('NODE_ENV'), 'N* passes NODE_ENV, which is not on the never list');
  const note = envOf(env).passNote();
  assert.equal(note[0], 'also passing these variables to the CLI (MODELMAP_PASS_ENV): MY_VAR, PREFIX_*, NODE_OPTIONS, GIT_DIR, TOKENISH_KEY, CUSTOM_*, PYTHON*, N*, LD_*, DYLD_*');
  assert.match(note.join('\n'), /never passed, even when named: NODE_OPTIONS, GIT_DIR, TOKENISH_KEY/);
  assert.match(note.join('\n'), /ignored, as they are not NAME or PREFIX\*: 3 entries/);
  assert.doesNotMatch(note.join('\n'), /secret-value|v-NODE_OPTIONS|bad name/);
  assert.equal(envOf(table()).passNote().length, 0, 'nothing is said when it is not set');
  // a name is NAME or PREFIX*: no pattern characters, the star only last
  assert.equal(give({ A_B: '1', AXB: '1', MODELMAP_PASS_ENV: 'A*B,A.B,A?B,[AB]*' }).length, 0);
});

test('cliEnv: a cloud mode passes its own credentials only while its switch is on', () => {
  const clouds = { AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b', AWS_SESSION_TOKEN: 'c', AWS_REGION: 'd', AWS_PROFILE: 'e',
    GOOGLE_APPLICATION_CREDENTIALS: 'f', GOOGLE_CLOUD_PROJECT: 'g', CLOUD_ML_REGION: 'h', GCLOUD_PROJECT: 'i', AZURE_API_KEY: 'j', AZURE_CLIENT_SECRET: 'k', AZURE_TENANT_ID: 'l' };
  const AWS = Object.keys(clouds).filter((k) => k.startsWith('AWS_')), GCP = ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'CLOUD_ML_REGION', 'GCLOUD_PROJECT'], AZ = Object.keys(clouds).filter((k) => k.startsWith('AZURE_'));
  const only = (extra) => give({ ...clouds, ...extra }).filter((k) => k in clouds);
  assert.deepEqual(only({}), [], 'no switch: none of them');
  assert.deepEqual(only({ CLAUDE_CODE_USE_BEDROCK: '1' }), AWS.sort());
  assert.deepEqual(only({ CLAUDE_CODE_USE_VERTEX: 'true' }), GCP.sort());
  assert.deepEqual(only({ CLAUDE_CODE_USE_FOUNDRY: '1' }), AZ.sort());
  assert.deepEqual(only({ CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1' }), [...AWS, ...GCP].sort());
  for (const off of ['0', 'false', 'False', 'no', 'off', '', ' ']) assert.deepEqual(only({ CLAUDE_CODE_USE_BEDROCK: off }), [], 'switch ' + JSON.stringify(off));
  // a cloud mode never lets through what is never passed
  assert.deepEqual(give({ CLAUDE_CODE_USE_BEDROCK: '1', NODE_OPTIONS: '--x', GIT_DIR: '/x', LD_PRELOAD: '/x', GITHUB_TOKEN: 'x', AWS_X: 'y' }), ['AWS_X', 'CLAUDE_CODE_USE_BEDROCK']);
});

test('cliEnv on Windows: names are matched without case, and the system variables of Windows pass', () => {
  const env = { Path: 'p', SystemRoot: 'r', windir: 'w', ComSpec: 'c', PATHEXT: 'e', USERPROFILE: 'u', APPDATA: 'a', LOCALAPPDATA: 'l', ProgramData: 'd', ProgramFiles: 'f', 'ProgramFiles(x86)': 'g', HOMEDRIVE: 'C:', HOMEPATH: '\\x', Temp: 't', http_proxy: 'h',
    Anthropic_Api_Key: 'k', Node_Options: '--x', GitHub_Token: 't', Ld_Preload: 'x', Git_Dir: 'x', USERNAME: 'n', OS: 'Windows_NT' };
  assert.deepEqual(give(env, 'win32'), ['ANTHROPIC_API_KEY', 'APPDATA', 'ComSpec', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATHEXT', 'Path', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'SystemRoot', 'Temp', 'USERPROFILE', 'http_proxy', 'windir'].map((k) => k === 'ANTHROPIC_API_KEY' ? 'Anthropic_Api_Key' : k).sort());
  // on a system with case-sensitive names the Windows ones are just other names
  assert.deepEqual(give({ SystemRoot: 'r', Path: 'p', PATH: 'q' }), ['PATH']);
});

// ---------- the server, with the fake CLI that logs what it was given ----------
let map, work, hook, marker, envLog, hostile, expected;
before(() => {
  if (skip || posix) return;
  ({ map } = buildMap(fixture('mini-model')));
  work = tmpDir('modelmap-env-');
  // a NODE_OPTIONS that any node process which gets it runs: it notes its pid (the server holds it itself, so exactly one line is right)
  marker = path.join(work, 'hook-marker');
  hook = path.join(work, 'hook.cjs');
  fs.writeFileSync(hook, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.pid + '\\n');\n`);
  envLog = path.join(work, 'env.jsonl');
  // the variables this server can survive: a preload of a library that is not there ends node on macOS (DYLD_) and warns on Linux (LD_)
  const survives = (extra) => { const r = spawnSync(process.execPath, ['-e', '1'], { env: { PATH: process.env.PATH, ...extra }, encoding: 'utf8' }); return r.status === 0; };
  const preload = {};
  if (survives({ LD_PRELOAD: '/nonexistent/modelmap-test.so' })) preload.LD_PRELOAD = '/nonexistent/modelmap-test.so';
  const dyld = process.platform === 'darwin' ? '/usr/lib/libz.1.dylib' : '/nonexistent/modelmap-test.dylib';
  if (survives({ DYLD_INSERT_LIBRARIES: dyld })) preload.DYLD_INSERT_LIBRARIES = dyld;
  hostile = {
    GITHUB_TOKEN: 'ghp_hostile', GH_TOKEN: 'gho_hostile', NPM_TOKEN: 'npm_hostile', AWS_SECRET_ACCESS_KEY: 'aws-hostile', AWS_ACCESS_KEY_ID: 'AKIAHOSTILE', GOOGLE_APPLICATION_CREDENTIALS: '/hostile.json', AZURE_CLIENT_SECRET: 'az-hostile',
    NODE_OPTIONS: '--require ' + hook, NODE_PATH: '/nonexistent/node_path', PYTHONSTARTUP: '/nonexistent/startup.py', PYTHONPATH: '/nonexistent/py', BASH_ENV: '/nonexistent/bash_env', ENV: '/nonexistent/env', PS4: '+hostile ',
    GIT_DIR: '/nonexistent/.git', GIT_CONFIG_GLOBAL: '/nonexistent/gitconfig', SSH_AUTH_SOCK: '/nonexistent/agent.sock', SOMETHING_SECRET: 'secret-' + Math.random().toString(36).slice(2), MY_PASSWORD: 'pw-hostile', EDITOR: 'vi',
    ...preload,
  };
  // this server was started from a Claude Code or Codex session
  const nested = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'sess', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_CHILD_SESSION: '1', CODEX_THREAD_ID: 't', CODEX_SANDBOX_NETWORK_DISABLED: '1' };
  expected = { HOME: '/nonexistent/home', PATH: process.env.PATH, LANG: 'en_US.UTF-8', HTTPS_PROXY: 'http://proxy.invalid:3128', ANTHROPIC_API_KEY: 'sk-ant-test', CLAUDE_CONFIG_DIR: '/nonexistent/claude-config', NODE_EXTRA_CA_CERTS: '/nonexistent/ca.pem' };
  hostile = { ...hostile, ...nested };
});
after(() => { if (work) fs.rmSync(work, { recursive: true, force: true }); });
const records = () => (fs.existsSync(envLog) ? fs.readFileSync(envLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const markerPids = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []);
const reset = () => { fs.rmSync(envLog, { force: true }); fs.rmSync(marker, { force: true }); };
/** the fake CLI's records, minus what a system adds to a process on its own (macOS puts __CF_USER_TEXT_ENCODING in) */
const seen = (rec) => Object.fromEntries(Object.entries(rec.env).filter(([k]) => !/^__CF_USER_TEXT_ENCODING$/.test(k)));

for (const engine of ['claude', 'codex']) {
  test('the fake CLI (' + engine + ' path) gets exactly the allowed variables with their values, for --version and for the run, and none of the hostile ones; no node process of its own loads the NODE_OPTIONS hook', { skip: skip || posix }, async () => {
    reset();
    const srv = await startServe(map, { bare: true, args: engine === 'codex' ? ['--engine', 'codex', '--codex', FAKE_CLAUDE] : [], env: { ...expected, ...hostile, FAKE_CLAUDE_ENV_LOG: envLog } });
    try {
      assert.deepEqual(markerPids(), [srv.proc.pid], 'the server itself holds NODE_OPTIONS: its hook ran once');
      await ask(srv, { question: '#tool n:blocks' });
      const recs = records();
      assert.deepEqual(recs.map((r) => r.kind), ['version', 'run'], 'the --version check and the run');
      for (const r of recs) {
        assert.deepEqual(seen(r), { ...expected, FAKE_CLAUDE_ENV_LOG: envLog, FAKE_CLAUDE_LOG: srv.log }, r.kind);
        for (const k of Object.keys(hostile)) assert.ok(!(k in r.env), r.kind + ' got ' + k);
      }
      assert.deepEqual(markerPids(), [srv.proc.pid], 'no process of the CLI (the fake, and node modelmap/query.mjs under it) ran the NODE_OPTIONS hook');
    } finally { await srv.stop(); }
  });
}

test('MODELMAP_PASS_ENV, in the server\'s own environment, passes a named variable and a prefix, but NODE_OPTIONS stays out even when named; the start output names them without values', { skip: skip || posix }, async () => {
  reset();
  const srv = await startServe(map, { bare: true, env: { PATH: process.env.PATH, HOME: '/nonexistent/home', FAKE_CLAUDE_ENV_LOG: envLog, MODELMAP_PASS_ENV: 'FAKE_*,MY_PASSED_VAR,MY_PREFIX_*,NODE_OPTIONS',
    MY_PASSED_VAR: 'value-one-xyz', MY_PREFIX_A: 'value-two-xyz', MY_PREFIX_B: 'b', MY_OTHER: 'o', NODE_OPTIONS: '--require ' + hook } });
  try {
    await ask(srv, { question: 'hello' });
    const run = records().find((r) => r.kind === 'run');
    assert.deepEqual(Object.keys(seen(run)).sort(), ['FAKE_CLAUDE_ENV_LOG', 'FAKE_CLAUDE_LOG', 'HOME', 'MY_PASSED_VAR', 'MY_PREFIX_A', 'MY_PREFIX_B', 'PATH']);
    assert.equal(run.env.MY_PASSED_VAR, 'value-one-xyz');
    assert.deepEqual(markerPids(), [srv.proc.pid]);
    const out = srv.output();
    assert.match(out, /^also passing these variables to the CLI \(MODELMAP_PASS_ENV\): FAKE_\*, MY_PASSED_VAR, MY_PREFIX_\*, NODE_OPTIONS$/m);
    assert.match(out, /^ {2}never passed, even when named: NODE_OPTIONS$/m);
    assert.doesNotMatch(out, /value-one-xyz|value-two-xyz|--require/);
  } finally { await srv.stop(); }
  // not set: the start output says nothing about it
  const plain = await startServe(map, { env: { MODELMAP_PASS_ENV: undefined } });
  try { assert.doesNotMatch(plain.output(), /MODELMAP_PASS_ENV|also passing/); } finally { await plain.stop(); }
});

test('CLAUDE_CODE_USE_BEDROCK in the server\'s environment passes AWS_* to the CLI; without it, AWS_* (secret key and token too) does not pass', { skip: skip || posix }, async () => {
  const aws = { AWS_ACCESS_KEY_ID: 'AKIATEST', AWS_SECRET_ACCESS_KEY: 'aws-secret-test', AWS_SESSION_TOKEN: 'aws-token-test', AWS_REGION: 'us-east-1' };
  for (const on of [true, false]) {
    reset();
    const srv = await startServe(map, { bare: true, env: { PATH: process.env.PATH, FAKE_CLAUDE_ENV_LOG: envLog, ...aws, ...(on ? { CLAUDE_CODE_USE_BEDROCK: '1' } : {}), GOOGLE_APPLICATION_CREDENTIALS: '/x.json', AZURE_API_KEY: 'az' } });
    try {
      await ask(srv, { question: 'hello' });
      for (const r of records()) {
        const names = Object.keys(r.env).filter((k) => /^(AWS_|GOOGLE_|AZURE_)/.test(k)).sort();
        assert.deepEqual(names, on ? Object.keys(aws).sort() : [], (on ? 'with' : 'without') + ' the switch, ' + r.kind);
        if (on) for (const [k, v] of Object.entries(aws)) assert.equal(r.env[k], v);
      }
      assert.equal(records().length, 2);
    } finally { await srv.stop(); }
  }
});

test('serve.mjs builds the CLI\'s environment in one place: every start of the CLI (--version, the run) is given cliEnv(), and nothing else copies process.env', () => {
  const text = fs.readFileSync(SERVE, 'utf8');
  assert.equal([...text.matchAll(/env: cliEnv\(\)/g)].length, 2, 'the version check and the run');
  assert.equal([...text.matchAll(/function cliEnv\(/g)].length, 1);
  assert.ok(!/\.\.\.process\.env/.test(text), 'process.env is never spread into another environment');
});
