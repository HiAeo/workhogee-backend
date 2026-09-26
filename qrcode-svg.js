/* =====================================================================
 * WorkHogee · 自包含 QR 码生成（qrcode-svg.js，无第三方依赖）
 * ---------------------------------------------------------------------
 * 支持：字节模式（UTF-8）、纠错等级 M、版本 1–6（数据容量最大 108 字节，
 * 远超短链所需）、8 种掩码按惩罚分择优。输出布尔矩阵或可缩放 SVG。
 * 算法依据 ISO/IEC 18004，离线同域生成，适合海报/立牌高清印刷。
 * ===================================================================*/

// GF(256) 指数/对数表（本原多项式 0x11D）
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
function gfMul(a, b) { if (a === 0 || b === 0) return 0; return EXP[LOG[a] + LOG[b]]; }

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly;
}
function rsEncode(data, ecLen) {
  // poly[k] 为生成多项式 x^k 系数（poly[ecLen]=1 为首项）
  const poly = rsGeneratorPoly(ecLen);
  const acc = data.slice().concat(new Array(ecLen).fill(0)); // 消息左移 ecLen 位，高次在前
  for (let i = 0; i < data.length; i++) {
    const coef = acc[i];
    if (coef === 0) continue;
    // 用生成多项式首项消去 acc[i]；j=0 为首 1（消自身），从 j=1 起
    for (let j = 1; j <= ecLen; j++) acc[i + j] ^= gfMul(poly[ecLen - j], coef);
  }
  return acc.slice(data.length);
}

// 纠错等级 M 参数（版本 1–6）
const M_DATA_CW = [0, 16, 28, 44, 64, 86, 108];
const M_EC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16];
const M_BLOCKS = [0, 1, 1, 1, 2, 2, 4];
const ALIGN = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];

function utf8Bytes(str) { return Array.from(new TextEncoder().encode(str)); }

function chooseVersion(byteLen) {
  // 字节模式：4 bit 模式 + 8 bit 计数 + 8*n；保守按整字节需求
  const needBits = 4 + 8 + byteLen * 8;
  for (let v = 1; v <= 6; v++) {
    if (M_DATA_CW[v] * 8 >= needBits + 4) return v;
  }
  throw new Error('内容过长，超出 QR 版本 6 容量');
}

function buildCodewords(text, version) {
  const bytes = utf8Bytes(text);
  const dataCw = M_DATA_CW[version];
  const bits = [];
  const pushBits = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  pushBits(0b0100, 4);                 // 字节模式
  pushBits(bytes.length, 8);          // 字符计数（v1–9 为 8 bit）
  for (const b of bytes) pushBits(b, 8);
  const totalDataBits = dataCw * 8;
  for (let i = 0; i < 4 && bits.length < totalDataBits; i++) bits.push(0); // 终止符
  while (bits.length % 8) bits.push(0);                                     // 补齐字节
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }
  for (let pad = 0; data.length < dataCw; pad++) data.push(pad % 2 ? 0x11 : 0xec);

  const blocks = M_BLOCKS[version];
  const perBlock = dataCw / blocks;
  const ecLen = M_EC_PER_BLOCK[version];
  const dataBlocks = [], ecBlocks = [];
  for (let i = 0; i < blocks; i++) {
    const slice = data.slice(i * perBlock, (i + 1) * perBlock);
    dataBlocks.push(slice);
    ecBlocks.push(rsEncode(slice, ecLen));
  }
  const out = [];
  for (let i = 0; i < perBlock; i++) for (let b = 0; b < blocks; b++) out.push(dataBlocks[b][i]);
  for (let i = 0; i < ecLen; i++) for (let b = 0; b < blocks; b++) out.push(ecBlocks[b][i]);
  return out;
}

