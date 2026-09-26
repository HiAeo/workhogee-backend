/* =====================================================================
 * WorkHogee · 效果中心路由（analytics.js）
 * ---------------------------------------------------------------------
 * 公开触点（零授权、零登录）：
 *   GET  /s/{code}            H5 动态画册（服务端渲染，内联埋点 SDK）
 *   GET  /r/{code}            渠道短链 302 跳转，记 redirect
 *   GET  /q/{code}.svg        渠道码二维码 SVG（可直接 <img>/印刷）
 *   POST /c/collect           埋点事件批量上报（反爬/限流/店归属反查）
 *   GET  /sdk/h5-analytics.js 通用埋点 SDK（外部页面嵌入）
 *   POST /leads               画册公开留资（opt_in 必为 true）
 * 业务（会员 token，强制店隔离，shop_id = 会员 id）：
 *   POST/GET /showcases、POST/GET /qr、
 *   GET /leads、POST /leads/{id}/followup、PATCH /leads/{id}、GET /leads/export、
 *   GET /analytics/overview|channels|showcases|funnel
 * 不匹配的路径返回 null，交由 worker.js 继续路由 / 404。
 * ===================================================================*/

import {
  collectEvents, scheduledRollup,
  createShowcase, getShowcase, getPublicShowcase, listShowcases,
  createLink, getLink, listLinks,
  createLead, listLeads, getLeadDecrypted, addFollowup, patchLead,
  analyticsOverview, analyticsChannels, analyticsShowcases, leadsCSV
} from './analytics-store.js';
import { qrSvg } from './qrcode-svg.js';
import { getMemberSession } from './member-auth.js';

export { scheduledRollup };

const ORIGINS = [
  'https://www.workhogee.com', 'http://www.workhogee.com',
  'https://workhogee.com', 'http://workhogee.com',
  'https://hiaeo.github.io', 'http://hiaeo.github.io'
];
function cors(origin) {
  const dev = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '');
  const allow = (ORIGINS.includes(origin) || dev) ? origin : ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function J(payload, status = 200, origin = '', extra = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=UTF-8', ...cors(origin), ...extra }
  });
}
// 短链/H5 画册/二维码由 Worker（api 子域）提供，必须同源闭环；www 是 GitHub Pages 无 /r//s/ 路由
const SHORT_BASE = 'https://api.workhogee.com';
const API_BASE = 'https://api.workhogee.com';
const SITE_BASE = 'https://www.workhogee.com'; // 仅用于官网/法务页链接

// ---------- 反爬 / 限流 ----------
const BOT_RE = /bot|crawler|spider|slurp|baidu|sogou|yisou|bytespider|facebookexternalhit|metainspector|pingdom|uptime|monitor|curl|wget|python|requests|go-http|java\//i;
const collectHits = new Map();
function collectLimited(ip) {
  const now = Date.now(), win = 60000, max = 120;
  const arr = (collectHits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); collectHits.set(ip, arr);
  if (collectHits.size > 5000) for (const [k, v] of collectHits) if (!v.some(t => now - t < win)) collectHits.delete(k);
  return arr.length > max;
}
function ipOf(req) {
  return req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown';
}

// 公开端不信任前端 shop_id：一律由画册 code 反查归属，并缓存反查索引 sccode:{code}
async function shopByShowcase(env, code) {
  if (!code || !env.MEMBERS) return null;
  code = String(code).slice(0, 12);
  const hit = await env.MEMBERS.get('sccode:' + code);
  if (hit) return hit;
  const sc = await getPublicShowcase(env, code);
  if (sc) { try { await env.MEMBERS.put('sccode:' + code, sc.shop_id); } catch { /* ignore */ } return sc.shop_id; }
  return null;
}

async function requireSession(request, env) {
  const s = await getMemberSession(env, request);
  return (s && s.status !== 'suspended') ? s : null;
}
function readBody(request) {
  return request.text().then(t => { try { return t ? JSON.parse(t) : {}; } catch { return {}; } }).catch(() => ({}));
}

/* =====================================================================
 * 埋点 SDK（同一份用于 /s 画册内联 与 /sdk 外链）
 * ===================================================================*/
