/* =====================================================================
 * WorkHogee · M3 案例库（轻量 RAG 骨架）
 * ---------------------------------------------------------------------
 * 目的：让 /generate-script 在写"这件商品"的脚本时，能参考同类目的
 * 优质案例（few-shot），输出更稳、更像头部卖家的卖点/场景/部件选择。
 *
 * 存储：Cloudflare KV `case:{categoryKey}` → JSON 数组（最多 20 条，TTL 30 天）。
 * 冷启动：内置 8 个跨行业种子案例（自行车/耳机/口红/T恤/零食/保温杯/运动鞋/背包）。
 * M3 范围：种子数据 + 关键词检索 + 最佳努力沉淀；向量检索后续再加。
 * ===================================================================*/

// 跨行业种子案例：基于佐糖输出结构与头部商品实证。
// keywords 用于与新商品 category/productName 做关键词重叠打分。
export const SEED_CASES = [
  {
    productName: '铝合金山地自行车',
    category: '山地车',
    keywords: ['自行车', '山地车', '单车', '骑行', '单车'],
    sellingPoints: ['铝合金车架轻量化', '避震前叉滤震', '21速变速系统'],
    useScenes: ['城市绿道骑行通勤', '周末郊野山地越野', '校园代步'],
    keyParts: ['品牌车架铭牌', '避震前叉', '变速指拨']
  },
  {
    productName: '头戴式降噪蓝牙耳机',
    category: '头戴式耳机',
    keywords: ['耳机', '头戴', '蓝牙', '降噪', '耳麦'],
    sellingPoints: ['主动降噪安静沉浸', '40mm 动圈低频饱满', '40小时长续航'],
    useScenes: ['通勤地铁降噪', '居家办公专注', '飞机长途出行'],
    keyParts: ['耳罩软垫', '品牌Logo头梁', '充电接口']
  },
  {
    productName: '丝绒哑光口红',
    category: '口红',
    keywords: ['口红', '唇膏', '唇釉', '彩妆', '美妆'],
    sellingPoints: ['丝绒哑光不拔干', '显白气色抬肤色', '磁吸管身有质感'],
    useScenes: ['通勤日常提气色', '约会聚会红唇妆', '送礼礼盒包装'],
    keyParts: ['膏体切面颜色', '磁吸管身', '管身品牌刻印']
  },
  {
    productName: '纯棉短袖T恤',
    category: 'T恤',
    keywords: ['t恤', '短袖', '纯棉', '上衣', '衣服', '服饰'],
    sellingPoints: ['精梳纯棉亲肤透气', '双纱重磅不透肉', '领口加固不易变形'],
    useScenes: ['日常通勤百搭', '周末休闲出门', '内搭叠穿'],
    keyParts: ['领口双车线', '面料针织纹理', '袖口下摆做工']
  },
  {
    productName: '每日坚果混合礼盒',
    category: '坚果零食',
    keywords: ['零食', '坚果', '食品', '饼干', '礼盒', '吃'],
    sellingPoints: ['7种坚果果干配比', '独立小袋便携卫生', '当季新货新鲜酥脆'],
    useScenes: ['办公室下午茶垫饥', '追剧随手分享', '节日送礼礼盒'],
    keyParts: ['袋内坚果实物', '独立小袋包装', '生产日期标签']
  },
  {
    productName: '316不锈钢保温杯',
    category: '保温杯',
    keywords: ['保温杯', '水杯', '杯子', '保温', '不锈钢杯'],
    sellingPoints: ['316不锈钢内胆', '12小时长效保温', '一键开盖防漏'],
    useScenes: ['通勤上班带热水', '户外运动补水', '车载杯架便携'],
    keyParts: ['杯盖一键开盖', '杯底防滑垫', '杯身容量刻度']
  },
  {
    productName: '缓震跑步运动鞋',
    category: '运动鞋',
    keywords: ['运动鞋', '跑步鞋', '跑鞋', '鞋', '球鞋', '服饰'],
    sellingPoints: ['EVA中底缓震回弹', '工程网面透气不闷脚', '橡胶大底防滑耐磨'],
    useScenes: ['路跑晨练健身', '日常通勤百搭', '健身房训练'],
    keyParts: ['网面透气结构', '中底缓震材料', '鞋带与鞋舌']
  },
  {
    productName: '防泼水通勤双肩背包',
    category: '双肩包',
    keywords: ['背包', '双肩包', '书包', '电脑包', '包'],
    sellingPoints: ['防泼水面料雨天无惧', '独立电脑仓护本本', '多隔层收纳分区'],
    useScenes: ['上下班通勤装电脑', '周末短途出行', '校园上课书本收纳'],
    keyParts: ['电脑仓防震夹层', '拉链五金质感', '肩带透气垫']
  }
];

