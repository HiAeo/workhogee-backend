/* =====================================================================
 * WorkHogee · 效果中心数据层（analytics-store.js）
 * ---------------------------------------------------------------------
 * 第一方可信效果度量：H5 画册 / 渠道码短链 / 留资 / 埋点聚合 / 看板查询。
 * 纯 Cloudflare KV 实现（MVP，无 R2 / PG / Queues 依赖）：
 *
 *   写路径（省 KV 写、避单 key 热点）：
 *     - 浏览/点击类高频事件先在 isolate 内存聚合，按「店×日×时×isolate×序号」
 *       写增量分片 inc:*（key 天然分散，无读-改-写覆盖）；
 *     - scheduled 每小时把上一完整小时的分片 rollup 进 day:* 日汇总后删除；
 *     - 留资/线索是关键转化，立即精确写 lead:* 实体（不丢、可跟进）。
 *   读路径：
 *     - 过去日期读 day:*；当天 = 今日 day 片段 + 实时 list 今日 inc 分片；
 *     - 看板只读汇总，绝不实时扫事件。
 *
 * UV 用 HyperLogLog（p=10，标准误差约 3.25%，前端标注“近似”）；
 * 线索按联系方式精确去重。联系方式 AES-GCM 加密落盘。
 * ===================================================================*/

