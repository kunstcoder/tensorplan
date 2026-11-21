// Shared by the plugin-shell tests (supply-chain, release, describe, status). The scan tests use helpers.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { repo, script, node, hasPython } from './helpers.mjs';

export { repo, script, node, hasPython };
export const SKILL = path.join(repo, 'skills', 'modelmap');
export const pluginFixture = (name) => path.join(repo, 'tests', 'fixtures', 'plugin', name);

/** Relative paths (forward slashes) of every file under dir, leaving out git's own folder and installs. */
export function allFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)).split(path.sep).join('/'))
    .filter((f) => !/^(\.git|node_modules)(\/|$)/.test(f) && !f.includes('/node_modules/'))
    .sort();
}
export const read = (f) => fs.readFileSync(f, 'utf8');
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** A new empty temporary folder; removed by the returned cleanup function. */
export function tmp(prefix = 'modelmap-plugin-test-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Every file under dir (with .git when withGit) as { relPath: sha256 }, to show that a run wrote nothing. */
export function snapshot(dir, { withGit = false } = {}) {
  const out = {};
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const f = path.relative(dir, path.join(e.parentPath ?? e.path, e.name)).split(path.sep).join('/');
    if (!withGit && /^\.git(\/|$)/.test(f)) continue;
    out[f] = sha256(fs.readFileSync(path.join(dir, f)));
  }
  return out;
}

/** git in a test folder (never through a shell); throws on failure. */
export function gitIn(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=modelmap-test', '-c', 'user.email=test@invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
  return r.stdout.trim();
}
export const hasGit = spawnSync('git', ['--version']).status === 0;
