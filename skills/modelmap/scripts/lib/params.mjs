// Parameter totals for a scanned module tree. A total with an unknown part is a lower bound (shown as ≥).
// A module that two paths share counts once: the second path is an alias with zero parameters.
import { layerParams, weightParams, Unknown } from './layers.mjs';

const RANK = { code: 0, config: 1, weights: 2, run: 3 };
/** The weakest source of the parts: a result is only as sure as its least sure part. */
export const weakest = (parts) => parts.reduce((w, p) => (RANK[p.src] < RANK[w] ? p.src : w), 'run');

/** Sum parts: { v, src } or { v: null, why }. One unknown part turns the total into a lower bound. */
export function sum(parts) {
  const known = parts.filter((p) => p.v !== null);
  const total = known.reduce((s, p) => s + p.v, 0);
  const unknown = parts.length - known.length;
  const src = known.length ? weakest(known) : 'code';
  // a part that is itself a lower bound makes the total a lower bound
  if (unknown === 0 && !parts.some((p) => p.lowerBound)) return { v: total, src };
  const why = parts.find((p) => p.why)?.why || (unknown + (unknown === 1 ? ' part is unknown' : ' parts are unknown'));
  return { v: total, src, lowerBound: true, why };
}

// classes of other packages that are known to hold no parameters. Every other outside class stays unknown.
const NO_PARAMS_EXTERNAL = new Set(['einops.layers.torch.Rearrange', 'einops.layers.torch.Reduce', 'einops.layers.torch.Repeat']);

const shapeNumel = (shape) => {
  if (shape && !Array.isArray(shape) && shape.unknown) throw new Unknown('parameter shape is not known: ' + shape.unknown);
  const dims = (Array.isArray(shape) ? shape : []).map((d) => {
    if (typeof d !== 'number' || !Number.isInteger(d)) throw new Unknown('parameter shape is not known' + (d && d.unknown ? ': ' + d.unknown : ''));
    return d;
  });
  return dims.reduce((s, x) => s * x, 1);
};

function ownParams(node) {
  switch (node.kind) {
    case 'torch': {
      let v = layerParams(node.cls, node.pos || [], node.kw || {});
      // a layer that shares its weight with another path keeps only the other layer's copy
      if (node.tied?.weight) v -= weightParams(node.cls, node.pos || [], node.kw || {});
      return { v };
    }
    case 'external':
      if (NO_PARAMS_EXTERNAL.has(node.fq)) return { v: 0 };
      throw new Unknown(node.why || 'class is not in the scanned repo');
    case 'unknown': throw new Unknown(node.why || 'module is not known');
    default: {
      let v = 0;
      for (const p of node.params || []) v += shapeNumel(p.shape);
      if (node.baseLayer) v += layerParams(node.baseLayer.cls, node.baseLayer.pos || [], node.baseLayer.kw || {});
      return { v };
    }
  }
}

/** Fill node.params = { v, src, lowerBound?, why? } and node.own on every node of the tree. Returns node.params. */
export function annotate(node) {
  const parts = [];
  let own = 0;
  try { own = ownParams(node).v; parts.push({ v: own, src: 'code' }); }
  catch (e) { if (!(e instanceof Unknown)) throw e; parts.push({ v: null, why: e.message }); node.why = node.why || e.message; }
  for (const c of node.children || []) {
    if (c.alias !== undefined) { c.params = { v: 0, src: 'code', shared: true, aliasOf: c.alias }; continue; }
    const r = annotate(c);
    parts.push(r.v === null ? r : { v: r.v, src: r.src, lowerBound: r.lowerBound, why: r.why });
  }
  if (node.incomplete) parts.push({ v: null, why: (node.notes || ['part of the constructor was skipped'])[0] });
  const total = sum(parts);
  // keep the first reason that matters; a leaf shows its own reason
  const firstWhy = parts.find((p) => p.why)?.why;
  node.params = { v: total.v, src: total.src, ...(total.lowerBound ? { lowerBound: true, why: firstWhy } : {}) };
  node.own = own;
  node.bytes = { fp32: total.v * 4 };
  return node.params;
}

/** Counts for the summary: how much of the tree the scan could resolve. */
export function stats(root) {
  const s = { modules: 0, shared: 0, unknown: 0, external: 0, incomplete: 0, reasons: [] };
  const walk = (n) => {
    s.modules++;
    if (n.alias !== undefined) { s.shared++; return; }
    if (n.kind === 'unknown') { s.unknown++; s.reasons.push({ path: n.path, why: n.why }); }
    else if (n.kind === 'external') { s.external++; s.reasons.push({ path: n.path, why: n.why }); }
    else if (n.kind === 'torch' && n.why) { s.unknown++; s.reasons.push({ path: n.path, why: n.why }); }
    else if (n.kind === 'repo' && n.why && n.children?.length === 0) { s.unknown++; s.reasons.push({ path: n.path, why: n.why }); }
    if (n.incomplete) { s.incomplete++; s.reasons.push({ path: n.path, why: (n.notes || ['skipped code'])[0] }); }
    (n.children || []).forEach(walk);
  };
  walk(root);
  return s;
}
