// modelmap lib/contract.mjs: the input and output contract of the model (plan claim 3, F06). Written for modelmap.
//
// buildContract(scan, descriptions, warnings) turns what pyscan.py read from the root's forward() (the signature,
// the docstring, the keys of the returned dict) and the dimension names it saw (the root's arguments, the fields of
// the config it was given, module attributes, floor divisions in the code) into graph.contract:
//   { forward: { file, line, owner }, inputs: [...], output: {...}, dims: [...] }
// (see references/schema.md). Facts read from the code are exact. A shape is shown only when the repo's docstring
// gives it (src "doc") or Claude wrote it in descriptions/*.json from reading forward (src "estimate");
// everything else is unknown (v null), never guessed. Untrusted repo text is data: it is cut to size here and
// escaped by the page.
//
// DIM_TABLE is FIXED: a dimension symbol exists only for these argument or attribute names. A dims entry exists
// only when the root arguments (or the fields of the config object the root was given) or a module attribute
// carry that name with a number. The first name found wins (root arguments in their order, then attributes in
// tree order); other names for the same symbol are listed in expr ("also: hidden_dim"). d_h = D // H is added only
// when no head_dim value was found, D and H exist, and the code divides the two names (a floor division of a D name
// by an H name, or an assignment to an attribute head_dim). No other dimension is ever computed.
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const has = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);

export const DIM_TABLE = [
  ['D', ['dim', 'hidden_dim', 'hidden_size', 'd_model', 'embed_dim', 'n_embd']],
  ['H', ['num_heads', 'n_head', 'n_heads', 'heads']],
  ['d_h', ['head_dim', 'dim_head']],
  ['L', ['depth', 'n_layer', 'num_layers', 'num_blocks']],
  ['V', ['vocab_size']],
  ['T', ['block_size', 'max_seq_len', 'max_len']],
  ['C', ['num_classes']],
  ['C_in', ['in_channels']],
  ['P', ['patch_size']],
  ['S', ['image_size']],
];
/** Every name of the table, and the symbol of each. scan.mjs passes DIM_NAMES to pyscan.py (job "dimNames"). */
export const DIM_NAMES = DIM_TABLE.flatMap(([, names]) => names);
const SYMBOL_OF = new Map(DIM_TABLE.flatMap(([sym, names]) => names.map((n) => [n, sym])));
export const symbolOf = (name) => SYMBOL_OF.get(String(name)) || null;
/** Attribute names whose assignment anywhere in the repo shows that the code splits D into heads. */
export const HEAD_DIM_ATTRS = DIM_TABLE.find(([s]) => s === 'd_h')[1];
/** Symbols that appear only in shapes: the batch and the sequence (token) count. */
export const SHAPE_ONLY = ['B', 'N'];
const BATCH_WORDS = ['batch', 'batch_size', 'bs', 'b', 'nb'];
const SEQ_WORDS = ['seq', 'seqlen', 'seq_len', 'sequence_length', 'num_tokens', 'tokens', 'n', 'length'];
const TABLE_SYMBOLS = new Set([...DIM_TABLE.map(([s]) => s), ...SHAPE_ONLY]);

/** Length caps of the contract's text fields (characters). */
export const CAPS = { name: 80, type: 120, default: 80, doc: 200, d: 400, shape: 40, expr: 80, key: 80 };
export const MAX_KEYS = 64;

const cut = (s, n) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n - 1) + '…' : s) : null);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------- shapes ----------
/** The symbol for one word of a docstring shape, or null: integers, "...", the symbols themselves, batch and
 *  sequence words (B, N), and the names of DIM_TABLE. */
export function wordSymbol(w) {
  const s = String(w);
  if (/^\d+$/.test(s) || s === '...') return s;
  if (TABLE_SYMBOLS.has(s)) return s;
  const low = s.toLowerCase();
  if (BATCH_WORDS.includes(low)) return 'B';
  if (SEQ_WORDS.includes(low)) return 'N';
  return SYMBOL_OF.get(low) || null;
}

