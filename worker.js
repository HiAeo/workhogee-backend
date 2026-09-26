/* =====================================================================
 * WorkHogee 生图伙计 · Cloudflare Worker 薄代理层
 * ---------------------------------------------------------------------
 * 职责（刻意保持“薄”）：
 *   1. 把火山引擎 Seedream 的 API Key 留在服务端环境变量，前端永不可见；
 *   2. 统一处理 CORS、入参校验、基础限流、上游错误归一化；
 *   3. 对外提供车型知识库只读接口（冷启动内置，后续替换为 RAG）；
 *   4. 下发合规能力开关 /config，前端据此如实标注“已生效 / 待后端支持”。
 *
 * 密钥配置（不要写进代码、不要提交）：
 *   wrangler secret put ARK_API_KEY
 *   wrangler.toml [vars] 里放非机密的 ARK_MODEL / ARK_ENDPOINT
 *
 * 路由：
 *   GET  /health   健康检查
 *   GET  /config   公开配置 + 合规能力开关
 *   GET  /kb?brand=&series=&year=   车型知识库查询
 *   POST /generate 图像生成代理  body: { prompt, image(dataURL), size? }
 * ===================================================================*/

import { matchVehicle } from './kb-data.js';
import { handleAdmin } from './admin.js';
import { handleMember } from './member-api.js';
import { getMemberSession, ensureBootstrapAdmin } from './member-auth.js';
import { checkAndDeductQuota } from './members.js';
import { handleFeed, ensureFeedBootstrap } from './feed.js';
import { handleAnalytics, scheduledRollup } from './analytics.js';
import { verifyConsistency, appendGuardClauses, qcUpload, generateCopy, generateStoryboard, identifyProduct, groupProducts, extractProductFeatures, understandIntent, prefillFacts, planDetails, chatVisionCustom, detectPlatesByVision, generatePipelineCopy, checkCutoutQuality } from './vision.js';
import { stampImageMeta } from './image-meta.js';
import { presignPut, presignGet } from './tos.js';
import { segmentEntities, superResolve, saliencySegment, goodsSegment, carPlateDetection } from './cv.js';
import { mediakitCutout, mediakitFaceDetect } from './mediakit.js';
import { giteeMatting } from './gitee.js';
import { autodlCutout, autodlSuperRes } from './autodl.js';
import { picwishCutout } from './picwish.js';

const ARK_ENDPOINT_DEFAULT = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
// 火山图像接口要求输出像素 ≥ 3,686,400。
// 标准档 2048x2048（4,194,304）；高清 2K 档 2304x2304（5,308,416，已实测可出图）。
const ALLOWED_SIZES = ['2048x2048', '2304x2304'];
const DEFAULT_SIZE = '2048x2048';
const MAX_IMAGE_CHARS = 11_000_000;   // 单张 base64 体积上限（约 8MB 原图）
const MAX_IMAGES = 8;                  // 最多参考图：同一商品多角度合成（实地展厅仍只用 2 张：主体 + 背景）
const MAX_TOTAL_IMAGE_CHARS = 32_000_000;
// 自动分组接口收的是压缩缩略图，单独限额。
const GROUP_MAX_IMAGES = 12;
const GROUP_TOTAL_CHARS = 8_000_000;
const MAX_PROMPT_CHARS = 4000;

// 仅允许官网与 GitHub Pages 预览来源跨域；小程序为服务端请求，不受 CORS 限制。
const ALLOWED_ORIGINS = [
  'https://www.workhogee.com',
  'http://www.workhogee.com',
  'https://workhogee.com',
  'http://workhogee.com',
  'https://hiaeo.github.io',
  'http://hiaeo.github.io'
];

// 单 isolate 内存限流（免费版够用，不精确；生产建议换 KV / Rate Limiting / Turnstile）。
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_GENERATE = 30; // 每 IP 每分钟最多 30 次生成
const hitMap = new Map();

function corsHeaders(origin) {
  // 允许本地开发来源（localhost / 127.0.0.1 任意端口）；生产环境不会出现，安全无影响
  const allowDev = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const allow = (ALLOWED_ORIGINS.includes(origin) || allowDev) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
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

function clientIp(req) {
  return req.headers.get('CF-Connecting-IP') ||
         req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hitMap.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  arr.push(now);
  hitMap.set(ip, arr);
  // 顺带清理过期桶，避免内存无限增长
  if (hitMap.size > 5000) {
    for (const [k, v] of hitMap) if (!v.some(t => now - t < RATE_WINDOW_MS)) hitMap.delete(k);
  }
  return arr.length > RATE_MAX_GENERATE;
}

const DATA_URL_RE = /^data:image\/(jpe?g|png|webp);base64,([A-Za-z0-9+/=\s]+)$/;

// 调用一次火山 Seedream 图生图；成功返回 { b64 }，失败返回 { error, status }
// timeoutMs 同时约束"建连 + 响应头 + 响应体读取"，避免上游连接/响应体挂起导致请求永不返回
async function callSeedream(env, { prompt, imagePayload, size, timeoutMs = 110000 }) {
  if (!env.ARK_API_KEY) {
    return { status: 500, error: { code: 'server_misconfigured', message: '图像服务密钥未配置' } };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, timeoutMs);
  let upstream, text;
  try {
    upstream = await fetch(env.ARK_ENDPOINT || ARK_ENDPOINT_DEFAULT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + env.ARK_API_KEY
      },
      body: JSON.stringify({
        model: env.ARK_MODEL,
        prompt,
        image: imagePayload,
        size,
        response_format: 'b64_json'
      }),
      signal: ctrl.signal
    });
    text = await upstream.text(); // abort 信号同样能中断挂起的响应体读取
  } catch (e) {
    clearTimeout(timer);
    const aborted = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    return {
      status: 502,
      error: {
        code: aborted ? 'upstream_timeout' : 'upstream_network',
        message: aborted ? '图像模型响应超时，请重试' : '图像模型网络异常，请重试'
      }
    };
  }
  clearTimeout(timer);

  if (!upstream.ok) {
    return { status: 502, error: { code: 'upstream_' + upstream.status, message: text.slice(0, 300) } };
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { return { status: 502, error: { code: 'upstream_bad_json', message: '图像模型返回解析失败' } }; }

  const b64 = parsed && parsed.data && parsed.data[0] && parsed.data[0].b64_json;
  if (!b64) return { status: 502, error: { code: 'no_image', message: '图像模型未返回图片数据' } };
  return { b64 };
}

// 视觉后验 + 必要时自动重生成一次；外层用总预算兜底，超时即抛出由调用方降级为首版成品。
// 任何情况下都不应让"质检增强"把主生图链路拖死。
const VERIFY_TOTAL_BUDGET_MS = 120000;
async function runVerifyAndRegenerate(env, { userPrompt, imagePayload, size, images, firstStamped }, budgetMs = VERIFY_TOTAL_BUDGET_MS) {
  const started = Date.now();
  const remain = () => Math.max(0, budgetMs - (Date.now() - started));
  let budgetTimer;
  const budget = new Promise((_, reject) => {
    budgetTimer = setTimeout(() => reject(new Error('verify_budget_timeout')), budgetMs);
  });

  const work = (async () => {
    let stamped = firstStamped;
    let b64 = firstStamped.b64;
    let regenerated = false;

    const resultURL = 'data:' + stamped.mime + ';base64,' + b64;
    let verify = await verifyConsistency(
      env,
      { originals: images.slice(0, 1), result: resultURL },
      30000
    );

    // 本体不一致且视觉服务可用、且剩余预算足够再出一张：带着问题自动重生成一次
    if (verify.available && !verify.pass && remain() > 70000) {
      const issues = (verify.issues || []).slice(0, 5).join('；');
      const prompt2 = appendGuardClauses(userPrompt)
        + '\n\n__RETRY__ 上一版成品改动了商品本体，不合格。问题：' + (issues || '商品本体与参考图不一致')
        + '。本次务必让成品中的商品/车辆与参考图为同一件：原色、原品牌车标、原外形款式，保留全部真实划痕与瑕疵，仅替换背景与光影。';
      const genMs = Math.max(20000, Math.min(85000, remain() - 25000));
      const r2 = await callSeedream(env, { prompt: prompt2, imagePayload, size, timeoutMs: genMs });
      if (!r2.error) {
        const s2 = stampImageMeta(r2.b64);
        // 重生成后做一次短后验（仅在预算内）；后验不可用/超时也采用 r2，并标记请人工确认
        let v2 = { available: false, pass: true };
        if (remain() > 25000) {
          try {
            v2 = await verifyConsistency(
              env,
              { originals: images.slice(0, 1), result: 'data:' + s2.mime + ';base64,' + s2.b64 },
              20000
            );
          } catch { v2 = { available: false, pass: true }; }
        }
        regenerated = true;
        if (v2.available && (v2.pass || (typeof v2.score === 'number' && v2.score >= (verify.score || 0)))) {
          stamped = s2; b64 = s2.b64; verify = v2;
        } else {
          verify = Object.assign({}, verify, { retryStillFails: true }); // 保留首版，前端提示人工确认
        }
      }
    }
    return { stamped, b64, regenerated, verify };
  })();

  try {
    return await Promise.race([work, budget]);
  } finally {
    clearTimeout(budgetTimer);
  }
}