const SDK_BODY = `(function(){
  function cfg(){
    if (window.__HOGEE_CFG) return window.__HOGEE_CFG;
    var s = document.currentScript;
    var d = s && s.dataset ? s.dataset : {};
    return { apiBase: d.api || location.origin, shop: d.shop || '', showcase: d.showcase || '',
             source: d.source || 'direct', linkCode: d.link || '', campaign: d.campaign || '' };
  }
  var C = cfg();
  if (!C.showcase) return;
  var start = Date.now(), sent = {}, viewed = {}, engaged = false, queue = [], timer = null;
  function uuid(){ return 'a'+Date.now().toString(36)+Math.random().toString(36).slice(2,12); }
  var aid = (function(){ try{ var v=localStorage.getItem('hogee_aid'); if(!v){v=uuid();localStorage.setItem('hogee_aid',v);} return v;}catch(e){return uuid();} })();
  var sid = (function(){ try{ var v=sessionStorage.getItem('hogee_sid'); if(!v){v=uuid();sessionStorage.setItem('hogee_sid',v);} return v;}catch(e){return uuid();} })();
  function dev(){ var ua=navigator.userAgentData, p=(ua&&ua.platform)||navigator.platform||'';
    var mo=/Mobi|Android|iPhone|iPod|Windows Phone/i.test(navigator.userAgent);
    var os=/Android/i.test(navigator.userAgent)?'android':/iPhone|iPad|iPod/i.test(navigator.userAgent)?'ios':/Windows/i.test(p)?'windows':/Mac/i.test(p)?'mac':'other';
    return { device: mo?'mobile':'desktop', os: os, lang: (navigator.language||'').slice(0,10) }; }
  function flush(){ if(!queue.length) return; var payload={ shop_id:C.shop, showcase_code:C.showcase, events:queue }; queue=[];
    var json=JSON.stringify(payload);
    try{ if(navigator.sendBeacon){ var ok=navigator.sendBeacon(C.apiBase+'/c/collect', new Blob([json],{type:'application/json'})); if(ok) return; } }catch(e){}
    try{ fetch(C.apiBase+'/c/collect',{method:'POST',headers:{'Content-Type':'application/json'},body:json,keepalive:true}).catch(function(){}); }catch(e){} }
  function track(event, props){ queue.push(Object.assign({ event:event, ts:Date.now(),
    showcase_code:C.showcase, link_code:C.linkCode||'', source:C.source||'direct', campaign:C.campaign||'',
    anonymous_id_h: aid, session_id: sid }, dev(), props||{}));
    clearTimeout(timer); timer=setTimeout(flush, 1200); }
  window.HogeeAnalytics = { track: track, flush: flush };
  // page_view（每会话 1 次）
  try{ if(!sessionStorage.getItem('hogee_pv_'+C.showcase)){ sessionStorage.setItem('hogee_pv_'+C.showcase,'1'); track('page_view'); } }catch(e){ track('page_view'); }
  function engage(){ if(engaged) return; engaged=true; track('engage'); }
  setTimeout(engage, 10000); // 停留 >10s
  // CTA / 分享 委托
  document.addEventListener('click', function(e){
    var el=e.target.closest&&e.target.closest('[data-hogee-cta],[data-hogee-share]'); if(!el) return;
    if(el.hasAttribute('data-hogee-cta')) track('cta_click',{ cta: el.getAttribute('data-hogee-cta') });
    if(el.hasAttribute('data-hogee-share')) track('share',{ target: el.getAttribute('data-hogee-share')||'share' });
  }, true);
  // 图集浏览（带 data-hogee-media 的横滑容器）
  var media=document.querySelector('[data-hogee-media]');
  if(media){ var mark=function(idx,id){ var k=id||('m'+idx); if(viewed[k]) return; viewed[k]=1;
      track('media_view',{ asset_id:k, index:idx }); if(Object.keys(viewed).length>=3) engage(); };
    var idx=0; mark(0, media.children[0]&&media.children[0].dataset.asset);
    media.addEventListener('scroll', function(){ var w=media.clientWidth, i=Math.round(media.scrollLeft/Math.max(1,w));
      if(i!==idx){ idx=i; var ch=media.children[i]; mark(i, ch&&ch.dataset.asset); } }, {passive:true}); }
  // 离开 / 切后台：上报停留
  function leave(){ var ms=Date.now()-start; if(ms>=500) track('stay',{ duration_ms:ms }); flush(); }
  document.addEventListener('visibilitychange', function(){ if(document.visibilityState==='hidden'){ var ms=Date.now()-start; if(ms>=500) track('stay',{duration_ms:ms}); flush(); } });
  window.addEventListener('pagehide', leave);
  setInterval(flush, 8000);
})();`;

