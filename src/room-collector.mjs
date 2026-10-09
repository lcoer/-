// src/room-collector.mjs - 房间实时数据采集器
// 职责:进入一个语音房间,周期性 dump 控件树,抽取「在线用户」(公屏发言者 + 麦位/贵宾位),
//       配合多房间导航、成员翻页和有界公开资料卡读取，按真实 UID 去重上报。
//
// 采集到的字段:
//   uid         —— 公屏消息(22830141) 或 麦位 user_code
//   nickname    —— 公屏发言者 / 麦位昵称
//   sex         —— 麦位性别图标可判;公屏读不到 → 'unknown'
//   room        —— 房间名
//   guild       —— 工会(公屏昵称前缀/可点击工会标签,读不到留空)
//
// 设计约束:
//   * 房间页 uiautomator 拿不到 idle,必须走无障碍桥接(AndroidDriver.dumpRoom)
//   * 仅浏览公开可见信息；允许进房、翻页、打开资料卡；不私聊、关注、赠送或上麦
//   * 全程容错:任何一次 dump 失败只跳过本轮,不中断采集

import { findById } from './adb-client.mjs';
import { ROOM_IDS } from './android-driver.mjs';
import { CollectionController } from './collection-controller.mjs';
import { placeholderUid } from './observation-identity.mjs';

import { abortableSleep, throwIfAborted, isAbortError } from './async-control.mjs';
function nearest(nodes, reference, maxDistance) {
 const candidates = nodes.map(node=>({node,d:Math.hypot(node.centerX-reference.centerX,node.centerY-reference.centerY)})).filter(c=>c.d<maxDistance).sort((a,b)=>a.d-b.d);
 return candidates.length && (!candidates[1] || candidates[1].d-candidates[0].d>12) ? candidates[0].node : null;
}

// 从房间控件树里抽取"当前在线用户"
// 返回 [{ uid, nickname, sex, guild, uidReal }]
//   uidReal=true  = uid 是真实用户ID(公屏读到);false = 昵称哈希占位
// 实测房间结构(2026-10-08):
//   麦位: tv_wheat_name(昵称) + tvWheatScore(分值)   ← 无 uid
//   公屏: nickname(昵称) + tv_nice_num(纯数字ID) + content  ← 有 uid
//   房间: tv_room_name / tv_room_code(ID:9277) / tv_online_count(16人)
export function extractRoomUsers(nodes, context = {}) {
  const users = new Map(); // key -> user

  const upsert = (key, patch) => {
    if (!key) return;
    const prev = users.get(key) || { uid: key, nickname: '', sex: 'unknown', guild: '', guildKnown:false, online:null, uidReal: false, source:'room_observation', evidence:'visible_node',lastSeenAt:new Date().toISOString() };
    users.set(key, { ...prev, ...patch, uid: key });
  };

  // 昵称 -> 真实 uid(来自公屏),用于给麦位昵称补真实 uid
  const nickToUid = new Map();

  // ---- 1) 公屏消息:昵称 + 数字 ID ----
  const nickNodes = [ROOM_IDS.msgNickname, ROOM_IDS.msgNicknameAlt]
    .flatMap(id => findById(nodes, id));
  const codeNodes = [ROOM_IDS.msgUserCode, ROOM_IDS.msgUserCodeAlt]
    .flatMap(id => findById(nodes, id));
  for (const n of nickNodes) {
    const nick = (n.text || '').trim();
    if (!nick) continue;
    const code = nearest(codeNodes.filter(c=>/^\(?\d{5,}\)?$/.test((c.text||'').trim())),n,250);
    if (code) {
      const uid = code.text.replace(/[()]/g,'').trim();
      if (!nickToUid.has(nick)) nickToUid.set(nick, uid);
      else if(nickToUid.get(nick) !== uid) nickToUid.set(nick,null);
      upsert(uid, { nickname: nick, uidReal: true, seenFrom: 'publicScreen' });
    } else {
      upsert(placeholderUid(nick,context), { nickname: nick, uidReal: false, seenFrom: 'publicScreen' });
    }
  }

  // ---- 2) 麦位/贵宾位:tv_wheat_name(本身无 uid) ----
  for (const w of findById(nodes, ROOM_IDS.wheatName)) {
    const nick = (w.text || '').trim();
    if (!nick || /贵宾席位|申请上麦|空|虚位/.test(nick)) continue;
    const realUid = nickToUid.get(nick);
    upsert(realUid || placeholderUid(nick,context), {
      nickname: nick, uidReal: !!realUid, seenFrom: 'wheat',
    });
  }

  // ---- 3) 性别:就近匹配性别图标 ----
  const wheatNodes = findById(nodes, ROOM_IDS.wheatName);
  for (const n of nodes) {
    const sid = String(n.shortId || '') + ' ' + String(n.className || n.cls || '');
    if (!/sex|gender/i.test(sid)) continue;
    const near = nearest(wheatNodes,n,160);
    if (!near) continue;
    const nick = (near.text || '').trim();
    const realUid = nickToUid.get(nick);
    const key = realUid || placeholderUid(nick,context);
    const female = /female|woman|girl|女/i.test(sid) || n.text === '女' || (n.contentDesc || n.desc) === '女';
    const male = /male|man|boy|男/i.test(sid) || n.text === '男' || (n.contentDesc || n.desc) === '男';
    if (female) upsert(key, { sex: 'female' });
    else if (male) upsert(key, { sex: 'male' });
  }

  return [...users.values()].filter(u => u.nickname);
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return Math.abs(h).toString(36);
}

// 读取当前房间名
export function extractRoomName(nodes) {
  // 优先用实测 id
  const direct = findById(nodes, ROOM_IDS.roomName)[0];
  if (direct && direct.text && direct.text.trim()) return direct.text.trim();
  const cands = nodes.filter(n => {
    const sid = String(n.shortId || '');
    return /room_name|roomName|tv_room_name|tv_title|title_bar|tv_room_title|room_tv_name/i.test(sid);
  });
  for (const c of cands) {
    const t = (c.text || '').trim();
    if (t && t.length <= 24 && !/^\d+$/.test(t)) return t;
  }
  return null;
}

// 读取房间号(形如 "ID:9277" → "9277")
export function extractRoomCode(nodes) {
  const n = findById(nodes, ROOM_IDS.roomCode)[0];
  if (!n || !n.text) return null;
  const m = String(n.text).match(/(\d{3,})/);
  return m ? m[1] : null;
}

// 读取在线人数(形如 "16人" → 16)
export function extractOnlineCount(nodes) {
  const n = findById(nodes, ROOM_IDS.onlineCount)[0];
  if (!n || !n.text) return null;
  const m = String(n.text).match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * RoomCollector - 房间实时采集
 * 用法:
 *   const c = new RoomCollector(driver, {
 *     onUsers: (users, meta) => dataStore.ingestRealRecords(users, meta),
 *     onLog: (level, msg) => {},
 *   });
 *   await c.start({ intervalMs: 5000 });
 *   ...
 *   await c.stop();
 */
export class RoomCollector extends CollectionController {
  constructor(driver, opts={}) {
    super(driver,{...opts,extractUsers:extractRoomUsers,extractRoomName,extractRoomCode,extractOnlineCount});
  }
}

export default RoomCollector;