async function handleGenerate(req, env, origin) {
  // 会员门禁：内测期也需注册登录后才能出图（登录会员默认不限量）
  const session = await getMemberSession(env, req);
  if (!session) {
    return json({ ok: false, error: { code: 'member_unauthorized', message: '请先登录会员账号后再生成图片' } }, 401, origin);
  }
  if (session.status === 'suspended') {
    return json({ ok: false, error: { code: 'member_suspended', message: '账号已停用，请联系客服' } }, 403, origin);
  }


  const ip = clientIp(req);
  if (rateLimited(ip)) {
    return json({ ok: false, error: { code: 'rate_limited', message: '生成过于频繁，请稍后再试' } }, 429, origin, { 'Retry-After': '30' });
  }

  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: { code: 'bad_json', message: '请求体不是合法 JSON' } }, 400, origin); }

  const userPrompt = body && body.prompt;
  const rawImage = body && body.image;
  const size = ALLOWED_SIZES.includes(body && body.size) ? body.size : DEFAULT_SIZE;
  const doVerify = !body || body.verify !== false; // 默认开启一致性 / 隐私后验

  if (!userPrompt || typeof userPrompt !== 'string' || !userPrompt.trim()) {
    return json({ ok: false, error: { code: 'bad_prompt', message: '缺少生成指令 prompt' } }, 400, origin);
  }
  if (userPrompt.length > MAX_PROMPT_CHARS) {
    return json({ ok: false, error: { code: 'prompt_too_long', message: '生成指令过长' } }, 400, origin);
  }

  // image 支持单张 dataURL（字符串）或多张（数组：同一商品多角度，最多 MAX_IMAGES 张；实地展厅为 主体+背景 2 张）
  const images = Array.isArray(rawImage) ? rawImage : [rawImage];
  if (images.length < 1 || images.length > MAX_IMAGES
      || images.some(x => typeof x !== 'string' || !DATA_URL_RE.test(x))) {
    return json({ ok: false, error: { code: 'bad_image', message: '缺少合法的图片 dataURL（jpeg/png/webp），参考图最多 ' + MAX_IMAGES + ' 张' } }, 400, origin);
  }
  if (images.some(x => x.length > MAX_IMAGE_CHARS)) {
    return json({ ok: false, error: { code: 'image_too_large', message: '单张图片过大，请压缩到 8MB 以内' } }, 413, origin);
  }
  if (images.reduce((n, x) => n + x.length, 0) > MAX_TOTAL_IMAGE_CHARS) {
    return json({ ok: false, error: { code: 'image_too_large', message: '参考图总体积过大，请压缩后重试' } }, 413, origin);
  }
  // 性能优化：同一商品多角度（refKind='multi-angle'）先用视觉模型 turbo 提取关键特征，
  // Seedream 只吃 1 张代表图 + 特征文本，把多图出图从 ~87s 降到 ~25s；
  // 特征提取失败则降级回多图直出，绝不阻塞。实地展厅 bg-composite（主体+背景）保持 2 图。
  const refKind = body && body.refKind;
  let seedPrompt = userPrompt;
  let seedImages = images;
  if (images.length > 1 && refKind === 'multi-angle') {
    // 特征提取优先用前端给的小图（更快），没有则退回原图；输出限制 150 字
    const featureInputs = (body && Array.isArray(body.featureImages) && body.featureImages.length > 1)
      ? body.featureImages : images;
    const feat = await extractProductFeatures(env, featureInputs, { timeoutMs: 40000, maxLen: 150, maxTokens: 420 });
    if (feat.ok && feat.text) {
      seedImages = [images[0]];
      seedPrompt = '以下参考图是同一件商品的不同角度实拍。该商品关键视觉特征：'
        + feat.text + '。请严格依据这些特征还原商品本体（颜色、品牌、外形、真实瑕疵一致），只改变背景与光影。\n' + userPrompt;
    }
    // feat 失败：seedImages 保持全部 images，走原多图路径降级
  }
  const imagePayload = seedImages.length === 1 ? seedImages[0] : seedImages;

  // 第一次生成：服务端强制追加"本体保持 + 隐私规避"硬约束（源头治理）
  const r1 = await callSeedream(env, { prompt: appendGuardClauses(seedPrompt), imagePayload, size });
  if (r1.error) return json({ ok: false, error: r1.error }, r1.status, origin);

  // 首版成品（始终先准备好，作为任何后验异常时的兜底交付）
  const firstStamped = stampImageMeta(r1.b64);
  let stamped = firstStamped;
  let b64 = firstStamped.b64;
  let regenerated = false;
  let verify = { available: false, pass: true, privacyHit: false };

  // 视觉后验 + 必要时自动重生成（总预算 120s 兜底；任何超时/异常都降级返回首版，绝不挂死主链路）
  if (doVerify) {
    try {
      const out = await runVerifyAndRegenerate(
        env,
        { userPrompt: seedPrompt, imagePayload, size, images, firstStamped },
        VERIFY_TOTAL_BUDGET_MS
      );
      stamped = out.stamped;
      b64 = out.b64;
      regenerated = out.regenerated;
      verify = out.verify;
    } catch (e) {
      const isTimeout = e && e.message === 'verify_budget_timeout';
      stamped = firstStamped;
      b64 = firstStamped.b64;
      regenerated = false;
      verify = {
        available: false,
        degraded: true,
        pass: true,
        privacyHit: false,
        reason: isTimeout ? 'verify_timeout' : 'verify_error'
      };
    }
  }

  return json({
    ok: true,
    b64,
    size,
    assetId: stamped.assetId || null,
    metaStamped: stamped.stamped === true,
    regenerated,
    verify
  }, 200, origin);
}

// 独立复检端点：前端可对任意成品 vs 原图手动复检（会员门禁防滥用）
async function handleVerify(req, env, origin) {
  const session = await getMemberSession(env, req);
  if (!session) {
    return json({ ok: false, error: { code: 'member_unauthorized', message: '请先登录会员账号' } }, 401, origin);
  }
  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: { code: 'bad_json', message: '请求体不是合法 JSON' } }, 400, origin); }

  const result = body && (body.image || body.result);
  const originals = body && (Array.isArray(body.originals) ? body.originals : (body.original ? [body.original] : []));
  if (typeof result !== 'string' || !/^data:image\/(jpe?g|png|webp);base64,/.test(result)) {
    return json({ ok: false, error: { code: 'bad_image', message: '缺少待复检成品图 dataURL' } }, 400, origin);
  }
  const refs = (originals || []).filter(x => typeof x === 'string' && /^data:image\//.test(x)).slice(0, 2);
  const verify = await verifyConsistency(env, { originals: refs, result });
  return json({ ok: true, verify }, 200, origin);
}

async function handleQc(req, env, origin) {
  const session = await getMemberSession(env, req);
  if (!session) {
    return json({ ok: false, error: { code: 'member_unauthorized', message: '请先登录会员账号' } }, 401, origin);
  }
  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: { code: 'bad_json', message: '请求体不是合法 JSON' } }, 400, origin); }
  const image = body && body.image;
  if (typeof image !== 'string' || !/^data:image\/(jpe?g|png|webp);base64,/.test(image)) {
    return json({ ok: false, error: { code: 'bad_image', message: '缺少图片 dataURL' } }, 400, origin);
  }
  const qc = await qcUpload(env, image);
  return json({ ok: true, qc }, 200, origin);
}

async function handleCopy(req, env, origin) {
  const session = await getMemberSession(env, req);
  if (!session) {
    return json({ ok: false, error: { code: 'member_unauthorized', message: '请先登录会员账号' } }, 401, origin);
  }
  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: { code: 'bad_json', message: '请求体不是合法 JSON' } }, 400, origin); }
  const product = String((body && body.product) || '').slice(0, 100);
  const identityType = String((body && body.identityType) || 'general');
  const extra = String((body && body.extra) || '').slice(0, 500);
  const category = String((body && body.category) || '').slice(0, 50);
  const tone = String((body && body.tone) || '').slice(0, 200);
  const targetAudience = String((body && body.targetAudience) || '').slice(0, 200);
  const scene = String((body && body.scene) || '').slice(0, 200);
  const kbContext = String((body && body.kbContext) || '').slice(0, 2000);
  const sellingPoints = Array.isArray(body && body.sellingPoints) ? body.sellingPoints.map(String).slice(0, 12) : [];
  const channels = Array.isArray(body && body.channels)
    ? body.channels.map(String).filter(c => ['xhs', 'douyin', 'pyq', 'general'].includes(c)).slice(0, 4) : [];
  const facts = (body && body.facts && typeof body.facts === 'object')
    ? body.facts : String((body && body.facts) || '').slice(0, 3000);
  if (!product && sellingPoints.length === 0 && !facts) {
    return json({ ok: false, error: { code: 'bad_product', message: '缺少商品名或卖点' } }, 400, origin);
  }
  const result = await generateCopy(env, { product, identityType, extra, sellingPoints, category, tone, targetAudience, scene, kbContext, channels, facts });
  return json({ ok: true, copy: result }, 200, origin);
}

