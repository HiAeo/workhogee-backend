/* =====================================================================
 * WorkHogee · M2.3 薄 Worker 异步 Job 引擎（轮询驱动单步版）
 * ---------------------------------------------------------------------
 * 背景：Cloudflare 免费版 Worker 在响应返回后无法维持长 waitUntil 后台任务
 * （实测 ~25s 后被冻结）。因此改为「前端轮询 GET /job 驱动单步」：
 *   - POST /pipeline 只创建 job（KV），立刻返回 jobId；
 *   - 浏览器每 3~5s 轮询 GET /job；该请求在 Worker 内同步跑「下一个未完成 step」，
 *     跑完写 KV 再返回。每个请求只做一个 step（有硬超时），不依赖后台存活。
 *   - step 之间只通过 KV `job:<jobId>` 传递 URL + 元数据，绝不大 base64 过 Worker。
 *   - Seedream 用 response_format=url；视觉模型用公网 URL；
 *     PicWish 仅在返回时短暂持有 base64，转存 TOS 后立即释放。
 *
 * 并发控制：KV `joblock:<memberId>` 计数，每用户最多 2 个并行 job。
 * ===================================================================*/

import { presignPut, presignGet, tosPut, tosGetUrl, tosHead } from './tos.js';
import { identifyProduct, generatePipelineCopy, checkCutoutQuality } from './vision.js';
import { picwishCutoutByUrl } from './picwish.js';

const DEFAULT_SIZE = '2048x2048';
const ARK_ENDPOINT_DEFAULT = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
// 同一 step 被视为「仍在被某次轮询执行」的窗口；超过则认为上次请求挂了，下次轮询重跑。
const STEP_OWN_WINDOW_MS = 130000;

const safeSeg = (s) => String(s == null ? '' : s).replace(/[^a-zA-Z0-9_-]/g, '');

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

