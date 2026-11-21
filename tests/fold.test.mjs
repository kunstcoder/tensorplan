import test from 'node:test';
import assert from 'node:assert/strict';
import { foldChildren, foldTree, pattern, signature } from '../skills/modelmap/scripts/lib/fold.mjs';

const block = (i, extra = {}) => ({ name: String(i), path: 'blocks.' + i, kind: 'repo', cls: 'Block', args: { dim: { v: 8, at: 'm.py:' + (10 + i) }, ...extra }, params: { v: 100, src: 'code' }, children: [] });
const list = (kids) => ({ kind: 'torch', cls: 'ModuleList', container: 'list', children: kids });

test('equal siblings of a list fold into one ×N card', () => {
  const f = foldChildren(list([block(0), block(1), block(2)]));
  assert.equal(f.length, 1);
  assert.equal(f[0].fold.n, 3);
  assert.deepEqual(f[0].fold.members, ['blocks.0', 'blocks.1', 'blocks.2']);
  assert.equal(f[0].fold.total, 300);
});

test('the place where a value was written does not make siblings different', () => {
  assert.equal(signature(block(0)), signature(block(5)));
});

test('one different argument keeps every card and gives each a letter', () => {
  const p = list([block(0), block(1, { attn: { v: { class: 'Cross' } } }), block(2), block(3, { attn: { v: { class: 'Cross' } } })]);
  const f = foldChildren(p);
  assert.equal(f.length, 4);
  assert.equal(pattern(p), 'ABAB');
});

test('a different class is a different card', () => {
  const other = { ...block(1), cls: 'Perceiver' };
  assert.equal(pattern(list([block(0), other, block(2)])), 'ABA');
});

test('siblings that are not in an indexed container never fold', () => {
  const parent = { kind: 'repo', cls: 'Attn', children: [block(0), block(1)] };
  assert.equal(foldChildren(parent).length, 2);
  assert.equal(pattern(parent), null);
});

test('an unknown module never folds', () => {
  const u = (i) => ({ name: String(i), kind: 'unknown', why: 'not known', children: [] });
  assert.equal(foldChildren(list([u(0), u(1)])).length, 2);
});

test('a list of one module stays as it is', () => {
  assert.equal(foldChildren(list([block(0)])).length, 1);
  assert.equal(foldChildren(list([block(0)]))[0].fold, undefined);
});

test('foldTree folds at every depth and keeps the original tree', () => {
  const inner = list([block(0), block(1)]);
  const outer = { kind: 'repo', cls: 'Net', children: [{ ...inner, name: 'blocks' }] };
  const folded = foldTree(outer);
  assert.equal(folded.children[0].children.length, 1);
  assert.equal(outer.children[0].children.length, 2);
});