async function handleFactsPrefill(req, env, origin) {
  const session = await getMemberSession(env, req);
  if (!session) {
    return json({ ok: false, error: { code: 'member_unauthorized', message: '请先登录会员账号' } }, 401, origin);
  }
  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: { code: 'bad_json', message: '请求体不是合法 JSON' } }, 400, origin); }
  const image = String((body && body.image) || '');
  const identityType = String((body && body.identityType) || 'general');
  const category = String((body && body.category) || '').slice(0, 50);
  const product = String((body && body.product) || '').slice(0, 100);
  const facts = (body && body.facts && typeof body.facts === 'object')
    ? body.facts : String((body && body.facts) || '').slice(0, 2000);
  const r = await prefillFacts(env, { image, identityType, category, product, facts });
  if (!r.ok) {
    return json({ ok: false, error: { code: 'prefill_failed', message: r.reason || '预填失败' } }, 200, origin);
  }
  return json({ ok: true, prefill: r }, 200, origin);
}

async function handleIdentify(req, env, origin) {
  const session = await getMemberSession(env, req);
  if (!session) {
    return json({ ok: false, error: { code: 'member_unauthorized', message: '请先登录会员账号' } }, 401, origin);
  }
  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: { code: 'bad_json', message: '请求体不是合法 JSON' } }, 400, origin); }
  const image = body && body.image;
  if (typeof image !== 'string' || !/^data:image\/(jpe?g|png|webp);base64,/.test(image)) {
    return json({ ok: false, error: { code: 'bad_image', message: '缺少图片 dataURL' } }, 400, origin);
  }
  const result = await identifyProduct(env, image);
  return json({ ok: true, identify: result }, 200, origin);
}

// 商品自动分组：多图上传后，识别哪些是同一商品的多角度、哪些是不同商品（会员门禁）
async function handleGroup(req, env, origin) {
  const session = await getMemberSession(env, req);
  if (!session) {
    return json({ ok: false, error: { code: 'member_unauthorized', message: '请先登录会员账号' } }, 401, origin);
  }
  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: { code: 'bad_json', message: '请求体不是合法 JSON' } }, 400, origin); }
  const raw = body && body.images;
  const images = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
  if (images.length < 1 || images.length > GROUP_MAX_IMAGES
      || images.some(x => typeof x !== 'string' || !/^data:image\/(jpe?g|png|webp);base64,/.test(x))) {
    return json({ ok: false, error: { code: 'bad_image', message: '缺少合法图片 dataURL，最多 ' + GROUP_MAX_IMAGES + ' 张' } }, 400, origin);
  }
  if (images.reduce((n, x) => n + x.length, 0) > GROUP_TOTAL_CHARS) {
    return json({ ok: false, error: { code: 'image_too_large', message: '分组图片总体积过大，请使用缩略图' } }, 413, origin);
  }
  const r = await groupProducts(env, images);
  if (!r.ok) {
    // 降级：不擅自合并（避免把不同商品错误并组少扣费 / 出错），按每张一组返回并标 degraded，
    // 前端据此提示"自动分组没成功，请手动确认分组"。
    const fallback = images.map((_, i) => ({ name: '商品' + (i + 1), indices: [i] }));
    return json({ ok: true, degraded: true, groups: fallback }, 200, origin);
  }
  return json({ ok: true, groups: r.groups }, 200, origin);
}

// 特征提取独立端点（性能实测 / 未来复用；会员门禁）
async function handleFeature(req, env, origin) {
  const session = await getMemberSession(env, req);
  if (!session) {
    return json({ ok: false, error: { code: 'member_unauthorized', message: '请先登录会员账号' } }, 401, origin);
  }
  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: { code: 'bad_json', message: '请求体不是合法 JSON' } }, 400, origin); }
  const raw = body && body.images;
  const images = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
  if (!images.length || images.length > 6
      || images.some(x => typeof x !== 'string' || !/^data:image\/(jpe?g|png|webp);base64,/.test(x))) {
    return json({ ok: false, error: { code: 'bad_image', message: '缺少合法图片 dataURL，最多 6 张' } }, 400, origin);
  }
  const r = await extractProductFeatures(env, images, {
    timeoutMs: 40000, maxLen: body.maxLen || 260, maxTokens: body.maxTokens || 800
  });
  if (!r.ok) return json({ ok: false, error: { code: r.error } }, 200, origin);
  return json({ ok: true, text: r.text }, 200, origin);
}

// 阿视 · 视频分镜（P0 图文成片）：turbo 产出结构化镜头脚本，前端 Canvas 合成短视频 / GIF

// 卖点局部规划（视觉选 3 个卖点 bbox，前端原图裁剪+保真超分）
async function handleDetailsPlan(req, env, origin) {
  const session = await getMemberSession(env, req);
  if (!session) return json({ ok: false, error: { code: 'member_unauthorized', message: '请先登录会员账号' } }, 401, origin);
  let body; try { body = await req.json(); } catch { return json({ ok: false, error: { code: 'bad_json', message: '请求体不是合法 JSON' } }, 400, origin); }
  const image = body && body.image;
  if (typeof image !== 'string' || !/^data:image\/(jpe?g|png|webp);base64,/.test(image))
    return json({ ok: false, error: { code: 'bad_image', message: '缺少合法商品图 dataURL' } }, 400, origin);
  const r = await planDetails(env, { image, category: body.category || '', product: body.product || '' });
  if (!r.ok) return json({ ok: false, error: r.error || { code: 'details_failed' } }, 502, origin);
  return json({ ok: true, details: r.details }, 200, origin);
}

// 通用视觉 JSON：前端按 ask 请求视觉分析（定位/计数/质检等），返回结构化 JSON（会员门禁）
async function handleVisionJson(req, env, origin) {
  const session = await getMemberSession(env, req);
  if (!session) return json({ ok: false, error: { code: 'member_unauthorized', message: '请先登录会员账号' } }, 401, origin);
  let body; try { body = await req.json(); } catch { return json({ ok: false, error: { code: 'bad_json', message: '请求体不是合法 JSON' } }, 400, origin); }
  const image = body && body.image;
  if (typeof image !== 'string' || !/^data:image\/(jpe?g|png|webp);base64,/.test(image))
    return json({ ok: false, error: { code: 'bad_image', message: '缺少合法图片 dataURL' } }, 400, origin);
  const ask = typeof body.ask === 'string' && body.ask ? body.ask : '请分析这张图并返回 JSON。';
  const r = await chatVisionCustom(env, { system: body.system || '你是严谨的视觉分析助手，只输出 JSON。', user: ask, images: [image], maxTokens: body.maxTokens || 1800, temperature: 0.2, timeoutMs: 75000 });
  if (!r.ok) return json({ ok: false, error: r.error || { code: 'vision_failed' } }, 502, origin);
  return json({ ok: true, data: r.data }, 200, origin);
}

// 场景空背景（Seedream 文生图，只生不含产品/人物/文字的空背景，供前端保真合成）
async function handleSceneBackground(req, env, origin) {
  const session = await getMemberSession(env, req);
  if (!session) return json({ ok: false, error: { code: 'member_unauthorized', message: '请先登录会员账号' } }, 401, origin);
  let body; try { body = await req.json(); } catch { return json({ ok: false, error: { code: 'bad_json', message: '请求体不是合法 JSON' } }, 400, origin); }
  const category = (body && body.category) || '商品';
  const scene = (body && body.scene) || '生活化使用场景';
  const angle = (body && body.angle) || '自然平视';
  const light = (body && body.light) || '明亮柔和自然光';
  const size = ALLOWED_SIZES.includes(body && body.size) ? body.size : DEFAULT_SIZE;
  const prompt = [
    '一张空旷的「' + scene + '」环境背景图，用于后期合成商品，' + angle + '，' + light + '。',
    '画面必须是空的：没有人物、没有动物、没有自行车、没有汽车等任何交通工具、没有任何商品或摆放物体、没有文字、没有logo、没有水印。',
    '画面干净通透、有真实空间纵深感与自然光影，中央地面简洁并略微虚化（用于后续摆放商品），四周只有自然环境元素（树木、道路、远景等），高级商业摄影质感。'
  ].join('');
  const r = await callSeedream(env, { prompt, size, timeoutMs: 90000 });
  if (r.error) return json({ ok: false, error: r.error }, r.status, origin);
  return json({ ok: true, b64: r.b64, size }, 200, origin);
}

