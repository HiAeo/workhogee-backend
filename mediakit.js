/* =====================================================================
 * WorkHogee · 火山 AI MediaKit 抠图（原分辨率输出）· 服务端封装（可复用）
 * ---------------------------------------------------------------------
 * MediaKit 只接受公网 HTTP/HTTPS URL（不支持 base64）。本模块在 Worker 侧：
 *   前端 dataUrl -> 服务端上传 TOS 公共临时对象 -> 预签名 GET 供火山拉取
 *   -> 调 remove-image-background -> 下载原分辨率透明 PNG -> dataUrl 返回。
 *
 * 实测边界（背景复杂度决定）：
 *   - 简单背景（纯色墙/简单室内）：辐条几何 ~96% 保留、约 1.4s，可用。
 *   - 复杂背景（树林/护栏）：细结构几何损坏，应由上层在调用前直接拒绝、引导重拍。
 *
 * 需要 env：MK_API_KEY、TOS_ACCESS_KEY_ID、TOS_SECRET_ACCESS_KEY。
 * 仅依赖 Web Crypto 与全局 fetch / atob / btoa，Cloudflare Worker 可运行。
 * ===================================================================*/

import { presignPut, presignGet } from './tos.js';

const MK_ENDPOINT = 'https://mediakit.cn-beijing.volces.com/api/v1/tools-sync/remove-image-background';
const TMP_PREFIX = 'feed/mk-tmp/';

function dataUrlToBytes(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  return { bytes: Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)), mime: m[1] };
}

function bytesToPngDataUrl(u8) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return 'data:image/png;base64,' + btoa(bin);
}

async function stageToTos(env, dataUrl, key) {
  const info = dataUrlToBytes(dataUrl);
  if (!info) throw new Error('bad dataUrl');
  const cfg = {
    accessKeyId: env.TOS_ACCESS_KEY_ID,
    secretAccessKey: env.TOS_SECRET_ACCESS_KEY,
    region: 'cn-beijing',
    bucket: 'workhogee-assets',
    key,
    expiresSec: 3600,
  };
  const put = await presignPut(cfg);
  const pr = await fetch(put.url, { method: 'PUT', body: info.bytes, headers: { 'Content-Type': info.mime } });
  if (pr.status !== 200) throw new Error('tos put ' + pr.status + ' ' + (await pr.text()).slice(0, 200));
  const get = await presignGet(cfg);
  return get.url;
}

/**
 * MediaKit 抠图。
 * @param {object} env Worker env（含 MK_API_KEY / TOS_*）
 * @param {string} dataUrl 原图 dataURL（建议原分辨率）
 * @param {object} [opts] { scene?: 'product'|'general'|'human' }
 * @returns {Promise<{ok:true,image:string,width:number,height:number,ms:number}|
 *                    {ok:false,error:{code:string,message?:string}}>}
 */
export async function mediakitCutout(env, dataUrl, opts = {}) {
  try {
    const key = TMP_PREFIX + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.jpg';
    const imageUrl = await stageToTos(env, dataUrl, key);
    const body = {
      image_url: imageUrl,
      scene: opts.scene || 'product',
      need_crop_background: false,
      output_format: 'png',
    };
    const t0 = Date.now();
    const r = await fetch(MK_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.MK_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const txt = await r.text();
    if (r.status !== 200) return { ok: false, error: { code: 'mk_http_' + r.status, message: txt.slice(0, 300) } };
    let j;
    try { j = JSON.parse(txt); } catch { return { ok: false, error: { code: 'mk_bad_json', message: txt.slice(0, 200) } }; }
    if (!j.result || !j.result.image_url) return { ok: false, error: { code: 'mk_no_result', message: txt.slice(0, 300) } };
    const ir = await fetch(j.result.image_url);
    const ab = await ir.arrayBuffer();
    return {
      ok: true,
      image: bytesToPngDataUrl(new Uint8Array(ab)),
      width: j.result.image_width,
      height: j.result.image_height,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, error: { code: 'mk_exception', message: String(e && e.message || e) } };
  }
}

const MK_FACE_BLUR = 'https://mediakit.cn-beijing.volces.com/api/v1/tools-sync/face-blur-image';

/**
 * 人脸检测：调 face-blur-image，只取检测框（打码由前端统一处理）。
 * @returns {Promise<{ok:true,boxes:Array}|{ok:false,error}>}
 */
export async function mediakitFaceDetect(env, dataUrl) {
  try {
    const key = TMP_PREFIX + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.jpg';
    const imageUrl = await stageToTos(env, dataUrl, key);
    const r = await fetch(MK_FACE_BLUR, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.MK_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: imageUrl, face_detect_thresh: 0.7, output_format: 'jpeg' }),
    });
    const txt = await r.text();
    if (r.status !== 200) return { ok: false, error: { code: 'mkf_http_' + r.status, message: txt.slice(0, 200) } };
    let j;
    try { j = JSON.parse(txt); } catch { return { ok: false, error: { code: 'mkf_json', message: txt.slice(0, 200) } }; }
    if (!j.success || !j.result) {
      return { ok: false, error: { code: (j.error && j.error.code) || 'mkf_fail', message: (j.error && j.error.message) || txt.slice(0, 200) } };
    }
    const locs = j.result.face_location || [];
    const boxes = locs.map(f => ({
      x1: Math.round(f.top_left_x), y1: Math.round(f.top_left_y),
      x2: Math.round(f.bottom_right_x), y2: Math.round(f.bottom_right_y), score: f.confidence
    }));
    return { ok: true, boxes };
  } catch (e) {
    return { ok: false, error: { code: 'mkf_exception', message: String(e && e.message || e) } };
  }
}
