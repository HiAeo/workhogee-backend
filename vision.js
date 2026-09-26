/* =====================================================================
 * WorkHogee · 火山方舟多模态视觉理解（豆包 Seed 2.1 turbo，原生多模态）服务端模块
 * ---------------------------------------------------------------------
 * 仅在 Worker 服务端调用，ARK_API_KEY 永不落地浏览器。用于两件事：
 *   1) 主体一致性后验 verifyConsistency：
 *      成品图只允许改背景 / 光影 / 构图 / 整洁度，绝不能改商品本体
 *      （颜色、车标品牌、外形款式、真实瑕疵）。
 *   2) 隐私检测 detectPrivacy（并入同一次调用）：
 *      成品中是否出现清晰车牌、可识别人脸、车架号 VIN，返回归一化 bbox。
 *
 * 设计原则：
 *   - 视觉服务是"质检 + 安全"增强，任何失败 / 未开通 / 超时都降级为
 *     { available:false }，由调用方决定放行，绝不阻断主生图链路。
 *   - 严格要求模型只输出 JSON，并做容错解析。
 * ===================================================================*/

const VISION_ENDPOINT_DEFAULT = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
// 视觉 + 文案统一用豆包 Seed 2.1 turbo（原生多模态，一个模型既能看图也能写文案，
// 支持结构化 JSON）。可用 VISION_MODEL / COPY_MODEL 环境变量覆盖为其它模型 ID 或 ep-xxxx。
// 旧的 doubao-seed-1-6 系列已于 2026-09-21 下线，不可再用。
const VISION_MODEL_DEFAULT = 'doubao-seed-2-1-turbo-260628';

// 隐私命中阈值：bbox 置信度高于该值才认为需要处理 / 提示。
export const PRIVACY_CONF_THRESHOLD = 0.6;
// 一致性通过线。
export const CONSISTENCY_PASS_SCORE = 80;

/**
 * 确定性 fetch 超时：AbortController + Promise.race 双保险。
 * 仅靠 AbortSignal.timeout 在个别运行时对"连接已建立但响应体不结束"的子请求中断不彻底，
 * 这里同时从外部竞态超时，保证视觉/文案请求在 ms 内要么返回、要么抛 upstream_timeout，
 * 绝不无限挂起（挂起会让 /generate 一直 await）。
 */
async function fetchWithTimeout(resource, init, ms) {
  const ctrl = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { ctrl.abort(); } catch {}
      reject(new Error('upstream_timeout'));
    }, ms);
  });
  try {
    return await Promise.race([
      fetch(resource, Object.assign({}, init, { signal: ctrl.signal })),
      timeout
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const SYSTEM_PROMPT = [
  '你是严格的电商商品图出图质检引擎，首发场景是二手车商品图，也适用于一切实物商品。',
  '规则：AI 成品图只允许改变背景、环境、光影、构图、整洁度与拍摄角度呈现，',
  '绝不能改变商品本体——包括主体颜色、品牌车标/LOGO、外形款式/型号结构，',
  '也绝不能抹除原图中真实存在的明显划痕、凹陷、破损、事故修复痕迹（这些必须保留）。',
  '同时检查成品是否泄露隐私：清晰可读的机动车牌照、可识别的人脸、车架号/VIN 钢印。',
  '你必须只输出一个 JSON 对象，不要输出 Markdown、不要输出代码块、不要任何解释文字。'
].join('\n');

function buildUserPrompt() {
  return [
    '下面依次给你 1~2 张「原始实拍图」和最后 1 张「AI 生成成品图」。请对照判断并只输出 JSON：',
    '{',
    '  "same_subject": true或false,   // 成品与实拍是否同一件商品/同一台车',
    '  "color_match": true或false,    // 主体颜色是否一致（无明显改色）',
    '  "brand_match": true或false,    // 品牌车标/LOGO 是否一致；图中无明显车标时给 true',
    '  "shape_match": true或false,    // 外形、款式、型号结构是否一致',
    '  "defect_removed": true或false, // 成品是否违规抹除了实拍中的明显划痕/凹陷/事故痕迹；true=被违规抹除',
    '  "score": 0到100的整数,          // 商品本体一致性综合分（背景美观度不计入）',
    '  "issues": ["不一致的具体点，没有则空数组"],',
    '  "privacy": {',
    '    "plates": [{"bbox":[x,y,w,h],"conf":0到1}], // 成品中清晰可读车牌；bbox 为相对图像宽高的 0~1 浮点，左上原点',
    '    "faces":  [{"bbox":[x,y,w,h],"conf":0到1}], // 可识别的真人正脸',
    '    "vins":   [{"bbox":[x,y,w,h],"conf":0到1}]  // 清晰可读的车架号/VIN 钢印',
    '  }',
    '}',
    '注意：只统计「成品图」里的隐私元素；虚焦、遮挡、不可读的不算；没有就给空数组。'
  ].join('\n');
}

/** 从模型回复里容错提取第一个完整 JSON 对象（去掉 ```json 包裹、前后废话）。 */
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const candidate = t.slice(start, end + 1);
  try { return JSON.parse(candidate); } catch { return null; }
}

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function normBoxes(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(b => b && Array.isArray(b.bbox) && b.bbox.length === 4)
    .map(b => {
      const [x, y, w, h] = b.bbox.map(v => {
        // 兼容模型给 0~1000 / 0~100 / 0~1 三种坐标习惯
        let n = Number(v);
        if (!Number.isFinite(n)) n = 0;
        if (n > 1.5) n = n / (n > 100 ? 1000 : 100);
        return clamp01(n);
      });
      return { bbox: [x, y, w, h], conf: clamp01(b.conf) };
    });
}

/** 调用一次视觉理解，返回解析后的 JSON；失败返回 { ok:false }。 */
export async function chatVisionJson(env, images, timeoutMs = 45000) {
  // 视觉模型允许使用独立 Key / 接入点（与图像生成解耦，可跨项目配置）；
  // 未单独配置 VISION_API_KEY 时回退到 ARK_API_KEY。
  const visionKey = env && (env.VISION_API_KEY || env.ARK_API_KEY);
  if (!env || !visionKey) return { ok: false, error: 'no_api_key' };
  const validImages = (images || []).filter(
    u => typeof u === 'string' && /^data:image\/(jpe?g|png|webp);base64,/.test(u)
  );
  if (validImages.length < 1) return { ok: false, error: 'no_image' };

  const content = validImages.map(u => ({
    type: 'image_url',
    image_url: { url: u, detail: 'auto' }
  }));
  content.push({ type: 'text', text: buildUserPrompt() });

  let resp;
  try {
    resp = await fetchWithTimeout(env.VISION_ENDPOINT || VISION_ENDPOINT_DEFAULT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + visionKey
      },
      body: JSON.stringify({
        model: env.VISION_MODEL || VISION_MODEL_DEFAULT,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content }
        ],
        temperature: 0.1,
        max_tokens: 1400,
        thinking: { type: 'disabled' }
      })
    }, timeoutMs);
  } catch (e) {
    return { ok: false, error: (e && e.message === 'upstream_timeout') ? 'vision_timeout' : 'vision_network' };
  }

  const text = await resp.text();
  if (!resp.ok) return { ok: false, error: 'vision_' + resp.status, detail: text.slice(0, 200) };

  let parsed;
  try { parsed = JSON.parse(text); } catch { return { ok: false, error: 'vision_bad_json' }; }
  const contentText = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message
    && parsed.choices[0].message.content;
  if (typeof contentText !== 'string') return { ok: false, error: 'vision_empty' };

  const data = extractJson(contentText);
  if (!data) return { ok: false, error: 'vision_unparseable' };
  return { ok: true, data };
}

