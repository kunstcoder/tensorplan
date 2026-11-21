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
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.py'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    files = out.split('\0').filter(Boolean);
    via = 'git';
  } catch { /* not a git repo, or no git: walk instead */ }
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

/**
 * Runs git with an argument list (never through a shell). Returns { out, error }: out is the trimmed stdout,
 * or null when git failed or is missing. --no-optional-locks keeps read commands such as git status from
 * refreshing the index file, so asking about a repo does not write into it.
 */
export function gitRun(cwd, args) {
  try {
    return { out: execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd(), error: null };
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