const CATEGORY_BG_PRESETS = {
  '家居百货': [
    { bg: '北欧风客厅一角，浅木色地板，窗边自然光洒落，沙发与绿植在背景中虚化，画面中央地面干净空旷、预留摆放商品的位置', guide: { position: 'center', scale: 0.55, shadow: true, colorTemp: 'warm' } },
    { bg: 'ins风浅木色桌面特写背景，柔光从侧方打来，背景虚化有绿植点缀，中央台面干净空旷留白', guide: { position: 'center', scale: 0.6, shadow: true, colorTemp: 'warm' } },
    { bg: '简约浅色书架旁的生活角落，书籍与收纳盒整齐排列，自然侧光，中央台面干净预留商品位置', guide: { position: 'center', scale: 0.5, shadow: true, colorTemp: 'natural' } }
  ],
  '3C数码': [
    { bg: '科技感极简白色桌面，柔和冷色氛围灯，画面空旷干净，中央台面预留摆放数码配件的位置', guide: { position: 'center', scale: 0.6, shadow: true, colorTemp: 'cool' } },
    { bg: '纯白色极简影棚背景，无影棚均匀柔光，地面干净无杂物，中央大面积留白', guide: { position: 'center', scale: 0.65, shadow: false, colorTemp: 'cool' } },
    { bg: '极简桌面搭配淡蓝色霓虹灯氛围光，现代科技感，背景适度虚化，中央台面干净留白', guide: { position: 'center', scale: 0.55, shadow: true, colorTemp: 'cool' } }
  ],
  '美妆个护': [
    { bg: 'ins风大理石梳妆台台面，柔和美妆环形白光，背景虚化有花束，中央台面干净预留商品位置', guide: { position: 'center', scale: 0.55, shadow: true, colorTemp: 'warm' } },
    { bg: '粉色柔光灯下的大理石台面，浅粉玫瑰与纱幔点缀，干净高级，中央台面留白', guide: { position: 'center', scale: 0.55, shadow: true, colorTemp: 'warm' } },
    { bg: '现代浴室大理石台面，白毛巾与尤加利叶点缀，自然光从窗户射入，中央台面干净预留位置', guide: { position: 'center', scale: 0.5, shadow: true, colorTemp: 'natural' } }
  ],
  '服饰鞋包': [
    { bg: '城市街头自然光街景，浅灰建筑与人行道在远处虚化，路面中央干净空旷预留摆放位置', guide: { position: 'center', scale: 0.6, shadow: true, colorTemp: 'natural' } },
    { bg: '简约衣帽间，浅色水泥墙面与开放式衣架，自然侧光，中央地面干净留白', guide: { position: 'center', scale: 0.55, shadow: true, colorTemp: 'natural' } },
    { bg: '咖啡馆木质桌面场景，虚化的咖啡杯与暖黄吊灯，中央桌面干净预留商品位置', guide: { position: 'center', scale: 0.6, shadow: true, colorTemp: 'warm' } }
  ],
  '食品餐饮': [
    { bg: '美食摄影木质餐桌，窗边自然光，餐具与绿植在旁点缀，桌面中央干净预留摆放食品的位置', guide: { position: 'center', scale: 0.55, shadow: true, colorTemp: 'warm' } },
    { bg: '现代厨房台面场景，整洁明亮，窗外自然光，中央台面干净留白', guide: { position: 'center', scale: 0.55, shadow: true, colorTemp: 'natural' } },
    { bg: '自然光野餐场景，浅色餐布上铺着花篮与藤编篮，背景草地虚化，中央餐布干净预留食品位置', guide: { position: 'center', scale: 0.55, shadow: true, colorTemp: 'warm' } }
  ]
};
const GENERIC_BG_PRESETS = [
  { bg: '明亮简约的生活化场景背景，自然光，浅色调，画面中央干净空旷预留摆放商品的位置', guide: { position: 'center', scale: 0.55, shadow: true, colorTemp: 'natural' } },
  { bg: 'ins风木质桌面，柔和氛围光，背景适度虚化，中央台面干净留白', guide: { position: 'center', scale: 0.6, shadow: true, colorTemp: 'warm' } },
  { bg: '浅色干净摄影棚背景，柔和侧光，地面整洁，中央大面积留白待合成商品', guide: { position: 'center', scale: 0.6, shadow: true, colorTemp: 'natural' } }
];
function pickBackgrounds(category) {
  const c = String(category || '');
  for (const key of Object.keys(CATEGORY_BG_PRESETS)) {
    if (c.includes(key.slice(0, 2)) || c.includes(key)) return CATEGORY_BG_PRESETS[key];
  }
  return GENERIC_BG_PRESETS;
}
function sceneBgPrompt(bgDesc, styleLine) {
  return [
    'Empty e-commerce product photography background. Scene: ' + bgDesc + '.',
    'Absolutely NO product, NO object, NO person, NO animal, NO vehicle, NO text, NO logo, NO watermark in the frame.',
    'The center area must be clean and uncluttered, deliberately left empty for later product compositing. High-end commercial photography, natural depth of field, realistic soft lighting.' + (styleLine ? ' Overall style: ' + styleLine + '.' : '')
  ].join(' ');
}
function marketingBgPrompt(styleLine) {
  return [
    'E-commerce promotional poster background, festive but clean, soft gradient with light decorative elements (ribbons, sparkles, soft geometric shapes).',
    'The CENTER must be a completely empty, uncluttered area reserved for later product compositing.',
    'Absolutely NO product, NO text, NO logo, NO human figure. Professional commercial advertising layout, bright and premium mood.' + (styleLine ? ' Overall style: ' + styleLine + '.' : '')
  ].join(' ');
}

