// modelmap: small shared helpers for the scripts. Written for modelmap (not copied from floorplan).
// open.mjs, status.mjs and claudemd.mjs import more from here; they get their parts when they are adapted.
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
