// Helpers for tests/contract.test.mjs (the input and output contract, plan claim 3). tests/helpers.mjs stays as it is.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { node, script, fixture, tmpDir } from './helpers.mjs';

export const contractFixture = (name) => fixture(path.join('contract', name));

// the AB-UPT repo the plan was written against (read only; the tests skip it when it is not on this machine)
export const AB_UPT = path.join(os.homedir(), 'MySpace', 'papers', 'anchored-branched-universal-physics-transformers');
export const hasAbUpt = fs.existsSync(path.join(AB_UPT, 'src', 'model.py'));

/**
 * Scan root into a new temporary map folder and build it there. descriptions: { "file.json": object | text }
 * written to <out>/descriptions/ first. Returns { out, scan, graph, html, stdout (build), scanStdout }.
 */
export function mapOf(root, { descriptions = {}, scanArgs = [] } = {}) {
  const out = tmpDir('modelmap-contract-');
  const s = node(script('scan.mjs'), [root, '--out', path.join(out, '.cache'), ...scanArgs]);
  if (s.status !== 0) throw new Error('scan failed: ' + s.stderr);
  const dir = path.join(out, 'descriptions');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(descriptions)) fs.writeFileSync(path.join(dir, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  const b = node(script('build.mjs'), [root, '--out', out]);
  if (b.status !== 0) throw new Error('build failed: ' + b.stderr);
  return {
    out, stdout: b.stdout, scanStdout: s.stdout,
    scan: JSON.parse(fs.readFileSync(path.join(out, '.cache', 'scan.json'), 'utf8')),
    graph: JSON.parse(fs.readFileSync(path.join(out, 'graph.json'), 'utf8')),
    html: fs.readFileSync(path.join(out, 'index.html'), 'utf8'),
  };
}

/** The NOTE lines of a build report that come from the contract. */
export const contractNotes = (stdout) => String(stdout).split('\n').filter((l) => l.startsWith('NOTE    contract: ')).map((l) => l.slice('NOTE    contract: '.length));
