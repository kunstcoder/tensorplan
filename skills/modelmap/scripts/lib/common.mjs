// modelmap: small shared helpers for the scripts. Written for modelmap; the helpers below the
// "taken from floorplan" line are excerpts of floorplan v0.11.0 (MIT): skills/floorplan/scripts/lib/common.mjs
// (gitRun, git, isMapDir, keepOutOfGit, isUnattended, unattendedMode, printJson), with the names changed.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const MAP_DIR = 'modelmap';
export const mapDir = (root) => path.join(root, MAP_DIR);
export const toPosix = (p) => p.split(path.sep).join('/');
export const fmtNum = (n) => Number(n).toLocaleString('en-US');

export function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

/** --key value, --key=value and --flag. Keys in multi collect every value into an array. */
export function parseArgs(argv, { multi = [], flags = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s, 2);
    if (v === undefined && !flags.includes(k) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) v = argv[++i];
    if (v === undefined) v = true;
    if (multi.includes(k)) (out[k] ||= []).push(v); else out[k] = v;
  }
  return out;
}

// folders that never hold the model of the project
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'env', '.tox', 'build', 'dist', 'site-packages', '.eggs', '.mypy_cache', '.pytest_cache', MAP_DIR]);
const MAX_FILES = 5000;

/** Python files of a repo: git's list (tracked, plus untracked that are not ignored), else a walk. */
export function listPythonFiles(root) {
  let files = null, via = 'walk';
  try {
    // through git() below, like every git call: the scanned repo's own .git/config must not make git run a program
    const out = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.py']);
    if (out !== null) { files = out.split('\0').filter(Boolean); via = 'git'; }
  } catch { /* no git: walk instead */ }
  if (!files) {
    files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isSymbolicLink()) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full); }
        else if (e.name.endsWith('.py')) files.push(toPosix(path.relative(root, full)));
        if (files.length > MAX_FILES * 2) return;
      }
    };
    walk(root);
  }
  files = files.map(toPosix).filter((f) => !f.split('/').some((seg) => SKIP_DIRS.has(seg)));
  const truncated = files.length > MAX_FILES;
  return { files: files.slice(0, MAX_FILES).sort(), via, truncated };
}

// ---------- taken from floorplan (see the header), names changed to modelmap ----------

/** A folder that a modelmap run made: it holds a built map, a scan cache or descriptions. */
export const isMapDir = (d) => ['graph.json', '.cache', 'descriptions'].some((f) => fs.existsSync(path.join(d, f)));

/** Unattended mode (MODELMAP_UNATTENDED=1): nobody is there to look, so nothing is started or opened. */
export const isUnattended = (env = process.env) => /^(1|true|yes|on)$/i.test(String(env.MODELMAP_UNATTENDED || '').trim());

/** Reads --unattended (which sets MODELMAP_UNATTENDED for this script and the ones it runs); true when on. */
export function unattendedMode(args = {}, env = process.env) {
  if (args.unattended === true) env.MODELMAP_UNATTENDED = '1';
  return isUnattended(env);
}

// A scanned repo can arrive with its own .git folder (a zip, a shared folder), and git obeys that .git/config. Run
// against such a repo, these commands start the programs it names (each one tried in a temporary repo with a
// marker file; the vectors are in UPSTREAM.md section 16):
//   core.fsmonitor            ls-files, status and check-ignore: switched off with -c below
//   filter.<name>.clean/process  status, on every file whose stat data differs from the index (any fresh extraction),
//                             when .gitattributes or .git/info/attributes names the filter: switched off below, by name
//   a submodule's own config  status looks inside submodules with their config: callers pass --ignore-submodules=all
//   the post-index-change hook  status, when it writes the index: --no-optional-locks stops that write
// Not started by these commands: smudge filters, diff.external, textconv, core.pager, hooks other than the one
// above, core.sshCommand, credential.helper, aliases.
const GIT_OFF = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];
const MAX_FILTERS = 50;
const filterOffs = new Map();
/**
 * The -c options that switch off the filter drivers the repo's own config (or a file it includes) defines, or null
 * when one cannot be named safely. The user's own filters (system and global config, such as git-lfs) stay on.
 * A filter named only by .gitattributes has no command, so it needs no entry here.
 */
