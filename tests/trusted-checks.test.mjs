// The checks of lib/common.mjs that status.mjs (commit id and folder of a map's meta.repos) and open.mjs (the record of a running server) use
// for values read from files a scanned repo can commit: isGitObjectName, folderInside, validServerRecord, readServerRecord, verifiedStatus.
// The scripts that use them are tried in trusted-values.test.mjs (status.mjs), trusted-server.test.mjs, trusted-stop.test.mjs and
// trusted-flows.test.mjs (open.mjs, serve.mjs --stop). Everything runs in temporary folders, with stand-in servers on 127.0.0.1 port 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers-plugin.mjs';
import { posixOnly, standIn, sendJson, GOOD_TOKEN } from './helpers-trusted.mjs';
import * as common from '../skills/modelmap/scripts/lib/common.mjs';

const { isGitObjectName, folderInside, validServerRecord, readServerRecord, verifiedStatus } = common;

test('common: isGitObjectName accepts lowercase hex of 7 to 64 characters and nothing else', () => {
  for (const ok of ['abcdef1', '0123456789abcdef', 'a'.repeat(40), 'f'.repeat(64)]) assert.equal(isGitObjectName(ok), true, ok);
  for (const bad of ['abcdef', 'a'.repeat(65), 'ABCDEF1', 'abcdefg', '', ' abcdef1', 'abcdef1\n', 'abcdef1\n--stat', '--stat', 'HEAD', 'HEAD~1', 'main', 1234567, null, undefined, ['abcdef1'], {}, true]) assert.equal(isGitObjectName(bad), false, JSON.stringify(bad));
});

