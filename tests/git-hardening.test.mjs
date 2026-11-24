// A scanned repo can arrive with its own .git folder (a zip, a shared folder), and git obeys the .git/config in it.
// Each test plants one way of making git start a program (a POSIX sh script that touches a marker file) in a temporary
// repo, runs scan.mjs, build.mjs and status.mjs on it, and asserts that the marker never appears and that the
// results are those of the same repo without the plant. UPSTREAM.md section 16 lists the vectors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gitIn } from './helpers-plugin.mjs';
import { skipGit, gitVersion, scratch, hookFile, makeRepo, observe } from './helpers-git.mjs';

const skip = skipGit;
// what a plain repo gives (the same files, nothing planted): the listing, the parameter count and one uncommitted file
const baseline = (() => {
  const cache = {};
  return (sub) => {
    if (!cache[sub]) { const s = scratch(); try { cache[sub] = observe(s, makeRepo(s, 'plain', { sub }), { sub }); } finally { s.done(); } }
    return cache[sub];
  };
})();

/** Plants with plant(s, repoDir), runs the scripts, asserts nothing ran and nothing changed for the user. */
function check(label, plant, { sub = false, filterName, env } = {}) {
  const s = scratch();
  try {
    const dir = makeRepo(s, 'hostile', { plant: (d) => plant(s, d), sub, filterName });
    const seen = observe(s, dir, { sub, env });
    assert.deepEqual(s.ran(), [], label + ': a program of the repo was started by git');
    const plain = baseline(sub);
    assert.deepEqual(seen, plain, label + ': the results differ from the same repo without the plant');
    assert.equal(seen.via, 'git');
    assert.equal(seen.files, 2, label + ': model.py and the untracked extra.py');
    assert.equal(seen.status[0].uncommitted, 1, label + ': one new file, nothing else');
  } finally { s.done(); }
}

test('git: core.fsmonitor in .git/config (a program, a hook path, true for git\'s own daemon, or set in an included file) is never run (ls-files, status)', { skip }, () => {
  check('program', (s, d) => gitIn(d, 'config', 'core.fsmonitor', s.mk('FSMONITOR')));
  check('hook path', (s, d) => { hookFile(s, path.join(d, '.git', 'hooks', 'fsmonitor-watchman'), 'FSMONITOR_HOOK'); gitIn(d, 'config', 'core.fsmonitor', '.git/hooks/fsmonitor-watchman'); });
  check('included file, with the untracked cache on', (s, d) => {
    const inc = path.join(s.dir, 'extra.cfg');
    fs.writeFileSync(inc, '[core]\n\tfsmonitor = ' + s.mk('INCLUDED') + '\n');
    gitIn(d, 'config', 'include.path', inc);
    gitIn(d, 'config', 'core.untrackedCache', 'true');
  });
});

