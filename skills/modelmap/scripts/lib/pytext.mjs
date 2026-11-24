// modelmap lib/pytext.mjs: Python source read as TEXT, never run or imported. Written for modelmap.
// Moved here from describe.mjs so that describe.mjs (the worksheet) and lib/flow.mjs (the "at" check of a flow
// edge) find a class's docstring and forward() the same way: by indentation, as text.
import fs from 'node:fs';
import path from 'node:path';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

const fileCache = new Map();
/** The lines of a repo file, or null. Only files inside the root (symlinks resolved); at most 2 MB. */
export function repoLines(repoRoot, rel) {
  const key = repoRoot + '\0' + rel;
  if (fileCache.has(key)) return fileCache.get(key);
  let lines = null;
  try {
    const abs = path.resolve(repoRoot, rel);
    const inside = (base, p) => { const r = path.relative(base, p); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
    if (inside(repoRoot, abs) && inside(fs.realpathSync(repoRoot), fs.realpathSync(abs)) && fs.statSync(abs).size <= MAX_FILE_BYTES) {
      lines = fs.readFileSync(abs, 'utf8').replace(/\r\n?/g, '\n').split('\n');
    }
  } catch { lines = null; }
  fileCache.set(key, lines);
  return lines;
}

// Python blocks are found by indentation, as text: good enough for class and def blocks, and a wrong guess
// only shows more or fewer lines of the repo's own text.
export const indentOf = (l) => /^[ \t]*/.exec(l)[0].replace(/\t/g, '        ').length;
const blankOrComment = (l) => /^\s*(#.*)?$/.test(l);
/** Index of the line that ends a header starting at i (a class or def line that may span lines). */
function headerEnd(lines, i) {
  let depth = 0;
  for (let j = i; j < Math.min(lines.length, i + 30); j++) {
    const t = lines[j].replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""').replace(/#.*$/, '');
    for (const ch of t) { if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) depth--; }
    if (depth <= 0 && /:\s*$/.test(t)) return j;
  }
  return i;
}
/** The open triple-quoted string at the end of a line ('"""', "'''" or null), given the one open at its start. */
function tripleAfter(line, open) {
  let i = 0;
  while (i < line.length) {
    if (open) {
      const k = line.indexOf(open, i);
      if (k < 0) return open;
      let bs = 0;
      for (let b = k - 1; b >= 0 && line[b] === '\\'; b--) bs++;
      i = k + 3;
      if (bs % 2 === 0) open = null;
      continue;
    }
    const ch = line[i];
    if (ch === '#') return null;
    if (ch === '"' || ch === "'") {
      if (line.startsWith(ch.repeat(3), i)) { open = ch.repeat(3); i += 3; continue; }
      i++;
      while (i < line.length && line[i] !== ch) i += line[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    i++;
  }
  return open;
}
/**
 * Index after the last line of the block whose header ends at h, for a header line indented by ind. Lines
 * inside a triple-quoted string belong to the block whatever their indent.
 */
function blockEnd(lines, h, ind) {
  let last = h, open = null;
  for (let j = h + 1; j < lines.length; j++) {
    if (!open) {
      if (blankOrComment(lines[j])) continue;
      if (indentOf(lines[j]) <= ind) break;
    }
    last = j;
    open = tripleAfter(lines[j], open);
  }
  return last + 1;
}

/** Docstring (first paragraph), forward() text and bases of a class, read from the file as text. forward.start and
 *  forward.end are the 1-based lines shown (at most maxForwardLines); forward.last is the last line of the method. */
export function classText(lines, cls, line, { maxForwardLines = 60, maxDocChars = 1500 } = {}) {
  const out = { doc: null, forward: null, bases: null, note: null };
  if (!lines) { out.note = 'the file could not be read as text'; return out; }
  const head = new RegExp('^\\s*class\\s+' + String(cls).replace(/\W/g, '') + '\\b');
  const isHead = (i) => i >= 0 && i < lines.length && head.test(lines[i]);
  let i = (line || 1) - 1;
  if (!isHead(i)) {
    const near = [...Array(11).keys()].map((k) => i - 5 + k).find(isHead);
    if (near === undefined) { out.note = 'the class line was not found where the scan said'; return out; }
    i = near;
  }
  const ind = indentOf(lines[i]);
  const h = headerEnd(lines, i);
  out.bases = (/^\s*class\s+\w+\s*\(([\s\S]*?)\)\s*:/.exec(lines.slice(i, h + 1).join(' ')) || [])[1]?.trim() || null;
  const body = lines.slice(h + 1, blockEnd(lines, h, ind));
  // docstring: the first statement of the body, when it is a string literal
  const firstIdx = body.findIndex((l) => !blankOrComment(l));
  if (firstIdx >= 0) {
    const first = body[firstIdx].trim();
    const m = /^[rRuU]?("""|'''|"|')/.exec(first);
    if (m) {
      const q = m[1];
      let text = first.slice(m[0].length);
      if (q.length === 3) for (let k = firstIdx; !text.includes(q) && k + 1 < body.length && k - firstIdx < 200;) text += '\n' + body[++k];
      text = text.split(q)[0];
      const ls = text.split('\n');
      const minInd = Math.min(999, ...ls.slice(1).filter((l) => l.trim()).map(indentOf));
      text = [ls[0].trim(), ...ls.slice(1).map((l) => l.slice(Math.min(minInd, indentOf(l))))].join('\n').trim();
      out.doc = clip(text.split(/\n\s*\n/)[0].trim(), maxDocChars) || null;
    }
  }
  // forward: a def at the indent of the class body's own statements (not a nested function)
  const memberInd = firstIdx >= 0 ? indentOf(body[firstIdx]) : ind + 4;
  const f = body.findIndex((l) => /^\s*(async\s+)?def\s+forward\s*\(/.test(l) && indentOf(l) === memberInd);
  if (f >= 0) {
    const at = h + 1 + f;
    const all = lines.slice(at, blockEnd(lines, headerEnd(lines, at), memberInd));
    const kept = all.slice(0, maxForwardLines);
    const cut = memberInd; // the def's own indent (lines of a multi-line string may start further left)
    out.forward = { start: at + 1, end: at + kept.length, last: at + all.length, total: all.length, text: kept.map((l) => l.slice(Math.min(cut, indentOf(l)))).join('\n') };
  }
  return out;
}