// 保真抠图 / 白底：entity_seg return_format=4，返回最大主体透明前景图+mask（像素级、不重画，会员门禁）
async function handleCutout(req, env, origin) {
  const session = await getMemberSession(env, req);
  if (!session) {
    return json({ ok: false, error: { code: 'member_unauthorized', message: '请先登录会员账号' } }, 401, origin);
  }
  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: { code: 'bad_json', message: '请求体不是合法 JSON' } }, 400, origin); }
  const image = body && body.image;
  if (typeof image !== 'string' || !/^data:image\/(jpe?g|png|webp);base64,/.test(image)) {
    return json({ ok: false, error: { code: 'bad_image', message: '缺少图片 dataURL' } }, 400, origin);
  }
  if (image.length > MAX_IMAGE_CHARS) {
    return json({ ok: false, error: { code: 'image_too_large', message: '图片过大，请先压缩' } }, 413, origin);
  }
  const strategy = body.strategy || 'max';
  const fail = (r) => json({ ok: false, error: r.error },
    /permission|denied|unauth|not.?activ|开通/i.test((r.error && r.error.code) || '') ? 403 : 502, origin);

  if (strategy === 'layers') {
    const r = await segmentEntities(env, image, { allLayers: true, maxEntity: body.maxEntity || 20 });
    if (!r.ok) return fail(r);
    return json({ ok: true, strategy: 'layers', entityNum: r.entityNum, masks: r.masks, width: r.width, height: r.height }, 200, origin);
  }
  if (strategy === 'saliency') {
    const r = await saliencySegment(env, image);
    if (!r.ok) return fail(r);
    return json({ ok: true, strategy: 'saliency', images: r.images, imagesCount: r.imagesCount }, 200, origin);
  }
  if (strategy === 'mediakit') {
    const r = await mediakitCutout(env, image, { scene: body.scene || 'product' });
    if (!r.ok) return fail(r);
    return json({ ok: true, strategy: 'mediakit', image: r.image, width: r.width, height: r.height, ms: r.ms }, 200, origin);
  }
  if (strategy === 'rmbg' || strategy === 'gitee') {
    const r = await giteeMatting(env, image, { model: body.model || 'RMBG-2.0' });
    if (!r.ok) return fail(r);
    return json({ ok: true, strategy: 'rmbg', image: r.image, width: r.width, height: r.height, ms: r.ms }, 200, origin);
  }
  if (strategy === 'autodl' || strategy === 'biref') {
    const r = await autodlCutout(env, image);
    if (!r.ok) return fail(r);
    return json({ ok: true, strategy: 'autodl', image: r.image, white: r.white, mask: r.mask, width: r.width, height: r.height, ms: r.ms }, 200, origin);
  }
  if (strategy === 'picwish') {
    const r = await picwishCutout(env, image);
    if (!r.ok) return fail(r);
    return json({ ok: true, strategy: 'picwish', image: r.image, width: r.width, height: r.height, ms: r.ms }, 200, origin);
  }
  if (strategy === 'goods') {
    const gr = await goodsSegment(env, image, body.method || 'product');
    if (!gr.ok) return fail(gr);
    return json({ ok: true, strategy: 'goods', image: gr.image }, 200, origin);
  }
  if (strategy === 'probe') {
    const out = { ok: true, strategy: 'probe' };
    const rm = await segmentEntities(env, image, { maxEntity: body.maxEntity || 20 });
    out.max = rm.ok ? { entityNum: rm.entityNum, foreground: rm.foreground, mask: rm.mask, imagesCount: rm.imagesCount } : { error: rm.error };
    const rl = await segmentEntities(env, image, { allLayers: true, maxEntity: body.maxEntity || 20 });
    out.layers = rl.ok ? { entityNum: rl.entityNum, masks: rl.masks } : { error: rl.error };
    const rs = await saliencySegment(env, image);
    out.saliency = rs.ok ? { images: rs.images, imagesCount: rs.imagesCount } : { error: rs.error };
    return json(out, 200, origin);
  }
  const r = await segmentEntities(env, image, { maxEntity: body.maxEntity || 20 });
  if (!r.ok) return fail(r);
  return json({ ok: true, entityNum: r.entityNum, foreground: r.foreground, mask: r.mask, imagesCount: r.imagesCount, width: r.width, height: r.height }, 200, origin);
}

// 保真超分：图片超分辨率 lens_nnsr2_pic_common，x2 放大不重画（会员门禁）
async function handleSuperRes(req, env, origin) {
  const session = await getMemberSession(env, req);
  if (!session) {
    return json({ ok: false, error: { code: 'member_unauthorized', message: '请先登录会员账号' } }, 401, origin);
  }
  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: { code: 'bad_json', message: '请求体不是合法 JSON' } }, 400, origin); }
  const image = body && body.image;
  if (typeof image !== 'string' || !/^data:image\/(jpe?g|png|webp);base64,/.test(image)) {
    return json({ ok: false, error: { code: 'bad_image', message: '缺少图片 dataURL' } }, 400, origin);
  }
  const scale = parseInt(body.scale, 10) || 4;
  const r = await autodlSuperRes(env, image, scale);
  if (!r.ok) {
    const st = /not_configured|unauth/i.test((r.error && r.error.code) || '') ? 403 : 502;
    return json({ ok: false, error: r.error }, st, origin);
  }
  return json({ ok: true, image: r.image, width: r.width, height: r.height, ms: r.ms }, 200, origin);
}

/* =====================================================================
 * M2 端到端物料包 pipeline（POST /pipeline）—— 图层合成架构
 * ---------------------------------------------------------------------
 * 核心纪律：产品像素绝不重绘。
 *   - 后端只生成"不含产品的空背景"（Seedream 文生图，不传参考图）；
 *   - 产品 = BiRefNet/RMBG 抠出的透明 PNG，由前端浏览器 Canvas 合成；
 *   - 白底图 = 同一张抠图 PNG（前端贴白底），后端不再生成白底图；
 *   - 细节图 = 原图按 bbox 裁剪 + 前端 /superres 超分，后端只返回 bbox；
 *   - 始终调用 identifyProduct 提取真实属性（category 仅用于场景路由，不跳过识别）；
 *   - 文案基于真实属性，结构化输出，禁止模板化/占位；
 *   - 末尾抠图质检评分（不阻断，前端展示分数）。
 * 降级：抠图 autodl→gitee；背景生成失败该位 null；错误进 errors 数组。
 * ===================================================================*/
const PIPELINE_GEN_SIZE = DEFAULT_SIZE; // 2048x2048（火山图像像素下限合规）
const EXPORT_SPECS_M2 = [
  { name: '淘宝', size: '800x800', transform: 'resize', note: '前端 Canvas 缩放，用合成后的白底主图' },
  { name: '小红书', size: '3:4', ratio: '3:4', transform: 'crop', note: '前端 Canvas 裁切' },
  { name: 'Amazon', size: '2000x2000', transform: 'resize', note: '纯白底合规，前端贴白底导出' }
];

// 品类 → 3 个空场景背景预设 + 合成建议（M2：只生空背景，绝不带产品/物体）
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

// 文生图 prompt：明确"空场景、无产品/物体/文字"，供前端保真合成（绝不重绘产品）
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

