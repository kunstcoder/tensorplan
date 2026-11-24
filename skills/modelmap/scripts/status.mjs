#!/usr/bin/env node
// Derived from floorplan v0.11.0 (MIT): skills/floorplan/scripts/status.mjs
// Prints whether a model map already exists here and how stale it is. Never fails and never writes.
// usage: node status.mjs [root] [--out DIR] [--json]
// --json prints one JSON object (modelmap/status-result@1) with "state": none | unbuilt | map, plus the
// text as "text". unbuilt: a scan (<map>/.cache/scan.json) but no graph.json.
import fs from 'node:fs';
import path from 'node:path';
import { git, mapDir, parseArgs, unattendedMode, printJson, readJsonFile, fmtNum, folderInside, isGitObjectName } from './lib/common.mjs';

const args = parseArgs(process.argv.slice(2), { flags: ['json', 'unattended'] });
unattendedMode(args);
const SCHEMA = 'modelmap/status-result@1';
const data = { schema: SCHEMA, ok: true, state: 'none' };
const lines = [];
const num = (v) => (typeof v === 'number' ? fmtNum(v) : '?');
// The files that differ between two commits a and b, both checked as commit ids by the caller. "--" after them says they are
// revisions, not paths; --end-of-options (git 2.24 and later) also says they are not options. An older git fails on it: then the same without.
const diffNames = (cwd, a, b) => git(cwd, ['diff', '--name-only', '--end-of-options', a, b, '--']) ?? git(cwd, ['diff', '--name-only', a, b, '--']) ?? '';
try {
  const root = path.resolve(args._[0] || '.');
  const dir = args.out ? path.resolve(String(args.out)) : mapDir(root);
  const rel = path.relative(root, dir).replace(/\\/g, '/') || '.';
  data.mapDir = rel;
  const graphFile = path.join(dir, 'graph.json');
  const scanFile = path.join(dir, '.cache', 'scan.json');
  if (!fs.existsSync(graphFile)) {
    if (fs.existsSync(scanFile)) {
      data.state = 'unbuilt';
      let what = '';
      try {
        const s = readJsonFile(scanFile);
        Object.assign(data, { scannedAt: s.meta?.generatedAt || null, rootClass: s.root?.cls || null });
        what = ` of ${s.root?.cls || '?'}${s.meta?.generatedAt ? ` (${s.meta.generatedAt})` : ''}`;
      } catch { what = ' (it could not be read)'; }
      lines.push(`unbuilt: a scan${what} is in ${rel}/.cache/scan.json but no map was built. Write descriptions (describe.mjs), then run build.mjs.`);
    } else {
      lines.push('none: no model map here yet (fresh run).');
    }
  } else {
    const g = readJsonFile(graphFile);
    const m = g.meta || {};
    const c = m.counts || {};
    data.state = 'map';
    Object.assign(data, { builtAt: m.generatedAt || null, rootName: m.rootName || null, modules: c.modules ?? null, params: c.params ?? null, unknownParts: c.unknownParts ?? null, nodes: Array.isArray(g.nodes) ? g.nodes.length : null, agent: m.agent || null, repos: [] });
    lines.push(`map of ${m.rootName || '?'} built ${m.generatedAt || '?'}: ${num(c.modules)} modules, ${num(c.params)} parameters${c.unknownParts ? ` (≥, ${c.unknownParts} unknown parts)` : ''}.`);
    // the commits the map was built from: meta.repos [{ path, head }] or meta.head for the root alone
    const repos = Array.isArray(m.repos) ? m.repos : m.head ? [{ path: '.', head: m.head }] : [];
    if (!repos.length) lines.push('  (the map records no git commit, so it was not compared with the code)');
    // graph.json can be a file the scanned repo shipped: path and head are checked before they reach git (lib/common.mjs)
    const shown = (v) => (typeof v === 'string' && v.length <= 80 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v) ? v : null);
    for (const [i, r0] of repos.entries()) {
      const r = r0 && typeof r0 === 'object' && !Array.isArray(r0) ? r0 : {};
      const label = shown(r.path) ?? (r.path === undefined || r.path === null || r.path === '' ? '.' : `(repo ${i + 1})`);
      const abs = folderInside(root, r.path);
      if (!abs) { lines.push(`  ${label}: not compared (the folder the map recorded is not a folder inside this repo)`); data.repos.push({ path: null, compared: false, reason: 'invalid path' }); continue; }
      // no commit recorded: the map was built without git. A value that is not a commit id: never given to git.
      const recorded = r.head === undefined || r.head === null ? null : r.head;
      if (recorded !== null && !isGitObjectName(recorded)) { lines.push(`  ${label}: not compared (the commit the map recorded is not a valid commit id)`); data.repos.push({ path: r.path, compared: false, reason: 'invalid commit' }); continue; }
      const now = git(abs, ['rev-parse', 'HEAD']);
      const head = isGitObjectName(now) ? now : null;
      // compared: false when there's no commit to compare (no git repo now, or none when the map was built)
      if (!head || !recorded) { lines.push(`  ${label}: not a git repo now`); data.repos.push({ path: r.path, compared: false }); continue; }
      const changed = head === recorded ? [] : diffNames(abs, recorded, head).split('\n').filter(Boolean);
      // --ignore-submodules=all: status would otherwise look inside each submodule, with that submodule's own .git/config (lib/common.mjs)
      const dirty = (git(abs, ['status', '--porcelain', '--ignore-submodules=all']) || '').split('\n').filter(Boolean).length;
      data.repos.push({ path: r.path, compared: true, sameCommit: head === recorded, changedFiles: changed.length, uncommitted: dirty });
      lines.push(`  ${label}: ${head === recorded ? 'same commit' : `${changed.length} file(s) changed since ${recorded.slice(0, 7)}`}${dirty ? `, ${dirty} uncommitted` : ''}`);
      if (changed.length) lines.push(`    e.g. ${changed.slice(0, 6).map((p) => (label === '.' ? p : `${label}/${p}`)).join(', ')}`);
    }
    lines.push('A map exists. After changes to the model, run scan.mjs and build.mjs again; descriptions/ is kept.');
  }
} catch (e) {
  data.state = 'unknown';
  data.error = e.message;
  lines.push(`status unavailable (${e.message})`);
}
if (args.json) await printJson({ ...data, text: lines.join('\n') });
else console.log(lines.join('\n'));