function normText(s) {
  return String(s || '').toLowerCase();
}

/** 关键词重叠打分：category + productName 拼起来与案例 keywords 求交集。 */
function scoreCase(c, category, productName) {
  const hay = normText(category + ' ' + productName);
  let score = 0;
  for (const kw of c.keywords) {
    if (hay.includes(normText(kw))) score += 2;
  }
  // category 直接包含再加 1
  if (hay.includes(normText(c.category))) score += 1;
  return score;
}

const kvKeyFor = (category) => 'case:' + normText(category).replace(/[^a-z0-9\u4e00-\u9fa5]/g, '').slice(0, 24);

/**
 * 检索相似案例（few-shot 参考）。
 * M3 轻量实现：种子案例关键词打分 + KV 中已沉淀案例按 categoryKey 命中。
 * @returns {Promise<Array>} 最多 2 个案例，格式同 SEED_CASES 条目
 */
export async function findSimilarCases(env, { category = '', productName = '' } = {}) {
  const scored = SEED_CASES
    .map(c => ({ c, s: scoreCase(c, category, productName) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s);

  const picked = [];
  for (const x of scored) {
    picked.push(x.c);
    if (picked.length >= 2) break;
  }
  // 一个都没匹配上：兜底给 2 个最通用的（耳机 + 保温杯，覆盖 3C/家居）
  if (picked.length === 0) picked.push(SEED_CASES[1], SEED_CASES[5]);

  // KV 已沉淀案例：按 categoryKey 精确命中时优先放前面（best-effort，失败忽略）
  try {
    if (env && env.MEMBERS && category) {
      const saved = await env.MEMBERS.get(kvKeyFor(category), 'json');
      if (Array.isArray(saved) && saved.length) {
        picked.unshift(saved[0]);
        if (picked.length > 2) picked.pop();
      }
    }
  } catch {}
  return picked;
}

/**
 * 用户确认过的脚本自动沉淀为案例（best-effort，绝不阻断主流程）。
 * 仅存结构化摘要，不存图片字节。
 */
export async function saveCase(env, script = {}) {
  try {
    if (!env || !env.MEMBERS) return;
    const category = String(script.category || '').trim();
    if (!category) return;
    const key = kvKeyFor(category);
    const entry = {
      productName: String(script.productName || '').slice(0, 60),
      category,
      sellingPoints: Array.isArray(script.sellingPoints) ? script.sellingPoints.slice(0, 5) : [],
      useScenes: Array.isArray(script.useScenes) ? script.useScenes.slice(0, 3) : [],
      keyParts: Array.isArray(script.keyParts) ? script.keyParts.slice(0, 4) : [],
      savedAt: Date.now()
    };
    if (!entry.productName) return;
    let list = [];
    try { list = await env.MEMBERS.get(key, 'json') || []; } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    // 同 productName 去重
    list = list.filter(c => c && c.productName !== entry.productName);
    list.unshift(entry);
    list = list.slice(0, 20);
    await env.MEMBERS.put(key, JSON.stringify(list), { expirationTtl: 30 * 24 * 3600 });
  } catch {}
}