function repoFilterOff(cwd) {
  if (filterOffs.has(cwd)) return filterOffs.get(cwd);
  const list = (extra) => {
    try { return execFileSync('git', ['--no-optional-locks', '-C', cwd, 'config', '--list', '-z', ...extra], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
  };
  // -z --show-scope: scope NUL key NL value NUL. Before git 2.26 there is no scope: every filter is switched off then.
  let text = list(['--show-scope']);
  const scoped = text !== null;
  if (!scoped) text = list([]) || '';
  const parts = text.split('\0'), names = new Set();
  for (let i = 0; i < parts.length; i += scoped ? 2 : 1) {
    if (scoped && (parts[i] === 'system' || parts[i] === 'global')) continue;
    const m = /^filter\.([^\n]+)\.(?:clean|process)(?:\n|$)/.exec((scoped ? parts[i + 1] : parts[i]) || '');
    if (m) names.add(m[1]);
  }
  // -c splits at the first "=", so a name with one cannot be switched off: git is not run in that repo at all
  const off = names.size > MAX_FILTERS || [...names].some((n) => n.includes('=')) ? null
    : [...names].flatMap((n) => ['-c', 'filter.' + n + '.clean=', '-c', 'filter.' + n + '.process=', '-c', 'filter.' + n + '.required=false']);
  filterOffs.set(cwd, off);
  return off;
}

/**
 * Runs git with an argument list (never through a shell). Returns { out, error }: out is the trimmed stdout,
 * or null when git failed or is missing. --no-optional-locks keeps read commands such as git status from
 * refreshing the index file, so asking about a repo does not write into it. The repo's own config cannot make
 * git run a program (see the list above). Every call to git in these scripts goes through here.
 */
export function gitRun(cwd, args) {
  const off = repoFilterOff(cwd);
  if (!off) return { out: null, error: 'the git config of ' + cwd + ' defines a filter that modelmap cannot switch off, so it does not run git there' };
  try {
    return { out: execFileSync('git', ['--no-optional-locks', ...GIT_OFF, ...off, '-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd(), error: null };
  } catch (e) {
    if (e.code === 'ENOENT') return { out: null, error: 'git is not installed, or not on PATH' };
    const said = String(e.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
    return { out: null, error: said.find((l) => /^(fatal|error):/.test(l)) || said[0] || String(e.message || e) };
  }
}

/** git's trimmed stdout, or null when it failed. */
export function git(cwd, args) {
  return gitRun(cwd, args).out;
}

// ---------- values read from files that a repo can ship ----------
// Everything under <repo>/modelmap/ can be committed by the scanned repo, and it is read before a build overwrites it:
// graph.json (meta.repos), .cache/server.json, .cache/scan.json, descriptions/*.json. A value from such a file never
// becomes a git option, a path outside the repo, a process id that is killed, or an address that is requested or opened,
// without one of the checks below. (serve.mjs keeps a small copy of the server.json checks: it is copied into the map
// folder and cannot import from here. Keep the two the same.)

/** A git object name as the map records it (meta.repos[].head): lowercase hex, 7 to 64 characters. */
export const isGitObjectName = (v) => typeof v === 'string' && /^[0-9a-f]{7,64}$/.test(v);

/**
 * The absolute path of the folder that value (meta.repos[].path) names inside root, or null when value is not a plain
 * relative path inside it: not a string, a NUL, a leading "-", an absolute path or a drive letter, a path that leaves root
 * (by "..", or through a symbolic link). A missing or empty value is the root itself. A folder that is not there is returned
 * as it is: git simply fails there. ".." is resolved in the text, as path.resolve does, and only the result is used.
 */
export function folderInside(root, value) {
  if (value === undefined || value === null || value === '') value = '.';
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0') || value.startsWith('-')) return null;
  if (/^[a-zA-Z]:/.test(value) || /^[\\/]/.test(value) || path.isAbsolute(value)) return null;
  const within = (base, p) => { const r = path.relative(base, p); return r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
  const base = path.resolve(root), abs = path.resolve(base, value.replace(/\\/g, '/'));
  if (!within(base, abs)) return null;
  if (!within(realPathOf(base), realPathOf(abs))) return null; // a link on the way out counts, also when the folder itself is not there
  return abs;
}

// ---------- the record of a running server: <map>/.cache/server.json ----------
// serve.mjs writes { pid, port, url, token, hash, startedAt } there, 0600, and a repo can ship a file of its own.
// A record is used only when (1) the file is a regular file this user owns, no link and at most 4 KB, (2) its form is
// what serve.mjs writes: url is exactly http://127.0.0.1:<port>, and (3) that server answers /api/status with the
// token and with this record's pid and this map's root (verifiedStatus). Anything else is stale: it is not requested,
// not opened, its pid is not killed and its port is not passed on.
export const SERVER_URL = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/?$/;
const MAX_RECORD_BYTES = 4096;

/** The record in v (parsed JSON) as { pid, port, url, token } with url rebuilt from port, or null when it is not what serve.mjs writes. */
export function validServerRecord(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const { pid, port, url, token } = v;
  // never pid 0 (our own group), 1, a negative number (a process group), this process or its parent
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const m = typeof url === 'string' ? SERVER_URL.exec(url) : null;
  if (!m || Number(m[1]) !== port) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null;
  } catch { return null; }
  if (typeof token !== 'string' || !/^[0-9a-f]{16,64}$/.test(token)) return null;
  return { pid, port, url: 'http://127.0.0.1:' + port, token };
}

/**
 * Reads the record file: { rec, raw }. rec is the validated record, or null (no file, a link, not a regular file, more than
 * 4 KB, owned by another user, not JSON, not valid). raw is the text read, to tell a later rewrite from this one. uid is
 * the owner that is accepted (the current user; null where there are no user ids).
 */
export function readServerRecord(file, { uid = typeof process.getuid === 'function' ? process.getuid() : null } = {}) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_RECORD_BYTES || (uid !== null && st.uid !== uid)) return { rec: null, raw: null };
    const raw = fs.readFileSync(file, 'utf8');
    if (Buffer.byteLength(raw) > MAX_RECORD_BYTES) return { rec: null, raw: null };
    let v = null;
    try { v = JSON.parse(raw); } catch { /* not JSON */ }
    return { rec: validServerRecord(v), raw };
  } catch { return { rec: null, raw: null }; }
}

/**
 * GET /api/status of the server a validated record names, with its token: the status when the answer is 200 JSON from the
 * record's own pid and from this map (mapRoot is the folder that holds the map folder, what serve.mjs reports as root;
 * compared by real path), else null. A pid is killed only after this passed in the same run. Redirects are not followed.
 */
export async function verifiedStatus(rec, mapRoot) {
  try {
    const r = await fetch(rec.url + '/api/status', { headers: { 'x-floorplan-token': rec.token }, redirect: 'manual', signal: AbortSignal.timeout(3000) });
    if (r.status !== 200) return null;
    const st = await r.json();
    if (!st || typeof st !== 'object' || st.pid !== rec.pid || typeof st.root !== 'string') return null;
    if (fs.realpathSync.native(st.root) !== fs.realpathSync.native(mapRoot)) return null;
    return st;
  } catch { return null; }
}

/**
 * --json: prints one JSON object on stdout and nothing else there. With `code`, exits with it once the
 * output has been written (a pipe may still be taking it when process.exit would cut it short).
 */
export async function printJson(obj, code) {
  await new Promise((resolve) => process.stdout.write(JSON.stringify(obj, null, 2) + '\n', resolve));
  if (code !== undefined) process.exit(code);
}

/**
 * Keeps the map folder out of git: <dir>/.gitignore holds "*", which ignores everything in the folder, the
 * .gitignore included, so nothing in the project's tracked files changes. Returns null when git tracks no
 * file in the folder, else a warning that says how many are tracked (ignoring does not untrack them) and
 * the command that untracks them. The command is for the user; this function never runs it.
 */
export function keepOutOfGit(dir) {
  const gi = path.join(dir, '.gitignore');
  const want = '# modelmap keeps its map out of git: this ignores everything in this folder, this file included.\n*\n';
  fs.mkdirSync(dir, { recursive: true });
  try { if (!fs.existsSync(gi) || fs.readFileSync(gi, 'utf8') !== want) fs.writeFileSync(gi, want); } catch {}
  const tracked = (git(dir, ['ls-files', '--', '.']) || '').split('\n').filter(Boolean);
  if (!tracked.length) return null;
  const rel = path.basename(dir);
  return `${tracked.length} file(s) in ${rel}/ were committed to git before; they stay tracked until you run: git rm -r --cached ${rel}  (this keeps the files on disk)`;
}

// ---------- symbolic links in the map folder ----------

/** The real path of p, or, when p is not all there yet, the real path of its nearest folder that is, plus the rest. */
function realPathOf(p) {
  const tail = [];
  for (let q = p; ; q = path.dirname(q)) {
    try { return path.join(fs.realpathSync.native(q), ...tail); } catch { /* not there yet: try the folder above */ }
    if (path.dirname(q) === q) return p;
    tail.unshift(path.basename(q));
  }
}

/**
 * A repo can carry symbolic links (git stores them, so does a zip): modelmap/ pointing at another folder, or a link
 * inside it. Writing through one puts files outside the repo. This says why writing the files in targets (paths under
 * base, the map folder or the one given with --out) is not safe, or returns null when it is. Nothing is written here.
 * It refuses when base (only when strict), any folder or file between base and a target, or the target is a symbolic
 * link, whether it points inside the folder or not, whether it is broken or not; and when the real path of a target
 * would not be inside the real path of base (junctions and short names on Windows come out through this).
 * strict is the default location (<repo>/modelmap), where the repo decides what is there. With --out the person chose
 * the folder, even through a link, so base itself may be one; what is inside it is still checked.
 */
export function symlinkProblem(base, targets, { strict = true } = {}) {
  base = path.resolve(base);
  const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
  const link = (p) => '✗ ' + p + ' is a symbolic link. modelmap will not write through it. Remove it, or choose a folder with --out.';
  if (strict && isLink(base)) return link(base);
  for (const t of targets.map((x) => path.resolve(x))) {
    const rel = path.relative(base, t);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return '✗ ' + t + ' is not inside ' + base + '. modelmap will not write there.';
    let cur = base;
    for (const seg of rel.split(path.sep).filter(Boolean)) { cur = path.join(cur, seg); if (isLink(cur)) return link(cur); }
    const rb = realPathOf(base), rt = realPathOf(t), inside = path.relative(rb, rt);
    if (inside.startsWith('..') || path.isAbsolute(inside)) return '✗ ' + t + ' leads to ' + rt + ', outside ' + rb + '. modelmap will not write through it. Remove the link, or choose a folder with --out.';
  }
  return null;
}

/** symlinkProblem, then the message on stderr and exit code 1: call it before the first folder or file is created. */
export function refuseSymlinks(base, targets, opts) {
  const problem = symlinkProblem(base, targets, opts);
  if (problem) { console.error(problem); process.exit(1); }
}
