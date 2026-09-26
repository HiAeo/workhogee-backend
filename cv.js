/* =====================================================================
 * WorkHogee · 火山引擎智能视觉 CV 客户端（保真链路）
 * ---------------------------------------------------------------------
 * 用于"保真类"图像处理：抠图 / 白底（通用图像分割 entity_seg）、
 * 局部放大（图片超分 lens_nnsr2_pic_common）。这些处理在火山侧是
 * 像素级算法，**不重画产品**，因此车身字母 / 型号 / Logo 零变形。
 *
 * 仅在 Worker 服务端运行：用 IAM AccessKey 做火山签名 V4（HMAC-SHA256），
 * AK/SK 永不落地浏览器。只依赖 Web Crypto，Cloudflare Worker / Node18+ 均可。
 *
 * 接口形态（火山视觉 OpenAPI）：
 *   host   visual.volcengineapi.com
 *   region cn-north-1   service cv
 *   通用处理  Action=CVProcess   Version=2022-08-31  (body JSON, req_key 区分能力)
 *   老版商品分割 Action=GoodsSegment Version=2020-08-26 (body form) —— 备用，
 *   主链路统一用能力更强的 entity_seg 取最大主体。
 * ===================================================================*/

const CV_HOST = 'visual.volcengineapi.com';
const CV_REGION = 'cn-north-1';
const CV_SERVICE = 'cv';
const VERSION_PROCESS = '2022-08-31';
const VERSION_GOODS = '2020-08-26';

const enc = (s) => new TextEncoder().encode(s);

function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacBytes(keyBytes, msg) {
  const k = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc(msg)));
}

async function sha256Bytes(buf) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
}
async function sha256HexStr(str) {
  return hex(await crypto.subtle.digest('SHA-256', enc(str)));
}
async function sha256HexBytes(buf) {
  return hex(await crypto.subtle.digest('SHA-256', buf));
}

/** RFC3986 编码（火山签名要求，空格为 %20）。 */
function uriEncode(str) {
  let s = encodeURIComponent(String(str));
  return s.replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function toAmzDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    'T' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z'
  );
}

/** SigningKey = HMAC(HMAC(HMAC(HMAC(SK, date), region), service), "request") */
async function buildSigningKey(secret, short, region, service) {
  let k = await hmacBytes(enc(secret), short);
  k = await hmacBytes(k, region);
  k = await hmacBytes(k, service);
  k = await hmacBytes(k, 'request');
  return k;
}

/** 从 dataURL 取出纯 base64 与 mime。 */
function splitDataUrl(dataUrl) {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(String(dataUrl || '').replace(/\s/g, ''));
  if (!m) throw new Error('bad_data_url');
  return { mime: m[1], b64: m[2] };
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/**
 * 火山签名 V4 并发起 POST，返回解析后的 JSON。
 * @param {object} o
 * @param {string} o.ak AccessKey ID
 * @param {string} o.sk Secret AccessKey
 * @param {string} o.action 如 CVProcess
 * @param {string} o.version 如 2022-08-31
 * @param {Uint8Array} o.bodyBytes 请求体字节
 * @param {string} o.contentType
 * @param {object} [o.extraQuery] 额外 query
 * @param {number} [o.timeoutMs] 默认 45s
 */
async function signedPost(o) {
  const {
    ak, sk, action, version, bodyBytes, contentType,
    host = CV_HOST, region = CV_REGION, service = CV_SERVICE,
    extraQuery = null, timeoutMs = 45000
  } = o;
  if (!ak || !sk) throw new Error('cv: access key 未配置');

  const now = new Date();
  const iso = toAmzDate(now);
  const short = iso.slice(0, 8);
  const payloadHash = await sha256HexBytes(bodyBytes);

  const query = Object.assign({ Action: action, Version: version }, extraQuery || {});
  const canonicalQuery = Object.keys(query).sort()
    .map(k => uriEncode(k) + '=' + uriEncode(query[k])
    ).join('&');

  // 参与签名的 header（名小写，按名排序）
  const headerMap = {
    host,
    'content-type': contentType,
    'x-content-sha256': payloadHash,
    'x-date': iso
  };
  const names = Object.keys(headerMap).sort();
  const canonicalHeaders = names.map(n => `${n}:${String(headerMap[n]).trim()}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    'POST', '/', canonicalQuery, canonicalHeaders, signedHeaders, payloadHash
  ].join('\n');

  const scope = `${short}/${region}/${service}/request`;
  const stringToSign = [
    'HMAC-SHA256', iso, scope, await sha256HexStr(canonicalRequest)
  ].join('\n');

  const signingKey = await buildSigningKey(sk, short, region, service);
  const signature = hex(await hmacBytes(signingKey, stringToSign));
  const authorization =
    `HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, timeoutMs);
  let resp, text;
  try {
    resp = await fetch(`https://${host}/?${canonicalQuery}`, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'X-Date': iso,
        'X-Content-Sha256': payloadHash,
        'Authorization': authorization
      },
      body: bodyBytes,
      signal: ctrl.signal
    });
    text = await resp.text();
  } catch (e) {
    clearTimeout(timer);
    const aborted = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    return { ok: false, status: 502, error: {
      code: aborted ? 'cv_timeout' : 'cv_network',
      message: aborted ? '视觉服务响应超时，请重试' : '视觉服务网络异常，请重试'
    } };
  }
  clearTimeout(timer);

  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  if (!parsed) {
    return { ok: false, status: 502, error: { code: 'cv_bad_json', message: text.slice(0, 200) } };
  }
  return { ok: true, httpStatus: resp.status, parsed };
}

