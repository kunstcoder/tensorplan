// modelmap yaml.mjs: a small YAML reader for model config files. Written for modelmap (not copied).
//
// parseYaml(text, { lines }) returns { value } or { error, line } (line is 1-based, 0 when not tied to a line).
// With opts.lines = true it returns { value, lines }: lines MIRRORS value. A map gives an object with the same
// keys, a list gives an array of the same length, and every scalar leaf gives the 1-based line it was written on.
//   value { model: { dim: 192, heads: [3, 6] } }  ->  lines { model: { dim: 4, heads: [5, 5] } }
//
// It reads: block maps by indentation, block lists ("- x", lists of maps), flow lists [a, b] and flow maps
// {a: 1} on ONE line, scalars (YAML 1.2 core: ints, floats, true/false, null and ~, quoted strings with
// basic escapes, plain strings), comments and blank lines. Map keys are always strings. A repeated key: the
// last one wins (as PyYAML does).
// It STOPS with an error at: anchors and aliases (&x *x), tags (!x !!x), a second document (--- or ...),
// block scalars (| >), merge keys (<<), tabs in indentation, flow collections that span lines and
// multi-line plain scalars. Limits: nesting depth 32, input 1 MB. Every loop walks the text once and the
// regexes are anchored with no nested quantifiers, so a long line cannot make it backtrack.

const MAX_DEPTH = 32;
const MAX_CHARS = 1024 * 1024;

class YamlStop extends Error {
  constructor(line, msg) { super(msg); this.line = line; }
}

/** Set a key without touching the prototype (a key named __proto__ stays a plain key). */
function put(obj, k, v) {
  Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
}

/** Cut a trailing comment. A quote opens only at the start of a token, so "don't" stays plain text. */
function stripComment(s, n) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === '"') { if (c === '\\') i++; else if (c === '"') q = null; continue; }
    if (q === "'") { if (c === "'") { if (s[i + 1] === "'") i++; else q = null; } continue; }
    const prev = i === 0 ? ' ' : s[i - 1];
    if ((c === '"' || c === "'") && ' \t[{,:-'.includes(prev)) q = c;
    else if (c === '#' && (prev === ' ' || prev === '\t')) return s.slice(0, i);
    else if (c === '#' && i === 0) return '';
  }
  return s;
}

const INT = /^[-+]?[0-9]+$/;
const HEX = /^0x[0-9a-fA-F]+$/;
const OCT = /^0o[0-7]+$/;
const FLOAT = /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/;

/** A plain scalar: null, bool, number or string (YAML 1.2 core schema). */
function plainScalar(s, n) {
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (s.length < 400) {
    if (INT.test(s)) return Number(s);
    if (HEX.test(s)) return parseInt(s.slice(2), 16);
    if (OCT.test(s)) return parseInt(s.slice(2), 8);
    if (FLOAT.test(s)) return Number(s);
  }
  if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) return s[0] === '-' ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(s)) return NaN;
  const c = s[0];
  if (c === '&' || c === '*') throw new YamlStop(n, 'anchors and aliases (' + c + ') are not read');
  if (c === '!') throw new YamlStop(n, 'tags (!) are not read');
  if (c === '|' || c === '>') throw new YamlStop(n, 'block scalars (' + c + ') are not read');
  if (c === '@' || c === '\x60' || c === '%') throw new YamlStop(n, 'a plain value cannot start with ' + c);
  if (s.includes(': ') || s.endsWith(':')) throw new YamlStop(n, 'a map inside a plain value on one line');
  return s;
}

const ESC = { '0': '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0' };

/** A quoted string that starts at s[i]. Returns [value, index after the closing quote]. */
function quoted(s, i, n) {
  const q = s[i];
  let out = '';
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (q === "'") {
      if (c !== "'") { out += c; continue; }
      if (s[j + 1] === "'") { out += "'"; j++; continue; }
      return [out, j + 1];
    }
    if (c === '"') return [out, j + 1];
    if (c !== '\\') { out += c; continue; }
    const e = s[++j];
    if (e in ESC) { out += ESC[e]; continue; }
    const len = e === 'x' ? 2 : e === 'u' ? 4 : e === 'U' ? 8 : 0;
    const hex = s.slice(j + 1, j + 1 + len);
    if (!len || hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) throw new YamlStop(n, 'unknown escape \\' + (e ?? ''));
    const cp = parseInt(hex, 16);
    if (cp > 0x10ffff) throw new YamlStop(n, 'escape out of range');
    out += String.fromCodePoint(cp);
    j += len;
  }
  throw new YamlStop(n, 'a quoted string must end on its line');
}

