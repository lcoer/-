// src/room-collector.mjs - 房间采集器
// 职责:遍历房间,采集活跃用户的 uid ↔ rongCloudId 映射,供私聊发送直接使用
//
// 流程(每房间):
//   1. joinRoom(roomId)      HTTP 进房(建立房间上下文)
//   2. UserRank/list         拿日榜活跃用户 uid 列表
//   3. exactUser(uid)        限流查询转换为 rongCloudId
//   4. HomePage(rongCloudId) 双向校验(uid+id 均一致才可信)
//   5. 缓存写入(供发送时零查询命中)
//   6. leave                 离开房间
//
// 防封号:采集与发送解耦;房间间停留 8-20 秒随机;查询复用 user-resolver 限流

import { cachePairs, getStats as getResolverStats } from './user-resolver.mjs';

const CONFIG = {
  roomsPerCategory: 2,
  stayMinMs: 8000,
  stayMaxMs: 20000,
  verifyDelayMs: 500,
  rankMode: 'rich',
  rankType: 'day',
  maxResolvePerRun: 60,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function buildDiscoverExpression(roomsPerCategory) {
  return `(async function(){
    const api = (p, d) => window.electronAPI.piscesApi(p, d);
    const cat = await api('/UI/Room/Home/categoryList', {});
    const cats = Array.isArray(cat.data && cat.data.list) ? cat.data.list : [];
    const rooms = [];
    for (const c of cats.slice(0, 8)) {
      try {
        const rl = await api('/UI/Room/Home/roomList', { id: Number(c.id), page: 1, page_size: 20 });
        const list = Array.isArray(rl.data && rl.data.list) ? rl.data.list : [];
        for (const r of list.slice(0, ${roomsPerCategory})) {
          rooms.push({ id: r.id, name: String(r.name || '').slice(0, 20) });
        }
        await new Promise(res => setTimeout(res, 600));
      } catch (e) {}
    }
    return rooms;
  })()`;
}

function buildCollectExpression(roomId, needUids) {
  return `(async function(){
    const api = (p, d) => window.electronAPI.piscesApi(p, d);
    const roomId = Number(${JSON.stringify(String(roomId))});
    const needUids = ${JSON.stringify(needUids)};
    const out = { resolved: [], rejected: [] };

    try {
      const jr = await api('/UI/User/joinRoom', { roomId, password: '' });
      out.joined = jr.code === 0;
    } catch (e) { out.joined = false; }
    if (!out.joined) return out;

    await new Promise(r => setTimeout(r, 1500));

    try {
      const rk = await api('/UI/Room/UserRank/list', { room_id: roomId, mode: '${CONFIG.rankMode}', rank_type: '${CONFIG.rankType}' });
      const items = Array.isArray(rk.data && rk.data.list) ? rk.data.list : [];
      out.rankUids = items.map(i => (i.user && i.user.uid != null) ? String(i.user.uid) : null).filter(Boolean);
    } catch (e) { out.rankUids = []; }

    for (const uid of needUids) {
      await new Promise(r => setTimeout(r, 800 + Math.floor(Math.random() * 1400)));
      try {
        const exact = await api('/UI/Search/exactUser', { keyword: uid });
        if (exact.code !== 0 || !exact.data) { out.rejected.push({ uid, reason: 'EXACT_' + exact.code }); continue; }
        const rcid = String(exact.data.id ?? '');
        if (!rcid) { out.rejected.push({ uid, reason: 'NO_ID' }); continue; }
        const hp = await api('/UI/User/User/HomePage/index', { user_id: Number(rcid) });
        if (hp.code === 0 && hp.data) {
          const respUid = String(hp.data.uid ?? '');
          const respId = String(hp.data.id ?? '');
          if (respUid === uid && respId === rcid) {
            out.resolved.push({ uid, rongCloudId: rcid, nickname: String(exact.data.nickname || '').slice(0, 30) });
          } else { out.rejected.push({ uid, reason: 'VERIFY_MISMATCH' }); }
        } else { out.rejected.push({ uid, reason: 'HP_' + hp.code }); }
      } catch (e) { out.rejected.push({ uid, reason: 'ERR' }); }
      await new Promise(r => setTimeout(r, ${CONFIG.verifyDelayMs}));
    }

    try { await api('/UI/User/Room/leave', { room_id: roomId }); out.left = true; } catch (e) { out.left = false; }
    return out;
  })()`;
}

// 采集一批房间的活跃用户映射(写入 user-resolver 缓存)
export async function collectRooms(cdp, options = {}) {
  const onLog = options.onLog || (() => {});
  const roomsPerCategory = options.roomsPerCategory || CONFIG.roomsPerCategory;

  onLog('info', `发现房间(每分类 ${roomsPerCategory} 个)...`);
  const rooms = await cdp.evaluate(buildDiscoverExpression(roomsPerCategory), true, 120000);
  onLog('ok', `发现 ${rooms.length} 个房间`);

  let totalRankUids = 0, totalResolved = 0, totalRejected = 0;
  for (let i = 0; i < rooms.length; i++) {
    const room = rooms[i];
    onLog('info', `[${i + 1}/${rooms.length}] 房间 ${room.id} "${room.name}"`);
    const probe = await cdp.evaluate(buildCollectExpression(room.id, []), true, 60000);
    if (!probe.joined) { onLog('warn', `  进房失败,跳过`); continue; }
    const rankUids = probe.rankUids || [];
    totalRankUids += rankUids.length;
    onLog('info', `  日榜 ${rankUids.length} 人`);

    const remainingQuota = CONFIG.maxResolvePerRun - totalResolved;
    const needUids = rankUids.slice(0, Math.max(0, remainingQuota));
    if (needUids.length > 0) {
      const collect = await cdp.evaluate(buildCollectExpression(room.id, needUids), true, 180000);
      totalResolved += (collect.resolved || []).length;
      totalRejected += (collect.rejected || []).length;
      cachePairs(collect.resolved || []);
      onLog('ok', `  解析 ${(collect.resolved || []).length} 人,拒 ${(collect.rejected || []).length} 人`);
    }
    if (i < rooms.length - 1) {
      const stay = rand(CONFIG.stayMinMs, CONFIG.stayMaxMs);
      onLog('info', `  停留 ${(stay / 1000).toFixed(1)} 秒...`);
      await sleep(stay);
    }
  }

  const cacheStats = getResolverStats();
  return { rooms: rooms.length, rankUids: totalRankUids, resolved: totalResolved, rejected: totalRejected, cacheStats };
}
