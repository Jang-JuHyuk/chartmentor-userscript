// ==UserScript==
// @name         차트멘토 최영현 기록기 3.0
// @namespace    local.chartmentor.research
// @version      3.0.0
// @updateURL    https://raw.githubusercontent.com/Jang-JuHyuk/chartmentor-userscript/main/chartmentor.user.js
// @downloadURL  https://raw.githubusercontent.com/Jang-JuHyuk/chartmentor-userscript/main/chartmentor.user.js
// @match        https://chartmentor.net/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      chartmentor-uploads.s3.ap-northeast-2.amazonaws.com
// @connect      fapi.binance.com
// @connect      api.bybit.com
// ==/UserScript==

(() => {
  'use strict';
  const PREFIX = 'cm22_message_';  // 2.2~2.4 저장소 그대로 유지
  const LABEL_PREFIX = 'cm25_label_';
  const IMAGE_HOST = 'chartmentor-uploads.s3.ap-northeast-2.amazonaws.com';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pad = n => String(n).padStart(2, '0');

  function hash(s) {
    let a = 2166136261, b = 3339675911;
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      a = Math.imul(a ^ c, 16777619);
      b = Math.imul(b ^ c, 2246822519);
    }
    return [a, b].map(n => (n >>> 0).toString(16).padStart(8, '0')).join('');
  }
  function entries() {
    return GM_listValues().filter(k => k.startsWith(PREFIX))
      .map(key => ({ key, r: GM_getValue(key, null) }))
      .filter(x => x.r && x.r.author === '최영현');
  }
  function cleanUrl(raw) {
    if (!raw) return null;
    try {
      let u = new URL(raw, location.href);
      return u.protocol === 'https:' && u.hostname === IMAGE_HOST &&
        u.pathname.startsWith('/uploads/chat/files/') ? u.href : null;
    } catch { return null; }
  }
  function fileName(url) {
    return 'chartmentor_' + new URL(url).pathname.split('/').pop()
      .replace(/[^a-z0-9._-]/gi, '_');
  }
  function normalizedImages(arr) {
    return (Array.isArray(arr) ? arr : []).map(img => {
      let url = cleanUrl(img.url || img.src);
      return { alt: img.alt || '첨부 이미지',
        sourceType: img.sourceType || 'web-or-other',
        url, fileName: url ? fileName(url) : null };
    });
  }
  function saveRecord(input) {
    if (input.author !== '최영현') return false;
    const r = {
      author: '최영현', text: input.text || '',
      briefing: !!input.briefing || (input.text || '').includes('##'),
      timeLabel: input.timeLabel || null, postedAt: input.postedAt || null,
      timeRaw: input.timeRaw || null,
      capturedAt: input.capturedAt || new Date().toISOString(),
      images: normalizedImages(input.images), channel: input.channel || location.pathname
    };
    if (!r.text && !r.images.length) return false;
    // 예전 저장 식별자 유지: 기존 기록은 이동/삭제하지 않음
    const signature = JSON.stringify([r.channel, r.text, r.timeLabel,
      r.text ? '' : r.images.length]);
    let key = PREFIX + hash(signature), old = GM_getValue(key, null);
    if (old?.postedAt && r.postedAt && old.postedAt !== r.postedAt) {
      key = PREFIX + hash(signature + r.postedAt);
      old = GM_getValue(key, null);
    }
    if (old) {
      const images = normalizedImages(old.images);
      r.images.forEach((img, i) => {
        if (!images[i]) images.push(img);
        else if (!images[i].url && img.url) images[i] = {...images[i], ...img};
      });
      const merged = {...old, images,
        postedAt: old.postedAt || r.postedAt,
        timeRaw: old.timeRaw || r.timeRaw,
        timeLabel: old.timeLabel || r.timeLabel,
        briefing: old.briefing || r.briefing};
      if (JSON.stringify(merged) !== JSON.stringify(old)) {
        GM_setValue(key, merged); markDataChanged(); return true;
      }
      return false;
    }
    GM_setValue(key, r); markDataChanged(); return true;
  }
  // V2.7: 지연 로딩된 이미지도 원본 URL로 연결하는 탐색기
  // 이미지·링크·picture의 속성을 검사하되, 실제 저장은 승인된 S3 경로만 허용한다.
  function imageSourceUrl(node, row) {
    const candidates = [];
    const add = raw => {
      if (!raw || typeof raw !== 'string') return;
      candidates.push(raw.trim().replace(/^["']|["']$/g, ''));
    };
    const els = [node, ...node.querySelectorAll('img,source,a,[data-src],[data-original],[data-full-src],[data-image-url],[style]')];
    let parent = node.parentElement;
    while (parent && parent !== row) {
      els.push(parent);
      parent = parent.parentElement;
    }
    for (const el of els.slice(0,100)) {
      for (const attr of ['data-original','data-full-src','data-image-url','data-src','href','src']) {
        add(el.getAttribute?.(attr));
      }
      if (el instanceof HTMLImageElement) add(el.currentSrc);
      for (const attr of ['srcset','data-srcset']) {
        const value=el.getAttribute?.(attr)||'';
        value.split(',').forEach(part=>add(part.trim().split(/\s+/)[0]));
      }
      const style=el.getAttribute?.('style')||'';
      const bg=style.match(/url\(["']?([^"')]+)["']?\)/i);
      if (bg) add(bg[1]);
    }
    for (const candidate of candidates) {
      const url=cleanUrl(candidate);
      if (url) return url;
    }
    return null;
  }
  function findRowImages(row) {
    const frames=[...row.querySelectorAll('[data-chat-image-frame="true"]')];
    const imgs=[...row.querySelectorAll('img')].filter(img=>{
      if (frames.some(frame=>frame.contains(img))) return false;
      const source=img.currentSrc || img.getAttribute('src') || '';
      const isAttachment=/첨부|차트/i.test(img.alt||'') ||
        img.getAttribute('role')==='button' ||
        !!cleanUrl(source) ||
        (img.closest('[data-chat-bubble="true"]') && img.getBoundingClientRect().width>=90);
      return !!isAttachment;
    });
    const links=[...row.querySelectorAll('a[href*="/uploads/chat/files/"]')]
      .filter(a=>!frames.some(f=>f.contains(a)) && !imgs.some(img=>a.contains(img)));
    return [...frames,...imgs,...links].map(node=>{
      const url=imageSourceUrl(node,row);
      const image=node.matches('img')?node:node.querySelector('img');
      const source=image?.getAttribute('src')||'';
      return {
        alt:image?.alt||'첨부 이미지',
        sourceType:url?'web-or-other':(source.startsWith('blob:')?'blob':'unresolved'),
        url
      };
    });
  }

  function parseTime(row) {
    const el = row.querySelector('[data-chat-time="true"]');
    const raw = el?.getAttribute('title') || '';
    const label = el?.textContent.trim() || null;
    const m = raw.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일(?:\s*[월화수목금토일]요일)?\s*(오전|오후)\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return {postedAt:null, timeLabel:label, timeRaw:raw || null};
    const [, y, mo, d, ap, hh, mm, ss = '00'] = m;
    const hour = Number(hh) % 12 + (ap === '오후' ? 12 : 0);
    return { postedAt:`${y}-${pad(mo)}-${pad(d)}T${pad(hour)}:${mm}:${ss}+09:00`,
      timeLabel:label, timeRaw:raw };
  }
  function scan() {
    let changed = false;
    document.querySelectorAll('[data-chat-column="true"]').forEach(col => {
      const header = col.querySelector(':scope > div:first-child');
      if (!header || ![...header.querySelectorAll('span')]
        .some(s => s.textContent.trim() === '최영현')) return;
      col.querySelectorAll('[data-chat-bubble-row="true"]').forEach(row => {
        const text = [...row.querySelectorAll('p[data-chat-text="true"]')]
          .map(p => p.innerText || p.textContent).join('\n').trim();
        const images = findRowImages(row);
        if (!text && !images.length) return;
        if (saveRecord({author:'최영현', text, images, ...parseTime(row),
            channel:location.pathname})) changed = true;
      });
    });
    if (changed) refresh();
  }

  // 이미지에 보이는 제목을 읽는 기능이 아님. 명시된 글자만 인식.
  const assetRules = [
    ['BTC', /비트코인|비트(?:는|가|도|를|의|만|\s|$)|\bBTC(?:USDT)?(?:\.P)?\b|\bXBT\b/i],
    ['ETH', /이더리움|이더(?:는|가|도|를|의|\s|$)|\bETH(?:USDT)?(?:\.P)?\b/i],
    ['SOL', /솔라나|\bSOL(?:USDT)?(?:\.P)?\b/i],
    ['XRP', /리플|\bXRP(?:USDT)?(?:\.P)?\b/i],
    ['GOLD', /골드|금값|금시세|\bXAUUSD\b/i],
    ['NASDAQ', /나스닥|\bNASDAQ\b|\bNQ1!\b|\bNDX\b/i],
    ['KOSPI', /코스피|\bKOSPI\b/i],
    ['NVDA', /엔비디아|\bNVDA\b/i]
  ];
  function detectInterval(text) {
    const m = text.match(/(?:^|[^\d])(1|3|5|15|30)\s*분\s*(?:봉|차트)|(?:^|[^\d])(1|2|4|6|12)\s*시간\s*(?:봉|차트|Bull|Bear)|\b(1m|3m|5m|15m|30m|1h|2h|4h|6h|12h|1d)\b/i);
    if (m) return m[1] ? m[1] + 'm' : m[2] ? m[2] + 'h' : m[3].toLowerCase();
    if (/일봉/.test(text)) return '1d';
    return null;
  }
  function classify(text) {
    // 첫머리에 붙인 [비트코인5분봉] 같은 차트 제목은 우선 적용
    const head = text.match(/^\s*(?:##\s*)?\[([^\]\n]{1,70})\]/)?.[1] || '';
    const inHeader = assetRules.filter(([, re]) => re.test(head)).map(([x]) => x);
    const inBody = assetRules.filter(([, re]) => re.test(text)).map(([x]) => x);
    const candidate = inHeader.length ? inHeader : inBody;
    const asset = candidate.length === 1 ? candidate[0] : null;
    const tf = detectInterval(head) || detectInterval(text);
    const ticker = text.match(/\b(?:BINANCE|BYBIT|NASDAQ|NYSE|OKX|GATE):([A-Z0-9_.!]+)/i)?.[1] ||
      text.match(/\b(?:BTC|ETH|SOL|XRP)(?:USDT|USDC|USD)(?:\.P)?\b/i)?.[0] || null;
    const exchange = /BINANCE\s*:|바이낸스\s*(?:차트|거래소\s*차트)/i.test(head || text) ? 'BINANCE'
      : /BYBIT\s*:|바이비트\s*(?:차트|거래소\s*차트)/i.test(head || text) ? 'BYBIT' : null;
    const market = (ticker && /\.P$/i.test(ticker)) || /무기한|퍼페추얼|영구선물|선물차트/i.test(head) ? 'PERP'
      : /현물|SPOT/i.test(head) ? 'SPOT' : null;
    return {asset, timeframe:tf, ticker, chartExchange:exchange, chartMarket:market,
      candidates:candidate, source:inHeader.length ? '본문의 [차트 제목]' : '본문 키워드',
      status:candidate.length > 1 ? '복수 종목: 확인 필요'
        : candidate.length === 1 ? '텍스트 추정: 이미지 확인 권장' : '종목 미확인'};
  }
  function labelKey(key) { return LABEL_PREFIX + key.slice(PREFIX.length); }
  function resolved(item) {
    const auto = classify(item.r.text || '');
    const manual = GM_getValue(labelKey(item.key), {});
    return {...auto,
      asset:manual.asset === 'UNKNOWN' ? null : (manual.asset || auto.asset),
      timeframe:manual.timeframe || auto.timeframe,
      ticker:manual.ticker || auto.ticker,
      chartExchange:manual.chartExchange || auto.chartExchange,
      chartMarket:manual.chartMarket || auto.chartMarket,
      manuallyReviewed:!!manual.reviewed};
  }

  function imageList() {
    const map = new Map();
    entries().forEach(({r}) => (r.images || []).forEach(img => {
      const url = cleanUrl(img.url);
      if (url && !map.has(url)) map.set(url, {url, name:fileName(url)});
    }));
    return [...map.values()];
  }
  function button(label, handler, parent) {
    let b = document.createElement('button'); b.textContent = label;
    b.style.cssText = 'background:white;color:#7035c3;border:0;border-radius:6px;padding:7px;cursor:pointer;font-weight:bold';
    b.addEventListener('click', handler); parent.appendChild(b); return b;
  }
  function select(options, parent) {
    let s = document.createElement('select');
    s.style.cssText = 'width:100%;max-width:100%;padding:5px;background:white;color:#202024;border-radius:5px';
    options.forEach(([value, name]) => {
      const o = document.createElement('option'); o.value = value; o.textContent = name; s.appendChild(o);
    });
    s.style.boxSizing='border-box'; parent.appendChild(s); return s;
  }
  function title(text, parent) {
    const p = document.createElement('div'); p.textContent = text;
    p.style.cssText = 'font-size:11px;margin-top:5px;overflow-wrap:anywhere'; parent.appendChild(p); return p;
  }
  // ── V2.6: 메뉴 3개 / 드래그 / 숨김 / 위치 기억 ──
  const POS_KEY = 'cm26_panel_position';
  const HIDDEN_KEY = 'cm26_panel_hidden';
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const panel = document.createElement('section');
  panel.id = 'cm26-panel';
  panel.style.cssText = [
    'position:fixed', 'z-index:2147483500',
    'width:310px', 'max-width:calc(100vw - 18px)',
    'background:#7035c3', 'color:white',
    'border-radius:12px', 'font-size:12px',
    'box-shadow:0 5px 20px #0005',
    'box-sizing:border-box', 'overflow:hidden',
    'font-family:system-ui,Arial,sans-serif'
  ].join(';');
  const initialPosition = GM_getValue(POS_KEY, null);
  function positionPanel(x, y, persist=false) {
    const w = panel.getBoundingClientRect().width || Math.min(310, innerWidth-18);
    const h = panel.getBoundingClientRect().height || 150;
    const left = clamp(Number(x)||0, 8, Math.max(8, innerWidth-w-8));
    const top = clamp(Number(y)||0, 8, Math.max(8, innerHeight-Math.min(h,150)-8));
    panel.style.left = left+'px';
    panel.style.top = top+'px';
    panel.style.right = 'auto';
    if (persist) GM_setValue(POS_KEY, {left,top});
  }
  document.body.appendChild(panel);
  positionPanel(initialPosition?.left ?? (innerWidth-325), initialPosition?.top ?? 115);

  const heading = document.createElement('div');
  heading.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:5px;padding:9px 10px 5px;cursor:move;touch-action:none;user-select:none';
  const headingText = document.createElement('strong');
  headingText.textContent = '⋮⋮ 차트멘토 기록기 3.0.0';
  headingText.style.cssText = 'font-size:12px;pointer-events:none';
  heading.appendChild(headingText);
  const closeBtn = document.createElement('button');
  closeBtn.type='button'; closeBtn.title='창 숨기기 (작은 버튼으로 복원)';
  closeBtn.textContent='✕';
  closeBtn.style.cssText='background:#ffffff24;border:0;color:white;border-radius:5px;width:26px;height:26px;cursor:pointer;font-size:14px';
  heading.appendChild(closeBtn);
  panel.appendChild(heading);

  const status = document.createElement('div');
  status.style.cssText = 'padding:0 10px 4px;font-size:11px;opacity:.93;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
  panel.appendChild(status);
  const activity = document.createElement('div');
  activity.style.cssText = 'padding:0 10px;font-size:11px;opacity:.92;max-height:42px;overflow:hidden';
  panel.appendChild(activity);

  const tabs = document.createElement('div');
  tabs.style.cssText='display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;padding:8px';
  panel.appendChild(tabs);
  const body = document.createElement('div');
  body.style.cssText = 'display:none;max-height:min(60vh,540px);overflow-y:auto;padding:4px 10px 11px;box-sizing:border-box;overscroll-behavior:contain';
  panel.appendChild(body);
  const views = {};
  const tabButtons = {};
  let activeView = null;
  function addTab(id, label) {
    const b=document.createElement('button'); b.type='button'; b.textContent=label;
    b.style.cssText='padding:8px 3px;border:1px solid #ffffff4f;background:#ffffff19;color:white;border-radius:7px;cursor:pointer;font-weight:700;font-size:12px';
    b.onclick=()=>activate(activeView===id?null:id);
    tabs.appendChild(b); tabButtons[id]=b;
    const page=document.createElement('div');
    page.style.display='none'; page.style.minWidth='0';
    views[id]=page; body.appendChild(page);
    return page;
  }
  const collectionPage=addTab('collect','수집');
  const analysisPage=addTab('analysis','차트 분석');
  const knowledgePage=addTab('knowledge','지식');
  const backupPage=addTab('backup','백업 · 설정');
  function activate(id) {
    activeView=id;
    body.style.display=id?'block':'none';
    for (const [key,page] of Object.entries(views)) {
      page.style.display=key===id?'block':'none';
      tabButtons[key].style.background=key===id?'white':'#ffffff19';
      tabButtons[key].style.color=key===id?'#7035c3':'white';
    }
    positionPanel(parseFloat(panel.style.left),parseFloat(panel.style.top));
  }
  activate(null); // 처음에는 메뉴 버튼만 표시

  // 닫으면 화면에 작은 복원 버튼만 남김
  const launcher=document.createElement('button');
  launcher.type='button'; launcher.textContent='CM';
  launcher.title='차트멘토 기록기 다시 열기';
  launcher.style.cssText='position:fixed;z-index:2147483500;right:14px;bottom:76px;width:45px;height:45px;border-radius:50%;border:2px solid white;box-shadow:0 3px 12px #0006;background:#7035c3;color:white;font-weight:800;cursor:pointer';
  document.body.appendChild(launcher);
  function setHidden(hidden) {
    GM_setValue(HIDDEN_KEY,!!hidden);
    panel.style.display=hidden?'none':'block';
    launcher.style.display=hidden?'block':'none';
    if(!hidden) positionPanel(parseFloat(panel.style.left),parseFloat(panel.style.top));
  }
  closeBtn.onclick=()=>setHidden(true);
  launcher.onclick=()=>setHidden(false);
  setHidden(GM_getValue(HIDDEN_KEY,false));

  // 헤더를 드래그하면 이동, 끝난 위치는 브라우저에 기억
  let drag=null;
  heading.addEventListener('pointerdown',e=>{
    if(e.button!==0 || e.target.closest('button'))return;
    drag={id:e.pointerId,x:e.clientX,y:e.clientY,
      left:parseFloat(panel.style.left),top:parseFloat(panel.style.top)};
    heading.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  heading.addEventListener('pointermove',e=>{
    if(!drag || drag.id!==e.pointerId)return;
    positionPanel(drag.left+e.clientX-drag.x,drag.top+e.clientY-drag.y);
  });
  function stopDrag(e){
    if(!drag || drag.id!==e.pointerId)return;
    drag=null;
    positionPanel(parseFloat(panel.style.left),parseFloat(panel.style.top),true);
  }
  heading.addEventListener('pointerup',stopDrag);
  heading.addEventListener('pointercancel',stopDrag);
  addEventListener('resize',()=>positionPanel(parseFloat(panel.style.left),parseFloat(panel.style.top)));

  // 실제 기능은 상위 메뉴 안에만 넣는다
  const collection=document.createElement('details');
  collection.open=true;
  const collectionTitle=document.createElement('summary');
  collectionTitle.textContent='과거 채팅 · 첨부 이미지';
  collectionTitle.style.cssText='margin:5px 0 10px;cursor:pointer;font-weight:700';
  collection.appendChild(collectionTitle);collectionPage.appendChild(collection);
  const controls=document.createElement('div');
  controls.style.cssText='display:flex;flex-direction:column;gap:6px';
  collection.appendChild(controls);

  const analysis=document.createElement('details');
  analysis.open=true;
  const analysisTitle=document.createElement('summary');
  analysisTitle.textContent='메시지별 차트 확인 · 과거 캔들';
  analysisTitle.style.cssText='margin:5px 0 10px;cursor:pointer;font-weight:700';
  analysis.appendChild(analysisTitle);analysisPage.appendChild(analysis);
  const fields=document.createElement('div');
  fields.style.cssText='display:flex;flex-direction:column;gap:5px;min-width:0';
  analysis.appendChild(fields);

  const backupControls=document.createElement('div');
  backupControls.style.cssText='display:flex;flex-direction:column;gap:7px';
  backupPage.appendChild(backupControls);
  const backupHelp=document.createElement('div');
  backupHelp.textContent='백업 파일은 로컬에 저장됩니다. 기존 기록 키(cm22_message_)를 유지합니다. 데이터 삭제 기능은 없습니다.';
  backupHelp.style.cssText='font-size:11px;line-height:1.5;opacity:.85;margin-top:9px';
  backupPage.appendChild(backupHelp);

  // V3.0: 텍스트 키워드로 "검토 후보"만 선별한다.
  // AI 추론/매매 신호 생성 없음. 사용자가 검토한 지식만 검증 목록에 편입.
  const KNOWLEDGE_PREFIX='cm30_review_';
  const knowledgeTypes=[
    ['TECH','차트 구조·기술적 분석',
      /오더블록|\bOB\b|피보나치|되돌림|1\.618|2\.618|0\.886|0\.382|추세선|넥라인|캔들|유동성|베어트랩|Bear Trap|LH.?LL|HH.?HL|저항|지지|웨지|쐐기|리테스트/i],
    ['TRADE','진입·청산·시나리오',
      /진입|익절|숏\s*포지션|롱\s*포지션|포지션|손절|지정가|매수|매도|셋업|목표가|매매\s*계획|상방\s*돌파|하방\s*돌파/i],
    ['RISK','위험·자금 관리',
      /손익비|레버리지|스탑로스|손절|본절|리스크\s*관리|비중\s*조절|물타기|최대\s*손실|포지션\s*사이즈|진입\s*비중/i],
    ['MIND','매매 심법·태도',
      /본전\s*심리|심법|멘탈|포모|FOMO|조급|매매\s*원칙|기다림|감정\s*매매|손실\s*회피|경험치|인내|욕심|배움의\s*자세/i],
    ['MARKET','시장·거시 해석',
      /비트코인|나스닥|CPI|FOMC|금리|거래량|시장\s*참여|시장\s*심리|상승\s*추세|하락\s*추세|횡보|랠리|사이클|고용지표/i]
  ];
  function knowledgeTags(record){
    const t=record.text||'';
    return knowledgeTypes.filter(([, ,rx])=>rx.test(t)).map(([id])=>id);
  }
  function knowledgeReviewKey(item){
    return KNOWLEDGE_PREFIX+hash(item.r.messageId||item.key);
  }
  function readKnowledgeReview(item){
    return GM_getValue(knowledgeReviewKey(item),null);
  }
  const knowledgeIntro=document.createElement('div');
  knowledgeIntro.textContent='원문 기반 검토함 · 아래 분류는 키워드 후보이며 선생님의 실제 매매 규칙으로 확정된 내용이 아닙니다.';
  knowledgeIntro.style.cssText='font-size:11px;line-height:1.5;margin:2px 0 8px';
  knowledgePage.appendChild(knowledgeIntro);
  const knowledgeSearch=document.createElement('input');
  knowledgeSearch.type='search';
  knowledgeSearch.placeholder='검색: OB, 본전 심리, 손익비, 가격 등';
  knowledgeSearch.style.cssText='width:100%;box-sizing:border-box;padding:8px;border-radius:6px;background:white;color:#262626;border:0;margin-bottom:6px';
  knowledgePage.appendChild(knowledgeSearch);
  const knowledgeTopic=select([
    ['ALL','전체 메시지'],['TECH','차트 구조·기술적 분석'],
    ['TRADE','진입·청산·시나리오'],['RISK','위험·자금 관리'],
    ['MIND','매매 심법·태도'],['MARKET','시장·거시 해석']
  ],knowledgePage);
  const knowledgeFilter=select([
    ['ALL','검토 여부 전체'],['PENDING','아직 검토하지 않음'],
    ['CONFIRMED','직접 검토한 지식'],['HOLD','판단 보류'],['EXCLUDED','학습에서 제외']
  ],knowledgePage);
  const knowledgeSummary=document.createElement('div');
  knowledgeSummary.style.cssText='font-size:11px;margin:8px 0;line-height:1.5;white-space:pre-wrap';
  knowledgePage.appendChild(knowledgeSummary);
  const knowledgeActions=document.createElement('div');
  knowledgeActions.style.cssText='display:flex;flex-direction:column;gap:6px;margin-bottom:7px';
  knowledgePage.appendChild(knowledgeActions);
  const knowledgeList=document.createElement('div');
  knowledgeList.style.cssText='display:flex;flex-direction:column;gap:5px';
  knowledgePage.appendChild(knowledgeList);
  const knowledgeDetail=document.createElement('div');
  knowledgeDetail.style.cssText='margin:10px 0;border-top:1px solid #ffffff60;padding-top:9px;white-space:pre-wrap';
  knowledgePage.appendChild(knowledgeDetail);
  let knowledgeRows=[],knowledgeSelected=null,knowledgeOffset=0;
  function refreshKnowledgeIndex(){
    knowledgeRows=entries().map(item=>({
      ...item,
      tags:knowledgeTags(item.r),
      review:readKnowledgeReview(item)
    })).sort((a,b)=>(Date.parse(b.r.postedAt)||0)-(Date.parse(a.r.postedAt)||0));
    knowledgeOffset=0;
    renderKnowledgeList();
  }
  function knowledgeMatches(item){
    const q=knowledgeSearch.value.trim().toLocaleLowerCase('ko-KR');
    if(q && !(item.r.text||'').toLocaleLowerCase('ko-KR').includes(q))return false;
    const topic=knowledgeTopic.value;
    const effective=(item.review?.status==='CONFIRMED' && item.review?.category)
      ?item.review.category:null;
    if(topic!=='ALL' && effective!==topic && (!effective && !item.tags.includes(topic)))return false;
    const status=knowledgeFilter.value;
    if(status==='PENDING' && item.review?.status)return false;
    if(status!=='ALL' && status!=='PENDING' && item.review?.status!==status)return false;
    return true;
  }
  function renderKnowledgeList(){
    knowledgeList.replaceChildren();
    if(!knowledgeRows.length){
      knowledgeSummary.textContent='아래 버튼으로 로컬 기록을 불러오세요.';
      return;
    }
    const subset=knowledgeRows.filter(knowledgeMatches);
    const confirmed=knowledgeRows.filter(x=>x.review?.status==='CONFIRMED').length;
    knowledgeSummary.textContent='저장된 메시지 '+knowledgeRows.length+
      '건 · 직접 검토 완료 '+confirmed+'건\n현재 필터 '+subset.length+'건'+
      ' · 처음 30건부터 표시 (AI가 자동 확정한 전략은 0건)';
    const shown=subset.slice(knowledgeOffset,knowledgeOffset+30);
    for(const item of shown){
      const el=document.createElement('button');
      el.type='button';
      el.style.cssText='text-align:left;padding:8px;border:1px solid #ffffff70;background:#522c96;color:white;border-radius:6px;white-space:pre-wrap;cursor:pointer;font-size:11px;line-height:1.4;overflow-wrap:anywhere';
      const tagNames=item.tags.map(id=>knowledgeTypes.find(t=>t[0]===id)?.[1]||id);
      const note=item.review?.status==='CONFIRMED'?'[검토 완료] ':item.review?.status==='EXCLUDED'?'[제외] ':item.review?.status==='HOLD'?'[보류] ':'[후보] ';
      el.textContent=note+(item.r.postedAt||'날짜 미확인')+'\n'+
        (tagNames.join(' · ')||'키워드 미분류')+'\n'+
        ((item.r.text||'[이미지 또는 본문 없음]').replace(/\s+/g,' ').slice(0,110));
      el.onclick=()=>openKnowledgeItem(item);
      knowledgeList.appendChild(el);
    }
    if(knowledgeOffset+30<subset.length){
      const more=button('다음 30건 보기',()=>{
        knowledgeOffset+=30;renderKnowledgeList();
      },knowledgeList);
      more.style.marginTop='4px';
    }
  }
  function openKnowledgeItem(item){
    knowledgeSelected=item;
    knowledgeDetail.replaceChildren();
    const heading=document.createElement('div');
    heading.style.cssText='font-weight:700;margin-bottom:5px';
    heading.textContent='원문 · '+(item.r.postedAt||'작성 시각 미확인');
    knowledgeDetail.appendChild(heading);
    const provenance=document.createElement('div');
    provenance.style.cssText='font-size:10px;overflow-wrap:anywhere;opacity:.85;margin-bottom:7px';
    provenance.textContent='작성자: '+item.r.author+'\n메시지 ID: '+(item.r.messageId||'기존 스크롤 기록(ID 없음)')+
      '\n아래 원문은 수정되지 않습니다.';
    knowledgeDetail.appendChild(provenance);
    const source=document.createElement('div');
    source.style.cssText='padding:8px;background:#4d2690;border-radius:5px;font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:340px;overflow-y:auto';
    source.textContent=item.r.text||'[텍스트 없음]';
    knowledgeDetail.appendChild(source);
    const links=(item.r.images||[]).map(img=>cleanUrl(img.url)).filter(Boolean);
    if(links.length){
      const urls=document.createElement('div');
      urls.style.cssText='display:flex;flex-direction:column;gap:5px;margin:8px 0';
      links.forEach((url,i)=>{
        const link=document.createElement('a');
        link.href=url;link.target='_blank';link.rel='noopener noreferrer';
        link.textContent='원본 이미지 '+(i+1)+' 열기';
        link.style.color='white';link.style.textDecoration='underline';
        urls.appendChild(link);
      });knowledgeDetail.appendChild(urls);
    }else if(item.r.serverMessageType==='image'){
      title('※ 서버 이미지형 메시지이나 현재 저장된 이미지 URL 없음',knowledgeDetail);
    }
    title('사람이 확인한 최종 분류',knowledgeDetail);
    const category=select([
      ['', '검토 필요 / 미분류'],...knowledgeTypes.map(([id,label])=>[id,label]),
      ['OTHER','기타']
    ],knowledgeDetail);
    title('검토 상태 (직접 검토하기 전에는 확정하지 마세요)',knowledgeDetail);
    const state=select([
      ['PENDING','아직 검토 안 함'],['CONFIRMED','원문 확인 · 학습 자료로 채택'],
      ['HOLD','맥락·차트 확인 필요'],['EXCLUDED','학습 자료에서 제외']
    ],knowledgeDetail);
    const note=document.createElement('textarea');
    note.placeholder='내 검토 메모: 원문의 실제 조건 / 앞뒤 대화 확인 필요 사항 / AI 해석과 구분';
    note.rows=4;
    note.style.cssText='box-sizing:border-box;width:100%;padding:7px;border-radius:6px;color:#222;background:white;margin-top:7px';
    knowledgeDetail.appendChild(note);
    const last=item.review||{};
    category.value=last.category||'';
    state.value=last.status||'PENDING';
    note.value=last.note||'';
    button('검토 메모 · 상태 저장',()=>{
      if(state.value==='CONFIRMED' && !category.value){
        alert('학습 자료로 채택하려면 최종 분류부터 선택해 주세요.');return;
      }
      const val={status:state.value,category:category.value,note:note.value.trim(),
        reviewedAt:new Date().toISOString(),messageId:item.r.messageId||null};
      GM_setValue(knowledgeReviewKey(item),val);
      markDataChanged();
      item.review=val;
      activity.textContent='원문은 그대로 유지하고 검토 결과만 별도로 저장했습니다.';
      renderKnowledgeList();
    },knowledgeDetail);
  }
  knowledgeSearch.addEventListener('input',()=>{
    knowledgeOffset=0;renderKnowledgeList();
  });
  knowledgeTopic.onchange=()=>{knowledgeOffset=0;renderKnowledgeList();};
  knowledgeFilter.onchange=()=>{knowledgeOffset=0;renderKnowledgeList();};
  button('로컬 기록에서 지식 후보 불러오기',refreshKnowledgeIndex,knowledgeActions);
  button('검토 완료 지식만 JSON으로 저장',()=>{
    if(!knowledgeRows.length)refreshKnowledgeIndex();
    const verified=knowledgeRows.filter(x=>x.review?.status==='CONFIRMED')
      .map(x=>({
        source:{messageId:x.r.messageId||null,storageKey:x.key,
          postedAt:x.r.postedAt||null,author:x.r.author,rawText:x.r.text,
          images:(x.r.images||[]).map(i=>({url:cleanUrl(i.url)}))},
        verifiedCategory:x.review.category,
        humanNote:x.review.note||'',
        reviewedAt:x.review.reviewedAt
      }));
    if(!verified.length){alert('아직 직접 검토한 학습 자료가 없습니다.');return;}
    const payload={version:'3.0.0',kind:'human-reviewed-knowledge',
      exportedAt:new Date().toISOString(),records:verified,
      warning:'원문은 출처 확인용이며 검토 메모는 사용자가 작성한 내용입니다. AI의 실전 수익성은 검증되지 않았습니다.'};
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;
    a.download='chartmentor_verified_knowledge_'+new Date().toISOString().slice(0,10)+'.json';
    a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  },knowledgeActions);

  function imageStats() {
    const rows=entries();
    const imageRows=rows.filter(x=>(x.r.images||[]).length);
    const unresolvedRows=imageRows.filter(x=>(x.r.images||[]).some(img=>!cleanUrl(img.url)));
    return {records:rows.length,imageRows:imageRows.length,
      unresolvedRows:unresolvedRows.length,sourceCount:imageList().length};
  }
  function refresh() {
    const list = entries();
    const stats=imageStats();
    status.style.whiteSpace='pre-line';
    status.textContent=`기록 ${list.length} · 날짜 ${list.filter(x=>x.r.postedAt).length}\n원본 이미지 ${stats.sourceCount} · URL 미확인 첨부 기록 ${stats.unresolvedRows}`;
  }
  // 문서 내부 스크롤 영역에서만 동작, 2.4 성공 로직 유지
  function findScroller() {
    const col = document.querySelector('[data-chat-column="true"]');
    let el = col?.parentElement || null;
    while (el && el !== document.body) {
      const css=getComputedStyle(el);
      if (el.scrollHeight > el.clientHeight+50 && el.clientWidth>200 &&
          /auto|scroll|overlay/.test(css.overflowY)) return el;
      el=el.parentElement;
    }
    return null;
  }
  // V2.9: 사용자 본인이 로그인한 차트멘토 채팅방의 정상적인 읽기 API를 사용한다.
  // 별도 로그인 우회, 토큰 수집, 외부 전송 없음. 최영현 메시지만 로컬 GM 저장.
  const SERVER_ROOM='87983b7a-ab21-4fd7-bfd3-bf42cd0d2898';
  const SERVER_PROGRESS_KEY='cm29_server_progress';
  const SERVER_AUTOSYNC_KEY='cm29_auto_sync';
  const AUTO_BACKUP_ENABLED_KEY='cm293_auto_backup_enabled';
  const AUTO_BACKUP_LAST_KEY='cm293_auto_backup_last';
  const AUTO_BACKUP_DIRTY_KEY='cm293_backup_dirty_at';
  const AUTO_SYNC_LAST_KEY='cm293_auto_sync_last_attempt';
  const AUTO_SYNC_PAUSE_KEY='cm293_auto_sync_paused';
  const AUTO_BACKUP_SPACING_MS=24*60*60*1000;
  const AUTO_SYNC_COOLDOWN_MS=60*1000;
  const AUTO_SYNC_INTERVAL_MS=3*60*1000;
  let lastDirtyWriteAt=0;
  // 매번 수천 건을 내보내지 않고 변경 여부만 안전하게 표시
  function markDataChanged(){
    const now=Date.now();
    if(now-lastDirtyWriteAt>=15000){
      lastDirtyWriteAt=now;
      GM_setValue(AUTO_BACKUP_DIRTY_KEY,now);
    }
  }
  const SERVER_PACE=1400;
  const SERVER_AUTHOR='최영현';
  const serverPanel=document.createElement('details');
  serverPanel.open=true;
  serverPanel.style.cssText='border:1px solid #ffffff60;border-radius:7px;padding:8px;margin-bottom:8px';
  const serverSummary=document.createElement('summary');
  serverSummary.textContent='서버에서 직접 채팅 수집 (새 방식)';
  serverSummary.style.cssText='font-weight:700;cursor:pointer;margin:3px 0';
  serverPanel.appendChild(serverSummary);
  controls.insertBefore(serverPanel,controls.firstChild);
  const serverInfo=document.createElement('div');
  serverInfo.style.cssText='font-size:11px;white-space:pre-wrap;line-height:1.55;margin:7px 0';
  serverPanel.appendChild(serverInfo);
  const serverControls=document.createElement('div');
  serverControls.style.cssText='display:flex;flex-direction:column;gap:6px';
  serverPanel.appendChild(serverControls);
  const syncOption=document.createElement('label');
  syncOption.style.cssText='font-size:11px;display:flex;align-items:center;gap:5px;margin:7px 0';
  const autoSync=document.createElement('input');
  autoSync.type='checkbox';autoSync.checked=GM_getValue(SERVER_AUTOSYNC_KEY,true);
  autoSync.onchange=()=>GM_setValue(SERVER_AUTOSYNC_KEY,autoSync.checked);
  syncOption.append(autoSync,document.createTextNode('자동 동기화: 새 메시지 감지·3분마다 확인·재접속 시 보충'));
  serverPanel.appendChild(syncOption);

  // 기존 저장 기록을 삭제하지 않고, 메시지 ID가 있으면 그 ID를 우선 사용
  function validServerId(value){
    return typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(value);
  }
  function serverDate(raw){
    const d=new Date(raw||'');
    if(!Number.isFinite(d.getTime()))return null;
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{
      timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
    }).formatToParts(d).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
    return parts.year+'-'+parts.month+'-'+parts.day+'T'+
      parts.hour+':'+parts.minute+':'+parts.second+'+09:00';
  }
  function serverTimeLabel(raw){
    const d=new Date(raw||'');
    return Number.isFinite(d.getTime())
      ?d.toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour:'numeric',minute:'2-digit'})
      :null;
  }
  function serverRecord(msg){
    if(!msg || msg.author?.nickname?.trim()!==SERVER_AUTHOR || !validServerId(msg.id))
      return null;
    // 원본 이미지 우선, 확대보기 주소는 원본이 없을 때도 수집할 수 있도록 보강
    const imageCandidates=[msg.image_url,msg.zoom_image_url,msg.file_url,
      msg.imageUrl,msg.zoomImageUrl,msg.fileUrl];
    if(Array.isArray(msg.attachments))msg.attachments.forEach(a=>{
      imageCandidates.push(a?.url,a?.image_url,a?.zoom_image_url,a?.file_url);
    });
    const imgs=[...new Set(imageCandidates.map(cleanUrl).filter(Boolean))]
      .map(url=>({alt:'첨부 이미지',sourceType:'server',url}));
    const body=typeof msg.content==='string'?msg.content:'';
    return {
      author:SERVER_AUTHOR,
      text:body,
      briefing:body.includes('##'),
      postedAt:serverDate(msg.created_at),
      timeRaw:msg.created_at||null,
      timeLabel:serverTimeLabel(msg.created_at),
      capturedAt:new Date().toISOString(),
      channel:'/ko/chat',
      images:imgs,
      messageId:msg.id,
      roomId:msg.room_id||SERVER_ROOM,
      authorId:msg.author?.id||null,
      serverMessageType:msg.message_type||null,
      serverFileUrl:typeof msg.file_url==='string'?msg.file_url:null,
      serverImageUrl:cleanUrl(msg.image_url),
      serverZoomImageUrl:cleanUrl(msg.zoom_image_url)
    };
  }
  function imageMerge(older,newer){
    const known=normalizedImages(older);
    for(const img of normalizedImages(newer)){
      if(img.url && known.some(x=>x.url===img.url))continue;
      const placeholder=known.findIndex(x=>!x.url);
      if(placeholder>=0 && img.url)known[placeholder]={...known[placeholder],...img};
      else known.push(img);
    }
    return known;
  }
  function serverIndexer(){
    const byId=new Map(),byContentDate=new Map();
    for(const item of entries()){
      const r=item.r;
      if(validServerId(r.messageId))byId.set(r.messageId,item.key);
      if(r.text && r.postedAt && Number.isFinite(Date.parse(r.postedAt))){
        const key=r.text+'|'+Math.floor(Date.parse(r.postedAt)/1000);
        const list=byContentDate.get(key)||[];
        list.push(item);byContentDate.set(key,list);
      }
    }
    return {byId,byContentDate};
  }
  function saveServerRecord(record,index){
    if(!record)return 'skip';
    const id=record.messageId;
    let key=index.byId.get(id)||null;
    if(!key && record.text && record.postedAt){
      const matchKey=record.text+'|'+Math.floor(Date.parse(record.postedAt)/1000);
      const matches=(index.byContentDate.get(matchKey)||[])
        .filter(x=>!x.r.messageId || x.r.messageId===id);
      if(matches.length===1)key=matches[0].key;
    }
    if(!key)key=PREFIX+'server_'+id;
    const old=GM_getValue(key,null);
    const updated=old?{
      ...old,
      messageId:id,
      roomId:record.roomId,
      authorId:record.authorId,
      serverMessageType:record.serverMessageType,
      serverFileUrl:record.serverFileUrl,
      serverImageUrl:record.serverImageUrl || old.serverImageUrl || null,
      serverZoomImageUrl:record.serverZoomImageUrl || old.serverZoomImageUrl || null,
      postedAt:record.postedAt||old.postedAt,
      timeRaw:record.timeRaw||old.timeRaw,
      timeLabel:record.timeLabel||old.timeLabel,
      images:imageMerge(old.images,record.images),
      text:record.text||old.text,
      briefing:record.briefing||old.briefing
    }:record;
    index.byId.set(id,key);
    if(!old || JSON.stringify(updated)!==JSON.stringify(old)){
      GM_setValue(key,updated);
      markDataChanged();
      return old?'enriched':'added';
    }
    return 'already';
  }
  async function getServerPage(before){
    const url=new URL('/api/v1/chat/rooms/'+SERVER_ROOM+'/messages',location.origin);
    url.searchParams.set('limit','200');
    if(before)url.searchParams.set('before',before);
    const res=await fetch(url.toString(),{
      method:'GET',credentials:'same-origin',
      headers:{Accept:'application/json'},cache:'no-store'
    });
    if(res.status===401||res.status===403)
      throw new Error('로그인 또는 채팅방 접근 권한 확인 필요 (HTTP '+res.status+')');
    if(res.status===429)
      throw new Error('요청 제한(429). 수집을 중단했습니다. 우회하거나 반복 요청하지 마세요.');
    if(!res.ok)throw new Error('채팅 서버 응답 오류 HTTP '+res.status);
    const json=await res.json();
    if(!Array.isArray(json.messages) || typeof json.has_more!=='boolean')
      throw new Error('서버 응답 형식이 바뀌었습니다 (messages/has_more 확인 필요)');
    if(json.has_more && !validServerId(json.next_cursor))
      throw new Error('다음 페이지 커서가 올바르지 않습니다');
    return json;
  }
  let serverBusy=false,serverStop=false;
  function progressLabel(extra){
    const p=GM_getValue(SERVER_PROGRESS_KEY,null);
    const line=p?.phase==='complete'
      ? '과거 서버 제공 범위 조회 완료 · 다음 접속 때 신규 기록 보충'
      :p?.phase==='catchup'
        ? '새 기록 보충 중 · 이어받기 가능'
        :p?.phase==='history'
          ? '과거 기록 수집 중/중단 · 이어받기 가능'
          : '서버 수집 전';
    serverInfo.textContent=line+
      '\n총 조회 '+(p?.pages||0)+'페이지 · 검사 '+(p?.seen||0)+'건 · 선생님 '+(p?.teacher||0)+'건'+
      '\n'+(extra||p?.note||'서버가 제공하는 기록만 수집할 수 있습니다.');
  }
  progressLabel();
  function hasKnownServerId(id,index){return !!(id&&index.byId.has(id));}
  async function runServerCollection(maxPages,auto=false){
    if(serverBusy||imageRepairBusy)return;
    if(location.hostname!=='chartmentor.net')return;
    serverBusy=true;serverStop=false;
    const oldState=GM_getValue(SERVER_PROGRESS_KEY,null);
    const previouslyDone=oldState?.phase==='complete';
    const continuation=oldState && (oldState.phase==='history'||oldState.phase==='catchup');
    const phase=continuation?oldState.phase:(previouslyDone?'catchup':'history');
    let state=continuation?{...oldState}:{
      phase,cursor:null,pages:0,seen:0,teacher:0,
      latestId:null,boundaryId:previouslyDone?oldState.latestId:null,
      startedAt:new Date().toISOString(),note:'수집 시작'
    };
    const index=serverIndexer();
    let pagesThisRun=0,foundThisRun=0,addedThisRun=0;
    const cursors=new Set();
    let reason='';
    try{
      for(let p=0;p<maxPages && !serverStop;p++){
        const before=state.cursor||null;
        if(before && cursors.has(before))throw new Error('커서가 반복되어 중단했습니다');
        if(before)cursors.add(before);
        const json=await getServerPage(before);
        if(json.messages.length===0 && json.has_more)
          throw new Error('다음 페이지가 있지만 메시지가 비어 있습니다');
        if(!state.latestId && json.messages[0]?.id)
          state.latestId=json.messages[0].id;
        let boundaryReached=false;
        for(const msg of json.messages){
          if(state.phase==='catchup' && msg.id===state.boundaryId){
            boundaryReached=true;break;
          }
          state.seen++;
          const r=serverRecord(msg);
          if(!r)continue;
          state.teacher++;foundThisRun++;
          const outcome=saveServerRecord(r,index);
          if(outcome==='added')addedThisRun++;
        }
        state.pages++;pagesThisRun++;
        state.cursor=json.next_cursor||null;
        state.updatedAt=new Date().toISOString();
        state.note='이번 실행 '+pagesThisRun+'/'+(Number.isFinite(maxPages)?maxPages:'끝까지')+'페이지, 선생님 '+foundThisRun+
          '건, 신규 '+addedThisRun+'건';
        if(boundaryReached || !json.has_more){
          state.phase='complete';state.cursor=null;
          state.note=boundaryReached?'이전 최신 메시지에 도달해 새 기록 보충 완료'
            :'서버에서 더 오래된 메시지가 없다고 응답함 (has_more=false)';
        }
        GM_setValue(SERVER_PROGRESS_KEY,state);
        if(pagesThisRun===1||pagesThisRun%3===0){
          progressLabel(state.note);
          activity.textContent=state.note;
          refresh();
        }
        if(state.phase==='complete')break;
        if(p<maxPages-1)await sleep(SERVER_PACE);
      }
      if(serverStop)reason='사용자 중지. 다음 실행에서 저장된 커서부터 재개합니다.';
      else if(state.phase!=='complete')reason=Number.isFinite(maxPages)?'이번 회차 페이지 제한에 도달. 다시 누르면 이어서 진행합니다.':'완료되지 않았습니다. 현재 커서부터 다시 시작할 수 있습니다.';
    }catch(err){
      reason='중단: '+err.message;
      console.error('차트멘토 서버 수집 오류',err);
      // 자동 수집 시 인증 오류·요청 제한에 대해 반복 재시도하지 않는다.
      if(auto)GM_setValue(AUTO_SYNC_PAUSE_KEY,reason);
      if(!auto)alert(reason);
    }finally{
      serverBusy=false;
      if(!reason && state.phase==='complete')
        GM_setValue(AUTO_SYNC_PAUSE_KEY,null);
      state.note=reason||state.note;
      state.updatedAt=new Date().toISOString();
      GM_setValue(SERVER_PROGRESS_KEY,state);
      progressLabel(state.note);refresh();fillPicker();
      activity.textContent='서버 수집 종료 · 이번에 신규 '+addedThisRun+'건';
    }
  }
  button('서버 연결 시험 · 1페이지',()=>runServerCollection(1),serverControls);
  button('서버 전체 과거 수집 · 끝까지 자동 (중지 가능)',()=>runServerCollection(Infinity),serverControls);
  button('서버 수집 중지',()=>{
    serverStop=true;activity.textContent='현재 페이지 저장 후 중지 요청됨';
  },serverControls);
  // 자동 업데이트: 탭이 열려 있을 때만 최신 기록과 연결한다.
  const autoBackupOption=document.createElement('label');
  autoBackupOption.style.cssText='font-size:11px;display:flex;align-items:center;gap:5px;margin:7px 0';
  const autoBackupBox=document.createElement('input');
  autoBackupBox.type='checkbox';
  autoBackupBox.checked=GM_getValue(AUTO_BACKUP_ENABLED_KEY,true);
  autoBackupBox.onchange=()=>{
    GM_setValue(AUTO_BACKUP_ENABLED_KEY,autoBackupBox.checked);
    showAutoStatus();
  };
  autoBackupOption.append(autoBackupBox,
    document.createTextNode('JSON 자동 백업 (새 자료가 있으면 하루 1회 다운로드 시도)'));
  serverPanel.appendChild(autoBackupOption);
  const autoHelp=document.createElement('div');
  autoHelp.style.cssText='font-size:11px;white-space:pre-wrap;line-height:1.4;opacity:.9;margin:5px 0';
  serverPanel.appendChild(autoHelp);
  let autoSyncTimer=null;
  function showAutoStatus(){
    const paused=GM_getValue(AUTO_SYNC_PAUSE_KEY,null);
    const backupAt=GM_getValue(AUTO_BACKUP_LAST_KEY,0);
    const toKST=t=>t?new Date(t).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'아직 없음';
    autoHelp.textContent=(paused?'자동 서버 확인 중지: '+paused:
      '새 메시지 감지 및 3분 정기 확인(탭이 열려 있을 때)')+
      '\n마지막 자동 백업 요청: '+toKST(backupAt)+
      '\n※ 다운로드 허용 여부는 브라우저에서 확인. 탭이 닫히면 자동 실행되지 않습니다.';
  }
  showAutoStatus();
  function maybeAutoBackup(){
    if(!location.pathname.startsWith('/ko/chat') ||
       !GM_getValue(AUTO_BACKUP_ENABLED_KEY,true) ||
       document.hidden||serverBusy||imageRepairBusy)return;
    const last=GM_getValue(AUTO_BACKUP_LAST_KEY,0);
    const dirty=GM_getValue(AUTO_BACKUP_DIRTY_KEY,0);
    const now=Date.now();
    if(!dirty || dirty<=last || now-last<AUTO_BACKUP_SPACING_MS)return;
    try{
      downloadJSON(true); // 다운로드 요청. 실제 저장 여부는 브라우저 설정에 따름.
      GM_setValue(AUTO_BACKUP_LAST_KEY,now);
      showAutoStatus();
      activity.textContent='최신 자료 JSON 자동 백업 다운로드 요청됨';
    }catch(e){
      console.warn('차트멘토 자동 백업 요청 실패',e);
      activity.textContent='자동 백업 요청 실패 · 백업 메뉴에서 직접 확인';
    }
  }
  async function tryAutoSync(){
    if(!location.pathname.startsWith('/ko/chat') ||
       !autoSync.checked || document.hidden || navigator.onLine===false ||
       serverBusy || imageRepairBusy || GM_getValue(AUTO_SYNC_PAUSE_KEY,null))
      return;
    const phase=GM_getValue(SERVER_PROGRESS_KEY,null)?.phase;
    if(phase!=='complete' && phase!=='catchup')return;
    GM_setValue(AUTO_SYNC_LAST_KEY,Date.now());
    await runServerCollection(20,true);
    showAutoStatus();
    maybeAutoBackup();
  }
  function scheduleAutoSync(delayMs=8000){
    if(!location.pathname.startsWith('/ko/chat') ||
       !autoSync.checked || document.hidden || navigator.onLine===false ||
       GM_getValue(AUTO_SYNC_PAUSE_KEY,null) || serverBusy || imageRepairBusy)
      return;
    const phase=GM_getValue(SERVER_PROGRESS_KEY,null)?.phase;
    if(phase!=='complete' && phase!=='catchup')return;
    const since=Date.now()-GM_getValue(AUTO_SYNC_LAST_KEY,0);
    const delay=Math.max(delayMs,AUTO_SYNC_COOLDOWN_MS-since,0);
    if(autoSyncTimer!==null)return; // 중복된 채팅 DOM 이벤트 합치기
    autoSyncTimer=setTimeout(()=>{
      autoSyncTimer=null;
      tryAutoSync();
    },delay);
  }
  // 채팅방을 떠나 있는 동안의 새 기록은 재접속 시 서버 커서로 보충한다.
  setTimeout(()=>scheduleAutoSync(0),6000);
  setInterval(()=>{
    scheduleAutoSync(0);
    maybeAutoBackup();
    showAutoStatus();
  },AUTO_SYNC_INTERVAL_MS);
  document.addEventListener('visibilitychange',()=>{
    if(!document.hidden){scheduleAutoSync(1200);maybeAutoBackup();}
  });
  addEventListener('online',()=>scheduleAutoSync(1200));

  // V2.9.2: 읽기 API 재조회로 과거 이미지 링크를 보강하고 원인별로 집계.
  // 기존 서버 과거-수집 커서는 절대 변경하지 않는다.
  const IMAGE_REPAIR_KEY='cm292_image_repair';
  let imageRepairBusy=false,imageRepairStop=false;
  const repairPanel=document.createElement('details');
  repairPanel.style.cssText='margin:7px 0;border-top:1px solid #ffffff60;padding-top:6px';
  const repairSummary=document.createElement('summary');
  repairSummary.textContent='이미지 누락 조사 · 재조회';
  repairSummary.style.cssText='font-size:12px;font-weight:700;cursor:pointer';
  repairPanel.appendChild(repairSummary);serverPanel.appendChild(repairPanel);
  const repairInfo=document.createElement('div');
  repairInfo.style.cssText='font-size:11px;line-height:1.45;white-space:pre-wrap;padding:6px 0';
  repairPanel.appendChild(repairInfo);
  const repairButtons=document.createElement('div');
  repairButtons.style.cssText='display:flex;flex-direction:column;gap:6px';
  repairPanel.appendChild(repairButtons);
  function showRepairProgress(note){
    const x=GM_getValue(IMAGE_REPAIR_KEY,null);
    repairInfo.textContent=(x?.phase==='complete'?'마지막 이미지 재조회 완료'
      :x?.phase==='running'?'재조회 진행/이어받기 가능':'이미지 진단 전')+
      '\n조회 '+(x?.pages||0)+'페이지 · 선생님 이미지형 '+(x?.teacherImage||0)+'건'+
      '\n서버 image_url 있음 '+(x?.original||0)+' · zoom_image_url 있음 '+(x?.zoom||0)+
      '\n둘 다 없음 '+(x?.noUrls||0)+' · 주소 보강 '+(x?.recovered||0)+'건'+
      '\n'+(note||x?.note||'기존 원본 기록과 브리핑은 그대로 유지합니다.');
  }
  showRepairProgress();
  async function repairServerImages(maxPages=Infinity){
    if(serverBusy||imageRepairBusy){
      alert('서버 수집이 진행 중입니다. 수집이 끝난 다음 시도해 주세요.');
      return;
    }
    imageRepairBusy=true;imageRepairStop=false;
    const previous=GM_getValue(IMAGE_REPAIR_KEY,null);
    let st=previous?.phase==='running'?{...previous}:{
      phase:'running',cursor:null,pages:0,teacherImage:0,
      original:0,zoom:0,noUrls:0,recovered:0,invalidUrls:0,
      startedAt:new Date().toISOString(),note:'이미지 재조회 시작'
    };
    const idx=serverIndexer();
    let n=0,reason='';
    try{
      const cursors=new Set();
      while(n<maxPages && !imageRepairStop){
        if(st.cursor && cursors.has(st.cursor))
          throw new Error('다음 페이지 커서가 반복됩니다');
        if(st.cursor)cursors.add(st.cursor);
        const data=await getServerPage(st.cursor||null);
        if(!data.messages.length && data.has_more)
          throw new Error('메시지가 없는데 다음 페이지가 있다고 응답했습니다');
        for(const msg of data.messages){
          if(msg.author?.nickname?.trim()!==SERVER_AUTHOR ||
             msg.message_type!=='image')continue;
          st.teacherImage++;
          if(typeof msg.image_url==='string' && msg.image_url.trim())st.original++;
          if(typeof msg.zoom_image_url==='string' && msg.zoom_image_url.trim())st.zoom++;
          if(!msg.image_url && !msg.zoom_image_url)st.noUrls++;
          const entry=serverRecord(msg);
          if(!entry)continue;
          const knownKey=idx.byId.get(entry.messageId);
          const prior=knownKey?GM_getValue(knownKey,null):null;
          const hadUrl=(prior?.images||[]).some(i=>!!cleanUrl(i.url));
          const received=entry.images.some(i=>!!i.url);
          if(!received && (msg.image_url||msg.zoom_image_url))st.invalidUrls++;
          saveServerRecord(entry,idx);
          if(received && !hadUrl)st.recovered++;
        }
        st.pages++;n++;
        st.cursor=data.next_cursor||null;
        st.updatedAt=new Date().toISOString();
        st.note='이번 조회 '+n+'페이지 진행 중';
        if(!data.has_more){
          st.phase='complete';st.cursor=null;
          st.note='서버가 제공한 과거 기록의 끝까지 이미지 재조회 완료';
        }
        GM_setValue(IMAGE_REPAIR_KEY,st);
        if(n===1||n%3===0||st.phase==='complete'){
          showRepairProgress();refresh();
          activity.textContent='이미지 재조회 '+st.pages+'페이지 · 주소 보강 '+st.recovered+'건';
        }
        if(st.phase==='complete')break;
        await sleep(SERVER_PACE);
      }
      if(imageRepairStop)reason='사용자 중지: 마지막 페이지 커서부터 재개 가능';
      else if(st.phase!=='complete')reason='1페이지 검사 완료. 다시 누르면 다음 페이지부터 이어집니다.';
    }catch(e){
      reason='재조회 중단: '+e.message;
      console.error('차트멘토 이미지 재조회 중단',e);
      alert(reason);
    }finally{
      st.note=reason||st.note;
      st.updatedAt=new Date().toISOString();
      GM_setValue(IMAGE_REPAIR_KEY,st);
      imageRepairBusy=false;
      showRepairProgress();refresh();fillPicker();
      activity.textContent=st.note;
    }
  }
  button('이미지 서버 확인 · 1페이지',()=>repairServerImages(1),repairButtons);
  button('누락 이미지 보강 · 끝까지 재조회 (중지 가능)',()=>repairServerImages(Infinity),repairButtons);
  button('이미지 재조회 중지',()=>{
    imageRepairStop=true;activity.textContent='현재 페이지를 저장한 후 중지합니다';
  },repairButtons);

  // V2.8: 전체 과거 대화 수집을 위한 길게 이어지는 스크롤 세션
  // 서버의 '최초 대화' 표시는 확인할 수 없으므로 멈춤과 완전 수집을 구별한다.
  const HISTORY_KEY='cm28_history_progress';
  const historyHelp=document.createElement('div');
  historyHelp.style.cssText='font-size:11px;line-height:1.5;white-space:pre-wrap;opacity:.95;margin-bottom:7px';
  controls.appendChild(historyHelp);
  let scrolling=false,stopScroll=false;
  const initialHistory=GM_getValue(HISTORY_KEY,null);
  if(initialHistory?.state==='running'){
    GM_setValue(HISTORY_KEY,{...initialHistory,state:'interrupted',
      note:'페이지가 닫히거나 새로고침되어 중단됨. 다시 실행하면 현재 표시된 위치부터 위쪽을 탐색합니다.'});
  }
  function oldestPost() {
    let oldest=Infinity, newest=-Infinity;
    for(const {r} of entries()){
      const t=r.postedAt?Date.parse(r.postedAt):NaN;
      if(Number.isFinite(t)){oldest=Math.min(oldest,t);newest=Math.max(newest,t);}
    }
    return {oldest:Number.isFinite(oldest)?new Date(oldest).toISOString():null,
      newest:Number.isFinite(newest)?new Date(newest).toISOString():null};
  }
  function localTime(iso) {
    return iso?new Date(iso).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',
      year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'확인된 날짜 없음';
  }
  function oldestScreenKey(sc) {
    const col=sc.querySelector('[data-chat-column="true"]');
    if(!col)return '';
    return (col.querySelector('[data-chat-time="true"]')?.getAttribute('title')||'')+
      ' / '+(col.textContent||'').replace(/\s+/g,' ').slice(0,140);
  }
  function showHistoryProgress(message) {
    const bounds=oldestPost();
    const saved=GM_getValue(HISTORY_KEY,null);
    historyHelp.textContent=
      '현재 저장된 가장 오래된 작성일: '+localTime(bounds.oldest)+
      '\n'+(message||saved?.note||'과거 기록 수집 전')+
      '\n※ 사이트에서 처음 메시지까지 열렸는지는 별도 확인이 필요합니다.';
  }
  showHistoryProgress();
  async function gatherHistory(maxSteps,mode) {
    if(scrolling)return;
    if(!findScroller()){
      alert('채팅 스크롤 영역을 찾지 못했습니다. 채팅 메시지를 표시한 뒤 다시 눌러 주세요.');
      return;
    }
    scrolling=true;stopScroll=false;
    scan();
    let initialCount=entries().length,stuck=0,step=0;
    let reason='정해진 탐색 횟수에 도달했습니다. 이어서 다시 실행할 수 있습니다.';
    const startedAt=new Date().toISOString();
    try {
      for(step=1;step<=maxSteps && !stopScroll;step++){
        const sc=findScroller();
        if(!sc){reason='채팅 스크롤 영역을 찾지 못해 중단됨';break;}
        const beforeTop=sc.scrollTop,beforeHeight=sc.scrollHeight;
        const first=oldestScreenKey(sc);
        const beforeCount=entries().length;
        const beforeOldest=oldestPost().oldest;
        const stepSize=Math.max(220,Math.floor(sc.clientHeight*0.65));
        sc.scrollTop=Math.max(0,beforeTop-stepSize);
        // 채팅 사이트가 이전 메시지를 비동기 로드할 시간을 확보
        await sleep(1050);
        scan();
        await sleep(500);
        scan();
        const cur=findScroller();
        if(!cur){reason='스크롤 영역이 사라져 중단됨';break;}
        const afterTop=cur.scrollTop;
        const afterFirst=oldestScreenKey(cur);
        const afterOldest=oldestPost().oldest;
        const movedUp=afterTop<beforeTop-3;
        const olderLoaded=(afterFirst!==first && !!afterFirst) ||
          (!!afterOldest && (!beforeOldest || afterOldest<beforeOldest));
        const heightChanged=cur.scrollHeight>beforeHeight+40;
        const newRecords=entries().length>beforeCount;
        // 실시간 채팅이 맨 아래로 강제로 점프할 때 무한 반복 방지
        if(afterTop>beforeTop+Math.max(stepSize*3,800) && !olderLoaded && !newRecords){
          reason='채팅방이 아래로 점프해 자동 탐색을 중지함. 다시 실행해 주세요.';
          break;
        }
        if(movedUp || olderLoaded || (heightChanged && afterFirst!==first) || newRecords)
          stuck=0;
        else
          stuck++;
        const note=`${mode} ${step}/${maxSteps} · 신규 기록 +${entries().length-initialCount}건 · 정지 신호 ${stuck}/8`;
        GM_setValue(HISTORY_KEY,{
          state:'running',mode,startedAt,updatedAt:new Date().toISOString(),
          steps:step,initialCount,currentCount:entries().length,
          oldestPostAt:afterOldest, note
        });
        activity.textContent=note;
        if(step%5===0)showHistoryProgress(note);
        if(stuck>=8){
          reason='위쪽에서 8회 연속 새로운 메시지/이동을 확인하지 못함. 가장 오래된 메시지 도달 여부는 화면에서 확인 필요.';
          break;
        }
      }
      if(stopScroll)reason='사용자가 중지함. 다음 실행은 현재 표시된 위치부터 다시 위로 탐색합니다.';
    } catch(err) {
      reason='탐색 오류: '+err.message;
      console.error('차트멘토 과거 수집 오류',err);
    } finally {
      scrolling=false;
      const final={state:'stopped',mode,startedAt,updatedAt:new Date().toISOString(),
        steps:Math.min(step,maxSteps),initialCount,currentCount:entries().length,
        oldestPostAt:oldestPost().oldest,note:reason};
      GM_setValue(HISTORY_KEY,final);
      refresh();showHistoryProgress(reason);
      activity.textContent=`과거 탐색 종료 · 신규 기록 +${entries().length-initialCount}건`;
    }
  }
  button('처음 대화까지 과거 수집 (최대 500회)',()=>{
    gatherHistory(500,'전체 과거');
  },controls);
  button('과거 채팅 빠른 수집 (35회)',()=>{
    gatherHistory(35,'빠른 탐색');
  },controls);
  button('자동 스크롤 중지',()=>{stopScroll=true;},controls);
  button('현재 화면 이미지 다시 탐색 · 누락 현황',()=>{
    const previous=imageList().length;
    scan();
    const stats=imageStats();
    activity.textContent=`이미지 확인: 원본 ${stats.sourceCount}개 / URL 미확인 ${stats.unresolvedRows}건`;
    alert(`첨부가 감지된 기록: ${stats.imageRows}건\n원본 URL: ${stats.sourceCount}개\n원본 주소 미확인 기록: ${stats.unresolvedRows}건\n이번 재탐색으로 찾은 원본: +${stats.sourceCount-previous}개\n\n과거 이미지가 화면에 다시 나타나면 지연 로딩 후 자동으로 보완을 시도합니다. 원본 이미지가 실제로 제공되지 않으면 자동 복원할 수 없습니다.`);
  },controls);


  function downloadJSON(automatic=false) {
    const out={version:'3.0.0',exportedAt:new Date().toISOString(),
      records:entries().map(x => ({...x.r, classification:resolved(x),
        storageKey:x.key})),
      knowledgeReviews:GM_listValues().filter(k=>k.startsWith(KNOWLEDGE_PREFIX))
        .map(key=>({key,value:GM_getValue(key,null)})),
      manualLabels:entries().map(x => ({storageKey:x.key,
        value:GM_getValue(labelKey(x.key),null)})).filter(x=>x.value),
      historyProgress:GM_getValue(HISTORY_KEY,null),
      serverProgress:GM_getValue(SERVER_PROGRESS_KEY,null),
      autoSyncControl:{
        enabled:GM_getValue(SERVER_AUTOSYNC_KEY,true),
        paused:GM_getValue(AUTO_SYNC_PAUSE_KEY,null),
        lastAttemptAt:GM_getValue(AUTO_SYNC_LAST_KEY,null),
        lastBackupRequestAt:GM_getValue(AUTO_BACKUP_LAST_KEY,null)
      },
      imageRepairProgress:GM_getValue(IMAGE_REPAIR_KEY,null),
      knownDateRange:oldestPost(),
      completenessNote:'이 파일은 브라우저 화면에 로딩되어 확인된 메시지를 포함합니다. 사이트의 최초 메시지까지 수집되었음을 보증하지 않습니다.'};
    const url=URL.createObjectURL(new Blob([JSON.stringify(out,null,2)],{type:'application/json'}));
    const a=document.createElement('a'); a.href=url; a.download=automatic?'chartmentor_auto_'+new Date().toISOString().replace(/[:.]/g,'-')+'.json':'chartmentor_v3_0_0_backup.json'; a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  button('JSON 백업 (라벨 포함)',()=>downloadJSON(false),backupControls);
  const doneKey=url=>'cm23_downloaded_'+hash(url);
  let downloading=false, stopDownload=false;
  button('새 원본 이미지 최대 10장 저장',async()=>{
    if (downloading) return;
    let queue=imageList().filter(x=>!GM_getValue(doneKey(x.url),false)).slice(0,10);
    if (!queue.length) return alert('새 이미지가 없습니다.');
    downloading=true;stopDownload=false;let ok=0;
    for (let i=0;i<queue.length && !stopDownload;i++) {
      let item=queue[i]; activity.textContent=`이미지 ${i+1}/${queue.length}`;
      const saved=await new Promise(resolve=>{
        let finished=false;
        const end=good=>{if(finished)return;finished=true;clearTimeout(timer);resolve(good);};
        const timer=setTimeout(()=>end(false),30000);
        try { GM_download({url:item.url,name:item.name,saveAs:false,conflictAction:'uniquify',
          onload:()=>end(true),onerror:()=>end(false),ontimeout:()=>end(false)}); }
        catch {end(false);}
      });
      if(saved){GM_setValue(doneKey(item.url),true);ok++;}
      await sleep(700);
    }
    downloading=false; activity.textContent=`이미지 저장 종료 / 성공 ${ok}장`;
  },controls);
  button('이미지 저장 중지',()=>{stopDownload=true;},controls);

  const fileInput=document.createElement('input');fileInput.type='file';fileInput.accept='.json,application/json';
  fileInput.multiple=true;fileInput.style.display='none';backupControls.appendChild(fileInput);
  function collect(obj,list,depth=0){
    if(!obj||typeof obj!=='object'||depth>12||list.length>100000)return;
    if(Array.isArray(obj)){obj.forEach(x=>collect(x,list,depth+1));return;}
    if(obj.author==='최영현'&&typeof obj.text==='string'){list.push(obj);return;}
    Object.values(obj).forEach(x=>collect(x,list,depth+1));
  }
  button('예전 JSON 복구',()=>fileInput.click(),backupControls);
  button('창 위치 초기화',()=>{
    positionPanel(innerWidth-325,115,true);
    activity.textContent='창 위치를 초기화했습니다.';
  },backupControls);

  fileInput.onchange=async()=>{
    let found=0,updated=0;
    for(const f of fileInput.files){
      try {let obj=JSON.parse(await f.text()),rows=[];collect(obj,rows);found+=rows.length;
        rows.forEach(r=>{if(saveRecord(r))updated++;});
        if(Array.isArray(obj.manualLabels)) obj.manualLabels.forEach(x=>{
          if(x.storageKey?.startsWith(PREFIX)&&x.value)
            GM_setValue(labelKey(x.storageKey),x.value);
        });
        if(Array.isArray(obj.knowledgeReviews))obj.knowledgeReviews.forEach(x=>{
          if(typeof x.key==='string' && /^cm30_review_[0-9a-f]{16}$/.test(x.key)
             && x.value && typeof x.value==='object')
            GM_setValue(x.key,x.value);
        });
      }catch(err){console.error('복구 오류',f.name,err);}
    }
    refresh();fillPicker();fileInput.value='';alert(`확인 ${found}건 / 추가·보완 ${updated}건`);
  };

  // 차트 라벨 수동 검토. 자동분류가 틀리거나 이미지에만 정보가 있을 때 사용
  title('메시지 선택 (날짜 없는 기록도 분류 가능)',fields);
  const picker=select([],fields);
  const preview=title('',fields);
  title('차트 대상 종목',fields);
  const assets=select([
    ['', '자동분류 사용'],['UNKNOWN','미확인으로 지정'],['BTC','BTC 비트코인'],['ETH','ETH 이더리움'],
    ['SOL','SOL 솔라나'],['XRP','XRP 리플'],['GOLD','금/골드'],
    ['NASDAQ','나스닥'],['KOSPI','코스피'],['NVDA','엔비디아'],['OTHER','기타']
  ],fields);
  title('차트 시간봉',fields);
  const frames=select([['','자동분류 사용 / 미확인'],
    ['1m','1분'],['3m','3분'],['5m','5분'],['15m','15분'],['30m','30분'],
    ['1h','1시간'],['2h','2시간'],['4h','4시간'],['1d','일봉']],fields);
  title('정확한 티커 (화면에서 확인했을 때만)',fields);
  const tickerInput = document.createElement('input');
  tickerInput.placeholder = '예: BTCUSDT.P (모르면 빈칸)';
  tickerInput.style.cssText = 'width:100%;padding:6px;color:#222;background:#fff;border-radius:5px';
  tickerInput.style.boxSizing='border-box';
  fields.appendChild(tickerInput);
  title('선생님 차트 거래소 (확실할 때만)',fields);
  const sourceEx=select([['','미확인'],['BINANCE','Binance'],['BYBIT','Bybit'],['OTHER','기타']],fields);
  title('선생님 차트 시장 종류 (확실할 때만)',fields);
  const sourceMarket=select([['','미확인'],['PERP','무기한 선물'],['SPOT','현물'],['OTHER','기타']],fields);
  const info=title('',fields);
  const imageAnchor=document.createElement('a');imageAnchor.textContent='첨부 원본 이미지 확인';
  imageAnchor.target='_blank';imageAnchor.rel='noopener noreferrer';
  imageAnchor.style.cssText='color:white;display:block;text-decoration:underline;margin-top:5px';
  fields.appendChild(imageAnchor);
  const imagePreview=document.createElement('img');
  imagePreview.alt='선택한 메시지 첨부 이미지 미리보기';
  imagePreview.loading='lazy';
  imagePreview.style.cssText='width:100%;max-height:220px;object-fit:contain;background:#442576;border-radius:7px;display:none;margin-top:7px;cursor:zoom-in';
  imageAnchor.appendChild(imagePreview);

  let choices=[];
  function selectedItem(){return choices.find(x=>x.key===picker.value)||null;}
  function fillPicker(){
    const prior=picker.value;
    choices=entries().sort((a,b)=>
      (b.r.postedAt ? new Date(b.r.postedAt).getTime() : 0) -
      (a.r.postedAt ? new Date(a.r.postedAt).getTime() : 0));
    picker.replaceChildren();
    choices.forEach(x=>{
      const c=classify(x.r.text||'');
      const opt=document.createElement('option');opt.value=x.key;
      opt.textContent=`${x.r.postedAt ? x.r.postedAt.slice(5,16).replace('T',' ') : '날짜 미확인'} · ${c.asset||'?'} ${c.timeframe||'?'} · ${(x.r.text||'[이미지]').replace(/\s+/g,' ').slice(0,35)}`;
      picker.appendChild(opt);
    });
    if(choices.some(x=>x.key===prior)) picker.value=prior;
    else {
      const example=choices.find(x=>(x.r.text||'').includes('[비트코인5분봉]'));
      if(example)picker.value=example.key;
    }
    showSelection();
  }
  function showSelection(){
    const x=selectedItem(); if(!x){preview.textContent='작성 날짜 있는 기록 없음';return;}
    let a=classify(x.r.text||''),saved=GM_getValue(labelKey(x.key),{});
    assets.value=saved.asset||'';frames.value=saved.timeframe||'';
    tickerInput.value=saved.ticker||'';
    sourceEx.value=saved.chartExchange||'';sourceMarket.value=saved.chartMarket||'';
    preview.textContent=`${x.r.postedAt}\n${(x.r.text||'[이미지 전용]').slice(0,250)}`;
    preview.style.whiteSpace='pre-wrap';
    info.textContent=`자동 판별: ${a.candidates.join(', ')||'없음'} / ${a.timeframe||'시간봉 미확인'} / ${a.ticker||'티커 미확인'}\n${a.status} · ${a.source}`;
    info.style.whiteSpace='pre-wrap';
    const img=(x.r.images||[]).map(i=>cleanUrl(i.url)).find(Boolean);
    imageAnchor.style.display=img?'inline':'none';
    if(img){imageAnchor.href=img;imagePreview.src=img;imagePreview.style.display='block';}
    else {imageAnchor.removeAttribute('href');imagePreview.removeAttribute('src');imagePreview.style.display='none';}
  }
  picker.onchange=showSelection;
  button('이 메시지 분류 저장',()=>{
    const x=selectedItem();if(!x)return;
    GM_setValue(labelKey(x.key),{reviewed:true,
      asset:assets.value, timeframe:frames.value, ticker:tickerInput.value.trim().toUpperCase(),
      chartExchange:sourceEx.value, chartMarket:sourceMarket.value});
    activity.textContent='차트 분류 저장 완료';
  },fields);

  title('비교용 선물 거래소 (선생님 차트 거래소와 별개)',fields);
  const benchmark=select([['BINANCE','Binance USDT 무기한 선물'],
    ['BYBIT','Bybit USDT 무기한 선물']],fields);
  title('가격 비교 시간봉 (원문 미확인 시 직접 선택)',fields);
  const candleTf=select([['AUTO','원문 시간봉 우선 / 없으면 5분'],
    ['1m','1분봉'],['5m','5분봉'],['15m','15분봉'],['1h','1시간봉'],['4h','4시간봉'],['1d','일봉']],fields);
  const priceOutput=document.createElement('pre');
  priceOutput.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;background:#4b2780;border-radius:6px;padding:8px;max-height:240px;overflow-y:auto';
  fields.appendChild(priceOutput);
  const tfMs={'1m':60000,'3m':180000,'5m':300000,'15m':900000,'30m':1800000,
    '1h':3600000,'2h':7200000,'4h':14400000,'1d':86400000};
  const bybitIntervals={'1m':'1','3m':'3','5m':'5','15m':'15','30m':'30',
    '1h':'60','2h':'120','4h':'240','1d':'D'};
  const priceSymbols={BTC:'BTCUSDT',ETH:'ETHUSDT',SOL:'SOLUSDT',XRP:'XRPUSDT'};
  function requestJson(url){
    return new Promise((resolve,reject)=>GM_xmlhttpRequest({method:'GET',url,
      timeout:15000,onload:r=>{
        if(r.status!==200) return reject(new Error('HTTP '+r.status));
        try {resolve(JSON.parse(r.responseText));}
        catch {reject(new Error('응답 JSON 파싱 실패'));}
      },onerror:()=>reject(new Error('네트워크 오류 또는 접속 제한')),
      ontimeout:()=>reject(new Error('응답 시간 초과'))}));
  }
  let querying=false, lastComparison=null;
  button('이 발언 당시 OHLCV 조회',async()=>{
    if(querying)return;
    let x=selectedItem();if(!x)return;
    let c=resolved(x), symbol=priceSymbols[c.asset];
    if(!symbol){priceOutput.textContent='종목이 미확인이거나 지원 대상이 아닙니다.\nBTC/ETH/SOL/XRP 중 확인 후 라벨을 저장해 주세요.';return;}
    if(!x.r.postedAt){priceOutput.textContent='실제 작성 날짜가 없어 조회할 수 없습니다.';return;}
    const interval=candleTf.value==='AUTO' ? (tfMs[c.timeframe]?c.timeframe:'5m') : candleTf.value;
    const duration=tfMs[interval], time=new Date(x.r.postedAt).getTime();
    if(!Number.isFinite(time)){priceOutput.textContent='작성 날짜 형식 오류';return;}
    const base=Math.floor(time/duration)*duration;
    const start=base-5*duration,end=base+5*duration;
    const source=benchmark.value;
    let url;
    if(source==='BINANCE'){
      const p=new URLSearchParams({symbol,interval,startTime:String(start),endTime:String(end+duration-1),limit:'20'});
      url='https://fapi.binance.com/fapi/v1/klines?'+p;
    }else{
      const p=new URLSearchParams({category:'linear',symbol,interval:bybitIntervals[interval],
        start:String(start),end:String(end),limit:'20'});
      url='https://api.bybit.com/v5/market/kline?'+p;
    }
    querying=true;lastComparison=null;priceOutput.textContent='거래소에서 공개 캔들을 조회하는 중...';
    try{
      const json=await requestJson(url);
      const raw=source==='BINANCE'?json:json?.result?.list;
      if(source==='BYBIT'&&json?.retCode!==0)throw new Error(json?.retMsg||'Bybit 응답 오류');
      if(!Array.isArray(raw)||!raw.length)throw new Error('조회 구간에 캔들이 없음');
      const candles=raw.map(a=>({t:Number(a[0]),o:Number(a[1]),h:Number(a[2]),
        l:Number(a[3]),c:Number(a[4]),v:Number(a[5])})).sort((a,b)=>a.t-b.t);
      const before=candles.filter(k=>k.t+duration<=time).slice(-3);
      // 작성 시각을 포함하는 진행 중이던 캔들은 과거 정보로 사용하지 않음
      const later=candles.filter(k=>k.t>=base+duration && k.t+duration<=Date.now()).slice(0,3);
      lastComparison={storageKey:x.key,source,symbol,interval,
        postedAt:x.r.postedAt,
        capturedAt:new Date().toISOString(),
        confirmedBefore:before,
        completedAfter:later,
        rawCandles:candles,
        warning:'작성 시각을 포함하는 봉의 최종 OHLCV는 당시 알 수 없었음. 비교용 거래소 차트는 선생님 실제 사용 차트로 확정되지 않음.'};
      const describe=k=>`${new Date(k.t).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})}\n O ${k.o} / H ${k.h} / L ${k.l} / C ${k.c} / V ${k.v}`;
      priceOutput.textContent=`비교기준: ${source} ${symbol} USDT 무기한 선물\n`+
        `시간봉: ${interval} ${c.timeframe?'(원문 추정 '+c.timeframe+')':'(분석용 기본값)'}\n`+
        `발언 작성: ${x.r.postedAt}\n\n`+
        `[발언 시점 전에 완성된 최근 캔들 ${before.length}개]\n${before.map(describe).join('\n\n')||'없음'}\n\n`+
        `[발언을 포함한 캔들 종료 이후 완성된 캔들 ${later.length}개]\n${later.map(describe).join('\n\n')||'없음'}\n\n`+
        `※ 작성 시각이 포함된 캔들의 최종 OHLCV는 당시 알 수 없으므로 제외함.\n`+
        `※ 선생님이 실제로 이 거래소/시장 차트를 사용했다는 뜻이 아님.`;
    }catch(err){priceOutput.textContent='조회 실패: '+err.message+'\n거래소 접속 제한이나 지역별 API 제한일 수도 있습니다.';}
    finally{querying=false;}
  },fields);

  // ── 다음 단계: 선택한 사례+원본 이미지 주소+가격 데이터 묶어서 내보내기 ──
  button('선택한 사례 분석 패킷 저장',()=>{
    const x=selectedItem();
    if(!x)return alert('먼저 메시지를 선택해 주세요.');
    const packet={
      version:'3.0.0',kind:'chartmentor-analysis-packet',
      exportedAt:new Date().toISOString(),
      message:{storageKey:x.key,author:x.r.author,text:x.r.text,
        postedAt:x.r.postedAt,timeRaw:x.r.timeRaw,
        images:(x.r.images||[]).map(i=>({url:cleanUrl(i.url),alt:i.alt}))},
      chartClassification:resolved(x),
      marketData:lastComparison?.storageKey===x.key?lastComparison:null,
      notes:[
        '이 JSON은 개인 연구용이다. 이미지 내용은 JSON에 포함되지 않으므로 PNG/JPG 파일도 함께 첨부해야 시각 분석 가능',
        '텍스트에서 추정한 종목과 시간봉은 이미지 검증 전까지 확정 아님',
        'marketData가 null이면 OHLCV 조회 버튼을 먼저 누르고 다시 저장할 것',
        '후속 캔들 자료는 발언 당시에는 존재하지 않았던 정보이므로 결과 검증에만 사용할 것'
      ]
    };
    const url=URL.createObjectURL(new Blob([JSON.stringify(packet,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;
    a.download='chartmentor_analysis_packet_'+new Date().toISOString().slice(0,10)+'.json';
    a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    activity.textContent='선택 사례 패킷을 저장했습니다.';
  },fields);

  // 이미지의 src/href가 나중에 설정되어도 놓치지 않도록 속성 변경과 로드를 감시
  let scanTimer;
  function queueScan(delay=180) {
    clearTimeout(scanTimer);
    scanTimer=setTimeout(scan,delay);
  }
  new MutationObserver(mutations=>{
      if (mutations.every(m => panel.contains(m.target) || launcher.contains(m.target))) return;
      queueScan();
      const newChat=mutations.some(m=>m.type==='childList' &&
        [...m.addedNodes].some(n=>n.nodeType===1 &&
          (n.matches?.('[data-chat-bubble-row="true"]') ||
           n.querySelector?.('[data-chat-bubble-row="true"]'))));
      if(newChat)scheduleAutoSync(8000);
    }).observe(document.body,{
      childList:true,subtree:true,attributes:true,
      attributeFilter:['src','srcset','href','data-src','data-original','data-full-src','data-image-url','style','title']
    });
  document.addEventListener('load',event=>{
    const target=event.target;
    if(target instanceof HTMLImageElement && target.closest('[data-chat-bubble-row="true"]'))
      queueScan(80);
  },true);
  setInterval(()=>{scan();refresh();},5000);
  scan();refresh();fillPicker();
  button('분류 대상 목록 새로고침',fillPicker,fields);
})();