// Derived from floorplan v0.11.0 (MIT): skills/floorplan/assets/ui/40-tour.js
// "Start here": a calm one-minute tour on first open. Steps come from graph.tour when it has some; otherwise
// modelmap builds them here from the graph: the whole model, its largest part, a repeated block, a block's data flow
// (its shapes are estimates), how to read a number, and the weights check. The text is Korean with the English term in brackets; every number is read
// from the graph, never written into the text.
(() => {
  const SC = window.Floorplan;
  if (!SC) return;
  const G = SC.graph;
  const { h } = SC;
  const SEEN = 'tour-seen:' + (G.project?.name || G.meta?.rootName || 'map');

  const style = document.createElement('style');
  style.textContent = `
#tour { position: fixed; left: 16px; bottom: 76px; width: min(360px, calc(100vw - 32px)); padding: 16px 16px 12px 20px; border-radius: var(--r-panel); z-index: 6; animation: tourIn .4s var(--ease); }
#tour[hidden] { display: none; }
#tour .tk { font-size: 12px; color: var(--text-3); margin-bottom: 4px; display: flex; gap: 6px; align-items: center; }
#tour .tk i { width: 3px; height: 3px; border-radius: 50%; background: var(--text-4); }
#tour .tt { font-size: 16px; font-weight: 600; letter-spacing: -.01em; line-height: 1.35; padding-right: 22px; }
#tour .tn { color: var(--text-2); line-height: 1.55; margin-top: 6px; font-size: 13.5px; }
#tour .tip { color: var(--text-3); font-size: 12px; line-height: 1.5; margin-top: 10px; }
#tour .tf { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
#tour .dots { display: flex; gap: 4px; flex: 1; }
#tour .dots i { width: 14px; height: 3px; border-radius: 2px; background: rgba(var(--ink), .12); transition: background .3s var(--ease); }
#tour .dots i.on { background: var(--on); }
#tour .tf .btn { height: 32px; }
#tour .tf .btn.icon { width: 32px; }
#tour .tx { position: absolute; top: 10px; right: 10px; width: 28px; height: 28px; }
@keyframes tourIn { from { opacity: 0; transform: translateY(8px) scale(.98); } }
`;
  document.head.appendChild(style);

  // ---------- steps ----------
  const clip = (s, max = 230) => {
    s = String(s || '').trim();
    if (s.length <= max) return s;
    const cut = s.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
    return end > 80 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…';
  };
  function flowStep() {
    const f = (G.flows || []).find((x) => !x.custom) || (G.flows || [])[0];
    if (!f || !f.steps?.length) return null;
    return { ref: 'root', flow: f.id, kicker: '따라가기 (walkthrough)', title: f.title, note: `${f.description ? clip(f.description, 160) + ' ' : ''}Play it 을 누르면 모듈을 한 단계씩 따라간다.` };
  }

  // ---------- steps built from the model (modelmap) ----------
  const num = (v) => Number(v).toLocaleString('en-US');
  const known = (p) => !!p && typeof p.v === 'number' && Number.isFinite(p.v);
  /** A parameter count as the cards show it: "≥ " in front of a lower bound, "?" when nothing is known. */
  const count = (p) => (!known(p) || (p.lowerBound && !p.v) ? '?' : (p.lowerBound ? '≥ ' : '') + num(p.v));
  const ref = (n) => 'n:' + n.id;
  const nodes = G.nodes || [];
  const root = nodes.find((n) => n.parent === null && n.m);
  const kidsOf = (n) => nodes.filter((k) => k.parent === n.id);

  function wholeStep() {
    const P = root.m.params;
    const c = G.meta?.counts || {};
    const own = clip(root.summary, 160);
    const note = (own ? own + ' ' : '')
      + `전체 파라미터(parameters)는 ${count(P)}개, 출처 태그(source tag)는 ${P?.src || 'code'}이다.`
      + (P?.lowerBound ? ' 모르는 부분이 있어 이 합계는 하한(lower bound)이다.' : '')
      + (c.modules ? ` 모듈 인스턴스(module instance) ${num(c.modules)}개를 코드에서 읽었다(실행하지 않음).` : '');
    return { ref: ref(root), kicker: '모델 전체', title: root.m.cls || root.label, note };
  }
  function contractStep() {
    // graph.contract (scan of forward(), see references/schema.md); absent when the scan found no forward
    const k = G.contract;
    if (!k || !Array.isArray(k.inputs) || !k.inputs.length) return null;
    const names = k.inputs.slice(0, 4).map((x) => String(x.name)).join(', ') + (k.inputs.length > 4 ? ` 외 ${k.inputs.length - 4}개` : '');
    const where = k.forward?.file ? `${k.forward.file}${k.forward.line ? ':' + k.forward.line : ''}` : '';
    const keys = Array.isArray(k.output?.keys) ? k.output.keys.length : 0;
    const note = `forward()${where ? ' (' + where + ')' : ''}의 입력(inputs)은 ${k.inputs.length}개다: ${names}.`
      + (keys ? ` 출력(output)은 키(key) ${keys}개를 가진 dict 다.` : k.output?.type ? ` 출력(output) 타입은 ${k.output.type}이다.` : '');
    return { ref: ref(root), kicker: '입력과 출력', title: 'forward()', note };
  }
  function largestStep() {
    const P = root.m.params;
    const kids = kidsOf(root).filter((k) => k.m && k.m.alias === undefined && known(k.m.params)).sort((a, b) => b.m.params.v - a.m.params.v);
    const top = kids[0];
    if (!top || !top.m.params.v) return null;
    const share = known(P) && P.v > 0 ? (top.m.params.v / P.v) * 100 : null;
    const rough = top.m.params.lowerBound || P.lowerBound;
    const note = `루트 바로 아래 모듈(direct child) ${kids.length}개 중 가장 크다. 파라미터 ${count(top.m.params)}개 [${top.m.params.src || 'code'}]`
      + (share === null ? '.' : `, 전체의 ${share.toFixed(1)}%${rough ? '(하한끼리 나눈 대략값)' : ''}를 차지한다.`);
    return { ref: ref(top), kicker: '가장 큰 부분', title: `${top.label} · ${top.m.cls}`, note };
  }
  function foldStep() {
    const f = nodes.find((n) => n.m?.fold && n.m.fold.n > 1);
    if (!f) return null;
    const fd = f.m.fold;
    const total = typeof fd.total === 'number' ? num(fd.total) : known(f.m.params) ? '≥ ' + num(f.m.params.v * fd.n) : '?';
    const note = `같은 블록(block)이 ${fd.n}번 반복된다. 클래스와 생성 인자(constructor arguments)가 모두 같아서 카드 하나로 접었다(folded, ×${fd.n}).`
      + ` 한 개(copy)에 파라미터 ${count(f.m.params)}개, ${fd.n}개 합계 ${total}개.`;
    return { ref: ref(f), kicker: '반복 블록', title: `${f.id} · ${f.m.cls} ×${fd.n}`, note };
  }
  function tensorStep() {
    // the block flows (graph links of kind "tensor"): one step at the first block that has one; numbers from the graph
    const ls = (G.links || []).filter((l) => l && l.k === 'tensor');
    if (!ls.length) return null;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const first = byId.get(String(ls[0].a).replace(/^n:/, ''));
    const c = first && byId.get(first.parent);
    if (!c || !c.m) return null;
    const mine = ls.filter((l) => byId.get(String(l.a).replace(/^n:/, ''))?.parent === c.id).length;
    const classes = Number(G.meta?.counts?.flowClasses) || 0;
    const note = `흐름도(flow): 이 블록을 열면 forward() 안에서 데이터가 움직이는 순서가 화살표(tensor flow edge) ${mine}개로 보인다. 지도 전체에는 클래스 ${classes}개의 흐름, 화살표 ${ls.length}개가 있다.`
      + ' 화살표 옆 shape 는 Claude 가 forward() 를 읽고 쓴 추정(estimate)이다. 코드를 실행해서 잰 값이 아니다. 점선은 잔차 연결(residual)이다.';
    return { ref: ref(c), kicker: '데이터 흐름', title: `${c.parent === null ? c.m.cls || c.label : c.id} · ${c.m.cls} flow`, note };
  }
  function readingStep() {
    // the tags that the counts on this map carry, in the order code < config < weights < run
    const order = ['code', 'config', 'weights', 'run'];
    const seen = new Set(nodes.map((n) => n.m?.params?.src).filter(Boolean));
    const used = order.filter((s) => seen.has(s)).concat([...seen].filter((s) => !order.includes(s)));
    // the deepest module whose count shows "≥" (a lower bound with a known part): nearest to the unknown part
    const lb = nodes.filter((n) => n.m?.params?.lowerBound && n.m.params.v > 0);
    const leaf = lb.find((n) => !kidsOf(n).some((k) => lb.includes(k))) || null;
    const note = '숫자 옆 출처 태그(source tag)는 값이 어디서 왔는지 말한다. code: 코드를 읽어 계산했다. config: 설정 파일(config)에서 읽었다.'
      + ' weights: 가중치 파일(safetensors) 헤더에서 읽었다. estimate: Claude 가 forward() 를 읽고 쓴 추정이다.'
      + (used.length ? ` 이 지도의 파라미터 수에 붙은 태그: ${used.join(', ')}.` : '')
      + (leaf ? ` ≥ 는 하한(lower bound)이다: 모르는 부분이 있어 실제 값은 이 이상이다. 예: ${leaf.parent === null ? leaf.m.cls || leaf.label : leaf.id} ${count(leaf.m.params)}${leaf.m.params.why ? ' (' + clip(leaf.m.params.why, 90) + ')' : ''}.` : '');
    return { ref: ref(leaf || root), kicker: '숫자 읽는 법', title: 'code · config · weights · estimate', note };
  }
  function weightsStep() {
    const w = G.meta?.weights;
    if (!w || typeof w !== 'object') return null;
    const files = Array.isArray(w.files) ? w.files.slice(0, 2).join(', ') : '';
    const differ = Number(w.differModules) || 0, extra = Number(w.unmatchedKeys) || 0;
    const note = `가중치 파일(weights file)${files ? ' ' + files : ''}의 헤더를 코드와 대조했다(weights check). 텐서(tensor) ${num(w.tensors || 0)}개, 값 ${num(w.totalParams || 0)}개.`
      + ` 모듈 ${num(w.matchedModules || 0)}개 일치(✓), ${num(differ)}개 불일치(✗), ${num(w.uncheckedModules || 0)}개 미확인.`
      + (extra ? ` 코드가 만들지 않는 텐서가 ${num(extra)}개 있다.` : '');
    const bad = nodes.find((n) => n.m?.check?.ok === false);
    return { ref: ref(bad || root), kicker: '가중치 대조', title: differ || extra ? '✗ weights check' : '✓ weights check', note };
  }
  function autoSteps() {
    if (!root) return [];
    return [wholeStep, contractStep, largestStep, foldStep, tensorStep, readingStep, weightsStep].map((f) => f()).filter(Boolean);
  }
  function buildSteps() {
    const own = (G.tour || []).filter((s) => s && s.ref && (s.ref === 'root' || SC.exists(s.ref))).map((s) => ({ ref: s.ref, title: s.title || SC.info(s.ref).name, note: s.note || SC.info(s.ref).desc || '', kicker: '' }));
    const steps = own.length >= 2 ? own : autoSteps();
    const fl = flowStep();
    if (fl && !steps.some((s) => s.flow) && steps.length < 9) steps.push(fl);
    return steps.filter((s) => s.ref === 'root' || SC.exists(s.ref)).slice(0, 9);
  }

  // ---------- card ----------
  const card = document.createElement('div');
  card.id = 'tour';
  card.className = 'glass';
  card.hidden = true;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Start here tour');
  document.body.appendChild(card);
  let steps = [], at = -1;
  const active = () => at >= 0;

  function go(s) {
    if (!s.ref || s.ref === 'root') { SC.go('root', { select: null }); return; }
    const parent = SC.parentOf(s.ref) || 'root';
    if (parent === 'root') SC.go('root', { select: s.ref }); // stay on the overview, just highlight the card
    else SC.reveal(s.ref);
  }
  function render() {
    const s = steps[at], last = at === steps.length - 1;
    const tip = last ? 'Replay this tour any time from <b>Start here</b> at the top.' : '';
    card.innerHTML = `<button class="btn icon tx" data-x title="Close (Esc)">${SC.iconI('x')}</button>
      <div class="tk"><span>Start here</span><i></i><span>${at + 1} of ${steps.length}</span>${s.kicker ? `<i></i><span>${h(s.kicker)}</span>` : ''}</div>
      <div class="tt">${h(s.title)}</div>${s.note ? `<div class="tn">${h(s.note)}</div>` : ''}${tip ? `<div class="tip">${tip}</div>` : ''}
      <div class="tf"><div class="dots">${steps.map((_, k) => `<i class="${k <= at ? 'on' : ''}"></i>`).join('')}</div>
        ${at > 0 ? `<button class="btn icon soft" data-back title="Back (←)">${SC.iconI('left')}</button>` : `<button class="btn" data-x>Skip</button>`}
        ${s.flow ? `<button class="btn primary" data-play>${SC.iconI('right')}Play it</button>${last ? '' : '<button class="btn soft" data-next>Next</button>'}` : `<button class="btn primary" data-next>${last ? 'Done' : 'Next'}</button>`}
      </div>`;
    card.querySelectorAll('[data-x]').forEach((b) => b.onclick = end);
    card.querySelector('[data-back]')?.addEventListener('click', back);
    card.querySelector('[data-next]')?.addEventListener('click', next);
    card.querySelector('[data-play]')?.addEventListener('click', () => { const id = s.flow; end(); SC.startFlow(id); });
    window.FloorplanGlossary?.annotate(card.querySelector('.tn')); // modelmap: ML terms in the note get their tooltip
  }
  // sit above the zoom controls, and above the Ask bar (and its notices) where they overlap
  function place() {
    let bottom = 76;
    const ask = document.getElementById('ask');
    if (ask) {
      const a = ask.getBoundingClientRect(), c = card.getBoundingClientRect();
      const top = [...ask.children].filter((x) => x.offsetParent && x.getBoundingClientRect().height > 0).reduce((m, x) => Math.min(m, x.getBoundingClientRect().top), a.bottom);
      if (a.width && a.left < 16 + c.width + 12 && top < innerHeight) bottom = Math.max(bottom, innerHeight - top + 12);
    }
    card.style.bottom = Math.min(bottom, Math.max(76, innerHeight - card.offsetHeight - 80)) + 'px';
  }
  window.addEventListener('resize', () => { if (active()) place(); });
  function show(i) {
    at = i;
    card.hidden = false;
    render();
    place();
    go(steps[at]);
    if (at === 0) setTimeout(() => SC.fit(true), 450);
  }
  function next() { if (at >= steps.length - 1) end(); else show(at + 1); }
  function back() { if (at > 0) show(at - 1); }
  function end() {
    if (!active()) return;
    at = -1;
    card.hidden = true;
    SC.store.set(SEEN, true);
    if (SC.state.container === 'root') SC.select(null);
  }
  function start() {
    steps = buildSteps();
    if (steps.length < 2) { SC.toast('There is not enough on this map for a tour yet.'); return; }
    SC.store.set(SEEN, true);
    show(0);
  }

  const tourBtn = SC.addHeaderButton({ id: 'tour-btn', label: 'Start here', icon: 'home', title: 'A one-minute tour of this model', onClick: () => (active() ? end() : start()) });
  const ic = tourBtn.querySelector('svg');
  if (ic) ic.innerHTML = '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2.2 4.8-4.8 2.2 2.2-4.8z"/>'; // compass
  window.addEventListener('keydown', (ev) => {
    if (!active() || ev.target?.tagName === 'INPUT' || ev.target?.tagName === 'TEXTAREA') return;
    if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); end(); }
    else if (!SC.state.flow && ev.key === 'ArrowRight') { ev.stopPropagation(); ev.preventDefault(); next(); }
    else if (!SC.state.flow && ev.key === 'ArrowLeft') { ev.stopPropagation(); ev.preventDefault(); back(); }
  }, true);
  // a guided flow takes over the canvas: step aside
  SC.on('render', () => { if (active() && SC.state.flow) end(); });

  // First visit: start on its own, unless the link points somewhere specific (any #… address, including the
  // #tour=0 a page embedding the map can add to say "not on its own"). Where the browser won't keep anything
  // between visits (a sandboxed frame, strict settings), it can't tell a first visit from the hundredth, so it
  // never starts on its own there: Start here is always one press away.
  let auto = false;
  const maybeAuto = () => {
    if (auto) return;
    auto = true;
    if (SC.store.persistent === false || SC.store.get(SEEN, false) || location.hash.length > 1) return;
    setTimeout(() => { if (!active() && !SC.state.flow && SC.state.container === 'root') start(); }, 700);
  };
  SC.on('ready', maybeAuto);
  if (SC.state.layout) maybeAuto();

  window.FloorplanTour = { start, end, active };
})();
