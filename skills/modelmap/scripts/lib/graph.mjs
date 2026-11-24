// modelmap: turn a scan (scan.json) into the map's graph (graph.json). Written for modelmap.
// The graph keeps floorplan's top-level shape (nodes, files, routes, links, flows, tour) so the viewer works
// as it is; every module node carries the model facts in its m field (see the shared data contract).
import fs from 'node:fs';
import path from 'node:path';
import { foldTree, pattern } from './fold.mjs';
import { buildContract, mergeEstimates, buildDims } from './contract.mjs';
import { mergeFlows, checkFlows, classIndex, flowGraph, FLOW_CAPS } from './flow.mjs';

export const GRAPH_SCHEMA = 'modelmap/graph@1';
export const MAX_ARGS = 12;      // arguments kept per module
export const MAX_VALUE = 200;    // characters kept per argument value

const has = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

/** The kind of a module, from its class name (case-insensitive). The first match wins. */
export function kindOf(node, isRoot = false) {
  if (isRoot) return 'model';
  if (node.alias !== undefined) return 'other';
  if (node.kind === 'external' || node.kind === 'unknown') return 'external';
  const c = String(node.cls || '');
  if (/attention|attn/i.test(c)) return 'attention';
  if (/mlp|feedforward|ffn/i.test(c)) return 'mlp';
  if (/norm/i.test(c)) return 'norm';
  if (/embed|embedding|positional/i.test(c)) return 'embed';
  if (/linear|conv/i.test(c)) return 'linear';
  if (/block|layer/i.test(c)) return 'block';
  return 'other';
}

/** A value record cut to size: a value longer than MAX_VALUE characters becomes its first MAX_VALUE characters and "...". */
function cutRecord(rec) {
  if (!isObj(rec) || !has(rec, 'v')) return { v: cutValue(rec) };
  const out = { v: cutValue(rec.v) };
  if (has(rec, 'at')) out.at = typeof rec.at === 'string' ? rec.at.slice(0, MAX_VALUE) : rec.at;
  if (has(rec, 'src')) out.src = rec.src;
  return out;
}
function cutValue(v) {
  if (typeof v === 'string') return v.length > MAX_VALUE ? v.slice(0, MAX_VALUE) + '...' : v;
  if (v === null || typeof v !== 'object') return v;
  const s = JSON.stringify(v);
  return s.length > MAX_VALUE ? s.slice(0, MAX_VALUE) + '...' : v;
}

/** The arguments of a module as { name: record }: a repo class's named arguments, or a torch/outside class's
 *  positional arguments (keys "0", "1", ...) followed by its keyword arguments. At most MAX_ARGS. */
function argsOf(node) {
  const all = [];
  if (isObj(node.args)) for (const [k, r] of Object.entries(node.args)) all.push([k, r]);
  else {
    (Array.isArray(node.pos) ? node.pos : []).forEach((r, i) => all.push([String(i), r]));
    if (isObj(node.kw)) for (const [k, r] of Object.entries(node.kw)) all.push([k, r]);
  }
  const args = {};
  for (const [k, r] of all.slice(0, MAX_ARGS)) Object.defineProperty(args, String(k).slice(0, MAX_VALUE), { value: cutRecord(r), enumerable: true, writable: true, configurable: true });
  return { args, more: Math.max(0, all.length - MAX_ARGS) };
}

const paramsOf = (p) => {
  if (!isObj(p)) return { v: null, src: 'code' };
  const out = { v: p.v, src: p.src || 'code' };
  if (p.lowerBound) { out.lowerBound = true; if (p.why) out.why = String(p.why); }
  return out;
};

/** Count every node of the full (unfolded) tree, the root and shared stubs included. */
const countTree = (n) => 1 + (n.children || []).reduce((s, c) => s + countTree(c), 0);


/** Every node of a scan tree by its path (shared stubs included). */
function pathIndex(tree) {
  const out = new Map();
  const walk = (n) => { if (!out.has(String(n.path ?? ''))) out.set(String(n.path ?? ''), n); for (const c of n.children || []) walk(c); };
  walk(tree);
  return out;
}

const MAX_FAILING = 5, MAX_FOLD_NOTES = 10;

/**
 * A folded run shows its first member, but a fact that can differ between members must hold for ALL of them:
 * the weights check (ok only when every member and every descendant of a member is ok; the failing keys go to
 * m.fold.failing), the weights summed over the members, a lower bound, notes and skipped code. The shown subtree
 * and the other check fields stay those of the first member.
 */
