// A tripwire for what the modelmap plugin can do on someone's computer. It promises: no hooks, no MCP
// servers, nothing that runs on install, no dependencies; a fixed list of programs per file; no network use
// except the map's own server on 127.0.0.1; no code built from text at run time except serve.mjs loading the
// map's own lookup code; pyscan.py uses only the standard library and never runs, imports or writes anything;
// no pickle or torch.load; and the byte-identical floorplan files match UPSTREAM.md section 4.
// Every check is a function over file texts, so the last tests plant forbidden strings in in-memory copies
// and show that each check catches them. If a change here is intended, change this file on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repo, SKILL, allFiles, read, sha256 } from './helpers-plugin.mjs';

const UPDATE = 'If this is intended, update tests/supply-chain.test.mjs on purpose.';
const BT = '\x60';

// ---------- the tree ----------
const repoFiles = allFiles(repo).filter((f) => !f.startsWith('.claude/'));
const CODE_EXT = /\.(mjs|js|cjs|html|py)$/;
const isVendor = (f) => f.startsWith('skills/modelmap/assets/vendor/');
/** The code that can run: everything under skills/ and tools/ except the vendored layout engine. */
function codeFiles() {
  const out = new Map();
  for (const f of repoFiles) if (/^(skills|tools)\//.test(f) && CODE_EXT.test(f) && !isVendor(f)) out.set(f, read(path.join(repo, f)));
  return out;
}
const json = (p) => JSON.parse(read(path.join(repo, p)));

/** JS lines that are code: comment lines (//, *, /*) left out, as floorplan's tripwire does. */
function jsLines(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--')) return;
    out.push({ line, n: i + 1 });
  });
  return out;
}
/** Every match of re on the code lines of the JS-like files, as { file, n, text, m }. */
function findJs(files, re) {
  const out = [];
  for (const [f, text] of files) {
    if (f.endsWith('.py')) continue;
    for (const { line, n } of jsLines(text)) for (const m of line.matchAll(new RegExp(re.source, 'g'))) out.push({ file: f, n, text: m[0], m });
  }
  return out;
}
/** A JS line with the inside of its string literals emptied ('...', "...", template text), so messages do not count. */
const jsNoStrings = (line) => line.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\x60(?:\\.|[^\x60\\])*\x60/g, "''");

/**
 * Python as code only: triple-quoted strings, string literals and # comments are emptied, so the words in
 * docstrings, messages and comments ("pickle files are not read") do not count, and what is left is the code
 * that runs. Line numbers are kept.
 */