// 文生图（不传 image）→ 返回公网 URL，Worker 不碰字节
async function seedreamTextGenUrl(env, { prompt, size, timeoutMs = 100000 }) {
  if (!env.ARK_API_KEY) throw new Error('seedream_no_key');
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, timeoutMs);
  try {
    const r = await fetch(env.ARK_ENDPOINT || ARK_ENDPOINT_DEFAULT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.ARK_API_KEY },
      body: JSON.stringify({
        model: env.ARK_MODEL,
        prompt,
        size: size || DEFAULT_SIZE,
        response_format: 'url'
      }),
      signal: ctrl.signal
    });
    const text = await r.text();
    if (!r.ok) throw new Error('seedream_http_' + r.status + ' ' + text.slice(0, 160));
    const j = JSON.parse(text);
    const url = j && j.data && j.data[0] && j.data[0].url;
    if (!url) throw new Error('seedream_no_url: ' + text.slice(0, 160));
    return url;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 下载远程图片字节并转存到自有 TOS（解决 Seedream ark 公共 bucket 无 CORS 配置的问题）。
 * 模式与 cutout 步骤一致：fetch → arrayBuffer → tosPut → 释放。逐张调用，单张内存。
 * 失败返回 null（调用方保留原 Seedream URL 作为前端 <img> 降级直显）。
 * @param {string} sourceUrl  远程图片 URL（Seedream 返回）
 * @param {string} tosKey     自有 TOS 目标 key
 * @returns {Promise<{key:string}|null>}
 */
async function reuploadImageToTos(env, sourceUrl, tosKey) {
  const cfg = tosConfig(env);
  // 最多尝试 2 次；每次下载加 30s 超时，避免 fetch 挂死拖垮整个 step
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, 30000);
    try {
      const r = await fetch(sourceUrl, { signal: ctrl.signal });
      if (!r.ok) throw new Error('dl_http_' + r.status);
      const ct = r.headers.get('content-type') || 'image/jpeg';
      const bytes = await r.arrayBuffer();
      await tosPut(cfg, tosKey, bytes, ct);
      return { key: tosKey };
    } catch (e) {
      if (attempt === 1) return null; // 第二次仍失败：降级保留原 Seedream URL
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * 把已转存到自有 TOS 的 scene/marketing key 刷新为预签名 GET URL；
 * 未转存成功的保留原 Seedream URL（前端会降级为 <img> 直显，不阻塞合成）。
 * 在 getJob 返回前调用，保证 sceneUrls/marketingUrl 始终是最新可用 URL。
 * 向后兼容：旧 job 没有 sceneSeedUrls 时原样保留 sceneUrls。
 */
async function refreshOutputUrls(env, job) {
  if (!job || !job.results) return;
  const cfg = tosConfig(env);
  const seedUrls = job.results.sceneSeedUrls;
  const keys = job.results.sceneKeys;
  if (Array.isArray(seedUrls)) {
    const out = [null, null, null];
    for (let i = 0; i < 3; i++) {
      const k = keys && keys[i];
      if (k) {
        try { out[i] = await tosGetUrl(cfg, k, 3600); }
        catch { out[i] = seedUrls[i] || null; }
      } else {
        out[i] = seedUrls[i] || null;
      }
    }
    job.results.sceneUrls = out;
  }
  if (job.results.marketingKey) {
    try { job.results.marketingUrl = await tosGetUrl(cfg, job.results.marketingKey, 3600); } catch {}
  }
  if (!job.results.marketingUrl && job.results.marketingSeedUrl) {
    job.results.marketingUrl = job.results.marketingSeedUrl;
  }
}

const STEP_ORDER = ['identify', 'cutout', 'scene', 'marketing', 'copy', 'qc'];

function emptySteps() {
  return STEP_ORDER.map(n => ({ name: n, status: 'pending', ms: 0 }));
}
const jobKvKey = (jobId) => 'job:' + jobId;
const lockKey = (memberId) => 'joblock:' + memberId;

async function saveJob(env, job) {
  job.updatedAt = Date.now();
  try {
    await env.MEMBERS.put(jobKvKey(job.jobId), JSON.stringify(job), { expirationTtl: 7200 });
  } catch {}
}

export async function tryAcquireSlot(env, memberId) {
  const k = lockKey(memberId);
  let cur = 0;
  try { cur = parseInt(await env.MEMBERS.get(k)) || 0; } catch { cur = 0; }
  if (cur >= 2) return false;
  await env.MEMBERS.put(k, String(cur + 1), { expirationTtl: 900 });
  return true;
}
export async function releaseSlot(env, memberId) {
  const k = lockKey(memberId);
  try {
    const cur = Math.max(0, (parseInt(await env.MEMBERS.get(k)) || 0) - 1);
    await env.MEMBERS.put(k, String(cur), { expirationTtl: 900 });
  } catch {}
}
export async function headObject(env, key) { return tosHead(tosConfig(env), key); }
export function keyBelongsTo(session, key) {
  const prefix = `uploads/${safeSeg(session.id)}/`;
  return typeof key === 'string' && key.startsWith(prefix) && !key.includes('..') && !key.includes('\\') && key.length <= 240;
}

/** 生成上传预签名：POST /upload-url。 */
export async function createUploadUrl(env, session) {
  const cfg = tosConfig(env);
  if (!cfg.accessKeyId || !cfg.bucket) { const e = new Error('tos_not_configured'); e.code = 'storage_unavailable'; throw e; }
  const ts = Date.now().toString(36);
  const rand = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)).replace(/-/g, '').slice(0, 16);
  const key = `uploads/${safeSeg(session.id)}/${ts}_${rand}.jpg`;
  const put = await presignPut({ ...cfg, key, expiresSec: 600 });
  return { uploadUrl: put.url, key, expiresSec: 600 };
}

