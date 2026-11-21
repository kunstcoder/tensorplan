// modelmap safetensors.mjs: read the headers of safetensors weight files and check them against the scan tree.
// Written for modelmap. Only the header is read (8 bytes of size, then JSON); no tensor data is read.
//
// readHeader(file)        -> { name: { dtype, shape, data_offsets } } (__metadata__ dropped). Throws SafetensorsError.
// readWeights(paths)      -> { files, tensors: { name: { dtype, shape, numel, bytes, file } }, errors, notes }
//                            a path is a .safetensors file, a model.safetensors.index.json or a folder (read
//                            non-recursively). Pickle checkpoints (.pt .pth .bin .ckpt .pkl) are skipped.
// expectKeys(tree)        -> the state_dict keys the scan tree implies (call it BEFORE annotate(), which
//                            replaces node.params, the list of direct nn.Parameter, with the count).
// crossCheck(tree, w, { expected }) sets node.check and node.weights, returns the summary for scan.weights.
import fs from 'node:fs';
import path from 'node:path';
import { layerKeys, Unknown } from './layers.mjs';

export class SafetensorsError extends Error {}

export const MAX_HEADER = 100 * 1024 * 1024;
export const MAX_TENSORS = 100000;
const MAX_JSON_DEPTH = 16;
const MAX_INDEX = 50 * 1024 * 1024;
export const PICKLE_EXT = ['.pt', '.pth', '.bin', '.ckpt', '.pkl'];

export const DTYPE_BYTES = { F64: 8, F32: 4, F16: 2, BF16: 2, I64: 8, I32: 4, I16: 2, I8: 1, U8: 1, BOOL: 1, F8_E4M3: 1, F8_E5M2: 1 };
/** Bytes per element of a dtype, or null when the dtype is not known. */
export const dtypeBytes = (dtype) => (Object.prototype.hasOwnProperty.call(DTYPE_BYTES, dtype) ? DTYPE_BYTES[dtype] : null);
/** Number of elements of a shape ([] is a scalar: 1). */
export const numel = (shape) => shape.reduce((s, x) => s * x, 1);

const fail = (file, msg) => { throw new SafetensorsError(path.basename(file) + ': ' + msg); };
const isInt = (x) => Number.isSafeInteger(x) && x >= 0;

/** Nesting depth of a JSON text, counted in one pass (strings skipped), so a bomb is refused before parsing. */
function jsonDepth(buf, limit) {
  let d = 0, inStr = false;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (inStr) { if (c === 0x5c) i++; else if (c === 0x22) inStr = false; continue; }
    if (c === 0x22) inStr = true;
    else if (c === 0x5b || c === 0x7b) { if (++d > limit) return d; }
    else if (c === 0x5d || c === 0x7d) d--;
  }
  return d;
}