function pyCode(text, { keepStrings = false } = {}) {
  let s = text.replace(/("""|''')[\s\S]*?\1/g, (m) => m.replace(/[^\n]/g, ' '));
  return s.split('\n').map((line) => {
    let out = '', i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === '#') break;
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
        // same length either way, so a position in one form is the same position in the other
        out += keepStrings ? line.slice(i, j + 1) : ch + ' '.repeat(Math.max(0, Math.min(j, line.length) - i - 1)) + (j < line.length ? ch : '');
        i = j + 1;
        continue;
      }
      out += ch; i++;
    }
    return out;
  });
}

// ---------- checks (each returns a list of findings; empty means it holds) ----------

const PLUGIN_KEYS = ['author', 'description', 'keywords', 'name', 'version'];
const MARKET_KEYS = ['metadata', 'name', 'owner', 'plugins'];
const ENTRY_KEYS = ['category', 'description', 'name', 'source', 'version'];
// keys that make Claude Code run or load something besides the skill
const ACTIVE_KEYS = /^(hooks|mcpServers|lspServers|commands|agents|outputStyles|scripts|postinstall|preinstall|install|bin)$/;
function deepKeys(x, out = []) {
  if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { out.push(k); deepKeys(v, out); }
  return out;
}
export function checkManifests(plugin, market, files) {
  const f = [];
  const extra = (o, allowed, where) => { for (const k of Object.keys(o || {})) if (!allowed.includes(k)) f.push(where + ': key "' + k + '" is not allowed'); };
  extra(plugin, PLUGIN_KEYS, 'plugin.json');
  extra(market, MARKET_KEYS, 'marketplace.json');
  for (const p of market.plugins || []) {
    extra(p, ENTRY_KEYS, 'marketplace.json plugins[' + p.name + ']');
    if (p.source !== './') f.push('marketplace.json plugins[' + p.name + ']: source must be "./" (this folder), got ' + JSON.stringify(p.source));
  }
  for (const k of [...deepKeys(plugin), ...deepKeys(market)]) if (ACTIVE_KEYS.test(k)) f.push('manifest key "' + k + '" would run or load something');
  for (const file of files) if (/(^|\/)(hooks\.json|\.mcp\.json|\.lsp\.json)$/.test(file) || /(^|\/)hooks\//.test(file)) f.push(file + ': hooks or MCP/LSP server file');
  return f;
}

const DEP_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies'];
const INSTALL_SCRIPTS = /^(preinstall|install|postinstall|prepare|prepublish|prepublishOnly|prepack|postpack|preuninstall|uninstall|postuninstall)$/;
export function checkPackages(pkgs, files) {
  const f = [];
  for (const [file, pkg] of pkgs) {
    for (const k of DEP_KEYS) if (pkg[k] !== undefined) f.push(file + ': has ' + k);
    for (const s of Object.keys(pkg.scripts || {})) if (INSTALL_SCRIPTS.test(s)) f.push(file + ': install script "' + s + '"');
  }
  for (const file of files) if (/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(file)) f.push(file + ': lockfile');
  return f;
}

// Programs the plugin may start, and what each call's first argument can name, file by file. A variable
// program is backed by a pattern that must match the file, showing the values it can hold.
export const PROGRAMS = ['git', 'python3', 'python', 'py', 'node', 'claude', 'codex', 'open', 'xdg-open', 'cmd', 'which', 'where'];
const OPENERS = /\? \['cmd', \['\/c', 'start', '', u\]\] : process\.platform === 'darwin' \? \['open', \[u\]\] : \['xdg-open', \[u\]\]/;
export const SPAWNS = {
  'skills/modelmap/assets/serve.mjs': {
    "process.platform === 'win32' ? 'where' : 'which'": { programs: ['where', 'which'] },
    'cli.cmd': { programs: ['claude', 'codex', 'node'], backing: [/find: \(\) => resolveCli\(given\('claude'\)/, /find: \(\) => resolveCli\(given\('codex'\)/, /return \{ cmd: process\.execPath, args: \[c\], path: c \}/] },
    'process.execPath': { programs: ['node'] },
    'opener[0]': { programs: ['cmd', 'open', 'xdg-open'], backing: [OPENERS] },
  },
  'skills/modelmap/scripts/scan.mjs': {
    py: { programs: ['python', 'py', 'python3'], backing: [/for \(const py of process\.platform === 'win32' \? \['python', 'py'\] : \['python3', 'python'\]\)/, /spawnSync\(py, \['-I', path\.join\(here, 'pyscan\.py'\)\]/] },
  },
  'skills/modelmap/scripts/lib/common.mjs': { "'git'": { programs: ['git'] } },
  'skills/modelmap/scripts/open.mjs': {
    cmd: { programs: ['cmd', 'open', 'xdg-open'], backing: [OPENERS] },
    'process.execPath': { programs: ['node'] },
  },
};
export function checkSpawns(files, table = SPAWNS) {
  const f = [];
  // execSync and exec go through a shell; fork runs a module by path. spawnSync/execFileSync/spawn/execFile take a program and its arguments
  for (const x of findJs(files, /(?<![.\w])(exec|execSync|fork)\s*\(/)) f.push(x.file + ':' + x.n + ' ' + x.text + ' (runs through a shell or forks)');
  for (const x of findJs(files, /shell:\s*true/)) f.push(x.file + ':' + x.n + ' shell: true');
  for (const x of findJs(files, /from\s+['"](?:node:)?(cluster)['"]/)) f.push(x.file + ':' + x.n + ' ' + x.text);
  const found = {};
  for (const x of findJs(files, /(?<![.\w])(spawn|spawnSync|execFileSync|execFile)\s*\(\s*([^,)]+)/)) {
    if (/^(['"]|\/\*)/.test(x.m[2].trim()) && !/^'[\w-]+'$/.test(x.m[2].trim())) { f.push(x.file + ':' + x.n + ' odd program argument ' + x.m[2]); continue; }
    (found[x.file] ||= new Set()).add(x.m[2].trim());
  }
  // child_process imported by a file that the table does not list
  for (const x of findJs(files, /from\s+['"](?:node:)?child_process['"]|require\(\s*['"](?:node:)?child_process['"]\s*\)/)) if (!table[x.file]) f.push(x.file + ':' + x.n + ' imports child_process but is not in the allow-list');
  for (const file of new Set([...Object.keys(found), ...Object.keys(table)])) {
    const want = Object.keys(table[file] || {}).sort();
    const got = [...(found[file] || [])].sort();
    if (!files.has(file)) continue; // a listed file that is gone starts nothing
    if (JSON.stringify(want) !== JSON.stringify(got)) f.push(file + ': starts ' + JSON.stringify(got) + ', allow-list says ' + JSON.stringify(want));
    for (const [expr, spec] of Object.entries(table[file] || {})) {
      for (const p of spec.programs) if (!PROGRAMS.includes(p)) f.push(file + ': ' + expr + ' may start ' + p + ', which is not an allowed program');
      for (const re of spec.backing || []) if (!re.test(files.get(file))) f.push(file + ': ' + expr + ' is no longer backed by ' + re);
    }
  }
  return f;
}

const SERVE = 'skills/modelmap/assets/serve.mjs';
const OPEN = 'skills/modelmap/scripts/open.mjs';
// browser code: the page and its add-ons, served by serve.mjs; a relative URL goes to that same local server
const isPage = (f) => f === 'skills/modelmap/assets/viewer.html' || /^skills\/modelmap\/assets\/ui\/[^/]+\.js$/.test(f);
const RELATIVE = new RegExp('^([\'"' + BT + '])\\/(?!\\/)');
const LOCALHOST = new RegExp('^([\'"' + BT + '])https?:\\/\\/(127\\.0\\.0\\.1|localhost)[:/' + BT + '\'"]');
export function checkNetwork(files) {
  const f = [];
  for (const x of findJs(files, /from\s+['"](?:node:)?(https?|http2|net|tls|dgram|dns|undici)['"]|require\(\s*['"](?:node:)?(https?|http2|net|tls|dgram|dns|undici)['"]\s*\)/)) {
    if (!(x.file === SERVE && /['"](?:node:)?http['"]/.test(x.text))) f.push(x.file + ':' + x.n + ' network module ' + x.text);
  }
  for (const x of findJs(files, /\b(https?|net|tls|http2)\.(request|get|connect|createConnection)\s*\(/)) f.push(x.file + ':' + x.n + ' ' + x.text);
  for (const x of findJs(files, /\b(WebSocket|XMLHttpRequest|sendBeacon|importScripts)\b/)) f.push(x.file + ':' + x.n + ' ' + x.text);
  for (const x of findJs(files, /new EventSource\(\s*([^,)]+)/)) if (!(isPage(x.file) && RELATIVE.test(x.m[1].trim()))) f.push(x.file + ':' + x.n + ' ' + x.text);
  for (const x of findJs(files, /(?<![.\w])fetch\(\s*([^,)]+)/)) {
    const arg = x.m[1].trim();
    if (x.file === SERVE && (LOCALHOST.test(arg) || RELATIVE.test(arg))) continue;
    if (isPage(x.file) && RELATIVE.test(arg)) continue;
    // open.mjs asks the map's running server for its status: s.url is the address serve.mjs wrote to
    // .cache/server.json, which is always http://127.0.0.1:<port> (checked below)
    if (x.file === OPEN && arg === 's.url + p') continue;
    f.push(x.file + ':' + x.n + ' fetch(' + arg);
  }
  const serve = files.get(SERVE) || '';
  if (serve) {
    if (!/http\.createServer\(/.test(serve)) f.push(SERVE + ': no http.createServer');
    const listens = findJs(new Map([[SERVE, serve]]), /\.listen\(([^)]*)\)/);
    if (!listens.length) f.push(SERVE + ': no listen call');
    for (const l of listens) if (!/^port, '127\.0\.0\.1'$/.test(l.m[1].trim())) f.push(SERVE + ':' + l.n + ' listens on ' + l.m[1]);
    if (!/const u = \x60http:\/\/127\.0\.0\.1:\$\{port\}\x60;/.test(serve)) f.push(SERVE + ': the address written to server.json is not http://127.0.0.1:<port>');
    if (!/JSON\.stringify\(\{ pid: process\.pid, port, url: u,/.test(serve)) f.push(SERVE + ': server.json no longer records url: u');
  }
  // the page loads nothing from the internet
  const page = files.get('skills/modelmap/assets/viewer.html') || '';
  if (/<script[^>]*\ssrc=["']?https?:/i.test(page)) f.push('viewer.html: external script');
  if (/<link[^>]*href=["']?https?:/i.test(page)) f.push('viewer.html: external stylesheet or font');
  if (/url\(\s*["']?https?:/i.test(page)) f.push('viewer.html: external url() in CSS');
  return f;
}

export function checkDynamicCode(files) {
  const f = [];
  for (const x of findJs(files, /(?<![.\w])eval\s*\(/)) f.push(x.file + ':' + x.n + ' eval(');
  // serve.mjs builds the map's lookup code from <map>/query.mjs, which build.mjs assembles from this plugin's
  // own assets/graph-query.js and query-cli.mjs: the one allowed use, and exactly one
  const fn = findJs(files, /new\s+Function\s*\(/);
  const inServe = fn.filter((x) => x.file === SERVE);
  for (const x of fn) if (x.file !== SERVE) f.push(x.file + ':' + x.n + ' new Function(');
  if (files.has(SERVE) && inServe.length !== 1) f.push(SERVE + ': ' + inServe.length + ' uses of new Function (exactly 1 allowed)');
  if (inServe.length === 1) {
    const lines = files.get(SERVE).split('\n');
    const before = lines.slice(Math.max(0, inServe[0].n - 4), inServe[0].n).join('\n');
    if (!/const coreSrc = fs\.readFileSync\(path\.join\(here, 'query\.mjs'\), 'utf8'\)/.test(before)) f.push(SERVE + ':' + inServe[0].n + ' new Function does not load the map\'s own query.mjs');
    if (!/new Function\(\x60\$\{coreSrc\.replace/.test(lines[inServe[0].n - 1])) f.push(SERVE + ':' + inServe[0].n + ' new Function is not built from coreSrc');
  }
  for (const x of findJs(files, /(?<![.\w])import\s*\(/)) f.push(x.file + ':' + x.n + ' dynamic import(');
  for (const x of findJs(files, /from\s+['"](?:node:)?(vm|worker_threads|inspector|wasi|module)['"]|new Worker\(|WebAssembly\.|createRequire\(/)) f.push(x.file + ':' + x.n + ' ' + x.text);
  return f;
}

// Standard-library modules pyscan.py may import. Not in it on purpose: subprocess, pickle, marshal, shelve,
// ctypes, importlib, socket, urllib, http, runpy, code, multiprocessing, shutil, tempfile.
export const PY_STDLIB = ['__future__', 'ast', 'collections', 'copy', 'dataclasses', 'enum', 'functools', 'itertools', 'json', 'keyword', 'math', 'os', 're', 'string', 'sys', 'textwrap', 'tokenize', 'typing', 'unicodedata'];
export function checkPyscan(text) {
  const f = [];
  const raw = text.split('\n');
  raw.forEach((line, i) => {
    let m = /^\s*import\s+(.+?)\s*(#.*)?$/.exec(line);
    if (m) for (const part of m[1].split(',')) { const mod = part.trim().split(/\s+as\s+/)[0].split('.')[0]; if (!PY_STDLIB.includes(mod)) f.push('pyscan.py:' + (i + 1) + ' imports ' + mod); }
    m = /^\s*from\s+(\S+)\s+import\b/.exec(line);
    if (m) { const mod = m[1].split('.')[0]; if (m[1].startsWith('.') || !PY_STDLIB.includes(mod)) f.push('pyscan.py:' + (i + 1) + ' imports from ' + m[1]); }
  });
  const code = pyCode(text);
  const FORBIDDEN = [/(?<![.\w])exec\s*\(/, /(?<![.\w])eval\s*\(/, /(?<![.\w])compile\s*\(/, /__import__/, /\bimportlib\b/, /\bsubprocess\b/, /\bos\.(system|popen|exec\w*|spawn\w*|fork|remove|unlink|rmdir|makedirs|mkdir|rename|replace)\b/, /\bpickle\b/, /\bmarshal\b/, /\bctypes\b/, /\bsocket\b/, /\.write_(text|bytes)\s*\(/, /\bbreakpoint\s*\(/];
  code.forEach((line, i) => { for (const re of FORBIDDEN) if (re.test(line)) f.push('pyscan.py:' + (i + 1) + ' ' + re.source + ': ' + raw[i].trim()); });
  // open() only for reading: a mode with w, a, x or + writes
  const withStrings = pyCode(text, { keepStrings: true });
  code.forEach((line, i) => {
    for (const c of line.matchAll(/(?<![.\w])open\s*\(/g)) {
      // the call is found in the code form (not in a string or comment); its arguments are read with their strings
      const m = /^open\s*\(([^)]*)\)?/.exec(withStrings[i].slice(c.index));
      if (!m) continue;
      const parts = m[1].split(',').map((s) => s.trim());
      const pos = parts[1] && !/^\w+\s*=/.test(parts[1]) ? parts[1] : null;
      const kw = parts.find((p) => /^mode\s*=/.test(p))?.replace(/^mode\s*=\s*/, '');
      for (const mode of [pos, kw].filter(Boolean)) {
        const lit = /^[rRbBuU]?(['"])([^'"]*)\1$/.exec(mode);
        if (!lit) f.push('pyscan.py:' + (i + 1) + ' open() with a mode that is not a literal: ' + raw[i].trim());
        else if (/[wax+]/.test(lit[2])) f.push('pyscan.py:' + (i + 1) + ' open() in a write mode: ' + raw[i].trim());
      }
    }
  });
  return f;
}

// torch.load and pickle in code that runs. Comments, docstrings and strings are emptied first (jsNoStrings,
// pyCode), so "pickle files are not read" in a message passes and a call does not.
const UNPICKLE = /\btorch\.load\b|\bpickle\b|\bunpickl|\bjoblib\.load\b|\bdill\b|\bcloudpickle\b|\btorch\.jit\.load\b|\bnp\.load\b/i;
export function checkUnpickle(files) {
  const f = [];
  for (const [file, text] of files) {
    if (!file.startsWith('skills/modelmap/scripts/')) continue;
    if (file.endsWith('.py')) pyCode(text).forEach((line, i) => { if (UNPICKLE.test(line)) f.push(file + ':' + (i + 1) + ' ' + text.split('\n')[i].trim()); });
    else for (const { line, n } of jsLines(text)) if (UNPICKLE.test(jsNoStrings(line).replace(/\/\/.*$/, ''))) f.push(file + ':' + n + ' ' + line.trim());
  }
  return f;
}

/** The rows of the table in UPSTREAM.md section 4: { source, sha, dest }. */
export function upstreamRows(md) {
  const sec = md.split(/\n## /).find((s) => /^4\. /.test(s));
  if (!sec) return [];
  return sec.split('\n').filter((l) => /^\|/.test(l)).map((l) => l.split('|').map((c) => c.trim()))
    .filter((c) => /^\x60[0-9a-f]{64}\x60$/.test(c[4] || ''))
    .map((c) => ({ source: c[2].replace(/\x60/g, ''), sha: c[4].replace(/\x60/g, ''), dest: c[5].replace(/\x60/g, '') }));
}
/** The licence file that must sit next to a copied file. */
export function licenceFor(dest) {
  if (/LICENSE/.test(path.posix.basename(dest))) return null;
  if (dest.endsWith('/elk.bundled.js')) return path.posix.join(path.posix.dirname(dest), 'elkjs-LICENSE.md');
  const font = /\/(inter|jetbrains-mono)-[^/]+\.woff2$/.exec(dest);
  if (font) return path.posix.join(path.posix.dirname(dest), font[1] + '-LICENSE.txt');
  return 'third_party/floorplan/LICENSE'; // floorplan's own files (MIT)
}
export function checkHashes(rows, readBytes, exists) {
  const f = [];
  const dests = new Set(rows.map((r) => r.dest));
  for (const r of rows) {
    if (!exists(r.dest)) { f.push(r.dest + ': missing'); continue; }
    const got = sha256(readBytes(r.dest));
    if (got !== r.sha) f.push(r.dest + ': sha256 ' + got + ', UPSTREAM.md says ' + r.sha);
    const lic = licenceFor(r.dest);
    if (lic && !(exists(lic) && dests.has(lic))) f.push(r.dest + ': its licence ' + lic + ' is missing or not hash-checked');
  }
  return f;
}

// ---------- the checks on this tree ----------

const files = codeFiles();
const SCRIPTS = ['build.mjs', 'describe.mjs', 'open.mjs', 'scan.mjs', 'status.mjs'];

test('manifests: plugin.json and marketplace.json hold only name, version, description, author, keywords (no hooks, mcpServers, commands or install steps), the marketplace installs from "./", and no hooks/.mcp.json/.lsp.json file exists', () => {
  assert.deepEqual(checkManifests(json('.claude-plugin/plugin.json'), json('.claude-plugin/marketplace.json'), repoFiles), [], UPDATE);
  assert.equal(json('.claude-plugin/plugin.json').license, undefined, 'no license field: the licence of modelmap is not decided yet');
});

test('dependencies: no package.json declares dependencies or install scripts, and there is no lockfile or node_modules', () => {
  const pkgs = repoFiles.filter((f) => /(^|\/)package\.json$/.test(f)).map((f) => [f, json(f)]);
  assert.deepEqual(checkPackages(pkgs, repoFiles), [], UPDATE);
  assert.ok(!fs.existsSync(path.join(repo, 'node_modules')), 'no node_modules folder');
});

test('skill: SKILL.md pre-approves exactly ' + SCRIPTS.join(', ') + ' through node and nothing else', () => {
  const front = /^---\n([\s\S]*?)\n---/.exec(read(path.join(SKILL, 'SKILL.md')).replace(/\r\n/g, '\n'))[1];
  const granted = /^allowed-tools:\n((?: {2}- .*\n?)+)/m.exec(front + '\n')?.[1].trim().split('\n').map((l) => l.replace(/^\s*- /, '').trim());
  assert.deepEqual(granted, SCRIPTS.map((s) => 'Bash(node $' + '{CLAUDE_SKILL_DIR}/scripts/' + s + ' *)'), UPDATE);
  assert.match(front, /^name: modelmap$/m);
});

test('programs: each file under skills/ and tools/ starts only its allow-listed programs (' + Object.keys(SPAWNS).map((f) => path.posix.basename(f)).join(', ') + '; programs ' + PROGRAMS.join(', ') + '), never through a shell', () => {
  assert.deepEqual(checkSpawns(files), [], UPDATE);
  // Python runs only this plugin's pyscan.py: it is the only Python file the plugin ships
  assert.deepEqual([...files.keys()].filter((f) => f.endsWith('.py')), ['skills/modelmap/scripts/pyscan.py'], UPDATE);
});

test('network: no fetch, http(s).request, net.connect, WebSocket or XMLHttpRequest outside serve.mjs, except relative URLs in the page and open.mjs asking the local server; serve.mjs listens on 127.0.0.1 only; the page loads nothing from the internet', () => {
  assert.deepEqual(checkNetwork(files), [], UPDATE);
});

test('dynamic code: no eval, no dynamic import, no vm or workers, and exactly one new Function, in serve.mjs, loading the map\'s own query.mjs (graph-query.js)', () => {
  assert.deepEqual(checkDynamicCode(files), [], UPDATE);
});

test('pyscan.py: imports only ' + PY_STDLIB.join(', ') + ', and has no exec(, eval(, compile(, __import__, importlib, subprocess, os.system or open() in a write mode', () => {
  assert.deepEqual(checkPyscan(files.get('skills/modelmap/scripts/pyscan.py')), [], UPDATE);
});

test('weights: no torch.load, pickle, joblib or np.load in the code of the scripts (comments and messages do not count)', () => {
  assert.deepEqual(checkUnpickle(files), [], UPDATE);
});

test('copied files: the byte-identical floorplan files match the sha256 values of the UPSTREAM.md section 4 table, with their licence files next to them', () => {
  const rows = upstreamRows(read(path.join(repo, 'UPSTREAM.md')));
  assert.equal(rows.length, 11, 'UPSTREAM.md section 4 lists 11 files');
  assert.deepEqual(checkHashes(rows, (p) => fs.readFileSync(path.join(repo, p)), (p) => fs.existsSync(path.join(repo, p))), [], UPDATE);
  // every vendored file is one of them
  const vendored = allFiles(path.join(SKILL, 'assets', 'vendor')).map((f) => 'skills/modelmap/assets/vendor/' + f);
  assert.deepEqual(vendored.filter((f) => !rows.some((r) => r.dest === f)), [], 'vendored files without a hash in UPSTREAM.md');
});

test('file kinds: everything under skills/ is source, text, JSON, a font or an image', () => {
  const kinds = new Set(repoFiles.filter((f) => f.startsWith('skills/')).map((f) => path.posix.extname(f).toLowerCase()));
  assert.deepEqual([...kinds].filter((k) => !['.html', '.js', '.json', '.md', '.mjs', '.py', '.txt', '.woff2', '.png', '.svg'].includes(k)), [], UPDATE);
});

// ---------- mutation checks: each check catches a planted violation ----------

const plant = (file, text) => { const m = new Map(files); m.set(file, (m.get(file) || '') + '\n' + text + '\n'); return m; };

test('mutation: the checks fail on a planted hook, dependency, spawn of curl, execSync, outside fetch, 0.0.0.0 listen, eval, second new Function, dynamic import, torch.load and a changed copied file', () => {
  const plugin = json('.claude-plugin/plugin.json'), market = json('.claude-plugin/marketplace.json');
  assert.notDeepEqual(checkManifests({ ...plugin, hooks: './hooks.json' }, market, repoFiles), []);
  assert.notDeepEqual(checkManifests(plugin, { ...market, plugins: [{ ...market.plugins[0], mcpServers: {} }] }, repoFiles), []);
  assert.notDeepEqual(checkManifests(plugin, market, [...repoFiles, 'hooks/hooks.json']), []);
  assert.notDeepEqual(checkPackages([['package.json', { dependencies: { leftpad: '1' } }]], repoFiles), []);
  assert.notDeepEqual(checkPackages([['package.json', { scripts: { postinstall: 'node x.js' } }]], repoFiles), []);
  const S = 'skills/modelmap/scripts/describe.mjs';
  assert.notDeepEqual(checkSpawns(plant(S, "import { spawn } from 'node:child_process';\nspawn('curl', ['https://example.com']);")), []);
  assert.notDeepEqual(checkSpawns(plant('skills/modelmap/scripts/lib/common.mjs', "execFileSync('curl', [u]);")), []);
  assert.notDeepEqual(checkSpawns(plant('skills/modelmap/scripts/scan.mjs', "execSync('rm -rf /');")), []);
  assert.notDeepEqual(checkSpawns(plant('skills/modelmap/scripts/scan.mjs', "spawnSync(py, a, { shell: true });")), []);
  assert.notDeepEqual(checkNetwork(plant(S, "await fetch('https://example.com/upload', { method: 'POST' });")), []);
  assert.notDeepEqual(checkNetwork(plant(S, "https.request(u);")), []);
  assert.notDeepEqual(checkNetwork(plant(S, "import net from 'node:net';")), []);
  assert.notDeepEqual(checkNetwork(plant('skills/modelmap/assets/viewer.html', "fetch('https://example.com/x');")), []);
  assert.notDeepEqual(checkNetwork(plant(SERVE, "server.listen(port, '0.0.0.0');")), []);
  assert.notDeepEqual(checkDynamicCode(plant(S, 'eval(text);')), []);
  assert.notDeepEqual(checkDynamicCode(plant(SERVE, "const g = new Function('return 1');")), []);
  assert.notDeepEqual(checkDynamicCode(plant(S, "const m = await import('./x.mjs');")), []);
  assert.notDeepEqual(checkUnpickle(plant(S, 'const w = torch.load(f);')), []);
  assert.notDeepEqual(checkUnpickle(plant('skills/modelmap/scripts/pyscan.py', 'import pickle')), []);
  // comments and messages are not code
  assert.deepEqual(checkUnpickle(plant(S, "// torch.load is never called\nconsole.log('pickle files are not read');")), []);
  const rows = upstreamRows(read(path.join(repo, 'UPSTREAM.md')));
  const changed = rows[0].dest;
  assert.notDeepEqual(checkHashes(rows, (p) => Buffer.concat([fs.readFileSync(path.join(repo, p)), Buffer.from(p === changed ? ' ' : '')]), (p) => fs.existsSync(path.join(repo, p))), []);
  assert.notDeepEqual(checkHashes(rows, (p) => fs.readFileSync(path.join(repo, p)), (p) => !p.endsWith('elkjs-LICENSE.md') && fs.existsSync(path.join(repo, p))), []);
});

test('mutation: the pyscan check fails on import subprocess, exec(, eval(, compile(, __import__, importlib, os.system and open(..., "w"), and passes the same words in comments and strings', () => {
  const py = files.get('skills/modelmap/scripts/pyscan.py');
  for (const bad of ['import subprocess', 'import os, pickle', 'from urllib import request', 'from . import x', 'exec(src)', 'x = eval(s)', 'c = compile(src, "f", "exec")', '__import__("os")', 'importlib.import_module(n)', 'os.system("ls")', 'open(p, "w")', 'open(p, mode="a")', "with open(p, 'r+') as fh:", 'p.write_text("x")']) {
    assert.notDeepEqual(checkPyscan(py + '\n' + bad + '\n'), [], 'not caught: ' + bad);
  }
  for (const ok of ['# never exec( or eval( anything; subprocess is not used', 'msg = "pickle files are not read; open(p, \'w\') is never called"', 'pattern = re.compile(r"x")', 'with open(full, "rb") as fh:']) {
    assert.deepEqual(checkPyscan(py + '\n' + ok + '\n'), [], 'wrongly caught: ' + ok);
  }
});
