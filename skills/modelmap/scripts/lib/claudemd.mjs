// Derived from floorplan v0.11.0 (MIT): skills/floorplan/scripts/lib/claudemd.mjs
// Keeps a short block in the project's CLAUDE.local.md pointing future Claude Code sessions at the model map,
// so "how big is X / what does block Y do" starts from the map instead of a fresh read of the code.
// CLAUDE.local.md is Claude Code's personal, uncommitted project memory (loaded at launch like CLAUDE.md).
// The block sits between markers and is rewritten in place; the rest of the file is never touched.
//
// Nothing here writes unless the caller asks for it, because each write changes the user's project:
//   add        create the block, or rewrite it when it is there (only after the user said yes)
//   refresh    rewrite the block only when it is already there
//   exclude    add CLAUDE.local.md to the repo's local ignore list (.git/info/exclude)
//   removeOld  take a modelmap block back out of CLAUDE.md or .claude/CLAUDE.md (usually committed files)
// With no options it only reports what it would do. Put <!-- modelmap:off --> in CLAUDE.local.md to opt out.
import fs from 'node:fs';
import path from 'node:path';
import { git } from './common.mjs';

export const START = '<!-- modelmap:start -->';
export const END = '<!-- modelmap:end -->';
export const OFF = '<!-- modelmap:off -->';
const NAME = 'CLAUDE.local.md';

function block(rel) {
  return `${START}
## modelmap: map of the model in this repo

\`${rel}/\` holds a map of the PyTorch model in this repo: its module tree, the parameter count of every module with the source of each number (code, config, weights), and a short description of each class. For questions like "how many parameters does X have", "what is inside Y" or "where is Z defined", look it up before reading the code (run these from the folder this file is in):

- \`node ${rel}/query.mjs overview\`: the model at a glance
- \`node ${rel}/query.mjs find "<words>"\`: modules that match
- \`node ${rel}/query.mjs show <module path>\`: what it is and what it holds

The map is made from the code as it was when it was built, so confirm in the code before changing anything. Open it with \`node ${rel}/serve.mjs\`. After changes to the model, rebuild it with the modelmap skill.
${END}`;
}

const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
/** The text with the block removed (normalized to \n), or null when there's no block. */
const stripBlock = (text) => {
  const a = text.indexOf(START), b = text.indexOf(END);
  if (a < 0 || b < a) return null;
  return [text.slice(0, a).trimEnd(), text.slice(b + END.length).trimStart()].filter(Boolean).join('\n\n').replace(/\r\n/g, '\n');
};

/** Adds CLAUDE.local.md to the enclosing repo's .git/info/exclude unless git already ignores it. */
function excludeLocally(root) {
  if (git(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') return 'not in a git repo';
  if (git(root, ['ls-files', '--', NAME])) return `${NAME} is committed in this repo; the modelmap section will show up in it`;
  if (git(root, ['check-ignore', '-q', NAME]) !== null) return 'already ignored';
  const prefix = git(root, ['rev-parse', '--show-prefix']) || '';
  const excl = git(root, ['rev-parse', '--git-path', 'info/exclude']);
  if (!excl) return 'could not find .git/info/exclude';
  const file = path.resolve(root, excl);
  const line = '/' + prefix + NAME;
  const cur = read(file) || '';
  if (!cur.split(/\r?\n/).includes(line)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, cur.replace(/\s*$/, cur.trim() ? '\n' : '') + `# personal Claude Code notes (added by modelmap)\n${line}\n`);
  }
  return 'ignored locally via .git/info/exclude';
}

/**
 * Writes the block only as the options allow (see the header). Returns one line saying what was done,
 * or, with no options, what could be done.
 */
export function writeClaudeMd(root, outDir, { add = false, refresh = false, exclude = false, removeOld = false } = {}) {
  const rel = path.relative(root, outDir).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return 'skipped (map is outside the codebase)';
  const file = path.join(root, NAME);
  const old = read(file);
  const notes = [];

  if (removeOld) {
    for (const f of [path.join(root, 'CLAUDE.md'), path.join(root, '.claude', 'CLAUDE.md')]) {
      const t = read(f);
      const rest = t == null ? null : stripBlock(t);
      if (rest == null) continue;
      const eol = t.includes('\r\n') ? '\r\n' : '\n';
      const tracked = !!git(path.dirname(f), ['ls-files', '--', path.basename(f)]);
      if (!rest.trim() && !tracked) fs.unlinkSync(f);
      else fs.writeFileSync(f, rest.replace(/\n/g, eol) + (rest.trim() ? eol : ''));
      notes.push(`moved the modelmap section out of ${path.relative(root, f).replace(/\\/g, '/')}${!rest.trim() && tracked ? ' (now empty; delete it if you like)' : ''}`);
    }
  }

  const had = old != null && stripBlock(old) != null;
  if (old?.includes(OFF)) notes.unshift('skipped (opted out)');
  else if (add || (refresh && had)) {
    const eol = old?.includes('\r\n') ? '\r\n' : '\n';
    const text = block(rel).replace(/\n/g, eol);
    let next;
    if (old == null) next = text + eol;
    else {
      const a = old.indexOf(START), b = old.indexOf(END);
      next = a >= 0 && b > a ? old.slice(0, a) + text + old.slice(b + END.length) : old.replace(/\s*$/, '') + eol + eol + text + eol;
    }
    if (next !== old) { fs.writeFileSync(file, next); notes.unshift(`${old == null ? 'created' : 'updated'} ${NAME}`); }
    else notes.unshift(`${NAME} unchanged`);
  } else notes.unshift(had ? `${NAME} has a modelmap block; not rewritten (pass refresh to keep it current)` : 'not added (offer it to the user; add it only when they say yes)');

  if (exclude) notes.push(excludeLocally(root));
  return notes.join('; ');
}
