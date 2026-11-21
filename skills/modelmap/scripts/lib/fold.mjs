// Fold repeated sibling modules into one ×N card.
// Rule: only siblings of an indexed container (ModuleList, Sequential), and only when the class AND every
// argument are equal. One difference keeps every card, and each card gets a letter: A, B, C by first sight.

const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
const vOnly = (r) => (r && typeof r === 'object' && 'v' in r ? r.v : r);

/** The identity of a module as built: its class and its argument values (not where they were written). */
export function signature(n) {
  if (n.alias !== undefined || n.kind === 'unknown' || n.kind === 'external') return null;
  const args = n.kind === 'repo' && n.args
    ? Object.fromEntries(Object.entries(n.args).map(([k, r]) => [k, vOnly(r)]))
    : { pos: (n.pos || []).map(vOnly), kw: Object.fromEntries(Object.entries(n.kw || {}).map(([k, r]) => [k, vOnly(r)])) };
  return canon([n.kind, n.cls, args]);
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The display list for one parent: the children, with equal runs folded when the parent is an indexed container. */
export function foldChildren(parent) {
  const kids = parent.children || [];
  if (!['list', 'seq'].includes(parent.container) || kids.length < 2) return kids;
  const sigs = kids.map(signature);
  if (sigs[0] !== null && sigs.every((s) => s === sigs[0])) {
    const total = kids.every((k) => k.params && !k.params.lowerBound) ? kids.reduce((s, k) => s + k.params.v, 0) : null;
    return [{ ...kids[0], name: kids[0].name + '…' + kids[kids.length - 1].name, fold: { n: kids.length, members: kids.map((k) => k.path), ...(total !== null ? { total } : {}) } }];
  }
  const seen = new Map();
  const order = sigs.map((s) => { if (s === null) return null; if (!seen.has(s)) seen.set(s, seen.size); return seen.get(s); });
  const repeats = order.some((o, i) => o !== null && order.indexOf(o) !== i);
  if (!repeats || seen.size > LETTERS.length) return kids;
  return kids.map((k, i) => (order[i] === null ? k : { ...k, letter: LETTERS[order[i]] }));
}

/** A copy of the tree with every container folded. The scan keeps the full tree; the map shows this one. */
export function foldTree(node) {
  return { ...node, children: foldChildren(node).map(foldTree) };
}

/** The pattern of a container whose children are not all equal, for example 'ABCBCB'. null when there is none. */
export function pattern(parent) {
  const f = foldChildren(parent);
  return f.every((k) => k.letter) && f.length > 1 ? f.map((k) => k.letter).join('') : null;
}
