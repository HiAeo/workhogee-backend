/* =====================================================================
 * WorkHogee · 会员自助认证（member-auth.js，Cloudflare KV）
 * ---------------------------------------------------------------------
 * 面向注册会员（区别于 auth.js 的“管理员”）：
 *   - 会员用「手机号 / 邮箱 + 密码」自助注册、登录；
 *   - 密码 PBKDF2-SHA256 加盐哈希（复用 auth.js 的 createPasswordRecord）；
 *   - 登录账号唯一索引：KV key "acct:<账号小写>" -> memberId；
 *   - 会员会话独立前缀 "msession:<token>"，与管理员 "session:" 严格隔离，
 *     会员令牌绝不能访问 /api/admin。
 *
 * KV（binding：env.MEMBERS）
 *   member:<id>    会员对象（在 members.js 字段基础上追加
 *                  loginAccount / accountType / salt / hash / iter）
 *   acct:<account> memberId（注册时写入，保证账号唯一）
 *   msession:<tok> { id, account, name, status, plan }，TTL 30 天
 *
 * 内测期：注册会员默认 plan=free、quotaTotal=-1（不限量），登录即可出图，
 * 不做强制扣量；后续商业化时再在 /generate 里按套餐校验额度。
 * ===================================================================*/

import { createPasswordRecord, randomHex } from './auth.js';
import { createMember, getMember } from './members.js';

const ENCODER = new TextEncoder();
const MSESSION_TTL_SECONDS = 30 * 24 * 3600; // 会员会话 30 天

const ACCT_PREFIX = 'acct:';
const MEMBER_PREFIX = 'member:';
const MSESS_PREFIX = 'msession:';

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function clean(v, max = 120) {
  if (v === null || v === undefined) return '';
  return String(v).trim().slice(0, max);
}

export function normalizeAccount(account) {
  return clean(account, 120).toLowerCase();
}

// 接受手机号、邮箱作为会员登录账号；保留账号 workhogee 为官方运营管理员（仅密码登录、不可自助注册）
export const ADMIN_BOOTSTRAP_ACCOUNT = 'workhogee';
export function accountType(account) {
  const a = normalizeAccount(account);
  if (a === ADMIN_BOOTSTRAP_ACCOUNT) return 'admin';
  if (/^1[3-9]\d{9}$/.test(a)) return 'phone';
  if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(a)) return 'email';
  return null;
}

async function hashPassword(password, saltHex, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', ENCODER.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return bufToHex(bits);
}

async function verifyMemberPassword(password, member) {
  if (!member || !member.salt || !member.hash) return false;
  const iter = member.iter || 100000;
  const candidate = await hashPassword(password, member.salt, iter);
  if (candidate.length !== member.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) {
    diff |= candidate.charCodeAt(i) ^ member.hash.charCodeAt(i);
  }
  return diff === 0;
}

// 返回给前端的会员公开视图（绝不包含 salt / hash）
function publicMember(m) {
  return {
    id: m.id,
    account: m.loginAccount || m.email || m.phone || m.username || '',
    accountType: m.accountType || '',
    memberType: m.memberType || '',
    contactName: m.contactName || '',
    merchantName: m.merchantName || '',
    plan: m.plan || 'free',
    status: m.status || 'active',
    quotaTotal: Number.isFinite(Number(m.quotaTotal)) ? Number(m.quotaTotal) : -1,
    quotaUsed: Number.isFinite(Number(m.quotaUsed)) ? Number(m.quotaUsed) : 0,
    expiresAt: m.expiresAt || null,
    role: m.role === 'admin' ? 'admin' : 'member'
  };
}

async function issueSession(env, member) {
  const token = randomHex(32);
  const payload = {
    id: member.id,
    account: member.loginAccount,
    name: member.contactName || member.merchantName || member.loginAccount,
    status: member.status,
    plan: member.plan || 'free',
    role: member.role === 'admin' ? 'admin' : 'member'
  };
  await env.MEMBERS.put(MSESS_PREFIX + token, JSON.stringify(payload), {
    expirationTtl: MSESSION_TTL_SECONDS
  });
  return { token, expiresIn: MSESSION_TTL_SECONDS };
}