/** One-line flow collections and flow scalars. */
function flow(s, n, depth) {
  let i = 0;
  const ws = () => { while (s[i] === ' ' || s[i] === '\t') i++; };
  const node = (d, inMap) => {
    if (d > MAX_DEPTH) throw new YamlStop(n, 'nested deeper than ' + MAX_DEPTH);
    ws();
    const c = s[i];
    if (c === '[' || c === '{') {
      const isMap = c === '{', close = isMap ? '}' : ']';
      const val = isMap ? {} : [], lin = isMap ? {} : [];
      i++;
      ws();
      if (s[i] === close) { i++; return [val, lin]; }
      for (;;) {
        if (i >= s.length) throw new YamlStop(n, 'a flow collection must end on its line');
        if (isMap) {
          ws();
          const k = s[i] === '"' || s[i] === "'" ? (() => { const [v, j] = quoted(s, i, n); i = j; return v; })() : plain(true);
          if (k === '<<') throw new YamlStop(n, 'merge keys (<<) are not read');
          ws();
          let v = null, l = n;
          if (s[i] === ':') { i++; [v, l] = node(d + 1, true); }
          put(val, String(k), v); put(lin, String(k), l);
        } else {
          const [v, l] = node(d + 1, false);
          val.push(v); lin.push(l);
        }
        ws();
        if (s[i] === ',') { i++; ws(); if (s[i] === close) { i++; return [val, lin]; } continue; }
        if (s[i] === close) { i++; return [val, lin]; }
        if (i >= s.length) throw new YamlStop(n, 'a flow collection must end on its line');
        throw new YamlStop(n, 'unexpected ' + JSON.stringify(s[i]) + ' in a flow collection');
      }
    }
    if (c === '"' || c === "'") { const [v, j] = quoted(s, i, n); i = j; return [v, n]; }
    return [plainScalar(plain(inMap), n), n];
  };
  // a plain scalar inside a flow collection ends at , [ ] { } and, for keys, at ": "
  const plain = (key) => {
    const start = i;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === ',' || c === '[' || c === ']' || c === '{' || c === '}') break;
      if (key && c === ':' && (i + 1 >= s.length || ' ,]}'.includes(s[i + 1]))) break;
    }
    return s.slice(start, i).trim();
  };
  const out = node(depth, false);
  ws();
  if (i < s.length) throw new YamlStop(n, 'text after a flow collection');
  return out;
}

/** A value written after "key:" or "- " on the same line. Returns [value, lines]. */
function inline(s, n, depth) {
  const c = s[0];
  if (c === '[' || c === '{') return flow(s, n, depth);
  if (c === '"' || c === "'") {
    const [v, j] = quoted(s, 0, n);
    if (s.slice(j).trim()) throw new YamlStop(n, 'text after a quoted string');
    return [v, n];
  }
  return [plainScalar(s, n), n];
}

/** The index of the ":" that ends a map key, or -1 when the line is not "key: value". */
function keyColon(t) {
  let i = 0;
  if (t[0] === '"' || t[0] === "'") {
    try { i = quoted(t, 0, 0)[1]; } catch { return -1; }
    while (t[i] === ' ') i++;
    return t[i] === ':' && (i + 1 === t.length || t[i + 1] === ' ') ? i : -1;
  }
  if (t[0] === '[' || t[0] === '{') return -1;
  for (; i < t.length; i++) if (t[i] === ':' && (i + 1 === t.length || t[i + 1] === ' ' || t[i + 1] === '\t')) return i;
  return -1;
}

const isItem = (t) => t === '-' || t.startsWith('- ');