/** A docstring shape hint (a list of words from pyscan.py) as { v, src: "doc", why? }. */
export function docShape(words) {
  if (!Array.isArray(words) || !words.length) return { v: null, src: 'doc', why: 'no shape in the docstring' };
  const syms = words.map(wordSymbol);
  const bad = words.filter((w, i) => syms[i] === null).map(String);
  if (bad.length) return { v: null, src: 'doc', why: 'the docstring shape uses ' + cut(bad.slice(0, 3).join(', '), 60) + ', not in the dimension table' };
  const v = '[' + syms.join(', ') + ']';
  return v.length > CAPS.shape ? { v: null, src: 'doc', why: 'the docstring shape is too long' } : { v, src: 'doc' };
}

/**
 * Check a shape string Claude wrote (an estimate). symbols: the symbols allowed (the dims table's plus B and N).
 * Returns { v } (spaces normalised) or { error }. Allowed: at most 40 characters; a bracketed, comma separated
 * list (brackets may nest) of integers, "...", allowed symbols, and B or N with a subscript (N_s, B_q).
 */
export function checkShape(s, symbols) {
  if (typeof s !== 'string') return { error: 'a shape must be a string' };
  const t = s.trim().replace(/\s+/g, ' ');
  if (!t) return { error: 'the shape is empty' };
  if (t.length > CAPS.shape) return { error: 'the shape has ' + t.length + ' characters (at most ' + CAPS.shape + ')' };
  if (!/^[A-Za-z0-9_,\[\] .]+$/.test(t)) return { error: 'the shape may hold only symbols, digits, commas, spaces, brackets, "..." and underscores' };
  if (!t.startsWith('[') || !t.endsWith(']')) return { error: 'the shape must be a bracketed list, e.g. [B, N, D]' };
  let depth = 0;
  for (const ch of t) { if (ch === '[') depth++; else if (ch === ']' && --depth < 0) break; }
  if (depth !== 0) return { error: 'the brackets of the shape do not match' };
  const allowed = new Set([...(symbols || []), ...SHAPE_ONLY]);
  const tokens = t.split(/[\[\],]/).map((x) => x.trim());
  // empty pieces only next to brackets ("[", "]", "],"), never between two commas
  if (/,\s*,|\[\s*,|,\s*\]/.test(t)) return { error: 'the shape has an empty item' };
  for (const tok of tokens) {
    if (!tok) continue;
    if (/^\d+$/.test(tok) || tok === '...') continue;
    if (allowed.has(tok)) continue;
    const m = /^([BN])_[A-Za-z0-9]+$/.exec(tok);
    if (m) continue;
    return { error: 'the shape uses ' + JSON.stringify(cut(tok, 20)) + ', which is not a symbol of the dimension table (' + [...allowed].join(', ') + ')' };
  }
  return { v: t };
}

