/* =====================================================================
 * WorkHogee · 「Hogee 上新」官方素材墙（feed.js，Cloudflare KV + TOS）
 * ---------------------------------------------------------------------
 * 定位：工作台首页「Hogee 上新」是官方运营素材墙，不是用户私人相册。
 *   - GET /api/feed                公开只读，任何登录 / 未登录用户都能看到；
 *   - 写操作（预签名 / 登记 / 删除）仅 role='admin' 的 workhogee 官方账号，
 *     普通会员一律 403，从根上杜绝“普通用户上传后换机 / 重登就消失”。
 * 持久化：
 *   - 元数据索引存 KV 单 key「feed:index」（沿用 analytics 单 key 教训，
 *     不做 KV list，规避免费版 list 配额）；
 *   - 图片 / 视频字节直传火山 TOS 公共前缀 feed/，浏览器与 TOS 间直传直读，
 *     GET 时由服务端用 IAM AK/SK 现场签 1 小时只读 URL，不下发长期公开链接；
 *   - 出厂示例 source='static' 指向站点 /images、/media，管理员可从索引删除，
 *     不删静态文件；TOS 对象删除仅移索引（TOS4 无 DELETE 预签名，孤儿对象
 *     量小、可接受，后续接后台生命周期清理）。
 * ===================================================================*/

import { presignPut, presignGet } from './tos.js';
import { getMemberSession } from './member-auth.js';

const FEED_INDEX_KEY = 'feed:index';
const FEED_PREFIX = 'feed/';

const IMG_CT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif'
};
const VID_CT = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
const ALL_CT = { ...IMG_CT, ...VID_CT };
const SZ_WHITELIST = new Set(['lg', 'wide', 'sq', 'tall']);
const MAX_ITEMS = 240;
const CAP_MAX = 80;
const PROMPT_MAX = 1500;
const CAT_NAME_MAX = 12;
// 内置分类（前端同名常量为单一展示来源，后端只做合法性校验）：
// product 商品图 / video 营销视频 / design 平面设计 / ecom 电商 / poster 海报
const CAT_BUILTIN = new Set(['product', 'video', 'design', 'ecom', 'poster']);
function cleanCat(v, kind) {
  const c = String(v == null ? '' : v).trim().slice(0, 24);
  if (CAT_BUILTIN.has(c)) return c;
  if (/^c_[a-z0-9]{1,18}$/.test(c)) return c;
  return kind === 'v' ? 'video' : 'product';
}
function cleanCatName(v) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, CAT_NAME_MAX);
}
// 置顶素材恒在最前（pinAt 新→旧），其余保持索引原有相对顺序（新提交 unshift 在前）
function sortFeed(items) {
  return items.map((it, i) => [it, i])
    .sort((a, b) => {
      const pa = a[0].pin ? 1 : 0, pb = b[0].pin ? 1 : 0;
      if (pa !== pb) return pb - pa;
      if (pa && pb) return (b[0].pinAt || 0) - (a[0].pinAt || 0);
      return a[1] - b[1];
    })
    .map(x => x[0]);
}

// 与官网主站保持同一套跨域白名单（feed 被 worker.js import，不能反向 import
// worker 的 corsHeaders，这里自带一份与 worker / admin 一致的实现）。
const ALLOWED_ORIGINS = [
  'https://www.workhogee.com',
  'http://www.workhogee.com',
  'https://workhogee.com',
  'http://workhogee.com',
  'https://hiaeo.github.io',
  'http://hiaeo.github.io'
];
function corsHeaders(origin) {
  const allowDev = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const allow = (ALLOWED_ORIGINS.includes(origin) || allowDev) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function json(payload, status, origin, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=UTF-8', ...corsHeaders(origin), ...extraHeaders }
  });
}

