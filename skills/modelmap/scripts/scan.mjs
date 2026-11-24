#!/usr/bin/env node
// modelmap scan.mjs: find the model in a PyTorch repo, build its module tree and count its parameters.
// It reads Python files as text (pyscan.py, stdlib only). It never imports or runs the code it reads.
//
// usage: node scan.mjs [root] [--out DIR] [--root-class NAME] [--arg name=<json>]... [--json] [--depth N]
//                [--config FILE [--config-key a.b] [--config-arg NAME]] [--weights FILE|DIR]...
//   --out         where scan.json goes (default <root>/modelmap/.cache). Nothing else is written.
//   --root-class  the class to map, when the scan picks the wrong one
//   --arg         a value for a required constructor argument of the root class, e.g. --arg dim=256
//   --config      a .json, .yaml or .yml file whose values go to the root class (values are tagged "config")
//   --config-key  a dotted path that selects a section of the config, e.g. model.encoder
//   --config-arg  the parameter of the root __init__ that receives the config object (default: the first
//                 required one named config, cfg, conf, args, hparams or params). "**" passes the keys as arguments.
//   --weights     a .safetensors file, a model.safetensors.index.json or a folder of them (repeatable). Only
//                 the headers are read; the scan checks every key and shape against the code. Pickle files
//                 (.pt .pth .bin .ckpt .pkl) are not read.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, mapDir, listPythonFiles, fmtNum, toPosix, refuseSymlinks } from './lib/common.mjs';
import { annotate, stats } from './lib/params.mjs';
import { loadConfig } from './lib/config.mjs';
import { readWeights, expectKeys, crossCheck } from './lib/safetensors.mjs';
import { foldTree, pattern } from './lib/fold.mjs';
import { DIM_NAMES, HEAD_DIM_ATTRS, buildContract } from './lib/contract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2), { multi: ['arg', 'weights'], flags: ['json'] });
const root = path.resolve(args._[0] || '.');
const fail = (msg) => { console.error('✗ ' + msg); process.exit(1); };
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(root + ' is not a folder');

// Where scan.json goes. A repo can ship modelmap/ (or modelmap/.cache) as a symbolic link to another folder, so nothing
// is created or written until no link is in the way. With --out the person chose the folder: only what is in it is checked.
const outDir = path.resolve(args.out || path.join(mapDir(root), '.cache'));
const outFile = path.join(outDir, 'scan.json');
refuseSymlinks(args.out ? outDir : mapDir(root), [outFile], { strict: !args.out });

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

// --config: read the file here (JSON or the small YAML reader); pyscan.py tags its values with file:line
const label = (p) => { const r = path.relative(root, p); return toPosix(r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p); };
let config = null;
if (args.config !== undefined) {
  if (args.config === true) fail('--config needs a file');
  const file = path.resolve(String(args.config));
  const key = typeof args['config-key'] === 'string' ? args['config-key'] : undefined;
  const c = loadConfig(file, { key });
  if (c.error) fail(c.error);
  config = { data: c.data, lines: c.lines ?? null, file: label(file), arg: typeof args['config-arg'] === 'string' ? args['config-arg'] : null, key };
} else if (args['config-key'] !== undefined || args['config-arg'] !== undefined) fail('--config-key and --config-arg need --config FILE');

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

// dimNames: the names of the dimension table (lib/contract.mjs); pyscan.py reports where it saw them
const scan = runPyscan({ root, files: listed.files, rootClass: args['root-class'] || null, args: rootArgs, config: config && { data: config.data, lines: config.lines, file: config.file, arg: config.arg }, dimNames: DIM_NAMES, dimAttrs: HEAD_DIM_ATTRS });
if (scan.fatal) fail(scan.fatal);
if (!scan.root) fail(scan.rootClass ? 'class ' + scan.rootClass + ' was not found' : 'No torch.nn.Module class found in ' + listed.files.length + ' Python files.');
if (config) {
  const use = scan.configUse || { arg: null, note: 'the config was not used' };
  scan.config = { file: config.file, arg: use.arg, ...(config.key ? { key: config.key } : {}), ...(use.note ? { note: use.note } : {}) };
  if (use.note) (scan.warnings ||= []).push(use.note);
}
delete scan.configUse;

