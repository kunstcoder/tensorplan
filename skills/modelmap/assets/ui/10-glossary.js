// Derived from floorplan v0.11.0 (MIT): skills/floorplan/assets/ui/10-glossary.js
// modelmap glossary: explains the ML and map words a developer meets on a model map, in Korean with the
// English term first. The first time a known term appears in a description (details panel, board title area,
// tour note), it gets a dotted underline; hovering or focusing it shows a short explanation. Off while
// "Show technical detail" is on. Talks to the viewer only through window.Floorplan.
(() => {
  const SC = window.Floorplan;
  if (!SC) return;

  // [display name, explanation, aliases...]. Aliases are matched as whole words, ignoring case, except those
  // marked with a leading "=" (matched exactly, so "D" doesn't fire on "d" and "code" not on "Code"). The
  // explanations are general: nothing here states a number or a fact about one particular model.
  const TERMS = [
    // sizes and storage
    ['Parameter count (파라미터 수)', '학습되는 값(weight, bias)의 개수다. 모듈의 수는 그 안 모든 하위 모듈의 합이고, 공유된 가중치는 한 번만 센다.', 'parameter count', 'parameter counts', 'parameters', 'params', '파라미터 수', '파라미터'],
    ['fp32 / bf16 / fp16', '값 하나를 저장하는 형식이다. fp32 는 4바이트, bf16 과 fp16 은 2바이트라서 같은 모델도 형식에 따라 크기가 두 배 차이 난다.', 'fp32', 'bf16', 'fp16', 'float32', 'bfloat16', 'float16'],
    ['nn.Module', 'PyTorch 에서 층과 모델의 기본 클래스다. __init__ 에서 하위 모듈과 파라미터를 만들고 forward() 에서 계산한다.', 'nn.Module', 'nn.Modules', '=Module'],
    ['ModuleList', '하위 모듈을 순서대로 담는 목록이다. 담기만 하고, 어떤 순서로 부를지는 forward() 가 정한다.', 'ModuleList', 'nn.ModuleList'],
    ['Sequential', '하위 모듈을 담고 forward() 에서 그 순서대로 차례로 통과시키는 컨테이너다.', 'Sequential', 'nn.Sequential'],
    ['nn.Parameter', '모듈이 직접 갖는 학습 텐서다. 하위 모듈을 거치지 않고 모듈에 바로 붙는다.', 'nn.Parameter', 'nn.Parameters'],
    ['Buffer (버퍼)', 'register_buffer 로 등록한, 학습하지 않는 텐서다(예: 정규화 통계). state_dict 에 저장되지만 파라미터 수에는 들어가지 않는다.', 'buffer', 'buffers', 'register_buffer', '버퍼'],
    ['state_dict', '모듈 경로를 키로 텐서를 담은 사전이다(예: blocks.0.attn.qkv.weight). 체크포인트 파일이 이 형식으로 저장된다.', 'state_dict', 'state dict'],
    ['safetensors', '텐서만 담는 가중치 파일 형식이다. 헤더에 이름·dtype·shape 가 JSON 으로 있어 코드를 실행하지 않고 읽을 수 있다(pickle 과 달리).', 'safetensors', '.safetensors'],
    ['Weight tying (가중치 공유)', '두 모듈이 같은 가중치 텐서를 쓰는 것이다(예: 입력 임베딩과 출력 층). 파라미터는 한 번만 센다.', 'weight tying', 'tied weights', 'tied weight', 'shared weights', 'tied', '가중치 공유'],
    // layers and blocks
    ['LayerNorm', '토큰마다 특징 차원의 평균을 빼고 표준편차로 나눈 뒤, 학습되는 scale 과 bias 를 곱하고 더한다.', 'LayerNorm', 'layer norm', 'layer normalization', 'nn.LayerNorm'],
    ['RMSNorm', 'LayerNorm 에서 평균 빼기를 생략하고 제곱평균제곱근(RMS)으로만 나누는 정규화다. 보통 bias 가 없다.', 'RMSNorm', 'RMS norm'],
    ['Pre-norm (사전 정규화)', '정규화를 attention·MLP 앞에 두고, 정규화하지 않은 입력을 잔차로 더하는 블록 배치다. 깊은 모델의 학습이 안정적이다.', 'pre-norm', 'prenorm', 'pre norm', '사전 정규화'],
    ['Residual connection (잔차 연결)', '하위 층의 출력에 그 층의 입력을 더하는 연결이다(x + f(x)). 그래서 입력과 출력 shape 가 같아야 한다.', 'residual connection', 'residual connections', 'residual', 'skip connection', '잔차 연결', '잔차'],
    ['Attention (어텐션)', '각 토큰이 query·key 의 유사도로 가중치를 구해 value 들의 가중합을 받는 연산이다. self-attention 은 같은 입력끼리, cross-attention 은 다른 입력을 본다.', 'attention', 'self-attention', 'cross-attention', 'multi-head attention', '어텐션'],
    ['head_dim (d_h)', '어텐션 헤드 하나의 차원이다. 보통 dim // num_heads 로 정해진다.', 'head_dim', 'head dim', '=d_h'],
    ['num_heads (H)', '어텐션을 나란히 몇 개의 헤드로 나눠 계산하는지다. 각 헤드는 head_dim 차원을 본다.', 'num_heads', 'n_heads', 'num heads', 'heads'],
    ['GQA', 'Grouped-query attention. query 헤드 여러 개가 key·value 헤드 하나를 나눠 쓴다. KV 파라미터와 캐시가 줄어든다.', '=GQA', 'grouped-query attention', 'grouped query attention', 'num_key_value_heads'],
    ['MQA', 'Multi-query attention. 모든 query 헤드가 key·value 헤드 하나를 공유한다. GQA 에서 KV 헤드가 1개인 경우다.', '=MQA', 'multi-query attention', 'multi query attention'],
    ['RoPE', 'Rotary position embedding. query 와 key 를 위치에 비례한 각도로 회전시켜 상대 위치를 넣는다. 학습 파라미터가 없다.', '=RoPE', 'rotary embedding', 'rotary position embedding', 'rotary'],
    ['MLP / feed-forward', '토큰마다 따로 적용하는 두 개(또는 세 개)의 Linear 와 그 사이 활성화 함수다. 보통 중간 차원을 dim 의 몇 배로 넓힌다.', 'MLP', 'Mlp', 'feed-forward', 'feedforward', 'FFN', '피드포워드'],
    ['GELU', 'Gaussian error linear unit. 0 근처에서 부드러운 활성화 함수로 트랜스포머 MLP 에 흔히 쓴다. 파라미터가 없다.', '=GELU', 'nn.GELU', 'gelu'],
    ['SiLU', 'x · sigmoid(x) 활성화 함수다(Swish). 파라미터가 없다.', '=SiLU', 'nn.SiLU', 'swish', 'silu'],
    ['SwiGLU', 'SiLU 를 게이트로 쓰는 MLP 다: 두 Linear 의 출력을 SiLU(a) · b 로 곱한 뒤 세 번째 Linear 로 줄인다. 그래서 Linear 가 세 개다.', '=SwiGLU', 'swiglu'],
    ['Embedding (임베딩)', '정수 id 나 좌표 같은 입력을 dim 차원 벡터로 바꾸는 층이다. nn.Embedding 은 크기가 어휘 수 × dim 인 표다.', 'embedding', 'embeddings', 'nn.Embedding', 'embed', '임베딩'],
    ['Supernode (슈퍼노드)', '점 구름(point cloud)에서 고른 대표 점이다. 주변 점들의 정보를 모아 이 점의 특징으로 만들어, 이후 계산을 작은 집합에서 한다.', 'supernode', 'supernodes', 'supernode pooling', '슈퍼노드'],
    // dimension symbols
    ['D', '모델 차원(hidden dimension). 토큰 하나를 나타내는 벡터의 길이다. 실제 값은 차원 표(dimensions)에 있다.', '=D'],
    ['H', '어텐션 헤드 수(num_heads).', '=H'],
    ['d_h', '헤드 하나의 차원(head_dim). 보통 D / H 다.', '=d_h'],
    ['B', '배치 크기(batch size). 한 번에 함께 계산하는 샘플 수다.', '=B'],
    ['N', '토큰(또는 점) 개수. 샘플마다 다를 수 있다.', '=N'],
    // map words
    ['Source tag (출처 태그)', '숫자가 어디서 왔는지 보여 주는 표시다: code, config, weights, run, estimate. 합계의 태그는 그 부분들 중 가장 약한 것이다(code < config < weights < run).', 'source tag', 'source tags', '출처 태그'],
    ['code', '출처 태그: 코드를 실행하지 않고 읽어서 계산한 값이다.', '=code'],
    ['config', '출처 태그: 설정 파일(JSON 또는 YAML)에서 읽은 값이다.', '=config'],
    ['weights', '출처 태그: 가중치 파일(safetensors) 헤더의 shape 에서 센 값이다.', '=weights'],
    ['run', '출처 태그: 모델을 실제로 실행해 잰 값이다. 런타임 추적은 v1 기능이라 지금은 쓰이지 않는다.', '=run'],
    ['estimate', '출처 태그: Claude 가 forward() 코드를 읽고 쓴 추정이다. 코드나 파일로 확인된 값이 아니다.', '=estimate', '추정'],
    ['Lower bound (≥, 하한)', '합계에 스캔이 모르는 부분이 있다는 표시다. 실제 값은 이 숫자 이상이고, 모르는 이유는 상세 패널에 있다.', 'lower bound', 'lower bounds', '하한'],
    ['Folded block (×N)', '클래스와 생성 인자가 모두 같은 형제 모듈을 카드 하나로 접은 것이다. 카드의 숫자는 한 개 분량이고, ×N 은 반복 횟수다.', 'folded block', 'folded blocks', 'folded', '접힌 블록', '반복 블록'],
    ['Alias (shared)', '같은 모듈 객체가 두 경로에 붙은 경우다. 두 번째 경로는 shared 로 표시되고 파라미터는 첫 경로에서 한 번만 센다.', '=alias', 'shared module', 'shared modules', '공유 모듈'],
  ];

  const exact = new Map(), loose = new Map(), alts = [];
  TERMS.forEach(([name, text, ...aliases], i) => {
    for (let a of aliases) {
      const strict = a.startsWith('=');
      if (strict) a = a.slice(1);
      (strict ? exact : loose).set(strict ? a : a.toLowerCase(), i);
      alts.push(a);
    }
  });
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  alts.sort((a, b) => b.length - a.length);
  const RE = new RegExp(`(?<![\\w./-])(?:${alts.map(esc).join('|')})(?![\\w/]|-\\w|\\.\\w)`, 'gi');
  const termOf = (m) => exact.has(m) ? exact.get(m) : loose.has(m.toLowerCase()) ? loose.get(m.toLowerCase()) : -1;

  // Where to look, and what to leave alone.
  const TARGETS = '.pd, .rd, .callout';
  const SKIP = 'a[href], button, code, pre, kbd, samp, input, textarea, select, [contenteditable], .tag, .rp, .pp, .method, .kbd, .sc-term, [data-noglossary]';
  const CLICKABLE = 'a, [data-go], [data-sel], [data-flow], [data-open], [role="button"]';
  const isMono = (el) => /mono|monospace/i.test(el.style?.fontFamily || '');

  function annotate(scope, targets) {
    if (!scope || SC.technical()) return;
    const used = new Set([...scope.querySelectorAll('.sc-term')].map((s) => +s.dataset.term)); // max one per term per scope
    const skipped = (from, stop) => { for (let p = from; p && p !== stop; p = p.parentElement) if (p.matches(SKIP) || isMono(p)) return true; return false; };
    for (const el of targets) {
      if (skipped(el, scope)) continue;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: (t) => !t.nodeValue.trim() || skipped(t.parentElement, el) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
      });
      const texts = [];
      while (walker.nextNode()) texts.push(walker.currentNode);
      for (const t of texts) wrapIn(t, used);
    }
  }
  function wrapIn(textNode, used) {
    let node = textNode;
    while (node) {
      RE.lastIndex = 0;
      let m, hit = null;
      while ((m = RE.exec(node.nodeValue))) {
        const i = termOf(m[0]);
        if (i >= 0 && !used.has(i)) { hit = { m, i }; break; }
      }
      if (!hit) return;
      used.add(hit.i);
      const word = node.splitText(hit.m.index);
      const rest = word.splitText(hit.m[0].length);
      const span = document.createElement('span');
      span.className = 'sc-term';
      span.dataset.term = String(hit.i);
      if (!word.parentElement.closest(CLICKABLE)) span.tabIndex = 0; // inside clickable rows: hover only, clicks pass through
      word.replaceWith(span);
      span.appendChild(word);
      node = rest;
    }
  }
  function strip(scope) {
    if (!scope) return;
    for (const s of scope.querySelectorAll('.sc-term')) s.replaceWith(...s.childNodes);
    scope.normalize();
  }

  const panelEl = () => document.getElementById('panel');
  const contextEl = () => document.getElementById('context');
  const doPanel = () => { const p = panelEl(); if (p) annotate(p, p.querySelectorAll(TARGETS)); };
  const doContext = () => { const c = contextEl(); if (c) annotate(c, c.querySelectorAll('p, .callout')); };

  // Run after the viewer and any other extension listeners have finished filling the DOM.
  SC.on('panel', () => { hide(true); queueMicrotask(doPanel); });
  SC.on('render', () => { hide(true); queueMicrotask(doContext); });
  SC.on('technical', (on) => {
    hide(true);
    if (on) { strip(panelEl()); strip(contextEl()); }
    else { queueMicrotask(() => { strip(panelEl()); strip(contextEl()); doPanel(); doContext(); }); }
  });

  // ---------- popover ----------
  const style = document.createElement('style');
  style.textContent = `
.sc-term { pointer-events: auto; cursor: help; border-radius: 4px; text-decoration-line: underline; text-decoration-style: dotted; text-decoration-thickness: 1px; text-underline-offset: 3px;
  text-decoration-color: rgba(var(--ink), .32); text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); transition: text-decoration-color .2s var(--ease), color .2s var(--ease); }
.sc-term:hover, .sc-term.on { text-decoration-color: currentColor; color: var(--text); }
.callout .sc-term:hover, .callout .sc-term.on { color: inherit; }
.sc-term:focus { outline: none; }
.sc-term:focus-visible { box-shadow: 0 0 0 2px var(--focus); }
#sc-gloss { position: fixed; left: 0; top: 0; z-index: 55; max-width: 280px; padding: 11px 13px; border-radius: 14px; font-size: 12.5px; line-height: 1.5; color: var(--text-2);
  pointer-events: none; opacity: 0; transform: translateY(3px); transition: opacity .15s var(--ease), transform .25s var(--ease); }
#sc-gloss.on { opacity: 1; transform: none; }
#sc-gloss b { display: block; color: var(--text); font-weight: 600; margin-bottom: 2px; }`;
  document.head.appendChild(style);

  const pop = document.createElement('div');
  pop.id = 'sc-gloss';
  pop.className = 'glass';
  pop.setAttribute('role', 'tooltip');
  document.body.appendChild(pop);

  let current = null, showT = 0, hideT = 0;
  function show(el) {
    clearTimeout(hideT);
    if (current === el) return;
    const term = TERMS[+el.dataset.term];
    if (!term) return;
    current?.classList.remove('on'); current?.removeAttribute('aria-describedby');
    current = el;
    el.classList.add('on');
    el.setAttribute('aria-describedby', 'sc-gloss');
    pop.innerHTML = `<b>${SC.h(term[0])}</b>${SC.h(term[1])}`;
    const r = el.getClientRects()[0] || el.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight, gap = 8;
    const x = Math.max(12, Math.min(r.left, innerWidth - pw - 12));
    const below = r.bottom + gap + ph <= innerHeight - 12;
    const y = below ? r.bottom + gap : Math.max(12, r.top - gap - ph);
    pop.style.left = `${Math.round(x)}px`;
    pop.style.top = `${Math.round(y)}px`;
    pop.classList.add('on');
  }
  function hide(now) {
    clearTimeout(showT); clearTimeout(hideT);
    const go = () => { pop.classList.remove('on'); current?.classList.remove('on'); current?.removeAttribute('aria-describedby'); current = null; };
    if (now === true) go(); else hideT = setTimeout(go, 90);
  }
  const termAt = (ev) => ev.target instanceof Element ? ev.target.closest('.sc-term') : null;
  document.addEventListener('mouseover', (ev) => { const t = termAt(ev); if (!t) return; clearTimeout(showT); showT = setTimeout(() => show(t), current ? 0 : 140); });
  document.addEventListener('mouseout', (ev) => { const t = termAt(ev); if (t && !t.contains(ev.relatedTarget)) { clearTimeout(showT); hide(); } });
  document.addEventListener('focusin', (ev) => { const t = termAt(ev); if (t) show(t); });
  document.addEventListener('focusout', (ev) => { if (termAt(ev)) hide(); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && current) hide(true); });
  document.addEventListener('scroll', () => { if (current) hide(true); }, true);
  addEventListener('resize', () => { if (current) hide(true); });

  // modelmap: other features (the tour) mark up their own text the same way
  window.FloorplanGlossary = Object.freeze({ annotate: (el) => { if (el) annotate(el.parentElement || el, [el]); } });

  // initial pass, in case the first render/panel happened before this script ran
  if (document.readyState !== 'loading') queueMicrotask(() => { doPanel(); doContext(); });
})();