/** 通用视觉理解（自定义 system/user prompt），返回解析后的 JSON；失败 {ok:false}。可复用。 */
export async function chatVisionCustom(env, { system = '', user = '', images = [], maxTokens = 1400, temperature = 0.2, timeoutMs = 45000 }) {
  const visionKey = env && (env.VISION_API_KEY || env.ARK_API_KEY);
  if (!env || !visionKey) return { ok: false, error: 'no_api_key' };
  const validImages = (images || []).filter(u => typeof u === 'string' && /^data:image\/(jpe?g|png|webp);base64,/.test(u));
  const content = validImages.map(u => ({ type: 'image_url', image_url: { url: u, detail: 'auto' } }));
  content.push({ type: 'text', text: user });
  let resp;
  try {
    resp = await fetchWithTimeout(env.VISION_ENDPOINT || VISION_ENDPOINT_DEFAULT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + visionKey },
      body: JSON.stringify({
        model: env.VISION_MODEL || VISION_MODEL_DEFAULT,
        messages: [
          { role: 'system', content: system || '你是严谨的视觉分析助手，只输出 JSON。' },
          { role: 'user', content }
        ],
        temperature, max_tokens: maxTokens, thinking: { type: 'disabled' }
      })
    }, timeoutMs);
  } catch (e) {
    return { ok: false, error: (e && e.message === 'upstream_timeout') ? 'vision_timeout' : 'vision_network' };
  }
  const text = await resp.text();
  if (!resp.ok) return { ok: false, error: 'vision_' + resp.status, detail: text.slice(0, 200) };
  let parsed; try { parsed = JSON.parse(text); } catch { return { ok: false, error: 'vision_bad_json' }; }
  const ct = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
  if (typeof ct !== 'string') return { ok: false, error: 'vision_empty' };
  const data = extractJson(ct);
  if (!data) return { ok: false, error: 'vision_unparseable' };
  return { ok: true, data };
}

/* ===== 车牌检测（方舟视觉模型方案）=====
 * 老接口 CarPlateDetection（文档 6425，2021）在当前智能视觉控制台已无开通入口，
 * 子用户即使有 CVFullAccess 仍返回 50400。改用 doubao-seed-2-1-turbo 视觉模型 +
 * 专门车牌检测 prompt（实测框紧贴车牌四角），输出归一化坐标后在此转像素，
 * 返回结构与原 carPlateDetection 完全一致：{ ok:true, boxes:[{x1,y1,x2,y2,score}] }。 */
function bytesFromDataUrl(dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
/** 纯函数：从 PNG / JPEG / WebP 字节解析 {width,height}，无法解析返回 null。可复用。 */
export function imageSizeOf(bytes) {
  if (!bytes || bytes.length < 16) return null;
  // PNG：宽高在 IHDR（固定偏移 16 / 20）
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return {
      width: ((bytes[16] << 24 | bytes[17] << 16 | bytes[18] << 8 | bytes[19]) >>> 0),
      height: ((bytes[20] << 24 | bytes[21] << 16 | bytes[22] << 8 | bytes[23]) >>> 0)
    };
  }
  // JPEG：扫描 marker，在 SOF0~SOF15（排除 C4/C8/CC）处读高/宽
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let o = 2;
    while (o + 8 < bytes.length) {
      if (bytes[o] !== 0xff) { o++; continue; }
      const marker = bytes[o + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { o += 2; continue; }
      const segLen = (bytes[o + 2] << 8) | bytes[o + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: (bytes[o + 5] << 8) | bytes[o + 6], width: (bytes[o + 7] << 8) | bytes[o + 8] };
      }
      if (!segLen || segLen < 2) break;
      o += 2 + segLen;
    }
  }
  // WebP：RIFF....WEBP，区分 VP8 / VP8L / VP8X
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    const fcc = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (fcc === 'VP8 ') {
      return { width: (bytes[26] | bytes[27] << 8) & 0x3fff, height: (bytes[28] | bytes[29] << 8) & 0x3fff };
    }
    if (fcc === 'VP8L') {
      const b0 = bytes[21], b1 = bytes[22], b2 = bytes[23], b3 = bytes[24];
      return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
    }
    if (fcc === 'VP8X') {
      return { width: 1 + (bytes[24] | bytes[25] << 8 | bytes[26] << 16), height: 1 + (bytes[27] | bytes[28] << 8 | bytes[29] << 16) };
    }
  }
  return null;
}
/** 车牌检测（方舟视觉模型），返回像素坐标 boxes，签名与 carPlateDetection 一致。 */
export async function detectPlatesByVision(env, dataUrl) {
  const size = imageSizeOf(bytesFromDataUrl(dataUrl));
  const user = ('你是车牌检测模型。只检测图中机动车悬挂的车牌（蓝底、绿底、黄底或白色号牌）。'
    + '对每块车牌输出紧贴其四角外缘的矩形框，坐标为0~999整数：x1,y1为左上角，x2,y2为右下角。'
    + '框必须完整包住整块车牌、紧贴边缘，不能只框文字部分，不能偏高或偏低。图中无车牌则返回空数组。'
    + '只输出JSON，不要解释：{"plates":[[x1,y1,x2,y2]]}');
  const r = await chatVisionCustom(env, {
    system: '你是车牌检测模型，只输出 JSON。', user, images: [dataUrl],
    maxTokens: 600, temperature: 0, timeoutMs: 45000
  });
  if (!r.ok) return r;
  if (!size) return { ok: false, error: 'no_image_size' };
  const raw = Array.isArray(r.data && r.data.plates) ? r.data.plates : [];
  const boxes = raw.map(p => ({
    x1: Math.round(p[0] / 999 * size.width), y1: Math.round(p[1] / 999 * size.height),
    x2: Math.round(p[2] / 999 * size.width), y2: Math.round(p[3] / 999 * size.height),
    score: p[4] || 1
  }));
  return { ok: true, boxes };
}

/**
 * 卖点局部规划：视觉模型从商品图选 3 个最值得放大的卖点局部，返回归一化 bbox + 标签。
 * 前端按 bbox 从原图裁剪 + 保真超分，产出 3 张「卖点局部放大图」（零重画、零变形）。
 */
export async function planDetails(env, { image, category = '', product = '' } = {}) {
  const sys = '你是资深电商视觉总监与商品摄影师，擅长找出商品最打动人的细节。只输出 JSON。';
  const catLine = category ? ('该商品品类：' + category + '。') : '';
  const prodLine = product ? ('商品名称：' + product + '。') : '';
  const usr = [
    '下面是一张商品实拍图。' + catLine + prodLine,
    '请从图中选出 3 个最能打动买家、最值得放大展示的「卖点局部」。原则：',
    '1) 优先：品牌标识/铭牌/Logo、核心功能部件、做工/材质/工艺细节、特色设计；',
    '2) 该局部在图中必须清晰、对焦准确，不要选被遮挡或虚焦区域；',
    '3) 三个局部分布在商品不同部位、彼此不重叠；',
    '4) bbox 为相对图像宽高的归一化矩形 [x,y,w,h]，0~1，左上原点；在部件四周各预留约 12%~18% 边距，不要紧贴部件；',
    '5) label 为不超过 12 字中文卖点名（如“永久品牌铭牌”“避震前叉”“变速指拨”）。',
    '只输出 JSON：{"details":[{"label":"","bbox":[x,y,w,h]},{"label":"","bbox":[x,y,w,h]},{"label":"","bbox":[x,y,w,h]}]}'
  ].join('\n');
  const r = await chatVisionCustom(env, { system: sys, user: usr, images: [image], maxTokens: 900, temperature: 0.2, timeoutMs: 45000 });
  if (!r.ok) return r;
  const list = Array.isArray(r.data.details) ? r.data.details : [];
  const details = [];
  for (const d of list) {
    if (!d || !Array.isArray(d.bbox) || d.bbox.length !== 4 || !d.label) continue;
    const nums = d.bbox.map(v => { let n = Number(v); if (!Number.isFinite(n)) n = 0; if (n > 1.5) n = n / (n > 100 ? 1000 : 100); return Math.min(1, Math.max(0, n)); });
    let [x, y, w, h] = nums;
    w = Math.min(w, 0.95); h = Math.min(h, 0.95);
    details.push({ label: String(d.label).slice(0, 16), bbox: [x, y, w, h] });
    if (details.length >= 3) break;
  }
  if (details.length < 1) return { ok: false, error: 'details_empty' };
  return { ok: true, details };
}


/**
 * 主体一致性 + 隐私后验。
 * @param {object} env Worker env
 * @param {object} args
 * @param {string[]} args.originals 用户原始实拍 dataURL（1~2 张）
 * @param {string}   args.result    成品图 dataURL
 * @returns {Promise<object>} 归一化后的质检结果；available=false 表示视觉服务不可用（应放行）
 */