// 把 dataURL 图片缩放到短边 shortEdge px，返回新 dataURL（JPEG，质量 0.82）。
// 用 OffscreenCanvas（Workers runtime 内置），QC 用图从原图 2-3MB 压到 <500KB。
async function resizeDataUrl(dataUrl, shortEdge = 1024) {
  try {
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const scale = Math.min(1, shortEdge / Math.min(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = new OffscreenCanvas(w, h);
    const ctx2d = canvas.getContext('2d');
    // 抠图 PNG 有透明通道：先铺白底再画，避免 JPEG 导出变黑
    ctx2d.fillStyle = '#ffffff';
    ctx2d.fillRect(0, 0, w, h);
    ctx2d.drawImage(bitmap, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let out = '';
    for (let i = 0; i < buf.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, buf.subarray(i, Math.min(i + 0x8000, buf.length)));
    }
    return 'data:image/jpeg;base64,' + btoa(out);
  } catch (e) {
    return dataUrl; // 缩放失败则原图返回，不阻断质检
  }
}

// 上游重试：callSeedream 失败时重试 1 次（间隔 2s），重试仍失败才抛错
async function pipelineTextGenWithRetry(env, opts, retries = 1) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await pipelineTextGen(env, opts);
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}
// 文生图（不传 imagePayload）→ dataURL；失败抛错由上层 .catch 兜底为 null
async function pipelineTextGen(env, { prompt, size, timeoutMs }) {
  const r = await callSeedream(env, { prompt, size, timeoutMs });
  if (r.error) throw new Error((r.error && r.error.code) || 'seedream_failed');
  const stamped = stampImageMeta(r.b64);
  const mime = stamped.mime && stamped.mime !== 'image/unknown' ? stamped.mime : 'image/jpeg';
  return 'data:' + mime + ';base64,' + stamped.b64;
}

async function handlePipeline(req, env, origin, ctx) {
  // 会员门禁（与 M1 一致）
  const session = await getMemberSession(env, req);
  if (!session) {
    return json({ ok: false, error: { code: 'member_unauthorized', message: '请先登录会员账号后再生成物料包' } }, 401, origin);
  }
  if (session.status === 'suspended') {
    return json({ ok: false, error: { code: 'member_suspended', message: '账号已停用，请联系客服' } }, 403, origin);
  }

  // M2.2 额度门禁：pipeline 开始前检查并扣减额度，不足返回 402
  let quotaResult = null;
  try {
    quotaResult = await checkAndDeductQuota(env, session.id, 1);
    if (!quotaResult.ok) {
      return json({ ok: false, error: { code: 'quota_exhausted', message: quotaResult.message || '额度不足' } }, 402, origin);
    }
  } catch (e) {
    return json({ ok: false, error: { code: 'quota_check_failed', message: '额度校验异常，请重试' } }, 500, origin);
  }

  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: { code: 'bad_json', message: '请求体不是合法 JSON' } }, 400, origin); }

  const image = body && body.image;
  if (typeof image !== 'string' || !DATA_URL_RE.test(image)) {
    return json({ ok: false, error: { code: 'bad_image', message: '缺少合法的商品图 dataURL（jpeg/png/webp）' } }, 400, origin);
  }
  if (image.length > MAX_IMAGE_CHARS) {
    return json({ ok: false, error: { code: 'image_too_large', message: '图片过大，请先压缩到 8MB 以内' } }, 413, origin);
  }
  const userCategory = String((body && body.category) || '').slice(0, 50);
  const style = String((body && body.style) || '').slice(0, 100);
  const styleLine = style ? style : '';

  const errors = [];
  const tStart = Date.now();
  const timing = { identify: 0, cutout: 0, generate: 0, copy: 0, quality: 0, total: 0 };

  // 1) 强制视觉属性提取：无论是否传 category 都跑 identifyProduct。
  //    category 仅用于场景路由；source 区分 user / vision / user+vision。
  const tI = Date.now();
  let productAttributes = { productName: '', material: '', color: '', sellingPoints: [], packagingText: '' };
  let categoryInfo = { name: userCategory || '商品', confidence: userCategory ? 1 : 0.8, source: userCategory ? 'user' : 'vision', fields: {} };
  try {
    const id = await identifyProduct(env, image);
    timing.identify = Date.now() - tI;
    if (id && id.available && id.fields) {
      const f = id.fields;
      productAttributes = {
        productName: String(f.name || ''),
        material: String(f.material || ''),
        color: String(f.color || ''),
        sellingPoints: Array.isArray(f.sellingPoints) ? f.sellingPoints.map(String).slice(0, 5) : [],
        packagingText: String(f.packagingText || '')
      };
      if (!userCategory) {
        categoryInfo = {
          name: f.category || f.kind || f.name || '商品',
          confidence: Number(f.confidence) || 0.8,
          source: 'vision',
          fields: f
        };
      } else {
        categoryInfo = { name: userCategory, confidence: 0.9, source: 'user+vision', fields: f };
      }
    }
  } catch (e) {
    timing.identify = Date.now() - tI;
    errors.push({ step: 'identify', message: String((e && e.message) || e) });
  }
  const categoryName = categoryInfo.name || '商品';

  // 2) 抠图降级链：picwish(商用API) → autodl(BiRefNet) → gitee(RMBG-2.0)。
  //    M2 只返回透明 PNG 给前端合成，不再生成白底图。
  const tC = Date.now();
  let cutout = null;
  let cutoutStrategy = 'none';
  let cutoutPng = null;
  let cutoutMask = null;
  const pw = await picwishCutout(env, image);
  if (pw.ok) {
    cutout = pw; cutoutStrategy = 'picwish';
    cutoutPng = pw.image;
  } else {
    errors.push({ step: 'cutout.picwish', message: (pw.error && pw.error.code) || 'picwish_failed' });
    const ac = await autodlCutout(env, image);
    if (ac.ok) {
      cutout = ac; cutoutStrategy = 'autodl';
      cutoutPng = ac.image; cutoutMask = ac.mask || null;
    } else {
      errors.push({ step: 'cutout.autodl', message: (ac.error && ac.error.code) || 'autodl_failed' });
      const gm = await giteeMatting(env, image);
      if (gm.ok) {
        cutout = gm; cutoutStrategy = 'gitee';
        cutoutPng = gm.image;
      } else {
        errors.push({ step: 'cutout.gitee', message: (gm.error && gm.error.code) || 'gitee_failed' });
      }
    }
  }
  timing.cutout = Date.now() - tC;

  // 3) 文生图：3 张空场景背景 + 1 张营销背景（均不含产品，前端合成）
  //    M2.2：4 张全并行改为 2+2 分批 + 重试，降低突发内存和上游限流压力
  const tG = Date.now();
  const presets = pickBackgrounds(categoryName);
  const size = PIPELINE_GEN_SIZE;
  // M2.2：全部并行启动（与原版一致，保证总耗时≈单次生成时间），加了重试和全局兜底。
  // 峰值并发4由全局try-catch+重试+KV非阻塞来防502，不再用串行分批（会翻倍总耗时导致Worker超时）。
  const sceneResults = [null, null, null];
  const sceneTasks = [0,1,2].map(i =>
    pipelineTextGenWithRetry(env, { prompt: sceneBgPrompt(presets[i].bg, styleLine), size, timeoutMs: 90000 })
      .then(r => { sceneResults[i] = r; })
      .catch(e => { errors.push({ step: 'scene.' + i, message: String((e && e.message) || e) }); })
  );
  const marketingBgP = pipelineTextGenWithRetry(env, {
    prompt: marketingBgPrompt(styleLine), size, timeoutMs: 90000
  }).catch(e => { errors.push({ step: 'marketing', message: String((e && e.message) || e) }); return null; });
  await Promise.all([...sceneTasks, marketingBgP]);
  const marketingBg = await marketingBgP;
  timing.generate = Date.now() - tG;
  const scene = [sceneResults[0] || null, sceneResults[1] || null, sceneResults[2] || null];
  const compositeGuide = {
    scene: presets.map(p => p.guide),
    marketing: { position: 'center', scale: 0.5, shadow: true }
  };

  // 4) 细节图：只回 bbox，前端原图裁剪 + /superres 超分（后端不重绘细节）
  const detailBoxes = [];
  try {
    const pd = await planDetails(env, { image, category: categoryName, product: productAttributes.productName });
    if (pd && pd.ok && Array.isArray(pd.details)) {
      pd.details.slice(0, 2).forEach(d => detailBoxes.push({ label: d.label, bbox: d.bbox }));
    }
  } catch (e) {
    errors.push({ step: 'details-plan', message: String((e && e.message) || e) });
  }

  // 5) 文案：基于真实属性的结构化输出（title / 5 卖点 / 描述 / 三平台）
  const tCp = Date.now();
  let copy = {
    title: productAttributes.productName || categoryName,
    sellingPoints: productAttributes.sellingPoints.length
      ? productAttributes.sellingPoints.map(s => '卖点：' + s)
      : [categoryName + '：实拍原图，所见即所得'],
    description: '',
    channels: { taobao: '', xhs: '', amazon: '' }
  };
  try {
    const c = await generatePipelineCopy(env, {
      productName: productAttributes.productName,
      material: productAttributes.material,
      color: productAttributes.color,
      sellingPoints: productAttributes.sellingPoints,
      packagingText: productAttributes.packagingText,
      category: categoryName
    });
    timing.copy = Date.now() - tCp;
    if (c && c.available) {
      copy = {
        title: c.title || copy.title,
        sellingPoints: c.sellingPoints.length ? c.sellingPoints : copy.sellingPoints,
        description: c.description || '',
        channels: c.channels || copy.channels
      };
    }
  } catch (e) {
    timing.copy = Date.now() - tCp;
    errors.push({ step: 'copy', message: String((e && e.message) || e) });
  }

  // 6) 质检门禁（阿果）：抠图结构 / 包装文字可读性 / 边缘干净度评分，M2 不强制阻断
  //    M2.2：质检图缩放到短边 1024px（base64 体积减半），10s 硬超时；
  //    超时后用 ctx.waitUntil 后台继续跑（再给 20s），结果写 KV，前端轮询 /qc-result。
  const tQ = Date.now();
  const QC_THRESHOLD = { consistency: 0.92, textReadability: 0.9, edgeCleanliness: 0.9 };
  const pipelineId = session.id + ':' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  let qualityCheck = {
    passed: false,
    available: false,
    scores: null,
    pending: false,
    qcId: null,
    thresholds: QC_THRESHOLD,
    issues: ['qc_unavailable']
  };
  try {
    if (cutoutPng) {
      // 缩放到短边 1024px，减少 base64 体积（结构/文字/边缘判断不受影响）
      const [qcOrig, qcCut] = await Promise.all([
        resizeDataUrl(image, 1024),
        resizeDataUrl(cutoutPng, 1024)
      ]);
      // 释放原图大变量引用（内存优化）

      const qcPromise = checkCutoutQuality(env, { original: qcOrig, cutout: qcCut });
      const qcTimeout = new Promise(resolve => setTimeout(() => resolve({
        available: false, scores: null, issues: ['vision_timeout']
      }), 10000));
      const q = await Promise.race([qcPromise, qcTimeout]);
      timing.quality = Date.now() - tQ;
      if (q && q.available && q.scores) {
        qualityCheck = {
          passed: q.scores.consistency >= QC_THRESHOLD.consistency
            && q.scores.textReadability >= QC_THRESHOLD.textReadability
            && q.scores.edgeCleanliness >= QC_THRESHOLD.edgeCleanliness,
          available: true,
          scores: q.scores,
          pending: false,
          qcId: null,
          thresholds: QC_THRESHOLD,
          issues: q.issues || []
        };
      } else {
        // 10s 超时：后台异步补算（再给 20s），结果写 KV，前端轮询
        qualityCheck = {
          passed: false,
          available: false,
          scores: null,
          pending: true,
          qcId: pipelineId,
          thresholds: QC_THRESHOLD,
          issues: ['qc_unavailable'].concat((q && q.issues) || [])
        };
        if (ctx && ctx.waitUntil) {
          ctx.waitUntil((async () => {
            try {
              // 先用 1024px 再试一次（20s 预算）
              let bgResult = await Promise.race([
                checkCutoutQuality(env, { original: qcOrig, cutout: qcCut }),
                new Promise(resolve => setTimeout(() => resolve({ available: false, scores: null, issues: ['bg_timeout_1024'] }), 20000))
              ]);
              // 1024px 仍超时，降级 768px 再试 1 次
              if (!bgResult.available) {
                const [q768o, q768c] = await Promise.all([
                  resizeDataUrl(image, 768),
                  resizeDataUrl(cutoutPng, 768)
                ]);
                bgResult = await Promise.race([
                  checkCutoutQuality(env, { original: q768o, cutout: q768c }),
                  new Promise(resolve => setTimeout(() => resolve({ available: false, scores: null, issues: ['bg_timeout_768'] }), 15000))
                ]);
              }
              const rec = bgResult && bgResult.available ? {
                passed: bgResult.scores.consistency >= QC_THRESHOLD.consistency
                  && bgResult.scores.textReadability >= QC_THRESHOLD.textReadability
                  && bgResult.scores.edgeCleanliness >= QC_THRESHOLD.edgeCleanliness,
                available: true,
                scores: bgResult.scores,
                issues: bgResult.issues || []
              } : { available: false, scores: null, issues: (bgResult && bgResult.issues) || ['bg_failed'] };
              await env.MEMBERS.put('qc:' + pipelineId, JSON.stringify(rec), { expirationTtl: 3600 });
            } catch (e) {
              try { await env.MEMBERS.put('qc:' + pipelineId, JSON.stringify({ available: false, scores: null, issues: ['bg_error', String((e && e.message) || e)] }), { expirationTtl: 3600 }); } catch {}
            }
          })());
        }
      }
    } else {
      timing.quality = Date.now() - tQ;
      qualityCheck = {
        passed: false,
        available: false,
        scores: null,
        pending: false,
        qcId: null,
        thresholds: QC_THRESHOLD,
        issues: ['cutout_failed_no_product_png']
      };
    }
  } catch (e) {
    timing.quality = Date.now() - tQ;
    qualityCheck = {
      passed: false,
      available: false,
      scores: null,
      pending: false,
      qcId: null,
      thresholds: QC_THRESHOLD,
      issues: ['qc_error', String((e && e.message) || e)]
    };
  }

  // M2.2：KV 调用计数改为非阻塞（不阻塞响应）
  if (env.MEMBERS && ctx && ctx.waitUntil) {
    ctx.waitUntil((async () => {
      try {
        const k = 'pipeline:' + session.id;
        const n = parseInt(await env.MEMBERS.get(k), 10) || 0;
        await env.MEMBERS.put(k, String(n + 1));
      } catch (e) {}
    })());
  }

  // 内存优化：释放大 base64 引用
  if (cutoutPng) { /* keep in response */ }
  const quotaResp = quotaResult ? {
    deductedFrom: quotaResult.deductedFrom,
    remaining: quotaResult.remaining,
    monthlyRemaining: quotaResult.monthlyRemaining,
    topupBalance: quotaResult.topupBalance,
    totalAvailable: quotaResult.totalAvailable
  } : null;

  timing.total = Date.now() - tStart;

  return json({
    ok: true,
    category: { name: categoryName, confidence: categoryInfo.confidence, source: categoryInfo.source },
    productAttributes,
    cutout: {
      strategy: cutoutStrategy,
      image: cutoutPng || null,
      mask: cutoutMask,
      width: cutout ? cutout.width : 0,
      height: cutout ? cutout.height : 0,
      ms: timing.cutout
    },
    backgrounds: {
      scene,
      marketing: marketingBg ? [marketingBg] : [null]
    },
    compositeGuide,
    detailBoxes,
    copy,
    qualityCheck,
    quota: quotaResp,
    timing,
    errors,
    exportSpecs: EXPORT_SPECS_M2,
    videoReady: false
  }, 200, origin);
}

