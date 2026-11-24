// modelmap: the four generated files of a map folder (index.html, query.mjs, serve.mjs, page-safety.mjs), made from this plugin's own
// files and the folder's graph. build.mjs writes them after a build, and open.mjs makes them so before it looks for, starts or restarts a
// server: everything under <repo>/modelmap/ can be committed by the scanned repo, so a code file or a page found there is data at best, and
// the plugin never runs, imports, loads or serves one it did not write itself (UPSTREAM.md section 18).
// The page and its helpers are put together the way floorplan v0.11.0's build.mjs does it; this file is modelmap's own.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scriptJson, scriptCode, withPolicy } from '../../assets/page-safety.mjs';
import { readJsonFile } from './common.mjs';

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');
// v1 work (recent changes) stays out of the MVP map
const UI_SKIP = new Set(['25-recent.js']);

/** The files of a map folder that this plugin generates (and that run, or are served): the page and the code beside it. */
export const MAP_FILES = ['index.html', 'query.mjs', 'serve.mjs', 'page-safety.mjs'];
/** The code files the running server is made of, in the order their bytes go into the hash that open.mjs compares with the server's. */
export const CODE_FILES = ['serve.mjs', 'query.mjs', 'page-safety.mjs'];

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * What the four files of the map folder hold for this graph: { 'index.html': string, 'query.mjs': string, 'serve.mjs': Buffer,
 * 'page-safety.mjs': Buffer }. Everything comes from this plugin's assets/ and the graph; nothing is read from the map folder.
 */
export function mapFiles(graph) {
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
  return {
    // only the page's own scripts run, and it talks to nothing but its own local server
    'index.html': withPolicy(page(graph), 'local'),
    // query.mjs: the graph lookups as a CLI, put together the way floorplan does it
    'query.mjs': graphQuery + '\n// ---- cli ----\n' + fs.readFileSync(path.join(ASSETS, 'query-cli.mjs'), 'utf8'),
    'serve.mjs': fs.readFileSync(path.join(ASSETS, 'serve.mjs')),
    'page-safety.mjs': fs.readFileSync(path.join(ASSETS, 'page-safety.mjs')),
  };
}

/** The hash a server reports as `hash`: sha1 over the bytes of serve.mjs, query.mjs and page-safety.mjs (CODE_FILES, in that order), 12 hex characters. */
export function codeHash(files) {
  const h = crypto.createHash('sha1');
  for (const name of CODE_FILES) h.update(files[name]);
  return h.digest('hex').slice(0, 12);
}

const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
function sameBytes(file, bytes) {
  try {
    const st = fs.lstatSync(file); // a link is never "the same": it is replaced, not followed
    return st.isFile() && st.size === bytes.length && fs.readFileSync(file).equals(bytes);
  } catch { return false; }
}

/**
 * Writes the four files into dir for this graph. Each one is written fresh: removed first, then created without following anything
 * at its path (flag wx), not copied and not written over. A copy or a write over a file keeps the old one's permissions, so a
 * read-only leftover (or a read-only install) would stay in the way of the next build, and a link planted at the path is never written through.
 * onlyIfDifferent (open.mjs): a file whose bytes are already what this plugin writes is left alone, so a second open changes nothing, and
 * the files that were written are returned, and which of them were not there at all. index.html goes last: a running server watches
 * it, and reloads the others when it changes. Returns { files, written, missing }.
 */
export function writeMapFiles(dir, graph, { onlyIfDifferent = false } = {}) {
  const files = mapFiles(graph);
  const written = [], missing = [];
  for (const name of ['query.mjs', 'serve.mjs', 'page-safety.mjs', 'index.html']) {
    const bytes = Buffer.from(files[name]);
    const file = path.join(dir, name);
    if (onlyIfDifferent && sameBytes(file, bytes)) continue;
    if (!fs.existsSync(file) && !isLink(file)) missing.push(name);
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, bytes, { flag: 'wx' });
    written.push(name);
  }
  return { files, written, missing };
}

/**
 * graph.json of a map folder as DATA: the parsed graph, or null when it is not there, not a regular file (no link, no folder), not
 * JSON, or not a graph (an object with an array `nodes` and a string `project.name`, which is what the page is made from). Nothing in it is run.
 */
export function readGraphFile(file) {
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    const g = readJsonFile(file);
    if (!g || typeof g !== 'object' || Array.isArray(g) || !Array.isArray(g.nodes) || typeof g.project?.name !== 'string') return null;
    return g;
  } catch { return null; }
}
