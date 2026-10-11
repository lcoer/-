import { abortableSleep, throwIfAborted, isAbortError } from './async-control.mjs';
import { placeholderUid } from './observation-identity.mjs';
const APP = 'com.sybl.voiceroom';
const id = n => n.shortId || String(n.resourceId || '').split('/').pop();
function rect(n) {
  if (!n)
    return null;
  const values = String(n.bounds || '').match(/-?\d+/g)?.map(Number);
  const [x, y, x2, y2] = values?.length === 4 ? values : [n.x, n.y, n.x2, n.y2];
  return [x, y, x2, y2].every(Number.isFinite) && x >= 0 && y >= 0 && x2 > x && y2 > y ? { x, y, x2, y2 } : null;
}
const trusted = nodes => !nodes.some(n => n.packageName && n.packageName !== APP);
const titled = nodes => nodes.some(n => id(n) === 'tvTitle' && /^房间在线用户/.test(n.text || ''));
function namesFrom(nodes, list, room, roomCode) {
  const inside = n => {
    const r = rect(n);
    return r && r.x >= list.x && r.x2 <= list.x2 && r.y >= list.y && r.y2 <= list.y2;
  };
  const nicknames = nodes.filter(n => ['tv_nickname', 'nickname'].includes(id(n)) && String(n.text || '').trim() && inside(n));
  const codes = nodes.filter(n => ['tv_user_code', 'tv_nice_num'].includes(id(n)) && /^\(?\d{5,}\)?$/.test(String(n.text || '').trim()) && inside(n));
  const related = (a, b) => {
    const ra = rect(a), rb = rect(b);
    return Math.min(ra.y2, rb.y2) - Math.max(ra.y, rb.y) > 0 && Math.abs((ra.y + ra.y2 - rb.y - rb.y2) / 2) <= 40;
  };
  return nicknames.map(n => {
    const paired = codes.filter(c => related(n, c) && nicknames.filter(other => related(other, c)).length === 1);
    const nickname = n.text.trim(), uidReal = paired.length === 1;
    return { uid: uidReal ? paired[0].text.replace(/[()]/g, '').trim() : placeholderUid(nickname, { room, roomCode }), nickname, uidReal, sex: 'unknown', guild: '', guildKnown: false, online: null, room: room || '', roomCode: roomCode || '', source: 'room_observation', seenFrom: 'memberList', evidence: 'visible_member_row', lastSeenAt: new Date().toISOString() };
  });
}
/** Read the observed member popup only; bounded navigation never opens profiles. */
export async function scanRoomMembers(driver, { room, roomCode, signal, maxPages = 6, maxDurationMs = 8000, onUsers = () => {
}, onLog = () => {
} } = {}) {
  throwIfAborted(signal);
  maxPages = Math.max(1, Math.min(50, Math.floor(Number(maxPages) || 6)));
  maxDurationMs = Math.max(1, Math.min(60000, Number(maxDurationMs) || 8000));
  const start = Date.now(), deadline = start + maxDurationMs, users = new Map(), signatures = new Set();
  let nodes = [], opened = false, pages = 0, advertisedCount = null, status = 'unavailable', reason = 'entry_missing';
  const remaining = () => Math.max(1, deadline - Date.now());
  const read = async () => {
    throwIfAborted(signal);
    const r = await driver.bridge.dumpUi({ signal, retries: 0, timeout: Math.min(remaining(), 1500) });
    throwIfAborted(signal);
    return Array.isArray(r.nodes) ? r.nodes : [];
  };
  const wait = async (ms) => {
    if (Date.now() < deadline)
      await abortableSleep(Math.min(ms, remaining()), signal);
  };
  const tap = async (n) => {
    const r = rect(n);
    throwIfAborted(signal);
    return driver.bridge.tapByCoord((r.x + r.x2) / 2, (r.y + r.y2) / 2, { signal, timeout: Math.min(remaining(), 1500) });
  };
  try {
    nodes = await read();
    if (!trusted(nodes)) {
      reason = 'wrong_app';
      return result();
    }
    if (!titled(nodes)) {
      const entries = nodes.filter(n => id(n) === 'layout_online_user' && n.clickable && n.enabled !== false && rect(n));
      if (entries.length !== 1)
        return result();
      const clicked = await tap(entries[0]);
      if (!clicked?.ok) {
        reason = 'entry_click_failed';
        return result();
      }
      reason = 'popup_not_ready';
      do {
        nodes = await read();
        if (titled(nodes) && trusted(nodes))
          break;
        await wait(120);
      } while (Date.now() < deadline);
    }
    if (!trusted(nodes) || !titled(nodes))
      return result();
    opened = true;
    status = 'partial';
    reason = 'max_duration';
    while (Date.now() < deadline && pages < maxPages) {
      throwIfAborted(signal);
      if (!trusted(nodes) || !titled(nodes)) {
        reason = 'popup_lost';
        break;
      }
      const title = nodes.find(n => id(n) === 'tvTitle')?.text || '';
      const count = title.match(/\((\d+)人\)/);
      if (count)
        advertisedCount = Number(count[1]);
      if (nodes.some(n => id(n) === 'tv_message' && n.text === '暂无数据')) {
        status = users.size ? 'partial' : 'empty';
        reason = 'empty_list';
        onLog('info', '在线成员列表显示暂无数据，继续采集公屏与麦位线索。');
        break;
      }
      const lists = nodes.filter(n => id(n) === 'mRecyclerView' && rect(n));
      if (lists.length !== 1) {
        reason = 'list_missing';
        break;
      }
      const bounds = rect(lists[0]), rows = namesFrom(nodes, bounds, room, roomCode);
      const signature = JSON.stringify(rows.map(u => [u.nickname, u.uid]));
      if (signatures.has(signature)) {
        // A second fresh read avoids treating a still-loading page as the bottom.
        await wait(120);
        const retry = await read();
        const retrySignature = JSON.stringify(namesFrom(retry, bounds, room, roomCode).map(u => [u.nickname, u.uid]));
        if (trusted(retry) && titled(retry) && retrySignature === signature) {
          status = 'partial';
          reason = 'no_progress';
          nodes = retry;
          break;
        }
        nodes = retry;
        continue;
      }
      signatures.add(signature);
      pages++;
      const added = [];
      for (const u of rows) {
        if (!users.has(u.uid))
          added.push(u);
        users.set(u.uid, u);
      }
      throwIfAborted(signal);
      if (added.length)
        await onUsers(added, { room, roomCode, pages });
      if (pages >= maxPages) {
        reason = 'max_pages';
        break;
      }
      if (!rows.length) {
        reason = 'unrecognized_rows';
        break;
      }
      const height = bounds.y2 - bounds.y, x = (bounds.x + bounds.x2) / 2;
      throwIfAborted(signal);
      await driver.adb.swipe(x, bounds.y + height * .85, x, bounds.y + height * .25, 350);
      await wait(120);
      if (Date.now() >= deadline)
        break;
      nodes = await read();
    }
  }
  catch (error) {
    if (isAbortError(error))
      throw error;
    reason = 'read_failed';
    status = opened ? 'partial' : 'unavailable';
    onLog('warn', `成员扫描未完成: ${error.message}`);
  }
  finally {
    // Close only a popup we opened/recognized, using a freshly observed back control.
    if (opened && !signal?.aborted) {
      try {
        const current = await driver.bridge.dumpUi({ signal, retries: 0, timeout: 1200 });
        if (trusted(current.nodes || []) && titled(current.nodes || [])) {
          const backs = current.nodes.filter(n => id(n) === 'ivBack' && n.clickable && n.enabled !== false && rect(n));
          if (backs.length === 1) {
            const r = rect(backs[0]);
            await driver.bridge.tapByCoord((r.x + r.x2) / 2, (r.y + r.y2) / 2, { signal, timeout: 1200 });
          }
        }
      }
      catch (error) {
        if (isAbortError(error))
          throw error;
        onLog('warn', '成员列表关闭未确认，请检查模拟器页面。');
      }
    }
  }
  return result();
  function result() {
    return { users: [...users.values()], pages, status, reason, advertisedCount, durationMs: Date.now() - start };
  }
}
