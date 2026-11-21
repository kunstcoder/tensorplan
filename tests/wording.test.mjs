// modelmap: the words a person reads on a model map. viewer.html, the ui/*.js files that carry the page's wording
// and the page that build.mjs makes for tests/fixtures/mini-model must not show floorplan's web-app words
// (codebase, this app, endpoint, route, blueprint) or point at floorplan (floorplan/, its repo, its cloud).
//
// How the check reads a file (tests/helpers-wording.mjs): only text a person can see counts. In HTML that is text
// nodes and the title, aria-label, placeholder, alt and label attributes; in JavaScript it is string literals and
// the static parts of template literals, with any HTML inside them read the same way. Comments (so the
// "Derived from floorplan" headers), identifiers (window.Floorplan, FLOORPLAN_SERVER, floorplanAskInstructions),
// tag names, class names and ids are never looked at. A string with no space in it (a key such as
// 'x-floorplan-token', 'floorplan:ask' or 'route') counts as an identifier for the web-app words, except as the
// noun of plural(n, '...'), which the page shows. The product words (floorplan/, haydenschmitty, waitlist, ...)
// are looked for in every string, identifier-like or not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { jsStrings, pageTexts, visibleText } from './helpers-wording.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(repo, 'skills', 'modelmap', 'assets');
const SCRIPTS = path.join(repo, 'skills', 'modelmap', 'scripts');
const VIEWER = path.join(ASSETS, 'viewer.html');
const UI = ['05-theme.js', '10-glossary.js', '40-tour.js', '60-export.js'].map((n) => path.join(ASSETS, 'ui', n));