async function handlePrivacyDetect(req, env, origin) {
  const session = await getMemberSession(env, req);
  if (!session) {
    return json({ ok: false, error: { code: 'member_unauthorized', message: '请先登录会员账号' } }, 401, origin);
  }
  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: { code: 'bad_json', message: '请求体不是合法 JSON' } }, 400, origin); }
  const image = body && body.image;
  if (typeof image !== 'string' || !/^data:image\/(jpe?g|png|webp);base64,/.test(image)) {
    return json({ ok: false, error: { code: 'bad_image', message: '缺少图片 dataURL' } }, 400, origin);
  }
  const [plateR, faceR] = await Promise.all([
    detectPlatesByVision(env, image),
    mediakitFaceDetect(env, image)
  ]);
  const plates = plateR.ok ? plateR.boxes : [];
  const faces = faceR.ok ? faceR.boxes : [];
  return json({ ok: true, data: { plates, faces, plateError: plateR.ok ? null : plateR.error, faceError: faceR.ok ? null : faceR.error } }, 200, origin);
}
async function handleStoryboard(req, env, origin) {
  const session = await getMemberSession(env, req);
  if (!session) {
    return json({ ok: false, error: { code: 'member_unauthorized', message: '请先登录会员账号' } }, 401, origin);
  }
  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: { code: 'bad_json', message: '请求体不是合法 JSON' } }, 400, origin); }

  const product = String((body && body.product) || '').slice(0, 100);
  const category = String((body && body.category) || '').slice(0, 50);
  const copyText = String((body && body.copyText) || (body && body.copy) || '').slice(0, 800);
  const sellingPoints = Array.isArray(body && body.sellingPoints) ? body.sellingPoints.map(String).slice(0, 8) : [];
  const template = String((body && body.template) || 'showcase15');
  const ratio = String((body && body.ratio) || '9:16');

  if (!['showcase15', 'seeding20', 'quick8', 'detail30'].includes(template)) {
    return json({ ok: false, error: { code: 'bad_template', message: '分镜模板不合法' } }, 400, origin);
  }
  if (!['9:16', '1:1', '3:4'].includes(ratio)) {
    return json({ ok: false, error: { code: 'bad_ratio', message: '画幅不合法' } }, 400, origin);
  }
  if (!product && sellingPoints.length === 0 && !copyText) {
    return json({ ok: false, error: { code: 'bad_product', message: '缺少商品名、卖点或文案' } }, 400, origin);
  }
  const storyboard = await generateStoryboard(env, { product, category, sellingPoints, copyText, template, ratio });
  return json({ ok: true, storyboard }, 200, origin);
}

// 自由输入意图路由：把中央对话框的一句话分到五个伙计之一（会员门禁防滥用）
async function handleUnderstand(req, env, origin) {
  const session = await getMemberSession(env, req);
  if (!session) {
    return json({ ok: false, error: { code: 'member_unauthorized', message: '请先登录会员账号' } }, 401, origin);
  }
  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: { code: 'bad_json', message: '请求体不是合法 JSON' } }, 400, origin); }
  const text = String((body && body.text) || '').slice(0, 500);
  if (!text.trim()) {
    return json({ ok: false, error: { code: 'bad_text', message: '缺少文本' } }, 400, origin);
  }
  const context = (body && typeof body.context === 'object' && body.context) ? body.context : {};
  const r = await understandIntent(env, { text, context });
  if (!r || !r.available) {
    return json({ ok: false, available: false, error: { code: 'understand_unavailable', message: '意图识别暂不可用', reason: (r && r.reason) || 'unknown' } }, 200, origin);
  }
  return json({ ok: true, data: { target: r.target, action: r.action, confidence: r.confidence, product: r.product, reply: r.reply } }, 200, origin);
}

// 任务历史 KV key：tasks:{memberId}，value 为任务数组（最近30条）
function tasksKey(memberId) { return 'tasks:' + memberId; }
function stateKey(memberId) { return 'state:' + memberId; }

