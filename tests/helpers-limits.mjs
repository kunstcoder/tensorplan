// Helpers for tests/pyscan-limits.test.mjs: small hostile repos built at run time (never committed), scanned through
// scan.mjs, and pyscan.py run directly, with its peak memory measured.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { script, tmpDir } from './helpers.mjs';

export const PYSCAN = script('pyscan.py');

/** A repo whose Net.__init__ runs lines (strings of Python), and then makes self.fc = nn.Linear(4, 4): exactly 20 parameters. */
export function limitsRepo(lines, { top = [] } = {}) {
  const root = tmpDir('modelmap-limits-');
  fs.writeFileSync(path.join(root, 'm.py'), [
    'from torch import nn', ...top, 'class Net(nn.Module):', '    def __init__(self):', '        super().__init__()',
    ...lines.map((l) => '        ' + l), '        self.fc = nn.Linear(4, 4)', '',
  ].join('\n'));
  return root;
}

/** scan.mjs on root (its scan.json is read from the --out folder: --json through a pipe is cut at 64 KB when the output is large), bounded by timeoutMs. Resolves { status, ms, json, stderr }. */
export function scanTimed(root, { timeoutMs = 60000, env = {} } = {}) {
  return new Promise((resolve) => {
    const out = tmpDir('modelmap-limits-out-');
    const t0 = Date.now();
    // its own process group, so that a timeout also ends the python3 that scan.mjs started (killing node alone leaves it running)
    const p = spawn(process.execPath, [script('scan.mjs'), root, '--out', out], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stderr = '';
    p.stdout.on('data', () => {});
    p.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch { p.kill('SIGKILL'); } }, timeoutMs);
    p.on('close', (status) => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(fs.readFileSync(path.join(out, 'scan.json'), 'utf8')); } catch { /* no scan: the caller sees status and stderr */ }
      resolve({ status, ms: Date.now() - t0, json, stderr: stderr.slice(-300) });
    });
  });
}

/** The job scan.mjs would send for root's m.py. */
export const jobFor = (root, extra = {}) => ({ root, files: ['m.py'], rootClass: null, args: {}, config: null, dimNames: [], dimAttrs: [], ...extra });

// Runs pyscan.py the way scan.mjs does (python3 -I, the job on stdin) but inside a wrapper that reports the peak memory
// of the process: macOS counts ru_maxrss in bytes, Linux in kilobytes.
const WRAP = [
  'import runpy, sys, resource',
  "sys.argv = ['pyscan.py']",
  'try:',
  '    runpy.run_path(' + JSON.stringify(PYSCAN) + ", run_name='__main__')",
  'finally:',
  '    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss',
  "    sys.stderr.write('PEAKRSS %d\\n' % (r if sys.platform == 'darwin' else r * 1024))",
].join('\n');

/** pyscan.py on a job, bounded by timeoutMs. Returns { status, stdout, result (parsed), peak (bytes), ms }. */
export function pyscanMeasured(job, { timeoutMs = 60000, env = {} } = {}) {
  const t0 = Date.now();
  const r = spawnSync('python3', ['-I', '-c', WRAP], { input: JSON.stringify(job), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 512 * 1024 * 1024, env: { ...process.env, ...env } });
  let result = null;
  try { result = JSON.parse(r.stdout); } catch { /* the caller sees stderr */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr || '', result, peak: Number(/PEAKRSS (\d+)/.exec(r.stderr || '')?.[1] || 0), ms: Date.now() - t0 };
}