function foldOver(members, m) {
  const first = members[0];
  // the checks that cover each member's subtree: the member's own, else the nearest checked descendants
  const failing = [], checks = [];
  const collect = (member, n) => {
    if (n.alias !== undefined) return;
    if (isObj(n.check)) {
      checks.push(n.check);
      if (n.check.ok === false) {
        const before = failing.length;
        for (const x of Array.isArray(n.check.mismatched) ? n.check.mismatched : []) failing.push({ member, key: String(x?.key ?? ''), expected: x?.expected ?? null, found: x?.found ?? null });
        for (const k of Array.isArray(n.check.missing) ? n.check.missing : []) failing.push({ member, key: String(k), expected: null, found: null, missing: true });
        if (failing.length === before) failing.push({ member, key: String(n.path ?? member), expected: null, found: null });
      }
      return;
    }
    for (const c of n.children || []) collect(member, c);
  };
  for (const mem of members) collect(String(mem.path ?? ''), mem);
  if (checks.length) {
    const base = isObj(first.check) ? { ...first.check } : { ok: true, file: checks[0].file ?? null, expectedKeys: 0, foundKeys: 0, missing: [], mismatched: [], partial: true };
    base.ok = checks.every((c) => c.ok !== false);
    if (checks.some((c) => c.partial)) base.partial = true;
    m.check = base;
  }
  if (failing.length) {
    m.fold.failing = failing.slice(0, MAX_FAILING);
    m.fold.failingCount = failing.length;
  }
  // the weights of every member, next to fold.total (the code's count of every member)
  const withW = members.filter((x) => isObj(x.weights));
  if (withW.length) {
    m.fold.weights = withW.reduce((s, x) => ({
      params: s.params + (Number(x.weights.params) || 0),
      bytes: s.bytes === null || typeof x.weights.bytes !== 'number' ? null : s.bytes + x.weights.bytes,
      keys: s.keys + (Number(x.weights.keys) || 0),
    }), { params: 0, bytes: 0, keys: 0 });
    m.fold.weights.members = withW.length;
  }
  // a member whose count is a lower bound makes the run's count one too
  const lb = members.find((x) => isObj(x.params) && x.params.lowerBound);
  if (lb && !m.params.lowerBound) { m.params.lowerBound = true; m.params.why = String(lb.path ?? '') + ': ' + String(lb.params.why || 'a part is unknown'); }
  if (members.some((x) => x.incomplete)) m.incomplete = true;
  // notes and skipped code inside another member that the first member does not have at the same place
  const firstAt = pathIndex(first), notes = [];
  const fp = String(first.path ?? '');
  for (const mem of members.slice(1)) {
    const mp = String(mem.path ?? '');
    const walk = (n) => {
      const rel = String(n.path ?? '').slice(mp.length);
      const twin = firstAt.get(fp + rel);
      const ns = Array.isArray(n.notes) ? n.notes.map(String) : [];
      const tn = twin && Array.isArray(twin.notes) ? twin.notes.map(String) : [];
      for (const t of ns) if (!tn.includes(t)) notes.push(String(n.path ?? '') + ': ' + t);
      if (n.incomplete && !(twin && twin.incomplete)) notes.push(String(n.path ?? '') + ': part of the constructor was skipped');
      for (const c of n.children || []) walk(c);
    };
    walk(mem);
  }
  if (notes.length) m.fold.notes = notes.slice(0, MAX_FOLD_NOTES).map((s) => s.slice(0, MAX_VALUE));
}

/** A small summary (scan.weights, scan.config) for meta: strings cut at MAX_VALUE characters. */
function capStrings(v, depth = 0) {
  if (typeof v === 'string') return v.length > MAX_VALUE ? v.slice(0, MAX_VALUE) + '...' : v;
  if (v === null || typeof v !== 'object' || depth > 6) return typeof v === 'object' && v !== null ? null : v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => capStrings(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) Object.defineProperty(out, k.slice(0, MAX_VALUE), { value: capStrings(x, depth + 1), enumerable: true, writable: true, configurable: true });
  return out;
}

const emptyDescriptions = () => ({ classes: Object.create(null), modules: Object.create(null), contract: null, flows: null });