test('common: folderInside keeps a path inside the root, also through links, and says null otherwise', { skip: posixOnly }, () => {
  const t = tmp();
  try {
    fs.mkdirSync(path.join(t.dir, 'root', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(t.dir, 'outside'));
    fs.symlinkSync(path.join(t.dir, 'outside'), path.join(t.dir, 'root', 'link'));
    fs.symlinkSync(path.join(t.dir, 'root', 'sub'), path.join(t.dir, 'root', 'inlink'));
    const root = path.join(t.dir, 'root');
    for (const ok of [undefined, null, '', '.', './', 'sub', 'sub/', 'sub/..', 'inlink', 'does-not-exist', 'a..b', '..a', 'link/..']) assert.ok(folderInside(root, ok), JSON.stringify(ok));
    assert.equal(folderInside(root, 'sub'), path.join(root, 'sub'));
    for (const bad of ['..', '../outside', 'sub/../..', '/', root, '-x', '--output=x', 'link', 'link/x', 'link/x/y', 'link/../link', 'C:', 'C:\\x', '\\x', 'a\0', 5, ['.'], {}, true, 'x'.repeat(5000)]) assert.equal(folderInside(root, bad), null, JSON.stringify(bad));
  } finally { t.done(); }
});

const REC = { pid: 4242, port: 4378, url: 'http://127.0.0.1:4378', token: GOOD_TOKEN };
test('common: validServerRecord accepts what serve.mjs writes (and its extra fields) and nothing that points elsewhere or at a process of someone else', () => {
  assert.deepEqual(validServerRecord(REC), REC);
  assert.deepEqual(validServerRecord({ ...REC, hash: 'abc', startedAt: 'x', extra: 1 }), REC, 'extra fields are ignored, not passed on');
  assert.deepEqual(validServerRecord({ ...REC, url: 'http://127.0.0.1:4378/' }), REC, 'a trailing slash is the same address, rebuilt without it');
  assert.deepEqual(validServerRecord({ ...REC, token: 'a'.repeat(16) }), { ...REC, token: 'a'.repeat(16) });
  assert.deepEqual(validServerRecord({ ...REC, token: 'a'.repeat(64) }), { ...REC, token: 'a'.repeat(64) });
  const bad = {
    'null': null, 'an array': [REC], 'a string': JSON.stringify(REC), 'a number': 1,
    'pid 0': { ...REC, pid: 0 }, 'pid 1': { ...REC, pid: 1 }, 'pid -1': { ...REC, pid: -1 }, 'pid -4242': { ...REC, pid: -4242 }, 'a float pid': { ...REC, pid: 4242.5 },
    'a string pid': { ...REC, pid: '4242' }, 'a huge pid': { ...REC, pid: 2 ** 60 }, 'no pid': { ...REC, pid: undefined }, 'NaN pid': { ...REC, pid: NaN },
    'this process': { ...REC, pid: process.pid }, 'the parent of this process': { ...REC, pid: process.ppid },
    'port 0': { ...REC, port: 0, url: 'http://127.0.0.1:0' }, 'port 65536': { ...REC, port: 65536, url: 'http://127.0.0.1:65536' }, 'a float port': { ...REC, port: 4378.5 },
    'a string port': { ...REC, port: '4378' }, 'no port': { ...REC, port: undefined },
    'a different port in url': { ...REC, url: 'http://127.0.0.1:4379' }, 'no port in url': { ...REC, url: 'http://127.0.0.1' }, 'a leading zero': { ...REC, url: 'http://127.0.0.1:04378' },
    https: { ...REC, url: 'https://127.0.0.1:4378' }, credentials: { ...REC, url: 'http://user:pw@127.0.0.1:4378' }, 'a user only': { ...REC, url: 'http://user@127.0.0.1:4378' },
    'a path': { ...REC, url: 'http://127.0.0.1:4378/x' }, 'a query': { ...REC, url: 'http://127.0.0.1:4378/?a=1' }, 'a bare query': { ...REC, url: 'http://127.0.0.1:4378?a=1' },
    'a hash': { ...REC, url: 'http://127.0.0.1:4378/#x' }, localhost: { ...REC, url: 'http://localhost:4378' }, 'localhost.': { ...REC, url: 'http://localhost.:4378' },
    'IPv6': { ...REC, url: 'http://[::1]:4378' }, '127.0.0.1.evil': { ...REC, url: 'http://127.0.0.1.evil.example:4378' }, '127.0.0.1.': { ...REC, url: 'http://127.0.0.1.:4378' },
    'another address': { ...REC, url: 'http://127.0.0.2:4378' }, 'a decimal address': { ...REC, url: 'http://2130706433:4378' }, 'hex address': { ...REC, url: 'http://0x7f.0.0.1:4378' },
    'a space': { ...REC, url: 'http://127.0.0.1:4378 ' }, 'a newline': { ...REC, url: 'http://127.0.0.1:4378\n' }, 'an uppercase scheme': { ...REC, url: 'HTTP://127.0.0.1:4378' },
    'no url': { ...REC, url: undefined }, 'a number url': { ...REC, url: 4378 }, 'an array url': { ...REC, url: ['http://127.0.0.1:4378'] },
    'a short token': { ...REC, token: 'abcdef012345678' }, 'a long token': { ...REC, token: 'a'.repeat(65) }, 'an uppercase token': { ...REC, token: 'A'.repeat(32) },
    'a token that is not hex': { ...REC, token: 'g'.repeat(32) }, 'a token with a newline': { ...REC, token: GOOD_TOKEN + '\n' }, 'x': { ...REC, token: 'x' }, 'no token': { ...REC, token: undefined }, 'a number token': { ...REC, token: 12345678901234567 },
  };
  for (const [name, v] of Object.entries(bad)) assert.equal(validServerRecord(v), null, name);
});

test('common: readServerRecord reads only a regular file of this user of at most 4 KB (not a link, not a folder, not another user\'s), then validates it', { skip: posixOnly }, () => {
  const t = tmp();
  try {
    const good = path.join(t.dir, 'good.json');
    fs.writeFileSync(good, JSON.stringify(REC), { mode: 0o600 });
    assert.deepEqual(readServerRecord(good).rec, REC);
    assert.equal(readServerRecord(good).raw, JSON.stringify(REC));
    // a record in a file that is not a plain file, is too big or is not valid
    fs.symlinkSync(good, path.join(t.dir, 'link.json'));
    assert.equal(readServerRecord(path.join(t.dir, 'link.json')).rec, null, 'a link to a good record');
    fs.mkdirSync(path.join(t.dir, 'dir.json'));
    assert.equal(readServerRecord(path.join(t.dir, 'dir.json')).rec, null, 'a folder');
    assert.equal(readServerRecord(path.join(t.dir, 'missing.json')).rec, null, 'no file');
    fs.writeFileSync(path.join(t.dir, 'big.json'), JSON.stringify(REC) + ' '.repeat(5000));
    assert.equal(readServerRecord(path.join(t.dir, 'big.json')).rec, null, '5 KB');
    fs.writeFileSync(path.join(t.dir, 'edge.json'), JSON.stringify(REC) + ' '.repeat(4096 - JSON.stringify(REC).length));
    assert.deepEqual(readServerRecord(path.join(t.dir, 'edge.json')).rec, REC, 'exactly 4 KB is still read');
    fs.writeFileSync(path.join(t.dir, 'junk.json'), 'not json');
    assert.equal(readServerRecord(path.join(t.dir, 'junk.json')).rec, null);
    // owned by another user: root's files cannot be made here, so the owner this user is compared with is the one that is changed
    const me = process.getuid();
    assert.deepEqual(readServerRecord(good, { uid: me }).rec, REC);
    assert.equal(readServerRecord(good, { uid: me + 1 }).rec, null, 'a file of another user');
    assert.equal(readServerRecord(good, { uid: 0 }).rec, me === 0 ? REC : null, 'a file that root would own');
  } finally { t.done(); }
});

test('common: verifiedStatus is a status only when the server answers 200 JSON with the record\'s pid and this map\'s root, with the token, and follows no redirect', { skip: posixOnly }, async () => {
  const t = tmp();
  const rootAlias = path.join(t.dir, 'alias');
  fs.mkdirSync(path.join(t.dir, 'root'));
  fs.symlinkSync(path.join(t.dir, 'root'), rootAlias);
  const other = await standIn();
  let s;
  const answers = {
    right: (req, res) => sendJson(res, 200, { pid: 4242, hash: 'h', tabs: 1, root: rootAlias }),
    'the same root by its real path': (req, res) => sendJson(res, 200, { pid: 4242, root: fs.realpathSync(path.join(t.dir, 'root')) }),
    'another pid': (req, res) => sendJson(res, 200, { pid: 4243, root: rootAlias }),
    'the pid as a string': (req, res) => sendJson(res, 200, { pid: '4242', root: rootAlias }),
    'another root': (req, res) => sendJson(res, 200, { pid: 4242, root: t.dir }),
    'a root that is not there': (req, res) => sendJson(res, 200, { pid: 4242, root: path.join(t.dir, 'nothing') }),
    'no root': (req, res) => sendJson(res, 200, { pid: 4242 }),
    'a root that is not a string': (req, res) => sendJson(res, 200, { pid: 4242, root: [rootAlias] }),
    '403': (req, res) => { res.writeHead(403); res.end(); },
    '204': (req, res) => { res.writeHead(204); res.end(); },
    'not JSON': (req, res) => { res.writeHead(200); res.end('<html>'); },
    'an array': (req, res) => sendJson(res, 200, [{ pid: 4242, root: rootAlias }]),
    'a redirect': (req, res) => { res.writeHead(302, { Location: 'http://127.0.0.1:' + other.port + '/api/status' }); res.end(); },
    'nothing at all (a timeout)': () => {},
  };
  try {
    const results = await Promise.all(Object.entries(answers).map(async ([name, fn]) => {
      const st = await standIn(fn);
      const rec = { pid: 4242, port: st.port, url: 'http://127.0.0.1:' + st.port, token: GOOD_TOKEN };
      const got = await verifiedStatus(rec, path.join(t.dir, 'root'));
      const seen = st.requests.map((r) => r.method + ' ' + r.url + ' ' + r.token);
      await st.close();
      return [name, got, seen];
    }));
    for (const [name, got, seen] of results) {
      const yes = name === 'right' || name === 'the same root by its real path';
      assert.equal(!!got, yes, name);
      assert.deepEqual(seen, ['GET /api/status ' + GOOD_TOKEN], name + ': one request, with the token');
    }
    assert.equal(other.requests.length, 0, 'a redirect was followed');
    // nothing listens: null, not an error
    assert.equal(await verifiedStatus({ ...REC, port: 1, url: 'http://127.0.0.1:1' }, t.dir), null);
  } finally { await other.close(); t.done(); }
});