/** Banned in every string and text node. */
const PRODUCT = [/floorplan\//i, /floorplan cloud/i, /waitlist/i, /haydenschmitty/i, /shopify/i];
/** Banned in text a person reads (not in identifier-like strings). */
const WEB = [/\bcodebases?\b/i, /\bthis app\b/i, /\bblueprints?\b/i, /\bendpoints?\b/i, /\broutes?\b/i, /\bfloorplan\b/i];

// viewer.html keeps floorplan's file and route items (cards, panels, rows) so its diff stays small. Their text names
// endpoints and routes, and it never shows on a model map: modelmap/graph@1 has files: [] and routes: []
// (references/schema.md). A finding is allowed only on a line of that code, which these names mark.
const FILE_ROUTE_CODE = /routesByFile|\beps\b|i\.type === 'route'|\broutes\.length\b|\bf\.tooLarge\b|\bundescribed\b|\bs\.files\b/;
// The tool descriptions the Claude app reads when it answers from the page (not shown to a person). They describe
// the lookups of graph-query.js, whose item kinds (module, file, endpoint, symbol) are not this file's to rename.
const TOOL_TEXT = [/^Search the map by words\./, /^Details of one map item by id:/];

const isIdentLike = (t) => !/\s/.test(t.trim());
const PLURAL_NOUN = /plural\(.*,\s*$/;

/**
 * Banned words in a file's texts: [{ line, word, text }]. texts come from jsStrings or pageTexts; lines are the
 * file's lines, to tell floorplan's file and route code (see FILE_ROUTE_CODE) from the rest.
 */
export function findBanned(texts, lines, { webWords = true } = {}) {
  const out = [];
  for (const t of texts) {
    const text = t.where === 'markup' ? t.text : visibleText(t.text);
    if (!text) continue;
    for (const re of PRODUCT) if (re.test(text) || re.test(t.text)) out.push({ line: t.line, word: re.source, text });
    if (!webWords) continue;
    if (t.where !== 'markup' && isIdentLike(text) && !PLURAL_NOUN.test(t.before || '')) continue;
    for (const re of WEB) {
      if (!re.test(text)) continue;
      if (/endpoint|route/.test(re.source) && FILE_ROUTE_CODE.test(lines[t.line - 1] || '')) continue;
      if (TOOL_TEXT.some((x) => x.test(text))) continue;
      out.push({ line: t.line, word: re.source, text: text.slice(0, 160) });
    }
  }
  return out;
}
const show = (file, found) => found.map((f) => `${file}:${f.line} ${f.word}: ${JSON.stringify(f.text)}`).join('\n');
const rel = (p) => path.relative(repo, p);

test('viewer.html: no web-app words and no floorplan links in its text, placeholders, titles and strings', () => {
  const src = fs.readFileSync(VIEWER, 'utf8');
  const found = findBanned(pageTexts(src), src.split('\n'));
  assert.equal(show(rel(VIEWER), found), '');
});

test('ui/05-theme.js, 10-glossary.js, 40-tour.js and 60-export.js: no web-app words and no floorplan links in their strings', () => {
  const all = [];
  for (const f of UI) {
    const src = fs.readFileSync(f, 'utf8');
    const found = findBanned(jsStrings(src).map((s) => ({ ...s, where: 'script' })), src.split('\n'));
    if (found.length) all.push(show(rel(f), found));
  }
  assert.equal(all.join('\n'), '');
});

const hasPython = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;
test('the built page of tests/fixtures/mini-model: no web-app words and no floorplan links', { skip: !hasPython && 'python3 is missing' }, () => {
  const out = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'modelmap-wording-'));
  try {
    const fixture = path.join(repo, 'tests', 'fixtures', 'mini-model');
    const scan = spawnSync(process.execPath, [path.join(SCRIPTS, 'scan.mjs'), fixture, '--out', path.join(out, '.cache')], { encoding: 'utf8' });
    assert.equal(scan.status, 0, scan.stderr);
    const build = spawnSync(process.execPath, [path.join(SCRIPTS, 'build.mjs'), fixture, '--out', out], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.ok(html.includes('/* ui/40-tour.js */'), 'the page holds the ui scripts');
    const lines = html.split('\n');
    // the layout engine (vendor/elk.bundled.js, byte-identical to its upstream) is minified third-party code
    const isElk = (body) => body.length > 500000 && /\bELK\b/.test(body);
    // graph-query.js (the lookups and the instructions sent to Claude) only for the product words: it is not page text
    const isQuery = (body) => /function createGraphQuery\b/.test(body) && !/window\.Floorplan = /.test(body);
    const scripts = [];
    const texts = pageTexts(html, { skipScript: (body) => { if (isElk(body)) return true; if (isQuery(body)) { scripts.push(body); return true; } return false; } });
    const found = findBanned(texts, lines);
    for (const body of scripts) found.push(...findBanned(jsStrings(body).map((s) => ({ ...s, where: 'script' })), body.split('\n'), { webWords: false }).map((f) => ({ ...f, line: 'graph-query.js:' + f.line })));
    assert.equal(show('index.html', found), '');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('the check finds a banned word in a string, a template, a text node and an attribute, and passes identifiers and comments', () => {
  const js = [
    "// floorplan/ codebase endpoint: a comment is not read",
    "const S = window.FLOORPLAN_SERVER, T = window.Floorplan; floorplanAskInstructions(G);",
    "fetch('/api/x', { headers: { 'x-floorplan-token': S.token } }); if (i.type === 'route') go('floorplan:ask');",
    "toast('Search the codebase');",
    "const a = `<b>${n}</b> routes in this app`;",
    "const b = plural(n, 'endpoint');",
    "const c = 'see https://github.com/haydenschmitty/x';",
    "const re = /'codebase'/g;",
    "const tip = `<button class=\"route\" title=\"Open the blueprint\">ok</button>`;",
  ].join('\n');
  const words = findBanned(jsStrings(js).map((s) => ({ ...s, where: 'script' })), js.split('\n')).map((f) => f.line + ' ' + f.word);
  assert.deepEqual(words, ['4 \\bcodebases?\\b', '5 \\bthis app\\b', '5 \\broutes?\\b', '6 \\bendpoints?\\b', '7 haydenschmitty', '9 \\bblueprints?\\b']);
  const html = '<!-- Derived from floorplan v0.11.0 (MIT): skills/floorplan/assets/viewer.html -->\n<div id="route" class="codebase">ok</div>\n<input placeholder="Search files and routes">\n<p>A map of this codebase</p>\n<script>const x = "run node floorplan/serve.mjs";</script>';
  const hw = findBanned(pageTexts(html), html.split('\n')).map((f) => f.line + ' ' + f.word);
  assert.deepEqual(hw, ['3 \\broutes?\\b', '4 \\bcodebases?\\b', '5 floorplan\\/', '5 \\bfloorplan\\b']);
});