/* ===== 会员工作台状态云端备份（作品元数据 / 知识库 / 发布登记 / 连接登记 / 资料）=====
 * 图片、视频本体存 TOS，这里只保存元数据与远程对象 key，绝不收 data:/blob: 大字段。
 *   GET  /api/state        拉取云端备份
 *   POST /api/state        全量覆盖保存（前端做本地与云端合并后提交）
 * 远端空集合不会被用来清空本地（合并逻辑在前端，服务端只忠实存取当前账号 KV）。 */
const STATE_MAX_CHARS = 1800000;
function stripBigForKV(v, depth) {
  if (depth == null) depth = 0;
  if (depth > 8) return null;
  if (typeof v === 'string') {
    if (v.indexOf('data:') === 0 || v.indexOf('blob:') === 0) return '';
    return v.length > 20000 ? v.slice(0, 20000) : v;
  }
  if (typeof v === 'number' || typeof v === 'boolean' || v == null) return v;
  if (Array.isArray(v)) return v.slice(0, 400).map(function (x) { return stripBigForKV(x, depth + 1); });
  if (typeof v === 'object') {
    const o = {};
    Object.keys(v).slice(0, 200).forEach(function (k) {
      const key = String(k);
      if (key.charAt(0) === '_' || key === 'blob') return; // 内部临时字段 / 二进制不入库
      o[key] = stripBigForKV(v[k], depth + 1);
    });
    return o;
  }
  return null;
}
async function handleState(req, env, origin) {
  const session = await getMemberSession(env, req);
  if (!session) {
    return json({ ok: false, error: { code: 'member_unauthorized', message: '请先登录会员账号' } }, 401, origin);
  }
  const key = stateKey(session.id);
  if (req.method === 'GET') {
    let st = null;
    try { st = (await env.MEMBERS.get(key, 'json')) || null; } catch (e) { st = null; }
    return json({ ok: true, state: st }, 200, origin);
  }
  if (req.method === 'POST' || req.method === 'PUT') {
    let body;
    try { body = await req.json(); }
    catch (e) { return json({ ok: false, error: { code: 'bad_json', message: '请求体不是合法 JSON' } }, 400, origin); }
    let st = body && body.state && typeof body.state === 'object' && !Array.isArray(body.state) ? body.state : {};
    st = stripBigForKV(st, 0);
    if (Array.isArray(st.works)) st.works = st.works.slice(0, 300);
    if (Array.isArray(st.publish)) st.publish = st.publish.slice(0, 400);
    if (Array.isArray(st.connections)) st.connections = st.connections.slice(0, 200);
    let txt;
    try { txt = JSON.stringify(st); }
    catch (e) { return json({ ok: false, error: { code: 'bad_state', message: '状态无法序列化' } }, 400, origin); }
    if (txt.length > STATE_MAX_CHARS) {
      return json({ ok: false, error: { code: 'too_large', message: '云端备份超出大小限制' } }, 413, origin);
    }
    try { await env.MEMBERS.put(key, txt); }
    catch (e) { return json({ ok: false, error: { code: 'storage_error', message: '保存失败' } }, 500, origin); }
    return json({ ok: true, saved: true, bytes: txt.length }, 200, origin);
  }
  return json({ ok: false, error: { code: 'bad_method', message: 'method not allowed' } }, 405, origin);
}

async function handleTasks(req, env, origin) {
  const session = await getMemberSession(env, req);
  if (!session) {
    return json({ ok: false, error: { code: 'member_unauthorized', message: '请先登录会员账号' } }, 401, origin);
  }
  const key = tasksKey(session.id);

  // GET /api/tasks —— 拉当前用户任务列表
  if (req.method === 'GET') {
    let list = [];
    try { list = (await env.MEMBERS.get(key, 'json')) || []; } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    return json({ ok: true, tasks: list.slice(0, 30) }, 200, origin);
  }

  // POST /api/tasks/sync —— 全量覆盖保存（前端内存缓存提交）
  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); }
    catch { return json({ ok: false, error: { code: 'bad_json', message: '请求体不是合法 JSON' } }, 400, origin); }
    let list = body && Array.isArray(body.tasks) ? body.tasks : [];
    // 服务端兜底：只保留最近30条，过滤非法项
    list = list
      .filter(t => t && typeof t.id === 'string' && t.id)
      .slice(0, 30);
    try {
      await env.MEMBERS.put(key, JSON.stringify(list));
    } catch (e) {
      return json({ ok: false, error: { code: 'storage_error', message: '保存失败' } }, 500, origin);
    }
    return json({ ok: true, saved: list.length }, 200, origin);
  }

  return json({ ok: false, error: { code: 'bad_method', message: 'method not allowed' } }, 405, origin);
}

/* ===== TOS 对象存储：跨端同步原图 / 成品图 =====================================
 * Worker 只用 IAM AK/SK 计算 TOS4 预签名，图片字节在浏览器与 TOS 北京之间
 * 直传直读、不绕 Worker、不占跨境带宽。对象按会员前缀隔离，GET 校验归属防越权。
 * 未配置 TOS 时返回 503，前端降级回 dataURL + KV，不阻断主流程。
 *   POST /api/storage  body:{action:'put', ext, kind} -> {key,putUrl,getUrl,...}
 *   POST /api/storage  body:{action:'get', key}        -> {getUrl}
 * ============================================================================ */
const TOS_EXT_CT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm' };
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
const safeSeg = s => String(s == null ? '' : s).replace(/[^a-zA-Z0-9_-]/g, '');

async function handleStorage(req, env, origin) {
  if (req.method !== 'POST') {
    return json({ ok: false, error: { code: 'bad_method', message: 'method not allowed' } }, 405, origin);
  }
  const session = await getMemberSession(env, req);
  if (!session) {
    return json({ ok: false, error: { code: 'member_unauthorized', message: '请先登录会员账号' } }, 401, origin);
  }
  const cfg = tosConfig(env);
  if (!cfg.accessKeyId || !cfg.secretAccessKey || !cfg.bucket) {
    return json({ ok: false, error: { code: 'storage_unavailable', message: '对象存储未配置' } }, 503, origin);
  }
  let body;
  try { body = await req.json(); } catch { body = {}; }

  // 读取：凭 key 换新鲜 GET 预签名（跨端打开旧任务时调用）
  if (body.action === 'get') {
    const key = String(body.key || '');
    const prefix = `u/${safeSeg(session.id)}/`;
    if (!key.startsWith(prefix) || key.includes('..') || key.includes('\\') || key.length > 240) {
      return json({ ok: false, error: { code: 'forbidden', message: '无权访问该对象' } }, 403, origin);
    }
    const get = await presignGet({ ...cfg, key, expiresSec: 3600 });
    return json({ ok: true, key, getUrl: get.url, expiresIn: 3600 }, 200, origin);
  }

  // 上传：服务端生成归属本人的 key + PUT/GET 预签名
  const ext = String(body.ext || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
  const contentType = TOS_EXT_CT[ext];
  if (!contentType) {
    return json({ ok: false, error: { code: 'bad_ext', message: '仅支持 jpg/png/webp/gif/mp4/webm' } }, 400, origin);
  }
  const kind = safeSeg(body.kind || 'asset').slice(0, 24) || 'asset';
  const d = new Date();
  const ym = d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0');
  const rand = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/-/g, '');
  const key = `u/${safeSeg(session.id)}/${kind}/${ym}/${rand}.${ext}`;
  const [put, get] = await Promise.all([
    presignPut({ ...cfg, key, expiresSec: 600 }),
    presignGet({ ...cfg, key, expiresSec: 3600 })
  ]);
  return json({
    ok: true,
    key,
    method: 'PUT',
    putUrl: put.url,
    getUrl: get.url,
    headers: { 'Content-Type': contentType },
    putExpiresIn: 600,
    getExpiresIn: 3600
  }, 200, origin);
}

function handleKb(url, origin) {
  const brand = url.searchParams.get('brand') || '';
  const series = url.searchParams.get('series') || '';
  const year = url.searchParams.get('year') || '';
  const kb = matchVehicle(brand, series);
  return json({ ok: true, year: year || null, kb }, 200, origin, { 'Cache-Control': 'public, max-age=86400' });
}

function handleConfig(env, origin) {
  return json({
    ok: true,
    service: 'workhogee-image-api',
    version: '1.0.0',
    image: {
      provider: 'volcengine-seedream',
      sizes: ALLOWED_SIZES,
      minPixels: 3686400
    },
    // 合规 / 信任能力开关：前端据此渲染“已生效 / 待支持”，不夸大、不硬编码承诺
    capabilities: {
      aiLabel: true,              // 显式 AI 标识（Seedream 水印 + 前端角标）
      aiMetadata: true,           // 隐式 AI 标识（成品文件内 XMP / tEXt 元数据）
      bannedWordsFilter: true,    // 绝对化/承诺词拦截（前端文案清洗）
      consistencyVerify: true,    // 主体一致性视觉后验（颜色/车标/外形），不合格自动重生成一次
      defectGuard: true,          // 真实划痕/瑕疵保留校验（提示词硬约束 + 视觉后验拦截）
      privacyDetect: true,        // 车牌/人脸/VIN 视觉检测 + 生成端规避 + 前端提示
      pixelMask: false,           // 像素级自动打码：需 Workers 付费算力或第三方脱敏 API，开关预留
      // 兼容旧字段名
      colorConsistencyVerify: true,
      accidentTracePreserve: true,
      plateFaceVinMask: false         // 硬像素打码尚未启用（检测已启用，见 privacyDetect）
    }
  }, 200, origin, { 'Cache-Control': 'public, max-age=300' });
}

