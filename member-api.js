/* =====================================================================
 * WorkHogee · 会员自助 HTTP 路由层（member-api.js）
 * ---------------------------------------------------------------------
 * 统一前缀 /api/member，供官网与 Web 工作台调用：
 *   POST /api/member/register   注册（手机号/邮箱 + 密码），注册即登录
 *   POST /api/member/login      登录
 *   POST /api/member/logout     登出（需会话）
 *   GET  /api/member/me         当前会员信息（需会话）
 * 注册 / 登录公开；其余接口要求 Authorization: Bearer <会员会话令牌>。
 * ===================================================================*/

import {
  registerMember, loginMember, logoutMember, getMemberSession,
  startLoginCode, verifyCodeAuth
} from './member-auth.js';

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
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
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
async function readBody(req) {
  try { return await req.json(); } catch { return null; }
}

// 注册 / 登录限流：每 IP 每分钟 10 次（防爆破、防批量注册）
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now(), W = 60_000, MAX = 10;
  const arr = (hits.get(ip) || []).filter(t => now - t < W);
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < W)) hits.delete(k);
  return arr.length > MAX;
}

export async function handleMember(request, env, origin) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  // ---- 公开：注册 ----
  if (path === '/api/member/register' && method === 'POST') {
    const ip = clientIp(request);
    if (rateLimited(ip)) {
      return json({ ok: false, error: { code: 'rate_limited', message: '操作过于频繁，请稍后再试' } }, 429, origin);
    }
    const body = await readBody(request) || {};
    const r = await registerMember(env, body);
    if (!r.ok) {
      const status = (r.reason === 'weak_password' || r.reason === 'bad_account' || r.reason === 'bad_member_type') ? 400
        : r.reason === 'account_exists' ? 409 : 500;
      return json({ ok: false, error: { code: r.reason || 'register_failed', message: r.message || '注册失败' } }, status, origin);
    }
    return json(r, 200, origin);
  }

  // ---- 公开：登录 ----
  if (path === '/api/member/login' && method === 'POST') {
    const ip = clientIp(request);
    if (rateLimited(ip)) {
      return json({ ok: false, error: { code: 'rate_limited', message: '尝试过于频繁，请稍后再试' } }, 429, origin);
    }
    const body = await readBody(request) || {};
    const r = await loginMember(env, body.account, body.password);
    if (!r.ok) {
      const status = r.reason === 'suspended' ? 403 : 401;
      return json({ ok: false, error: { code: r.reason || 'denied', message: r.message || '登录失败' } }, status, origin);
    }
    return json(r, 200, origin);
  }

  // ---- 公开：发送登录验证码（内测回传演示码，不假装发短信） ----
  if (path === '/api/member/send-code' && method === 'POST') {
    const ip = clientIp(request);
    if (rateLimited(ip)) {
      return json({ ok: false, error: { code: 'rate_limited', message: '操作过于频繁，请稍后再试' } }, 429, origin);
    }
    const body = await readBody(request) || {};
    const r = await startLoginCode(env, body.account);
    if (!r.ok) {
      const status = r.reason === 'rate_limited' ? 429 : r.reason === 'bad_account' ? 400 : 500;
      return json({ ok: false, error: { code: r.reason || 'send_failed', message: r.message || '验证码发送失败' } }, status, origin);
    }
    return json(r, 200, origin);
  }

  // ---- 公开：验证码登录 / 未注册则免密自动注册 ----
  if (path === '/api/member/code-auth' && method === 'POST') {
    const ip = clientIp(request);
    if (rateLimited(ip)) {
      return json({ ok: false, error: { code: 'rate_limited', message: '尝试过于频繁，请稍后再试' } }, 429, origin);
    }
    const body = await readBody(request) || {};
    const r = await verifyCodeAuth(env, body.account, body.code);
    if (!r.ok) {
      const status = r.reason === 'suspended' ? 403
        : (r.reason === 'bad_code' || r.reason === 'too_many' || r.reason === 'bad_account') ? 400 : 401;
      return json({ ok: false, error: { code: r.reason || 'denied', message: r.message || '验证失败' } }, status, origin);
    }
    return json(r, 200, origin);
  }

  // ---- 以下均需会员会话 ----
  const session = await getMemberSession(env, request);
  if (!session) {
    return json({ ok: false, error: { code: 'member_unauthorized', message: '请先登录会员账号' } }, 401, origin);
  }

  if (path === '/api/member/me' && method === 'GET') {
    return json({
      ok: true,
      member: {
        id: session.id,
        account: session.account,
        name: session.name,
        status: session.status,
        plan: session.plan,
        role: session.role === 'admin' ? 'admin' : 'member'
      }
    }, 200, origin);
  }

  if (path === '/api/member/logout' && method === 'POST') {
    const r = await logoutMember(env, session.token);
    return json(r, 200, origin);
  }

  return json({ ok: false, error: { code: 'not_found', message: '接口不存在' } }, 404, origin);
}
