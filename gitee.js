/* =====================================================================
 * WorkHogee · Gitee AI（模力方舟）Serverless API 服务端封装（可复用）
 * ---------------------------------------------------------------------
 * 一个 GITEE_API_KEY 覆盖：
 *   - 抠图 RMBG-2.0（BiRefNet）：POST /v1/images/mattings，0.01 元/次
 *   - 超分 Real-ESRGAN、场景 Qwen-Image-Edit-2511（同平台，后续接入）
 *
 * 实测边界：
 *   - 简单/干净背景：辐条实心连续、文字零变形，通过 A 级。
 *   - 复杂背景（树林+光斑穿透轮圈）：细辐条 alpha 丢失，应由上层质检
 *     拒绝白底、引导纯色墙重拍或走场景图，不要硬交付。
 *
 * 需要 env：GITEE_API_KEY。仅依赖 Web 标准 fetch / FormData / Blob / atob / btoa。
 * ===================================================================*/

const BASE = 'https://ai.gitee.com';

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

async function decodeImageItem(d) {
  if (d && d.b64_json) return Uint8Array.from(atob(d.b64_json), (c) => c.charCodeAt(0));
  if (d && d.url) {
    const r = await fetch(d.url);
    return new Uint8Array(await r.arrayBuffer());
  }
  return null;
}

/**
 * Gitee 通用抠图（默认 RMBG-2.0）。
 * @param {object} env Worker env（含 GITEE_API_KEY）
 * @param {string} dataUrl 原图 dataURL
 * @param {object} [opts] { model?:string }
 * @returns {Promise<{ok:true,image:string,width:number,height:number,ms:number}|
 *                    {ok:false,error:{code:string,message?:string}}>}
 */
export async function giteeMatting(env, dataUrl, opts = {}) {
  const model = opts.model || 'RMBG-2.0';
  const t0 = Date.now();
  try {
    const info = dataUrlToBytes(dataUrl);
    if (!info) return { ok: false, error: { code: 'bad_dataurl', message: '图片 dataURL 不合法' } };
    const ext = /png$/i.test(info.mime) ? 'png' : 'jpg';
    const fd = new FormData();
    fd.append('model', model);
    fd.append('image', new Blob([info.bytes], { type: info.mime }), 'image.' + ext);
    const r = await fetch(BASE + '/v1/images/mattings', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.GITEE_API_KEY, 'X-Failover-Enabled': 'true' },
      body: fd,
      signal: AbortSignal.timeout(120000),
    });
    const txt = await r.text();
    if (r.status !== 200) return { ok: false, error: { code: 'gitee_http_' + r.status, message: txt.slice(0, 300) } };
    let j;
    try { j = JSON.parse(txt); } catch { return { ok: false, error: { code: 'gitee_bad_json', message: txt.slice(0, 200) } }; }
    const item = (j.data && j.data[0]) || null;
    const out = await decodeImageItem(item);
    if (!out) return { ok: false, error: { code: 'gitee_no_image', message: txt.slice(0, 200) } };
    const size = pngSize(out);
    return { ok: true, image: bytesToPngDataUrl(out), width: size.width, height: size.height, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: { code: 'gitee_exception', message: String(e && e.message || e) } };
  }
}
