/* =====================================================================
 * WorkHogee · M2 支付订单系统（orders.js，Cloudflare KV）
 * ---------------------------------------------------------------------
 * 内测阶段支付流程（微信/支付宝商户号尚未申请，先打通订单→模拟支付→到账）：
 *   1. createOrder   生成待支付订单（套餐 plan / 加量包 topup）
 *   2. confirmOrder  模拟支付确认（内测期 confirmCode 任意非空即视为支付成功），
 *                    支付成功后额度到账：topup → 加量包余额；plan → 开通套餐。
 *   3. listOrders    当前会员订单列表
 *
 * 真实支付预留：接入微信/支付宝商户号后，在 confirmOrder 处改为验签官方回调，
 *   本文件的下单/到账逻辑可直接复用，无需改动额度层。
 *
 * KV（binding：env.MEMBERS）
 *   order:<id>            订单对象
 *   orders:list:<memberId> 该会员订单 id 列表（最多保留 200 条）
 * ===================================================================*/

import { getMember, KV_PREFIX, addTopup, PLAN_PRICING, TOPUP_PACKS } from './members.js';

const ORDER_PREFIX = 'order:';
const ORDER_INDEX_PREFIX = 'orders:list:';
const ORDER_INDEX_MAX = 200;

function genOrderId() {
  const b = new Uint8Array(5);
  crypto.getRandomValues(b);
  return 'ord_' + Date.now().toString(36).toUpperCase() + '_' +
    Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

// 套餐开通：置 plan、到期时间，并重置月度计费周期
async function activatePlan(env, memberId, planId) {
  const p = PLAN_PRICING[planId];
  const member = await getMember(env, memberId);
  if (!member || !p) return { ok: false };
  member.plan = planId;
  member.planExpireAt = Date.now() + (p.periodDays || 30) * 24 * 3600 * 1000;
  member.monthlyUsed = 0;
  const d = new Date(); d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0);
  member.monthlyResetAt = d.getTime();
  member.updatedAt = Date.now();
  await env.MEMBERS.put(KV_PREFIX + member.id, JSON.stringify(member));
  return { ok: true };
}

/**
 * 创建订单
 * body: { type:'plan'|'topup', plan?, topupPack? }
 */
export async function createOrder(env, memberId, input) {
  if (!env.MEMBERS) return { ok: false, error: { code: 'storage_unavailable', message: '存储未配置' } };
  if (!memberId) return { ok: false, error: { code: 'unauthorized', message: '请先登录' } };
  const member = await getMember(env, memberId);
  if (!member) return { ok: false, error: { code: 'member_not_found', message: '会员不存在' } };

  const body = input || {};
  const type = String(body.type || '');
  const order = {
    id: genOrderId(),
    memberId,
    type,
    status: 'pending',
    createdAt: Date.now(),
    paidAt: null
  };

  if (type === 'topup') {
    const pack = TOPUP_PACKS[body.topupPack];
    if (!pack) return { ok: false, error: { code: 'bad_pack', message: '加量包规格不存在' } };
    order.topupPack = pack.id;
    order.packs = pack.packs;
    order.amount = pack.amount;
    order.title = pack.name;
  } else if (type === 'plan') {
    const p = PLAN_PRICING[body.plan];
    if (!p) return { ok: false, error: { code: 'bad_plan', message: '套餐不存在' } };
    order.plan = p.id;
    order.amount = p.amount;
    order.title = p.name;
  } else {
    return { ok: false, error: { code: 'bad_type', message: '订单类型必须是 plan 或 topup' } };
  }

  await env.MEMBERS.put(ORDER_PREFIX + order.id, JSON.stringify(order));
  // 维护会员订单索引
  const idxKey = ORDER_INDEX_PREFIX + memberId;
  const ids = await env.MEMBERS.get(idxKey, 'json') || [];
  ids.unshift(order.id);
  await env.MEMBERS.put(idxKey, JSON.stringify(ids.slice(0, ORDER_INDEX_MAX)));

  // 内测期：返回模拟支付入口；接入真实商户号后这里换成统一下单的 code_url / 交易号
  return {
    ok: true,
    orderId: order.id,
    amount: order.amount,
    title: order.title,
    type: order.type,
    status: order.status,
    payUrl: '/pay?order=' + order.id,
    qrCode: null
  };
}

/**
 * 确认支付（内测模拟）。支付成功后额度到账。
 * body: { orderId, confirmCode }
 */
export async function confirmOrder(env, orderId, confirmCode) {
  if (!env.MEMBERS) return { ok: false, error: { code: 'storage_unavailable', message: '存储未配置' } };
  if (!orderId) return { ok: false, error: { code: 'missing_order', message: '缺少订单号' } };
  const order = await env.MEMBERS.get(ORDER_PREFIX + orderId, 'json');
  if (!order) return { ok: false, error: { code: 'order_not_found', message: '订单不存在' } };
  if (order.status === 'paid') return { ok: false, error: { code: 'already_paid', message: '该订单已支付' } };
  if (order.status !== 'pending') return { ok: false, error: { code: 'order_closed', message: '订单状态不可支付' } };
  // 内测模拟支付：confirmCode 非空即视为支付成功（真实接入后改为验签官方支付回调）
  if (!confirmCode || String(confirmCode).trim() === '') {
    return { ok: false, error: { code: 'missing_code', message: '请提供支付确认码（内测模拟）' } };
  }

  order.status = 'paid';
  order.paidAt = Date.now();
  order.confirmCode = String(confirmCode).slice(0, 32);
  await env.MEMBERS.put(ORDER_PREFIX + order.id, JSON.stringify(order));

  // 额度到账
  if (order.type === 'topup') {
    await addTopup(env, order.memberId, order.packs, order.id);
  } else if (order.type === 'plan') {
    await activatePlan(env, order.memberId, order.plan);
  }
  return { ok: true, order };
}

// 当前会员订单列表（按时间倒序）
export async function listOrders(env, memberId) {
  if (!env.MEMBERS || !memberId) return [];
  const ids = await env.MEMBERS.get(ORDER_INDEX_PREFIX + memberId, 'json') || [];
  const orders = await Promise.all(ids.map(id => env.MEMBERS.get(ORDER_PREFIX + id, 'json')));
  return orders.filter(Boolean).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