/** 会员自助注册：成功即签发会话（注册即登录） */
export async function registerMember(env, input) {
  if (!env.MEMBERS) return { ok: false, reason: 'storage_unavailable' };
  const body = input || {};
  const account = normalizeAccount(body.account);
  const type = accountType(account);
  if (!type) {
    return { ok: false, reason: 'bad_account', message: '请输入正确的手机号或邮箱作为登录账号' };
  }
  if (type === 'admin') {
    return { ok: false, reason: 'account_reserved', message: '该账号为官方保留账号，请直接登录' };
  }
  const password = String(body.password || '');
  if (password.length < 8 || password.length > 64) {
    return { ok: false, reason: 'weak_password', message: '密码长度需为 8-64 位' };
  }
  // 注册不再要求前端选择账号类型，缺省按个人会员；显式 enterprise 才记为企业
  const memberType = body.memberType === 'enterprise' ? 'enterprise' : 'personal';
  if (await env.MEMBERS.get(ACCT_PREFIX + account)) {
    return { ok: false, reason: 'account_exists', message: '该账号已注册，请直接登录' };
  }

  const fields = {
    source: 'web',
    contactName: clean(body.contactName, 60),
    merchantName: clean(body.merchantName, 120)
  };
  if (type === 'phone') fields.phone = account;
  else fields.email = account;
  fields.username = account; // 后台“登录账号”列

  const created = await createMember(env, fields);
  if (!created.ok) return created;
  const member = created.member;

  const rec = await createPasswordRecord(password);
  member.loginAccount = account;
  member.accountType = type;
  member.memberType = memberType;
  member.salt = rec.salt;
  member.hash = rec.hash;
  member.iter = rec.iter;
  member.passwordUpdatedAt = rec.updatedAt;

  await env.MEMBERS.put(MEMBER_PREFIX + member.id, JSON.stringify(member));
  await env.MEMBERS.put(ACCT_PREFIX + account, member.id);

  const sess = await issueSession(env, member);
  return { ok: true, token: sess.token, expiresIn: sess.expiresIn, member: publicMember(member) };
}

/** 会员登录 */
export async function loginMember(env, accountRaw, password) {
  if (!env.MEMBERS) return { ok: false, reason: 'storage_unavailable' };
  const account = normalizeAccount(accountRaw);
  if (!accountType(account)) {
    return { ok: false, reason: 'bad_credentials', message: '账号或密码错误' };
  }
  const id = await env.MEMBERS.get(ACCT_PREFIX + account);
  if (!id) {
    return { ok: false, reason: 'bad_credentials', message: '账号或密码错误' };
  }
  const member = await getMember(env, id);
  if (!member || !member.hash) {
    return { ok: false, reason: 'bad_credentials', message: '账号或密码错误' };
  }
  if (!(await verifyMemberPassword(String(password || ''), member))) {
    return { ok: false, reason: 'bad_credentials', message: '账号或密码错误' };
  }
  if (member.status === 'suspended') {
    return { ok: false, reason: 'suspended', message: '账号已停用，请联系客服' };
  }
  member.lastLoginAt = Date.now();
  await env.MEMBERS.put(MEMBER_PREFIX + member.id, JSON.stringify(member));

  const sess = await issueSession(env, member);
  return { ok: true, token: sess.token, expiresIn: sess.expiresIn, member: publicMember(member) };
}

export async function logoutMember(env, token) {
  if (token) await env.MEMBERS.delete(MSESS_PREFIX + token);
  return { ok: true };
}

/**
 * 校验会员会话（从 Authorization: Bearer <msession token>）。
 * 与管理员 getSession 使用不同 KV 前缀，天然隔离，无法越权访问 /api/admin。
 * 无效返回 null；有效返回 { token, id, account, name, status, plan }。
 */
