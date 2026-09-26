/* =====================================================================
 * WorkHogee · 成品图隐式 AI 标识（元数据）写入
 * ---------------------------------------------------------------------
 * 只做"字节级插入"，不解码 / 不重编码像素，CPU 极低，Cloudflare Worker
 * 免费版即可运行。显式"AI 生成"角标由 Seedream 自带，这里补的是文件内部
 * 机器可读的隐式标识：
 *   - JPEG：APP1 段写入标准 XMP（IPTC digitalSourceType =
 *           trainedAlgorithmicMedia，即"算法训练生成媒体"），并附 COM 注释；
 *   - PNG ：IHDR 后插入 tEXt（Software / AI-Content / Asset-Id / 时间）
 *           与 iTXt（keyword=XML:com.adobe.xmp，携带同一份 XMP）。
 * 不支持的格式（webp/gif 等）原样返回，绝不因元数据失败影响出图。
 * ===================================================================*/

const XMP_NS = 'http://ns.adobe.com/xap/1.0/';
const IPTC_TRAINED_MEDIA = 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia';

function b64ToBytes(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

function bytesToB64(u) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, u.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function concat(list) {
  let n = 0;
  for (const a of list) n += a.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const a of list) { out.set(a, off); off += a.length; }
  return out;
}

function strBytes(s) { return new TextEncoder().encode(s); }
function latinBytes(s) {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
  return u;
}

// 标准 CRC32（PNG chunk 校验）
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(u) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u.length; i++) c = CRC_TABLE[(c ^ u[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeB = latinBytes(type);
  const len = data.length;
  const out = new Uint8Array(12 + len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  out.set(typeB, 4);
  out.set(data, 8);
  const crcInput = concat([typeB, data]);
  dv.setUint32(8 + len, crc32(crcInput));
  return out;
}

// tEXt: keyword\0text（latin1，键值都用 ASCII）
function pngText(keyword, text) {
  const data = concat([latinBytes(keyword), new Uint8Array([0]), latinBytes(String(text))]);
  return pngChunk('tEXt', data);
}

// iTXt: keyword\0 compFlag(1) compMethod(1) lang\0 transKw\0 utf8text
function pngIText(keyword, utf8text) {
  const data = concat([
    latinBytes(keyword), new Uint8Array([0]),
    new Uint8Array([0, 0]),                 // 未压缩
    new Uint8Array([0]),                    // language tag 空 + null
    new Uint8Array([0]),                    // translated keyword 空 + null
    strBytes(utf8text)
  ]);
  return pngChunk('iTXt', data);
}

function buildXmp({ assetId, iso }) {
  const safe = String(assetId || '').replace(/[<>&"]/g, '');
  return [
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about=""',
    ' xmlns:xmp="' + XMP_NS + '"',
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"',
    ' xmlns:iptc="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/"',
    ' xmp:CreatorTool="WorkHogee AI"',
    ' dc:creator="WorkHogee"',
    ' dc:publisher="WorkHogee"',
    ' iptc:digitalSourceType="' + IPTC_TRAINED_MEDIA + '">',
    '<xmp:CreateDate>' + iso + '</xmp:CreateDate>',
    '<xmp:MetadataDate>' + iso + '</xmp:MetadataDate>',
    '<dc:identifier>' + safe + '</dc:identifier>',
    '</rdf:Description></rdf:RDF></x:xmpmeta>'
  ].join('');
}

function stampPng(u, meta) {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (u[i] !== SIG[i]) return null;
  // IHDR = 8(sig)+4(len)+4(type) 起，长度在偏移 8 的 Uint32
  const ihdrLen = new DataView(u.buffer, u.byteOffset + 8, 4).getUint32(0);
  const ihdrEnd = 8 + 12 + ihdrLen; // sig + (len+type+data+crc)
  const head = u.slice(0, ihdrEnd);
  const rest = u.slice(ihdrEnd);

  const chunks = [
    pngText('Software', 'WorkHogee AI (Volcengine Seedream)'),
    pngText('AI-Content', 'generated'),
    pngText('Asset-Id', meta.assetId),
    pngText('Generated-At', meta.iso),
    pngIText('XML:com.adobe.xmp', meta.xmp)
  ];
  return concat([head, ...chunks, rest]);
}

function stampJpeg(u, meta) {
  if (u[0] !== 0xff || u[1] !== 0xd8) return null; // 无 SOI
  // 已含 XMP 则不重复注入
  const head = u.slice(0, Math.min(u.length, 4096));
  let already = false;
  for (let i = 0; i + XMP_NS.length < head.length; i++) {
    if (String.fromCharCode(head[i]) === 'h') {
      const slice = String.fromCharCode.apply(null, head.subarray(i, i + 28));
      if (slice === XMP_NS.slice(0, 28)) { already = true; break; }
    }
  }

  const parts = [u.slice(0, 2)]; // SOI
  if (!already) {
    const nsB = strBytes(XMP_NS + '\0'); // 命名空间以 null 结尾
    const xmpB = strBytes(meta.xmp);
    const payloadLen = nsB.length + xmpB.length;
    const seg = new Uint8Array(4 + payloadLen);
    seg[0] = 0xff; seg[1] = 0xe1; // APP1
    new DataView(seg.buffer).setUint16(2, payloadLen + 2);
    seg.set(nsB, 4);
    seg.set(xmpB, 4 + nsB.length);
    parts.push(seg);

    // 兜底：再写一条人类可读 COM 注释
    const com = strBytes('AI-generated by WorkHogee | asset=' + meta.assetId + ' | ' + meta.iso);
    if (com.length + 2 <= 65533) {
      const comSeg = new Uint8Array(4 + com.length);
      comSeg[0] = 0xff; comSeg[1] = 0xfe;
      new DataView(comSeg.buffer).setUint16(2, com.length + 2);
      comSeg.set(com, 4);
      parts.push(comSeg);
    }
  }
  parts.push(u.slice(2));
  return concat(parts);
}

/**
 * 给 base64 成品图注入隐式 AI 标识。
 * @param {string} b64 纯 base64（无 data: 前缀）
 * @param {object} [opts]
 * @returns {{b64:string, stamped:boolean, mime:string}}
 */
export function stampImageMeta(b64, opts = {}) {
  try {
    const iso = new Date().toISOString();
    const assetId = opts.assetId || ('wh-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 8));
    const meta = { assetId, iso, xmp: buildXmp({ assetId, iso }) };

    const u = b64ToBytes(b64);
    let out = null;
    let mime = 'image/png';
    if (u[0] === 0xff && u[1] === 0xd8) { out = stampJpeg(u, meta); mime = 'image/jpeg'; }
    else if (u[0] === 0x89 && u[1] === 0x50) { out = stampPng(u, meta); mime = 'image/png'; }
    // webp / gif 等暂不注入，原样返回
    if (!out) return { b64, stamped: false, mime: 'image/unknown' };
    return { b64: bytesToB64(out), stamped: true, mime, assetId };
  } catch {
    return { b64, stamped: false, mime: 'image/unknown' };
  }
}
