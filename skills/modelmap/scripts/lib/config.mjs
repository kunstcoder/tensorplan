// modelmap config.mjs: read the config file of a model (JSON, or YAML through yaml.mjs). Written for modelmap.
//
// loadConfig(file, { key }) returns { data, file, lines? } or { error }. It never throws.
//   key   a dotted path that selects a nested section, for example "model.encoder"
//   lines (YAML only) mirrors data: every scalar leaf gives its 1-based line (see yaml.mjs)
// It reads only the file named, and refuses files over 1 MB.
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';

export const MAX_CONFIG_BYTES = 1024 * 1024;

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function loadConfig(file, { key } = {}) {
  try {
    const ext = path.extname(String(file)).toLowerCase();
    if (!['.json', '.yaml', '.yml'].includes(ext)) return { error: 'a config file must end in .json, .yaml or .yml: ' + file };
    let st;
    try { st = fs.statSync(file); } catch { return { error: 'config file not found: ' + file }; }
    if (!st.isFile()) return { error: 'the config is not a file: ' + file };
    if (st.size > MAX_CONFIG_BYTES) return { error: 'the config file is larger than 1 MB: ' + file };
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    let data, lines;
    if (ext === '.json') {
      try { data = JSON.parse(text); } catch (e) { return { error: 'the config is not valid JSON: ' + String(e.message).slice(0, 120) }; }
    } else {
      const r = parseYaml(text, { lines: true });
      if (r.error) return { error: 'the config could not be read' + (r.line ? ' at line ' + r.line : '') + ': ' + r.error };
      data = r.value;
      lines = r.lines;
    }
    if (key !== undefined && key !== null && key !== '' && key !== true) {
      for (const seg of String(key).split('.')) {
        const has = isMap(data) ? Object.prototype.hasOwnProperty.call(data, seg)
          : Array.isArray(data) && /^[0-9]+$/.test(seg) && +seg < data.length;
        if (!has) return { error: 'the config has no section "' + key + '" (stopped at "' + seg + '")' };
        data = data[seg];
        lines = lines && typeof lines === 'object' ? lines[seg] : undefined;
      }
    }
    return lines === undefined ? { data, file } : { data, file, lines };
  } catch (e) {
    return { error: 'the config could not be read: ' + String(e && e.message).slice(0, 120) };
  }
}
