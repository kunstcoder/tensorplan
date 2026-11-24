// Helpers for the flow tests (flow, describe, query): the fixture tests/fixtures/flow and the HAND-WRITTEN flows of its
// classes (examples written for the tests, not Claude's output).
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.mjs';

export const ROOT = fixture('flow');
/** The 1-based line of the first line of the fixture that holds text. */
export const lineOf = (text) => fs.readFileSync(path.join(ROOT, 'model.py'), 'utf8').split('\n').findIndex((l) => l.includes(text)) + 1;

export const BLOCK_FLOW = () => ({
  ops: [{ id: 'add1', op: 'add' }, { id: 'add2', op: 'add' }],
  edges: [
    { from: 'in', to: 'norm1', shape: '[B, N, D]', at: 'model.py:' + lineOf('x = x + self.attn') },
    { from: 'norm1', to: 'attn', shape: '[B, N, D]' },
    { from: 'attn', to: 'add1', shape: '[B, N, D]' },
    { from: 'in', to: 'add1', skip: true, shape: '[B, N, D]', d: 'residual: x is added as it is' },
    { from: 'add1', to: 'norm2', shape: '[B, N, D]', at: 'model.py:' + lineOf('x = x + self.mlp') },
    { from: 'norm2', to: 'mlp', shape: '[B, N, D]' },
    { from: 'mlp', to: 'add2', shape: '[B, N, D]' },
    { from: 'add1', to: 'add2', skip: true },
    { from: 'add2', to: 'out', shape: '[B, N, D]', at: 'model.py:' + lineOf('        return x') },
  ],
});
// Head has a child named "out": "self.out" names it, a bare "out" is what forward() returns
export const HEAD_FLOW = () => ({ edges: [{ from: 'in', to: 'proj' }, { from: 'proj', to: 'self.out', shape: '[B, N, 2]' }, { from: 'self.out', to: 'out' }] });
