// src/room-collector.mjs - 房间实时数据采集器
// 职责:进入一个语音房间,周期性 dump 控件树,抽取「在线用户」(公屏发言者 + 麦位/贵宾位),
//       去重后通过回调上报给 data-store,替换掉本地随机生成的演示数据。
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
//   * 只做"读",不做任何点击/发送 —— 采集器绝不主动打扰房间
//   * 全程容错:任何一次 dump 失败只跳过本轮,不中断采集

import { findById } from './adb-client.mjs';
import { ROOM_IDS } from './android-driver.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 从房间控件树里抽取"当前在线用户"
// 返回 [{ uid, nickname, sex, guild, uidReal }]
//   uidReal=true  = uid 是真实用户ID(公屏读到);false = 昵称哈希占位
// 实测房间结构(2026-10-08):
//   麦位: tv_wheat_name(昵称) + tvWheatScore(分值)   ← 无 uid
//   公屏: nickname(昵称) + tv_nice_num(纯数字ID) + content  ← 有 uid
//   房间: tv_room_name / tv_room_code(ID:9277) / tv_online_count(16人)
export function extractRoomUsers(nodes) {
  const users = new Map(); // key -> user

  const upsert = (key, patch) => {
    if (!key) return;
    const prev = users.get(key) || { uid: key, nickname: '', sex: 'unknown', guild: '', uidReal: false };
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
    const code = codeNodes.find(c =>
      Math.abs(c.centerY - n.centerY) < 60 && /^\d{5,}$/.test((c.text || '').trim()));
    if (code) {
      const uid = code.text.trim();
      nickToUid.set(nick, uid);
      upsert(uid, { nickname: nick, uidReal: true, seenFrom: 'publicScreen' });
    } else {
      upsert('n' + hashStr(nick), { nickname: nick, uidReal: false, seenFrom: 'publicScreen' });
    }
  }

  // ---- 2) 麦位/贵宾位:tv_wheat_name(本身无 uid) ----
  for (const w of findById(nodes, ROOM_IDS.wheatName)) {
    const nick = (w.text || '').trim();
    if (!nick || /贵宾席位|申请上麦|空|虚位/.test(nick)) continue;
    const realUid = nickToUid.get(nick);
    upsert(realUid || ('n' + hashStr(nick)), {
      nickname: nick, uidReal: !!realUid, seenFrom: 'wheat',
    });
  }

  // ---- 3) 性别:就近匹配性别图标 ----
  const wheatNodes = findById(nodes, ROOM_IDS.wheatName);
  for (const n of nodes) {
    const sid = String(n.shortId || '') + ' ' + String(n.cls || '');
    if (!/sex|gender/i.test(sid)) continue;
    const near = wheatNodes.find(w => Math.abs(w.centerY - n.centerY) < 160);
    if (!near) continue;
    const nick = (near.text || '').trim();
    const realUid = nickToUid.get(nick);
    const key = realUid || ('n' + hashStr(nick));
    const female = /female|woman|girl|女/i.test(sid) || n.text === '女' || n.desc === '女';
    const male = /male|man|boy|男/i.test(sid) || n.text === '男' || n.desc === '男';
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
export class RoomCollector {
  constructor(driver, opts = {}) {
    this.driver = driver;
    this.onUsers = opts.onUsers || (() => {});
    this.onLog = opts.onLog || (() => {});
    this.onRoom = opts.onRoom || (() => {});
    this.onError = opts.onError || (() => {});
    this.intervalMs = opts.intervalMs || 5000;
    this.roomName = opts.roomName || null;   // 指定要进的房间名(可空=自动挑热门)
    this.timer = null;
    this.stopped = true;
    this.rounds = 0;
    this.threeEmptyRounds = 0;
    this.lastRoom = null;
    this.consecutiveErrors = 0;
  }

  log(l, m) { this.onLog(l, m); }

  async start({ intervalMs } = {}) {
    if (!this.stopped) return { ok: false, reason: 'ALREADY_RUNNING' };
    if (intervalMs) this.intervalMs = intervalMs;
    this.stopped = false;
    this.rounds = 0;
    this.threeEmptyRounds = 0;
    this.consecutiveErrors = 0;

    // 首次采集立刻做一次,拿到基线
    await this._collectOnce().catch(e => this.log('warn', '首次采集失败: ' + e.message.slice(0, 60)));

    this.timer = setInterval(() => {
      if (this.stopped) return;
      this._collectOnce().catch(e => {
        this.consecutiveErrors++;
        this.log('warn', `采集异常(${this.consecutiveErrors}): ${e.message.slice(0, 60)}`);
        this.onError(e.message);
      });
    }, this.intervalMs);

    return { ok: true, intervalMs: this.intervalMs };
  }

  async stop() {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    return { ok: true, rounds: this.rounds };
  }

  getStatus() {
    return {
      running: !this.stopped,
      rounds: this.rounds,
      intervalMs: this.intervalMs,
      room: this.lastRoom,
    };
  }

  async _collectOnce() {
    // 确认当前在房间页;不在则自动进房
    const inRoom = await this._isInRoom();
    if (!inRoom) {
      const entered = await this._enterRoom();
      if (!entered) {
        this.consecutiveErrors++;
        this.onError('NOT_IN_ROOM');
        return;
      }
    }

    const { nodes } = await this.driver.dumpRoom();
    const users = extractRoomUsers(nodes);
    const room = extractRoomName(nodes) || this.lastRoom;
    if (room && room !== this.lastRoom) {
      this.lastRoom = room;
      const code = extractRoomCode(nodes);
      const online = extractOnlineCount(nodes);
      this.log('info', `进入房间: ${room}${code ? ` (ID:${code})` : ''}${online ? ` 在线${online}人` : ''}`);
    }
    this.onRoom(room);

    this.rounds++;
    this.consecutiveErrors = 0;

    if (!users.length) {
      this.threeEmptyRounds++;
      if (this.threeEmptyRounds % 6 === 1) {
        this.log('info', `本轮未采集到用户(公屏空闲),继续监听中...`);
      }
      return;
    }
    this.threeEmptyRounds = 0;

    const males = users.filter(u => u.sex === 'male').length;
    const females = users.filter(u => u.sex === 'female').length;
    const realUids = users.filter(u => u.uidReal).length;
    this.log('ok', `采集到 ${users.length} 位在线用户(真实ID ${realUids} / 女 ${females} / 男 ${males} / 未知 ${users.length - males - females})`);

    this.onUsers(users.map(u => ({
      uid: u.uid,
      nickname: u.nickname,
      sex: u.sex,
      guild: u.guild || '',
      room: room || '',
      online: true,
      uidReal: !!u.uidReal,
    })), { room, ts: Date.now() });
  }

  async _isInRoom() {
    try {
      const r = await this.driver.adb.sh('dumpsys activity activities');
      // 只看当前前台 Activity。切勿用 out.includes('RoomPageActivity') ——
      // 历史任务栈里会残留该字样,导致在主页时被误判成"已在房间"。
      const m = r.out.match(/topResumedActivity=\S+\s+\S+\s+(\S+)/);
      const top = m ? m[1] : '';
      return top.includes('RoomPageActivity');
    } catch { return false; }
  }

  // 自动进入房间:
  //   1) 已在房间页 → 直接返回
  //   2) 点「消息」页里的房间足迹(最近进过的厅) → 最快
  //   3) 回「聊天室」主页 → 点一个热门房间的 tv_room_name 进房
  // 依赖桥接的 clickText(中文安全),不依赖坐标。
  async _enterRoom() {
    if (await this._isInRoom()) return true;
    this.log('info', '当前不在房间页,尝试自动进入房间...');

    // 优先:如果配置了指定房间名,直接按名点
    if (this.roomName) {
      for (let i = 0; i < 3; i++) {
        if (await this._clickRoomByName(this.roomName)) {
          await sleep(3500);
          if (await this._isInRoom()) { this.log('ok', `已进入房间: ${this.roomName}`); return true; }
        }
        await sleep(800);
      }
    }

    // 回到主界面
    await this._gotoMain();
    await sleep(1200);

    // 在主页找热门房间,逐个尝试点进去
    for (let attempt = 0; attempt < 6; attempt++) {
      const picked = await this._clickFirstRoomCard();
      if (picked) {
        await sleep(3500);
        if (await this._isInRoom()) {
          this.log('ok', `已自动进入房间: ${picked}`);
          return true;
        }
        // 没进去(可能有密码房/弹窗),关掉弹窗再试
        await this._dismissPopup();
        await this._gotoMain();
        await sleep(1200);
      } else {
        await sleep(1000);
      }
    }

    this.log('warn', '自动进房失败。请手动在模拟器中进入任意语音房间,采集会自动继续。');
    return false;
  }

  // 回到「聊天室」主页(底部第一个 tab)
  async _gotoMain() {
    try {
      const { nodes } = await this.driver.dump();
      // 若底部 tab 存在,直接点「聊天室」
      if (findById(nodes, 'tv_tab_home').length) {
        await this.driver.adb.sh(`shell input tap ${Math.round(160)} ${Math.round(1035)}`).catch(() => {});
        // 坐标兜底:有些版本 tab 可点;失败也无妨
        try { await this.driver.bridge.clickText('聊天室'); } catch { /* 忽略 */ }
        await sleep(1000);
        const { nodes: n2 } = await this.driver.dump();
        if (findById(n2, 'tv_room_name').length) return true;
      }
      // 兜底:连续 back 直到出现底部 tab 或房间卡片
      for (let i = 0; i < 4; i++) {
        const { nodes: n3 } = await this.driver.dump();
        if (findById(n3, 'tv_room_name').length) return true;
        await this.driver.adb.back().catch(() => {});
        await sleep(800);
      }
    } catch { /* 忽略 */ }
    return false;
  }

  // 在主页点第一个可进的热门房间卡片(按房间名文本点击)
  async _clickFirstRoomCard() {
    try {
      const { nodes } = await this.driver.dump();
      const names = findById(nodes, 'tv_room_name')
        .map(n => (n.text || '').trim())
        .filter(t => t && t.length <= 30);
      // 逐个尝试(跳过密码房之类进不去的)
      for (const name of names.slice(0, 6)) {
        this.log('info', `尝试进入房间: ${name}`);
        const ok = await this._clickRoomByName(name);
        if (ok) return name;
      }
    } catch (e) {
      this.log('warn', '读取房间列表失败: ' + e.message.slice(0, 50));
    }
    return null;
  }

  async _clickRoomByName(name) {
    try {
      const r = await this.driver.bridge.clickText(name);
      return !!(r && r.ok);
    } catch { return false; }
  }

  // 关掉可能出现的弹窗/升级提示
  async _dismissPopup() {
    for (const txt of ['取消', '关闭', '我知道了', '稍后再说', '确定']) {
      try {
        const r = await this.driver.bridge.clickText(txt);
        if (r && r.ok) { await sleep(600); return true; }
      } catch { /* 忽略 */ }
    }
    return false;
  }
}

export default RoomCollector;