export async function verifyConsistency(env, { originals = [], result } = {}, timeoutMs = 30000) {
  // 原图最多带 2 张，成品放最后；整体控制在 3 张以内。
  const refs = originals.slice(0, 2).filter(Boolean);
  const images = [...refs, result].filter(Boolean);
  const r = await chatVisionJson(env, images, timeoutMs);
  if (!r.ok) {
    return { available: false, reason: r.error, pass: true, privacyHit: false };
  }
  const d = r.data || {};
  const plates = normBoxes(d.privacy && d.privacy.plates);
  const faces = normBoxes(d.privacy && d.privacy.faces);
  const vins = normBoxes(d.privacy && d.privacy.vins);
  const hit = list => list.some(b => b.conf >= PRIVACY_CONF_THRESHOLD);

  const checks = {
    same_subject: d.same_subject !== false,
    color_match: d.color_match !== false,
    brand_match: d.brand_match !== false,
    shape_match: d.shape_match !== false,
    defect_removed: d.defect_removed === true
  };
  const score = Math.min(100, Math.max(0, Math.round(Number(d.score) || 0)));
  const issues = Array.isArray(d.issues) ? d.issues.map(String).slice(0, 8) : [];

  const pass = checks.same_subject
    && checks.color_match
    && checks.brand_match
    && checks.shape_match
    && !checks.defect_removed
    && score >= CONSISTENCY_PASS_SCORE;

  return {
    available: true,
    pass,
    score,
    checks,
    issues,
    privacy: { plates, faces, vins },
    privacyHit: hit(plates) || hit(faces) || hit(vins)
  };
}

/**
 * 在生图提示词末尾追加不可越过的"本体保持 + 隐私规避"硬约束（源头治理）。
 * 对非车商品无害（车牌/车架号条款不会作用于服装等图）。
 */
export function appendGuardClauses(prompt) {
  const base = String(prompt || '');
  if (base.includes('__WORKHOGEE_GUARD__')) return base;
  return base.trimEnd() + [
    '',
    '__WORKHOGEE_GUARD__ 硬性要求：',
    '1) 严格保持商品/车辆本体与参考图完全一致——原色、原品牌车标、原外形款式，',
    '   不得改色、换标、换型号，不得去除或美化原图中真实的划痕、凹陷、瑕疵；只改背景与光影。',
    '2) 画面中不得出现清晰可读的车牌号码（车牌做哑光/虚化或避让角度），',
    '   不得出现可识别的真人正脸，不得出现清晰车架号/VIN 钢印。'
  ].join('\n');
}

/* =====================================================================
 * 上传实拍图智能质检（W2）
 * 用户刚传上来的商品/车辆实拍图，在进生图流程之前先 vision 判一遍：
 *   清晰度、曝光、遮挡、完整度、构图。不合格即时提示重拍。
 * 失败降级为 { available:false }，前端用已有像素级粗判兜底，不阻断流程。
 * ===================================================================*/

const QC_SYSTEM_PROMPT = [
  '你是电商实拍图质检员。用户刚用手机拍了一张商品/车辆照片准备上架。',
  '你要判断这张图适不适合直接拿去做商品图。只输出 JSON，不要任何解释。',
  '判断项：sharpness 清晰度、exposure 曝光、occlusion 遮挡、completeness 完整度、framing 构图。',
  '每项给 "ok" / "warn" / "bad"。再给整体 level 和一句口语化重拍建议（中文，40字内）。',
  '返回：{ "sharpness":"ok|warn|bad","exposure":"ok|warn|bad","occlusion":"ok|warn|bad","completeness":"ok|warn|bad","framing":"ok|warn|bad","level":"ok|warn|bad","tip":"重拍建议" }',
  '规则：任何一项 bad 则整体 bad；有 warn 但无 bad 则整体 warn；全 ok 才 ok。'
].join('\n');

export async function qcUpload(env, imageDataUrl) {
  const visionKey = env && (env.VISION_API_KEY || env.ARK_API_KEY);
  if (!env || !visionKey) return { available: false, level: 'ok' };
  if (typeof imageDataUrl !== 'string' || !/^data:image\/(jpe?g|png|webp);base64,/.test(imageDataUrl)) {
    return { available: false, level: 'ok' };
  }
  let resp;
  try {
    resp = await fetchWithTimeout(env.VISION_ENDPOINT || VISION_ENDPOINT_DEFAULT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + visionKey },
      body: JSON.stringify({
        model: env.VISION_MODEL || VISION_MODEL_DEFAULT,
        messages: [
          { role: 'system', content: QC_SYSTEM_PROMPT },
          { role: 'user', content: [
            { type: 'image_url', image_url: { url: imageDataUrl, detail: 'auto' } },
            { type: 'text', text: '这张实拍图质检一下。' }
          ]}
        ],
        temperature: 0.1,
        max_tokens: 400,
        thinking: { type: 'disabled' }
      })
    }, 30000);
  } catch { return { available: false, level: 'ok' }; }
  const text = await resp.text();
  if (!resp.ok) return { available: false, level: 'ok' };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { available: false, level: 'ok' }; }
  const contentText = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
  if (typeof contentText !== 'string') return { available: false, level: 'ok' };
  const d = extractJson(contentText);
  if (!d) return { available: false, level: 'ok' };
  const items = ['sharpness', 'exposure', 'occlusion', 'completeness', 'framing'];
  const checks = {};
  items.forEach(k => {
    const v = String(d[k] || 'ok').toLowerCase();
    checks[k] = (v === 'warn' || v === 'bad') ? v : 'ok';
  });
  let level = String(d.level || '').toLowerCase();
  if (level !== 'warn' && level !== 'bad') {
    const hasBad = items.some(k => checks[k] === 'bad');
    const hasWarn = items.some(k => checks[k] === 'warn');
    level = hasBad ? 'bad' : (hasWarn ? 'warn' : 'ok');
  }
  return { available: true, level, checks, tip: String(d.tip || '').slice(0, 80) };
}

/* =====================================================================
 * 商品智能识别（W2）—— 传图后自动抓取品牌/型号/颜色等信息预填
 * 用户刚传了商品/车辆图，让 vision 把能看到的信息全抓出来，
 * 前端预填到认货表单，客户只需确认或修改，不必从零填。
 * 失败降级为 { available:false, fields:{} }，前端走空白表单。
 * ===================================================================*/

const IDENTIFY_SYSTEM_PROMPT = [
  '你是电商商品识别引擎。用户上传了一张商品实拍图（可能是二手车，也可能是通用商品如化妆品、服装、3C、食品、家居等）。',
  '请仔细看图，把你能从图片中可靠识别出的信息全部提取出来。看不清或不确定的字段不要猜，留空。',
  '除了基础信息，你还要从图里找出 3-5 个"能写进商品文案的卖点"——就是买家看了会心动的具体细节，比如材质手感、包装状态、配件、成色、使用场景。',
  '只输出 JSON，不要任何解释。',
  '如果是车辆，返回：{ "kind":"usedcar","brand":"品牌中文，如丰田","series":"车系，如凯美瑞","year":"年款，如2021款","color":"车身颜色，如黑色","energy":"燃油/油电混动/插混增程/纯电","bodyType":"轿车/SUV/MPV/皮卡","condition":"成色描述，如九成新/原版原漆","sellingPoints":["3-5个车况卖点，从图里看出来的，如漆面光亮/内饰干净/轮毂无刮痕"],"defects":["从图里看出来的明显瑕疵，如右前门有刮痕/轮毂有擦伤/前杠有补漆，没有就空数组"],"confidence":0.0到1.0 }',
  '如果是通用商品，返回：{ "kind":"general","name":"商品名称，如雅诗兰黛小棕瓶精华液100ml","category":"品类，如精华液/运动鞋/蓝牙耳机/T恤/咖啡","brand":"品牌名，如雅诗兰黛","color":"颜色","material":"材质，如玻璃/真皮/棉/铝合金","condition":"成色，如全新未拆/九成新/有使用痕迹","accessories":"配件，如含原盒/含说明书/无配件","scene":"适用场景，如通勤/运动/送礼/居家","sellingPoints":["3-5个从图里看出来的卖点，如玻璃瓶质感好/盒在塑封没拆/滴管设计方便/生产日期标签清晰"],"defects":["从图里看出来的瑕疵或问题，如瓶口有使用痕迹/包装盒有压痕/充电口有磨损，没有就空数组"],"confidence":0.0到1.0 }',
  'sellingPoints 必须是从图片实际看到的细节，不要编。看不清的字段给空字符串，confidence 给你对整体识别的把握程度。'
].join('\n');