// ---------- 基础工具 ----------
const ENC = new TextEncoder();
const B64STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64encode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64decode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 去歧义 base62（无 0/O、1/l）
const CODE_ALPHABET = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
export function randomCode(len = 4) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[arr[i] % CODE_ALPHABET.length];
  return s;
}
export function randomId(prefix) {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return prefix + Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

function pad2(n) { return String(n).padStart(2, '0'); }
// 北京时区（UTC+8）日期/小时分片
export function bjParts(ts) {
  const d = new Date(ts + 8 * 3600 * 1000);
  return {
    date: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
    hh: pad2(d.getUTCHours())
  };
}
function dateLabel(offsetDays = 0) {
  return bjParts(Date.now() + offsetDays * 86400000).date;
}
// 区间内所有日期（含端点），最长 92 天
export function dateRange(from, to) {
  const out = [];
  const start = new Date(from + 'T00:00:00+08:00').getTime();
  const end = new Date(to + 'T00:00:00+08:00').getTime();
  for (let t = start; t <= end && out.length < 93; t += 86400000) out.push(bjParts(t).date);
  return out;
}
function normalizeDateParam(v, fallback) {
  if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return fallback;
}

async function getJson(kv, key) {
  try { return (await kv.get(key, 'json')) || null; } catch { return null; }
}
async function putJson(kv, key, val, ttl) {
  const opt = ttl ? { expirationTtl: ttl } : undefined;
  await kv.put(key, JSON.stringify(val), opt);
}

// ---------- 免 list 索引（读路径零 KV list，规避免费计划每日 1000 次 list 配额）----------
// 字符串数组去重追加（画册 / 渠道码 / 按小时 inc 分片索引），best-effort，失败静默
async function indexAdd(kv, key, val, ttl) {
  try {
    const arr = await getJson(kv, key);
    const list = Array.isArray(arr) ? arr : [];
    if (!list.includes(val)) { list.push(val); await putJson(kv, key, list, ttl); }
  } catch { /* 索引仅影响枚举完整性，小时 rollup 仍有全局 list 兜底 */ }
}
// 线索轻量索引项（不含加密联系方式），供列表 / 分桶零 list、零逐条 get
function leadIndexItem(rec) {
  return {
    id: rec.lead_id, created_at: rec.created_at, status: rec.status,
    source: rec.source || 'direct', showcase: rec.intent_showcase || '',
    name: rec.name || '', note: String(rec.note || '').slice(0, 100)
  };
}
async function leadIndexUpsert(kv, shop, item) {
  const key = `leadindex:${shop}`;
  try {
    const arr = await getJson(kv, key);
    const list = Array.isArray(arr) ? arr : [];
    const i = list.findIndex(x => x && x.id === item.id);
    if (i >= 0) list[i] = { ...list[i], ...item }; else list.push(item);
    await putJson(kv, key, list);
  } catch { /* ignore */ }
}
async function leadIndexPatch(kv, shop, id, patch) {
  const key = `leadindex:${shop}`;
  try {
    const arr = await getJson(kv, key);
    if (!Array.isArray(arr)) return;
    const i = arr.findIndex(x => x && x.id === id);
    if (i >= 0) { arr[i] = { ...arr[i], ...patch }; await putJson(kv, key, arr); }
  } catch { /* ignore */ }
}
// 取某店线索轻量索引，按北京日期集合过滤（dates 为 'YYYY-MM-DD' 数组）
async function leadIndexInRange(kv, shop, dates) {
  const arr = await getJson(kv, `leadindex:${shop}`);
  if (!Array.isArray(arr)) return [];
  const set = new Set(dates);
  return arr.filter(x => x && set.has(bjParts(x.created_at).date));
}

// ---------- 联系方式加密（AES-GCM） ----------
let _dataKeyPromise = null;
async function getDataKey(env) {
  const secret = env.DATA_KEY || env.ARK_API_KEY || 'workhogee-dev-data-key-change-me';
  if (_dataKeyPromise) return _dataKeyPromise;
  _dataKeyPromise = crypto.subtle.digest('SHA-256', ENC.encode(secret)).then(digest =>
    crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  );
  return _dataKeyPromise;
}
export async function encryptText(env, plain) {
  if (plain === null || plain === undefined || plain === '') return '';
  const key = await getDataKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, ENC.encode(String(plain)));
  const merged = new Uint8Array(iv.length + ct.byteLength);
  merged.set(iv, 0); merged.set(new Uint8Array(ct), iv.length);
  return 'enc:v1:' + b64encode(merged);
}
export async function decryptText(env, packed) {
  if (!packed || typeof packed !== 'string' || !packed.startsWith('enc:v1:')) return packed || '';
  try {
    const key = await getDataKey(env);
    const bytes = b64decode(packed.slice(7));
    const iv = bytes.slice(0, 12);
    const ct = bytes.slice(12);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch { return ''; }
}
export function maskContact(type, value) {
  const v = String(value || '');
  if (type === 'phone') return v.length >= 7 ? v.slice(0, 3) + '****' + v.slice(-4) : v;
  if (type === 'email') { const [u, d] = v.split('@'); return (u ? u[0] + '***' : '') + (d ? '@' + d : ''); }
  return v.length > 2 ? v[0] + '**' + v.slice(-1) : v;
}

// ---------- HyperLogLog（p=10） ----------
const HLL_P = 10;
const HLL_M = 1 << HLL_P;            // 1024
const HLL_ALPHA = 0.7213 / (1 + 1.079 / HLL_M);
function fnv32(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function emptyRegs() { return new Uint8Array(HLL_M); }
function hllAdd(regs, item) {
  const s = String(item);
  const h1 = fnv32(s);
  const idx = h1 & (HLL_M - 1);
  const h2 = fnv32(s, 0x9e3779b9);
  // 用 h2 的位计算前导零（至多 22 位），rho ∈ [1,23]
  let rho = 1;
  for (let bit = 31; bit >= 10; bit--) {
    if (((h2 >>> bit) & 1) === 1) break;
    rho++;
  }
  if (rho > regs[idx]) regs[idx] = rho;
}
function hllMerge(a, b) {
  for (let i = 0; i < HLL_M; i++) if (b[i] > a[i]) a[i] = b[i];
}
function hllCount(regs) {
  let sum = 0, zeros = 0;
  for (let i = 0; i < HLL_M; i++) {
    sum += Math.pow(2, -regs[i]);
    if (regs[i] === 0) zeros++;
  }
  let est = HLL_ALPHA * HLL_M * HLL_M / sum;
  if (est <= 2.5 * HLL_M && zeros > 0) est = HLL_M * Math.log(HLL_M / zeros);
  return Math.round(est);
}
function regsToB64(regs) { return b64encode(regs); }
function regsFromB64(str) {
  const r = emptyRegs();
  if (!str) return r;
  try {
    const b = b64decode(str);
    for (let i = 0; i < Math.min(r.length, b.length); i++) r[i] = b[i];
  } catch { /* ignore */ }
  return r;
}

// ---------- 聚合累加器 ----------
function newAcc() {
  return {
    t: { pv: 0, redir: 0, cta: 0, engage: 0, form: 0, share: 0, dur: 0, durn: 0 },
    uv: emptyRegs(), sess: emptyRegs(),
    ch: {}, sc: {}
  };
}
function chBucket(acc, src) {
  if (!src) src = 'direct';
  if (!acc.ch[src]) acc.ch[src] = { pv: 0, redir: 0, cta: 0, form: 0, share: 0, uv: emptyRegs() };
  return acc.ch[src];
}
function scBucket(acc, code) {
  if (!code) return null;
  if (!acc.sc[code]) acc.sc[code] = { pv: 0, cta: 0, form: 0, dur: 0, durn: 0, uv: emptyRegs() };
  return acc.sc[code];
}
function accAddEvent(acc, e) {
  const src = e.source || 'direct';
  const anon = e.anonymous_id_h || e.aid || '';
  const sid = e.session_id || '';
  switch (e.event) {
    case 'page_view':
      acc.t.pv++;
      if (anon) hllAdd(acc.uv, anon);
      if (sid) hllAdd(acc.sess, sid);
      chBucket(acc, src).pv++;
      if (anon) hllAdd(acc.ch[src].uv, anon);
      { const b = scBucket(acc, e.showcase_code); if (b) { b.pv++; if (anon) hllAdd(b.uv, anon); } }
      break;
    case 'redirect':
      acc.t.redir++; chBucket(acc, src).redir++; break;
    case 'cta_click':
      acc.t.cta++; chBucket(acc, src).cta++;
      { const b2 = scBucket(acc, e.showcase_code); if (b2) b2.cta++; }
      break;
    case 'engage':
      acc.t.engage++; break;
    case 'form_submit':
      acc.t.form++; chBucket(acc, src).form++;
      { const b3 = scBucket(acc, e.showcase_code); if (b3) b3.form++; }
      break;
    case 'share':
      acc.t.share++; chBucket(acc, src).share++; break;
    case 'stay': {
      const ms = Math.max(0, Math.min(7200000, Number(e.duration_ms) || 0));
      if (ms >= 500) { acc.t.dur += ms; acc.t.durn++; const b4 = scBucket(acc, e.showcase_code); if (b4) { b4.dur += ms; b4.durn++; } }
      break;
    }
    default: break;
  }
}
// HLL 寄存器可能是已反序列化的 Uint8Array，也可能是 KV 里的 b64 字符串；统一归一，避免二次解码清空
function asRegs(x) {
  if (x instanceof Uint8Array) return x;
  if (Array.isArray(x)) { const r = emptyRegs(); for (let i = 0; i < r.length; i++) r[i] = x[i] || 0; return r; }
  return x ? regsFromB64(x) : emptyRegs();
}
function accMerge(a, b) {
  for (const k of Object.keys(a.t)) a.t[k] += (b.t[k] || 0);
  hllMerge(a.uv, asRegs(b.uv)); hllMerge(a.sess, asRegs(b.sess));
  for (const [src, x] of Object.entries(b.ch || {})) {
    const c = chBucket(a, src);
    c.pv += x.pv || 0; c.redir += x.redir || 0; c.cta += x.cta || 0; c.form += x.form || 0; c.share += x.share || 0;
    hllMerge(c.uv, asRegs(x.uv));
  }
  for (const [code, x] of Object.entries(b.sc || {})) {
    const s = scBucket(a, code);
    s.pv += x.pv || 0; s.cta += x.cta || 0; s.form += x.form || 0; s.dur += x.dur || 0; s.durn += x.durn || 0;
    hllMerge(s.uv, asRegs(x.uv));
  }
}
function accSerialize(acc) {
  return {
    t: acc.t,
    uv: regsToB64(acc.uv), sess: regsToB64(acc.sess),
    ch: Object.fromEntries(Object.entries(acc.ch).map(([k, v]) => [k, { ...v, uv: regsToB64(v.uv) }])),
    sc: Object.fromEntries(Object.entries(acc.sc).map(([k, v]) => [k, { ...v, uv: regsToB64(v.uv) }]))
  };
}
function accDeserialize(o) {
  const acc = newAcc();
  if (!o) return acc;
  Object.assign(acc.t, o.t || {});
  if (o.uv) acc.uv = regsFromB64(o.uv);
  if (o.sess) acc.sess = regsFromB64(o.sess);
  for (const [k, v] of Object.entries(o.ch || {})) acc.ch[k] = { pv: v.pv || 0, redir: v.redir || 0, cta: v.cta || 0, form: v.form || 0, share: v.share || 0, uv: regsFromB64(v.uv) };
  for (const [k, v] of Object.entries(o.sc || {})) acc.sc[k] = { pv: v.pv || 0, cta: v.cta || 0, form: v.form || 0, dur: v.dur || 0, durn: v.durn || 0, uv: regsFromB64(v.uv) };
  return acc;
}

// ---------- 边缘内存缓冲 + 分片落 KV ----------
// isolate 标识必须在请求处理内懒生成——Workers 禁止在模块全局作用域取随机值
let _isoId = null;
function isoId() { if (!_isoId) _isoId = randomCode(3); return _isoId; }
let _flushSeq = 0;  // 跨 buffer 全局单调递增：buffer 会在每次 flush 后删除重建、b.seq 会重置，
// 不能用 b.seq 当分片序号，否则同一小时内多次 flush 的 inc 分片 key 相同、互相覆盖丢数。
const buffers = new Map();   // shop -> {acc, seq, lastFlush}
const FLUSH_EVERY_MS = 25000;
const FLUSH_SIZE = 20;

function bufferOf(shop) {
  let b = buffers.get(shop);
  if (!b) { b = { acc: newAcc(), seq: 0, lastFlush: Date.now() }; buffers.set(shop, b); }
  return b;
}

async function flushShop(env, shop, force) {
  const kv = env.MEMBERS;
  const b = buffers.get(shop);
  if (!b) return;
  const total = b.acc.t.pv + b.acc.t.redir + b.acc.t.cta + b.acc.t.form + b.acc.t.share + b.acc.t.engage;
  if (!force && total === 0) return;
  const { date, hh } = bjParts(Date.now());
  b.seq++;
  const key = `inc:${shop}:${date}:${hh}:${isoId()}:${++_flushSeq}:${Date.now().toString(36)}`;
  const payload = accSerialize(b.acc);
  buffers.delete(shop);
  try {
    await kv.put(key, JSON.stringify(payload), { expirationTtl: 60 * 3600 });
    // 按「店×日×时」枚举分片，供今日实时视图零 list 读取（TTL 略长于分片）
    await indexAdd(kv, `inci:${shop}:${date}:${hh}`, key, 3 * 3600);
  } catch { /* 内测可接受偶发丢弃 */ }
}

// 收集一批事件（来自 /c/collect）。ctx.waitUntil 保证刷盘。
export function collectEvents(env, ctx, shopId, events) {
  if (!env.MEMBERS || !shopId || !Array.isArray(events)) return;
  const b = bufferOf(shopId);
  let n = 0;
  for (const e of events) {
    if (!e || !e.event) continue;
    e.shop_id = shopId;
    accAddEvent(b.acc, e);
    n++;
  }
  if (!n) return;
  // Workers isolate 无状态、低频店无法靠“25 秒 / 20 条”攒批触发刷盘；
  // 每批立即落一个 inc 分片（一次 KV put，key 唯一无读-改-写覆盖），waitUntil 保证响应返回后仍刷盘。
  b.lastFlush = Date.now();
  const p = flushShop(env, shopId, true);
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
  return p;
}

// ---------- 每小时 rollup（scheduled 调用） ----------
async function rollupHour(env, date, hh) {
  const kv = env.MEMBERS;
  const wmKey = `wm:${date}:${hh}`;
  if (await kv.get(wmKey)) return { skipped: true, date, hh };
  const listed = await kv.list({ prefix: 'inc:' });
  const want = `:${date}:${hh}:`;
  const byShop = {};
  const delKeys = [];
  for (const k of listed.keys) {
    if (!k.name.includes(want)) continue;
    const shop = k.name.split(':')[1];
    const o = await getJson(kv, k.name);
    if (!o) { delKeys.push(k.name); continue; }
    if (!byShop[shop]) byShop[shop] = newAcc();
    accMerge(byShop[shop], accDeserialize(o));
    delKeys.push(k.name);
  }
  for (const [shop, acc] of Object.entries(byShop)) {
    const dayKey = `day:${shop}:${date}`;
    const dayAcc = accDeserialize(await getJson(kv, dayKey));
    accMerge(dayAcc, acc);
    await putJson(kv, dayKey, accSerialize(dayAcc));
  }
  for (const name of delKeys) { try { await kv.delete(name); } catch { /* ignore */ } }
  await putJson(kv, wmKey, { at: Date.now() }, { expirationTtl: 7 * 86400 });
  return { rolled: Object.keys(byShop).length, date, hh };
}

export async function scheduledRollup(env) {
  // 处理上一个完整小时；同时兜底补跑最近 3 小时内漏处理的分片
  const now = new Date(Date.now() + 8 * 3600000 - 3600000);
  const results = [];
  for (let back = 0; back < 3; back++) {
    const t = new Date(Date.now() + 8 * 3600000 - (back + 1) * 3600000);
    const date = `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
    const hh = pad2(t.getUTCHours());
    results.push(await rollupHour(env, date, hh));
  }
  return results;
}

// 读取某店某日的聚合（今日合并实时分片；往日读 day）
async function dayAcc(env, shop, date) {
  const kv = env.MEMBERS;
  const acc = accDeserialize(await getJson(kv, `day:${shop}:${date}`));
  if (date === dateLabel(0)) {
    // 零 list：按「店×日×时」索引枚举今日分片（每小时一个索引 key，最多 24 次 get）
    const curHH = Number(bjParts(Date.now()).hh);
    for (let h = 0; h <= curHH; h++) {
      const keys = await getJson(kv, `inci:${shop}:${date}:${pad2(h)}`);
      if (Array.isArray(keys)) {
        for (const k of keys) {
          const o = await getJson(kv, k);
          if (o) accMerge(acc, accDeserialize(o));
        }
      }
    }
  }
  return acc;
}

// ---------- 实体：画册 / 渠道码 / 线索 ----------
export async function createShowcase(env, shop, input) {
  const code = randomCode(4);
  const rec = {
    code, shop_id: shop,
    product_id: String(input.product_id || '').slice(0, 80),
    title: String(input.title || '未命名车源').slice(0, 120),
    assets: Array.isArray(input.assets) ? input.assets.slice(0, 12).map(a => {
      const raw = String(a.url || a.r2_key || '');
      const isData = raw.startsWith('data:image/');
      // 工作台直接内联压缩后的成品图（dataURL，单张约 1.9MB 上限，KV value 上限 25MB）；外链仍按短字段存
      const url = isData ? (raw.length <= 1900000 ? raw : '') : raw.slice(0, 500);
      return {
        asset_id: String(a.asset_id || '').slice(0, 80),
        kind: ['main', 'detail', 'gif', '360'].includes(a.kind) ? a.kind : 'main',
        url
      };
    }).filter(a => a.url) : [],
    copy: {
      title: String(input.copy?.title || input.title || '').slice(0, 200),
      selling_points: Array.isArray(input.copy?.selling_points) ? input.copy.selling_points.slice(0, 12).map(x => String(x).slice(0, 60)) : [],
      params: (input.copy && typeof input.copy.params === 'object') ? input.copy.params : {}
    },
    contact: {
      phone: String(input.contact?.phone || '').slice(0, 30),
      wechat: String(input.contact?.wechat || '').slice(0, 40),
      show_call: input.contact?.show_call !== false
    },
    status: 'published', created_at: Date.now()
  };
  await putJson(env.MEMBERS, `sc:${shop}:${code}`, rec);
  await indexAdd(env.MEMBERS, `scindex:${shop}`, code); // 本店画册 code 索引（零 list）
  return rec;
}
export async function getShowcase(env, shop, code) {
  return await getJson(env.MEMBERS, `sc:${shop}:${code}`);
}
export async function getPublicShowcase(env, code) {
  // 跨店按 code 反查归属（POST /showcases 时写入 sccode:<code>=shop），零 list
  const shop = await env.MEMBERS.get(`sccode:${code}`);
  if (shop) {
    const o = await getJson(env.MEMBERS, `sc:${shop}:${code}`);
    if (o) return o;
  }
  return null;
}
export async function listShowcases(env, shop) {
  const kv = env.MEMBERS;
  const codes = await getJson(kv, `scindex:${shop}`);
  const out = [];
  if (Array.isArray(codes)) {
    for (const code of codes) { const o = await getJson(kv, `sc:${shop}:${code}`); if (o) out.push(o); }
  }
  return out.sort((a, b) => b.created_at - a.created_at);
}

export async function createLink(env, shop, input) {
  const code = randomCode(4);
  let targetUrl = '';
  let targetCode = '';
  if (input.target_code) {
    targetCode = String(input.target_code).slice(0, 12);
    targetUrl = `https://api.workhogee.com/s/${targetCode}?ch=${code}`;
  } else {
    targetUrl = String(input.target_url || '').slice(0, 500);
  }
  const rec = {
    code, shop_id: shop, kind: input.kind === 'link' ? 'link' : 'qr',
    target_type: targetCode ? 'showcase' : 'url',
    target_code: targetCode, target_url: targetUrl,
    source: String(input.source || 'other').slice(0, 40),
    medium: String(input.medium || '').slice(0, 20),
    campaign: String(input.campaign || '').slice(0, 60),
    content: String(input.content || '').slice(0, 60),
    status: 'active', created_at: Date.now()
  };
  await putJson(env.MEMBERS, `qr:${code}`, rec);
  await indexAdd(env.MEMBERS, `qrindex:${shop}`, code); // 本店渠道码 code 索引（零 list）
  return rec;
}
export async function getLink(env, code) { return await getJson(env.MEMBERS, `qr:${code}`); }
export async function listLinks(env, shop) {
  const kv = env.MEMBERS;
  const codes = await getJson(kv, `qrindex:${shop}`);
  const out = [];
  if (Array.isArray(codes)) {
    for (const code of codes) { const o = await getJson(kv, `qr:${code}`); if (o) out.push(o); }
  }
  return out.sort((a, b) => b.created_at - a.created_at);
}

const LEAD_STATUSES = ['new', 'following', 'visited', 'deal', 'lost'];
export async function createLead(env, shop, input) {
  const kv = env.MEMBERS;
  const type = ['phone', 'wechat', 'email'].includes(input.contact?.type) ? input.contact.type : 'phone';
  const value = String(input.contact?.value || '').trim();
  if (!value) return { ok: false, code: 'bad_contact', message: '请留下手机号、微信或邮箱' };
  if (type === 'phone' && !/^1[3-9]\d{9}$/.test(value.replace(/\s|-/g, ''))) {
    return { ok: false, code: 'bad_phone', message: '手机号格式不正确' };
  }
  const optIn = !!input.opt_in;
  if (!optIn) {
    // 未授权：只计数不留联系方式（前端/画册应拦截，这里双保险）
    return { ok: false, code: 'no_consent', message: '请先勾选同意被联系' };
  }
  const normValue = value.replace(/\s|-/g, '');
  const showcaseCode = String(input.showcase_code || '').slice(0, 12);
  const linkCode = String(input.link_code || '').slice(0, 12);

  // 同店 + 同联系方式 + 同画册 24h 去重
  const dedupKey = `dedup:${shop}:${type}:${normValue}:${showcaseCode}`;
  if (await kv.get(dedupKey)) return { ok: false, code: 'duplicate', message: '已收到您的咨询，商家会尽快联系您' };

  let source = 'direct', firstTouch = linkCode, lastTouch = linkCode;
  if (linkCode) { const link = await getLink(env, linkCode); if (link) source = link.source; }

  const id = randomId('ld_');
  const now = Date.now();
  const rec = {
    lead_id: id, shop_id: shop,
    name: String(input.name || '').slice(0, 40),
    contact: { type, value: await encryptText(env, normValue) },
    intent_showcase: showcaseCode, intent_product: String(input.intent_product || '').slice(0, 80),
    note: String(input.intent_note || '').slice(0, 500),
    first_touch: firstTouch, last_touch: lastTouch, source,
    opt_in: true, opt_in_at: now,
    status: 'new', rating: 0, followups: [], created_at: now
  };
  await putJson(kv, `lead:${shop}:${id}`, rec);
  await leadIndexUpsert(kv, shop, leadIndexItem(rec)); // 本店线索轻量索引（零 list）
  await kv.put(dedupKey, '1', { expirationTtl: 86400 });
  return { ok: true, lead_id: id, status: 'new' };
}

export async function listLeads(env, shop, opts = {}) {
  const kv = env.MEMBERS;
  const from = normalizeDateParam(opts.from, dateLabel(-30));
  const to = normalizeDateParam(opts.to, dateLabel(0));
  const idx = await leadIndexInRange(kv, shop, dateRange(from, to));
  // 先在轻量索引上过滤（name/note 已含于索引），再只对命中项 get 实体解密
  let items = idx.sort((a, b) => b.created_at - a.created_at);
  if (opts.status && opts.status !== 'all') items = items.filter(r => r.status === opts.status);
  if (opts.source && opts.source !== 'all') items = items.filter(r => r.source === opts.source);
  if (opts.q) {
    const q = String(opts.q).toLowerCase();
    items = items.filter(r => (r.name || '').toLowerCase().includes(q) || (r.note || '').toLowerCase().includes(q));
  }
  const rows = [];
  for (const it of items) {
    const rec = await getJson(kv, `lead:${shop}:${it.id}`);
    if (rec) rows.push(rec);
  }
  // 列表返回脱敏联系方式（详情/导出才解密）
  const safe = await Promise.all(rows.map(async r => ({
    ...r,
    contact: { type: r.contact.type, value: maskContact(r.contact.type, await decryptText(env, r.contact.value)) }
  })));
  return safe;
}

export async function getLeadDecrypted(env, shop, id) {
  const rec = await getJson(env.MEMBERS, `lead:${shop}:${id}`);
  if (!rec || rec.shop_id !== shop) return null;
  rec.contact = { type: rec.contact.type, value: await decryptText(env, rec.contact.value) };
  return rec;
}

export async function addFollowup(env, shop, id, text) {
  const kv = env.MEMBERS;
  const rec = await getJson(kv, `lead:${shop}:${id}`);
  if (!rec || rec.shop_id !== shop) return { ok: false, code: 'not_found' };
  rec.followups = rec.followups || [];
  rec.followups.push({ at: Date.now(), by: 'owner', text: String(text || '').slice(0, 1000), human_confirmed: true });
  if (rec.status === 'new') rec.status = 'following';
  await putJson(kv, `lead:${shop}:${id}`, rec);
  await leadIndexPatch(kv, shop, id, { status: rec.status });
  return { ok: true, status: rec.status };
}

export async function patchLead(env, shop, id, patch) {
  const kv = env.MEMBERS;
  const rec = await getJson(kv, `lead:${shop}:${id}`);
  if (!rec || rec.shop_id !== shop) return { ok: false, code: 'not_found' };
  const idxPatch = {};
  if (patch.status && LEAD_STATUSES.includes(patch.status)) { rec.status = patch.status; idxPatch.status = rec.status; }
  if (patch.name !== undefined) { rec.name = String(patch.name).slice(0, 40); idxPatch.name = rec.name; }
  if (patch.rating !== undefined) rec.rating = Math.max(0, Math.min(5, Number(patch.rating) || 0));
  await putJson(kv, `lead:${shop}:${id}`, rec);
  if (Object.keys(idxPatch).length) await leadIndexPatch(kv, shop, id, idxPatch);
  return { ok: true, status: rec.status };
}

// ---------- 看板查询 ----------
function accTotalsView(acc) {
  return {
    pv: acc.t.pv,
    uv: hllCount(acc.uv),
    sessions: hllCount(acc.sess),
    redirect: acc.t.redir,
    cta: acc.t.cta,
    engage: acc.t.engage,
    form: acc.t.form,
    share: acc.t.share,
    avg_duration_ms: acc.t.durn ? Math.round(acc.t.dur / acc.t.durn) : 0
  };
}

// 区间内线索（精确），按来源/画册/状态分桶；基于轻量索引内存聚合，零 list、零逐条 get
async function leadsBreakdown(env, shop, from, to) {
  const kv = env.MEMBERS;
  const items = await leadIndexInRange(kv, shop, dateRange(from, to));
  const bySource = {}, byShowcase = {}, byStatus = { new: 0, following: 0, visited: 0, deal: 0, lost: 0 };
  let total = 0;
  for (const r of items) {
    total++;
    const src = r.source || 'direct';
    bySource[src] = (bySource[src] || 0) + 1;
    if (r.showcase) byShowcase[r.showcase] = (byShowcase[r.showcase] || 0) + 1;
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  }
  return { total, bySource, byShowcase, byStatus };
}

export async function analyticsOverview(env, shop, from, to) {
  from = normalizeDateParam(from, dateLabel(-6));
  to = normalizeDateParam(to, dateLabel(0));
  const dates = dateRange(from, to);
  const merged = newAcc();
  const trend = [];
  for (const d of dates) {
    const acc = await dayAcc(env, shop, d);
    accMerge(merged, acc);
    trend.push({ date: d, pv: acc.t.pv, uv: hllCount(acc.uv), cta: acc.t.cta, form: acc.t.form });
  }
  const leads = await leadsBreakdown(env, shop, from, to);
  const totals = accTotalsView(merged);
  totals.leads = leads.total;
  totals.lead_rate = totals.uv ? +(leads.total / totals.uv * 100).toFixed(1) : 0; // %
  totals.visited = leads.byStatus.visited || 0;
  totals.deal = leads.byStatus.deal || 0;

  // 漏斗（view/engage/cta 用聚合，lead/visited/deal 用线索精确）
  const funnel = [
    { key: 'view', label: '画册浏览', count: totals.pv },
    { key: 'engage', label: '有效浏览(停留>10秒)', count: merged.t.engage },
    { key: 'cta', label: '意向点击(拨号/加微/问底价)', count: totals.cta },
    { key: 'lead', label: '留资线索', count: leads.total },
    { key: 'following', label: '已跟进', count: (leads.byStatus.following || 0) + (leads.byStatus.visited || 0) + (leads.byStatus.deal || 0) },
    { key: 'visited', label: '到店', count: leads.byStatus.visited || 0 },
    { key: 'deal', label: '成交', count: leads.byStatus.deal || 0 }
  ];
  let prev = null;
  for (const s of funnel) { s.rate_from_prev = prev ? (prev ? +(s.count / prev * 100).toFixed(1) : 0) : 100; prev = s.count; }

  const topChannels = Object.entries(merged.ch).map(([source, v]) => ({
    source, pv: v.pv, redirect: v.redir, uv: hllCount(v.uv), cta: v.cta,
    leads: leads.bySource[source] || 0
  })).sort((a, b) => b.leads - a.leads || b.pv - a.pv).slice(0, 10);

  const showcaseMeta = await listShowcases(env, shop);
  const metaMap = Object.fromEntries(showcaseMeta.map(s => [s.code, s]));
  const topShowcases = Object.entries(merged.sc).map(([code, v]) => ({
    code, title: metaMap[code]?.title || code,
    thumb: metaMap[code]?.assets?.[0]?.url || '',
    pv: v.pv, uv: hllCount(v.uv), cta: v.cta,
    leads: leads.byShowcase[code] || 0,
    avg_duration_ms: v.durn ? Math.round(v.dur / v.durn) : 0
  })).sort((a, b) => b.leads - a.leads || b.pv - a.pv).slice(0, 10);

  return {
    totals, trend, funnel, top_channels: topChannels, top_showcases: topShowcases,
    meta: { source: 'first_party', tz: 'Asia/Shanghai', generated_at: Date.now(), from, to,
      note: 'PV/扫码/意向/留资为第一方精确统计；UV 为近似值；到店/成交为商家手动标记' }
  };
}

export async function analyticsChannels(env, shop, from, to) {
  from = normalizeDateParam(from, dateLabel(-6));
  to = normalizeDateParam(to, dateLabel(0));
  const merged = newAcc();
  for (const d of dateRange(from, to)) accMerge(merged, await dayAcc(env, shop, d));
  const leads = await leadsBreakdown(env, shop, from, to);
  const rows = Object.entries(merged.ch).map(([source, v]) => {
    const uv = hllCount(v.uv); const ld = leads.bySource[source] || 0;
    return { source, pv: v.pv, redirect: v.redir, uv, cta: v.cta, share: v.share,
      leads: ld, lead_rate: uv ? +(ld / uv * 100).toFixed(1) : 0 };
  }).sort((a, b) => b.leads - a.leads || b.pv - a.pv);
  const links = await listLinks(env, shop);
  return { rows, links, meta: { source: 'first_party', from, to } };
}

export async function analyticsShowcases(env, shop, from, to) {
  from = normalizeDateParam(from, dateLabel(-6));
  to = normalizeDateParam(to, dateLabel(0));
  const merged = newAcc();
  for (const d of dateRange(from, to)) accMerge(merged, await dayAcc(env, shop, d));
  const leads = await leadsBreakdown(env, shop, from, to);
  const all = await listShowcases(env, shop);
  return {
    rows: all.map(s => {
      const v = merged.sc[s.code] || { pv: 0, cta: 0, dur: 0, durn: 0 };
      const uv = merged.sc[s.code] ? hllCount(merged.sc[s.code].uv) : 0;
      const ld = leads.byShowcase[s.code] || 0;
      return { code: s.code, title: s.title, thumb: s.assets?.[0]?.url || '', status: s.status,
        created_at: s.created_at, pv: v.pv || 0, uv, cta: v.cta || 0, leads: ld,
        avg_duration_ms: v.durn ? Math.round(v.dur / v.durn) : 0,
        lead_rate: uv ? +(ld / uv * 100).toFixed(1) : 0 };
    }).sort((a, b) => b.created_at - a.created_at),
    meta: { source: 'first_party', from, to }
  };
}

// 线索导出 CSV（联系方式解密，仅本店）
export async function leadsCSV(env, shop, from, to) {
  const kv = env.MEMBERS;
  from = normalizeDateParam(from, dateLabel(-90)); // 导出默认近 90 天，避免空参得到空表
  to = normalizeDateParam(to, dateLabel(0));
  const idx = await leadIndexInRange(kv, shop, dateRange(from, to));
  idx.sort((a, b) => a.created_at - b.created_at);
  const rows = [];
  for (const it of idx) {
    const r = await getJson(kv, `lead:${shop}:${it.id}`);
    if (r) rows.push(r);
  }
  const head = ['线索ID', '姓名', '联系方式类型', '联系方式', '意向画册', '来源渠道', '状态', '授权时间', '留资时间', '备注'];
  const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = [head.join(',')];
  for (const r of rows) {
    const val = await decryptText(env, r.contact.value);
    lines.push([r.lead_id, r.name, r.contact.type, val, r.intent_showcase, r.source, r.status,
      new Date(r.opt_in_at || r.created_at).toISOString(), new Date(r.created_at).toISOString(), r.note].map(esc).join(','));
  }
  return '\uFEFF' + lines.join('\r\n'); // BOM 便于 Excel 识别 UTF-8
}