test('git: a clean filter named by .gitattributes is never run by status, also when it is defined in an included file', { skip }, () => {
  check('clean', (s, d) => gitIn(d, 'config', 'filter.evilf.clean', s.mk('CLEAN')));
  check('clean in an included file', (s, d) => {
    const inc = path.join(s.dir, 'filters.cfg');
    fs.writeFileSync(inc, '[filter "evilf"]\n\tclean = ' + s.mk('CLEAN_INCLUDED') + '\n');
    gitIn(d, 'config', 'include.path', inc);
  });
  check('a name with dots and capitals, named in .git/info/attributes', (s, d) => {
    gitIn(d, 'config', 'filter.My.Evil.clean', s.mk('CLEAN_DOTS'));
    fs.mkdirSync(path.join(d, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(d, '.git', 'info', 'attributes'), '*.py filter=My.Evil\n');
  }, { filterName: 'plain' });
});

test('git: a long-running filter process (filter.<name>.process) is never started by status, also with required = true (which makes git fail when the filter has no command)', { skip }, () => {
  check('process, required', (s, d) => { gitIn(d, 'config', 'filter.evilf.process', s.mk('PROCESS_REQUIRED')); gitIn(d, 'config', 'filter.evilf.clean', s.mk('CLEAN_REQUIRED')); gitIn(d, 'config', 'filter.evilf.required', 'true'); });
});

test('git: status does not look into a submodule, so a submodule\'s own .git/config (fsmonitor, filters) is never run', { skip }, () => {
  check('submodule', (s, d) => {
    const sd = path.join(d, 'sub');
    gitIn(sd, 'config', 'core.fsmonitor', s.mk('SUB_FSMONITOR'));
    gitIn(sd, 'config', 'filter.subf.clean', s.mk('SUB_CLEAN'));
    fs.writeFileSync(path.join(sd, '.gitattributes'), '*.py filter=subf\n');
  }, { sub: true });
});

test('git: the post-index-change hook (in .git/hooks or under core.hooksPath) is not run, because status does not write the index', { skip }, () => {
  check('.git/hooks', (s, d) => hookFile(s, path.join(d, '.git', 'hooks', 'post-index-change'), 'POST_INDEX_CHANGE'));
  check('core.hooksPath', (s, d) => { const h = path.join(s.dir, 'hooks'); hookFile(s, path.join(h, 'post-index-change'), 'POST_INDEX_CHANGE_PATH'); gitIn(d, 'config', 'core.hooksPath', h); });
});

test('git: the other programs a .git/config can name are not started by these commands either (a guard: if a git release changes that, this fails)', { skip }, () => {
  check('the rest', (s, d) => {
    const set = (k, v) => gitIn(d, 'config', k, v);
    set('filter.evilf.smudge', s.mk('SMUDGE'));
    set('diff.external', s.mk('DIFF_EXTERNAL'));
    set('diff.evilf.textconv', s.mk('TEXTCONV'));
    set('diff.evilf.command', s.mk('DIFF_COMMAND'));
    for (const k of ['core.pager', 'pager.status', 'pager.diff', 'core.editor', 'core.sshCommand', 'core.askPass', 'core.alternateRefsCommand', 'core.gitProxy', 'gpg.program']) set(k, s.mk(k.replace(/\W/g, '_').toUpperCase()));
    set('credential.helper', '!' + s.mk('CREDENTIAL'));
    for (const c of ['status', 'ls-files', 'diff', 'rev-parse', 'check-ignore']) set('alias.' + c, '!' + s.mk('ALIAS_' + c.replace(/\W/g, '_').toUpperCase()));
    const h = path.join(s.dir, 'hooks');
    for (const n of ['post-checkout', 'post-merge', 'pre-commit', 'reference-transaction', 'post-rewrite']) hookFile(s, path.join(h, n), 'HOOK_' + n.replace(/\W/g, '_'));
    set('core.hooksPath', h);
  });
});

test('git: a filter whose name git cannot be told to switch off (an equals sign in it) makes modelmap not run git there: the scan walks the folder, status says it is not compared, nothing ran', { skip }, () => {
  const s = scratch();
  try {
    const dir = makeRepo(s, 'odd', { filterName: 'a=b', plant: (d) => gitIn(d, 'config', 'filter.a=b.clean', s.mk('CLEAN_EQUALS')) });
    const seen = observe(s, dir);
    assert.deepEqual(s.ran(), []);
    assert.equal(seen.via, 'walk');
    assert.deepEqual(seen.status, [{ path: '.', compared: false }]);
  } finally { s.done(); }
});

test('git: the user\'s own config keeps working: a filter in the global config still runs, and the repo\'s config cannot take its place', { skip: skip || (gitVersion[0] < 2 || (gitVersion[0] === 2 && gitVersion[1] < 32) ? 'GIT_CONFIG_GLOBAL needs git 2.32' : false) }, () => {
  const s = scratch();
  try {
    const global = path.join(s.dir, 'global.gitconfig');
    fs.writeFileSync(global, '[filter "userf"]\n\tclean = ' + s.mk('USER_CLEAN') + '\n');
    const dir = makeRepo(s, 'user', { filterName: 'userf' });
    const seen = observe(s, dir, { env: { GIT_CONFIG_GLOBAL: global } });
    assert.deepEqual(s.ran(), ['USER_CLEAN'], 'the user\'s own filter was switched off');
    assert.equal(seen.via, 'git');
  } finally { s.done(); }
});