export async function identifyProduct(env, imageDataUrl) {
  const visionKey = env && (env.VISION_API_KEY || env.ARK_API_KEY);
  if (!env || !visionKey) return { available: false, fields: {} };
  if (typeof imageDataUrl !== 'string' || !/^data:image\/(jpe?g|png|webp);base64,/.test(imageDataUrl)) {
    return { available: false, fields: {} };
  }
  let resp;
  try {
    resp = await fetchWithTimeout(env.VISION_ENDPOINT || VISION_ENDPOINT_DEFAULT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + visionKey },
      body: JSON.stringify({
        model: env.VISION_MODEL || VISION_MODEL_DEFAULT,
        messages: [
          { role: 'system', content: IDENTIFY_SYSTEM_PROMPT },
          { role: 'user', content: [
            { type: 'image_url', image_url: { url: imageDataUrl, detail: 'auto' } },
            { type: 'text', text: '识别这张图里的商品，把能看到的信息都抓出来。' }
          ]}
        ],
        temperature: 0.1,
        max_tokens: 500,
        thinking: { type: 'disabled' }
      })
    }, 30000);
  } catch { return { available: false, fields: {} }; }
  const text = await resp.text();
  if (!resp.ok) return { available: false, fields: {} };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { available: false, fields: {} }; }
  const contentText = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
  if (typeof contentText !== 'string') return { available: false, fields: {} };
  const d = extractJson(contentText);
  if (!d) return { available: false, fields: {} };
  const fields = {};
  ['kind','brand','series','year','color','energy','bodyType','name','category','material','condition','accessories','scene','confidence'].forEach(k => {
    if (d[k] !== undefined && d[k] !== null && d[k] !== '') fields[k] = typeof d[k] === 'string' ? d[k].trim() : d[k];
  });
  if (Array.isArray(d.sellingPoints)) fields.sellingPoints = d.sellingPoints.map(String).slice(0, 6);
  if (Array.isArray(d.defects)) fields.defects = d.defects.map(String).slice(0, 6);
  return { available: true, fields };
}

/* =====================================================================
 * 商品自动分组（多图上传后，识别哪些是同一商品的多角度 / 哪些是不同商品）
 * ===================================================================*/

const GROUP_SYSTEM_PROMPT = [
  '你是电商商品清点引擎。商家一次上传了若干张实拍图，你要判断哪些图拍的是同一个商品。',
  '判定规则：',
  '1. 同一件商品的不同角度（正面、侧面、斜45度、背面、顶部、底部）、不同部位、内饰、细节、铭牌，都归为同一个商品；',
  '2. 同款商品但颜色不同、型号 / 规格 / 容量不同，视为不同商品，分别成组；',
  '3. 配件、包装、赠品若明显属于某件商品，并入该商品组；无法判断归属的就独立成组；',
  '4. 必须给每一张图都分配一个组：indices 是图片序号（从 0 开始），所有序号恰好出现一次，不重不漏；',
  '5. 拿不准两件是不是同一个商品时，宁可分成两组，也不要把不同商品错误合并。',
  '只返回一个 JSON 对象，不要 markdown、不要解释：',
  '{"groups":[{"name":"该商品的简短描述（含颜色、品类、型号）","indices":[整数序号]}]}'
].join('\n');

/**
 * 把一批上传图按「同一个商品」聚类分组。
 * @param {string[]} images dataURL 数组（建议先压缩成缩略图）
 * @returns {Promise<object>} { ok:true, groups:[{name,indices:[]}] }；失败 { ok:false,error }
 */
export async function groupProducts(env, images, timeoutMs = 45000) {
  const visionKey = env && (env.VISION_API_KEY || env.ARK_API_KEY);
  if (!env || !visionKey) return { ok: false, error: 'no_api_key' };
  const validImages = (images || []).filter(
    u => typeof u === 'string' && /^data:image\/(jpe?g|png|webp);base64,/.test(u)
  );
  if (validImages.length < 1) return { ok: false, error: 'no_image' };

  const content = validImages.map(u => ({ type: 'image_url', image_url: { url: u, detail: 'auto' } }));
  content.push({ type: 'text', text: '共 ' + validImages.length + ' 张图，请按"同一个商品"分组，每一张图都要分到某个组里。' });

  let resp;
  try {
    resp = await fetchWithTimeout(env.VISION_ENDPOINT || VISION_ENDPOINT_DEFAULT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + visionKey },
      body: JSON.stringify({
        model: env.VISION_MODEL || VISION_MODEL_DEFAULT,
        messages: [
          { role: 'system', content: GROUP_SYSTEM_PROMPT },
          { role: 'user', content }
        ],
        temperature: 0.1,
        max_tokens: 900,
        thinking: { type: 'disabled' }
      })
    }, timeoutMs);
  } catch (e) {
    return { ok: false, error: (e && e.message === 'upstream_timeout') ? 'vision_timeout' : 'vision_network' };
  }
  const text = await resp.text();
  if (!resp.ok) return { ok: false, error: 'vision_' + resp.status, detail: text.slice(0, 200) };

  let parsed;
  try { parsed = JSON.parse(text); } catch { return { ok: false, error: 'vision_bad_json' }; }
  const ct = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
  if (typeof ct !== 'string') return { ok: false, error: 'vision_empty' };
  const d = extractJson(ct);
  if (!d || !Array.isArray(d.groups)) return { ok: false, error: 'vision_unparseable' };

  // 规范化分组：剔除非法 / 重复序号，保证 0..n-1 每张图恰好出现一次
  const n = validImages.length;
  const seen = new Set();
  const groups = [];
  d.groups.forEach(g => {
    if (!g || !Array.isArray(g.indices)) return;
    const indices = [];
    g.indices.forEach(x => {
      x = Number(x);
      if (Number.isInteger(x) && x >= 0 && x < n && !seen.has(x)) { seen.add(x); indices.push(x); }
    });
    if (indices.length) groups.push({ name: String(g.name || ('商品' + (groups.length + 1))).slice(0, 40), indices });
  });
  for (let i = 0; i < n; i++) {
    if (!seen.has(i)) groups.push({ name: '商品' + (groups.length + 1), indices: [i] });
  }
  return { ok: true, groups };
}

/* =====================================================================
 * 同商品多角度 → 视觉特征提取（性能优化：让 Seedream 只吃 1 张主图）
 * ===================================================================*/
function buildFeatureSystemPrompt(maxLen) {
 return [
  '你是电商商品视觉特征提取引擎。下面给你的是同一件商品（车辆、服装、3C数码、食品、家居、美妆等任意实物）的多个角度实拍图。',
  '任务：只依据图片中真实可见的内容，客观、精炼地清点这件商品的外观特征，形成一份“商品还原说明书”，',
  '让另一个只看到其中一张图的图像模型，也能精确还原这件商品的全部关键细节。',
  '图中可见才写，不可见的不要臆测；需覆盖：',
  '1) 主体颜色、材质、表面质感与整体版型/外形；',
  '2) 品牌标志 / LOGO 的位置、颜色与形态；',
  '3) 关键外观部件（车辆：轮毂样式、刹车卡钳颜色、前后灯组形态、天窗、车顶设备、包围；服装：领型、门襟、图案、纽扣、配件；3C：接口、按键、屏幕、随附配件；其他品类类推）；',
  '4) 特殊配置、装饰、随附配件与包装；',
  '5) 图中真实存在的划痕、磨损、污渍、瑕疵、旧化痕迹——必须如实记录，后续要保留，严禁美化或省略。',
  '用客观描述，不用营销形容词，不推测品牌型号（图上有明确文字/标志时可照录），不写使用感受。',
  '只返回一个 JSON 对象，不要 markdown、不要解释：',
  '{"features":"一段连贯中文，各特征用逗号分隔，控制在 ' + maxLen + ' 字以内"}'
 ].join('\n');
}

/**
 * 从同商品多角度图提取可还原特征文本。
 * @returns {Promise<object>} { ok:true, text }；失败 { ok:false,error }（调用方降级为单图直出，绝不阻塞）
 */
