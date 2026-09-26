/* =====================================================================
 * WorkHogee · 会员数据层（members.js，Cloudflare KV）
 * ---------------------------------------------------------------------
 * 产品定位：面向全行业的「AI 生意伙计」工作台。
 *   五个伙计能力：阿图(生图) / 阿文(文案) / 阿视(视频) / 阿发(分发) / 阿果(效果)；
 *   两个端：Hogee Web 工作台、Hogee 微信小程序。
 *
 * 重要口径（与官网/工作台一致）：
 *   - 不再按「二手品类」做会员授权，也不存在任何行业限定；
 *     CAPABILITIES 是只读的产品能力版图，内测期会员默认享有全部已上线能力，
 *     不做逐能力开关。
 *   - 内测期统一一个会员档位（PLANS，内测会员，不限量、不在前台展示价格）；
 *     商业化档位随经营主体与定价方案上线后再扩展。
 *
 * KV（binding：env.MEMBERS）
 *   member:<id>   会员对象
 *   acct:<account> memberId（自助注册账号唯一索引，见 member-auth.js）
 *
 * 兼容：历史会员可能带有 products(旧品类授权) / plan=free|monthly... 等字段，
 *   本层读取时统一归一展示，不强制改写、不删除历史数据。
 * ===================================================================*/

export const KV_PREFIX = 'member:';

export function genId() {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return 'm_' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

/* ---------------- 产品能力版图（只读，描述当前产品，不做逐会员授权） ---------- */
export const CAPABILITIES = [
  {
    id: 'atu', kind: 'mate', name: '阿图 · 生图伙计', short: '阿图',
    status: 'available',
    desc: '手机随手拍，自动识别商品并匹配行业知识库，约 20 秒生成可上架的商品图与动态图；规格、清晰度、多平台尺寸一次出齐。',
    apps: ['web', 'mp']
  },
  {
    id: 'awen', kind: 'mate', name: '阿文 · 文案伙计', short: '阿文',
    status: 'available',
    desc: '基于商品事实卡与受众、渠道，生成小红书、抖音、朋友圈等多版本标题、正文与卖点；合规词库双审，缺失事实主动追问、不编造。',
    apps: ['web', 'mp']
  },
  {
    id: 'ashi', kind: 'mate', name: '阿视 · 视频伙计', short: '阿视',
    status: 'available',
    desc: '把阿图的商品图与阿文的文案自动分镜，前端合成可直接发抖音 / 小红书 / 视频号 / 朋友圈的竖版或方形短视频与 GIF（图文成片）；AI 图生视频让静态照片真实运动，即将开放。',
    apps: ['web']
  },
  {
    id: 'afa', kind: 'mate', name: '阿发 · 分发伙计', short: '阿发',
    status: 'beta',
    desc: '把图文打包成各渠道就绪素材：小红书 / 抖音就绪包、朋友圈企微半自动；公众号草稿、微博、闲鱼、视频号等按资质逐步接通。',
    apps: ['web']
  },
  {
    id: 'aguo', kind: 'mate', name: '阿果 · 效果伙计', short: '阿果',
    status: 'available',
    desc: 'H5 画册、渠道短链与二维码归因，回收浏览、留资与线索，第一方效果看板让每张图、每条内容的效果可量化。',
    apps: ['web', 'mp']
  },
  {
    id: 'web', kind: 'app', name: 'Hogee Web 工作台', short: 'Web',
    status: 'available',
    desc: '浏览器打开即用的对话式工作台，技能、插件与伙计协同，原图与成品跨端同步。',
    apps: []
  },
  {
    id: 'mp', kind: 'app', name: 'Hogee 微信小程序', short: '小程序',
    status: 'soon',
    desc: '手机端随拍随生、随时分发与查看效果；正式版待小程序经营主体与认证完成后开放。',
    apps: []
  }
];

/* ---------------- 会员档位（内测期统一一个，不限量、不展示价格） ------------- */
export const PLANS = [
  {
    id: 'beta',
    name: '内测会员',
    price: '内测期',
    quotaText: '不限生成量',
    watermark: false,
    desc: '内测阶段注册即享，全行业通用，伙计能力随产品版本持续更新。',
    features: [
      '阿图生图与动态图（多平台尺寸）',
      '阿文多渠道文案与合规校验',
      '阿视图文成片短视频与 GIF（AI 图生视频即将开放）',
      '阿发渠道就绪素材（按渠道逐步开通）',
      '阿果效果看板与 H5 画册',
      'Web 工作台，小程序就绪后同步开放'
    ]
  }
];

export const MEMBER_STATUS = [
  { id: 'active', name: '正常' },
  { id: 'pending', name: '待激活' },
  { id: 'suspended', name: '已停用' }
];

// 注册 / 录入来源（client 为历史客户端来源，保留以兼容旧数据展示）
export const SOURCES = [
  { id: 'web', name: '网页注册' },
  { id: 'miniprogram', name: '小程序注册' },
  { id: 'client', name: '客户端注册' },
  { id: 'manual', name: '后台添加' }
];

export const ACCOUNT_TYPES = [
  { id: 'phone', name: '手机号' },
  { id: 'email', name: '邮箱' }
];

export const MEMBER_TYPES = [
  { id: 'personal', name: '个人' },
  { id: 'enterprise', name: '企业' }
];

const STATUS_IDS = new Set(MEMBER_STATUS.map(s => s.id));
const SOURCE_IDS = new Set(SOURCES.map(s => s.id));
const MTYPE_IDS = new Set(MEMBER_TYPES.map(t => t.id));

/* ---------------- 归一化辅助（兼容历史数据） ---------------- */
export function inferAccountType(m) {
  if (m.accountType === 'phone' || m.accountType === 'email') return m.accountType;
  if (m.phone) return 'phone';
  if (m.email) return 'email';
  const a = String(m.loginAccount || m.username || '');
  if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(a)) return 'email';
  if (/^1[3-9]\d{9}$/.test(a)) return 'phone';
  return '';
}
export function displayAccount(m) {
  return m.loginAccount || m.username || m.phone || m.email || '';
}
export function displayMemberType(m) {
  return MTYPE_IDS.has(m.memberType) ? m.memberType : 'personal';
}
// 内测期统一档位：历史 plan(free/monthly/...) 一律归一显示为内测会员
export function displayPlan() { return 'beta'; }
export function planName(id) {
  const p = PLANS.find(x => x.id === (id || 'beta'));
  return p ? p.name : PLANS[0].name;
}