/* =====================================================================
 * H5 动态画册
 * ===================================================================*/
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function renderShowcaseHtml(sc, link) {
  const C = {
    apiBase: API_BASE, shop: sc.shop_id, showcase: sc.code,
    source: link?.source || 'direct', linkCode: link?.code || '', campaign: link?.campaign || ''
  };
  const imgs = (sc.assets || []).filter(a => a.url);
  const slides = imgs.length ? imgs.map((a, i) =>
    `<figure class="slide" data-asset="${esc(a.asset_id || ('a' + i))}"><img src="${esc(a.url)}" alt="${esc(sc.title)} ${i + 1}" loading="${i ? 'lazy' : 'eager'}"/>${a.kind === 'gif' ? '<span class="tag">动态</span>' : a.kind === '360' ? '<span class="tag">360</span>' : ''}</figure>`
  ).join('') : `<figure class="slide empty"><div class="ph">暂无图片</div></figure>`;
  const points = (sc.copy?.selling_points || []).map(p => `<li>${esc(p)}</li>`).join('');
  const params = sc.copy?.params && typeof sc.copy.params === 'object'
    ? Object.entries(sc.copy.params).slice(0, 12).map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('') : '';
  const phone = sc.contact?.phone || '';
  const wechat = sc.contact?.wechat || '';
  const showCall = sc.contact?.show_call !== false && !!phone;

  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>${esc(sc.copy?.title || sc.title)} · WorkHogee</title>
<meta name="description" content="${esc(sc.title)}，${(sc.copy?.selling_points || []).slice(0, 3).map(esc).join('，')}"/>
<meta name="theme-color" content="#ffffff"/>
<meta property="og:title" content="${esc(sc.title)}"/><meta property="og:type" content="website"/>
${imgs[0] ? `<meta property="og:image" content="${esc(imgs[0].url)}"/>` : ''}
<style>
:root{--o:#ea580c;--ink:#111;--m:#6b7280;--l:#f5f5f4;--line:#e7e5e4;}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink);background:#fff;line-height:1.55}
.wrap{max-width:560px;margin:0 auto;padding:0 16px 40px}
.brand{display:flex;align-items:center;gap:8px;padding:14px 0 10px;font-weight:800;letter-spacing:-.02em}
.brand .w{color:var(--ink)} .brand .h{color:var(--o)} .brand-logo{height:26px;width:auto;display:block}
.brand small{font-weight:600;color:var(--m);font-size:11px;letter-spacing:.08em;border:1px solid var(--line);border-radius:999px;padding:2px 8px;margin-left:auto}
h1{font-size:21px;line-height:1.35;margin:6px 0 4px;letter-spacing:-.01em}
.sub{color:var(--m);font-size:13px;margin:0 0 12px}
.gallery{display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;margin:0 -16px 6px;padding:2px 16px 8px;scrollbar-width:none}
.gallery::-webkit-scrollbar{display:none}
.slide{flex:0 0 86%;scroll-snap-align:center;margin:0;position:relative;border-radius:16px;overflow:hidden;background:var(--l);aspect-ratio:4/3}
.slide img{width:100%;height:100%;object-fit:cover;display:block}
.slide .tag{position:absolute;left:10px;top:10px;background:rgba(17,17,17,.82);color:#fff;font-size:11px;padding:3px 9px;border-radius:999px}
.slide.empty .ph{display:flex;align-items:center;justify-content:center;height:100%;color:var(--m)}
.dots{display:flex;gap:5px;justify-content:center;margin:2px 0 14px}
.dots i{width:5px;height:5px;border-radius:50%;background:var(--line);transition:.25s}
.dots i.on{width:16px;border-radius:3px;background:var(--o)}
.card{border:1px solid var(--line);border-radius:16px;padding:16px;margin:12px 0}
.card h2{font-size:15px;margin:0 0 10px;display:flex;align-items:center;gap:7px}
.card h2::before{content:"";width:4px;height:15px;border-radius:2px;background:var(--o)}
.points{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:8px}
.points li{font-size:13.5px;background:var(--l);border-radius:10px;padding:9px 11px;position:relative;padding-left:26px}
.points li::before{content:"";position:absolute;left:11px;top:15px;width:7px;height:7px;border:2px solid var(--o);border-radius:50%}
.kv{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px dashed var(--line);font-size:13.5px}
.kv:last-child{border-bottom:0}.kv span{color:var(--m)}.kv b{font-weight:600;text-align:right}
.cta{position:fixed;left:0;right:0;bottom:0;z-index:30;background:rgba(255,255,255,.96);backdrop-filter:blur(8px);border-top:1px solid var(--line);padding:10px 16px calc(10px + env(safe-area-inset-bottom));display:flex;gap:10px;max-width:560px;margin:0 auto}
.btn{flex:1;border:0;border-radius:12px;height:48px;font-size:15px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:7px;text-decoration:none;cursor:pointer;transition:transform .12s,background .2s}
.btn:active{transform:scale(.97)}
.btn-o{background:var(--o);color:#fff}.btn-o:hover{background:#c2410c}
.btn-ghost{background:#fff;color:var(--ink);border:1.5px solid var(--ink)}
.form{display:none;padding-bottom:96px}
.form.show{display:block}
.field{margin:10px 0}.field label{display:block;font-size:12.5px;color:var(--m);margin-bottom:5px}
.field input,.field textarea,.seg{width:100%;border:1px solid var(--line);border-radius:11px;padding:12px 13px;font-size:15px;font-family:inherit;background:#fff;color:var(--ink)}
.field textarea{min-height:70px;resize:vertical}
.seg{display:flex;padding:4px;gap:4px;background:var(--l);border:0}
.seg button{flex:1;border:0;background:transparent;padding:9px;border-radius:8px;font-size:13.5px;font-weight:600;color:var(--m);cursor:pointer}
.seg button.on{background:#fff;color:var(--ink);box-shadow:0 1px 3px rgba(0,0,0,.08)}
.consent{display:flex;gap:9px;align-items:flex-start;font-size:12px;color:var(--m);margin:12px 0}
.consent input{width:17px;height:17px;margin-top:2px;accent-color:var(--o);flex:none}
.submit{width:100%;background:var(--ink);color:#fff;border:0;border-radius:12px;height:50px;font-size:16px;font-weight:700;cursor:pointer}
.submit:disabled{opacity:.5}
.okbox{display:none;text-align:center;padding:34px 16px}.okbox.show{display:block}
.okbox .ic{width:60px;height:60px;border-radius:50%;background:#fff7ed;color:var(--o);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;font-size:30px}
.foot{color:var(--m);font-size:11.5px;text-align:center;margin:22px 0 8px;line-height:1.7}
.foot a{color:var(--m)}
.toast{position:fixed;left:50%;bottom:84px;transform:translateX(-50%) translateY(20px);background:var(--ink);color:#fff;padding:10px 18px;border-radius:999px;font-size:13px;opacity:0;pointer-events:none;transition:.25s;z-index:40;max-width:90%}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head>
<body>
<div class="wrap">
  <div class="brand"><svg class="brand-logo" viewBox="0 0 118 19.13" role="img" aria-label="WorkHogee" xmlns="http://www.w3.org/2000/svg"><defs><style>.bl1{fill:#111827}.bl2{fill:#ea580c}</style></defs><g transform="translate(-1.06 -28.16)"><path class="bl1" d="M13,32.58,9.81,42.11a1.34,1.34,0,0,1-1.33,1.12h-2a1.35,1.35,0,0,1-1.29-.94L1.13,30a1.36,1.36,0,0,1,1.29-1.78h2a1.35,1.35,0,0,1,1.29.94l2.15,6.58L9.09,32a1.13,1.13,0,0,1,1.07-.74l1.68,0A1.06,1.06,0,0,1,13,32.58Z"/><path class="bl2" d="M12.88,43.23h2a1.38,1.38,0,0,0,1.3-.94l4-12.35a1.36,1.36,0,0,0-1.29-1.78h-2a1.35,1.35,0,0,0-1.3.93l-4,12.35A1.36,1.36,0,0,0,12.88,43.23Z"/><path class="bl1" d="M19.12,37.64a5.39,5.39,0,0,1,5.62-5.58,5.4,5.4,0,0,1,5.64,5.58,5.41,5.41,0,0,1-5.64,5.6A5.4,5.4,0,0,1,19.12,37.64Zm8.35,0a2.74,2.74,0,1,0-5.44,0c0,1.67,1,3.11,2.71,3.11A2.82,2.82,0,0,0,27.47,37.64Z"/><path class="bl1" d="M33.75,32.32a.43,.43,0,0,1,.43.43h0a.43,.43,0,0,0,.69,.34,4.61,4.61,0,0,1,2.26-1,.4,.4,0,0,1,.45.4v1.82a.4,.4,0,0,1-.4.4h-.37a3.68,3.68,0,0,0-2.55,1.1.43,.43,0,0,0-.08.24c0,1,0,6.9,0,6.9h-2.4a.4,.4,0,0,1-.4-.4V32.73a.4,.4,0,0,1,.4-.41Z"/><path class="bl1" d="M42.25,39.39l-.64,.68a.58,.58,0,0,0-.15.39V42.4a.57,.57,0,0,1-.57.57H39.23a.56,.56,0,0,1-.57-.57V28.84a.56,.56,0,0,1,.57-.57h1.66a.57,.57,0,0,1,.57.57v6.68a.57,.57,0,0,0,1,.37l2.86-3.37a.6,.6,0,0,1,.43-.2h1.93a.57,.57,0,0,1,.43,1L45,36.81a.57,.57,0,0,0,0,.71l3.39,4.54a.57,.57,0,0,1-.45.91H45.86a.56,.56,0,0,1-.47-.24l-2.25-3.28A.57,.57,0,0,0,42.25,39.39Z"/><text x="53" y="42.3" font-family="'Trebuchet MS','Trebuchet','Lucida Sans Unicode',sans-serif" font-size="18" font-weight="400" fill="#111827">Hogee</text></g></svg></div>
  <h1>${esc(sc.copy?.title || sc.title)}</h1>
  <p class="sub">WorkHogee 智能画册 · 商品以实物为准</p>

  <div class="gallery" data-hogee-media>${slides}</div>
  <div class="dots">${imgs.map((_, i) => `<i${i === 0 ? ' class="on"' : ''}></i>`).join('')}</div>

  ${points ? `<div class="card"><h2>核心卖点</h2><ul class="points">${points}</ul></div>` : ''}
  ${params ? `<div class="card"><h2>商品参数</h2>${params}</div>` : ''}

  <div class="card" id="ask">
    <h2>咨询 / 联系商家</h2>
    <div class="okbox" id="ok"><div class="ic">✓</div><b>已收到您的咨询</b><p class="sub" style="margin-top:6px">商家会尽快与您联系，请保持电话畅通</p></div>
    <form class="form" id="leadForm" novalidate>
      <div class="field"><label>联系方式</label>
        <div class="seg" id="seg"><button type="button" data-t="phone" class="on">手机号</button><button type="button" data-t="wechat">微信号</button></div>
      </div>
      <div class="field"><label id="valLabel">手机号</label><input id="val" type="tel" inputmode="numeric" autocomplete="tel" placeholder="请输入手机号"/></div>
      <div class="field"><label>怎么称呼（选填）</label><input id="name" type="text" maxlength="40" placeholder="先生 / 女士"/></div>
      <div class="field"><label>想了解的问题（选填）</label><textarea id="note" maxlength="500" placeholder="如：价格、规格、库存，什么时候方便看货？"></textarea></div>
      <label class="consent"><input id="consent" type="checkbox"/><span>我同意商家就该商品通过电话或微信与我联系。我们仅向该商家提供您的联系方式，不做跨站追踪。</span></label>
      <button class="submit" type="submit" id="submitBtn">提交咨询</button>
    </form>
  </div>

  <p class="foot">本页面由 WorkHogee 生成，仅用于商品展示与咨询承接<br/>
  <a href="${SITE_BASE}/privacy.html" target="_blank" rel="noopener">隐私政策</a> · 您可申请删除已提交的联系方式</p>
</div>

<div class="cta">
  ${showCall ? `<a class="btn btn-ghost" data-hogee-cta="call" href="tel:${esc(phone)}">电话咨询</a>` : ''}
  ${wechat ? `<button class="btn btn-ghost" type="button" data-hogee-cta="copy" id="copyWx">复制微信</button>` : ''}
  <button class="btn btn-o" type="button" data-hogee-cta="askprice" id="askBtn">联系商家</button>
</div>
<div class="toast" id="toast"></div>

<script>window.__HOGEE_CFG=${JSON.stringify(C)};</script>
<script>${SDK_BODY}</script>
<script>
(function(){
  var media=document.querySelector('[data-hogee-media]'), dots=document.querySelectorAll('.dots i');
  if(media) media.addEventListener('scroll',function(){var w=media.clientWidth,i=Math.round(media.scrollWidth/Math.max(1,w))?Math.round(media.scrollLeft/Math.max(1,w)):0;
    dots.forEach(function(d,k){d.classList.toggle('on',k===i);});},{passive:true});
  function toast(t){var el=document.getElementById('toast');el.textContent=t;el.classList.add('show');setTimeout(function(){el.classList.remove('show');},2200);}
  var seg=document.getElementById('seg'),type='phone';
  seg.addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;type=b.dataset.t;
    seg.querySelectorAll('button').forEach(function(x){x.classList.toggle('on',x===b);});
    var lab=document.getElementById('valLabel'),inp=document.getElementById('val');
    lab.textContent=type==='phone'?'手机号':'微信号';
    inp.placeholder=type==='phone'?'请输入手机号':'请输入微信号';inp.value='';});
  var wx=${JSON.stringify(wechat || '')};
  var cw=document.getElementById('copyWx'); if(cw) cw.addEventListener('click',function(){
    function ok(){toast('微信号已复制：'+wx);}
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(wx).then(ok).catch(function(){fallback();});}else fallback();
    function fallback(){var t=document.createElement('input');t.value=wx;document.body.appendChild(t);t.select();try{document.execCommand('copy');ok();}catch(e){}document.body.removeChild(t);}
  });
  document.getElementById('askBtn').addEventListener('click',function(){
    var form=document.getElementById('leadForm'),ask=document.getElementById('ask');
    form.classList.add('show');
    ask.scrollIntoView({behavior:'smooth',block:'center'});
    setTimeout(function(){var v=document.getElementById('val');if(v)v.focus({preventScroll:true});},350);
  });
  var form=document.getElementById('leadForm'),btn=document.getElementById('submitBtn');
  form.addEventListener('submit',function(e){e.preventDefault();
    var val=document.getElementById('val').value.trim(),name=document.getElementById('name').value.trim(),
        note=document.getElementById('note').value.trim(),consent=document.getElementById('consent').checked;
    if(!val){toast(type==='phone'?'请输入手机号':'请输入微信号');return;}
    if(type==='phone'&&!/^1[3-9]\\d{9}$/.test(val.replace(/\\s|-/g,''))){toast('手机号格式不正确');return;}
    if(!consent){toast('请先勾选同意被联系');return;}
    btn.disabled=true;btn.textContent='提交中…';
    fetch(window.__HOGEE_CFG.apiBase+'/leads',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({showcase_code:window.__HOGEE_CFG.showcase,link_code:window.__HOGEE_CFG.linkCode,
        name:name,intent_note:note,contact:{type:type,value:val},opt_in:true})})
      .then(function(r){return r.json();}).then(function(j){
        if(j.ok){form.classList.remove('show');document.getElementById('ok').classList.add('show');}
        else{toast(j.message||j.error?.message||'提交失败，请稍后再试');btn.disabled=false;btn.textContent='提交咨询';}
      }).catch(function(){toast('网络异常，请稍后再试');btn.disabled=false;btn.textContent='提交咨询';});
  });
})();
</script>
</body></html>`;
}

function renderNotFoundShowcase() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>画册不存在或已下架 · WorkHogee</title><style>body{margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;font-family:-apple-system,"PingFang SC",sans-serif;background:#fafaf9;color:#111;text-align:center}
.b{padding:32px}.b h1{font-size:20px;margin:0 0 8px}.b p{color:#6b7280;font-size:14px;margin:0 0 20px}.b a{color:#ea580c;text-decoration:none;font-weight:700}</style></head>
<body><div class="b"><h1>画册不存在或已下架</h1><p>链接可能有误，或该商品已售出 / 下架。</p><a href="${SITE_BASE}/">返回 WorkHogee</a></div></body></html>`;
}

/* =====================================================================
 * 主路由
 * ===================================================================*/
async function handleAnalyticsInner(request, env, ctx, origin) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

  // ---------- 埋点 SDK ----------
  if (path === '/sdk/h5-analytics.js' && method === 'GET') {
    return new Response(SDK_BODY, {
      headers: {
        'Content-Type': 'application/javascript; charset=UTF-8',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  // ---------- H5 画册 ----------
  let m;
  if ((m = path.match(/^\/s\/([A-Za-z0-9]{2,12})$/)) && method === 'GET') {
    const code = m[1];
    const sc = await getPublicShowcase(env, code);
    if (!sc || sc.status !== 'published') {
      return new Response(renderNotFoundShowcase(), { status: 404, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
    }
    const ch = url.searchParams.get('ch') || '';
    const link = ch ? await getLink(env, ch) : null;
    return new Response(renderShowcaseHtml(sc, link), {
      headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store' }
    });
  }

  // ---------- 渠道短链 302 ----------
  if ((m = path.match(/^\/r\/([A-Za-z0-9]{2,12})$/)) && method === 'GET') {
    const code = m[1];
    const link = await getLink(env, code);
    if (!link || link.status !== 'active' || !link.target_url) {
      return new Response(renderNotFoundShowcase(), { status: 404, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
    }
    // 记 redirect（微信等扫描器预取也只记 redirect；落地 page_view 以真实 beacon 为准）
    try { collectEvents(env, ctx, link.shop_id, [{ event: 'redirect', source: link.source, link_code: code }]); } catch { /* ignore */ }
    return Response.redirect(link.target_url, 302);
  }

  // ---------- 渠道码二维码 SVG ----------
  if ((m = path.match(/^\/q\/([A-Za-z0-9]{2,12})\.svg$/)) && method === 'GET') {
    const link = await getLink(env, m[1]);
    if (!link) return J({ ok: false, error: { code: 'not_found' } }, 404, origin);
    const svg = qrSvg(`${SHORT_BASE}/r/${link.code}`, { fg: '#111111', bg: '#ffffff', quiet: 2 });
    return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } });
  }

  // ---------- 埋点上报 ----------
  if (path === '/c/collect' && method === 'POST') {
    const ip = ipOf(request);
    const ua = request.headers.get('User-Agent') || '';
    if (BOT_RE.test(ua) || collectLimited(ip)) return J({ ok: true, accepted: 0, dropped: true }, 202, origin);
    const body = await readBody(request);
    const rawEvents = Array.isArray(body.events) ? body.events.slice(0, 60) : [];
    const showcaseCode = body.showcase_code || (rawEvents[0] && rawEvents[0].showcase_code) || '';
    const shop = await shopByShowcase(env, showcaseCode);
    if (!shop) return J({ ok: true, accepted: 0 }, 202, origin); // 归属不明，静默丢弃
    const ALLOW = new Set(['page_view', 'engage', 'media_view', 'cta_click', 'form_submit', 'share', 'stay']);
    const cf = request.cf || {};
    const events = rawEvents
      .filter(e => e && ALLOW.has(e.event))
      .map(e => ({
        ...e,
        showcase_code: e.showcase_code || showcaseCode, // 回填画册码，保证按画册分桶稳健
        ts: Number(e.ts) > 0 ? Number(e.ts) : Date.now(),
        geo: { country: cf.country || '', region: cf.region || '', city: cf.city || '' } // 仅粗粒度；IP 不落盘
      }));
    if (events.length) collectEvents(env, ctx, shop, events);
    return J({ ok: true, accepted: events.length }, 200, origin);
  }

  // ---------- 以下均需会员会话（公开留资除外）----------
  const session = await requireSession(request, env);

  // 公开留资（无 token 时由画册反查店归属；有 token 时以会员店为准）
  if (path === '/leads' && method === 'POST') {
    const body = await readBody(request);
    const shop = session ? session.id : await shopByShowcase(env, body.showcase_code);
    if (!shop) return J({ ok: false, error: { code: 'bad_showcase', message: '画册无效' } }, 400, origin);
    const res = await createLead(env, shop, body);
    if (!res.ok) return J({ ok: false, error: { code: res.code, message: res.message } }, 400, origin);
    // form_submit 权威计数（服务端记录，避免与 SDK 重复）
    try {
      const link = body.link_code ? await getLink(env, body.link_code) : null;
      collectEvents(env, ctx, shop, [{ event: 'form_submit', showcase_code: body.showcase_code, source: link?.source || 'direct', lead_id: res.lead_id }]);
    } catch { /* ignore */ }
    return J({ ok: true, ...res }, 200, origin);
  }

  // 业务接口必须登录
  if (!session) return J({ ok: false, error: { code: 'unauthorized', message: '请先登录' } }, 401, origin);
  const shop = session.id;

  // ----- 画册 CRUD -----
  if (path === '/showcases' && method === 'POST') {
    const body = await readBody(request);
    const rec = await createShowcase(env, shop, body);
    try { await env.MEMBERS.put('sccode:' + rec.code, shop); } catch { /* ignore */ }
    return J({ ok: true, code: rec.code, url: `${SHORT_BASE}/s/${rec.code}`, showcase: rec }, 200, origin);
  }
  if (path === '/showcases' && method === 'GET') {
    const rows = await listShowcases(env, shop);
    return J({ ok: true, data: rows, meta: { generated_at: Date.now() } }, 200, origin);
  }

  // ----- 渠道码 / 短链 -----
  if (path === '/qr' && method === 'POST') {
    const body = await readBody(request);
    const rec = await createLink(env, shop, body);
    const shortUrl = `${SHORT_BASE}/r/${rec.code}`;
    return J({
      ok: true, code: rec.code, short_url: shortUrl,
      qr_svg_url: `${API_BASE}/q/${rec.code}.svg`,
      qr_svg: qrSvg(shortUrl, { fg: '#111111', bg: '#ffffff', quiet: 2 }),
      target_url: rec.target_url, link: rec
    }, 200, origin);
  }
  if (path === '/qr' && method === 'GET') {
    const rows = await listLinks(env, shop);
    return J({ ok: true, data: rows.map(r => ({ ...r, short_url: `${SHORT_BASE}/r/${r.code}`, qr_svg_url: `${API_BASE}/q/${r.code}.svg` })) }, 200, origin);
  }

  // ----- 线索 CRM -----
  if (path === '/leads' && method === 'GET') {
    const rows = await listLeads(env, shop, {
      from: url.searchParams.get('from') || undefined, to: url.searchParams.get('to') || undefined,
      status: url.searchParams.get('status') || undefined, source: url.searchParams.get('source') || undefined,
      q: url.searchParams.get('q') || undefined
    });
    return J({ ok: true, data: rows, meta: { generated_at: Date.now() } }, 200, origin);
  }
  if (path === '/leads/export' && method === 'GET') {
    const csv = await leadsCSV(env, shop, url.searchParams.get('from'), url.searchParams.get('to'));
    return new Response(csv, {
      headers: { 'Content-Type': 'text/csv; charset=UTF-8', 'Content-Disposition': 'attachment; filename="workhogee-leads.csv"', ...cors(origin) }
    });
  }
  if ((m = path.match(/^\/leads\/([A-Za-z0-9_]+)\/followup$/)) && method === 'POST') {
    const body = await readBody(request);
    const res = await addFollowup(env, shop, m[1], body.text || '');
    if (!res.ok) return J({ ok: false, error: { code: res.code } }, 404, origin);
    return J({ ok: true, ...res }, 200, origin);
  }
  if ((m = path.match(/^\/leads\/([A-Za-z0-9_]+)$/)) && method === 'PATCH') {
    const body = await readBody(request);
    const res = await patchLead(env, shop, m[1], body);
    if (!res.ok) return J({ ok: false, error: { code: res.code } }, 404, origin);
    return J({ ok: true, ...res }, 200, origin);
  }
  if ((m = path.match(/^\/leads\/([A-Za-z0-9_]+)$/)) && method === 'GET') {
    const rec = await getLeadDecrypted(env, shop, m[1]);
    if (!rec) return J({ ok: false, error: { code: 'not_found' } }, 404, origin);
    return J({ ok: true, data: rec }, 200, origin);
  }

  // ----- 看板查询 -----
  if ((m = path.match(/^\/analytics\/(overview|channels|showcases|funnel)$/)) && method === 'GET') {
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    let data;
    if (m[1] === 'overview') data = await analyticsOverview(env, shop, from, to);
    else if (m[1] === 'channels') data = await analyticsChannels(env, shop, from, to);
    else if (m[1] === 'showcases') data = await analyticsShowcases(env, shop, from, to);
    else { const ov = await analyticsOverview(env, shop, from, to); data = { funnel: ov.funnel, totals: ov.totals, meta: ov.meta }; }
    return J({ ok: true, data, meta: { source: 'first_party', tz: 'Asia/Shanghai', generated_at: Date.now() } }, 200, origin);
  }

  return null; // 非本模块路由
}

// 顶层兜底：任何效果中心异常都返回带 CORS 头的 JSON，避免冒泡成无跨域头的 CF error 1101
export async function handleAnalytics(request, env, ctx, origin) {
  try {
    return await handleAnalyticsInner(request, env, ctx, origin);
  } catch (err) {
    try { console.log('[analytics error]', err && err.stack ? err.stack : String(err)); } catch { /* ignore */ }
    const message = (err && err.message) ? String(err.message).slice(0, 200) : 'internal_error';
    return J({ ok: false, error: { code: 'analytics_error', message } }, 500, origin);
  }
}