/** 解析火山 OpenAPI 返回：成功取 data，失败归一化错误。 */
function unwrapCv(parsed) {
  // 形态一：{ code/status:10000, data }
  const okCode = parsed.code === 10000 || parsed.status === 10000;
  if (okCode && parsed.data) return { ok: true, data: parsed.data };
  // 形态二：{ ResponseMetadata:{ Error }, Result }
  const rm = parsed.ResponseMetadata;
  if (rm && rm.Error) {
    return { ok: false, error: {
      code: rm.Error.Code || 'cv_error',
      message: rm.Error.Message || '视觉服务返回错误',
      requestId: rm.RequestId
    } };
  }
  if (parsed.Result || parsed.data) return { ok: true, data: parsed.Result || parsed.data };
  return { ok: false, error: {
    code: (parsed.code && String(parsed.code)) || 'cv_error',
    message: parsed.message || parsed.Message || '视觉服务返回未知错误'
  } };
}

/** 调用 CVProcess（JSON body），返回 { ok, data, error }。 */
async function callProcess(env, reqKey, payload) {
  const ak = env.TOS_ACCESS_KEY_ID;
  const sk = env.TOS_SECRET_ACCESS_KEY;
  const body = Object.assign({ req_key: reqKey }, payload);
  const bodyBytes = enc(JSON.stringify(body));
  const r = await signedPost({
    ak, sk, action: 'CVProcess', version: VERSION_PROCESS,
    bodyBytes, contentType: 'application/json', timeoutMs: 50000
  });
  if (!r.ok) return r;
  return unwrapCv(r.parsed);
}

/**
 * 通用图像分割 entity_seg（智能分割）。
 * 默认 return_format=4：返回【最大主体透明前景图 + 最大主体 mask】，用于保真白底抠图。
 * opts.allLayers=true 时 return_format=1：返回每个实体的 0~255 置信度 mask（多商品判定）。
 * 输入单图（总像素建议 <1000 万，超限由前端先缩）。
 * @returns {Promise<object>}
 */
export async function segmentEntities(env, dataUrl, opts = {}) {
  const { b64 } = splitDataUrl(dataUrl);
  const returnFormat = typeof opts.returnFormat === 'number' ? opts.returnFormat
    : opts.allLayers ? 1 : 4;
  const r = await callProcess(env, 'entity_seg', {
    binary_data_base64: [b64],
    return_format: returnFormat,
    max_entity: opts.maxEntity || 20,
    refine_mask: opts.refineMask !== false
  });
  if (!r.ok) return r;
  const d = r.data;
  const imgs = Array.isArray(d.binary_data_base64) ? d.binary_data_base64 : [];
  const firstNum = v => Array.isArray(v) ? v[0] : v;
  const entityNum = firstNum(d.entity_num);
  const width = firstNum(d.ori_width);
  const height = firstNum(d.ori_height);
  const toUrl = m => `data:image/png;base64,${String(m).replace(/\s/g, '')}`;

  if (returnFormat === 4) {
    // 文档约定顺序：[最大主体透明前景图, 最大主体 mask]
    return {
      ok: true,
      entityNum: typeof entityNum === 'number' ? entityNum : imgs.length,
      width: width || null,
      height: height || null,
      imagesCount: imgs.length,
      foreground: imgs[0] ? toUrl(imgs[0]) : null,
      mask: imgs[1] ? toUrl(imgs[1]) : null
    };
  }
  // return_format=1：每个实体一张 0~255 置信度 mask
  return {
    ok: true,
    entityNum: typeof entityNum === 'number' ? entityNum : imgs.length,
    width: width || null,
    height: height || null,
    masks: imgs.map(toUrl)
  };
}