export function parseYaml(text, opts = {}) {
  if (typeof text !== 'string') return { error: 'not text', line: 0 };
  if (text.length > (opts.maxChars || MAX_CHARS)) return { error: 'larger than 1 MB', line: 0 };
  const L = [];
  const raw = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let content = false;
  try {
    for (let k = 0; k < raw.length; k++) {
      const n = k + 1, s = raw[k];
      let ind = 0;
      while (s[ind] === ' ') ind++;
      if (s[ind] === '\t' && stripComment(s.slice(ind), n).trim()) throw new YamlStop(n, 'tabs cannot indent YAML');
      const t = stripComment(s.slice(ind), n).trimEnd();
      if (!t.trim()) continue;
      if (ind === 0 && (t === '---' || t.startsWith('--- ') || t === '...' || t.startsWith('... '))) {
        if (content || t[0] === '.' || t.length > 3) throw new YamlStop(n, 'a second document (' + t.slice(0, 3) + ') is not read');
        continue;
      }
      if (ind === 0 && t[0] === '%') throw new YamlStop(n, 'directives (%) are not read');
      content = true;
      L.push({ n, ind, t });
    }
    let pos = 0;
    const block = (ind, depth) => {
      if (depth > MAX_DEPTH) throw new YamlStop(L[pos].n, 'nested deeper than ' + MAX_DEPTH);
      const { t, n } = L[pos];
      if (isItem(t)) return seq(ind, depth);
      if (keyColon(t) >= 0) return map(ind, depth);
      const r = inline(t, n, depth);
      pos++;
      return r;
    };
    const after = (ind) => {
      if (pos < L.length && L[pos].ind > ind) throw new YamlStop(L[pos].n, 'unexpected indentation (a value cannot go on over several lines)');
    };
    const seq = (ind, depth) => {
      const val = [], lin = [];
      while (pos < L.length && L[pos].ind === ind && isItem(L[pos].t)) {
        const { t, n } = L[pos];
        const rest = t.slice(1).replace(/^ +/, '');
        let r;
        if (!rest) {
          pos++;
          r = pos < L.length && L[pos].ind > ind ? block(L[pos].ind, depth + 1) : [null, n];
        } else {
          // the text after "- " is a line of its own, at the column where it starts
          L[pos] = { n, ind: ind + (t.length - rest.length), t: rest };
          r = block(L[pos].ind, depth + 1);
        }
        val.push(r[0]); lin.push(r[1]);
        after(ind);
      }
      return [val, lin];
    };
    const map = (ind, depth) => {
      const val = {}, lin = {};
      while (pos < L.length && L[pos].ind === ind && !isItem(L[pos].t)) {
        const { t, n } = L[pos];
        const ci = keyColon(t);
        if (ci < 0) throw new YamlStop(n, 'expected "key: value"');
        const kt = t.slice(0, ci).trim();
        let key;
        if (kt[0] === '"' || kt[0] === "'") key = quoted(kt, 0, n)[0];
        else {
          if (kt === '<<') throw new YamlStop(n, 'merge keys (<<) are not read');
          if (/^[&*!|>@%\x60?]/.test(kt)) throw new YamlStop(n, 'a key cannot start with ' + kt[0]);
          key = kt;
        }
        const rest = t.slice(ci + 1).trim();
        let r;
        pos++;
        if (!rest) {
          if (pos < L.length && L[pos].ind > ind) r = block(L[pos].ind, depth + 1);
          else if (pos < L.length && L[pos].ind === ind && isItem(L[pos].t)) r = seq(ind, depth + 1);
          else r = [null, n];
        } else r = inline(rest, n, depth + 1);
        put(val, key, r[0]); put(lin, key, r[1]);
        after(ind);
      }
      return [val, lin];
    };
    if (!L.length) return opts.lines ? { value: null, lines: 0 } : { value: null };
    const [value, lines] = block(L[0].ind, 0);
    if (pos < L.length) throw new YamlStop(L[pos].n, 'unexpected indentation or a second value');
    return opts.lines ? { value, lines } : { value };
  } catch (e) {
    if (e instanceof YamlStop) return { error: e.message, line: e.line };
    if (e instanceof RangeError) return { error: 'nested too deep', line: 0 };
    throw e;
  }
}
