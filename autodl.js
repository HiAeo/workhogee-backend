/* =====================================================================
 * WorkHogee · AutoDL 自部署 BiRefNet（分块原生分辨率）抠图服务封装（可复用）
 * ---------------------------------------------------------------------
 * 调用 AutoDL 实例上的 Flask 服务（6006，经 seetacloud 8443 网关）：
 *   - 分块（tiled）原生分辨率推理，复杂背景细结构（辐条/琴弦/文字）完整。
 *   - 共享密钥鉴权（X-Service-Key），防止公网被盗刷。
 *
 * 需要 env：
 *   AUTODL_CUTOUT_URL   例如 https://u<uid>-....bjb1.seetacloud.com:8443
 *   AUTODL_SERVICE_KEY  Flask 启动时的 SERVICE_KEY
 *
 * 仅依赖 Web 标准 fetch。返回 cutout(PNG) / white(JPEG) / mask(PNG)。
 * ===================================================================*/

/**
 * AutoDL 分块保真抠图。
 * @param {object} env Worker env（含 AUTODL_CUTOUT_URL / AUTODL_SERVICE_KEY）
 * @param {string} dataUrl 原图 dataURL
 * @returns {Promise<{ok:true,image:string,white:string,mask:string,width:number,height:number,ms:number}|
 *                    {ok:false,error:{code:string,message?:string}}>}
 */
export async function autodlCutout(env, dataUrl) {
  const t0 = Date.now();
  const base = env.AUTODL_CUTOUT_URL;
  if (!base || !env.AUTODL_SERVICE_KEY) {
    return { ok: false, error: { code: 'autodl_not_configured', message: '抠图服务未配置' } };
  }
  try {
    const r = await fetch(base.replace(/\/$/, '') + '/cutout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': env.AUTODL_SERVICE_KEY },
      body: JSON.stringify({ image: dataUrl }),
      signal: AbortSignal.timeout(180000),
    });
    const txt = await r.text();
    if (r.status !== 200) {
      return { ok: false, error: { code: 'autodl_http_' + r.status, message: txt.slice(0, 300) } };
    }
    let j;
    try { j = JSON.parse(txt); }
    catch { return { ok: false, error: { code: 'autodl_bad_json', message: txt.slice(0, 200) } }; }
    const size = Array.isArray(j.size) ? j.size : [0, 0];
    return {
      ok: true,
      image: 'data:image/png;base64,' + j.cutout,
      white: 'data:image/jpeg;base64,' + j.white,
      mask: 'data:image/png;base64,' + j.mask,
      width: size[0], height: size[1], ms: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, error: { code: 'autodl_exception', message: String((e && e.message) || e) } };
  }
}

/**
 * AutoDL Real-ESRGAN 超分辨率（可复用）。
 * @param {object} env Worker env（AUTODL_CUTOUT_URL / AUTODL_SERVICE_KEY）
 * @param {string} dataUrl 输入图 dataURL（部件 crop / 内饰 / 空间）
 * @param {number} scale 放大倍数（默认 4）
 * @returns {Promise<{ok:true,image:string,width:number,height:number,ms:number}|{ok:false,error:object}>}
 */
export async function autodlSuperRes(env, dataUrl, scale = 4) {
  const t0 = Date.now();
  const base = env.AUTODL_CUTOUT_URL;
  if (!base || !env.AUTODL_SERVICE_KEY) {
    return { ok: false, error: { code: 'autodl_not_configured', message: '超分服务未配置' } };
  }
  try {
    const r = await fetch(base.replace(/\/$/, '') + '/superres', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': env.AUTODL_SERVICE_KEY },
      body: JSON.stringify({ image: dataUrl, scale }),
      signal: AbortSignal.timeout(180000),
    });
    const txt = await r.text();
    if (r.status !== 200) {
      return { ok: false, error: { code: 'autodl_http_' + r.status, message: txt.slice(0, 300) } };
    }
    let j;
    try { j = JSON.parse(txt); }
    catch { return { ok: false, error: { code: 'autodl_bad_json', message: txt.slice(0, 200) } }; }
    const size = Array.isArray(j.size) ? j.size : [0, 0];
    return {
      ok: true,
      image: 'data:image/jpeg;base64,' + j.superres,
      width: size[0], height: size[1], ms: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, error: { code: 'autodl_exception', message: String((e && e.message) || e) } };
  }
}
