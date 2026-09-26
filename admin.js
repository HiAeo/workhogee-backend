/* =====================================================================
 * WorkHogee · 管理后台 HTTP 路由层（admin.js）
 * ---------------------------------------------------------------------
 * 挂载在现有图像代理 Worker 上，统一前缀 /api/admin。
 * 除 /login 外，所有接口都要求请求头 Authorization: Bearer <会话令牌>，
 * 未登录或令牌失效一律 401 —— 静态后台页可以公开，但数据接口不公开。
 *
 * 会员模型：全行业「AI 生意伙计」，四伙计能力（阿图/阿文/阿发/阿果）+
 * 两端（Web 工作台 / 微信小程序）；内测期统一一个会员档位、不限量。
 * ===================================================================*/

import { loginAdmin, logoutAdmin, getSession, changeAdminPassword } from './auth.js';
import {
  CAPABILITIES, PLANS, MEMBER_STATUS, SOURCES, ACCOUNT_TYPES, MEMBER_TYPES,
  listAllMembers, getMember, createMember, updateMember, deleteMember,
  computeStats, membersToCSV, inferAccountType, displayAccount, displayMemberType,
  isTestMember
} from './members.js';

const ALLOWED_ORIGINS = [
  'https://www.workhogee.com', 'http://www.workhogee.com',
  'https://workhogee.com', 'http://workhogee.com',
  'https://hiaeo.github.io', 'http://hiaeo.github.io'
];
function corsHeaders(origin) {
  const allowDev = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const allow = (ALLOWED_ORIGINS.includes(origin) || allowDev) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function json(payload, status = 200, origin, extra = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=UTF-8', ...corsHeaders(origin), ...extra }
  });
}
function clientIp(req) {
  return req.headers.get('CF-Connecting-IP') ||
    req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown';
}
// 登录限流：每 IP 每分钟 8 次
const loginHits = new Map();
function loginRateLimited(ip) {
  const now = Date.now(), W = 60_000, MAX = 8;
  const arr = (loginHits.get(ip) || []).filter(t => now - t < W);
  arr.push(now); loginHits.set(ip, arr);
  if (loginHits.size > 5000) for (const [k, v] of loginHits) if (!v.some(t => now - t < W)) loginHits.delete(k);
  return arr.length > MAX;
}

async function readBody(req) {
  try { return await req.json(); } catch { return null; }
}

