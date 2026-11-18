// ==UserScript==
// @name         차트멘토 최영현 기록기 2.0
// @namespace    local.chartmentor.research
// @version      2.8.0
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
        GM_setValue(key, merged); return true;
      }
      return false;
    }
    GM_setValue(key, r); return true;
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
  headingText.textContent = '⋮⋮ 차트멘토 기록기 2.8';
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
  tabs.style.cssText='display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px;padding:8px';
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
  activate(null); // 처음에는 상위 버튼 3개만 표시

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
      note:'페이지가 닫히거나 새로고침되어 중단됨. 동일 버튼을 누르면 이어서 위로 탐색합니다.'});
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
      ' / '+(col.textContent||'').replace(/\\s+/g,' ').slice(0,140);
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
      if(stopScroll)reason='사용자가 중지함. 다음 실행에서 계속 탐색 가능.';
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


  function downloadJSON() {
    const out={version:'2.8.0',exportedAt:new Date().toISOString(),
      records:entries().map(x => ({...x.r, classification:resolved(x),
        storageKey:x.key})),
      manualLabels:entries().map(x => ({storageKey:x.key,
        value:GM_getValue(labelKey(x.key),null)})).filter(x=>x.value),
      historyProgress:GM_getValue(HISTORY_KEY,null),
      knownDateRange:oldestPost(),
      completenessNote:'이 파일은 브라우저 화면에 로딩되어 확인된 메시지를 포함합니다. 사이트의 최초 메시지까지 수집되었음을 보증하지 않습니다.'};
    const url=URL.createObjectURL(new Blob([JSON.stringify(out,null,2)],{type:'application/json'}));
    const a=document.createElement('a'); a.href=url; a.download='chartmentor_v2_8_backup.json'; a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  button('JSON 백업 (라벨 포함)',downloadJSON,backupControls);
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
      version:'2.8.0',kind:'chartmentor-analysis-packet',
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