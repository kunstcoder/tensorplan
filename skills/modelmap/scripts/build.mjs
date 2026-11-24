#!/usr/bin/env node
// Structure follows floorplan v0.11.0 (MIT): skills/floorplan/scripts/build.mjs
// modelmap build.mjs: turn a scan (scan.json) into the map folder: graph.json and one self-contained index.html,
// plus the helpers next to it (query.mjs, serve.mjs, page-safety.mjs) and a .gitignore that keeps it out of git.
//
// usage: node build.mjs [root] [--scan FILE] [--out DIR]
//   root    the scanned repo (default: the current folder)
//   --out   the map folder (default <root>/modelmap)
//   --scan  the scan to read (default <out>/.cache/scan.json; scan.mjs writes it)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, refuseSymlinks } from './lib/common.mjs';
import { toGraph, loadDescriptions } from './lib/graph.mjs';
import { writeMapFiles } from './lib/mapfiles.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** --key value, --key=value; everything else is positional. */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s, 2);
    if (v === undefined && i + 1 < argv.length && !argv[i + 1].startsWith('--')) v = argv[++i];
    out[k] = v === undefined ? true : v;
  }
  return out;
}
const fail = (msg) => { console.error('✗ ' + msg); process.exit(1); };
const fmtNum = (n) => Number(n).toLocaleString('en-US');
/** A path as the report shows it: relative to the repo when it is inside, else in full. */
const shownPath = (p) => { const r = path.relative(root, p); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p; };

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args._[0] || '.');
const outDir = path.resolve(typeof args.out === 'string' ? args.out : path.join(root, 'modelmap'));
const scanFile = path.resolve(typeof args.scan === 'string' ? args.scan : path.join(outDir, '.cache', 'scan.json'));
// A repo can ship modelmap/ (or a file in it) as a symbolic link. Nothing is created or written until no link is in the way;
// with --out the person chose the folder, so only what is in it is checked.
refuseSymlinks(outDir, ['.cache', 'descriptions', '.gitignore', 'graph.json', 'index.html', 'query.mjs', 'serve.mjs', 'page-safety.mjs'].map((f) => path.join(outDir, f)), { strict: typeof args.out !== 'string' });
if (!fs.existsSync(scanFile)) fail('No scan at ' + scanFile + '. Run scan.mjs first: node ' + path.join(HERE, 'scan.mjs') + ' ' + JSON.stringify(root));
let scan;
try { scan = JSON.parse(fs.readFileSync(scanFile, 'utf8')); } catch (e) { fail(scanFile + ' is not valid JSON (' + e.message + '). Run scan.mjs again.'); }
if (!scan || typeof scan !== 'object' || !scan.root) fail(scanFile + ' has no module tree. Run scan.mjs again.');

// ---------- graph ----------
fs.mkdirSync(outDir, { recursive: true });
const descDir = path.join(outDir, 'descriptions');
fs.mkdirSync(descDir, { recursive: true });
const descriptions = loadDescriptions(descDir);
// the commit the map was built from, so status.mjs can tell when the code moved on
const gitOut = (a) => git(root, a) || null; // lib/common.mjs: an argument list, never a shell
const head = gitOut(['rev-parse', 'HEAD']);
const repos = [head ? { path: '.', name: path.basename(root), branch: gitOut(['rev-parse', '--abbrev-ref', 'HEAD']), head } : { path: '.', name: path.basename(root) }];
// what the build dropped from the descriptions' contract and flows blocks, one NOTE line each
const dropWarnings = [];
const graph = toGraph(scan, { descriptions, root, repos, warnings: dropWarnings });
// the map folder ignores itself: nothing in it belongs in the repo's history
fs.writeFileSync(path.join(outDir, '.gitignore'), '*\n');
fs.writeFileSync(path.join(outDir, 'graph.json'), JSON.stringify(graph));

// ---------- page and the helpers next to it ----------
// index.html, query.mjs, serve.mjs and page-safety.mjs come from lib/mapfiles.mjs, which open.mjs also uses to make them before it starts a server.
const { files } = writeMapFiles(outDir, graph);
const html = files['index.html'];

// ---------- report ----------
const P = graph.nodes[0].m.params;
const shown = P.v === null || (P.lowerBound && P.v === 0) ? '?' : (P.lowerBound ? '≥ ' : '') + fmtNum(P.v);
const report = [
  'MODEL   ' + graph.project.name,
  'PARAMS  ' + shown + '  [' + P.src + ']' + (P.lowerBound && P.why ? '  (' + P.why + ')' : ''),
  'CARDS   ' + graph.nodes.length + ' on the map for ' + graph.meta.counts.modules + ' module instances' + (graph.meta.counts.unknownParts ? ', ' + graph.meta.counts.unknownParts + ' unknown parts' : ''),
  'TEXT    ' + (descriptions.files.length ? descriptions.files.length + ' description file(s): ' + (Object.keys(descriptions.classes).length) + ' classes, ' + Object.keys(descriptions.modules).length + ' modules' : 'no descriptions yet (' + shownPath(descDir) + '/)'),
  ...(graph.contract ? ['INPUTS  ' + graph.contract.inputs.length + ' of forward(), output ' + (graph.contract.output.type || '(no annotation)') + (graph.contract.output.keys.length ? ' with ' + graph.contract.output.keys.length + ' keys' : '')
    + ', ' + [...graph.contract.inputs, ...graph.contract.output.keys].filter((x) => x.shape?.v).length + ' shapes known'
    + (graph.contract.dims.length ? '; dims ' + graph.contract.dims.map((d) => d.sym + '=' + d.value).join(' ') : '')] : []),
  ...descriptions.warnings.map((w) => 'NOTE    ' + w),
  ...(graph.meta.counts.flowClasses ? ['FLOWS   ' + graph.meta.counts.flowClasses + ' class(es), ' + graph.meta.counts.linkCount + ' tensor edges on the map; every shape is an estimate (Claude read forward(), nothing ran)'] : []),
  ...dropWarnings.map((w) => 'NOTE    ' + w),
  'GIT     ' + shownPath(outDir) + '/ is kept out of git (it ignores itself)',
  '',
  '✓ wrote ' + path.join(outDir, 'index.html') + ' (' + fmtNum(Math.round(html.length / 1024)) + ' KB) and graph.json',
];
console.log(report.join('\n'));