export function readHeader(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { fail(file, 'cannot open (' + e.code + ')'); }
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 8) fail(file, 'too short to be a safetensors file');
    const len = Buffer.alloc(8);
    fs.readSync(fd, len, 0, 8, 0);
    const big = len.readBigUInt64LE(0);                       // header size in bytes
    if (big > BigInt(MAX_HEADER)) fail(file, 'header size ' + big + ' is larger than 100 MiB (a hostile or broken file)');
    const n = Number(big);
    if (n > size - 8) fail(file, 'header size ' + n + ' is larger than the file (' + size + ' bytes): the file is cut short');
    if (n < 2) fail(file, 'header is empty');
    const buf = Buffer.alloc(n);
    if (fs.readSync(fd, buf, 0, n, 8) !== n) fail(file, 'could not read the whole header');
    if (jsonDepth(buf, MAX_JSON_DEPTH) > MAX_JSON_DEPTH) fail(file, 'header JSON is nested deeper than ' + MAX_JSON_DEPTH);
    let head;
    try { head = JSON.parse(buf.toString('utf8')); } catch (e) { fail(file, 'header is not valid JSON (' + String(e.message).slice(0, 80) + ')'); }
    if (!head || typeof head !== 'object' || Array.isArray(head)) fail(file, 'header is not a JSON object');
    const dataLen = size - 8 - n;
    const out = {};
    let count = 0;
    for (const name of Object.keys(head)) {
      if (name === '__metadata__') continue;
      if (++count > MAX_TENSORS) fail(file, 'more than ' + MAX_TENSORS + ' tensors');
      const t = head[name];
      const where = 'tensor ' + JSON.stringify(name.slice(0, 80));
      if (!t || typeof t !== 'object' || Array.isArray(t)) fail(file, where + ' is not an object');
      if (typeof t.dtype !== 'string') fail(file, where + ': dtype is not a string');
      if (!Array.isArray(t.shape) || t.shape.length > 64 || !t.shape.every(isInt)) fail(file, where + ': shape is not a list of integers >= 0');
      const o = t.data_offsets;
      if (!Array.isArray(o) || o.length !== 2 || !isInt(o[0]) || !isInt(o[1]) || o[0] > o[1]) fail(file, where + ': data_offsets is not two integers a <= b');
      if (o[1] > dataLen) fail(file, where + ': data_offsets point past the end of the file');
      const ne = numel(t.shape);
      if (!Number.isSafeInteger(ne)) fail(file, where + ': shape is too large');
      const bs = dtypeBytes(t.dtype);
      if (bs !== null && ne * bs !== o[1] - o[0]) fail(file, where + ': shape ' + JSON.stringify(t.shape) + ' and ' + t.dtype + ' need ' + ne * bs + ' bytes, data_offsets give ' + (o[1] - o[0]));
      Object.defineProperty(out, name, { value: { dtype: t.dtype, shape: t.shape.slice(), data_offsets: [o[0], o[1]] }, enumerable: true, writable: true, configurable: true });
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** The shard names of a model.safetensors.index.json, all in the same folder. Throws SafetensorsError. */
export function readIndex(file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { fail(file, 'cannot open (' + e.code + ')'); }
  if (st.size > MAX_INDEX) fail(file, 'index is larger than 50 MiB');
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { fail(file, 'index is not valid JSON'); }
  const wm = j && j.weight_map;
  if (!wm || typeof wm !== 'object' || Array.isArray(wm)) fail(file, 'index has no weight_map object');
  const shards = new Set();
  const map = {};
  let count = 0;
  for (const [k, v] of Object.entries(wm)) {
    if (++count > MAX_TENSORS) fail(file, 'index names more than ' + MAX_TENSORS + ' tensors');
    if (typeof v !== 'string' || !v || v.includes('/') || v.includes('\\') || v.includes('..') || v.includes('\0') || path.basename(v) !== v)
      fail(file, 'index names a shard outside its folder: ' + JSON.stringify(String(v).slice(0, 80)));
    shards.add(v);
    map[k] = v;
  }
  return { shards: [...shards].sort(), map };
}

function addTensors(acc, header, label) {
  for (const [name, t] of Object.entries(header)) {
    if (Object.prototype.hasOwnProperty.call(acc.tensors, name)) { acc.notes.push(name + ' is in more than one file; the one in ' + label + ' is used'); }
    const bs = dtypeBytes(t.dtype);
    const ne = numel(t.shape);
    Object.defineProperty(acc.tensors, name, { value: { dtype: t.dtype, shape: t.shape, numel: ne, bytes: bs === null ? null : ne * bs, file: label }, enumerable: true, writable: true, configurable: true });
    if (bs === null && !acc.notes.some((x) => x.startsWith('dtype ' + t.dtype + ' '))) acc.notes.push('dtype ' + t.dtype + ' is not known; its bytes are not counted');
  }
}

/** Read every weights path named. Errors are collected, never thrown. */
export function readWeights(paths) {
  const acc = { files: [], tensors: {}, errors: [], notes: [], skipped: [] };
  const readOne = (file, label) => {
    try { addTensors(acc, readHeader(file), label); acc.files.push(label); } catch (e) { if (!(e instanceof SafetensorsError)) throw e; acc.errors.push(e.message); }
  };
  const readIdx = (file) => {
    try {
      const { shards, map } = readIndex(file);
      const dir = path.dirname(file);
      const before = acc.files.length;
      for (const s of shards) readOne(path.join(dir, s), s);
      acc.files.splice(before, 0, path.basename(file));
      const missing = Object.entries(map).filter(([k, s]) => acc.tensors[k]?.file !== s).length;
      if (missing) acc.notes.push(missing + ' tensors of the index are not in the shard it names');
    } catch (e) { if (!(e instanceof SafetensorsError)) throw e; acc.errors.push(e.message); }
  };
  for (const p of paths) {
    const ext = path.extname(p).toLowerCase();
    if (PICKLE_EXT.includes(ext)) { acc.skipped.push(p); continue; }
    let st;
    try { st = fs.statSync(p); } catch { acc.errors.push(p + ': not found'); continue; }
    if (st.isDirectory()) {
      const names = fs.readdirSync(p).sort();
      const idx = names.filter((f) => f.endsWith('.safetensors.index.json'));
      for (const f of names) if (PICKLE_EXT.includes(path.extname(f).toLowerCase())) acc.skipped.push(path.join(p, f));
      if (idx.length) { for (const f of idx) readIdx(path.join(p, f)); continue; }
      const files = names.filter((f) => f.endsWith('.safetensors'));
      if (!files.length) acc.errors.push(p + ': no .safetensors file in this folder');
      for (const f of files) readOne(path.join(p, f), f);
    } else if (p.endsWith('.json')) readIdx(p);
    else readOne(p, path.basename(p));
  }
  return acc;
}

// ---------- expected keys ----------

const join = (a, b) => (a ? a + '.' + b : b);

/**
 * Map path -> { own: [{ key, shape, buffer? }] | null (not known), why? } for every non-alias node, plus
 * ties and aliases. Call before annotate(): it reads node.params as the list of direct nn.Parameter.
 */
export function expectKeys(tree) {
  const nodes = new Map(), ties = [], aliases = [];
  const walk = (n) => {
    const p = n.path || '';
    if (n.alias !== undefined) { aliases.push({ path: p, of: n.alias }); return; }
    let own = null, why;
    try {
      if (n.kind === 'torch') own = layerKeys(n.cls, n.pos || [], n.kw || {});
      else if (n.kind === 'repo') {
        if (n.incomplete) throw new Unknown('part of the constructor was skipped');
        own = [];
        for (const prm of Array.isArray(n.params) ? n.params : []) {
          if (!Array.isArray(prm.shape) || !prm.shape.every((d) => Number.isInteger(d) && d >= 0)) throw new Unknown('the shape of ' + prm.name + ' is not known');
          own.push({ key: prm.name, shape: prm.shape });
        }
        if (n.baseLayer) own.push(...layerKeys(n.baseLayer.cls, n.baseLayer.pos || [], n.baseLayer.kw || {}));
      } else throw new Unknown(n.why || 'the module is not known');
    } catch (e) { if (!(e instanceof Unknown)) throw e; own = null; why = e.message; }
    nodes.set(p, { own, why });
    for (const k of Object.keys(n.tied || {})) if (typeof n.tied[k] === 'string' && n.tied[k] !== '?') ties.push([join(p, k), join(n.tied[k], k)]);
    for (const c of n.children || []) walk(c);
  };
  walk(tree);
  return { nodes, ties, aliases };
}

// ---------- the check ----------

const shapeEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const under = (key, p) => !p || key === p || key.startsWith(p + '.');

/**
 * Compare the file's tensors with the keys the tree implies. Sets node.check (only on nodes with an
 * expectation) and node.weights (on nodes with a tensor under their path). node.params is not touched.
 */
export function crossCheck(tree, weights, { expected } = {}) {
  const exp = expected || expectKeys(tree);
  const T = weights.tensors;
  const has = (k) => Object.prototype.hasOwnProperty.call(T, k);
  const twin = new Map();
  for (const [a, b] of exp.ties) { twin.set(a, b); twin.set(b, a); }
  // keys under an alias path are copies of the keys under the first path
  const aliasOf = (k) => { for (const a of exp.aliases) if (under(k, a.path)) return a.of + k.slice(a.path.length); return null; };
  const expectedKey = new Map();
  for (const [p, e] of exp.nodes) for (const x of e.own || []) expectedKey.set(join(p, x.key), x);
  // a copy is a tensor that the file stores twice (a tied twin, or a key under an alias path): count it once
  // (of a tie, the copy is the key of the layer that took the other's weight: its code count is already 0)
  const copy = new Set();
  for (const [a, b] of exp.ties) if (has(a) && has(b)) copy.add(a);
  for (const k of Object.keys(T)) { const al = aliasOf(k); if (al !== null && (has(al) || expectedKey.has(al))) copy.add(k); }
  const unmatched = Object.keys(T).filter((k) => !expectedKey.has(k) && !copy.has(k) && aliasOf(k) === null);
  // what the file holds under each path, in one pass over the keys (buffers of known layers and copies are not parameters)
  const byPath = new Map();
  for (const k of Object.keys(T)) {
    if (copy.has(k) || expectedKey.get(k)?.buffer) continue;
    const t = T[k], segs = k.split('.');
    for (let i = 0; i < segs.length; i++) {
      const pre = i === 0 ? '' : segs.slice(0, i).join('.');
      let w = byPath.get(pre);
      if (!w) byPath.set(pre, (w = { params: 0, bytes: 0, dtypes: {}, keys: 0 }));
      w.params += t.numel;
      w.bytes = w.bytes === null || t.bytes === null ? null : w.bytes + t.bytes;
      w.dtypes[t.dtype] = (w.dtypes[t.dtype] || 0) + t.numel;
      w.keys++;
    }
  }
  let matchedModules = 0, differModules = 0, unchecked = 0;
  const problems = [];
  const visit = (n) => {
    const p = n.path || '';
    if (n.alias !== undefined) return null;
    const e = exp.nodes.get(p) || { own: null };
    const agg = { expected: 0, found: 0, missing: [], mismatched: [], known: e.own !== null, partial: e.own === null, files: [] };
    if (e.own) {
      let ownBad = false, ownExpected = 0;
      for (const x of e.own) {
        const k = join(p, x.key);
        if (x.buffer) continue;
        agg.expected++; ownExpected++;
        const t = has(k) ? T[k] : twin.has(k) && has(twin.get(k)) ? T[twin.get(k)] : null;
        if (!t) { agg.missing.push(k); ownBad = true; problems.push(k + ': missing'); continue; }
        agg.files.push(t.file);
        if (!shapeEq(t.shape, x.shape)) { agg.mismatched.push({ key: k, expected: x.shape, found: t.shape }); ownBad = true; problems.push(k + ': expected ' + JSON.stringify(x.shape) + ' found ' + JSON.stringify(t.shape)); }
        else agg.found++;
      }
      if (ownExpected) ownBad ? differModules++ : matchedModules++;
    } else unchecked++;
    for (const c of n.children || []) {
      const r = visit(c);
      if (!r) continue;
      agg.expected += r.expected; agg.found += r.found;
      agg.missing.push(...r.missing); agg.mismatched.push(...r.mismatched);
      agg.known = agg.known || r.known; agg.partial = agg.partial || r.partial;
      agg.files.push(...r.files);
    }
    const w = byPath.get(p);
    if (w) n.weights = { params: w.params, bytes: w.bytes, dtypes: { ...w.dtypes }, keys: w.keys };
    if (agg.known) {
      n.check = {
        ok: agg.missing.length === 0 && agg.mismatched.length === 0,
        file: agg.files[0] || weights.files[0] || null,
        expectedKeys: agg.expected, foundKeys: agg.found,
        missing: agg.missing.slice(0, 5), mismatched: agg.mismatched.slice(0, 5),
        codeParams: n.params && !Array.isArray(n.params) ? n.params.v : null,
        weightParams: n.weights ? n.weights.params : 0,
        ...(agg.partial ? { partial: true } : {}),
      };
    }
    return agg;
  };
  // nothing read: there is nothing to check against, so no node gets a check
  if (weights.files.length) visit(tree);
  let totalParams = 0, bytes = 0;
  for (const t of Object.values(T)) { totalParams += t.numel; bytes = bytes === null || t.bytes === null ? null : bytes + t.bytes; }
  return {
    files: weights.files.slice(), tensors: Object.keys(T).length, totalParams, bytes,
    unmatchedKeys: unmatched.length, unmatchedSample: unmatched.slice(0, 5),
    matchedModules, differModules, uncheckedModules: unchecked, problems: problems.slice(0, 20),
    ...(weights.errors?.length ? { errors: weights.errors.slice(0, 10) } : {}),
    ...(weights.notes?.length ? { notes: weights.notes.slice(0, 10) } : {}),
    ...(weights.skipped?.length ? { skipped: weights.skipped.slice() } : {}),
  };
}