export async function getMemberSession(env, request) {
  if (!env.MEMBERS) return null;
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+([A-Za-z0-9]+)$/);
  if (!m) return null;
  const token = m[1].trim();
  const sess = await env.MEMBERS.get(MSESS_PREFIX + token, 'json');
  if (!sess || !sess.id) return null;
  return { token, ...sess };
}

/* =====================================================================
 * 验证码登录 / 免密注册（内测演示码）
 *  - KV mcode:<account>  {code,attempts}  TTL 300s
 *  - KV mcoderl:<account> 限发标记        TTL 60s
 *  - 验证码正确：已注册→登录；未注册→免密自动注册（不设 hash，只能走验证码登录）
 * 内测阶段无短信/邮件企业通道，startLoginCode 回传 devCode 由前端明示，
 * 绝不假装已发短信；接入正式网关后改为仅在网关发送成功时返回 {ok:true}。
 * ===================================================================*/
const MCODE_PREFIX = 'mcode:';
const MCODE_RL_PREFIX = 'mcoderl:';
const MCODE_TTL = 300;
const MCODE_RL_TTL = 60;
const MCODE_MAX_ATTEMPTS = 5;

function genLoginCode() {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  let n = 0;
  for (let i = 0; i < 4; i++) n = (n * 256 + b[i]) >>> 0;
  return String(100000 + (n % 900000));
}

export async function startLoginCode(env, accountRaw) {
  if (!env.MEMBERS) return { ok: false, reason: 'storage_unavailable' };
  const account = normalizeAccount(accountRaw);
  if (!accountType(account)) {
    return { ok: false, reason: 'bad_account', message: '请输入正确的手机号或邮箱' };
  }
  if (accountType(account) === 'admin') {
    return { ok: false, reason: 'account_reserved', message: '官方账号请使用密码登录' };
  }
  const rlKey = MCODE_RL_PREFIX + account;
  if (await env.MEMBERS.get(rlKey)) {
    return { ok: false, reason: 'rate_limited', message: '发送太频繁，请 60 秒后再试' };
  }
  const code = genLoginCode();
  await env.MEMBERS.put(MCODE_PREFIX + account, JSON.stringify({ code: code, attempts: 0 }), { expirationTtl: MCODE_TTL });
  await env.MEMBERS.put(rlKey, '1', { expirationTtl: MCODE_RL_TTL });
  // TODO: 正式通道——手机走短信服务商、邮箱走邮件 API；当前内测回传演示码
  return {
    ok: true,
    devCode: code,
    channel: accountType(account) === 'phone' ? '短信（内测演示）' : '邮箱（内测演示）'
  };
}

async function createPasswordlessMember(env, account, type) {
  const fields = { source: 'web-code' };
  if (type === 'phone') fields.phone = account;
  else fields.email = account;
  fields.username = account;
  const created = await createMember(env, fields);
  if (!created.ok) return created;
  const member = created.member;
  member.loginAccount = account;
  member.accountType = type;
  member.memberType = 'personal';
  // 不设 salt/hash：该账号只能验证码登录，后续补设密码后才可密码登录
  await env.MEMBERS.put(MEMBER_PREFIX + member.id, JSON.stringify(member));
  await env.MEMBERS.put(ACCT_PREFIX + account, member.id);
  return { ok: true, member: member };
}

