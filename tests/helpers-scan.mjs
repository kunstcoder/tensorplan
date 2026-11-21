// Helpers for the scan input tests (config files, safetensors). Owned by the scan tests; tests/helpers.mjs stays as it is.
import fs from 'node:fs';
import path from 'node:path';
import { node, script, tmpDir } from './helpers.mjs';

const BYTES = { F64: 8, F32: 4, F16: 2, BF16: 2, I64: 8, I32: 4, I16: 2, I8: 1, U8: 1, BOOL: 1 };

/**
 * Write a safetensors file: 8 bytes of header size, the JSON header, then zero bytes for the data.
 * entries: [[name, dtype, shape], ...]. The data part is made with truncate, so a large model costs no disk.
 */
export function writeSafetensors(file, entries, { metadata = { format: 'pt' } } = {}) {
  const head = {};
  let off = 0;
  for (const [name, dtype, shape] of entries) {
    const n = shape.reduce((a, b) => a * b, 1) * (BYTES[dtype] ?? 1);
    head[name] = { dtype, shape, data_offsets: [off, off + n] };
    off += n;
  }
  if (metadata) head.__metadata__ = metadata;
  writeRaw(file, JSON.stringify(head), { dataBytes: off });
  return file;
}

/** Write a file with any header text. sizeField overrides the 8-byte size (a BigInt), dataBytes adds zeros. */
export function writeRaw(file, headerText, { sizeField, dataBytes = 0 } = {}) {
  const js = Buffer.from(headerText, 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(sizeField ?? BigInt(js.length));
  fs.writeFileSync(file, Buffer.concat([len, js]));
  if (dataBytes) fs.truncateSync(file, 8 + js.length + dataBytes);
  return file;
}

/** Run scan.mjs; returns { status, stdout, stderr, json } (json is the parsed scan.json when the scan ran). */
export function runScan(root, extra = []) {
  const out = tmpDir();
  const r = node(script('scan.mjs'), [root, '--out', out, ...extra]);
  const f = path.join(out, 'scan.json');
  return { ...r, json: fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null };
}

/** Every node of a scan tree, depth first. */
export function allNodes(tree) {
  const out = [];
  const walk = (n) => { out.push(n); (n.children || []).forEach(walk); };
  walk(tree);
  return out;
}
