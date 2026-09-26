/* =====================================================================
 * WorkHogee · 管理员认证（auth.js）
 * ---------------------------------------------------------------------
 * - 管理员账号存 KV key "admin:config"（用户名 + PBKDF2-SHA256 密码哈希）；
 * - 登录成功签发随机会话令牌，存 KV key "session:<token>"，TTL 7 天；
 * - 前端把令牌放在 Authorization: Bearer <token>，由 getSession 校验。
 * 纯 Web Crypto 实现，无第三方依赖；与 Python 种子脚本的 PBKDF2 参数对齐
 * （SHA-256 / iterations=100000 / dklen=32 / salt 为 16 字节随机 hex）。
 * ===================================================================*/

const ENCODER = new TextEncoder();
export const PBKDF2_ITERATIONS = 100000;
const SESSION_TTL_SECONDS = 7 * 24 * 3600; // 7 天

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
export function randomHex(byteLen = 16) {
  const arr = new Uint8Array(byteLen);
  crypto.getRandomValues(arr);
  return bufToHex(arr.buffer);
}

async function hashPassword(password, saltHex, iterations = PBKDF2_ITERATIONS) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', ENCODER.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return bufToHex(bits);
}

export async function createPasswordRecord(password) {
  const salt = randomHex(16);
  return {
    salt,
    hash: await hashPassword(password, salt),
    iter: PBKDF2_ITERATIONS,
    updatedAt: Date.now()
  };
}

async function verifyPassword(password, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const iter = rec.iter || PBKDF2_ITERATIONS;
  const candidate = await hashPassword(password, rec.salt, iter);
  // 恒定时间比较，避免计时侧信道
  if (candidate.length !== rec.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) diff |= candidate.charCodeAt(i) ^ rec.hash.charCodeAt(i);
  return diff === 0;
}

/** 登录：成功返回 { ok:true, token, admin }，失败返回 { ok:false, reason } */
export async function loginAdmin(env, username, password) {
  if (!env.MEMBERS) return { ok: false, reason: 'storage_unavailable' };
  const cfg = await env.MEMBERS.get('admin:config', 'json');
  if (!cfg || !cfg.username) return { ok: false, reason: 'not_initialized' };
  if (typeof username !== 'string' || username.trim() !== cfg.username) return { ok: false, reason: 'bad_credentials' };
  if (!(await verifyPassword(password, cfg))) return { ok: false, reason: 'bad_credentials' };

  const token = randomHex(32);
  await env.MEMBERS.put(
    'session:' + token,
    JSON.stringify({ username: cfg.username, name: cfg.name || '管理员', createdAt: Date.now() }),
    { expirationTtl: SESSION_TTL_SECONDS }
  );
  return { ok: true, token, admin: { username: cfg.username, name: cfg.name || '管理员' }, expiresIn: SESSION_TTL_SECONDS };
}

export async function logoutAdmin(env, token) {
  if (token) await env.MEMBERS.delete('session:' + token);
  return { ok: true };
}

/** 从请求头解析并校验会话；无效返回 null */
export async function getSession(env, request) {
  if (!env.MEMBERS) return null;
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+([A-Za-z0-9]+)$/);
  if (!m) return null;
  const token = m[1].trim();
  const session = await env.MEMBERS.get('session:' + token, 'json');
  if (!session) return null;
  return { token, ...session };
}

export async function changeAdminPassword(env, username, oldPassword, newPassword) {
  const cfg = await env.MEMBERS.get('admin:config', 'json');
  if (!cfg) return { ok: false, reason: 'not_initialized' };
  if (username !== cfg.username) return { ok: false, reason: 'bad_credentials' };
  if (!(await verifyPassword(oldPassword, cfg))) return { ok: false, reason: 'bad_old_password' };
  if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
    return { ok: false, reason: 'weak_password', message: '新密码长度需为 8-128 位' };
  }
  const rec = await createPasswordRecord(newPassword);
  const next = { ...cfg, salt: rec.salt, hash: rec.hash, iter: rec.iter, passwordUpdatedAt: rec.updatedAt };
  await env.MEMBERS.put('admin:config', JSON.stringify(next));
  return { ok: true };
}
