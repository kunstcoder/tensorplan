// modelmap lib/flow.mjs: the block flow diagram (F07, plan claim 5). Written for modelmap.
//
// Claude reads the forward() of a class and writes, in descriptions/*.json, the optional block
//   "flows": { "<ClassName or file.py:ClassName>": {
//     "ops":   [{ "id": "add1", "op": "add", "label": "+" }],
//     "edges": [{ "from": "norm1", "to": "attn", "shape": "[B, N, D]", "skip": false, "at": "file.py:35", "d": "..." }] } }
// An endpoint is a DIRECT child module of the class (its attribute name; "self.out" names a child called out),
// "in" (what forward receives), "out" (what forward returns) or the id of an op (an operation that is not a module).
// This file checks the block against the scan (the class, its direct children, the dims symbols, the text of its
// forward()) and turns it into graph links between the cards of every instance of the class, with VIRTUAL nodes for
// "in", "out" and the ops. Virtual nodes are not modules: they carry virtual: true and no m field.
// EVERY shape is an estimate: Claude's reading of the code; nothing was run. The functions never throw; only
// classIndex reads files, as text, through lib/pytext.mjs. All text here is untrusted data: it is checked, cut to
// size and escaped by the page, never built into code or markup.
import { checkShape } from './contract.mjs';
import { repoLines, classText } from './pytext.mjs';

