// modelmap: helpers for tests/wording.test.mjs. They pull out the text a person can read from a page or a
// script, so the wording test can look for banned words in that text and never in identifiers or comments.
//
// How: a small lexer walks the JavaScript source and keeps only string literals and the static parts of
// template literals (with the code inside ${...} lexed in turn); comments and regular expressions are skipped.
// HTML is read the same way: outside <script> and <style>, only text nodes and the attributes a person sees
// (title, aria-label, placeholder, alt, label) count; tags, class names, ids and comments do not.
// Inside a JavaScript string that holds HTML, tags are dropped the same way and their visible attributes kept.

const VISIBLE_ATTRS = /\b(?:title|aria-label|placeholder|alt|label)\s*=\s*("[^"]*"|'[^']*')/gi;
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const decode = (s) => s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e]);

/** Text a person sees in an HTML fragment: tags go, their visible attributes stay. */
export function visibleText(html) {
  const noComments = html.replace(/<!--[\s\S]*?-->/g, ' ');
  const out = noComments.replace(/<\/?[a-zA-Z][^>]*>/g, (tag) => {
    const vals = [];
    for (const m of tag.matchAll(VISIBLE_ATTRS)) vals.push(m[1].slice(1, -1));
    return ' ' + vals.join(' ') + ' ';
  });
  return decode(out).replace(/\u0001/g, ' ').replace(/\s+/g, ' ').trim();
}

const REGEX_AFTER = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const REGEX_WORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'else', 'do', 'yield', 'await']);
const isIdent = (c) => /[\w$]/.test(c);

/**
 * The string literals of a JavaScript source: [{ text, line }]. A template literal gives one entry whose text joins
 * its static parts with U+0001; the code in its ${...} gives its own entries.
 */
export function jsStrings(src, startLine = 1) {
  const out = [];
  let i = 0, line = startLine;
  const n = src.length;
  let last = ''; // the last significant character outside strings and comments
  let word = ''; // the last identifier, to tell "return /re/" from "a / b"
  const adv = () => { if (src[i] === '\n') line++; i++; };
  // the code just before a string on its line, so a check can tell plural(n, 'endpoint') from a kind key
  const lineBefore = () => src.slice(src.lastIndexOf('\n', i - 1) + 1, i);
  function readQuoted(q) {
    const at = line, before = lineBefore(); let s = '';
    adv();
    while (i < n && src[i] !== q) {
      if (src[i] === '\\') { adv(); const c = src[i]; s += c === 'n' ? '\n' : c === 't' ? '\t' : c; adv(); continue; }
      if (src[i] === '\n') break; // an unterminated string: stop at the line end
      s += src[i]; adv();
    }
    adv();
    out.push({ text: s, line: at, before });
  }
  function readTemplate() {
    const at = line, before = lineBefore(); const parts = []; let s = '';
    adv();
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') { adv(); s += src[i]; adv(); continue; }
      if (src[i] === '$' && src[i + 1] === '{') {
        parts.push(s); s = '';
        adv(); adv();
        lexCode(true);
        continue;
      }
      s += src[i]; adv();
    }
    adv();
    parts.push(s);
    out.push({ text: parts.join('\u0001'), line: at, before });
  }
  function readRegex() {
    adv();
    let cls = false;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { adv(); adv(); continue; }
      if (c === '\n') break;
      if (cls) { if (c === ']') cls = false; }
      else if (c === '[') cls = true;
      else if (c === '/') { adv(); break; }
      adv();
    }
    while (i < n && /[a-z]/i.test(src[i])) adv();
    last = 'x'; word = '';
  }
  // lexes code; inTemplate: stop at the } that closes a ${...}
  function lexCode(inTemplate) {
    let depth = 0;
    while (i < n) {
      const c = src[i], d = src[i + 1];
      if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') adv(); continue; }
      if (c === '/' && d === '*') { adv(); adv(); while (i < n && !(src[i] === '*' && src[i + 1] === '/')) adv(); adv(); adv(); continue; }
      if (c === "'" || c === '"') { readQuoted(c); last = 'x'; word = ''; continue; }
      if (c === '`') { readTemplate(); last = 'x'; word = ''; continue; }
      if (c === '/') {
        if (last === '' || REGEX_AFTER.has(last) || REGEX_WORDS.has(word)) { readRegex(); continue; }
        adv(); last = '/'; word = ''; continue;
      }
      if (inTemplate) {
        if (c === '{') depth++;
        else if (c === '}') { if (depth === 0) { adv(); return; } depth--; }
      }
      if (/\s/.test(c)) { adv(); continue; }
      if (isIdent(c)) {
        let w = '';
        while (i < n && isIdent(src[i])) { w += src[i]; adv(); }
        word = w; last = 'x';
        continue;
      }
      last = c; word = ''; adv();
    }
  }
  lexCode(false);
  return out;
}

/**
 * An HTML page split into what a person can read: the markup's text nodes and visible attributes, and the string
 * literals of each inline script, each with its line number. A script whose first line matches skipScript is left out.
 */
export function pageTexts(html, { skipScript } = {}) {
  const texts = [];
  const lineAt = (idx) => html.slice(0, idx).split('\n').length;
  const re = /<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let pos = 0, m;
  const markup = (from, to) => {
    const chunk = html.slice(from, to);
    // one entry per markup line, so a finding names its line
    chunk.split('\n').forEach((l, k) => { const t = visibleText(l); if (t) texts.push({ text: t, line: lineAt(from) + k, where: 'markup' }); });
  };
  while ((m = re.exec(html))) {
    markup(pos, m.index);
    pos = m.index + m[0].length;
    if (m[1].toLowerCase() !== 'script') continue;
    const body = m[2];
    if (skipScript && skipScript(body)) continue;
    const start = lineAt(m.index + m[0].indexOf('>') + 1);
    for (const s of jsStrings(body, start)) texts.push({ ...s, where: 'script' });
  }
  markup(pos, html.length);
  return texts;
}