export async function extractProductFeatures(env, images, opts = {}) {
  const timeoutMs = (opts && opts.timeoutMs) || 40000;
  const maxLen = (opts && opts.maxLen) || 260;
  const maxTokens = (opts && opts.maxTokens) || 800;
  const visionKey = env && (env.VISION_API_KEY || env.ARK_API_KEY);
  if (!env || !visionKey) return { ok: false, error: 'no_api_key' };
  const validImages = (images || []).filter(
    u => typeof u === 'string' && /^data:image\/(jpe?g|png|webp);base64,/.test(u)
  ).slice(0, 6);
  if (validImages.length < 2) return { ok: false, error: 'no_image' };

  const content = validImages.map(u => ({ type: 'image_url', image_url: { url: u, detail: 'auto' } }));
  content.push({ type: 'text', text: '共 ' + validImages.length + ' 张同商品角度图，请提取可还原这件商品的关键视觉特征。' });

  let resp;
  try {
    resp = await fetchWithTimeout(env.VISION_ENDPOINT || VISION_ENDPOINT_DEFAULT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + visionKey },
      body: JSON.stringify({
        model: env.VISION_MODEL || VISION_MODEL_DEFAULT,
        messages: [
          { role: 'system', content: buildFeatureSystemPrompt(maxLen) },
          { role: 'user', content }
        ],
        temperature: 0.1,
        max_tokens: maxTokens,
        thinking: { type: 'disabled' }
      })
    }, timeoutMs);
  } catch (e) {
    return { ok: false, error: (e && e.message === 'upstream_timeout') ? 'vision_timeout' : 'vision_network' };
  }
  const text = await resp.text();
  if (!resp.ok) return { ok: false, error: 'vision_' + resp.status };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { ok: false, error: 'vision_bad_json' }; }
  const ct = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
  if (typeof ct !== 'string') return { ok: false, error: 'vision_empty' };
  const d = extractJson(ct);
  if (!d || typeof d.features !== 'string' || !d.features.trim()) return { ok: false, error: 'vision_unparseable' };
  return { ok: true, text: d.features.trim().slice(0, 400) };
}

/* =====================================================================
 * 多平台文案生成（W2）—— 调豆包文本模型
 * ===================================================================*/

const COPY_MODEL_DEFAULT = 'doubao-seed-2-1-turbo-260628';

const COPY_BANNED_WORDS = [
  '最好','最佳','最优','最低','最高','第一','唯一','首个','首选','顶级','极品','极致','万能',
  '100%','百分百','纯天然','永久','绝对','彻底','根治','永不','全网最低','史上最','全国第一',
  '领先','领导者','之王','之最','冠军','销量第一','驰名','免检','老字号'
];

/* —— 小红书：爆款笔记方法论 —— */
/* =====================================================================
 * 阿文 · 品类事实模板 + 智能预填
 * 不同品类买家关心的点不同：补录卡字段按品类动态；阿文先给一版预填
 * （价格给市场参考、品种给通俗名+学名），老板在草稿上改，不做空白填空。
 * ===================================================================*/
const FACT_SCHEMAS = {
  usedcar: {
    label: '二手车',
    fields: [
      ['regDate', '上牌时间', '如 2023年5月'],
      ['mileage', '表显里程', '如 3.2万公里'],
      ['price', '售价', '如 16.99万'],
      ['transfers', '过户次数', '如 一手 / 0过户'],
      ['condition', '车况', '如 仅右前叶1处补漆'],
      ['config', '配置亮点', '如 全景天窗、座椅加热']
    ]
  },
  flower: {
    label: '鲜花',
    fields: [
      ['price', '价格', '一束的市场参考价'],
      ['quantity', '数量 / 规格', '如 20支一束、花头大小'],
      ['variety', '品种（通俗名+学名）', '如 无刺玫瑰（洋桔梗 Eustoma grandiflorum）'],
      ['origin', '产地', '如 云南昆明斗南'],
      ['bloom', '花期 / 新鲜度', '如 瓶插约7天、现摘花苞'],
      ['scene', '适用场景 / 节日', '如 表白、生日、家居、母亲节'],
      ['delivery', '配送方式', '如 同城闪送、顺丰冷链、现货速发']
    ]
  },
  general: {
    label: '通用商品',
    fields: [
      ['price', '价格', '市场参考价'],
      ['spec', '规格 / 材质', '尺寸、材质、型号'],
      ['spoints', '核心卖点', '具体、可验证'],
      ['scenes', '使用场景', '适合什么人 / 什么场合']
    ]
  }
};

function factSchemaFor(identityType, category) {
  if (identityType === 'usedcar') return FACT_SCHEMAS.usedcar;
  const cat = String(category || '');
  if (/鲜花|花束|花卉|花店|flower/i.test(cat)) return FACT_SCHEMAS.flower;
  return FACT_SCHEMAS.general;
}

const PREFILL_SYSTEM_PROMPT = [
  '你是 WorkHogee 阿文，同时是该品类的资深行家：既懂产品本身的专业知识，也懂这个品类的买家下单前最关心什么。',
  '任务：根据商品图片 / 品类，把"商品事实表"先填一版，让老板在你的草稿上改，而不是面对空白表格。',
  '要求：',
  '1. 只输出一个 JSON 对象，键是给定字段 key，值是你建议填写的字符串；不要解释、不要 markdown。',
  '2. 价格：给该商品当下的市场参考价或合理区间（可注明"参考"），不要留空。',
  '3. 品种 / 规格：以买家最易懂的通俗名为主，括号备注别名或专业名 / 学名。例如白色洋桔梗写成"无刺玫瑰（又叫土耳其桔梗 / 白色重瓣洋桔梗，学名 Eustoma grandiflorum）"。',
  '4. 产地、花期、适用场景等：基于该品类真实常识给具体内容；确实无法从图判断的，给最常见情况并注明"请按实际改"。',
  '5. 不编造品牌、认证、销量、具体功效；不确定的字段给占位提示，不要瞎编。'
].join('\n');

export async function prefillFacts(env, { image = '', identityType = 'general', category = '', product = '', facts = null } = {}) {
  const key = env && (env.COPY_API_KEY || env.ARK_API_KEY);
  if (!key) return { ok: false, reason: 'no_key' };
  const schema = factSchemaFor(identityType, category);
  const fieldLines = schema.fields.map(f => '- key "' + f[0] + '"（' + f[1] + '）').join('\n');
  let known = '';
  if (facts) {
    known = typeof facts === 'string' ? facts
      : Object.entries(facts).map(([k, v]) => (v ? k + '：' + v : '')).filter(Boolean).join('\n');
  }
  const userText = [
    '品类：' + schema.label + (category ? '（' + category + '）' : ''),
    product ? '商品：' + product : '',
    known ? '已知信息（优先沿用、不要推翻）：\n' + known : '',
    '需要你填的字段（JSON 的键）：\n' + fieldLines,
    '请直接输出 JSON，例如 {"' + schema.fields[0][0] + '": "..."}'
  ].filter(Boolean).join('\n');

  const content = [];
  if (image && /^data:image\/(jpe?g|png|webp);base64,/.test(image)) {
    content.push({ type: 'text', text: userText });
    content.push({ type: 'image_url', image_url: { url: image } });
  } else {
    content.push({ type: 'text', text: userText });
  }

  let resp;
  try {
    resp = await fetchWithTimeout(env.COPY_ENDPOINT || VISION_ENDPOINT_DEFAULT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: env.COPY_MODEL || COPY_MODEL_DEFAULT,
        messages: [
          { role: 'system', content: PREFILL_SYSTEM_PROMPT },
          { role: 'user', content }
        ],
        temperature: 0.7,
        max_tokens: 1200,
        thinking: { type: 'disabled' }
      })
    }, 45000);
  } catch (e) { return { ok: false, reason: 'fetch:' + (e && e.message) }; }
  const text = await resp.text();
  if (!resp.ok) return { ok: false, reason: 'http:' + resp.status };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { ok: false, reason: 'body_parse' }; }
  const raw = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
  // extractJson 已返回解析后的对象；这里不能再次 JSON.parse（对象会被 toString 成 "[object Object]" 导致解析失败、fields 永远为空）
  let fields = {};
  const ej = extractJson(raw);
  if (ej && typeof ej === 'object' && !Array.isArray(ej)) fields = ej;
  const allowed = schema.fields.map(f => f[0]);
  const out = {};
  allowed.forEach(k => {
    let v = fields[k];
    if (v == null || !String(v).trim()) {
      // 键名容错：模型偶尔把 key 写成带中文标签的形式（如 "config亮点" 应为 "config"）
      const fk = Object.keys(fields).find(rk => rk !== k && (rk.indexOf(k) === 0 || k.indexOf(rk) === 0));
      if (fk) v = fields[fk];
    }
    if (v != null && String(v).trim()) out[k] = String(v).trim();
  });
  const schemaId = schema === FACT_SCHEMAS.usedcar ? 'usedcar' : (schema === FACT_SCHEMAS.flower ? 'flower' : 'general');
  return { ok: true, schema: schemaId, fields: out };
}