export async function verifyCodeAuth(env, accountRaw, codeRaw) {
  if (!env.MEMBERS) return { ok: false, reason: 'storage_unavailable' };
  const account = normalizeAccount(accountRaw);
  const type = accountType(account);
  if (!type) return { ok: false, reason: 'bad_account', message: '请输入正确的手机号或邮箱' };
  if (type === 'admin') return { ok: false, reason: 'account_reserved', message: '官方账号请使用密码登录' };
  const code = String(codeRaw || '').trim();
  if (!/^\d{4,8}$/.test(code)) return { ok: false, reason: 'bad_code', message: '请输入收到的验证码' };

  const rec = await env.MEMBERS.get(MCODE_PREFIX + account, 'json');
  if (!rec || !rec.code) return { ok: false, reason: 'bad_code', message: '验证码已失效，请重新获取' };
  if ((rec.attempts | 0) >= MCODE_MAX_ATTEMPTS) {
    await env.MEMBERS.delete(MCODE_PREFIX + account);
    return { ok: false, reason: 'too_many', message: '错误次数过多，请重新获取验证码' };
  }
  if (String(rec.code) !== code) {
    await env.MEMBERS.put(
      MCODE_PREFIX + account,
      JSON.stringify({ code: rec.code, attempts: (rec.attempts | 0) + 1 }),
      { expirationTtl: MCODE_TTL }
    );
    return { ok: false, reason: 'bad_code', message: '验证码不正确' };
  }
  await env.MEMBERS.delete(MCODE_PREFIX + account);
  await env.MEMBERS.delete(MCODE_RL_PREFIX + account);

  const id = await env.MEMBERS.get(ACCT_PREFIX + account);
  let member;
  if (id) {
    member = await getMember(env, id);
    if (!member) return { ok: false, reason: 'not_found', message: '账号异常，请联系客服' };
    if (member.status === 'suspended') return { ok: false, reason: 'suspended', message: '账号已停用，请联系客服' };
    member.lastLoginAt = Date.now();
    await env.MEMBERS.put(MEMBER_PREFIX + member.id, JSON.stringify(member));
  } else {
    const cr = await createPasswordlessMember(env, account, type);
    if (!cr.ok) return cr;
    member = cr.member;
  }
  const sess = await issueSession(env, member);
  return { ok: true, token: sess.token, expiresIn: sess.expiresIn, member: publicMember(member) };
}

/* =====================================================================
 * 官方运营管理员引导账号（仅密码登录、不可自助注册 / 不可验证码登录）
 * 账号 workhogee、role='admin'，用于前台工作台「Hogee上新」官方素材墙的
 * 上传与删除；密码只取环境变量 ADMIN_MEMBER_PASSWORD（未配置则不创建引导账号），源码内不内置任何默认密码。
 * 冷启动幂等：账号已存在则确保 role=admin；调用方用模块级 Promise 缓存，
 * 每个 isolate 只真正执行一次。
 * ===================================================================*/
let _bootstrapAdminPromise = null;
export function ensureBootstrapAdmin(env) {
  if (!env || !env.MEMBERS) return Promise.resolve(false);
  if (_bootstrapAdminPromise) return _bootstrapAdminPromise;
  _bootstrapAdminPromise = (async () => {
    try {
      const account = ADMIN_BOOTSTRAP_ACCOUNT;
      const existingId = await env.MEMBERS.get(ACCT_PREFIX + account);
      if (existingId) {
        const ex = await getMember(env, existingId);
        if (ex && ex.role !== 'admin') {
          ex.role = 'admin';
          ex.status = 'active';
          await env.MEMBERS.put(MEMBER_PREFIX + ex.id, JSON.stringify(ex));
        }
        return true;
      }
      if (!env.ADMIN_MEMBER_PASSWORD) { _bootstrapAdminPromise = null; return false; }
      const password = String(env.ADMIN_MEMBER_PASSWORD);
      const created = await createMember(env, {
        source: 'manual',
        contactName: 'WorkHogee 官方',
        username: account
      });
      if (!created.ok) { _bootstrapAdminPromise = null; return false; }
      const member = created.member;
      const rec = await createPasswordRecord(password);
      member.loginAccount = account;
      member.accountType = 'admin';
      member.role = 'admin';
      member.plan = 'beta';
      member.status = 'active';
      member.salt = rec.salt;
      member.hash = rec.hash;
      member.iter = rec.iter;
      member.passwordUpdatedAt = rec.updatedAt;
      await env.MEMBERS.put(MEMBER_PREFIX + member.id, JSON.stringify(member));
      await env.MEMBERS.put(ACCT_PREFIX + account, member.id);
      return true;
    } catch (e) {
      _bootstrapAdminPromise = null; // 出错允许下次请求重试
      return false;
    }
  })();
  return _bootstrapAdminPromise;
}
