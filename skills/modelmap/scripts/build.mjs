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
import { git } from './lib/common.mjs';
import { toGraph, loadDescriptions } from './lib/graph.mjs';
import { scriptJson, scriptCode, withPolicy } from '../assets/page-safety.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..');
const ASSETS = path.join(SKILL_DIR, 'assets');
// v1 work (recent changes) stays out of the MVP map
const UI_SKIP = new Set(['25-recent.js']);

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
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args._[0] || '.');
const outDir = path.resolve(typeof args.out === 'string' ? args.out : path.join(root, 'modelmap'));
const scanFile = path.resolve(typeof args.scan === 'string' ? args.scan : path.join(outDir, '.cache', 'scan.json'));
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

// ---------- page ----------
const template = fs.readFileSync(path.join(ASSETS, 'viewer.html'), 'utf8');
// The layout engine (elkjs 0.9.3) and the fonts (Inter, JetBrains Mono) are inlined from assets/vendor/,
// so the page makes no outside request and works offline.
const vendor = path.join(ASSETS, 'vendor');
const elkTag = '<script>' + scriptCode(fs.readFileSync(path.join(vendor, 'elk.bundled.js'), 'utf8')) + '</script>';
const FONT_RANGES = {
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  'latin-ext': 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
};
const fontCss = [['Inter', 'inter'], ['JetBrains Mono', 'jetbrains-mono']].flatMap(([family, file]) => Object.entries(FONT_RANGES).map(([subset, range]) =>
  '@font-face{font-family:"' + family + '";font-style:normal;font-display:swap;font-weight:100 900;unicode-range:' + range + ';src:url(data:font/woff2;base64,'
  + fs.readFileSync(path.join(vendor, 'fonts', file + '-' + subset + '-wght-normal.woff2')).toString('base64') + ') format("woff2")}')).join('\n');
// a plain mark of our own (three stacked layers), white like the image it replaces; the light theme inverts it
const MARK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="#fff" stroke-width="2.4" stroke-linejoin="round">'
  + '<rect x="5" y="4" width="22" height="6" rx="2"/><rect x="5" y="13" width="22" height="6" rx="2"/><rect x="5" y="22" width="22" height="6" rx="2"/></svg>';
const markUri = 'data:image/svg+xml;base64,' + Buffer.from(MARK_SVG).toString('base64');
const graphQuery = fs.readFileSync(path.join(ASSETS, 'graph-query.js'), 'utf8');
const uiDir = path.join(ASSETS, 'ui');
const uiNames = fs.existsSync(uiDir) ? fs.readdirSync(uiDir).filter((n) => n.endsWith('.js') && !UI_SKIP.has(n)).sort() : [];
const uiScripts = uiNames.map((n) => '<script>/* ui/' + n + ' */\n' + scriptCode(fs.readFileSync(path.join(uiDir, n), 'utf8')) + '</script>').join('\n');
// Code goes in through scriptCode and the graph through scriptJson (assets/page-safety.mjs). The graph goes in
// last, so nothing inside it can be taken for one of the page's own placeholders.
const page = (g) => template
  .replace('/*__GRAPH_QUERY__*/', () => scriptCode(graphQuery))
  .replace('<!--__ELK_SCRIPT__-->', () => elkTag)
  .replace('/*__FONTS__*/', () => fontCss)
  .replace(/__FLOORPLAN_TITLE__/g, () => escapeHtml(g.project.name + ' model map'))
  .replace(/__FLOORPLAN_LOGO__/g, () => markUri)
  .replace(/__FLOORPLAN_FAVICON__/g, () => markUri)
  .replace('<!--__UI_EXTENSIONS__-->', () => uiScripts)
  .replace('/*__FLOORPLAN_DATA__*/null', () => scriptJson(g));
// only the page's own scripts run, and it talks to nothing but its own local server
const html = withPolicy(page(graph), 'local');
fs.writeFileSync(path.join(outDir, 'index.html'), html);

// ---------- helpers next to the map ----------
// query.mjs: the graph lookups as a CLI, put together the way floorplan does it
fs.writeFileSync(path.join(outDir, 'query.mjs'), graphQuery + '\n// ---- cli ----\n' + fs.readFileSync(path.join(ASSETS, 'query-cli.mjs'), 'utf8'));
// Written fresh, not copied: a copy keeps the original's permissions, so a read-only install would leave read-only
// files here that the next build could not replace. Removing first replaces one left that way.
for (const name of ['serve.mjs', 'page-safety.mjs']) {
  const bytes = fs.readFileSync(path.join(ASSETS, name));
  fs.rmSync(path.join(outDir, name), { force: true });
  fs.writeFileSync(path.join(outDir, name), bytes);
}

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
