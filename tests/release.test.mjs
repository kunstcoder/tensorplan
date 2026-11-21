// Release consistency: the plugin manifest and the marketplace entry describe the same plugin and version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repo, SKILL } from './helpers-plugin.mjs';

const json = (p) => JSON.parse(fs.readFileSync(path.join(repo, p), 'utf8'));
const plugin = json('.claude-plugin/plugin.json');
const market = json('.claude-plugin/marketplace.json');

test('release: plugin.json version equals the marketplace entry version, and both are x.y.z', () => {
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
  assert.equal(market.plugins.length, 1, 'one plugin in the marketplace');
  assert.equal(market.plugins[0].version, plugin.version);
});

test('release: the plugin, its marketplace entry, the marketplace and the skill are all named modelmap', () => {
  assert.equal(plugin.name, 'modelmap');
  assert.equal(market.name, 'modelmap');
  assert.equal(market.plugins[0].name, plugin.name);
  assert.match(fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8'), /^---\nname: modelmap\n/);
});

test('release: the author is a name only (no email), the same in both manifests', () => {
  assert.deepEqual(Object.keys(plugin.author), ['name']);
  assert.deepEqual(market.owner, plugin.author);
  assert.doesNotMatch(JSON.stringify([plugin, market]), /@[\w-]+\.[\w.]+/, 'no email address');
});
