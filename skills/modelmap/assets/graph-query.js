// Derived from floorplan v0.11.0 (MIT): skills/floorplan/assets/graph-query.js
// modelmap graph queries, shared by the viewer (as page tools for the Claude app) and by
// modelmap/query.mjs (as a CLI that the Claude Code CLI or Codex calls). Plain script: no imports, no exports.
// Item ids: n:<node id>. A node id is the module's instance path (blocks.0.attn); the model itself is n:root.
// Every number these lookups print is worked out here, in integers, so an answer can copy it and never has to
// do arithmetic of its own. The virtual nodes of a block flow (its in, out and ops; virtual: true) are not modules:
// find, overview, the children of show and the params breakdowns never list them. flow <id> lists a block's tensor
// edges, whose shapes are estimates.

function createGraphQuery(G) {
  const nodes = new Map(G.nodes.map((n) => [n.id, n]));
  const kidsOf = new Map();
  for (const n of G.nodes) if (n.parent != null && !n.virtual) { if (!kidsOf.has(n.parent)) kidsOf.set(n.parent, []); kidsOf.get(n.parent).push(n.id); }
  // a member of a folded run (blocks.3) is shown by the run's card (blocks.0)
  const foldOf = new Map();
  for (const n of G.nodes) for (const p of n.m?.fold?.members || []) if (p !== n.id && !nodes.has(p)) foldOf.set(String(p), n.id);

  const M = (n) => n.m || {};
  const isInt = (v) => Number.isSafeInteger(v);
  const num = (v) => isInt(v) ? String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',').replace(/^/, v < 0 ? '-' : '') : String(v);
  /** A parameter record as the map shows it: { v, src, shown, lowerBound?, why? }. */
  // as the map's cards show it: ? for nothing known, ≥ for a sum with an unknown part
  const shownOf = (v, lowerBound) => v === null || (lowerBound && v === 0) ? '?' : (lowerBound ? '≥ ' : '') + num(v);
  const rec = (p) => {
    const v = p && (isInt(p.v) || p.v === null) ? p.v : null;
    const out = { v, src: (p && p.src) || 'code', shown: shownOf(v, !!(p && p.lowerBound)) };
    if (p && p.lowerBound) { out.lowerBound = true; out.why = String(p.why || 'a part is unknown'); }
    return out;
  };
  /** A share in percent with one decimal, from the two integers shown next to it. */
  const share = (part, whole) => isInt(part) && isInt(whole) && whole > 0 ? (Math.round(part * 1000 / whole) / 10).toFixed(1) + '%' : null;
  const where = (d) => d && d.file ? d.file + (d.line != null ? ':' + d.line : '') : null;
  /** What a card adds to its parent's count: a folded run all its copies, a shared module nothing (it counts at its first path). */
  function contributes(n) {
    const m = M(n), P = rec(m.params);
    if (m.alias !== undefined) return { v: 0, shared: true };
    if (m.fold) {
      const total = isInt(m.fold.total) ? m.fold.total : isInt(P.v) && isInt(m.fold.n) ? P.v * m.fold.n : null;
      return { v: total, copies: m.fold.n, perCopy: P.v, lowerBound: !!P.lowerBound };
    }
    return { v: P.v, lowerBound: !!P.lowerBound };
  }
  const nameOf = (n) => {
    if (n.parent == null) return M(n).cls || n.label;
    if (M(n).fold && n.parent !== 'root') return n.parent + '.' + n.label;
    return M(n).fold ? n.label : n.id;
  };

  function brief(id) {
    const s = String(id || '');
    const n = s.startsWith('n:') ? nodes.get(s.slice(2)) : null;
    return n ? { id: 'n:' + n.id, type: n.kind, name: nameOf(n), class: M(n).cls || '', params: rec(M(n).params).shown + (M(n).fold ? ' ×' + M(n).fold.n : ''), description: n.summary || '' } : null;
  }
  const exists = (id) => !!brief(id);

  /** Accepts an id, or what people naturally pass: a bare path, "root", a member of a folded run, [[n:id]]. */
  function normId(id) {
    let s = String(id ?? '').trim().replace(/^\[\[(.*)\]\]$/, '$1');
    if (brief(s)) return s;
    if (s.startsWith('n:')) s = s.slice(2);
    if (s === '' || s === 'root') return 'n:root';
    if (nodes.has(s)) return 'n:' + s;
    // blocks.3.attn: the card of blocks.3 is blocks.0, so its attn is blocks.0.attn
    const parts = s.split('.');
    for (let i = parts.length; i > 0; i--) {
      const head = parts.slice(0, i).join('.');
      if (foldOf.has(head)) { const t = [foldOf.get(head), ...parts.slice(i)].join('.'); if (nodes.has(t)) return 'n:' + t; }
    }
    return 'n:' + s;
  }
  function need(id) {
    const nid = normId(id), n = nodes.get(nid.slice(2));
    if (!n) throw new Error('Unknown id "' + String(id) + '". Use find first; ids look like n:root, n:blocks, n:blocks.0.attn.');
    return n;
  }
  const resolved = (id, n) => { const s = String(id ?? '').trim().replace(/^\[\[(.*)\]\]$/, '$1').replace(/^n:/, ''); return s && s !== n.id && s !== 'root' ? { resolvedFrom: s, note: s + ' is one of the folded copies shown by n:' + n.id } : {}; };

  const argText = (v) => v === null || typeof v !== 'object' ? String(v) : JSON.stringify(v);
  const FILLER = new Set(['how', 'many', 'much', 'does', 'do', 'the', 'a', 'an', 'is', 'are', 'where', 'what', 'which', 'of', 'to', 'for', 'in', 'on', 'and', 'or', 'it', 'with', 'module', 'modules', 'layer', 'layers', 'params', 'parameters']);
  function find(query, kind, limit = 15) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const terms = words.filter((t) => !FILLER.has(t)).length ? words.filter((t) => !FILLER.has(t)) : words;
    if (!terms.length) return [];
    const kinds = new Set(G.nodes.map((n) => n.kind));
    const scored = [];
    for (const n of G.nodes) {
      if (n.virtual) continue; // the in, out and ops of a flow are not modules
      if (kind && kinds.has(kind) && n.kind !== kind) continue;
      const m = M(n);
      const label = String(n.label || '').toLowerCase(), cls = String(m.cls || '').toLowerCase(), title = String(n.title || '').toLowerCase();
      const pth = n.id.toLowerCase(), desc = (String(n.summary || '') + ' ' + String(n.details || '')).toLowerCase();
      const args = Object.entries(m.args || {}).map(([k, r]) => k + '=' + argText(r && r.v)).join(' ').toLowerCase();
      let s = 0, hit = 0;
      for (const t of terms) {
        const sc = cls === t || label === t ? 30 : cls.startsWith(t) || label.startsWith(t) ? 20 : cls.includes(t) || label.includes(t) || title.includes(t) ? 12 : pth.includes(t) ? 7 : args.includes(t) ? 6 : desc.includes(t) ? 5 : 0;
        if (sc) { s += sc; hit++; }
      }
      // shallower cards first: the container before what it holds
      if (hit) scored.push([hit, s - pth.split('.').length * 0.5, n.id]);
    }
    const best = Math.max(0, ...scored.map((x) => x[0]));
    const floor = best === terms.length ? best : Math.max(1, Math.ceil(terms.length / 2));
    return scored.filter((x) => x[0] >= floor).sort((a, b) => b[0] - a[0] || b[1] - a[1])
      .slice(0, Math.min(Number(limit) || 15, 40)).map(([, , id]) => brief('n:' + id));
  }

  function childList(n) {
    return (kidsOf.get(n.id) || []).map((k) => {
      const c = nodes.get(k), x = contributes(c);
      return { id: 'n:' + k, name: nameOf(c), class: M(c).cls || '', params: x.v, shown: shownOf(x.v, x.lowerBound),
        ...(x.copies ? { copies: x.copies, perCopy: x.perCopy } : {}), ...(x.lowerBound ? { lowerBound: true } : {}), ...(x.shared ? { shared: 'counted at n:' + M(c).alias } : {}) };
    });
  }

  function show(id) {
    const n = need(id), m = M(n);
    const res = { ...brief('n:' + n.id), ...resolved(id, n) };
    if (n.title) res.title = n.title;
    if (n.details) res.details = n.details;
    if (n.parent != null) res.partOf = { id: 'n:' + n.parent, name: nameOf(nodes.get(n.parent)) };
    res.classKind = m.ckind || 'unknown';
    res.definedAt = where(m.def);
    if (m.container) res.container = m.container;
    res.arguments = Object.fromEntries(Object.entries(m.args || {}).map(([k, r]) => [k, { value: r ? r.v : null, src: (r && r.src) || 'code', ...(r && r.at ? { at: r.at } : {}) }]));
    if (m.argsMore) res.moreArguments = m.argsMore;
    res.params = rec(m.params);
    res.ownParams = isInt(m.own) ? m.own : 0;
    if (m.direct) res.direct = m.direct;
    res.bytes = { fp32: isInt(m.bytes?.fp32) ? m.bytes.fp32 : null };
    if (m.fold) { const x = contributes(n); res.fold = { copies: m.fold.n, perCopy: res.params.shown, total: x.v, totalShown: shownOf(x.v, x.lowerBound), members: m.fold.members, ...(m.fold.failing ? { failing: m.fold.failing, failingCount: m.fold.failingCount } : {}), ...(m.fold.notes ? { notes: m.fold.notes } : {}), ...(m.fold.weights ? { weights: m.fold.weights } : {}) }; }
    if (m.letter) res.letter = m.letter;
    if (m.pattern) res.pattern = m.pattern;
    if (m.alias !== undefined) res.alias = { sharesWeightsWith: normId(m.alias), note: 'the same module object as ' + m.alias + ': its parameters are counted once, there' };
    if (m.tied) res.tied = m.tied;
    if (m.why) res.unknownBecause = m.why;
    if (m.incomplete) res.incomplete = 'part of the constructor was skipped by the scan';
    if (m.notes) res.notes = m.notes;
    if (m.weights) res.weights = m.weights;
    if (m.check) res.weightsCheck = m.check;
    if (flowLinks.has(n.id)) res.flow = { edges: flowLinks.get(n.id).length, note: 'the data flow of forward(): run flow ' + 'n:' + n.id + '; its shapes are estimates' };
    const kids = childList(n);
    res.children = kids.slice(0, 30);
    if (kids.length > 30) res.moreChildren = kids.length - 30;
    return res;
  }

  /** The exact parameter count of a module and what it is made of, every sum and share worked out here. */
  function params(id, top = 10) {
    const n = need(id), m = M(n), P = rec(m.params);
    const res = { id: 'n:' + n.id, name: nameOf(n), class: m.cls || '', ...resolved(id, n), params: P, ownParams: isInt(m.own) ? m.own : 0, bytes: { fp32: isInt(m.bytes?.fp32) ? m.bytes.fp32 : null } };
    if (res.bytes.fp32 !== null) res.bytes.fp32Shown = num(res.bytes.fp32) + ' B';
    if (m.alias !== undefined) {
      const t = nodes.get(normId(m.alias).slice(2));
      res.alias = { sharesWeightsWith: normId(m.alias), note: 'This is the same module object as ' + m.alias + '. Its weights are shared: they are counted once, at ' + m.alias + ', and add 0 here.', ...(t ? { paramsThere: rec(M(t).params) } : {}) };
    }
    if (m.fold) {
      const x = contributes(n);
      res.fold = { copies: m.fold.n, perCopy: P.v, perCopyShown: P.shown, total: x.v, totalShown: shownOf(x.v, x.lowerBound), members: m.fold.members };
      if (res.bytes.fp32 !== null && isInt(m.fold.n)) { res.fold.bytesFp32Total = res.bytes.fp32 * m.fold.n; res.fold.bytesFp32TotalShown = num(res.fold.bytesFp32Total) + ' B'; }
      res.fold.note = 'The card stands for ' + m.fold.n + ' equal copies; params and the breakdown below are per copy.';
    }
    if (m.weights) res.weights = m.weights;
    if (m.check) res.weightsCheck = m.check;
    const kids = childList(n).sort((a, b) => (b.params ?? -1) - (a.params ?? -1));
    if (kids.length) {
      const known = kids.filter((k) => k.params !== null);
      let childrenSum = 0;
      for (const k of known) childrenSum += k.params;
      const whole = P.v;
      for (const k of kids) k.share = share(k.params, whole);
      const cut = Math.max(1, Math.min(Number(top) || 10, 100));
      const shownKids = kids.slice(0, cut), rest = kids.slice(cut);
      res.breakdown = {
        of: P.shown, ownParams: res.ownParams, ...(res.ownParams ? { ownShare: share(res.ownParams, whole) } : {}),
        children: shownKids,
        childrenSum: known.length === kids.length ? childrenSum : null,
        ...(known.length < kids.length ? { unknownChildren: kids.length - known.length } : {}),
      };
      if (rest.length) {
        let restSum = 0;
        for (const k of rest) restSum += k.params ?? 0;
        res.breakdown.more = { count: rest.length, params: restSum, shown: num(restSum), share: share(restSum, whole) };
      }
      const sum = res.breakdown.childrenSum === null ? null : res.ownParams + res.breakdown.childrenSum;
      res.breakdown.ownPlusChildren = sum;
      res.breakdown.addsUp = sum !== null && sum === whole;
    }
    return res;
  }

  // the data flow inside a block: links of kind "tensor" (descriptions' flows block, lib/flow.mjs), by the block
  const flowLinks = new Map();
  for (const l of G.links || []) {
    if (!l || l.k !== 'tensor') continue;
    const a = nodes.get(String(l.a).replace(/^n:/, ''));
    if (a && a.parent != null) { if (!flowLinks.has(a.parent)) flowLinks.set(a.parent, []); flowLinks.get(a.parent).push(l); }
  }
  /** An endpoint: a module's name and id, or "in", "out" or an op ("+ (add1)"), which are not modules and have no id. */
  const flowEnd = (id) => {
    const n = nodes.get(String(id).replace(/^n:/, ''));
    if (!n) return { name: String(id) };
    if (n.virtual) return { name: n.op ? n.label + ' (' + n.op.id + ')' : String(n.label) };
    return { name: String(n.label), id: 'n:' + n.id };
  };
  /** The tensor edges of a block's forward(), in the order Claude wrote them. Every shape is an estimate. */
  function flow(id) {
    const n = need(id), ls = flowLinks.get(n.id) || [];
    return {
      id: 'n:' + n.id, name: nameOf(n), class: M(n).cls || '', ...resolved(id, n), count: ls.length,
      edges: ls.map((l) => {
        const a = flowEnd(l.a), b = flowEnd(l.b);
        return { from: a.name, to: b.name, ...(a.id ? { fromId: a.id } : {}), ...(b.id ? { toId: b.id } : {}), shape: { v: l.shape && typeof l.shape.v === 'string' ? l.shape.v : null, src: (l.shape && l.shape.src) || 'estimate' },
          ...(l.skip ? { skip: true } : {}), ...(l.at ? { at: l.at } : {}), ...(l.d ? { d: l.d } : {}) };
      }),
      note: ls.length ? 'shapes are estimates: say so when you quote them' : 'no flow was written for this module (the "flows" block of descriptions/*.json)',
    };
  }

  function contract() {
    if (G.contract && typeof G.contract === 'object') return { available: true, ...G.contract };
    return { available: false, reason: 'The scan found no forward() method on the root model, so the map has no input and output contract.' };
  }

  /** The way through the module tree from one module to another: up to their common parent, then down. */
  function path(from, to) {
    const a = need(from), b = need(to);
    const up = (n) => { const out = []; for (let x = n; x; x = x.parent != null ? nodes.get(x.parent) : null) out.push(x.id); return out; };
    const ua = up(a), ub = up(b), common = ua.find((x) => ub.includes(x));
    const down = ub.slice(0, ub.indexOf(common)).reverse();
    const chain = [...ua.slice(0, ua.indexOf(common) + 1), ...down];
    const hops = [];
    for (let i = 1; i < chain.length; i++) hops.push({ from: brief('n:' + chain[i - 1]), to: brief('n:' + chain[i]), via: i <= ua.indexOf(common) ? 'part of' : 'contains' });
    return { found: true, common: brief('n:' + common), hops: hops.slice(0, 30) };
  }

  function overview() {
    const root = G.nodes.find((n) => n.parent == null) || G.nodes[0];
    const kids = childList(root);
    const P = rec(M(root).params);
    for (const k of kids) k.share = share(k.params, P.v);
    const unknown = G.nodes.filter((n) => !n.virtual).filter((n) => M(n).why || (M(n).params && M(n).params.lowerBound && !(kidsOf.get(n.id) || []).length)).slice(0, 12).map((n) => ({ id: 'n:' + n.id, class: M(n).cls || '', why: String(M(n).why || M(n).params.why || '') }));
    const c = contract();
    return {
      project: G.project?.name || '', summary: G.project?.summary || '',
      model: { id: 'n:' + root.id, class: M(root).cls || '', definedAt: where(M(root).def), params: P },
      counts: G.meta?.counts || {},
      parts: kids,
      ...(unknown.length ? { unknownParts: unknown } : {}),
      contract: c.available ? { available: true, inputs: (c.inputs || []).map((i) => i && i.name), dims: (c.dims || []).length } : { available: false },
      ...(G.meta?.weights ? { weights: G.meta.weights } : {}),
      ...((G.flows || []).length ? { flows: G.flows.map((f) => ({ title: f.title, steps: (f.steps || []).map((s) => s.ref + ' ' + (s.note || '')) })) } : {}),
    };
  }

  return { find, show, params, contract, flow, path, overview, exists, brief };
}

