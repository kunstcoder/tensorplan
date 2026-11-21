// Helpers for tests/build.test.mjs: scan a folder and build its map into a temporary folder.
import fs from 'node:fs';
import path from 'node:path';
import { node, script, tmpDir } from './helpers.mjs';

/** Scan root into <out>/.cache/scan.json (the default place build.mjs reads). Returns out. */
export function scanInto(root, extra = [], out = tmpDir('modelmap-build-')) {
  const r = node(script('scan.mjs'), [root, '--out', path.join(out, '.cache'), ...extra]);
  if (r.status !== 0) throw new Error('scan failed: ' + r.stderr);
  return out;
}

/** Run build.mjs for root into out. Returns { status, stdout, stderr }. */
export const build = (root, out, extra = []) => node(script('build.mjs'), [root, '--out', out, ...extra]);

/** What a build wrote: the graph, the page and the graph inside the page. */
export function readMap(out) {
  const graph = JSON.parse(fs.readFileSync(path.join(out, 'graph.json'), 'utf8'));
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  return { graph, html, byId: new Map(graph.nodes.map((n) => [n.id, n])) };
}

/** A repo with two equal blocks (Linear(4, 4) each) and a weights file in which blocks.1.fc.weight has the wrong
 *  shape when bad is true. Returns { root, weights }. */
export function twoBlockRepo(writeSafetensors, { bad = true } = {}) {
  const root = tmpDir('modelmap-fold-');
  fs.writeFileSync(path.join(root, 'm.py'), [
    'from torch import nn',
    'class Block(nn.Module):',
    '    def __init__(self, dim):',
    '        super().__init__()',
    '        self.fc = nn.Linear(dim, dim)',
    'class Net(nn.Module):',
    '    def __init__(self, dim=4):',
    '        super().__init__()',
    '        self.blocks = nn.ModuleList([Block(dim) for _ in range(2)])',
    '',
  ].join('\n'));
  const weights = path.join(tmpDir('modelmap-weights-'), 'w.safetensors');
  writeSafetensors(weights, [
    ['blocks.0.fc.weight', 'F32', [4, 4]], ['blocks.0.fc.bias', 'F32', [4]],
    ['blocks.1.fc.weight', 'F32', bad ? [4, 2] : [4, 4]], ['blocks.1.fc.bias', 'F32', [4]],
  ]);
  return { root, weights };
}

/** A tiny repo whose class arguments carry hostile text, a very long string and many arguments. */
export function hostileRepo(evil) {
  const root = tmpDir('modelmap-hostile-');
  const many = Array.from({ length: 15 }, (_, i) => 'a' + i + '=' + i).join(', ');
  fs.writeFileSync(path.join(root, 'm.py'), [
    'from torch import nn',
    'class Part(nn.Module):',
    '    def __init__(self, name="x", note="y", ' + many + '):',
    '        super().__init__()',
    '        self.fc = nn.Linear(2, 2)',
    'class Net(nn.Module):',
    '    def __init__(self):',
    '        super().__init__()',
    '        self.part = Part(name=' + JSON.stringify(evil) + ', note="' + 'z'.repeat(500) + '")',
    '',
  ].join('\n'));
  return root;
}
