/* =====================================================================
 * WorkHogee · 火山引擎 TOS 对象存储 · TOS4-HMAC-SHA256 预签名
 * ---------------------------------------------------------------------
 * 仅在 Worker 服务端用 IAM AccessKey 计算预签名 URL；AK/SK 永不落地浏览器。
 * 图片字节由浏览器与 TOS 之间直传 / 直读（PUT / GET），Worker 不中转字节、
 * 不占跨境带宽，签名计算本身不传输任何数据。
 *
 * 签名依据火山 TOS 官方《预签名 URL 文档》的 TOS4-HMAC-SHA256 方案：
 *   - 虚拟主机风格 host：{bucket}.tos-{region}.volces.com
 *   - 仅 V4 签名；X-Tos-* 查询参数；payload 用 UNSIGNED-PAYLOAD
 *   - SigningKey = HMAC(HMAC(HMAC(HMAC(SK, date), region), "tos"), "request")
 *
 * 仅依赖 Web Crypto（crypto.subtle），Cloudflare Worker 与 Node 18+ 均可运行，
 * 因此同一份代码可用官方 worked example 在本地做确定性自测。
 * ===================================================================*/

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

async function sha256Hex(str) {
  return hex(await crypto.subtle.digest('SHA-256', enc(str)));
}

/** RFC 3986 编码；encodeSlash=false 时保留路径里的 "/"。 */
function uriEncode(str, encodeSlash = true) {
  let s = encodeURIComponent(str);
  s = s.replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  if (!encodeSlash) s = s.replace(/%2F/gi, '/');
  return s;
}

export function toAmzDate(d) {
  const p = n => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) +
    'T' +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    p(d.getUTCSeconds()) +
    'Z'
  );
}

async function buildSigningKey(secret, dateShort, region) {
  let k = await hmacBytes(enc(secret), dateShort);
  k = await hmacBytes(k, region);
  k = await hmacBytes(k, 'tos');
  k = await hmacBytes(k, 'request');
  return k;
}

/**
 * 生成预签名 URL。
 * @param {object} o
 * @param {string} o.accessKeyId      IAM AccessKey ID
 * @param {string} o.secretAccessKey  IAM Secret AccessKey
 * @param {string} o.region          如 cn-beijing
 * @param {string} o.bucket          桶名
 * @param {string} [o.endpoint]      TOS 外网主机后缀，默认 tos-cn-beijing.volces.com
 * @param {string} [o.method]        GET / PUT，默认 GET
 * @param {string} [o.key]           对象 key
 * @param {number} [o.expiresSec]    有效期秒，默认 3600（TOS 上限 2592000=30天）
 * @param {Date}   [o.date]         注入签名时刻（自测用），默认 now
 * @returns {Promise<{url:string,method:string,host:string,key:string,expiresSec:number,
 *           canonicalRequest:string,stringToSign:string,signature:string}>}
 */
export async function presign(o) {
  const {
    accessKeyId,
    secretAccessKey,
    region = 'cn-beijing',
    bucket,
    endpoint = 'tos-cn-beijing.volces.com',
    method = 'GET',
    key = '',
    expiresSec = 3600,
    date = new Date()
  } = o;

  if (!accessKeyId || !secretAccessKey || !bucket) {
    throw new Error('presign: accessKeyId/secretAccessKey/bucket 必填');
  }
  const expires = Math.min(Math.max(1, Number(expiresSec) || 3600), 2592000);

  const iso = toAmzDate(date);
  const short = iso.slice(0, 8);
  const scope = `${short}/${region}/tos/request`;
  const host = `${bucket}.${endpoint}`;
  // 对象路径：逐段编码但保留 "/"
  const canonicalUri = '/' + String(key).split('/').map(seg => uriEncode(seg, true)).join('/');

  const query = {
    'X-Tos-Algorithm': 'TOS4-HMAC-SHA256',
    'X-Tos-Credential': `${accessKeyId}/${scope}`,
    'X-Tos-Date': iso,
    'X-Tos-Expires': String(expires),
    'X-Tos-SignedHeaders': 'host'
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map(k => `${uriEncode(k, true)}=${uriEncode(query[k], true)}`)
    .join('&');

  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = 'host';
  const payloadHash = 'UNSIGNED-PAYLOAD';

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const canonicalHash = await sha256Hex(canonicalRequest);
  const stringToSign = ['TOS4-HMAC-SHA256', iso, scope, canonicalHash].join('\n');

  const signingKey = await buildSigningKey(secretAccessKey, short, region);
  const signature = hex(await crypto.subtle.sign(
    'HMAC',
    await crypto.subtle.importKey('raw', signingKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    enc(stringToSign)
  ));

  const url = `https://${host}${canonicalUri}?${canonicalQuery}&X-Tos-Signature=${signature}`;
  return {
    url,
    method: method.toUpperCase(),
    host,
    key: String(key),
    expiresSec: expires,
    canonicalRequest,
    stringToSign,
    signature
  };
}

/** 便捷封装：上传（浏览器 PUT 直传）。 */
export function presignPut(o) {
  return presign({ ...o, method: 'PUT' });
}
/** 便捷封装：下载 / 读取（浏览器 GET 直读）。 */
export function presignGet(o) {
  return presign({ ...o, method: 'GET' });
}

/* =====================================================================
 * M2.3 薄 Worker 封装：服务端用 IAM 凭证经预签名 URL 直接读写 TOS。
 * 这些函数只在 Worker 内部用，外部拿到的永远是 object key 或预签名 URL。
 * ===================================================================*/

/**
 * 服务端把 buffer 上传到指定 key。
 * 实现：生成短时 PUT 预签名，再 fetch PUT 过去（不在 Worker 内长期持有签名/字节）。
 * @param {object} cfg tosConfig(env) 的产物
 * @param {string} key 对象 key
 * @param {ArrayBuffer|Uint8Array|Buffer} bytes
 * @param {string} contentType 如 image/png
 */
export async function tosPut(cfg, key, bytes, contentType = 'image/jpeg') {
  if (!cfg || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.bucket) {
    throw new Error('tos_put: TOS 未配置');
  }
  const put = await presignPut({ ...cfg, key, expiresSec: 600 });
  const r = await fetch(put.url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: bytes
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('tos_put_http_' + r.status + ' ' + t.slice(0, 200));
  }
  return { key, version: r.headers.get('x-tos-version-id') || null };
}

/** 生成一个有公网有效期的 GET 预签名 URL（供 PicWish / 视觉模型 / 浏览器读取）。 */
export async function tosGetUrl(cfg, key, expiresSec = 3600) {
  if (!cfg || !cfg.bucket) throw new Error('tos_get_url: TOS 未配置');
  const g = await presignGet({ ...cfg, key, expiresSec });
  return g.url;
}

/** HEAD 检查对象是否存在（可选，失败返回 false 不抛）。 */
export async function tosHead(cfg, key) {
  try {
    const g = await presignGet({ ...cfg, key, expiresSec: 60 });
    const r = await fetch(g.url, { method: 'HEAD' });
    return r.ok;
  } catch {
    return false;
  }
}