export const FLOW_CAPS = { classes: 40, edges: 60, ops: 12, links: 5000, d: 200, label: 20, at: 200, key: 200, name: 80, warnings: 10 };
export const OPS = ['add', 'mul', 'concat', 'other'];
export const OP_LABEL = { add: '+', mul: '×', concat: '⧺' };
const ENTRY_KEYS = ['ops', 'edges'];
const OP_KEYS = ['id', 'op', 'label'];
const EDGE_KEYS = ['from', 'to', 'shape', 'skip', 'at', 'd'];
const OP_ID = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const CHILD = /^(?:[A-Za-z_][A-Za-z0-9_]*|\d+)$/; // an attribute name, or an index inside a container
// C0/C1 controls and the bidirectional marks and overrides (the same set describe.mjs refuses)
const CONTROL = /[\u0000-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/;
const CONTROL_G = new RegExp(CONTROL.source, 'g');
const MAX_RAW = 1000; // list entries kept while merging files; checkFlows reports the real caps

const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
/** Text kept for the page: control characters become spaces, then it is cut to n characters. */
const clean = (s, n) => cut(String(s).replace(CONTROL_G, ' ').trim(), n);
/** A name from the file inside a message: quoted, cut, control characters made visible. */
const q = (s, n = 60) => JSON.stringify(cut(String(s).replace(CONTROL_G, '�'), n));

/** Korean text of the virtual nodes (the page shows it as their description). */
const IO_TEXT = {
  in: 'forward() 가 받는 입력(input). 모듈이 아니라 흐름도(flow)의 시작점이다.',
  out: 'forward() 가 돌려주는 출력(output). 모듈이 아니라 흐름도(flow)의 끝점이다.',
};
const OP_WORD = { add: '더하기(add)', mul: '곱하기(mul)', concat: '이어 붙이기(concat)', other: '그 밖의 연산(other)' };
const opText = (op) => 'forward() 안의 연산(operation): ' + OP_WORD[op.op] + '. 모듈이 아니므로 파라미터(parameters)가 없다.';

/**
 * Merge the "flows" block of one descriptions file into into (made when null): a later file wins per class key,
 * field by field ("ops", "edges"). Values are kept as written; checkFlows checks them. Returns into. Never throws.
 */
export function mergeFlows(into, block) {
  const out = into || Object.create(null);
  if (!isObj(block)) return out;
  for (const [k, e] of Object.entries(block)) {
    if (!isObj(e)) { out[k] = e; continue; }
    const rec = {};
    for (const [f, v] of Object.entries(e)) rec[f] = Array.isArray(v) ? v.slice(0, MAX_RAW) : v;
    out[k] = isObj(out[k]) ? { ...out[k], ...rec } : rec;
  }
  return out;
}

/**
 * The repo classes of a scan, for checking flows: [{ cls, file, line, count, children: Map(name -> class),
 * forward }]. One entry per class (file and name); children are the direct children of every instance.
 * forward: { file, start, last } (1-based lines of the method), false when the class body has no forward(), null when
 * the file was not read (no repo root given). The files are read as text, never run.
 */
export function classIndex(scan, { root = null, readLines = null } = {}) {
  const groups = new Map();
  const walk = (n, depth) => {
    if (!isObj(n) || depth > 200) return;
    const kids = Array.isArray(n.children) ? n.children : [];
    if (n.kind === 'repo' && n.alias === undefined && typeof n.cls === 'string') {
      const file = typeof n.file === 'string' ? n.file : '';
      const key = file + '\0' + n.cls;
      let e = groups.get(key);
      if (!e) groups.set(key, (e = { cls: n.cls, file, line: Number.isInteger(n.line) ? n.line : null, count: 0, children: new Map(), forward: null }));
      e.count++;
      for (const c of kids) if (isObj(c) && c.name !== undefined && c.name !== null && !e.children.has(String(c.name))) e.children.set(String(c.name), String(c.cls ?? ''));
    }
    for (const c of kids) walk(c, depth + 1);
  };
  walk(scan && scan.root, 0);
  const read = typeof readLines === 'function' ? readLines : root ? (f) => repoLines(root, f) : null;
  for (const e of groups.values()) {
    if (!read || !e.file) continue;
    try {
      const t = classText(read(e.file), e.cls, e.line);
      e.forward = t.forward ? { file: e.file, start: t.forward.start, last: t.forward.last } : t.note ? null : false;
    } catch { e.forward = null; }
  }
  return [...groups.values()];
}

const sameFile = (a, b) => a === b || a.endsWith('/' + b);
/** The classes a key names: "ClassName" (every class of that name) or "file.py:ClassName" (that file's class). */
export function entriesFor(key, index) {
  const k = String(key), i = k.lastIndexOf(':');
  if (i > 0) { const file = k.slice(0, i), cls = k.slice(i + 1); return index.filter((e) => e.cls === cls && sameFile(e.file, file)); }
  return index.filter((e) => e.cls === k);
}

/**
 * Check a "flows" block (merged, or one file's). index: classIndex(scan), or null to check the form only (no scan).
 * symbols: the dims symbols (lib/contract.mjs buildDims); B and N are always allowed. Returns { flows, errors,
 * warnings }: flows are what passed, normalised ({ key, cls, file, ops, edges }); errors fail describe.mjs --check;
 * the build drops what they name and keeps the rest (a bad shape drops only the shape, the edge stays).
 */
export function checkFlows(block, { index = null, symbols = [] } = {}) {
  const errors = [], warnings = [], flows = [];
  const err = (s) => errors.push(s), warn = (s) => warnings.push(s);
  if (!isObj(block)) { err('"flows" must be an object keyed by class name ("ClassName" or "file.py:ClassName")'); return { flows, errors, warnings }; }
  const keys = Object.keys(block);
  if (keys.length > FLOW_CAPS.classes) err('"flows" has ' + keys.length + ' classes (at most ' + FLOW_CAPS.classes + '); the rest are left out');
  for (const key of keys.slice(0, FLOW_CAPS.classes)) {
    const where = 'flows.' + q(key);
    if (!key.trim() || key.length > FLOW_CAPS.key || CONTROL.test(key)) { err(where + ': a key is a class name or "file.py:ClassName", at most ' + FLOW_CAPS.key + ' characters, no control characters'); continue; }
    const e = block[key];
    if (!isObj(e)) { err(where + ': must be an object { "ops": [...], "edges": [...] }'); continue; }
    for (const k of Object.keys(e)) if (!ENTRY_KEYS.includes(k)) err(where + ': unknown key ' + q(k, 40) + ' (only "ops" and "edges")');
    const i = key.lastIndexOf(':');
    const cls = i > 0 ? key.slice(i + 1) : key, file = i > 0 ? key.slice(0, i) : null;
    const entries = index ? entriesFor(key, index) : null;
    if (entries && !entries.length) warn(where + ': the scan has no repo class ' + (file ? 'of this name in this file' : 'of this name') + ', so this flow is left out');
    if (entries && !file && new Set(entries.map((x) => x.file)).size > 1) warn(where + ': ' + entries.length + ' repo classes have this name (' + entries.slice(0, 3).map((x) => x.file).join(', ') + '); the flow applies to each; write "file.py:' + cls + '" to pick one');
    const children = entries && entries.length ? new Set(entries.flatMap((x) => [...x.children.keys()])) : null;

    // ops: operations that are not modules
    const ops = [];
    if (e.ops !== undefined && !Array.isArray(e.ops)) err(where + '.ops must be a list of { "id", "op", "label" }');
    const rawOps = Array.isArray(e.ops) ? e.ops : [];
    if (rawOps.length > FLOW_CAPS.ops) err(where + '.ops has ' + rawOps.length + ' entries (at most ' + FLOW_CAPS.ops + '); the rest are left out');
    rawOps.slice(0, FLOW_CAPS.ops).forEach((o, k) => {
      const w = where + '.ops[' + k + ']';
      if (!isObj(o)) { err(w + ': must be an object { "id", "op", "label" }'); return; }
      for (const x of Object.keys(o)) if (!OP_KEYS.includes(x)) err(w + ': unknown key ' + q(x, 40) + ' (only "id", "op" and "label")');
      if (typeof o.id !== 'string' || !OP_ID.test(o.id)) { err(w + '.id must be a short name (letters, digits and _, at most 40 characters), like "add1"'); return; }
      if (o.id === 'in' || o.id === 'out' || (children && children.has(o.id))) { err(w + '.id ' + q(o.id) + ' is taken by "in", "out" or a child module'); return; }
      if (ops.some((x) => x.id === o.id)) { err(w + '.id ' + q(o.id) + ' is declared twice'); return; }
      if (!OPS.includes(o.op)) { err(w + '.op must be one of ' + OPS.join(', ')); return; }
      let label = OP_LABEL[o.op] || o.op;
      if (o.label !== undefined) {
        if (typeof o.label !== 'string' || !o.label.trim()) err(w + '.label must be a non-empty string');
        else {
          if (o.label.length > FLOW_CAPS.label) err(w + '.label has ' + o.label.length + ' characters (at most ' + FLOW_CAPS.label + ')');
          if (CONTROL.test(o.label)) err(w + '.label holds a control character');
          label = clean(o.label, FLOW_CAPS.label) || label;
        }
      }
      ops.push({ id: o.id, op: o.op, label });
    });
    const opIds = new Set(ops.map((x) => x.id));

    // edges
    const edges = [];
    if (!Array.isArray(e.edges)) err(where + '.edges must be a list of { "from", "to", "shape", "skip", "at", "d" }');
    else if (!e.edges.length) err(where + '.edges is empty');
    const rawEdges = Array.isArray(e.edges) ? e.edges : [];
    if (rawEdges.length > FLOW_CAPS.edges) err(where + '.edges has ' + rawEdges.length + ' entries (at most ' + FLOW_CAPS.edges + '); the rest are left out');
    const endpoint = (w, v, side) => {
      if (typeof v !== 'string' || !v.trim()) { err(w + ' must be a string: a direct child module, "in", "out" or an op id'); return null; }
      const t = v.trim(), viaSelf = t.startsWith('self.'), s = viaSelf ? t.slice(5) : t;
      if (!viaSelf && (s === 'in' || s === 'out')) {
        if (side === 'from' && s === 'out') { err(w + ': "out" is what forward() returns; an edge cannot start there'); return null; }
        if (side === 'to' && s === 'in') { err(w + ': "in" is what forward() receives; an edge cannot end there'); return null; }
        return { t: 'io', v: s };
      }
      if (!viaSelf && opIds.has(s)) return { t: 'op', v: s };
      if (!CHILD.test(s) || s.length > FLOW_CAPS.name) { err(w + ' ' + q(v) + ' is not a direct child module, "in", "out" or a declared op id'); return null; }
      if (children && !children.has(s)) { err(w + ' ' + q(v) + ': ' + q(key) + ' has no direct child module of this name (it has ' + [...children].slice(0, 12).map((x) => q(x, 30)).join(', ') + (children.size > 12 ? ', …' : '') + ')'); return null; }
      return { t: 'child', v: s };
    };
    const fwds = entries ? entries.map((x) => x.forward) : [];
    const seen = new Set();
    rawEdges.slice(0, FLOW_CAPS.edges).forEach((x, k) => {
      const w = where + '.edges[' + k + ']';
      if (!isObj(x)) { err(w + ': must be an object { "from", "to", "shape", "skip", "at", "d" }'); return; }
      for (const y of Object.keys(x)) if (!EDGE_KEYS.includes(y)) err(w + ': unknown key ' + q(y, 40) + ' (only ' + EDGE_KEYS.map((z) => '"' + z + '"').join(', ') + ')');
      const from = endpoint(w + '.from', x.from, 'from'), to = endpoint(w + '.to', x.to, 'to');
      if (!from || !to) return;
      if (from.t === to.t && from.v === to.v) { err(w + ': from and to are the same'); return; }
      const edge = { from, to, shape: null, skip: false, at: null, d: null };
      if (x.shape !== undefined) {
        const c = checkShape(x.shape, symbols);
        if (c.error) err(w + '.shape dropped: ' + c.error + ' (the edge stays, without a shape)');
        else edge.shape = c.v;
      }
      if (x.skip !== undefined) { if (typeof x.skip !== 'boolean') err(w + '.skip must be true or false'); else edge.skip = x.skip; }
      if (x.at !== undefined) {
        const m = typeof x.at === 'string' && x.at.length <= FLOW_CAPS.at && !CONTROL.test(x.at) ? /^([^:]+(?::[^:]+)*):(\d+)$/.exec(x.at.trim()) : null;
        if (!m) err(w + '.at must be "file:line" (at most ' + FLOW_CAPS.at + ' characters), like "src/block.py:35"');
        else {
          const line = Number(m[2]);
          edge.at = m[1] + ':' + line;
          const known = fwds.filter(Boolean);
          if (known.length && !known.some((fw) => sameFile(fw.file, m[1]) && line >= fw.start && line <= fw.last)) warn(w + '.at ' + q(edge.at) + ' is not inside forward() of ' + q(key) + ' (' + known.slice(0, 3).map((fw) => fw.file + ':' + fw.start + '-' + fw.last).join(', ') + ')');
          else if (!known.length && fwds.some((fw) => fw === false)) warn(w + '.at: ' + q(key) + ' has no forward() in its class body, so the line was not checked');
        }
      }
      if (x.d !== undefined) {
        if (typeof x.d !== 'string' || !x.d.trim()) err(w + '.d must be a non-empty string');
        else {
          if (x.d.length > FLOW_CAPS.d) err(w + '.d has ' + x.d.length + ' characters (at most ' + FLOW_CAPS.d + ')');
          if (CONTROL.test(x.d)) err(w + '.d holds a control character');
          edge.d = clean(x.d, FLOW_CAPS.d) || null;
        }
      }
      const sig = from.t + ':' + from.v + '>' + to.t + ':' + to.v;
      if (seen.has(sig)) { warn(w + ': the same from and to as an earlier edge; left out'); return; }
      seen.add(sig);
      edges.push(edge);
    });
    for (const o of ops) if (!edges.some((x) => (x.from.t === 'op' && x.from.v === o.id) || (x.to.t === 'op' && x.to.v === o.id))) warn(where + '.ops: ' + q(o.id) + ' is declared but no edge uses it');
    if ((!entries || entries.length) && edges.length) flows.push({ key, cls, file, ops, edges });
  }
  return { flows, errors, warnings };
}

/**
 * The links and virtual nodes of checked flows (checkFlows().flows) for the graph nodes of toGraph(). Every graph node
 * of a repo class with a flow gets it: a folded run is one node (its first member), so its flow is drawn once; an
 * unfolded run draws it for each instance. A file key ("file.py:Class") beats a plain class key. Returns
 * { nodes: virtual nodes, links, flowClasses, warnings }. Link: { a, b, k: "tensor", w: 1, shape: { v, src:
 * "estimate" }, skip?, at?, d? }; a and b are "n:<node id>". Never throws.
 */
export function flowGraph(nodes, flows, { maxLinks = FLOW_CAPS.links } = {}) {
  const warnings = [], links = [], virtual = [];
  if (!Array.isArray(nodes) || !Array.isArray(flows) || !flows.length) return { nodes: virtual, links, flowClasses: 0, warnings };
  const kids = new Map();
  for (const n of nodes) if (isObj(n) && n.parent !== null && n.parent !== undefined && !n.virtual) { if (!kids.has(n.parent)) kids.set(n.parent, []); kids.get(n.parent).push(n); }
  const withFile = flows.filter((x) => x.file !== null), plainKey = flows.filter((x) => x.file === null);
  const pick = (m) => withFile.find((x) => x.cls === m.cls && m.def && typeof m.def.file === 'string' && sameFile(m.def.file, x.file)) || plainKey.find((x) => x.cls === m.cls) || null;
  const reached = new Set(), missing = [];
  let full = false;
  for (const n of nodes) {
    const m = isObj(n) ? n.m : null;
    if (!isObj(m) || n.virtual || m.alias !== undefined || m.ckind !== 'repo') continue;
    const fl = pick(m);
    if (!fl) continue;
    // a direct child by its attribute name: the card's label, or the last part of its path (a folded run's first member)
    const child = new Map();
    for (const c of kids.get(n.id) || []) child.set(String(c.label), c.id);
    for (const c of kids.get(n.id) || []) { const seg = String(c.id).split('.').pop().replace(/~+$/, ''); if (!child.has(seg)) child.set(seg, c.id); }
    const made = new Map();
    const vnode = (end) => {
      const id = n.id + '#' + end.v;
      if (!made.has(id)) {
        const op = end.t === 'op' ? fl.ops.find((o) => o.id === end.v) : null;
        made.set(id, {
          id, parent: n.id, label: op ? op.label : end.v, kind: op ? 'op' : 'io', summary: op ? opText(op) : IO_TEXT[end.v], details: '',
          tags: [], paths: [], packages: [], hosts: [], stats: { files: 0, loc: 0 }, virtual: true, ...(op ? { op: { id: op.id, op: op.op } } : { io: end.v }),
        });
      }
      return id;
    };
    const before = links.length;
    for (const e of fl.edges) {
      if (links.length >= maxLinks) { full = true; break; }
      const ca = e.from.t === 'child' ? child.get(e.from.v) : null, cb = e.to.t === 'child' ? child.get(e.to.v) : null;
      if (ca === undefined || cb === undefined) { if (missing.length < 5) missing.push(q(fl.key) + ' at ' + q(n.id) + ': no child ' + q(ca === undefined ? e.from.v : e.to.v)); continue; }
      const a = ca === null ? vnode(e.from) : ca, b = cb === null ? vnode(e.to) : cb;
      const l = { a: 'n:' + a, b: 'n:' + b, k: 'tensor', w: 1, shape: { v: e.shape, src: 'estimate' } };
      if (e.skip) l.skip = true;
      if (e.at) l.at = e.at;
      if (e.d) l.d = e.d;
      links.push(l);
    }
    // in first, then the ops in the order they are declared, then out: the order the layout starts from
    const rank = (v) => (v.io === 'in' ? -1 : v.io === 'out' ? 1e6 : fl.ops.findIndex((o) => o.id === v.op.id));
    virtual.push(...[...made.values()].sort((x, y) => rank(x) - rank(y)));
    if (links.length > before) reached.add(fl.key);
    if (full) break;
  }
  if (full) warnings.push('flows: the graph holds at most ' + maxLinks + ' flow links; the rest are left out');
  for (const s of missing) warnings.push('flows: ' + s + ' in this instance; that edge is left out there');
  return { nodes: virtual, links, flowClasses: reached.size, warnings };
}
