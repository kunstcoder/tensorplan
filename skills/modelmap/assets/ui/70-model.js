// modelmap: the model facts in the details panel. For a module: its parameters and where the number comes from,
// its size, where its class is defined, its arguments, the members of a folded run, shared weights, the weights
// file check and the scan's notes. For the overview: the model's total. Talks to the viewer only through
// window.Floorplan. Every text here comes from the scanned repo, so all of it goes through SC.h (or SC.hk for ids).
(() => {
  const SC = window.Floorplan;
  if (!SC) return;
  const G = SC.graph;
  if (!/^modelmap\//.test(G.schema || '')) return;
  const { h, hk } = SC;

  const style = document.createElement('style');
  style.textContent = `
.mm-sec .mm-big { font-size: 22px; font-weight: 650; letter-spacing: -.02em; font-variant-numeric: tabular-nums; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.mm-sec .mm-sub { color: var(--text-3); font-size: 12.5px; line-height: 1.55; margin-top: 4px; overflow-wrap: anywhere; }
.mm-sec .mm-why { color: var(--warn-text); background: var(--warn-bg); border-radius: 10px; padding: 7px 10px; font-size: 12.5px; line-height: 1.5; margin-top: 8px; overflow-wrap: anywhere; }
.mm-tag { font-size: 10.5px; font-weight: 600; letter-spacing: .02em; padding: 3px 7px; border-radius: 999px; color: var(--text-3); box-shadow: inset 0 0 0 1px var(--hair-2); vertical-align: 2px; }
.mm-tag.config { color: var(--n-block); } .mm-tag.weights { color: var(--ok); } .mm-tag.run { color: var(--n-attention); }
.mm-kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font-size: 12.5px; margin-top: 10px; }
.mm-kv > span:nth-child(odd) { color: var(--text-3); }
.mm-kv > span:nth-child(even) { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.mm-mono { font-family: var(--mono); font-size: 12px; }
table.mm-tbl { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 4px; table-layout: fixed; }
table.mm-tbl th { text-align: left; font-weight: 500; color: var(--text-3); padding: 4px 6px 4px 0; border-bottom: 1px solid var(--hair); }
table.mm-tbl td { padding: 5px 6px 5px 0; border-bottom: 1px solid var(--hair); vertical-align: top; overflow-wrap: anywhere; word-break: break-word; }
table.mm-tbl td.v, table.mm-tbl td.n { font-family: var(--mono); word-break: break-all; }
table.mm-tbl td:last-child { padding-right: 0; text-align: right; }
table.mm-tbl .l { color: var(--text-3); font-family: var(--mono); font-size: 10.5px; margin-top: 2px; word-break: break-all; }
.mm-list { margin: 4px 0 0; padding: 0; list-style: none; font-family: var(--mono); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.mm-list .more { font-family: var(--sans); color: var(--text-3); }
.mm-fail { margin-top: 6px; font-size: 12.5px; line-height: 1.5; overflow-wrap: anywhere; }
.mm-ok { color: var(--ok); font-weight: 600; } .mm-bad { color: var(--err-text); font-weight: 600; }
.mm-link { color: var(--text); text-decoration: underline; text-decoration-color: var(--hair-2); text-underline-offset: 3px; cursor: pointer; }
.mm-link:hover { text-decoration-color: currentColor; }
`;
  document.head.appendChild(style);

  // ---------- formatting ----------
  const num = (v) => Number(v).toLocaleString('en-US');
  const count = (p) => !p || p.v === null || p.v === undefined || (p.lowerBound && !p.v) ? '?' : (p.lowerBound ? '≥ ' : '') + num(p.v);
  const SRC = { code: 'code', config: 'config', weights: 'weights', run: 'run' };
  const tag = (src) => { const s = SRC[src] || 'code'; return '<span class="mm-tag ' + s + '" title="where this number comes from">' + s + '</span>'; };
  const bytes = (b) => {
    if (typeof b !== 'number' || !Number.isFinite(b)) return '?';
    const u = b >= 1 << 30 ? [b / (1 << 30), 'GiB'] : b >= 1 << 20 ? [b / (1 << 20), 'MiB'] : b >= 1024 ? [b / 1024, 'KiB'] : null;
    return num(b) + ' B' + (u ? ' (' + u[0].toFixed(1) + ' ' + u[1] + ')' : '');
  };
  const MAXV = 120;
  /** A value record's value as text: number, string, list, or what the scan knows about it. */
  function value(v) {
    let s;
    if (v === null) s = 'None';
    else if (typeof v === 'string') s = JSON.stringify(v);
    else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
    else if (Array.isArray(v)) s = '[' + v.map(value).join(', ') + ']';
    else if (v && typeof v === 'object') {
      if ('unknown' in v) return '?';
      if ('class' in v) s = String(v.class);
      else if ('ref' in v) s = String(v.ref);
      else if ('tensor' in v) s = 'tensor ' + value(v.tensor);
      else s = JSON.stringify(v);
    } else s = String(v);
    return s.length > MAXV ? s.slice(0, MAXV - 1) + '…' : s;
  }
  const isUnknown = (v) => v && typeof v === 'object' && !Array.isArray(v) && 'unknown' in v;
  const node = (id) => (typeof id === 'string' && id.startsWith('n:') ? SC.nodes.get(id.slice(2)) : null);
  /** A link to a module only when the map has it; otherwise the path as plain text. */
  const goLink = (p) => (SC.nodes.has(p) ? '<a class="mm-link mm-mono" data-go="' + hk('n:' + p) + '">' + h(p) + '</a>' : '<span class="mm-mono">' + h(p) + '</span>');
  const sec = (title, body, extra = '') => '<div class="sec mm-sec"><h3>' + h(title) + (extra ? ' <span class="c">' + extra + '</span>' : '') + '</h3>' + body + '</div>';

  // ---------- one module ----------
  function moduleSections(n) {
    const m = n.m, out = [];
    // what it is and how many parameters it holds
    let top = '';
    if (n.title) top += '<div class="mm-sub" style="margin:0 0 6px;font-size:13px;color:var(--text-2)">' + h(n.title) + '</div>';
    if (m.alias !== undefined) {
      top += '<div class="mm-big">shared</div><div class="mm-sub">The same module as ' + goLink(m.alias) + ', so it shares its weights. Its parameters count once, there.</div>';
    } else {
      top += '<div class="mm-big">' + h(count(m.params)) + ' ' + tag(m.params?.src) + '</div><div class="mm-sub">parameters' + (m.fold ? ' in each of the ' + h(m.fold.n) + ' copies' : '') + '</div>';
      if (m.params?.lowerBound) top += '<div class="mm-why">≥ means at least: a part is not known' + (m.params.why ? '. ' + h(m.params.why) : '.') + '</div>';
    }
    const kv = [];
    if (m.fold) kv.push(['All ' + h(m.fold.n) + ' copies', 'total' in m.fold ? h(num(m.fold.total)) : '≥ ' + h(num((m.params?.v || 0) * m.fold.n))]);
    if (m.fold?.weights) kv.push(['Weights, all copies', h(num(m.fold.weights.params)) + ' ' + tag('weights') + (m.fold.weights.members < m.fold.n ? ' <span style="color:var(--text-3)">(' + h(m.fold.weights.members) + ' of ' + h(m.fold.n) + ' copies in the file)</span>' : '')]);
    if (m.alias === undefined) kv.push(['Size in fp32', h(bytes(m.bytes?.fp32)) + (m.params?.lowerBound ? ' or more' : '')]);
    if (m.alias === undefined && m.own && (n.parent === null || SC.children('n:' + n.id).length)) kv.push(['Its own', h(num(m.own)) + ' (parameters held directly, not in a submodule)']);
    if (m.weights) {
      const w = m.weights;
      const dt = w.dtypes && typeof w.dtypes === 'object' ? Object.entries(w.dtypes).map(([k, v]) => h(k) + ' ' + h(num(v))).join(', ') : '';
      kv.push(['In the weights', h(num(w.params)) + ' ' + tag('weights')]);
      if (typeof w.bytes === 'number') kv.push(['Weights bytes', h(bytes(w.bytes)) + (dt ? ' · ' + dt : '')]);
    }
    kv.push(['Class', '<span class="mm-mono">' + h(m.cls) + '</span> <span style="color:var(--text-3)">(' + h(m.ckind) + ')</span>']);
    if (m.def) kv.push(['Defined in', '<span class="mm-mono">' + h(m.def.file) + (m.def.line ? ':' + h(m.def.line) : '') + '</span>']);
    kv.push(['Path', '<span class="mm-mono">' + h(n.parent === null ? '(root)' : n.id) + '</span>']);
    if (m.container) kv.push(['Container', h({ list: 'ModuleList', seq: 'Sequential', dict: 'ModuleDict' }[m.container] || m.container)]);
    if (m.pattern) kv.push(['Pattern', '<span class="mm-mono">' + h(m.pattern.split('').join(' ')) + '</span>']);
    if (m.letter) kv.push(['Pattern letter', '<span class="mm-mono">' + h(m.letter) + '</span>']);
    if (m.tied) for (const [k, p] of Object.entries(m.tied)) kv.push(['Tied ' + h(k), 'shares its ' + h(k) + ' with ' + goLink(String(p))]);
    top += '<div class="mm-kv">' + kv.map(([k, v]) => '<span>' + k + '</span><span>' + v + '</span>').join('') + '</div>';
    if (m.why) top += '<div class="mm-why">' + h(m.why) + '</div>';
    out.push('<div class="sec mm-sec">' + top + '</div>');

    // the weights file check
    if (m.check) {
      const c = m.check, failing = Array.isArray(m.fold?.failing) ? m.fold.failing : [];
      const OK = '<span class="mm-ok">✓</span> ', BAD = '<span class="mm-bad">✗</span> ';
      let body = '', ownOk = c.ok !== false;
      if (m.fold) {
        // a folded run: the verdict covers every copy; the cards inside are the first copy's
        const first = String(m.fold.members[0] || '');
        const short = (p) => String(p).split('.').slice(-2).join('.');
        ownOk = !failing.some((f) => f.member === first);
        body += '<div>' + (c.ok === false ? BAD + 'not every copy matches the weights file' : OK + 'all ' + h(m.fold.n) + ' copies match the weights file') + '</div>';
        for (const f of failing) body += '<div class="mm-fail">' + BAD + 'differs in ' + h(short(f.member)) + ': <span class="mm-mono">' + h(f.key) + '</span> '
          + (f.missing ? 'is missing' : f.expected === null && f.found === null ? 'does not match' : 'expected ' + h(value(f.expected)) + ' found ' + h(value(f.found))) + '</div>';
        if ((m.fold.failingCount || 0) > failing.length) body += '<div class="mm-sub">and ' + h(m.fold.failingCount - failing.length) + ' more</div>';
        body += '<div class="mm-sub" style="margin:10px 0 4px">The cards inside are those of the first copy, ' + goLink(first) + '. Its own check:</div>';
      }
      body += '<div>' + (ownOk ? OK : BAD)
        + h(num(c.foundKeys ?? 0)) + ' of ' + h(num(c.expectedKeys ?? 0)) + ' tensors found' + (c.file ? ' in <span class="mm-mono">' + h(c.file) + '</span>' : '') + '</div>';
      if (typeof c.codeParams === 'number' || typeof c.weightParams === 'number') body += '<div class="mm-sub">code ' + h(num(c.codeParams ?? 0)) + ' · weights ' + h(num(c.weightParams ?? 0)) + '</div>';
      if (Array.isArray(c.missing) && c.missing.length) body += '<div class="mm-sub">missing</div><ul class="mm-list">' + c.missing.slice(0, 5).map((k) => '<li>' + h(k) + '</li>').join('') + '</ul>';
      if (Array.isArray(c.mismatched) && c.mismatched.length) {
        body += '<table class="mm-tbl"><thead><tr><th>tensor</th><th>expected</th><th>found</th></tr></thead><tbody>'
          + c.mismatched.slice(0, 5).map((x) => '<tr><td class="n">' + h(x?.key) + '</td><td class="v">' + h(value(x?.expected)) + '</td><td class="v">' + h(value(x?.found)) + '</td></tr>').join('') + '</tbody></table>';
      }
      if (c.partial) body += '<div class="mm-sub">Checked in part: some modules here are not known to the scan, so their tensors were not compared.</div>';
      out.push(sec('Weights file', body));
    }

    // the arguments it was built with
    const args = Object.entries(m.args || {});
    if (args.length) {
      const rows = args.map(([k, r]) => {
        const v = r?.v;
        return '<tr><td class="n">' + h(/^\d+$/.test(k) ? '(' + k + ')' : k) + '</td><td class="v">' + h(value(v))
          + (isUnknown(v) ? '<div class="l" style="font-family:var(--sans)">' + h(v.unknown) + '</div>' : '') + (r?.at ? '<div class="l">' + h(r.at) + '</div>' : '') + '</td><td>' + tag(r?.src) + '</td></tr>';
      }).join('');
      out.push(sec('Arguments', '<table class="mm-tbl"><colgroup><col style="width:36%"><col><col style="width:64px"></colgroup><thead><tr><th>name</th><th>value · set at</th><th style="text-align:right">tag</th></tr></thead><tbody>' + rows + '</tbody></table>'
        + (m.argsMore ? '<div class="mm-sub">and ' + h(m.argsMore) + ' more</div>' : ''), String(args.length + (m.argsMore || 0))));
    }

    // the members of a folded run
    if (m.fold && Array.isArray(m.fold.members)) {
      const mem = m.fold.members;
      out.push(sec('Folded copies', '<div class="mm-sub" style="margin-top:0">Same class and the same arguments, so they show as one card.</div><ul class="mm-list">'
        + mem.slice(0, 8).map((p) => '<li>' + goLink(String(p)) + '</li>').join('') + (mem.length > 8 ? '<li class="more">and ' + h(mem.length - 8) + ' more</li>' : '') + '</ul>', String(mem.length)));
    }

    // the nn.Parameter a module holds itself, when the scan lists them
    if (Array.isArray(m.direct) && m.direct.length) out.push(sec('Direct parameters', '<table class="mm-tbl"><colgroup><col style="width:36%"><col><col style="width:64px"></colgroup><thead><tr><th>name</th><th>shape</th><th style="text-align:right">tag</th></tr></thead><tbody>'
      + m.direct.map((p) => '<tr><td class="n">' + h(p.name) + '</td><td class="v">' + h(value(p.shape)) + '</td><td>' + tag(p.src) + '</td></tr>').join('') + '</tbody></table>', String(m.direct.length)));

    // what the scan noticed (for a folded run, also what only another copy has)
    const notes = (Array.isArray(m.notes) ? m.notes : []).concat(Array.isArray(m.fold?.notes) ? m.fold.notes : []).slice(0, 12);
    if (notes.length || m.incomplete) out.push(sec('Scan notes', (m.incomplete ? '<div class="mm-why" style="margin-top:0">Part of the constructor was skipped, so the count is a lower bound.</div>' : '')
      + (notes.length ? '<ul class="mm-list" style="font-family:var(--sans)">' + notes.map((t) => '<li>' + h(t) + '</li>').join('') + '</ul>' : '')));
    return out.join('');
  }

  SC.addPanelSection('item', (id) => {
    const n = node(id);
    if (!n || !n.m) return null;
    return { html: moduleSections(n), top: true };
  });

  // ---------- the overview ----------
  SC.addPanelSection('overview', () => {
    const r = G.nodes.find((x) => x.parent === null);
    if (!r || !r.m) return null;
    const c = G.meta?.counts || {};
    let body = '<div class="mm-big">' + h(count(r.m.params)) + ' ' + tag(r.m.params?.src) + '</div><div class="mm-sub">parameters in ' + h(r.m.cls) + '</div>';
    if (r.m.params?.lowerBound) body += '<div class="mm-why">≥ means at least' + (r.m.params.why ? ': ' + h(r.m.params.why) : '.') + '</div>';
    body += '<div class="mm-kv"><span>Size in fp32</span><span>' + h(bytes(r.m.bytes?.fp32)) + (r.m.params?.lowerBound ? ' or more' : '') + '</span>'
      + '<span>Unknown parts</span><span>' + h(num(c.unknownParts || 0)) + '</span>'
      + '<span>Modules</span><span>' + h(num(c.modules || 0)) + '</span>';
    // the weights file: what it holds and how it matches the code (scan.weights, see lib/safetensors.mjs)
    const w = G.meta?.weights;
    if (w && typeof w === 'object') {
      const differ = Number(w.differModules) || 0, extra = Number(w.unmatchedKeys) || 0;
      body += '<span>Weights</span><span>' + (differ || extra ? '<span class="mm-bad">✗</span> ' : '<span class="mm-ok">✓</span> ') + h(num(w.tensors || 0)) + ' tensors, ' + h(num(w.totalParams || 0)) + ' values'
        + ' · ' + h(num(w.matchedModules || 0)) + ' modules match, ' + h(num(differ)) + ' differ, ' + h(num(w.uncheckedModules || 0)) + ' unchecked'
        + (extra ? ' · ' + h(num(extra)) + ' tensors the code does not make' : '')
        + (Array.isArray(w.files) && w.files.length ? ' <span style="color:var(--text-3)">(' + h(w.files.slice(0, 3).join(', ')) + ')</span>' : '') + '</span>';
      const probs = (Array.isArray(w.problems) ? w.problems : []).slice(0, 3);
      if (probs.length) body += '<span></span><span class="mm-mono" style="color:var(--err-text)">' + probs.map(h).join('<br>') + (w.problems.length > 3 ? '<br>…' : '') + '</span>';
      if (Array.isArray(w.errors) && w.errors.length) body += '<span></span><span style="color:var(--err-text)">' + w.errors.slice(0, 3).map(h).join('<br>') + '</span>';
    }
    const cf = G.meta?.config;
    if (cf && typeof cf === 'object') body += '<span>Config</span><span><span class="mm-mono">' + h(cf.file) + (cf.key ? ' › ' + h(cf.key) : '') + '</span>' + (cf.arg ? ' fills <span class="mm-mono">' + h(cf.arg) + '</span> ' + tag('config') : '') + (cf.note ? '<br><span style="color:var(--warn-text)">' + h(cf.note) + '</span>' : '') + '</span>';
    body += '</div>';
    return { html: '<div class="sec mm-sec"><h3>Parameters</h3>' + body + '</div>', top: true };
  });
})();
