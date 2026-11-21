#!/usr/bin/env node
// Derived from floorplan v0.11.0 (MIT): skills/floorplan/scripts/status.mjs
// Prints whether a model map already exists here and how stale it is. Never fails and never writes.
// usage: node status.mjs [root] [--out DIR] [--json]
// --json prints one JSON object (modelmap/status-result@1) with "state": none | unbuilt | map, plus the
// text as "text". unbuilt: a scan (<map>/.cache/scan.json) but no graph.json.
import fs from 'node:fs';
import path from 'node:path';
import { git, mapDir, parseArgs, unattendedMode, printJson, readJsonFile, fmtNum } from './lib/common.mjs';

const args = parseArgs(process.argv.slice(2), { flags: ['json', 'unattended'] });
unattendedMode(args);
const SCHEMA = 'modelmap/status-result@1';
const data = { schema: SCHEMA, ok: true, state: 'none' };
const lines = [];
const num = (v) => (typeof v === 'number' ? fmtNum(v) : '?');
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
    for (const r of repos) {
      const abs = path.join(root, String(r.path || '.'));
      const head = git(abs, ['rev-parse', 'HEAD']);
      // compared: false when there's no commit to compare (no git repo now, or none when the map was built)
      if (!head || !r.head) { lines.push(`  ${r.path}: not a git repo now`); data.repos.push({ path: r.path, compared: false }); continue; }
      const changed = head === r.head ? [] : (git(abs, ['diff', '--name-only', r.head, head]) || '').split('\n').filter(Boolean);
      const dirty = (git(abs, ['status', '--porcelain']) || '').split('\n').filter(Boolean).length;
      data.repos.push({ path: r.path, compared: true, sameCommit: head === r.head, changedFiles: changed.length, uncommitted: dirty });
      lines.push(`  ${r.path}: ${head === r.head ? 'same commit' : `${changed.length} file(s) changed since ${r.head.slice(0, 7)}`}${dirty ? `, ${dirty} uncommitted` : ''}`);
      if (changed.length) lines.push(`    e.g. ${changed.slice(0, 6).map((p) => (r.path === '.' ? p : `${r.path}/${p}`)).join(', ')}`);
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
