/* =====================================================================
 * WorkHogee · 佐糖 PicWish（AOS Labs）商用抠图 API 封装（可复用）
 * ---------------------------------------------------------------------
 * 国内服务（techsz.aoscdn.com），支付宝充值，边缘质量优于 RMBG。
 * 同步模式（sync=1）直接返回透明 PNG base64。
 *
 * 需要 env：PICWISH_API_KEY
 *
 * 计费：0.5 算粒/张 ≈ ¥0.021/张；新用户注册送 50 算粒。
 * 文档：https://picwish.com/new-background-removal-api-doc
 * ===================================================================*/

const BASE = 'https://techsz.aoscdn.com';

function dataUrlToBytes(dataUrl) {
  const m = /^data:(image\/(?:jpe?g|png|webp));base64,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  return { bytes: Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)), mime: m[1] };
}

function bytesToPngDataUrl(u8) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return 'data:image/png;base64,' + btoa(bin);
}

function pngSize(bytes) {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  } catch { return { width: 0, height: 0 }; }
}

/**
 * PicWish 智能抠图（商品/物体）。
 * @param {object} env Worker env（含 PICWISH_API_KEY）
 * @param {string} dataUrl 原图 dataURL
 * @param {object} [opts] { type?: 'object'|'person'|'stamp' }
 * @returns {Promise<{ok:true,image:string,width:number,height:number,ms:number}|
 *                    {ok:false,error:{code:string,message?:string}}>}
 */
export async function picwishCutout(env, dataUrl, opts = {}) {
  const t0 = Date.now();
  const key = env.PICWISH_API_KEY;
  if (!key) {
    return { ok: false, error: { code: 'picwish_not_configured', message: 'PICWISH_API_KEY 未配置' } };
  }
  try {
    const info = dataUrlToBytes(dataUrl);
    if (!info) return { ok: false, error: { code: 'bad_dataurl', message: '图片 dataURL 不合法' } };
    const ext = /png$/i.test(info.mime) ? 'png' : 'jpg';
    const fd = new FormData();
    fd.append('sync', '1');
    fd.append('type', opts.type || 'object');
    fd.append('return_type', '2');   // base64
    fd.append('format', 'png');       // transparent
    fd.append('output_type', '2');   // image only
    fd.append('image_file', new Blob([info.bytes], { type: info.mime }), 'image.' + ext);
    const r = await fetch(BASE + '/api/tasks/visual/segmentation', {
      method: 'POST',
      headers: { 'X-API-KEY': key },
      body: fd,
      signal: AbortSignal.timeout(120000),
    });
    const txt = await r.text();
    if (r.status !== 200) {
      return { ok: false, error: { code: 'picwish_http_' + r.status, message: txt.slice(0, 300) } };
    }
    let j;
    try { j = JSON.parse(txt); }
    catch { return { ok: false, error: { code: 'picwish_bad_json', message: txt.slice(0, 200) } }; }
    if (j.status !== 200 || !j.data || j.data.state !== 1) {
      return { ok: false, error: { code: 'picwish_task_failed', message: 'state=' + (j.data && j.data.state) + ' msg=' + (j.message || '').slice(0, 200) } };
    }
    const b64 = j.data.image;
    if (!b64) return { ok: false, error: { code: 'picwish_no_image', message: txt.slice(0, 200) } };
    const out = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const size = pngSize(out);
    return {
      ok: true,
      image: bytesToPngDataUrl(out),
      width: size.width, height: size.height,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, error: { code: 'picwish_exception', message: String(e && e.message || e) } };
  }
}

/**
 * M2.3：用公网图片 URL 调用 PicWish 抠图（Worker 不再中转原图字节）。
 * @param {object} env Worker env
 * @param {string} imageUrl 公网可访问的图片 URL（如 TOS 预签名 GET）
 * @param {object} [opts] { type?: 'object'|'person'|'stamp' }
 * @returns {Promise<{ok:true,image:string,width:number,height:number,ms:number}|
 *                    {ok:false,error:{code,message?}}>}
 *   image 为 data:image/png;base64,...（调用方应立即转存 TOS 并释放该字符串）。
 */
export async function picwishCutoutByUrl(env, imageUrl, opts = {}) {
  const t0 = Date.now();
  const key = env.PICWISH_API_KEY;
  if (!key) {
    return { ok: false, error: { code: 'picwish_not_configured', message: 'PICWISH_API_KEY 未配置' } };
  }
  if (typeof imageUrl !== 'string' || !/^https?:\/\//.test(imageUrl)) {
    return { ok: false, error: { code: 'bad_image_url', message: 'imageUrl 必须是 http(s) 公网 URL' } };
  }
  try {
    const fd = new FormData();
    fd.append('sync', '1');
    fd.append('type', opts.type || 'object');
    fd.append('return_type', '2');   // base64
    fd.append('format', 'png');       // transparent
    fd.append('output_type', '2');   // image only
    fd.append('image_url', imageUrl);
    const r = await fetch(BASE + '/api/tasks/visual/segmentation', {
      method: 'POST',
      headers: { 'X-API-KEY': key },
      body: fd,
      signal: AbortSignal.timeout(120000),
    });
    const txt = await r.text();
    if (r.status !== 200) {
      return { ok: false, error: { code: 'picwish_http_' + r.status, message: txt.slice(0, 300) } };
    }
    let j;
    try { j = JSON.parse(txt); }
    catch { return { ok: false, error: { code: 'picwish_bad_json', message: txt.slice(0, 200) } }; }
    if (j.status !== 200 || !j.data || j.data.state !== 1) {
      return { ok: false, error: { code: 'picwish_task_failed', message: 'state=' + (j.data && j.data.state) + ' msg=' + (j.message || '').slice(0, 200) } };
    }
    const b64 = j.data.image;
    if (!b64) return { ok: false, error: { code: 'picwish_no_image', message: txt.slice(0, 200) } };
    const out = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const size = pngSize(out);
    return {
      ok: true,
      image: bytesToPngDataUrl(out),
      width: size.width, height: size.height,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, error: { code: 'picwish_exception', message: String(e && e.message || e) } };
  }
}