const COPY_PROMPT_XHS = `你是 WorkHogee 阿文，顶级小红书带货写手。你的笔记必须和真实高赞爆款一模一样，而不是写作文。
【第一步：严格照"成品骨架"逐块输出，顺序不变，绝不写成连续段落】
<第1行 标题：价格或数字钩子+1个emoji+商品名+人群/稀缺标签，20字内，如"16.99w捡漏天花板✨小米SU7小姐姐一手极品车">
<空1行>
<开头2句：用"谁懂啊/真的杀疯了/姐妹们"这类情绪热词开场，每句可带emoji，直接给结论>
<空1行>
<档案区：二手车用"🚗 车辆档案"，其他商品用"📋 商品档案">
· <字段>：<值>，把具体事实里的核心字段逐行列出（二手车如上牌/车型/里程/售价；其他如材质/规格/颜色/价格）
<空1行>
✅ <卖点区标题：二手车用"硬核车况"，其他用"必入理由">
· 每条一行、"· "开头，必须是带数字或具体事实的卖点，至少5条
<空1行>
💛 <场景区标题"为什么选它/适合谁">
· 使用场景、人群契合的卖点，2-3条
<空1行>
<互动提问：一句引导评论/私信，如"想看细节的评论区扣1">
<最后1行 标签：8-10个 #开头空格分隔，大词+垂直词+长尾词>
【第二步：把下面真实高赞范例当成排版与语感的唯一标准，对齐它的emoji分块、"· "短句bullet、空行节奏、数字密度和网感；商品换成用户给的，禁止照抄范例里的车和数字】
===== 真实高赞范例（小米SU7）=====
16.99w捡漏天花板✨小米SU7小姐姐一手极品车

谁懂啊！小米SU7性价比真的杀疯了💥
准新代步电车首选！干净温柔小姐姐一手车，车况无敌！

🚗 车辆档案
· 上牌：2024年11月
· 车型：小米SU7 标准续航700km版本
· 里程：实表仅3万公里
· 售价：16.99万（同年限全网底价）

✅ 极品硬核车况
· 小姐姐个人一手户
· 全程温柔驾驶，无暴力用车
· 专业电池检测S级满分状态
· 跑长途、日常通勤完全无焦虑
· 全车仅2块补漆，无钣金无事故
· 灰红经典撞色，颜值直接拉满
· 里外成色接近新车，内饰零磨损、干净透亮

💛 为什么选这台SU7?
· 700km超长CLTC续航真的够用
· 市区通勤一周充一次，短途自驾随便跑

想看更多细节的评论区扣1，我挨个发你～
#小米su7 #新能源二手车 #准新车 #代步电车 #一手车 #捡漏 #高性价比 #同城看车
===== 范例结束 =====
【铁律】1.数字/配置/参数只能来自"具体事实"，事实里没有的条目直接省略，绝不编造（不编续航/油耗/排名/销量/功效）；2.禁止连续段落，必须emoji小标题+"· "短句bullet+区块间空行；3.不用广告法绝对化词（100%/绝对/永久/第一/最好），不喊"立即下单/点击购买"；4.直接输出成稿，不要解释、JSON或代码块。`;

/* —— 抖音：3秒钩子 + 分时间轴口播 —— */
const COPY_PROMPT_DOUYIN = `你是 WorkHogee 阿文，顶级短视频编导，写15秒强节奏口播分镜。严格照骨架输出：
<第1行 黄金3秒钩子：身份召唤或利益前置，如"10万出头想提台操控好的后驱车？先别划走！">
[0-3s]（画面：<镜头>）
口播：<≤15字短句>
[3-7s]（画面：<镜头>）
口播：<≤15字，带具体数字：年份/价格/里程/动力>
[7-11s]（画面：<镜头>）
口播：<内饰/配置/保养，具体>
[11-14s]（画面：<镜头>）
口播：<车况：补漆处数/原漆/无事故，具体数字>
[14-15s]（画面：<镜头>）
口播：<检测+看车地点+轻互动>
发布标题：<15字内，留悬念或提问>
<最后1行 话题：4-5个 #开头空格分隔>
【真实风格范例，只学它的节奏、镜头标注和数字密度，商品与数字全部换成用户给的，禁止照抄】
10万出头想提台操控好的后驱车？先别划走！
[0-3s]（画面：展厅宝马3系正面缓缓推近）
口播：10万出头想开后驱，这台3系看看
[3-7s]（画面：绕车拍侧面线条、轮毂）
口播：18年上牌，2.0T有184马力
[7-11s]（画面：拉开车门拍内饰、天窗、真皮）
口播：个人一手6万公里，全程4S保养
[11-14s]（画面：特写翼子板、发动机舱）
口播：就右前叶一块补漆，没事故没钣金
[14-15s]（画面：车标特写）
口播：支持第三方检测，看车评论区
发布标题：10万出头提宝马3系，一手原漆香不香
#宝马3系 #二手车 #后驱车 #同城看车
【铁律】数字只来自具体事实、不编造；每句口播≤15字、能一口气念完；直接输出，不要解释和JSON。`;

/* —— 朋友圈：本人生活化分享 —— */
const COPY_PROMPT_PYQ = `你是 WorkHogee 阿文，帮老板写一条"像本人随手发的"朋友圈，真实、可信、让人愿意私信。
【真实风格范例，只学口吻、节奏和克制，商品与数字全部换成用户给的，禁止照抄】
今天收了台挺省心的凯美瑞，18年的，个人一手，开了6万公里。
2.0自吸，省油耐造，全程4S保养，记录都能查。
里外成色不错，内饰没什么磨损，就右前翼子板补过一块漆，其他原漆，没事故没钣金。
支持第三方检测，买个踏实。
价格私信，随时看车，有兴趣的朋友留言，细节视频发你。
【要求】1.第一句像随口一说（"今天收了台…/新到一台…"），不要"家人们/重磅/推出"营销腔；2.4-6行大白话，把年份、里程、价格、补漆处数、保养这些具体事实自然揉进去，不罗列、全文emoji≤3个；3.结尾软引导私信，不喊下单；4.数字只来自具体事实、不编造；直接输出成稿，不要解释和JSON。`;

/* —— 通用：商品详情/介绍（兜底与其他渠道）—— */
const COPY_PROMPT_GENERAL = `你是 WorkHogee 阿文，帮商家写一段"商品详情/通用介绍"，清楚、可信、不啰嗦。
【结构】1.第一句：一句话说明这是什么、最核心卖点（15字内）；2.主体：用3-5个"· "短句小点把具体事实讲清楚，用真实数字和事实、不堆形容词；3.结尾：一句客观的服务/成交说明（如"支持实地看货/有问题可咨询"），不喊下单。
【铁律】只用给定具体事实，不编造参数/价格/销量/功效；不用广告法绝对化词；直接输出成稿，不要解释和JSON。`;

const COPY_PLATFORM_PROMPTS = {
  xhs: COPY_PROMPT_XHS,
  douyin: COPY_PROMPT_DOUYIN,
  pyq: COPY_PROMPT_PYQ,
  general: COPY_PROMPT_GENERAL
};

/* 把商品/卖点/人群/场景/知识库结构化成统一上下文 */
function buildCopyContext({ product = '', category = '', targetAudience = '', sellingPoints = [], scene = '', extra = '', kbContext = '', facts = '' } = {}) {
  const sp = Array.isArray(sellingPoints) ? sellingPoints.filter(Boolean) : [];
  let factsText = '';
  if (facts) {
    if (typeof facts === 'string') factsText = facts;
    else factsText = Object.entries(facts).map(([k, v]) => (v ? k + '：' + v : '')).filter(Boolean).join('\n');
  }
  const isFlower = /鲜花|花束|花卉|花店|flower/i.test(category);
  return [
    '【行家要求】你是该品类的资深行家，既懂产品本身，也懂这个品类的买家下单前最关心什么：先把买家最关心的几件事用“具体事实”回答清楚，再写卖点；商品名以买家最易懂的通俗名为主，别名、专业名或学名放在括号备注，不堆砌术语、不写空话。',
    isFlower ? '【鲜花品类要点】买家最关心：新鲜度与瓶插花期、支数 / 花头大小、品种（通俗名+学名）、能否按节日 / 场景准时送达、是否现货；商品名示例：白色洋桔梗写成“无刺玫瑰（又叫土耳其桔梗 / 白色重瓣洋桔梗，学名 Eustoma grandiflorum）”。' : '',
    factsText ? '【具体事实（以下数字与字段全部真实，必须用上、逐条转成"· "bullet，缺失字段不要编）】\n' + factsText : '',
    product ? '商品：' + product : '',
    category ? '品类：' + category : '',
    targetAudience ? '目标人群：' + targetAudience : '',
    sp.length ? '补充卖点（转化成自然表达、不要照抄罗列）：' + sp.join('；') : '',
    scene ? '使用/成交场景：' + scene : '',
    kbContext ? '商家与品牌资料（用于落款与可信细节，不要原样堆砌）：' + kbContext : '',
    extra ? '补充说明：' + extra : ''
  ].filter(Boolean).join('\n');
}