/** 创建 job（不跑后台任务；由 GET /job 轮询逐步驱动）。 */
export async function createAndRunJob(env, session, { key, category, style, quotaResult }) {
  const jobId = 'job_' + session.id + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const job = {
    jobId,
    memberId: session.id,
    key,
    category: category || '',
    style: style || '',
    status: 'running',
    progress: 0,
    steps: emptySteps(),
    stepRunningAt: 0,
    results: {},
    errors: [],
    quota: quotaResult ? {
      deductedFrom: quotaResult.deductedFrom,
      remaining: quotaResult.remaining,
      monthlyRemaining: quotaResult.monthlyRemaining,
      topupBalance: quotaResult.topupBalance,
      totalAvailable: quotaResult.totalAvailable
    } : null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  await saveJob(env, job);
  return { jobId, status: 'running' };
}

/* ===== 各 step 的具体实现（每个只持有必要资源，结束即释放）===== */

async function stepIdentify(env, job) {
  const cfg = tosConfig(env);
  const originalUrl = await tosGetUrl(cfg, job.key, 3600);
  const id = await identifyProduct(env, originalUrl);
  let fields = {};
  let categoryName = job.category || '商品';
  if (id && id.available && id.fields) {
    fields = id.fields;
    if (!job.category) categoryName = fields.category || fields.kind || fields.name || '商品';
  }
  job.results.productAttributes = {
    productName: String(fields.name || ''),
    material: String(fields.material || ''),
    color: String(fields.color || ''),
    sellingPoints: Array.isArray(fields.sellingPoints) ? fields.sellingPoints.map(String).slice(0, 5) : [],
    packagingText: String(fields.packagingText || '')
  };
  job.results.category = { name: categoryName, source: job.category ? 'user' : 'vision' };
}

async function stepCutout(env, job) {
  const cfg = tosConfig(env);
  const originalUrl = await tosGetUrl(cfg, job.key, 3600);
  const pw = await picwishCutoutByUrl(env, originalUrl);
  if (!pw.ok) throw new Error((pw.error && pw.error.code) || 'picwish_failed');
  const dataUrl = pw.image;
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const cutoutKey = `cutouts/${safeSeg(job.memberId)}/${Date.now().toString(36)}.png`;
  await tosPut(cfg, cutoutKey, bytes, 'image/png');
  // 立即释放 base64
  job.results.cutoutKey = cutoutKey;
  job.results.cutoutWidth = pw.width;
  job.results.cutoutHeight = pw.height;
}

async function stepScene(env, job) {
  const categoryName = (job.results.category && job.results.category.name) || '商品';
  const presets = pickBackgrounds(categoryName);
  const styleLine = job.style || '';
  // sceneSeedUrls = Seedream 原始 URL（生成状态 + 降级兜底）；sceneKeys = 自有 TOS key
  const seedUrls = job.results.sceneSeedUrls || [null, null, null];
  const sceneKeys = job.results.sceneKeys || [null, null, null];
  const outPrefix = `outputs/${safeSeg(job.memberId)}/${safeSeg(job.jobId)}`;
  // 第一批：前两张并行（一次轮询请求内完成）
  const todo = [];
  if (!seedUrls[0]) todo.push(0);
  if (!seedUrls[1]) todo.push(1);
  await Promise.all(todo.map(i =>
    seedreamTextGenUrl(env, { prompt: sceneBgPrompt(presets[i].bg, styleLine), size: DEFAULT_SIZE, timeoutMs: 95000 })
      .then(u => { seedUrls[i] = u; })
      .catch(e => { job.errors.push({ step: 'scene.' + i, message: String((e && e.message) || e) }); })
  ));
  // 第二批：第三张（留给下一次轮询）
  if (!seedUrls[2]) {
    try { seedUrls[2] = await seedreamTextGenUrl(env, { prompt: sceneBgPrompt(presets[2].bg, styleLine), size: DEFAULT_SIZE, timeoutMs: 95000 }); }
    catch (e) { job.errors.push({ step: 'scene.2', message: String((e && e.message) || e) }); }
  }
  // 逐张转存到自有 TOS（下载→转存→释放，单张内存；失败降级保留 Seedream URL）
  for (let i = 0; i < 3; i++) {
    if (!seedUrls[i] || sceneKeys[i]) continue;
    const up = await reuploadImageToTos(env, seedUrls[i], `${outPrefix}/scene_${i}.jpg`);
    if (up) sceneKeys[i] = up.key;
  }
  job.results.sceneSeedUrls = seedUrls;
  job.results.sceneKeys = sceneKeys;
  job.results.compositeGuide = { scene: presets.map(p => p.guide), marketing: { position: 'center', scale: 0.5, shadow: true } };
  // 全部三张拿到才算 done
  if (!seedUrls[0] || !seedUrls[1] || !seedUrls[2]) throw new Error('scene_partial_retry');
}

async function stepMarketing(env, job) {
  const styleLine = job.style || '';
  let u = job.results.marketingSeedUrl;
  if (!u) {
    u = await seedreamTextGenUrl(env, { prompt: marketingBgPrompt(styleLine), size: DEFAULT_SIZE, timeoutMs: 95000 });
    job.results.marketingSeedUrl = u;
  }
  // 转存到自有 TOS（失败降级保留 Seedream URL；重试时不重复生成，省一次 Seedream 调用）
  if (!job.results.marketingKey) {
    const outPrefix = `outputs/${safeSeg(job.memberId)}/${safeSeg(job.jobId)}`;
    const up = await reuploadImageToTos(env, u, `${outPrefix}/marketing.jpg`);
    if (up) job.results.marketingKey = up.key;
  }
}

async function stepCopy(env, job) {
  const categoryName = (job.results.category && job.results.category.name) || '商品';
  const pa = job.results.productAttributes || {};
  let copy = {
    title: pa.productName || categoryName,
    sellingPoints: pa.sellingPoints.length ? pa.sellingPoints.map(s => '卖点：' + s) : [categoryName + '：实拍原图，所见即所得'],
    description: '',
    channels: { taobao: '', xhs: '', amazon: '' }
  };
  const c = await generatePipelineCopy(env, {
    productName: pa.productName, material: pa.material, color: pa.color,
    sellingPoints: pa.sellingPoints, packagingText: pa.packagingText, category: categoryName
  });
  if (c && c.available) {
    copy = {
      title: c.title || copy.title,
      sellingPoints: c.sellingPoints && c.sellingPoints.length ? c.sellingPoints : copy.sellingPoints,
      description: c.description || '',
      channels: c.channels || copy.channels
    };
  }
  job.results.copy = copy;
}

async function stepQc(env, job) {
  const cfg = tosConfig(env);
  const cutoutKey = job.results.cutoutKey;
  if (!cutoutKey) throw new Error('no_cutout');
  const cutoutUrl = await tosGetUrl(cfg, cutoutKey, 600);
  const q = await checkCutoutQuality(env, { cutout: cutoutUrl });
  job.results.qualityCheck = {
    passed: q.available && q.scores && q.scores.consistency >= 0.9 && q.scores.textReadability >= 0.9 && q.scores.edgeCleanliness >= 0.9,
    available: !!q.available,
    scores: q.scores || null,
    issues: q.issues || []
  };
}

const STEP_FN = {
  identify: stepIdentify,
  cutout: stepCutout,
  scene: stepScene,
  marketing: stepMarketing,
  copy: stepCopy,
  qc: stepQc
};

/**
 * GET /job 轮询入口：若下一个 step 可跑，就在本请求内同步跑完一步，再返回。
 * 并发安全：stepRunningAt 在窗口内说明另一请求在跑，直接返回当前状态。
 */
export async function getJob(env, session, jobId) {
  if (!jobId) return { ok: false, status: 400, error: { code: 'bad_param', message: '缺少 id' } };
  let job = null;
  try { job = await env.MEMBERS.get(jobKvKey(jobId), 'json'); } catch { job = null; }
  if (!job) return { ok: false, status: 404, error: { code: 'not_found', message: '任务不存在或已过期' } };
  if (job.memberId !== session.id) return { ok: false, status: 403, error: { code: 'forbidden', message: '无权查看该任务' } };

  const now = Date.now();

  // 已结束：刷新 cutoutUrl / sceneUrls / marketingUrl 后返回
  if (job.status === 'done' || job.status === 'error') {
    if (job.results && job.results.cutoutKey) {
      try { job.results.cutoutUrl = await tosGetUrl(tosConfig(env), job.results.cutoutKey, 3600); } catch {}
    }
    await refreshOutputUrls(env, job);
    return { ok: true, status: 200, job };
  }

  // 有人在跑（窗口内）：不抢，直接返回
  if (job.stepRunningAt && (now - job.stepRunningAt) < STEP_OWN_WINDOW_MS) {
    return { ok: true, status: 200, job };
  }

  // 找下一个未完成 step
  const next = job.steps.find(s => s.status !== 'done' && s.status !== 'failed');
  if (!next) {
    job.status = 'done';
    await saveJob(env, job);
    await releaseSlot(env, session.id);
    return { ok: true, status: 200, job };
  }

  // 认领并执行
  next.status = 'running';
  job.stepRunningAt = now;
  await saveJob(env, job);

  const t = Date.now();
  try {
    await STEP_FN[next.name](env, job);
    next.status = 'done';
  } catch (e) {
    next.status = 'failed';
    next.error = String((e && e.message) || e);
    // scene_partial_retry 不算致命：下次轮询继续补
    if (next.error !== 'scene_partial_retry') job.errors.push({ step: next.name, message: next.error });
  }
  next.ms = Date.now() - t;
  job.stepRunningAt = 0;

  // 计算进度
  const doneCount = job.steps.filter(s => s.status === 'done' || s.status === 'failed').length;
  job.progress = Math.round((doneCount / job.steps.length) * 100);

  // 全部完成？
  const allDone = job.steps.every(s => s.status === 'done' || s.status === 'failed');
  if (allDone) {
    job.status = 'done';
    // 若 cutout 完全失败，整体仍标记 done（前端可提示），释放槽位
    await releaseSlot(env, session.id);
  }

  // 刷新 cutoutUrl + sceneUrls/marketingUrl（自有 TOS 预签名）
  if (job.results && job.results.cutoutKey) {
    try { job.results.cutoutUrl = await tosGetUrl(tosConfig(env), job.results.cutoutKey, 3600); } catch {}
  }
  await refreshOutputUrls(env, job);
  await saveJob(env, job);
  return { ok: true, status: 200, job };
}
