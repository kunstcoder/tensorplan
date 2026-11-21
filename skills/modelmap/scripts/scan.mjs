#!/usr/bin/env node
// modelmap scan.mjs: find the model in a PyTorch repo, build its module tree and count its parameters.
// It reads Python files as text (pyscan.py, stdlib only). It never imports or runs the code it reads.
//
// usage: node scan.mjs [root] [--out DIR] [--root-class NAME] [--arg name=<json>]... [--json] [--depth N]
//   --out         where scan.json goes (default <root>/modelmap/.cache). Nothing else is written.
//   --root-class  the class to map, when the scan picks the wrong one
//   --arg         a value for a required constructor argument of the root class, e.g. --arg dim=256
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, mapDir, listPythonFiles, fmtNum } from './lib/common.mjs';
import { annotate, stats } from './lib/params.mjs';
import { foldTree, pattern } from './lib/fold.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2), { multi: ['arg'], flags: ['json'] });
const root = path.resolve(args._[0] || '.');
const fail = (msg) => { console.error('✗ ' + msg); process.exit(1); };
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(root + ' is not a folder');

// --arg name=<json value>; a value that is not JSON is taken as a string
const rootArgs = {};
for (const a of args.arg || []) {
  const i = String(a).indexOf('=');
  if (i < 1) fail('--arg needs name=value, got "' + a + '"');
  const raw = String(a).slice(i + 1);
  try { rootArgs[a.slice(0, i)] = JSON.parse(raw); } catch { rootArgs[a.slice(0, i)] = raw; }
}

const listed = listPythonFiles(root);
if (!listed.files.length) fail('No Python files found in ' + root);

/** Run pyscan.py with python3 in isolated mode (-I): no site packages, no PYTHON* variables. */
function runPyscan(job) {
  let last;
  for (const py of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    const r = spawnSync(py, ['-I', path.join(here, 'pyscan.py')], { input: JSON.stringify(job), encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 120000 });
    if (r.error && r.error.code === 'ENOENT') { last = r; continue; }
    if (r.error) fail('Could not run ' + py + ': ' + r.error.message);
    if (r.status !== 0) fail(py + ' stopped with status ' + r.status + ': ' + (r.stderr || '').trim().split('\n').slice(-3).join(' | '));
    try { return JSON.parse(r.stdout); } catch { fail('pyscan.py gave output that is not JSON: ' + r.stdout.slice(0, 200)); }
  }
  fail('python3 was not found. modelmap reads Python code with python3 (standard library only). Install Python 3.9 or newer.');
}

const scan = runPyscan({ root, files: listed.files, rootClass: args['root-class'] || null, args: rootArgs });
if (scan.fatal) fail(scan.fatal);
if (!scan.root) fail(scan.rootClass ? 'class ' + scan.rootClass + ' was not found' : 'No torch.nn.Module class found in ' + listed.files.length + ' Python files.');

annotate(scan.root);
scan.resolution = stats(scan.root);
scan.meta = { generatedAt: new Date().toISOString(), root: path.basename(root), files: listed.files.length, via: listed.via, truncated: listed.truncated };

const outDir = path.resolve(args.out || path.join(mapDir(root), '.cache'));
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'scan.json');
fs.writeFileSync(outFile, JSON.stringify(scan));

if (args.json) { console.log(JSON.stringify(scan)); process.exit(0); }

// ---------- summary ----------
const P = (p) => (p.v === null || (p.lowerBound && p.v === 0) ? '?' : (p.lowerBound ? '≥ ' : '') + fmtNum(p.v));
const r = scan.root, st = scan.resolution;
const out = [];
out.push('MODEL   ' + r.cls + '  ' + (r.file || '') + ':' + (r.line || ''));
out.push('PARAMS  ' + P(r.params) + '  [code]' + (r.params.lowerBound ? '  (' + r.params.why + ')' : '  (every part known)'));
out.push('BYTES   ' + fmtNum(r.bytes.fp32) + ' B in fp32' + (r.params.lowerBound ? ' or more' : ''));
out.push('READ    ' + scan.stats.files + ' Python files, ' + scan.stats.classes + ' classes, ' + st.modules + ' module instances (' + st.shared + ' shared)' + (scan.errors?.length ? ', ' + scan.errors.length + ' files skipped' : ''));
const others = scan.candidates.filter((c) => c.hasForward && !(c.name === r.cls && c.file === r.file)).slice(0, 4);
if (others.length) out.push('OTHERS  ' + others.map((c) => c.name + ' (' + c.file + ')').join(', ') + '  (map another with --root-class path.py:Name)');
for (const w of scan.warnings || []) out.push('NOTE    ' + w);
const maxDepth = Number(args.depth ?? 2);
out.push('', 'TREE (equal siblings folded)');
const show = (n, d) => {
  const kids = n.children || [];
  const f = foldTree({ ...n, children: kids }).children;
  for (const c of f) {
    const tag = c.alias !== undefined ? '  = shared with ' + c.alias : '';
    const fold = c.fold ? '  ×' + c.fold.n : c.letter ? '  ' + c.letter : '';
    const bad = c.kind === 'unknown' || c.kind === 'external' ? '  ? ' + c.why : '';
    out.push('  '.repeat(d + 1) + c.name + '  ' + c.cls + fold + '  ' + P(c.params) + tag + bad);
    if (d + 1 < maxDepth && c.children?.length) show(c, d + 1);
  }
  const pat = pattern(n);
  if (pat && d >= 0) out.push('  '.repeat(d + 1) + '  pattern ' + pat.split('').join(' '));
};
show(r, 0);
if (st.reasons.length) {
  out.push('', 'UNKNOWN PARTS ' + st.reasons.length);
  for (const x of st.reasons.slice(0, 12)) out.push('  ' + (x.path || '(root)') + ' — ' + x.why);
}
if (scan.errors?.length) { out.push('', 'SKIPPED FILES'); for (const e of scan.errors.slice(0, 6)) out.push('  ' + e.file + ' — ' + e.error); }
out.push('', '✓ wrote ' + outFile);
console.log(out.join('\n'));