/**
 * The graph for a scan. descriptions: the merged result of loadDescriptions(). name: the repo's name for the map's
 * meta.rootName (default scan.meta.root). root: the repo's absolute path, for the viewer's editor links (meta.root).
 * repos: meta.repos, [{ path, name, branch?, head? }] (build.mjs reads them from git). warnings: an array that
 * gets a line for each estimate of the descriptions' "contract" block that was dropped (lib/contract.mjs), and for
 * each part of the "flows" block that was dropped (lib/flow.mjs). flowIndex: classIndex(scan) when the caller has it
 * (default: made here, reading forward() as text from root when root is given).
 */
export function toGraph(scan, { descriptions, name, root, repos, warnings, flowIndex } = {}) {
  if (!scan || !isObj(scan.root)) throw new Error('the scan has no root module');
  const D = descriptions && isObj(descriptions) ? descriptions : emptyDescriptions();
  const classes = isObj(D.classes) ? D.classes : {}, modules = isObj(D.modules) ? D.modules : {};
  const classDesc = (cls) => (has(classes, cls) && isObj(classes[cls]) ? classes[cls] : null);
  const moduleDesc = (p) => (has(modules, p) && isObj(modules[p]) ? modules[p] : null);

  const nodes = [];
  const byPath = pathIndex(scan.root);
  const used = new Set(['root']);
  const idFor = (p) => {
    // the root's id is "root"; a module whose path is "root" (an attribute named root) gets "root~" instead
    let id = p, i = 0;
    while (used.has(id)) id = p + '~'.repeat(++i);
    used.add(id);
    return id;
  };

  const emit = (n, parent, isRoot) => {
    const id = isRoot ? 'root' : idFor(String(n.path ?? ''));
    const cd = classDesc(n.cls), md = moduleDesc(isRoot ? '' : n.path);
    const { args, more } = n.alias !== undefined ? { args: {}, more: 0 } : argsOf(n);
    const m = {
      cls: String(n.cls ?? ''),
      ckind: n.kind || 'unknown',
      def: n.file ? { file: String(n.file), line: Number.isInteger(n.line) ? n.line : null } : null,
      args,
      params: paramsOf(n.params),
      own: typeof n.own === 'number' ? n.own : 0,
      bytes: { fp32: isObj(n.bytes) && typeof n.bytes.fp32 === 'number' ? n.bytes.fp32 : 0 },
    };
    if (more) m.argsMore = more;
    if (n.container) m.container = n.container;
    if (n.fold) m.fold = { n: n.fold.n, members: n.fold.members.slice(), ...(has(n.fold, 'total') ? { total: n.fold.total } : {}) };
    if (n.letter) m.letter = n.letter;
    const pat = n.container && n.alias === undefined ? pattern(n) : null;
    if (pat) m.pattern = pat;
    if (n.alias !== undefined) m.alias = String(n.alias);
    if (n.tied) m.tied = n.tied;
    if (Array.isArray(n.notes) && n.notes.length) m.notes = n.notes.map(String);
    if (n.incomplete) m.incomplete = true;
    if (n.why && (n.kind === 'external' || n.kind === 'unknown')) m.why = String(n.why);
    if (n.weights) m.weights = n.weights;
    if (n.check) m.check = n.check;
    if (Array.isArray(n.direct) && n.direct.length) m.direct = n.direct.slice(0, MAX_ARGS).map((p) => ({ name: String(p?.name ?? ''), shape: p?.shape ?? null, src: p?.src || 'code' }));
    if (m.fold) foldOver(m.fold.members.map((p) => byPath.get(p)).filter(Boolean), m);
    const label = isRoot ? m.cls : String(n.name ?? n.path ?? '');
    const g = {
      id, parent, label, kind: kindOf(n, isRoot),
      summary: (md && typeof md.d === 'string' ? md.d : cd && typeof cd.d === 'string' ? cd.d : ''),
      details: cd && typeof cd.details === 'string' ? cd.details : '',
      tags: [], paths: [], packages: [], hosts: [], stats: { files: 0, loc: 0 },
      m,
    };
    if (cd && typeof cd.name === 'string' && cd.name) g.title = cd.name;
    nodes.push(g);
    for (const c of n.children || []) emit(c, id, false);
  };
  // equal siblings folded: a folded run is one node (its first member) whose children are that member's children
  emit(foldTree(scan.root), null, true);

  const res = isObj(scan.resolution) ? scan.resolution : {};
  const rootNode = nodes[0];
  // the input and output contract of the root's forward(); absent when the scan found no forward
  const contract = buildContract(scan, D, Array.isArray(warnings) ? warnings : []);
  // the block flow diagram: the "flows" block, checked against the scan, becomes tensor links between the cards of
  // every instance of a class, and virtual nodes (in, out, ops) that are not modules (lib/flow.mjs)
  let links = [], flowClasses = 0;
  const flowNotes = [];
  if (isObj(D.flows) && Object.keys(D.flows).length) {
    const chk = checkFlows(D.flows, { index: flowIndex || classIndex(scan, { root: root || null }), symbols: buildDims(scan).map((d) => d.sym) });
    const fg = flowGraph(nodes, chk.flows);
    nodes.push(...fg.nodes);
    links = fg.links; flowClasses = fg.flowClasses;
    flowNotes.push(...chk.errors, ...chk.warnings, ...fg.warnings);
    if (Array.isArray(warnings)) warnings.push(...flowNotes);
  }
  return {
    schema: GRAPH_SCHEMA,
    meta: {
      generatedAt: new Date().toISOString(),
      scanAt: scan.meta?.generatedAt || null,
      rootName: name || scan.meta?.root || rootNode.label,
      root: root || null,
      agent: 'claude',
      ...(Array.isArray(repos) ? { repos } : {}),
      ...(isObj(scan.weights) ? { weights: capStrings(scan.weights) } : {}),
      ...(isObj(scan.config) ? { config: capStrings(scan.config) } : {}),
      counts: {
        modules: countTree(scan.root),
        params: rootNode.m.params.v,
        unknownParts: (res.unknown || 0) + (res.external || 0) + (res.incomplete || 0),
        contractInputs: contract ? contract.inputs.length : 0,
        flowClasses,
        linkCount: links.length,
      },
      ...(flowNotes.length ? { flowWarnings: flowNotes.slice(0, FLOW_CAPS.warnings).map((s) => (s.length > 300 ? s.slice(0, 299) + '…' : s)) } : {}),
    },
    project: { name: rootNode.label, summary: rootNode.summary },
    nodes,
    files: [], routes: [], links, flows: [], tour: [],
    ...(contract ? { contract } : {}),
  };
}

