import { abortableSleep, throwIfAborted, isAbortError } from './async-control.mjs';
import { isOperationRoomCard } from './room-card.mjs';
const id = n => n.shortId || String(n.resourceId || '').split('/').pop();
const APP = 'com.sybl.voiceroom';
const app = nodes => nodes[0]?.packageName === APP && !!bounds(nodes[0]) && !nodes.some(n => n.packageName && n.packageName !== APP);
const text = n => String(n?.text || '').trim();
function bounds(n) {
  const p = String(n.bounds || '').match(/-?\d+/g)?.map(Number);
  const [x, y, x2, y2] = p?.length === 4 ? p : [n.x, n.y, n.x2, n.y2];
  return [x, y, x2, y2].every(Number.isFinite) && x >= 0 && y >= 0 && x2 > x && y2 > y ? { x, y, x2, y2 } : null;
}
function visible(n, nodes) {
  const r = bounds(n), viewport = bounds(nodes[0]);
  return app(nodes) && r && viewport && r.x >= viewport.x && r.x2 <= viewport.x2 && r.y >= viewport.y && r.y2 <= viewport.y2;
}
const roomPage = nodes => app(nodes) && !nodes.some(n => id(n) === 'rv_top_bg') && nodes.some(n => id(n) === 'tv_room_name' && visible(n, nodes)) && nodes.some(n => ['tv_room_code', 'layout_online_user'].includes(id(n)) && visible(n, nodes));
// Preload cards contain these exact fields with empty values. The marker alone is insufficient.
const cardPage = nodes => app(nodes) && (isOperationRoomCard(nodes.filter(n=>visible(n,nodes))) || nodes.some(n => id(n) === 'rv_top_bg' && visible(n, nodes)) && nodes.some(n => id(n) === 'tv_nickname') && nodes.some(n => id(n) === 'tv_user_code'));
function canonicalUid(value) {
  const m = String(value || '').trim().match(/^(?:([0-9]{5,})|\(([0-9]{5,})\)|ID\s*[:：]\s*([0-9]{5,}))$/i);
  return m ? (m[1] || m[2] || m[3]) : null;
}
/** Resolve a bounded set of currently visible seats through public user cards. */
export async function resolveVisibleRoomUsers(driver, users, { room, roomCode, signal, maxProfiles = 6, maxDurationMs = 10000, onUser = () => {
}, onLog = () => {
}, knownMappings } = {}) {
  throwIfAborted(signal);
  const start = Date.now(), deadline = start + Math.max(1, Math.min(60000, Number(maxDurationMs) || 10000));
  maxProfiles = Math.max(0, Math.min(30, Math.floor(Number(maxProfiles) || 0)));
  const resolved = [];
  let profilesRead = 0, reason = 'complete';
  const remaining = () => Math.max(1, deadline - Date.now());
  const read = async (timeout = 1500) => {
    throwIfAborted(signal);
    const r = await driver.bridge.dumpUi({ signal, retries: 0, timeout: Math.min(timeout, remaining()) });
    throwIfAborted(signal);
    return Array.isArray(r.nodes) ? r.nodes : [];
  };
  const wait = async (ms) => {
    if (Date.now() < deadline)
      await abortableSleep(Math.min(ms, remaining()), signal);
  };
  const candidates = [...new Map((Array.isArray(users) ? users : []).filter(u => u.uidReal === false && text({ text: u.nickname })).map(u => [u.uid, u])).values()];
  for (const user of candidates) {
    throwIfAborted(signal);
    if (knownMappings instanceof Map ? knownMappings.has(user.uid) : knownMappings && Object.hasOwn(knownMappings, user.uid))
      continue;
    if (profilesRead >= maxProfiles) {
      reason = 'max_profiles';
      break;
    }
    if (Date.now() >= deadline) {
      reason = 'max_duration';
      break;
    }
    let opened = false, nodes = [];
    try {
      nodes = await read();
      if (!roomPage(nodes)) {
        reason = 'not_in_room';
        break;
      }
      const currentCode = text(nodes.find(n => id(n) === 'tv_room_code' && visible(n, nodes))).match(/\d{3,}/)?.[0];
      if (roomCode && (!currentCode || String(roomCode) !== currentCode)) {
        reason = currentCode ? 'room_changed' : 'room_unverified';
        break;
      }
      const seats = nodes.filter(n => id(n) === 'tv_wheat_name' && text(n) === user.nickname && n.enabled !== false && visible(n, nodes));
      if (seats.length !== 1)
        continue;
      const r = bounds(seats[0]);
      throwIfAborted(signal);
      const clicked = await driver.bridge.tapByCoord((r.x + r.x2) / 2, (r.y + r.y2) / 2, { signal, timeout: Math.min(remaining(), 1500) });
      throwIfAborted(signal);
      if (!clicked?.ok)
        continue;
      profilesRead++;
      // A card may briefly have blank fields; wait only within the profile and total budgets.
      const before = resolved.length, cardDeadline = Math.min(deadline, Date.now() + 1800);
      while (Date.now() < cardDeadline) {
        nodes = await read();
        if (cardPage(nodes)) {
          opened = true;
          const names = nodes.filter(n => id(n) === 'tv_nickname' && visible(n, nodes)), codes = nodes.filter(n => id(n) === 'tv_user_code' && visible(n, nodes));
          const nickname = names.length === 1 ? text(names[0]) : null;
          const uid = codes.length === 1 ? canonicalUid(text(codes[0])) : null;
          if (nickname === user.nickname && uid) {
            const record = { ...user, uid, uidReal: true, nickname, room: room || user.room || '', roomCode: roomCode || user.roomCode || '', seenFrom: 'roomProfile', evidence: 'matched_room_user_card', resolvedFrom: user.uid, lastSeenAt: new Date().toISOString() };
            throwIfAborted(signal);
            resolved.push(record);
            await onUser(record);
            break;
          }
          if ((nickname && nickname !== user.nickname) || names.length > 1 || codes.length > 1) {
            reason = 'identity_mismatch';
            break;
          }
        }
        else if (!app(nodes)) {
          reason = 'unknown_page';
          break;
        }
        await wait(100);
      }
      if (!opened) {
        reason = 'card_unavailable';
        break;
      }
      if (resolved.length === before && reason === 'complete')
        reason = 'profile_unresolved';
    }
    catch (error) {
      if (isAbortError(error))
        throw error;
      reason = 'profile_read_failed';
      onLog('warn', `公开资料读取未完成: ${error.message}`);
    }
    finally {
      if (opened && !signal?.aborted) {
        try {
          // Back is authorized only by a fresh recognizable card, never by the earlier tap.
          const fresh = await driver.bridge.dumpUi({ signal, retries: 0, timeout: 1200 });
          throwIfAborted(signal);
          if (cardPage(fresh.nodes || [])) {
            await driver.adb.back();
            throwIfAborted(signal);
            let restored = false;
            for (let i = 0; i < 3; i++) {
              const check = await driver.bridge.dumpUi({ signal, retries: 0, timeout: 1200 });
              throwIfAborted(signal);
              if (roomPage(check.nodes || [])) {
                restored = true;
                break;
              }
              if (i < 2)
                await abortableSleep(100, signal);
            }
            if (!restored) {
              reason = 'room_restore_failed';
              onLog('warn', '公开资料关闭后未确认房间页面，暂停资料补全。');
            }
          }
          else {
            reason = 'card_lost';
          }
        }
        catch (error) {
          if (isAbortError(error))
            throw error;
          reason = 'room_restore_failed';
          onLog('warn', '关闭公开资料未确认，请检查模拟器页面。');
        }
      }
    }
    if (['room_restore_failed', 'card_lost', 'unknown_page', 'profile_read_failed'].includes(reason))
      break;
  }
  if (Date.now() >= deadline && reason === 'complete')
    reason = 'max_duration';
  return { resolved, profilesRead, reason, durationMs: Date.now() - start };
}