// --weights: read the headers before annotate() turns node.params (the direct nn.Parameter list) into a count
let weights = null, expected = null;
if (args.weights) {
  weights = readWeights(args.weights.filter((w) => w !== true).map((w) => path.resolve(String(w))));
  expected = expectKeys(scan.root);
}

annotate(scan.root);
if (weights) scan.weights = crossCheck(scan.root, weights, { expected });
scan.resolution = stats(scan.root);
scan.meta = { generatedAt: new Date().toISOString(), root: path.basename(root), files: listed.files.length, via: listed.via, truncated: listed.truncated };

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(scan));

if (args.json) {
  // stdout is the JSON alone; messages go to stderr
  for (const w of scan.weights?.skipped || []) console.error('pickle checkpoints are not read in the MVP: ' + w);
  if (scan.config?.note) console.error('config: ' + scan.config.note);
  console.log(JSON.stringify(scan));
  process.exit(0);
}

// ---------- summary ----------
const P = (p) => (p.v === null || (p.lowerBound && p.v === 0) ? '?' : (p.lowerBound ? '≥ ' : '') + fmtNum(p.v));
const r = scan.root, st = scan.resolution;
const out = [];
out.push('MODEL   ' + r.cls + '  ' + (r.file || '') + ':' + (r.line || ''));
out.push('PARAMS  ' + P(r.params) + '  [' + r.params.src + ']' + (r.params.lowerBound ? '  (' + r.params.why + ')' : '  (every part known)'));
if (scan.config) out.push('CONFIG  ' + scan.config.file + (scan.config.key ? ' (key ' + scan.config.key + ')' : '') + (scan.config.arg ? '  -> ' + (scan.config.arg === '**' ? 'keyword arguments' : 'argument ' + scan.config.arg) + ' of ' + r.cls : '  not used: ' + scan.config.note));
if (scan.weights) {
  const w = scan.weights;
  const head = w.files.length ? w.files.join(', ') + ': ' + fmtNum(w.tensors) + ' tensors, ' + fmtNum(w.totalParams) + ' values' : 'no file read';
  const mark = !w.files.length ? '✗ nothing checked' : w.differModules ? '✗ ' + w.differModules + (w.differModules === 1 ? ' module differs, ' : ' modules differ, ') + w.matchedModules + ' match' : '✓ ' + w.matchedModules + ' modules match';
  out.push('WEIGHTS ' + mark + '  (' + head + ')' + (w.uncheckedModules ? '  ' + w.uncheckedModules + ' modules not checked (shapes not known)' : '') + (w.unmatchedKeys ? '  ' + w.unmatchedKeys + ' keys in the file are not in the code' : ''));
  for (const x of w.problems.slice(0, 6)) out.push('        ' + x);
  for (const x of (w.unmatchedSample || []).slice(0, w.differModules ? 0 : 3)) out.push('        not in the code: ' + x);
  for (const e of w.errors || []) out.push('        ✗ ' + e);
  for (const s of w.skipped || []) out.push('        pickle checkpoints are not read in the MVP: ' + s);
  for (const x of w.notes || []) out.push('        note: ' + x);
}
out.push('BYTES   ' + fmtNum(r.bytes.fp32) + ' B in fp32' + (r.params.lowerBound ? ' or more' : ''));
const ct = buildContract(scan);
if (ct) {
  const ins = ct.inputs.map((x) => x.name + (x.optional ? '?' : '')).join(', ');
  out.push('INPUTS  ' + ct.inputs.length + (ins ? '  (' + (ins.length > 160 ? ins.slice(0, 159) + '…' : ins) + ')' : '') + '  forward() at ' + ct.forward.file + ':' + ct.forward.line);
  const o = ct.output;
  out.push('OUTPUT  ' + (o.type || '(no annotation)') + (o.keys.length ? '  ' + o.keys.length + (o.keysMore ? '+' : '') + ' keys' : o.names ? '  (' + o.names.join(', ') + ')' : ''));
  if (ct.dims.length) out.push('DIMS    ' + ct.dims.map((d) => d.sym + '=' + d.value + ' (' + d.name + (d.src === 'config' ? ', config' : '') + ')').join('  '));
}
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