/* 单次文案模型调用，直接返回成稿文本 */
async function callCopyModel(env, systemPrompt, userContent, temperature) {
  const key = env && (env.COPY_API_KEY || env.ARK_API_KEY);
  if (!key) throw new Error('no_key');
  let resp;
  try {
    resp = await fetchWithTimeout(env.COPY_ENDPOINT || VISION_ENDPOINT_DEFAULT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: env.COPY_MODEL || COPY_MODEL_DEFAULT,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ],
        temperature: temperature || 0.85,
        max_tokens: 1900,
        thinking: { type: 'disabled' }
      })
    }, 45000);
  } catch (e) { throw new Error('fetch:' + (e && e.message)); }
  const text = await resp.text();
  if (!resp.ok) throw new Error('http:' + resp.status);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('body_parse'); }
  const c = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
  if (typeof c !== 'string' || !c.trim()) throw new Error('no_content');
  return c.trim();
}

export async function generateCopy(env, input = {}) {
  const key = env && (env.COPY_API_KEY || env.ARK_API_KEY);
  if (!env || !key) return { available: false };
  const want = (Array.isArray(input.channels) && input.channels.length
    ? input.channels : ['xhs', 'douyin', 'pyq', 'general']).filter(c => COPY_PLATFORM_PROMPTS[c]);
  const uniq = Array.from(new Set(want));
  const ctx = buildCopyContext(input);
  const entries = await Promise.all(uniq.map(async (pf) => {
    try {
      const text = await callCopyModel(env, COPY_PLATFORM_PROMPTS[pf], ctx, pf === 'general' ? 0.5 : 0.85);
      return [pf, text];
    } catch (e) { return [pf, '']; }
  }));
  const out = {};
  entries.forEach(([pf, t]) => { out[pf] = t; });
  const anyOk = ['xhs', 'douyin', 'pyq', 'general'].some(pf => out[pf]);
  if (!anyOk) return { available: false, reason: 'all_empty' };
  const xhsText = out.xhs || '';
  const titleLine = (xhsText.split('\n').map(l => l.trim()).filter(Boolean)[0]) || input.product || '';
  const tagMatches = xhsText.match(/#[^#\s]+/g) || [];
  const tags = tagMatches.map(t => t.replace(/^#/, '').trim()).filter(Boolean).slice(0, 8);
  if (!out.general) out.general = out.pyq || xhsText;
  const bannedHits = COPY_BANNED_WORDS.filter(w => entries.map(([, t]) => t).join('\n').includes(w));
  return {
    available: true,
    channels: {
      general: out.general || '',
      xhs: out.xhs || '',
      pyq: out.pyq || '',
      douyin: out.douyin || '',
      title: titleLine,
      tags: tags
    },
    bannedHits
  };
}

/* =====================================================================
 * 阿视 · 视频分镜（P0 图文成片）
 * ---------------------------------------------------------------------
 * 只做一件需要大模型的事：把商品名 / 卖点 / 阿文文案 + 模板，结构化成
 * 「镜头脚本 JSON」。运镜、转场、字幕、音乐、导出全部在前端 Canvas 完成，
 * Worker 不跑 FFmpeg、不调按秒计费的图生视频模型（那是 P1，待 Seedance 开通）。
 * 任何失败 / 未配置都降级 { available:false }，由前端走内置兜底分镜，不阻断。
 * ===================================================================*/

const STORYBOARD_TEMPLATES = {
  // 商品展示型 15s：全景 → 细节 → 场景 → 卖点（抖音 / 快手）
  showcase15: { label: '商品展示型', durationSec: 15, beats: ['全景展示', '细节特写', '使用场景', '卖点收尾'], platforms: ['抖音', '快手'] },
  // 种草推荐型 20s：痛点 → 产品 → 效果 → 对比 → 号召（小红书）
  seeding20: { label: '种草推荐型', durationSec: 20, beats: ['痛点引入', '产品亮相', '效果展示', '前后对比', '行动号召'], platforms: ['小红书'] },
  // 快速浏览型 8s：全景 → 细节 → 全景（朋友圈 / 视频号）
  quick8: { label: '快速浏览型', durationSec: 8, beats: ['全景', '细节', '全景'], platforms: ['朋友圈', '视频号'] },
  // 详细讲解型 30s：外观 → 内部 → 功能 → 细节 → 对比 → 号召（抖音挂车）
  detail30: { label: '详细讲解型', durationSec: 30, beats: ['整体外观', '内部细节', '核心功能', '材质做工', '对比优势', '行动号召'], platforms: ['抖音挂车'] }
};
const STORYBOARD_RATIOS = {
  '9:16': { w: 1080, h: 1920 },
  '1:1': { w: 1080, h: 1080 },
  '3:4': { w: 1080, h: 1440 }
};

const STORYBOARD_SYSTEM_PROMPT = [
  '你是 WorkHogee 阿视，电商商品短视频的导演兼剪辑师。任务：为“图文成片”设计结构化分镜脚本。',
  '素材是商家已经生成好的多张商品图，你只安排镜头顺序、画面重点、Ken Burns 运镜和字幕，不臆造画面里没有的东西。',
  '纪律：字幕只能取材于给定的商品名、品类、已知卖点和阿文文案；不得编造价格、销量、排名、功效或承诺；',
  '不用广告法绝对化用语（最好、第一、100%、绝对、永久等）；每条字幕不超过 14 个汉字；',
  '结尾只做品牌露出和轻提示，不写“立即购买”“点击下单”。',
  '严格只输出一个 JSON 对象，不要 Markdown、不要代码块、不要任何解释。schema：',
  '{',
  '  "title": "不超过15字的视频标题",',
  '  "cta": "结尾品牌露出字幕，不超过10字",',
  '  "musicMood": "轻快|温暖|节奏|舒缓 四选一",',
  '  "shots": [',
  '    { "shot":"镜头名，如 全景/细节/场景/卖点",',
  '      "visual":"这一镜的画面重点，10-30字，指明展示商品的哪个部分、什么角度、什么氛围",',
  '      "motion":"push-in|zoom-out|pan-left|pan-right|kenburns|rise 六选一",',
  '      "duration": 该镜秒数（数字）,',
  '      "caption":"不超过14字字幕，无字幕给空字符串" }',
  '  ]',
  '}'
].join('\n');

export async function generateStoryboard(env, {
  product = '', category = '', sellingPoints = [], copyText = '',
  template = 'showcase15', ratio = '9:16'
} = {}) {
  const key = env && (env.COPY_API_KEY || env.ARK_API_KEY);
  if (!env || !key) return { available: false };
  const tpl = STORYBOARD_TEMPLATES[template] || STORYBOARD_TEMPLATES.showcase15;
  const rt = STORYBOARD_RATIOS[ratio] ? ratio : '9:16';
  const dim = STORYBOARD_RATIOS[rt];
  const sp = Array.isArray(sellingPoints) ? sellingPoints.filter(Boolean).slice(0, 8) : [];
  const userContent = [
    '商品：' + (product || '未命名商品'),
    category ? '品类：' + category : '',
    sp.length ? '已知卖点（字幕只能从这里和商品名取材）：' + sp.join('；') : '',
    copyText ? '阿文文案参考：' + String(copyText).slice(0, 600) : '',
    '模板：' + tpl.label + '，总时长约 ' + tpl.durationSec + ' 秒，画幅 ' + rt + '（' + dim.w + '×' + dim.h + '）。',
    '镜头节拍（按此顺序，可合并、不可新增卖点）：' + tpl.beats.join(' → '),
    '请生成 ' + tpl.beats.length + ' 个镜头，各镜 duration 之和约等于 ' + tpl.durationSec + ' 秒。'
  ].filter(Boolean).join('\n');

  let resp;
  try {
    resp = await fetchWithTimeout(env.COPY_ENDPOINT || VISION_ENDPOINT_DEFAULT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: env.COPY_MODEL || COPY_MODEL_DEFAULT,
        messages: [
          { role: 'system', content: STORYBOARD_SYSTEM_PROMPT },
          { role: 'user', content: userContent }
        ],
        temperature: 0.6,
        max_tokens: 1400,
        thinking: { type: 'disabled' }
      })
    }, 30000);
  } catch { return { available: false }; }

  const text = await resp.text();
  if (!resp.ok) return { available: false };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { available: false }; }
  const contentText = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
  if (typeof contentText !== 'string') return { available: false };
  const d = extractJson(contentText);
  if (!d || !Array.isArray(d.shots) || d.shots.length === 0) return { available: false };

  const MOTIONS = new Set(['push-in', 'zoom-out', 'pan-left', 'pan-right', 'kenburns', 'rise']);
  const autoDur = Math.max(2, Math.round(tpl.durationSec / tpl.beats.length));
  let total = 0;
  const shots = d.shots.slice(0, 8).map((s, i) => {
    let dur = Number(s && s.duration);
    if (!Number.isFinite(dur) || dur <= 0) dur = autoDur;
    dur = Math.min(8, Math.max(1.5, dur));
    total += dur;
    return {
      index: i + 1,
      shot: String((s && s.shot) || tpl.beats[Math.min(i, tpl.beats.length - 1)] || ('镜头' + (i + 1))).slice(0, 12),
      visual: String((s && s.visual) || '').slice(0, 120),
      motion: MOTIONS.has(s && s.motion) ? s.motion : 'kenburns',
      duration: dur,
      caption: String((s && s.caption) || '').slice(0, 28)
    };
  });

  const allText = [d.title, d.cta, ...shots.map(x => x.shot + x.visual + x.caption)].filter(Boolean).join('\n');
  const bannedHits = COPY_BANNED_WORDS.filter(w => allText.includes(w));
  return {
    available: true,
    template,
    templateLabel: tpl.label,
    ratio: rt,
    width: dim.w,
    height: dim.h,
    durationSec: Math.round(total * 10) / 10,
    platforms: tpl.platforms,
    title: String(d.title || '').slice(0, 30),
    cta: String(d.cta || '').slice(0, 20),
    musicMood: String(d.musicMood || '轻快').slice(0, 8),
    shots,
    bannedHits
  };
}