function tosConfig(env) {
  const region = env.TOS_REGION || 'cn-beijing';
  return {
    accessKeyId: env.TOS_ACCESS_KEY_ID,
    secretAccessKey: env.TOS_SECRET_ACCESS_KEY,
    bucket: env.TOS_BUCKET,
    region,
    endpoint: env.TOS_ENDPOINT || `tos-${region}.volces.com`
  };
}
function cleanCap(v) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, CAP_MAX);
}
function cleanPrompt(v) {
  return String(v == null ? '' : v)
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
    .slice(0, PROMPT_MAX);
}
function extOf(key) {
  const m = String(key || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}
function safeFeedKey(key) {
  return typeof key === 'string' &&
    key.startsWith(FEED_PREFIX) &&
    !key.includes('..') && !key.includes('\\') &&
    key.length <= 240;
}

/* ---------------- 出厂示例（静态站点资源，对齐前端 HM6_DEMO 字段） -----------
 * 出厂不带任何内置素材：「Hogee 上新」是官方运营素材墙，内容统一由 workhogee
 * 管理员账号在工作台上传、登记到 KV 索引。这里保留空数组与函数签名，避免新环境
 * 冷启动时重新灌入历史演示素材；静态文件本身不删除，需要时可重新登记。 */
function bootstrapItems() {
  return [];
}

/* ---------------- 索引引导（每个 isolate 冷启动只跑一次） ------------------- */
let _feedBootPromise = null;
export function ensureFeedBootstrap(env) {
  if (!env || !env.MEMBERS) return Promise.resolve(false);
  if (_feedBootPromise) return _feedBootPromise;
  _feedBootPromise = (async () => {
    try {
      const existing = await env.MEMBERS.get(FEED_INDEX_KEY, 'json');
      if (existing && Array.isArray(existing.items)) return true;
      await env.MEMBERS.put(
        FEED_INDEX_KEY,
        JSON.stringify({ v: 1, updatedAt: Date.now(), items: bootstrapItems() })
      );
      return true;
    } catch (e) {
      _feedBootPromise = null; // 出错允许下次请求重试
      return false;
    }
  })();
  return _feedBootPromise;
}

async function readIndex(env) {
  let rec = await env.MEMBERS.get(FEED_INDEX_KEY, 'json');
  if (!rec || !Array.isArray(rec.items)) {
    await ensureFeedBootstrap(env);
    rec = await env.MEMBERS.get(FEED_INDEX_KEY, 'json');
  }
  if (!rec || !Array.isArray(rec.items)) return { v: 1, updatedAt: 0, items: bootstrapItems(), cats: [] };
  if (!Array.isArray(rec.cats)) rec.cats = [];
  return rec;
}
async function writeIndex(env, items, cats) {
  await env.MEMBERS.put(FEED_INDEX_KEY, JSON.stringify({
    v: 1, updatedAt: Date.now(),
    items: Array.isArray(items) ? items : [],
    cats: Array.isArray(cats) ? cats : []
  }));
}

/* GET：feed/ 公共前缀由桶策略授权匿名读，直接下发固定可强缓存 URL（不现场签名，
 * 也不随时间变化）；仅私有前缀才现场签 1 小时只读 URL，静态素材原样返回。 ---- */
async function signItem(env, it) {
  const out = { ...it };
  if (out.source !== 'tos' || !out.key) return out;
  const cfg = tosConfig(env);
  const endpoint = cfg.endpoint || `tos-${cfg.region || 'cn-beijing'}.volces.com`;
  // 官方作品墙素材都在 feed/ 公共前缀：桶策略已允许匿名 GetObject，
  // 用固定 URL，浏览器/CDN 可长期强缓存，进工作台无需逐张签名。
  if (out.key.startsWith(FEED_PREFIX) && cfg.bucket) {
    out.src = `https://${cfg.bucket}.${endpoint}/${out.key}`;
    delete out.key;
    return out;
  }
  // 兜底：私有前缀对象仍现场签 1 小时只读 URL
  if (cfg.accessKeyId && cfg.secretAccessKey && cfg.bucket) {
    try {
      const g = await presignGet({ ...cfg, key: out.key, expiresSec: 3600 });
      out.src = g.url;
    } catch (e) {
      // 签名失败则不下发该项（避免裂图），由前端按缺 src 跳过
      out.src = '';
    }
  } else {
    out.src = '';
  }
  delete out.key;
  return out;
}

async function signedFeed(env, rec) {
  // 并行处理全部素材（固定 URL 不依赖签名，签名项也并发），避免串行 await 拖慢索引
  const settled = await Promise.all(sortFeed(rec.items).map(it => signItem(env, it)));
  return settled.filter(s => (s.k === 'ba') || !!s.src); // 签名失败的单素材跳过
}

async function handleGet(env, origin) {
  // KV 未配置时退化为只读出厂示例
  if (!env.MEMBERS) {
    return json({ ok: true, items: bootstrapItems() }, 200, origin,
      { 'Cache-Control': 'no-store' });
  }
  await ensureFeedBootstrap(env);
  const rec = await readIndex(env);
  const items = await signedFeed(env, rec);
  // 公开作品墙：浏览器短缓存(30s)、边缘缓存(120s)并允许后台刷新，进工作台秒显；
  // 管理员写操作的响应仍为 no-store，运营端即时看到最新结果。
  return json({ ok: true, items, cats: Array.isArray(rec.cats) ? rec.cats : [] }, 200, origin, {
    'Cache-Control': 'public, max-age=30, s-maxage=120, stale-while-revalidate=300'
  });
}

/* ---------------- 写操作鉴权：仅官方管理员 --------------------------------- */
async function requireAdmin(env, req, origin) {
  const sess = await getMemberSession(env, req);
  if (!sess) {
    return { error: json({ ok: false, error: { code: 'member_unauthorized', message: '请先登录会员账号' } }, 401, origin) };
  }
  if (sess.role !== 'admin') {
    return { error: json({ ok: false, error: { code: 'forbidden', message: '官方素材墙仅运营账号可维护' } }, 403, origin) };
  }
  return { sess };
}

async function handlePresign(req, env, origin) {
  const guard = await requireAdmin(env, req, origin);
  if (guard.error) return guard.error;
  const cfg = tosConfig(env);
  if (!cfg.accessKeyId || !cfg.secretAccessKey || !cfg.bucket) {
    return json({ ok: false, error: { code: 'storage_unavailable', message: '对象存储未配置' } }, 503, origin);
  }
  let body;
  try { body = await req.json(); } catch { body = {}; }
  const ext = String(body.ext || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const ct = ALL_CT[ext];
  if (!ct) {
    return json({ ok: false, error: { code: 'bad_ext', message: '仅支持 jpg/jpeg/png/webp/gif/mp4/mov/webm' } }, 400, origin);
  }
  const d = new Date();
  const ym = d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0');
  const rand = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/-/g, '');
  const key = `${FEED_PREFIX}${ym}/${rand}.${ext}`;
  const put = await presignPut({ ...cfg, key, expiresSec: 600 });
  return json({
    ok: true,
    key,
    method: 'PUT',
    putUrl: put.url,
    headers: { 'Content-Type': ct },
    putExpiresIn: 600
  }, 200, origin);
}

async function handleCommit(req, env, origin) {
  const guard = await requireAdmin(env, req, origin);
  if (guard.error) return guard.error;
  if (!env.MEMBERS) {
    return json({ ok: false, error: { code: 'storage_unavailable', message: '存储未配置' } }, 503, origin);
  }
  let body;
  try { body = await req.json(); } catch { body = {}; }
  const key = String(body.key || '');
  if (!safeFeedKey(key)) {
    return json({ ok: false, error: { code: 'bad_key', message: '素材 key 非法' } }, 400, origin);
  }
  const ext = extOf(key);
  const ct = ALL_CT[ext];
  if (!ct) {
    return json({ ok: false, error: { code: 'bad_ext', message: '不支持的素材格式' } }, 400, origin);
  }
  const kind = VID_CT[ext] ? 'v' : 'img';
  const sz = SZ_WHITELIST.has(body.sz) ? body.sz : (kind === 'v' ? 'wide' : 'sq');
  const cat = cleanCat(body.cat, kind);
  const cap = cleanCap(body.cap) || (kind === 'v' ? '营销视频 · 阿视成片' : 'AI 商品图 · 功能演示');
  const id = 'f-' + (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/-/g, '').slice(0, 20);
  const item = {
    id, source: 'tos', k: kind, key, cap, sz, cat,
    tag: '功能演示',
    createdAt: Date.now()
  };
  const prompt = cleanPrompt(body.prompt);
  if (prompt) item.prompt = prompt;
  if (kind === 'v' && body.feat) item.feat = 1;

  const rec = await readIndex(env);
  // 幂等：同一 key 已登记则替换，避免重复提交产生重复卡片；替换时保留置顶状态
  const idx = rec.items.findIndex(x => x.source === 'tos' && x.key === key);
  if (idx >= 0) { item.pin = rec.items[idx].pin; item.pinAt = rec.items[idx].pinAt; rec.items[idx] = item; }
  else rec.items.unshift(item);
  if (rec.items.length > MAX_ITEMS) rec.items = rec.items.slice(0, MAX_ITEMS);
  await writeIndex(env, rec.items, rec.cats);
  const items = await signedFeed(env, rec);
  return json({ ok: true, item: items.find(x => x.id === id) || null, items, cats: Array.isArray(rec.cats) ? rec.cats : [] }, 200, origin, { 'Cache-Control': 'no-store' });
}

async function handleDeleteAuthorized(url, env, origin) {
  if (!env.MEMBERS) {
    return json({ ok: false, error: { code: 'storage_unavailable', message: '存储未配置' } }, 503, origin);
  }
  const id = String(url.searchParams.get('id') || '').trim();
  if (!id || id.length > 64) {
    return json({ ok: false, error: { code: 'bad_id', message: '缺少素材 id' } }, 400, origin);
  }
  const rec = await readIndex(env);
  const next = rec.items.filter(x => x.id !== id);
  if (next.length === rec.items.length) {
    return json({ ok: false, error: { code: 'not_found', message: '素材不存在或已删除' } }, 404, origin);
  }
  await writeIndex(env, next, rec.cats);
  const items = await signedFeed(env, { items: next, cats: rec.cats });
  return json({ ok: true, items, cats: Array.isArray(rec.cats) ? rec.cats : [] }, 200, origin, { 'Cache-Control': 'no-store' });
}

async function handleUpdate(req, env, origin) {
  const guard = await requireAdmin(env, req, origin);
  if (guard.error) return guard.error;
  if (!env.MEMBERS) {
    return json({ ok: false, error: { code: 'storage_unavailable', message: '存储未配置' } }, 503, origin);
  }
  let body;
  try { body = await req.json(); } catch { body = {}; }
  const id = String(body.id || '').trim();
  if (!id || id.length > 64) {
    return json({ ok: false, error: { code: 'bad_id', message: '缺少素材 id' } }, 400, origin);
  }
  const rec = await readIndex(env);
  const it = rec.items.find(x => x.id === id);
  if (!it) {
    return json({ ok: false, error: { code: 'not_found', message: '素材不存在或已删除' } }, 404, origin);
  }
  if (typeof body.cap === 'string') {
    const c = cleanCap(body.cap);
    if (c) it.cap = c;
  }
  if (typeof body.prompt === 'string') {
    const p2 = cleanPrompt(body.prompt);
    if (p2) it.prompt = p2; else delete it.prompt;
  }
  // 改所属分类
  if (typeof body.cat === 'string') {
    it.cat = cleanCat(body.cat, it.k);
  }
  // 置顶 / 取消置顶
  if (body.pin === 1 || body.pin === '1' || body.pin === true) { it.pin = 1; it.pinAt = Date.now(); }
  else if (body.pin === 0 || body.pin === '0' || body.pin === false) { delete it.pin; delete it.pinAt; }
  await writeIndex(env, rec.items, rec.cats);
  const items = await signedFeed(env, rec);
  return json({ ok: true, item: items.find(x => x.id === id) || null, items, cats: Array.isArray(rec.cats) ? rec.cats : [] }, 200, origin, { 'Cache-Control': 'no-store' });
}

/* ---------------- 分类管理：仅官方管理员，可增删自定义分类 ---------------- */
async function handleCats(req, env, origin) {
  const guard = await requireAdmin(env, req, origin);
  if (guard.error) return guard.error;
  if (!env.MEMBERS) {
    return json({ ok: false, error: { code: 'storage_unavailable', message: '存储未配置' } }, 503, origin);
  }
  let body;
  try { body = await req.json(); } catch { body = {}; }
  const rec = await readIndex(env);
  let cats = Array.isArray(rec.cats) ? rec.cats.slice() : [];
  const act = String(body.act || '');
  if (act === 'add') {
    const name = cleanCatName(body.n);
    if (!name) {
      return json({ ok: false, error: { code: 'bad_cat', message: '分类名称为空' } }, 400, origin);
    }
    if (cats.some(c => c.n === name)) {
      return json({ ok: false, error: { code: 'dup_cat', message: '分类已存在' } }, 400, origin);
    }
    const rand = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/-/g, '');
    cats.push({ key: 'c_' + rand.slice(0, 10), n: name });
  } else if (act === 'remove') {
    const key = String(body.key || '');
    if (!/^c_[a-z0-9]{1,18}$/.test(key)) {
      return json({ ok: false, error: { code: 'bad_cat', message: '内置分类不可删除' } }, 400, origin);
    }
    if (!cats.some(c => c.key === key)) {
      return json({ ok: false, error: { code: 'not_found', message: '分类不存在' } }, 404, origin);
    }
    cats = cats.filter(c => c.key !== key);
    // 删除分类后，原素材按类型回落到默认分类，避免成为孤儿
    rec.items.forEach(it => { if (it.cat === key) it.cat = it.k === 'v' ? 'video' : 'product'; });
  } else {
    return json({ ok: false, error: { code: 'bad_act', message: '未知分类操作' } }, 400, origin);
  }
  await writeIndex(env, rec.items, cats);
  const items = await signedFeed(env, { items: rec.items, cats });
  return json({ ok: true, cats, items }, 200, origin, { 'Cache-Control': 'no-store' });
}

/* ---------------- 路由入口 ------------------------------------------------- */
export async function handleFeed(req, env, origin) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, '');
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method === 'GET' && p === '/api/feed') {
    return handleGet(env, origin);
  }
  if (req.method === 'POST' && p === '/api/feed/presign') {
    return handlePresign(req, env, origin);
  }
  if (req.method === 'POST' && p === '/api/feed/commit') {
    return handleCommit(req, env, origin);
  }
  if (req.method === 'POST' && p === '/api/feed/update') {
    return handleUpdate(req, env, origin);
  }
  if (req.method === 'POST' && p === '/api/feed/cats') {
    return handleCats(req, env, origin);
  }
  if (req.method === 'DELETE' && p === '/api/feed') {
    // DELETE 鉴权需要请求头（Authorization）
    const guard = await requireAdmin(env, req, origin);
    if (guard.error) return guard.error;
    return handleDeleteAuthorized(url, env, origin);
  }
  return json({ ok: false, error: { code: 'not_found', message: '接口不存在' } }, 404, origin);
}