// What an answer looks like, for both engines (JSON Schema).
const FLOORPLAN_ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short title for the answer view, at most 6 words.' },
    answer: { type: 'string', description: 'The answer in Markdown, in Korean with the English term next to it, at most ~180 words. Every number copied from a lookup. Mention map items inline as [[id]].' },
    items: { type: 'array', description: '3-14 map items (modules such as n:blocks or n:blocks.0.attn) most relevant to the answer, most important first.', items: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string', description: 'Why this module matters here, at most 15 words.' } }, required: ['id', 'note'] } },
    steps: { type: 'array', description: 'Optional ordered walkthrough when the answer is a sequence (data moving through the modules in forward()). Empty otherwise.', items: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } }, required: ['id', 'note'] } },
    followups: { type: 'array', description: '2-3 short follow-up questions the person might ask next.', items: { type: 'string' } },
  },
  required: ['title', 'answer', 'items'],
};

// A requested flow: an ordered walkthrough of map items (JSON Schema).
const FLOORPLAN_FLOW_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short flow title, at most 6 words, e.g. "Encoder to surface decoder".' },
    description: { type: 'string', description: 'One sentence on what the flow shows.' },
    steps: { type: 'array', description: '3-9 steps in the order forward() runs them, each a module and what happens to the data there.', items: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string', description: 'What happens at this step, at most 18 words.' } }, required: ['id', 'note'] } },
  },
  required: ['title', 'steps'],
};

