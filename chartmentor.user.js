// ==UserScript==
// @name         차트멘토 최영현 기록기 2.0
// @namespace    local.chartmentor.research
// @version      2.6.2
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
        const images = [...row.querySelectorAll('[data-chat-bubble="true"] img')]
          .map(img => ({alt:img.alt || '첨부 이미지', sourceType:'web-or-other',
            url:cleanUrl(img.getAttribute('src') || img.currentSrc)}));
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
  headingText.textContent = '⋮⋮ 차트멘토 기록기 2.6';
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
  function refresh() {
    const list = entries();
    status.textContent = `기록 ${list.length} · 날짜 ${list.filter(x=>x.r.postedAt).length} · 원본 이미지 ${imageList().length}`;
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
  let scrolling=false, stopScroll=false;
  button('과거 채팅 자동 수집 (최대 35회)', async () => {
    if (scrolling) return;
    if (!findScroller()) { alert('채팅 스크롤 영역을 찾지 못했습니다.'); return; }
    scrolling=true; stopScroll=false;
    let start=entries().length, stuck=0;
    for (let i=1;i<=35 && !stopScroll;i++) {
      let sc=findScroller(); if (!sc) break;
      let top=sc.scrollTop, height=sc.scrollHeight;
      sc.scrollTop = top - Math.max(250,Math.floor(sc.clientHeight*.7));
      activity.textContent=`과거 탐색 ${i}/35`;
      await sleep(1600); scan();
      let cur=findScroller(); if (!cur) break;
      if (Math.abs(cur.scrollTop-top)<=3 && cur.scrollHeight<=height+20) stuck++;
      else stuck=0;
      if (stuck>=4) break;
    }
    scrolling=false; refresh();
    activity.textContent=`탐색 종료 / 새 기록 ${entries().length-start}건`;
  }, controls);
  button('자동 스크롤 중지', ()=>{stopScroll=true;}, controls);

  function downloadJSON() {
    const out={version:'2.6.0',exportedAt:new Date().toISOString(),
      records:entries().map(x => ({...x.r, classification:resolved(x),
        storageKey:x.key})),
      manualLabels:entries().map(x => ({storageKey:x.key,
        value:GM_getValue(labelKey(x.key),null)})).filter(x=>x.value)};
    const url=URL.createObjectURL(new Blob([JSON.stringify(out,null,2)],{type:'application/json'}));
    const a=document.createElement('a'); a.href=url; a.download='chartmentor_v2_6_backup.json'; a.click();
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
      version:'2.6.0',kind:'chartmentor-analysis-packet',
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

  let scanTimer;
  new MutationObserver(mutations=>{
      if (mutations.every(m => panel.contains(m.target) || launcher.contains(m.target))) return;
      clearTimeout(scanTimer);scanTimer=setTimeout(scan,600);
    }).observe(document.body,{childList:true,subtree:true});
  setInterval(()=>{scan();refresh();},5000);
  scan();refresh();fillPicker();
  button('분류 대상 목록 새로고침',fillPicker,fields);
})();