/* 冷启动引导（每个 isolate 最多一次）：官方管理员账号 workhogee + 官方素材墙出厂索引。
 * 失败不阻断任何正常请求（两个引导内部都自带 try/catch 与重试）。 */
let _runtimeBootPromise = null;
function ensureRuntimeBoot(env) {
  if (_runtimeBootPromise) return _runtimeBootPromise;
  _runtimeBootPromise = Promise.allSettled([
    ensureBootstrapAdmin(env),
    ensureFeedBootstrap(env)
  ]);
  return _runtimeBootPromise;
}

// 图片链接安全代理（链接导入，前端 CORS 兜底；仅放行公网 image/*，SSRF 防护 + 15MB 上限）
async function handleImportUrl(url, origin) {
  const u = (url.searchParams.get('u') || '').trim();
  const bad = (code, msg) => json({ ok: false, error: { code, message: msg } }, 400, origin);
  let tu;
  try { tu = new URL(u); } catch (e) { return bad('bad_url', '链接不合法'); }
  if (tu.protocol !== 'http:' && tu.protocol !== 'https:') return bad('bad_proto', '仅支持 http(s)');
  const host = tu.hostname.toLowerCase();
  const priv = host === 'localhost' || host === 'metadata.google.internal' ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^0\./.test(host) || host === '::1' || /^(fc|fd|fe)/.test(host) || /\.internal$/.test(host);
  if (priv) return bad('blocked', '不允许抓取内网/保留地址');
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(tu.toString(), {
      method: 'GET', redirect: 'follow', signal: ctrl.signal,
      headers: { 'Accept': 'image/*,*/*;q=0.8', 'User-Agent': 'Mozilla/5.0 WorkHogee-Importer' }
    });
    clearTimeout(to);
    if (!r.ok) return bad('upstream', '上游返回 ' + r.status);
    const ct = (r.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    const cl = parseInt(r.headers.get('Content-Length') || '0', 10);
    if (!ct.startsWith('image/')) return bad('not_image', '链接内容不是图片（网盘/飞书分享页请先下载再传）');
    if (cl && cl > 15 * 1024 * 1024) return bad('too_large', '图片超过 15MB');
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 15 * 1024 * 1024) return bad('too_large', '图片超过 15MB');
    const h = corsHeaders(origin);
    h['Content-Type'] = ct;
    h['Cache-Control'] = 'public, max-age=3600';
    return new Response(buf, { status: 200, headers: h });
  } catch (e) {
    return bad('fetch_failed', '抓取失败：链接可能需登录或不是图片直链');
  }
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // 冷启动引导（管理员账号 + 素材墙出厂数据），幂等且不阻断主流程
    try { await ensureRuntimeBoot(env); } catch (e) {}

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/' || path === '/health') {
      return json({ ok: true, service: 'workhogee-image-api', status: 'healthy', ts: Date.now() }, 200, origin);
    }
    if (path === '/config' && request.method === 'GET') {
      return handleConfig(env, origin);
    }
    if (path === '/kb' && request.method === 'GET') {
      return handleKb(url, origin);
    }
    if (path === '/generate' && request.method === 'POST') {
      return handleGenerate(request, env, origin);
    }
    if (path === '/verify' && request.method === 'POST') {
      return handleVerify(request, env, origin);
    }

    // M1 端到端物料包 pipeline：品类识别→抠图→8图+文案一键生成（会员门禁）
    if (path === '/pipeline' && request.method === 'POST') {
      try {
        return await handlePipeline(request, env, origin, ctx);
      } catch (e) {
        return json({ ok: false, error: { code: 'pipeline_crash', message: String((e && e.message) || e) } }, 500, origin);
      }
    }

    // 质检异步补算结果轮询（M2.2）：GET /qc-result?id=qc:<pipelineId>
    if (path === '/qc-result' && request.method === 'GET') {
      const qid = url.searchParams.get('id') || '';
      if (!qid || !env.MEMBERS) return json({ ok: false, error: { code: 'bad_param', message: '缺少 id' } }, 400, origin);
      const rec = await env.MEMBERS.get('qc:' + qid, 'json');
      if (!rec) return json({ ok: true, pending: true, scores: null }, 200, origin);
      return json({ ok: true, pending: false, ...rec }, 200, origin);
    }

    // 上传实拍图智能质检（vision 判定遮挡/完整度/构图）
    if (path === '/qc' && request.method === 'POST') {
      return handleQc(request, env, origin);
    }

    // 多平台文案生成（豆包文本模型 + 广告法双审）
    if (path === '/copy' && request.method === 'POST') {
      return handleCopy(request, env, origin);
    }
    if (path === '/facts-prefill' && request.method === 'POST') {
      return handleFactsPrefill(request, env, origin);
    }

    // 商品智能识别（传图后自动抓取品牌/型号/颜色等预填）
    if (path === '/identify' && request.method === 'POST') {
      return handleIdentify(request, env, origin);
    }

    // 多图自动分组（识别同一商品多角度 / 不同商品，决定合并出图还是逐张出图）
    if (path === '/group' && request.method === 'POST') {
      return handleGroup(request, env, origin);
    }

    if (path === '/details-plan' && request.method === 'POST') {
      return handleDetailsPlan(request, env, origin);
    }
    if (path === '/vision-json' && request.method === 'POST') {
      return handleVisionJson(request, env, origin);
    }
    if (path === '/scene-background' && request.method === 'POST') {
      return handleSceneBackground(request, env, origin);
    }
    if (path === '/cutout' && request.method === 'POST') {
      return handleCutout(request, env, origin);
    }
    if (path === '/superres' && request.method === 'POST') {
      return handleSuperRes(request, env, origin);
    }
    if (path === '/privacy-detect' && request.method === 'POST') {
      return handlePrivacyDetect(request, env, origin);
    }
    // 商品视觉特征提取（多角度→可还原特征文本；性能实测 / 复用）
    if (path === '/feature' && request.method === 'POST') {
      return handleFeature(request, env, origin);
    }

    // 阿视 · 视频分镜（P0 图文成片，会员门禁防滥用）
    if (path === '/storyboard' && request.method === 'POST') {
      return handleStoryboard(request, env, origin);
    }

    // 自由输入意图路由（中央对话框统一入口）
    if (path === '/api/understand' && request.method === 'POST') {
      return handleUnderstand(request, env, origin);
    }

    // 工作台任务历史（按会员隔离，KV 持久化，跨设备同步）
    if (path === '/api/tasks' || path.startsWith('/api/tasks/')) {
      return handleTasks(request, env, origin);
    }

    // 会员工作台状态云端备份（作品元数据 / 知识库 / 发布 / 连接 / 资料，跨设备恢复）
    if (path === '/api/state' && (request.method === 'GET' || request.method === 'POST' || request.method === 'PUT')) {
      return handleState(request, env, origin);
    }

    // TOS 对象存储预签名（原图/成品/视频跨端同步，浏览器直传直读）
    if (path === '/api/import-url' && request.method === 'GET') {
      return handleImportUrl(url, origin);
    }

    if (path === '/api/storage' && request.method === 'POST') {
      return handleStorage(request, env, origin);
    }

    // 「Hogee 上新」官方素材墙：GET 公开全员可见；上传/删除仅 workhogee 管理员
    if (path === '/api/feed' || path.startsWith('/api/feed/')) {
      return handleFeed(request, env, origin);
    }

    // 会员自助注册 / 登录（鉴权在 member-api.js 内部完成，register/login 公开）
    if (path === '/api/member' || path.startsWith('/api/member/')) {
      return handleMember(request, env, origin);
    }

    // 管理后台（鉴权在 admin.js 内部完成，仅 /api/admin/login 公开）
    if (path === '/api/admin' || path.startsWith('/api/admin/')) {
      return handleAdmin(request, env, origin);
    }

    // 效果中心：H5 画册 / 渠道短链 / 埋点 / 留资 / 渠道码 / 看板（公开+会员，鉴权在 analytics.js 内）
    const analyticsResp = await handleAnalytics(request, env, ctx, origin);
    if (analyticsResp) return analyticsResp;

    return json({ ok: false, error: { code: 'not_found', message: '接口不存在' } }, 404, origin);
  },

  // 每小时 rollup：把边缘增量分片 inc:* 汇总进 day:* 日汇总
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduledRollup(env));
  }
};