function floorplanFlowInstructions(G, engine) {
  return [
    'You build guided flows for an interactive map of the model "' + (G.project?.name || '') + '". A flow is an ordered walkthrough: each step is one map item (a module, id n:<instance path>; the model is n:root) and a note on what happens to the data there.',
    engine === 'cli'
      ? 'Find the modules with ' + '\x60node modelmap/query.mjs find "<words>"\x60 and \x60show <id>\x60; read the forward() code of their classes to confirm the order.'
      : 'Find the modules with the tools find_items, get_item and dependency_path.',
    'Follow the data through forward(), from the inputs to the outputs, in the order the code calls the modules. Use 3-9 steps.',
    'Write the notes in Korean with the English term next to it. Mention a shape or a number only when a lookup printed it.',
    'Reply with JSON only: {"title", "description", "steps": [{"id", "note"}]}. Only use ids the map gave you.',
  ].join('\n');
}

function floorplanAskInstructions(G, engine) {
  const q = '\x60node modelmap/query.mjs';
  const tools = engine === 'cli'
    ? 'Look things up from the shell; each prints JSON: ' + q + ' overview\x60, ' + q + ' find "<words>"\x60 (name, class, argument, path), ' + q + ' show <id>\x60 (class, arguments, parameters, children, notes), ' + q + ' params <id> [--top N]\x60 (exact count, per-child breakdown with shares, folded copies, shared weights), ' + q + ' contract\x60 (forward() inputs, outputs, shape symbols), ' + q + ' flow <id>\x60 (the tensor edges inside a block, with estimated shapes). You may Read or Grep the repo\'s source files to explain how something works.'
    : 'Look things up with the tools find_items and get_item (a module\'s class, arguments, parameter count and children). You cannot read source files; say so when a question needs the code.';
  return [
    'You answer questions about the model "' + (G.project?.name || '') + '" for a developer exploring an interactive map of its module tree. Map items are modules, ids n:<instance path>; the model itself is n:root.',
    tools,
    'Numbers: copy every number (parameters, bytes, shares, copies, shapes, dimensions) exactly as a lookup printed it (the shown field). Do no arithmetic yourself: no sums, products or percentages; when you need a total or a share, run the lookup that prints it. Never state a number that no lookup printed. A count with lowerBound is written with ≥ and its reason (why). Name the source tag (code, config, weights, estimate) when it matters.',
    'A shape taken from a flow (flow <id>, a tensor edge) is an estimate Claude wrote from reading forward(): when you quote it, call it an estimate (추정).',
    'What-if questions ("what if dim were 256?"): say that the map does not calculate what-if values yet. Do not invent a formula or a number.',
    'Use a few lookups, not dozens. Then reply with JSON only: {"title", "answer", "items", "steps", "followups"}.',
    '- answer: Markdown in Korean, with the English term next to the Korean word, e.g. 잔차 연결(residual connection); at most ~180 words. Refer to map items inline as [[id]], with ids a lookup printed.',
    '- items: the 3-14 modules that best show the answer, most important first, each with a note (at most 15 words).',
    '- steps: an ordered walkthrough when the answer is a sequence (data moving through forward()); otherwise [].',
    '- followups: 2-3 short follow-up questions, in Korean.',
    'Only use ids that the map gave you.',
  ].join('\n');
}