const strField = (o, k, max) => (has(o, k) && typeof o[k] === 'string' ? o[k].slice(0, max) : undefined);

/**
 * Read <dir>/*.json in file-name order and merge them: { classes, modules, contract, flows, files, warnings }. A later file wins,
 * field by field. A file that is not JSON or has the wrong shape is skipped with a warning; this never throws.
 */
export function loadDescriptions(dir) {
  const out = { ...emptyDescriptions(), files: [], warnings: [] };
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); }
  catch (e) { if (e.code !== 'ENOENT') out.warnings.push('descriptions: cannot read ' + dir + ': ' + e.code); return out; }
  for (const n of names) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8').replace(/^﻿/, '')); }
    catch (e) { out.warnings.push('descriptions/' + n + ' skipped: not valid JSON'); continue; }
    if (!isObj(data) || (data.classes !== undefined && !isObj(data.classes)) || (data.modules !== undefined && !isObj(data.modules))) {
      out.warnings.push('descriptions/' + n + ' skipped: expected { "classes": {...}, "modules": {...} }');
      continue;
    }
    let bad = 0;
    for (const [part, fields] of [['classes', [['name', 200], ['d', 2000], ['details', 8000]]], ['modules', [['d', 2000]]]]) {
      for (const [key, entry] of Object.entries(data[part] || {})) {
        if (!isObj(entry)) { bad++; continue; }
        const rec = {};
        for (const [f, max] of fields) { const v = strField(entry, f, max); if (v !== undefined) rec[f] = v; }
        if (!Object.keys(rec).length) { bad++; continue; }
        out[part][key] = { ...(out[part][key] || {}), ...rec };
      }
    }
    if (bad) out.warnings.push('descriptions/' + n + ': ' + bad + ' entr' + (bad === 1 ? 'y' : 'ies') + ' without text skipped');
    // the estimates of the input and output contract; checked against the scan by buildContract()
    if (data.contract !== undefined) {
      if (isObj(data.contract)) out.contract = mergeEstimates(out.contract, data.contract);
      else out.warnings.push('descriptions/' + n + ': "contract" skipped: expected { "inputs": {...}, "output": {...} }');
    }
    // the block flow diagram; checked against the scan by toGraph() (lib/flow.mjs)
    if (data.flows !== undefined) {
      if (isObj(data.flows)) out.flows = mergeFlows(out.flows, data.flows);
      else out.warnings.push('descriptions/' + n + ': "flows" skipped: expected { "<ClassName>": { "ops": [...], "edges": [...] } }');
    }
    out.files.push(n);
  }
  return out;
}