// 账号字符串（登录名 / 用户名 / 邮箱 / 手机号）
export function memberAccount(m) {
  return String(m.loginAccount || m.username || m.email || m.phone || '').toLowerCase().trim();
}

/* ---------------- 测试 / 虚拟账号识别 ----------------
 * 历次真机 / 端到端回归经注册接口造出的账号都带明显特征：
 *   - 测试域名：@example.com、@test.workhogee.com
 *   - 本地部分前缀 / 标记：smoke<数字>、showcase<数字>、uc<数字>、
 *     hogeeqa、ashi-qa、hogee.test/e2e/smoke/clean/mob
 * 管理后台的列表、统计、导出统一隐藏这些账号；正常手机号与商户邮箱不受影响。
 * 真实管理员（workhogee）与真实注册账号不会命中。 */
export function isTestMember(m) {
  const s = memberAccount(m);
  if (!s) return false;
  if (s.endsWith('@example.com') || s.endsWith('@test.workhogee.com')) return true;
  const local = s.split('@')[0];
  if (/^(smoke|showcase)\d/.test(local)) return true;
  if (/^uc\d/.test(local)) return true;
  if (local.includes('hogeeqa') || local.includes('ashi-qa')) return true;
  return ['hogee.test', 'hogee.e2e', 'hogee.smoke', 'hogee.clean', 'hogee.mob']
    .some(t => local.includes(t));
}