// ---------- dimensions ----------
/** The dims table of a scan: [{ sym, name, value, src, at?, expr?, why? }] in DIM_TABLE order. */
export function buildDims(scan) {
  const d = isObj(scan?.dims) ? scan.dims : null;
  if (!d) return [];
  const cands = [];
  const take = (r, from) => {
    if (!isObj(r) || typeof r.name !== 'string') return;
    const sym = symbolOf(r.name);
    if (!sym || !isNum(r.v)) return;
    cands.push({ sym, name: r.name, value: r.v, src: r.src === 'config' ? 'config' : 'code', at: typeof r.at === 'string' ? cut(r.at, 200) : null, expr: typeof r.expr === 'string' ? r.expr : null, from, cls: typeof r.cls === 'string' ? r.cls : null });
  };
  for (const r of Array.isArray(d.args) ? d.args : []) take(r, 'arg');
  for (const r of Array.isArray(d.attrs) ? d.attrs : []) take(r, 'attr');
  const out = [];
  for (const [sym] of DIM_TABLE) {
    const list = cands.filter((c) => c.sym === sym);
    if (!list.length) continue;
    const w = list[0];
    const e = { sym, name: w.name, value: w.value, src: w.src };
    if (w.at) e.at = w.at;
    const exprs = [];
    if (w.from === 'attr' && w.expr && w.expr !== w.name) exprs.push(w.expr);
    const others = [], differ = [];
    for (const c of list.slice(1)) {
      if (c.name === w.name || others.includes(c.name) || differ.some((x) => x.name === c.name)) continue;
      if (c.value === w.value) others.push(c.name); else differ.push(c);
    }
    if (others.length) exprs.push('also: ' + others.join(', '));
    if (exprs.length) e.expr = cut(exprs.join('; '), CAPS.expr);
    if (w.from === 'attr') e.why = 'attribute of ' + cut(w.cls || 'a module', 60);
    if (differ.length) e.why = (e.why ? e.why + '; ' : '') + differ.slice(0, 2).map((c) => c.name + ' = ' + c.value + (c.cls ? ' in ' + cut(c.cls, 40) : '')).join(', ') + ' differ' + (differ.length === 1 ? 's' : '');
    if (e.why) e.why = cut(e.why, 200);
    out.push(e);
  }
  // d_h = D // H, only when the code itself divides the two (or assigns an attribute head_dim) and no value was found
  const D = out.find((x) => x.sym === 'D'), H = out.find((x) => x.sym === 'H');
  if (!out.some((x) => x.sym === 'd_h') && D && H && Number.isInteger(D.value) && Number.isInteger(H.value) && H.value > 0) {
    const divs = (Array.isArray(d.floordiv) ? d.floordiv : []).filter((x) => isObj(x) && symbolOf(x.a) === 'D' && symbolOf(x.b) === 'H');
    const div = divs.find((x) => x.a === D.name && x.b === H.name) || divs[0];
    const set = (Array.isArray(d.assigned) ? d.assigned : []).find((x) => isObj(x) && symbolOf(x.name) === 'd_h');
    if (div || set) {
      // named after what the code has: the attribute it assigns, else the division itself
      const e = { sym: 'd_h', name: cut(set ? String(set.name) : div.a + ' // ' + div.b, CAPS.name), value: Math.floor(D.value / H.value), src: D.src === 'config' || H.src === 'config' ? 'config' : 'code' };
      const at = div ? div.at : set.at;
      if (typeof at === 'string') e.at = cut(at, 200);
      e.expr = cut(div ? div.a + ' // ' + div.b : D.name + ' // ' + H.name, CAPS.expr);
      e.why = 'D // H: the code divides ' + (div ? div.a + ' by ' + div.b : 'into heads (' + set.name + ')') + ' there';
      out.splice(out.findIndex((x) => x.sym === 'H') + 1, 0, e);
    }
  }
  return out;
}

// ---------- estimates from descriptions/*.json ----------
const emptyEstimates = () => ({ inputs: Object.create(null), output: { keys: Object.create(null) } });
const MAX_EST = 2000; // kept while merging; buildContract checks the real caps and warns
const estStr = (o, k) => (has(o, k) && typeof o[k] === 'string' ? o[k].slice(0, MAX_EST) : undefined);
const estEntry = (o) => { const r = {}; for (const k of ['shape', 'd']) { const v = estStr(o, k); if (v !== undefined) r[k] = v; } return r; };

/** Merge the "contract" block of one descriptions file into into (made when null). A later file wins, field by
 *  field. Only strings are kept; buildContract checks them. Returns into. Never throws. */
export function mergeEstimates(into, block) {
  const out = into || emptyEstimates();
  if (!isObj(block)) return out;
  if (isObj(block.inputs)) for (const [k, e] of Object.entries(block.inputs)) if (isObj(e)) out.inputs[k] = { ...(out.inputs[k] || {}), ...estEntry(e) };
  if (isObj(block.output)) {
    const o = block.output;
    for (const k of ['shape', 'd']) { const v = estStr(o, k); if (v !== undefined) out.output[k] = v; }
    if (isObj(o.keys)) for (const [k, e] of Object.entries(o.keys)) if (isObj(e)) out.output.keys[k] = { ...(out.output.keys[k] || {}), ...estEntry(e) };
  }
  return out;
}