/**
 * 图片超分 lens_nnsr2_pic_common：固定 x2 保真放大，不重画。
 * 输入边长需在 [256,1024]（由前端裁剪/缩放保证）。
 * @returns {Promise<{ok, image:string, error?}>}
 */
export async function superResolve(env, dataUrl, opts = {}) {
  const { b64 } = splitDataUrl(dataUrl);
  const r = await callProcess(env, 'lens_nnsr2_pic_common', {
    binary_data_base64: [b64],
    model_quality: opts.quality || 'MQ',
    result_format: 0,
    jpg_quality: 95,
    return_url: false
  });
  if (!r.ok) return r;
  const d = r.data;
  let outB64 = null;
  if (Array.isArray(d.binary_data_base64) && d.binary_data_base64[0]) {
    outB64 = d.binary_data_base64[0];
  } else if (Array.isArray(d.image_urls) && d.image_urls[0]) {
    const dl = await fetch(d.image_urls[0]);
    outB64 = bytesToBase64(new Uint8Array(await dl.arrayBuffer()));
  }
  if (!outB64) return { ok: false, error: { code: 'cv_no_image', message: '超分未返回图片' } };
  return { ok: true, image: `data:image/png;base64,${outB64.replace(/\s/g, '')}` };
}

/**
 * 老版商品分割 GoodsSegment（备用，主链路用 entity_seg）。
 * @param {string} method product / human / general
 */
/**
 * 显著性主体分割 saliency_seg：模拟人眼注意力，取图中最显著区域（通常即商品主体）。
 * 对"商品接触地面、背景面积大"的场景图，比 entity_seg 取最大实体更鲁棒。
 * @returns {Promise<{ok, images:array, imagesCount:number, error?}>}
 */
export async function saliencySegment(env, dataUrl) {
  const { b64 } = splitDataUrl(dataUrl);
  const r = await callProcess(env, 'saliency_seg', { binary_data_base64: [b64] });
  if (!r.ok) return r;
  const d = r.data;
  const imgs = Array.isArray(d.binary_data_base64) ? d.binary_data_base64 : [];
  const toUrl = m => `data:image/png;base64,${String(m).replace(/\s/g, '')}`;
  return { ok: true, images: imgs.map(toUrl), imagesCount: imgs.length };
}

export async function goodsSegment(env, dataUrl, method = 'product') {
  const { b64 } = splitDataUrl(dataUrl);
  const form = new URLSearchParams({ image_base64: b64, method });
  const bodyBytes = enc(form.toString());
  const r = await signedPost({
    ak: env.TOS_ACCESS_KEY_ID, sk: env.TOS_SECRET_ACCESS_KEY,
    action: 'GoodsSegment', version: VERSION_GOODS,
    bodyBytes, contentType: 'application/x-www-form-urlencoded', timeoutMs: 45000
  });
  if (!r.ok) return r;
  const u = unwrapCv(r.parsed);
  if (!u.ok) return u;
  if (!u.data.img_url) return { ok: false, error: { code: 'cv_no_image', message: '商品分割未返回图片' } };
  const dl = await fetch(u.data.img_url);
  const b = new Uint8Array(await dl.arrayBuffer());
  return { ok: true, image: `data:image/png;base64,${bytesToBase64(b)}` };
}

/**
 * 车牌检测 CarPlateDetection（视觉智能，form body）。
 * 返回 { ok:true, boxes:[{x1,y1,x2,y2,score}] }（像素坐标）；无车牌时 boxes=[]。
 */
export async function carPlateDetection(env, dataUrl) {
  const { b64 } = splitDataUrl(dataUrl);
  const form = new URLSearchParams({ image_base64: b64 });
  const bodyBytes = enc(form.toString());
  const r = await signedPost({
    ak: env.TOS_ACCESS_KEY_ID, sk: env.TOS_SECRET_ACCESS_KEY,
    action: 'CarPlateDetection', version: VERSION_GOODS,
    bodyBytes, contentType: 'application/x-www-form-urlencoded', timeoutMs: 30000
  });
  if (!r.ok) return r;
  const u = unwrapCv(r.parsed);
  // 61801 = 输入图不含车牌，按空结果正常返回
  if (!u.ok) {
    if (String(u.error && u.error.code) === '61801') return { ok: true, boxes: [] };
    return u;
  }
  const boxes = (u.data.car_plate_box || []).map(a => ({
    x1: Math.round(a.min_x), y1: Math.round(a.min_y),
    x2: Math.round(a.max_x), y2: Math.round(a.max_y), score: a.score
  }));
  return { ok: true, boxes };
}
