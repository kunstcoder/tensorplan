// Shared by the tests: run a modelmap script and read the scan of the fixture.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const script = (name) => path.join(repo, 'skills', 'modelmap', 'scripts', name);
export const fixture = (name) => path.join(repo, 'tests', 'fixtures', name);

export const hasPython = spawnSync('python3', ['-I', '-c', 'import sys; assert sys.version_info >= (3, 9)']).status === 0;

/** Run a script with node. Returns { status, stdout, stderr }. */
export function node(scriptPath, args = [], opts = {}) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', ...opts });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function tmpDir(prefix = 'modelmap-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Scan a folder and return the parsed scan.json. The output goes to a temporary folder, never into the repo scanned. */
export function scanOf(root, extra = []) {
  const out = tmpDir();
  const r = node(script('scan.mjs'), [root, '--out', out, '--json', ...extra]);
  if (r.status !== 0) throw new Error('scan failed: ' + r.stderr);
  return JSON.parse(r.stdout);
}

/** Find a node by its path in a scan tree. */
export function at(tree, p) {
  if (p === '') return tree;
  let n = tree;
  for (const seg of p.split('.')) { n = (n.children || []).find((c) => c.name === seg); if (!n) return null; }
  return n;
}