// a type that allows None, for scans written before pyscan.py reported nullable
const NULLABLE_TYPE = /\|\s*None\b|\bNone\s*\||^\s*['"]?\s*(typing\.)?Optional\[|^\s*['"]?\s*(typing\.)?Union\[.*\bNone\b/;

/**
 * The contract of a scan, or null when the scan found no forward method. descriptions: the merged descriptions
 * (descriptions.contract from mergeEstimates), or null. warnings: an array that gets a line per estimate dropped.
 */
export function buildContract(scan, descriptions = null, warnings = []) {
  const fw = scan?.forward;
  if (!isObj(fw) || !Array.isArray(fw.params)) return null;
  const warn = (s) => { if (Array.isArray(warnings)) warnings.push('contract: ' + s); };
  const dims = buildDims(scan);
  const symbols = dims.map((x) => x.sym);
  const inputs = fw.params.filter(isObj).map((p) => {
    const ann = typeof p.annotation === 'string' ? p.annotation : null, def = typeof p.default === 'string' ? p.default : null;
    // optional: it has a default (any default), so a caller may leave it out. nullable: its type allows None.
    // A required parameter typed X | None is nullable, not optional.
    // a scan that reports nullable has the new optional rule; an older scan's optional is recomputed from the default
    const optional = typeof p.nullable === 'boolean' && typeof p.optional === 'boolean' ? p.optional : def !== null;
    const nullable = typeof p.nullable === 'boolean' ? p.nullable : !!ann && NULLABLE_TYPE.test(ann);
    return {
      name: cut(String(p.name ?? ''), CAPS.name), type: cut(ann, CAPS.type), default: cut(def, CAPS.default), optional, nullable,
      doc: cut(typeof p.docText === 'string' ? p.docText : null, CAPS.doc), shape: docShape(p.shapeHint),
    };
  });
  const fo = isObj(fw.output) ? fw.output : {};
  const keys = (Array.isArray(fo.keys) ? fo.keys : []).filter((k) => typeof k === 'string').slice(0, MAX_KEYS).map((k) => {
    const e = { name: cut(k, CAPS.key) };
    const hint = isObj(fo.keyShapes) && has(fo.keyShapes, k) ? docShape(fo.keyShapes[k]) : null;
    if (hint && hint.v) e.shape = hint;
    return e;
  });
  const output = { type: cut(typeof fw.returns === 'string' ? fw.returns : null, CAPS.type), doc: cut(typeof fo.docText === 'string' ? fo.docText : null, CAPS.doc), keys };
  if (Number.isInteger(fo.keysMore) && fo.keysMore > 0) output.keysMore = fo.keysMore;
  if (Array.isArray(fo.names) && fo.names.length) output.names = fo.names.filter((x) => typeof x === 'string').slice(0, MAX_KEYS).map((x) => cut(x, CAPS.name));
  if (Array.isArray(fo.shapeHint)) { const s = docShape(fo.shapeHint); if (s.v) output.shape = s; }

  // estimates: a shape fills an unknown one, never replaces a docstring shape; names the code does not have are dropped
  const est = descriptions && isObj(descriptions.contract) ? descriptions.contract : null;
  const apply = (where, target, e, hasDoc) => {
    if (has(e, 'shape')) {
      const c = checkShape(e.shape, symbols);
      if (c.error) warn(where + '.shape dropped: ' + c.error);
      else if (hasDoc) warn(where + '.shape ignored: the docstring gives the shape (' + target.shape.v + ')');
      else target.shape = { v: c.v, src: 'estimate' };
    }
    if (has(e, 'd')) {
      if (typeof e.d === 'string' && e.d.trim()) target.d = cut(e.d.trim(), CAPS.d);
    }
  };
  if (est) {
    for (const [name, e] of Object.entries(isObj(est.inputs) ? est.inputs : {})) {
      const inp = inputs.find((x) => x.name === name);
      if (!inp) { warn('inputs.' + cut(name, 60) + ' dropped: forward() has no input of this name'); continue; }
      apply('inputs.' + name, inp, e, inp.shape.src === 'doc' && inp.shape.v !== null);
    }
    const eo = isObj(est.output) ? est.output : {};
    apply('output', output, eo, !!(output.shape && output.shape.src === 'doc'));
    for (const [k, e] of Object.entries(isObj(eo.keys) ? eo.keys : {})) {
      const key = keys.find((x) => x.name === k);
      if (!key) { warn('output.keys.' + cut(k, 60) + ' dropped: the code returns no key of this name'); continue; }
      apply('output.keys.' + k, key, e, !!(key.shape && key.shape.src === 'doc'));
    }
  }
  return {
    forward: { file: cut(String(fw.file ?? ''), 200), line: Number.isInteger(fw.line) ? fw.line : null, owner: cut(String(fw.owner ?? ''), CAPS.name) },
    inputs, output, dims,
  };
}