function newMatrix(size) {
  return { size, m: Array.from({ length: size }, () => new Array(size).fill(false)), f: Array.from({ length: size }, () => new Array(size).fill(false)) };
}
function setMod(g, r, c, v, isFunc) {
  if (r < 0 || c < 0 || r >= g.size || c >= g.size) return;
  g.m[r][c] = v; g.f[r][c] = isFunc || g.f[r][c];
}
function placeFinder(g, r0, c0) {
  for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
    const rr = r0 + r, cc = c0 + c;
    if (rr < 0 || cc < 0 || rr >= g.size || cc >= g.size) continue;
    const edge = r === 0 || r === 6 || c === 0 || c === 6;
    const center = r >= 2 && r <= 4 && c >= 2 && c <= 4;
    const sep = r === -1 || r === 7 || c === -1 || c === 7;
    setMod(g, rr, cc, sep ? false : (edge || center), true);
  }
}
function placeAlignment(g, version) {
  const centers = ALIGN[version];
  for (const r of centers) for (const c of centers) {
    if (g.f[r][c]) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      const edge = dr === -2 || dr === 2 || dc === -2 || dc === 2;
      const dot = dr === 0 && dc === 0;
      setMod(g, r + dr, c + dc, edge || dot, true);
    }
  }
}
function setupFunctionModules(g, version) {
  const n = g.size;
  placeFinder(g, 0, 0); placeFinder(g, 0, n - 7); placeFinder(g, n - 7, 0);
  // 定时图案
  for (let i = 8; i < n - 8; i++) {
    setMod(g, 6, i, i % 2 === 0, true);
    setMod(g, i, 6, i % 2 === 0, true);
  }
  // 预留格式信息（跳过 (8,6)/(6,8) 两个 timing 交点，它们保持定时图案深色）
  for (let i = 0; i < 9; i++) {
    if (i !== 6) setMod(g, 8, i, false, true);
    if (i !== 6) setMod(g, i, 8, false, true);
  }
  for (let i = n - 8; i < n; i++) { setMod(g, 8, i, false, true); setMod(g, i, 8, false, true); }
  setMod(g, 8, n - 8, false, true);
  placeAlignment(g, version);
  setMod(g, n - 8, 8, true, true); // 固定深色模块
}
function placeData(g, codewords) {
  const n = g.size;
  let bitIdx = 0;
  const total = codewords.length * 8;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let i = 0; i < n; i++) {
      const upward = Math.floor((n - 1 - col) / 2) % 2 === 0;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        const r = upward ? n - 1 - i : i;
        if (!g.f[r][c]) {
          const bit = bitIdx < total ? ((codewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1) : 0;
          setMod(g, r, c, bit === 1, false);
          bitIdx++;
        }
      }
    }
  }
}
function maskBit(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
  return false;
}
function applyMask(g, mask) {
  for (let r = 0; r < g.size; r++) for (let c = 0; c < g.size; c++)
    if (!g.f[r][c] && maskBit(mask, r, c)) g.m[r][c] = !g.m[r][c];
}
function formatBits(mask) {
  // 纠错等级 M（indicator 00）的标准格式信息常量表（已含 BCH 与 XOR 0x5412）
  const FORMAT_M = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];
  return FORMAT_M[mask & 7];
}
function drawFormat(g, mask) {
  const bits = formatBits(mask);
  const n = g.size;
  const set = (r, c, i) => setMod(g, r, c, ((bits >> i) & 1) === 1, true);
  for (let i = 0; i < 15; i++) {
    // 纵向（col=8）：bit0-5 在 row0-5；bit6-7 在 row7-8；bit8-14 在 row n-7..n-1
    if (i < 6) set(i, 8, i);
    else if (i < 8) set(i + 1, 8, i);
    else set(n - 15 + i, 8, i);
    // 横向（row=8）：bit0-7 在 col n-1..n-8；bit8 在 col7；bit9-14 在 col5..0
    if (i < 8) set(8, n - 1 - i, i);
    else if (i === 8) set(8, 7, i);
    else set(8, 14 - i, i);
  }
  setMod(g, n - 8, 8, true, true); // 固定深色模块
}
function penalty(g) {
  const n = g.size, m = g.m;
  let score = 0;
  const run = (line) => {
    let s = 0, color = line[0], runLen = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === color) { runLen++; if (runLen === 5) s += 3; else if (runLen > 5) s++; }
      else { color = line[i]; runLen = 1; }
      // 1011101 图案
    }
    return s;
  };
  for (let r = 0; r < n; r++) {
    score += run(m[r]);
    score += run(Array.from({ length: n }, (_, c) => m[c][r]));
  }
  // 1011101 前后浅色
  const pat = [1, 0, 1, 1, 1, 0, 1];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (c + 6 < n) { const seg = m[r].slice(c, c + 7); if (pat.every((v, i) => seg[i] === v)) { const pre = c >= 4 && m[r].slice(c - 4, c).every(v => !v); const post = c + 11 < n && m[r].slice(c + 7, c + 11).every(v => !v); if (pre || post) score += 40; } }
    if (r + 6 < n) { let ok = true; for (let k = 0; k < 7; k++) if (m[r + k][c] !== pat[k]) { ok = false; break; } if (ok) { const pre = r >= 4 && [0, 1, 2, 3].every(k => !m[r - 4 + k][c]); const post = r + 11 < n && [7, 8, 9, 10].every(k => !m[r + k][c]); if (pre || post) score += 40; } }
  }
  // 2x2 同色
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++)
    if (m[r][c] === m[r + 1][c] && m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c + 1]) score += 3;
  // 平衡
  let dark = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) dark++;
  const pct = dark * 100 / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

export function buildMatrix(text, version, mask) {
  const size = 17 + version * 4;
  const codewords = buildCodewords(text, version);
  const g = newMatrix(size);
  setupFunctionModules(g, version);
  placeData(g, codewords);
  applyMask(g, mask);
  drawFormat(g, mask);
  return { size, matrix: g.m, func: g.f, version, mask, score: penalty(g) };
}

export function qrMatrix(text) {
  const version = chooseVersion(utf8Bytes(text).length);
  const candidates = [];
  for (let mask = 0; mask < 8; mask++) candidates.push(buildMatrix(text, version, mask));
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];
  return { size: best.size, matrix: best.matrix, version, mask: best.mask };
}

export function qrSvg(text, opts = {}) {
  const { matrix, size } = qrMatrix(text);
  const fg = opts.fg || '#111111';
  const bg = opts.bg || '#ffffff';
  const quiet = opts.quiet != null ? opts.quiet : 2;
  const dim = size + quiet * 2;
  let rects = '';
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++)
    if (matrix[r][c]) rects += `M${c + quiet},${r + quiet}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="${bg}"/><path d="${rects}" fill="${fg}"/></svg>`;
}