/* =====================================================================
 * 自由输入意图路由 understandIntent
 * ---------------------------------------------------------------------
 * 工作台中央对话框是统一入口，用户可能一上来就要写文案 / 做视频 / 发布 / 看数据，
 * 不一定从生图开始。用文本模型把一句话路由到五个伙计之一，输出严格 JSON。
 * 面向全行业（实物商品 + 服务），不绑定任何单一品类。任何失败 / 未配置都降级
 * { available:false }，由前端走关键词规则兜底，绝不阻断对话。
 * ===================================================================*/
const INTENT_TARGETS = new Set(['atu', 'awen', 'ashi', 'afa', 'agu', 'host']);
const INTENT_ACTIONS = new Set(['start_sell', 'upload_photos', 'write_copy', 'make_video', 'deliver', 'show_analytics', 'choose_skill', 'extra_note', 'chat']);
const INTENT_SYSTEM_PROMPT = [
  '你是 WorkHogee 工作台的意图路由引擎。WorkHogee 是面向全行业商家（既卖实物商品也卖服务）的 AI 生意伙计，共有五位伙计：',
  '- atu 阿图：商品图 / 服务展示图的拍摄引导、识别、生成与精修；',
  '- awen 阿文：写各平台文案、标题、卖点话术、种草文、商品描述、朋友圈/公众号/小红书/抖音文案；',
  '- ashi 阿视：把已有图文做成短视频、动态图、GIF、分镜、宣传片；',
  '- afa 阿发：把成品打包并协助分发到抖音/小红书/朋友圈等渠道（半自动，最后一下用户自己发）；',
  '- agu 阿果：效果数据、浏览量、线索、转化、渠道二维码归因、数据看板；',
  '- host：总管，负责问候、能力介绍、连接账号/知识库/渠道设置，以及无法归类的闲聊。',
  '判定规则：',
  '1) 要写文案/标题/卖点/描述/种草/笔记/软文/话术 → target=awen, action=write_copy；',
  '2) 要做视频/剪视频/短视频/动态图/GIF/分镜/宣传片/把图动起来 → target=ashi, action=make_video；',
  '3) 要发布/上架/分发/发到某个平台/送达/打包给渠道/媒体发布 → target=afa, action=deliver；',
  '4) 要看数据/效果/浏览播放量/线索/转化/统计/看板/二维码效果 → target=agu, action=show_analytics；',
  '5) 要连接账号、管理渠道插件、管理知识库或行业能力 → target=host, action=choose_skill；',
  '6) 要传图、拍照、上传、怎么开始做图，或只是报出商品/服务名想开始做图 → target=atu；明确在催上传动作用 action=upload_photos，否则 action=start_sell；',
  '7) 已经在某个流程里补充确认信息、追加备注或卖点 → target=host, action=extra_note；',
  '8) 问候、问你是谁/能做什么、与上述都无关的闲聊 → target=host, action=chat。',
  '意图清晰 confidence 给 0.7 以上；模棱两可给 0.3 以下。product 只填从这句话里能明确抽出的商品或服务名（如“无线蓝牙耳机”“乒乓球拍”），抽不出给空字符串。',
  'reply 留空字符串即可，除非需要一句简短中文引导。只输出一个 JSON 对象，不要 Markdown、不要代码块、不要解释。'
].join('\n');

export async function understandIntent(env, { text = '', context = {} } = {}) {
  const key = env && (env.COPY_API_KEY || env.ARK_API_KEY);
  if (!env || !key) return { available: false, reason: 'no_api_key' };
  const q = String(text || '').slice(0, 500);
  if (!q.trim()) return { available: false, reason: 'empty_text' };
  const ctx = {
    activePartner: context && context.activePartner,
    stage: context && context.stage,
    hasIdentity: !!(context && context.hasIdentity),
    identityType: context && context.identityType,
    hasImages: !!(context && context.hasImages),
    product: context && context.product ? String(context.product).slice(0, 60) : ''
  };
  const userContent = [
    '当前上下文：' + JSON.stringify(ctx),
    '用户这句话：' + q,
    '输出 JSON：{"target":"...","action":"...","confidence":0.0,"product":"","reply":""}'
  ].join('\n');
  let resp;
  try {
    resp = await fetchWithTimeout(env.COPY_ENDPOINT || VISION_ENDPOINT_DEFAULT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: env.COPY_MODEL || VISION_MODEL_DEFAULT,
        messages: [
          { role: 'system', content: INTENT_SYSTEM_PROMPT },
          { role: 'user', content: userContent }
        ],
        temperature: 0.1,
        max_tokens: 400,
        thinking: { type: 'disabled' }
      })
    }, 15000);
  } catch (e) { return { available: false, reason: 'fetch:' + (e && e.message) }; }
  const raw = await resp.text();
  if (!resp.ok) return { available: false, reason: 'http:' + resp.status, detail: raw.slice(0, 160) };
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { available: false, reason: 'body_parse', detail: raw.slice(0, 160) }; }
  const c0 = parsed && parsed.choices && parsed.choices[0];
  const contentText = c0 && c0.message && c0.message.content;
  if (typeof contentText !== 'string') return { available: false, reason: 'no_content', finish: c0 && c0.finish_reason };
  const d = extractJson(contentText);
  if (!d) return { available: false, reason: 'no_json', detail: contentText.slice(0, 160) };
  const target = INTENT_TARGETS.has(d.target) ? d.target : 'host';
  const action = INTENT_ACTIONS.has(d.action) ? d.action : 'chat';
  let confidence = Number(d.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.min(1, Math.max(0, confidence));
  return {
    available: true,
    target,
    action,
    confidence,
    product: typeof d.product === 'string' ? d.product.slice(0, 60) : '',
    reply: typeof d.reply === 'string' ? d.reply.slice(0, 120) : ''
  };
}
