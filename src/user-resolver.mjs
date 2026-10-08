// src/user-resolver.mjs - uid → rongCloudId 转换器
// 职责:通过客户端内部精确搜索接口,把榜单的公开 uid 转换成融云内部 id(发送真实 targetId)
//
// 背景:后端存的 user_id 是源站 uid(displayId,如 23466820),
//       而融云发送需要 rongCloudId(internal id,如 23351546)——两者不同,
//       直接用 uid 发送会创建虚假会话,对端收不到。
//
// 防封号措施:
//   1. 内存缓存映射,避免重复查询
//   2. 查询间随机抖动(800-2200ms),模拟真人搜索节奏
//   3. 会话内查询配额(40 次),超出即拒绝(连环精确搜索是风控强特征)

const resolveCache = new Map();
const failedSet = new Set();

const QUERY_QUOTA = 40;
let queryCount = 0;
let lastQueryAt = 0;

async function throttleBeforeQuery() {
  if (queryCount >= QUERY_QUOTA) return false;
  const JITTER_MIN = 800, JITTER_MAX = 2200;
  const sinceLast = Date.now() - lastQueryAt;
  const target = JITTER_MIN + Math.floor(Math.random() * (JITTER_MAX - JITTER_MIN));
  if (sinceLast < target) await new Promise(r => setTimeout(r, target - sinceLast));
  lastQueryAt = Date.now();
  queryCount++;
  return true;
}

// 解析单个 uid → rongCloudId
export async function resolveUid(cdp, uid) {
  const key = String(uid || '').trim();
  if (!key) return null;
  if (resolveCache.has(key)) return resolveCache.get(key);
  if (failedSet.has(key)) return null;
  if (!await throttleBeforeQuery()) { failedSet.add(key); return null; }

  try {
    const result = await cdp.evaluate(`(async function(){
      const keyword = ${JSON.stringify(key)};
      try {
        const res = await window.electronAPI.piscesApi('/UI/Search/exactUser', { keyword });
        if (res && res.code === 0 && res.data) {
          const rcid = String(res.data.id ?? '').trim();
          const uid = String(res.data.uid ?? '').trim();
          if (rcid && uid === keyword) return { ok: true, rongCloudId: rcid, nickname: res.data.nickname || '' };
          return { ok: false, reason: 'MISMATCH' };
        }
        return { ok: false, reason: 'CODE_' + (res && res.code) };
      } catch (e) { return { ok: false, reason: String(e && e.message || e).slice(0, 60) }; }
    })()`, true);

    if (result && result.ok) {
      resolveCache.set(key, result.rongCloudId);
      return result.rongCloudId;
    }
    failedSet.add(key);
    return null;
  } catch {
    failedSet.add(key);
    return null;
  }
}

// 批量预解析(串行,带抖动限流)
export async function preResolveUids(cdp, ids, onLog) {
  let hit = 0, miss = 0;
  for (const id of ids) {
    const key = String(id);
    if (resolveCache.has(key)) { hit++; continue; }
    const r = await resolveUid(cdp, id);
    if (r) hit++; else miss++;
  }
  if (onLog) onLog('info', `预解析完成: 命中 ${hit}, 未解析 ${miss}, 缓存 ${resolveCache.size}`);
}

// 批量写入配对缓存(采集结果直接入缓存,发送零查询)
export function cachePairs(pairs) {
  for (const p of pairs || []) {
    if (p?.uid && p?.rongCloudId) {
      resolveCache.set(String(p.uid), String(p.rongCloudId));
    }
  }
}

export function resetForNewTask() {
  queryCount = 0;
  lastQueryAt = 0;
  failedSet.clear();
}

export function getStats() {
  return { cached: resolveCache.size, failed: failedSet.size, queries: queryCount };
}