function clean(v, max = 120) {
  if (v === null || v === undefined) return '';
  return String(v).trim().slice(0, max);
}
function lower(v) { return clean(v, 120).toLowerCase(); }
function tsFromDate(v) {
  if (!v) return null;
  const t = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/* ---------------- 字段白名单（后台新增 / 编辑） ---------------- */
function applyInput(member, input) {
  const i = input || {};
  if (typeof i.merchantName === 'string') member.merchantName = clean(i.merchantName, 120);
  if (typeof i.contactName === 'string') member.contactName = clean(i.contactName, 60);
  if (typeof i.phone === 'string') member.phone = clean(i.phone, 24);
  if (typeof i.email === 'string') member.email = lower(i.email);
  if (typeof i.username === 'string') member.username = clean(i.username, 120);
  if (typeof i.note === 'string') member.note = clean(i.note, 500);

  if (typeof i.memberType === 'string') {
    member.memberType = MTYPE_IDS.has(i.memberType) ? i.memberType : member.memberType || 'personal';
  }
  if (typeof i.source === 'string') {
    member.source = SOURCE_IDS.has(i.source) ? i.source : (member.source || 'manual');
  }
  if (typeof i.status === 'string') {
    member.status = STATUS_IDS.has(i.status) ? i.status : member.status;
  }
  // 内测期统一档位，忽略历史多档入参
  member.plan = 'beta';

  if (i.expiresAt !== undefined) member.expiresAt = tsFromDate(i.expiresAt);

  // 账号类型：后台录入若未显式给出，则按手机/邮箱推断
  if (!member.accountType) member.accountType = inferAccountType(member);
  return member;
}

/* ---------------- CRUD ---------------- */
export async function createMember(env, input) {
  if (!env.MEMBERS) return { ok: false, error: { message: '存储未配置' } };
  const now = Date.now();
  const member = {
    id: genId(),
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,

    merchantName: '',
    contactName: '',
    phone: '',
    email: '',
    username: '',

    loginAccount: '',
    accountType: '',
    memberType: 'personal',

    note: '',
    status: 'active',
    plan: 'beta',
    source: 'manual',

    quotaTotal: -1, // -1 表示内测期不限量
    quotaUsed: 0,
    expiresAt: null
  };
  applyInput(member, input);

  if (!member.merchantName && !member.contactName && !member.phone && !member.email && !member.username && !member.loginAccount) {
    return { ok: false, error: { message: '请至少填写手机号、邮箱、登录账号、联系人或商户名称中的一项' } };
  }
  await env.MEMBERS.put(KV_PREFIX + member.id, JSON.stringify(member));
  return { ok: true, member };
}

export async function getMember(env, id) {
  if (!env.MEMBERS || !id) return null;
  return env.MEMBERS.get(KV_PREFIX + id, 'json');
}

export async function listAllMembers(env) {
  if (!env.MEMBERS) return [];
  const listed = await env.MEMBERS.list({ prefix: KV_PREFIX });
  const vals = await Promise.all(listed.keys.map(k => env.MEMBERS.get(k.name, 'json')));
  return vals.filter(Boolean).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function updateMember(env, id, input) {
  const existing = await getMember(env, id);
  if (!existing) return { ok: false, status: 404, error: { message: '会员不存在' } };
  const member = applyInput({ ...existing }, input);
  member.updatedAt = Date.now();
  await env.MEMBERS.put(KV_PREFIX + id, JSON.stringify(member));
  return { ok: true, member };
}

export async function deleteMember(env, id) {
  if (!env.MEMBERS) return { ok: false, error: { message: '存储未配置' } };
  const m = await getMember(env, id);
  if (!m) return { ok: false, status: 404, error: { message: '会员不存在' } };
  await env.MEMBERS.delete(KV_PREFIX + id);
  // 清理自助注册账号唯一索引（若存在）
  const acct = m.loginAccount || m.username || '';
  if (acct) await env.MEMBERS.delete('acct:' + acct.toLowerCase());
  return { ok: true };
}

/* ---------------- 统计（仅真实可计算指标） ---------------- */
export function computeStats(members) {
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const stats = {
    total: members.length,
    active: 0, pending: 0, suspended: 0,
    newToday: 0, new7d: 0,
    loggedIn: 0, active7d: 0,
    byAccountType: { phone: 0, email: 0, unknown: 0 },
    byMemberType: { personal: 0, enterprise: 0 },
    bySource: {}
  };
  for (const m of members) {
    if (m.status === 'active') stats.active++;
    else if (m.status === 'suspended') stats.suspended++;
    else stats.pending++;

    if (m.createdAt && now - m.createdAt < day) stats.newToday++;
    if (m.createdAt && now - m.createdAt < 7 * day) stats.new7d++;
    if (m.lastLoginAt) {
      stats.loggedIn++;
      if (now - m.lastLoginAt < 7 * day) stats.active7d++;
    }

    const at = inferAccountType(m);
    if (at === 'phone') stats.byAccountType.phone++;
    else if (at === 'email') stats.byAccountType.email++;
    else stats.byAccountType.unknown++;

    stats.byMemberType[displayMemberType(m)]++;

    const src = m.source || 'manual';
    stats.bySource[src] = (stats.bySource[src] || 0) + 1;
  }
  return stats;
}

/* ---------------- CSV 导出 ---------------- */
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}
function fmtTs(ts) {
  if (!ts) return '';
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
const TYPE_LABEL = { phone: '手机号', email: '邮箱', '': '—' };
const MTYPE_LABEL = { personal: '个人', enterprise: '企业' };
function sourceLabel(id) { return (SOURCES.find(s => s.id === id) || {}).name || (id || '后台添加'); }
function statusLabel(id) { return (MEMBER_STATUS.find(s => s.id === id) || {}).name || (id || '正常'); }

export function membersToCSV(members) {
  const header = [
    '会员ID', '登录账号', '账号类型', '会员类型', '联系人', '商户名称',
    '手机号', '邮箱', '状态', '套餐', '来源', '注册时间', '最近登录', '到期时间', '备注'
  ];
  const rows = members.map(m => [
    m.id,
    displayAccount(m),
    TYPE_LABEL[inferAccountType(m)] || '—',
    MTYPE_LABEL[displayMemberType(m)],
    m.contactName,
    m.merchantName,
    m.phone,
    m.email,
    statusLabel(m.status),
    planName(m.plan),
    sourceLabel(m.source),
    fmtTs(m.createdAt),
    fmtTs(m.lastLoginAt),
    fmtTs(m.expiresAt),
    m.note
  ].map(csvCell).join(','));
  return '\uFEFF' + header.join(',') + '\n' + rows.join('\n');
}

/* =====================================================================
 * 额度 / 配额（M2.2 支付回补）
 * ---------------------------------------------------------------------
 * 内测期 beta 会员 monthlyQuota=-1（不限量），但仍写 quotaUsed 用于埋点统计；
 * 后续商业化时改为正数月度配额 + topup 叠加包。
 * ===================================================================*/

function nextMonthResetTs() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
}

export async function getMemberQuota(env, memberId) {
  if (!env.MEMBERS || !memberId) {
    return { ok: false, error: 'storage_unavailable' };
  }
  const m = await getMember(env, memberId);
  if (!m) return { ok: false, error: 'member_not_found' };

  const monthlyQuota = Number.isFinite(Number(m.quotaTotal)) ? Number(m.quotaTotal) : -1;
  const now = Date.now();
  let resetAt = Number(m.monthlyResetAt) || 0;
  if (!resetAt || resetAt < now) {
    resetAt = nextMonthResetTs();
    m.quotaUsed = 0;
    m.monthlyResetAt = resetAt;
    await env.MEMBERS.put(KV_PREFIX + memberId, JSON.stringify(m));
  }
  const monthlyUsed = Number(m.quotaUsed) || 0;
  const monthlyRemaining = monthlyQuota === -1 ? -1 : Math.max(0, monthlyQuota - monthlyUsed);
  const topupBalance = Number(m.topupBalance) || 0;
  const totalAvailable = monthlyRemaining === -1 ? -1 : (monthlyRemaining + topupBalance);

  return {
    ok: true,
    monthlyQuota,
    monthlyUsed,
    monthlyRemaining,
    topupBalance,
    totalAvailable,
    monthlyResetAt: resetAt
  };
}

export async function checkAndDeductQuota(env, memberId, cost = 1) {
  if (!env.MEMBERS || !memberId) {
    return { ok: false, reason: 'storage_unavailable' };
  }
  const m = await getMember(env, memberId);
  if (!m) return { ok: false, reason: 'member_not_found' };

  const now = Date.now();
  let resetAt = Number(m.monthlyResetAt) || 0;
  if (!resetAt || resetAt < now) {
    resetAt = nextMonthResetTs();
    m.quotaUsed = 0;
  }

  const monthlyQuota = Number.isFinite(Number(m.quotaTotal)) ? Number(m.quotaTotal) : -1;
  const monthlyUsed = Number(m.quotaUsed) || 0;
  let topupBalance = Number(m.topupBalance) || 0;

  const monthlyRemaining = monthlyQuota === -1 ? -1 : Math.max(0, monthlyQuota - monthlyUsed);
  if (monthlyRemaining !== -1 && monthlyRemaining <= 0 && topupBalance <= 0) {
    return { ok: false, reason: 'quota_exhausted', message: '本月生成额度已用完，请购买叠加包或等待下月重置' };
  }

  let deductedFrom = 'monthly';
  let newMonthlyUsed = monthlyUsed;
  let newTopup = topupBalance;
  if (monthlyQuota === -1) {
    newMonthlyUsed = monthlyUsed + cost;
    deductedFrom = 'monthly';
  } else if (monthlyRemaining >= cost) {
    newMonthlyUsed = monthlyUsed + cost;
    deductedFrom = 'monthly';
  } else {
    const fromMonthly = monthlyRemaining;
    const fromTopup = cost - fromMonthly;
    newMonthlyUsed = monthlyUsed + fromMonthly;
    newTopup = topupBalance - fromTopup;
    deductedFrom = fromMonthly > 0 ? 'mixed' : 'topup';
  }

  m.quotaUsed = newMonthlyUsed;
  m.topupBalance = newTopup;
  m.monthlyResetAt = resetAt;
  m.updatedAt = now;
  await env.MEMBERS.put(KV_PREFIX + memberId, JSON.stringify(m));

  const remaining = monthlyQuota === -1 ? -1 : Math.max(0, monthlyQuota - newMonthlyUsed);
  return {
    ok: true,
    deductedFrom,
    remaining,
    monthlyRemaining: remaining,
    topupBalance: newTopup,
    totalAvailable: remaining === -1 ? -1 : (remaining + newTopup)
  };
}
