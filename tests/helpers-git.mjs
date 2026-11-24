// Helpers for tests/git-hardening.test.mjs: a repo that arrives with a hostile .git/config, and what the scripts make of it.
// Every hostile program here is a POSIX sh script that touches a marker file, so "it ran" is a file on disk.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { node, script, tmp, gitIn, hasGit, hasPython } from './helpers-plugin.mjs';
import { scanInto, build } from './helpers-build.mjs';

export const skipGit = process.platform === 'win32' ? 'needs a POSIX sh' : !hasGit ? 'git is not installed' : !hasPython ? 'python3 (3.9+) is needed' : false;
/** git's version as [major, minor]. */
export const gitVersion = (() => { const m = /(\d+)\.(\d+)/.exec(spawnSync('git', ['--version'], { encoding: 'utf8' }).stdout || ''); return m ? [+m[1], +m[2]] : [0, 0]; })();

const MODEL = ['from torch import nn', 'class Net(nn.Module):', '    def __init__(self):', '        super().__init__()', '        self.fc = nn.Linear(4, 4)', ''].join('\n');

/** A scratch folder with a marker script: mk('NAME') is a shell command that creates marks/NAME. */
export function scratch() {
  const t = tmp('modelmap-git-');
  const marks = path.join(t.dir, 'marks');
  fs.mkdirSync(marks);
  const sh = path.join(t.dir, 'mark.sh');
  fs.writeFileSync(sh, '#!/bin/sh\ntouch "' + marks + '/$1"\nexit 0\n', { mode: 0o755 });
  const mk = (name) => "sh '" + sh + "' " + name;
  const ran = () => fs.readdirSync(marks).sort();
  return { ...t, marks, mk, ran };
}

/** A hook file (an executable sh script) that creates the marker. */
export function hookFile(s, file, name) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\ntouch "' + s.marks + '/' + name + '"\nexit 0\n', { mode: 0o755 });
}

/**
 * A repo with one model file, committed. Every .py file is named for the filter "filterName" by .gitattributes (a
 * name with no command defined is no filter at all). plant(repoDir) runs after the commit, so none of the test's own
 * git commands meet it. Returns the repo folder.
 */
export function makeRepo(s, name, { plant, filterName = 'evilf', sub = false } = {}) {
  const dir = path.join(s.dir, name);
  fs.mkdirSync(dir);
  gitIn(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'model.py'), MODEL);
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.py filter=' + filterName + '\n');
  if (sub) {
    const sd = path.join(dir, 'sub');
    fs.mkdirSync(sd);
    gitIn(sd, 'init', '-q');
    fs.writeFileSync(path.join(sd, 's.py'), 's = 1\n');
    gitIn(sd, 'add', '-A');
    gitIn(sd, 'commit', '-q', '-m', 's');
    fs.writeFileSync(path.join(dir, '.gitmodules'), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n');
    gitIn(dir, 'add', '.gitmodules', 'model.py', '.gitattributes');
    gitIn(dir, 'update-index', '--add', '--cacheinfo', '160000,' + gitIn(sd, 'rev-parse', 'HEAD') + ',sub');
  } else gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'one');
  if (plant) plant(dir);
  return dir;
}

/** One new untracked file (and one in the submodule). */
function addUntracked(dir, sub) {
  fs.writeFileSync(path.join(dir, 'extra.py'), 'y = 2\n');
  if (sub) fs.writeFileSync(path.join(dir, 'sub', 'dirty.py'), 'q = 1\n');
}
/** Makes the work tree look like a fresh extraction of the commit: model.py has new stat data, so git must read it to
 *  compare it with the index (that is when a clean filter runs). In a submodule, the same. */
function newStat(dir, sub) {
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, 'model.py'), later, later);
  if (sub) fs.utimesSync(path.join(dir, 'sub', 's.py'), later, later);
}

/**
 * scan.mjs and build.mjs on the repo (with one untracked file in it), then status.mjs after the work tree got new stat
 * data. The map goes to a folder of its own. Returns what the user would see, so a hostile repo can be compared with a
 * plain one: the listing the scan used, the parameter count and the status. env is for the child processes.
 */
export function observe(s, root, { env, sub = false } = {}) {
  const out = path.join(s.dir, 'map-' + path.basename(root));
  const opts = env ? { env: { ...process.env, ...env } } : {};
  const run = (file, args) => { const r = node(script(file), args, opts); if (r.status !== 0) throw new Error(file + ' failed: ' + r.stderr); return r; };
  addUntracked(root, sub);
  run('scan.mjs', [root, '--out', path.join(out, '.cache')]);
  run('build.mjs', [root, '--out', out]);
  newStat(root, sub);
  const scan = JSON.parse(fs.readFileSync(path.join(out, '.cache', 'scan.json'), 'utf8'));
  const st = JSON.parse(run('status.mjs', [root, '--out', out, '--json']).stdout);
  return { via: scan.meta.via, files: scan.meta.files, params: scan.root.params.v, status: st.repos };
}