// 全行业会员模型过滤：账号、状态、来源、会员类型、账号类型
function filterMembers(all, qs) {
  let rows = all.slice();
  const q = (qs.get('q') || '').trim().toLowerCase();
  const status = qs.get('status') || '';
  const source = qs.get('source') || '';
  const memberType = qs.get('memberType') || '';
  const accountType = qs.get('accountType') || '';
  if (q) {
    rows = rows.filter(m =>
      [m.id, displayAccount(m), m.loginAccount, m.username, m.phone, m.email,
       m.merchantName, m.contactName, m.note]
        .filter(Boolean).some(s => String(s).toLowerCase().includes(q))
    );
  }
  if (status) rows = rows.filter(m => (m.status || 'active') === status);
  if (source) rows = rows.filter(m => (m.source || 'manual') === source);
  if (memberType) rows = rows.filter(m => displayMemberType(m) === memberType);
  if (accountType) rows = rows.filter(m => inferAccountType(m) === accountType);

  const sort = qs.get('sort') || 'createdAt';
  rows.sort((a, b) => {
    if (sort === 'merchantName') return String(a.merchantName || '').localeCompare(String(b.merchantName || ''), 'zh');
    if (sort === 'lastLoginAt') return (b.lastLoginAt || 0) - (a.lastLoginAt || 0);
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
  return rows;
}

function filterAndPaginate(all, qs) {
  const rows = filterMembers(all, qs);
  const total = rows.length;
  const pageSize = Math.min(100, Math.max(5, parseInt(qs.get('pageSize') || '20', 10) || 20));
  const page = Math.max(1, parseInt(qs.get('page') || '1', 10) || 1);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  return { items: rows.slice(start, start + pageSize), total, page: safePage, pageSize, totalPages };
}

function errBody(r, fallback) {
  return { ok: false, error: { code: (r.error && r.error.code) || r.reason || 'error', message: (r.error && r.error.message) || r.message || fallback } };
}

export async function handleAdmin(request, env, origin) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  // ---- 公开：登录 ----
  if (path === '/api/admin/login' && method === 'POST') {
    const ip = clientIp(request);
    if (loginRateLimited(ip)) return json({ ok: false, error: { code: 'rate_limited', message: '尝试过于频繁，请稍后再试' } }, 429, origin);
    const body = await readBody(request) || {};
    const r = await loginAdmin(env, body.username, body.password);
    if (!r.ok) {
      const msg = r.reason === 'not_initialized' ? '后台尚未初始化，请联系部署方' : '账号或密码错误';
      return json({ ok: false, error: { code: r.reason || 'denied', message: msg } }, 401, origin);
    }
    return json(r, 200, origin);
  }

  // ---- 以下全部需要登录 ----
  const session = await getSession(env, request);
  if (!session) return json({ ok: false, error: { code: 'unauthorized', message: '请先登录管理后台' } }, 401, origin);

  if (path === '/api/admin/me' && method === 'GET') {
    return json({ ok: true, admin: { username: session.username, name: session.name } }, 200, origin);
  }
  if (path === '/api/admin/logout' && method === 'POST') {
    const r = await logoutAdmin(env, session.token);
    return json(r, 200, origin);
  }
  if (path === '/api/admin/change-password' && method === 'POST') {
    const body = await readBody(request) || {};
    const r = await changeAdminPassword(env, session.username, body.oldPassword, body.newPassword);
    if (!r.ok) return json({ ok: false, error: { code: r.reason, message: r.message || '修改失败' } }, r.reason === 'weak_password' ? 400 : 401, origin);
    return json({ ok: true }, 200, origin);
  }
  if (path === '/api/admin/meta' && method === 'GET') {
    return json({
      ok: true,
      capabilities: CAPABILITIES,
      plans: PLANS,
      statuses: MEMBER_STATUS,
      sources: SOURCES,
      accountTypes: ACCOUNT_TYPES,
      memberTypes: MEMBER_TYPES
    }, 200, origin);
  }

  // ---- 会员导出（在 /:id 之前匹配），复用同一套筛选，不分页 ----
  if (path === '/api/admin/members/export.csv' && method === 'GET') {
    const all = (await listAllMembers(env)).filter(m => !isTestMember(m));
    const rows = filterMembers(all, url.searchParams);
    const csv = membersToCSV(rows);
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=UTF-8',
        'Content-Disposition': `attachment; filename="workhogee-members-${stamp}.csv"`,
        ...corsHeaders(origin)
      }
    });
  }

  // ---- 会员集合 ----
  if (path === '/api/admin/members' && method === 'GET') {
    const all = (await listAllMembers(env)).filter(m => !isTestMember(m));
    const page = filterAndPaginate(all, url.searchParams);
    return json({ ok: true, ...page, stats: computeStats(all) }, 200, origin);
  }
  if (path === '/api/admin/members' && method === 'POST') {
    const body = await readBody(request);
    const r = await createMember(env, body);
    if (!r.ok) return json(errBody(r, '新增失败'), 400, origin);
    return json(r, 201, origin);
  }

  // ---- 单个会员 ----
  const idMatch = path.match(/^\/api\/admin\/members\/(m_[0-9a-f]+)$/);
  if (idMatch) {
    const id = idMatch[1];
    if (method === 'GET') {
      const m = await getMember(env, id);
      if (!m) return json({ ok: false, error: { code: 'not_found', message: '会员不存在' } }, 404, origin);
      return json({ ok: true, member: m }, 200, origin);
    }
    if (method === 'PUT') {
      const body = await readBody(request);
      const r = await updateMember(env, id, body);
      if (!r.ok) return json(errBody(r, '更新失败'), r.status || 400, origin);
      return json(r, 200, origin);
    }
    if (method === 'DELETE') {
      const r = await deleteMember(env, id);
      if (!r.ok) return json(errBody(r, '删除失败'), r.status || 404, origin);
      return json(r, 200, origin);
    }
  }

  return json({ ok: false, error: { code: 'not_found', message: '接口不存在' } }, 404, origin);
}
