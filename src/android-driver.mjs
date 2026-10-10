// src/android-driver.mjs - 双鱼部落 Android 驱动的业务实现
// Android driver: private messaging and public user collection
//
// 驱动选择策略(自动降级):
//   1) 优先用 BridgeClient(无障碍服务) —— 房间页唯一可行方案
//   2) 普通页面用 uiautomator(AdbClient.dumpUi) —— 更轻量
//   两者 API 已统一为 { nodes } / tapById / tapByCoord

import { AdbClient, findById, findByText } from './adb-client.mjs';
import { BridgeClient } from './bridge-client.mjs';
import * as ui from './android-ui.mjs';
import { PrivateNavigator } from './private-navigator.mjs';
import {readProfileGender} from './user-gender.mjs';

import { abortableSleep, throwIfAborted, isAbortError } from './async-control.mjs';

// ===== 房间页控件 id(实测,见 docs/阶段1-探测结果.md) =====
export const ROOM_IDS = {
  publicScreen: 'roomPublicScreen',     // 公屏消息容器
  publicScreenMore: 'roomPublicScreenMore', // "当前有 N 条新消息"
  msgNickname: 'tv_nickname',           // 公屏消息-发言者(旧版)
  msgNicknameAlt: 'nickname',           // 公屏消息-发言者(实测 id)
  msgUserCode: 'tv_user_code',          // 公屏消息-用户ID(形如 (22830141))
  msgUserCodeAlt: 'tv_nice_num',        // 公屏消息-用户ID(实测 id,纯数字)
  msgContent: 'tv_bubble_content',      // 公屏消息-内容
  msgContentAlt: 'content',             // 公屏消息-内容(实测 id)
  gift: 'iv_room_gift',                 // 礼物
  roomMessage: 'iv_room_message',       // 消息
  roomMore: 'iv_room_more',             // 更多
  seat: 'cl_seat',                      // 麦位
  wheatName: 'tv_wheat_name',           // 麦位昵称
  wheatScore: 'tvWheatScore',           // 麦位分值
  upSeat: 'up_seat',                     // 上麦
  roomName: 'tv_room_name',             // 房间名
  roomCode: 'tv_room_code',             // 房间号(形如 ID:9277)
  roomHot: 'tv_room_hot',               // 房间热度
  onlineCount: 'tv_online_count',       // 在线人数(形如 16人)
  follow: 'follow',                      // 关注(用户卡片)
  followText: 'follow_text',
  quit: 'iv_quit',                       // 退出房间
  report: 'iv_report',
  share: 'iv_share',
  mini: 'iv_mini',
};

export const APP = {
  pkg: 'com.sybl.voiceroom',
  launcher: 'com.sybl.voiceroom/.ui.LaunchActivity',
  main: 'com.sybl.voiceroom/.ui.MainActivity',
  room: 'com.sybl.voiceroom/.ui.RoomPageActivity',
};

/**
 * AndroidDriver - 统一驱动
 * 自动在 uiautomator 与无障碍桥接之间选择
 */
export class AndroidDriver {
  constructor(opts = {}) {
    this.adb = opts.adb || new AdbClient(opts.adbOpts);
    this.bridge = opts.bridge || new BridgeClient(this.adb);
    this.forceBridge = !!opts.forceBridge;
    this.onLog = opts.onLog || (() => {});
    // 关键:把桥接注入 adb,使所有 dumpUi 调用在 uiautomator 失败时自动降级
    // (房间页等动效页面 uiautomator 永远拿不到 idle)
    this.adb.setBridge(this.bridge);
  }

  setSignal(signal) { this.signal = signal; this.adb.setSignal?.(signal); this.bridge.setSignal?.(signal); return this; }

  log(level, msg) { this.onLog(level, msg); }

  // ===== 环境检查 =====
  async ensureReady({ requireRoom = false } = {}) {
    if (!this.adb.adbExists()) {
      throw new Error('ADB_NOT_FOUND: 未找到 adb.exe,请检查雷电模拟器安装路径');
    }
    const online = await this.adb.ping();
    if (!online) throw new Error('EMULATOR_OFFLINE: 模拟器未连接');

    if (!await this.adb.isAppInstalled()) {
      throw new Error('APP_NOT_INSTALLED: 模拟器中未安装双鱼部落');
    }
    if (!await this.bridge.isInstalled()) throw new Error('BRIDGE_NOT_INSTALLED: 请安装新版 SYL Bridge APK');
    if (!await this.bridge.isServiceEnabled()) throw new Error('BRIDGE_NOT_ENABLED: 请在模拟器「设置-无障碍」中手动开启 SYL Bridge');
    if(requireRoom && !await this._isRoomPage()) throw new Error('NOT_IN_FOREGROUND_ROOM');
    return true;
  }

  async isAppForeground() { return this.adb.isAppForeground(); }
  async readProfileGender(nodes,options={}) { return readProfileGender(this,nodes,{signal:this.signal,...options}); }

  async launchApp() { return this.adb.launchApp(); }

  // ===== dump:自动选择方案 =====
  // 房间页必须用 bridge;其它页面优先 uiautomator(更快)
  async dump(opts = {}) {
    const activity = await this.adb.isAppForeground();
    const inRoom = activity === APP.pkg && await this._isRoomPage();
    if (this.forceBridge || inRoom) {
      return this.bridge.dumpUi(opts);
    }
    try {
      const r = await this.adb.dumpUi();
      return { ok: true, nodes: r.nodes, count: r.nodes.length, xml: r.xml };
    } catch (e) {
      if(isAbortError(e)) throw e;
      this.log('warn', `uiautomator dump 失败(${e.message.slice(0, 40)}),改用桥接服务`);
      return this.bridge.dumpUi(opts);
    }
  }

  async _isRoomPage() {
    try {
      const r = await this.adb.sh('dumpsys activity activities');
      // 只看当前前台,不能全串匹配 —— 历史任务栈里会残留 RoomPageActivity 字样,会误判
      const m = r.out.match(/topResumedActivity=\S+\s+\S+\s+(\S+)/);
      const top = m ? m[1] : '';
      return top.startsWith(APP.pkg + '/') && top.includes('RoomPageActivity');
    } catch (e) { if (isAbortError(e)) throw e; return false; }
  }

  // 强制用桥接 dump(房间页)
  async dumpRoom(opts = {}) {
    throwIfAborted(this.signal);
    if (!await this._isRoomPage()) throw new Error('NOT_IN_FOREGROUND_ROOM');
    return this.bridge.dumpUi(opts);
  }

  // ===== 点击(按 id) =====
  // A bridge timeout may follow a completed click, so never retry by coordinates.
  async tapId(id, { nodes = null, index = 0, useBridge = false } = {}) {
    if (useBridge || this.forceBridge) {
      const r = await this.bridge.tapById(id);
      if (r && r.ok) return r;
      throw new Error(r?.error || 'BRIDGE_CLICK_UNCONFIRMED');
    }
    const ns = nodes || (await this.dump()).nodes;
    const list = findById(ns, id);
    if (!list.length) throw new Error(`NOT_FOUND(id=${id})`);
    const t = list[Math.min(index, list.length - 1)];
    await this.adb.tap(t.centerX, t.centerY);
    return { ok: true, via: 'coord', x: t.centerX, y: t.centerY };
  }

  async tapText(text, { nodes = null } = {}) {
    const ns = nodes || (await this.dump()).nodes;
    const list = findByText(ns, text);
    if (!list.length) throw new Error(`NOT_FOUND_TEXT(${text})`);
    const t = list.find(n => n.clickable) || list[0];
    await this.adb.tap(t.centerX, t.centerY);
    return { ok: true, x: t.centerX, y: t.centerY };
  }

  async tap(x, y) { return this.adb.tap(x, y); }

  // ===================================================================
  // 功能 1:自动私聊(写作业)
  // ===================================================================
  /**
   * 按 expectedUid 搜索用户，核对身份后打开首次/已有私聊并发送文本。
   * @param {string|null} nickname 采集时的昵称，仅作展示；定位使用用户ID
   * @param {string} text 要发送的内容(支持中文)
   */
  async sendPrivateMessage(nickname, text, { expectedUid, signal = this.signal, onLog, onBeforeSend } = {}) {
    this.setSignal(signal);
    const fail = (reason, stage = 'identity') => ({ok:false, outcome:'failed',status:'failed',reason,stage,evidence:{expectedUid}});
    if (!/^\d+$/.test(String(expectedUid || ''))) return fail('EXPECTED_UID_REQUIRED');
    if (!String(text || '').trim()) return fail('EMPTY_TEXT','validate');
    try {
      throwIfAborted(signal);
      // Reopening LaunchActivity while already in the app can strand it on
      // the splash screen. Keep the active session and navigate its real UI.
      if (await this.adb.isAppForeground() !== APP.pkg && !await this.adb.launchApp({ waitMs: 8000 }))
        throw Error('APP_LAUNCH_FAILED');
      const route = await this.openPrivateChat(String(expectedUid), {signal,onLog});
      const profile = route.profile;
      if (!profile) return fail('PROFILE_UID_UNREADABLE');
      if (profile.uid !== String(expectedUid)) return {...fail('UID_MISMATCH'),evidence:{expectedUid,actualUid:profile.uid}};
      throwIfAborted(signal);
      const r = await ui.typeAndSend(this.adb,text,{onLog:onLog || ((l,m)=>this.log(l,m)), signal, onBeforeSend, dump:()=>route.navigator.readChat(), setText:value=>this.bridge.setText('input_message',value,{signal}), clickSend:()=>route.navigator.clickSend(text), requireOutgoingProof:true});
      return {...r,nickname:profile.nickname,text,evidence:{...r.evidence,expectedUid,actualUid:profile.uid}};
    } catch(e) {
      const outcome = isAbortError(e) ? 'cancelled' : 'failed';
      return {ok:false,outcome,status:outcome,stage:'navigation',reason:e.message,evidence:{expectedUid,...(e.actualUid ? {actualUid:e.actualUid} : {})}};
    }
  }
  async returnPrivateHome({signal=this.signal,onLog} = {}) {
    const navigator = new PrivateNavigator(this, {signal,onLog:onLog || ((l,m)=>this.log(l,m))});
    await navigator.returnHome();
    return {ok:true};
  }
  async openPrivateChat(uid, {signal=this.signal,onLog} = {}) {
    const navigator = new PrivateNavigator(this, {signal,onLog:onLog || ((l,m)=>this.log(l,m))});
    const profile = await navigator.open(uid);
    return {profile,navigator};
  }

  // 按 uid 反查昵称(房间公屏/麦位上有 uid 与昵称的对应关系)
  async resolveUidToNickname(uid) {
    const { nodes } = await this.dumpRoom();
    const needle = `(${uid})`;
    const codeNodes = findById(nodes, ROOM_IDS.msgUserCode).concat(findById(nodes, 'tv_nice_num'));
    for (const c of codeNodes) {
      if (String(c.text).replace(/[()]/g, '').trim() === String(uid)) {
        // 同一行找昵称
        const line = nodes.filter(n => Math.abs(n.centerY - c.centerY) < 40);
        const nick = line.find(n => n.shortId === 'tv_nickname' || n.shortId === 'nickname');
        if (nick) return nick.text;
      }
    }
    return null;
  }

  // ===================================================================
  // 昵称解析:读取"用户主页"上的昵称 + uid
  // ===================================================================
  // 用户主页控件(实测):
  //   tv_nickname   = 昵称
  //   tv_user_code  = 用户ID(纯数字,即 uid)
  // 调用前提:当前已在某个用户的主页页面上。
  async readUserProfile() {
    const { nodes } = await this.dump();
    const nick = (findById(nodes, 'tv_nickname')[0] || {}).text || null;
    const code = (findById(nodes, 'tv_user_code')[0] || {}).text || null;
    const uid = code && /^\(?\d+\)?$/.test(String(code).trim()) ? String(code).replace(/[()]/g, '').trim() : null;
    if (!nick || !uid) return null;
    return { uid, nickname: nick };
  }

  // 打开当前聊天会话对方的"用户主页"
  // 从聊天窗口点对方头像(iv_avatar_target_2)即可进入主页
  async openPeerProfileFromChat() {
    // 优先点头像,其次点"查看主页"
    let { nodes } = await this.dump();
    let target = findById(nodes, 'iv_avatar_target_2')[0] ||
                 findById(nodes, 'tv_check')[0];
    if (!target) {
      // 有些版本头像没 resource-id,退而点 rc_left_portrait
      target = findById(nodes, 'rc_left_portrait')[0];
    }
    if (!target) throw new Error('PEER_AVATAR_NOT_FOUND');
    await this.adb.tap(target.centerX, target.centerY);
    await abortableSleep(2200, this.signal);
    return this.readUserProfile();
  }

  // 批量解析:遍历"消息页所有会话"(含陌生人分组),逐个进会话→进主页→读 uid/昵称
  // 返回 { map: { uid: nickname }, pairs: [{uid,nickname}], visited }
  async harvestConversationUids({ onLog, maxConversations = 60, wantedUids, signal = this.signal } = {}) {
    this.setSignal(signal);
    const wanted = wantedUids ? new Set(wantedUids.map(String)) : null;
    const log = onLog || ((l, m) => this.log(l, m));
    const map = {};
    const pairs = [];
    let visited = 0;

    // 打开 App 到消息页
    await this.adb.launchApp({ waitMs: 8000 });
    await ui.switchTab(this.adb, 'message');
    await abortableSleep(1500, this.signal);

    // 先在顶层收集会话(含陌生人分组入口)
    let { nodes } = await this.dump();
    let convs = await ui.readConversations(this.adb, nodes);
    const strangerEntry = convs.find(c => c.isStranger);

    // 逐个处理函数
    const processList = async (list, label) => {
      const handled = new Set();
      let previousPage = '';
      for (let page = 0; page < 12 && visited < maxConversations; page++) {
      throwIfAborted(signal);
      if (wanted && [...wanted].every(uid => map[uid])) return;
      if(page) list = await ui.readConversations(this.adb,(await this.dump()).nodes);
      const pageKey = list.map(c=>c.nickname + ':' + c.content).join('|');
      if(page && pageKey === previousPage) break;
      previousPage = pageKey;
      const names = list.filter(c => !c.isSystem && !c.isStranger).map(c => c.nickname);
      for (let i = 0; i < names.length && visited < maxConversations; i++) {
        throwIfAborted(signal);
        if (wanted && [...wanted].every(uid => map[uid])) break;
        const nick = names[i];
        if (handled.has(nick)) continue;
        handled.add(nick);
        try {
          log('info', `[${label} ${i + 1}/${names.length}] 解析 ${nick}...`);
          // 重新读列表(每次位置可能变),找到该会话点击
          const cur = await ui.readConversations(this.adb, (await this.dump()).nodes);
          const hit = cur.find(c => c.nickname === nick);
          if (!hit) continue;
          await this.adb.tap(hit.x, hit.y);
          await ui.waitById(this.adb, 'input_message', { timeout: 8000, desc: '聊天窗口' });
          await abortableSleep(800, this.signal);
          const prof = await this.openPeerProfileFromChat();
          if (prof) {
            map[prof.uid] = prof.nickname;
            if (!pairs.some(p => p.uid === prof.uid)) pairs.push(prof);
            log('ok', `  → ${prof.nickname}(${prof.uid})`);
          } else {
            log('warn', `  → ${nick} 未能读到 uid,跳过`);
          }
          // 从主页返回聊天,再从聊天返回列表
          await this.adb.back(); await abortableSleep(800, this.signal);
          await this.adb.back(); await abortableSleep(900, this.signal);
          visited++;
        } catch (e) {
          if(isAbortError(e)) throw e;
          log('warn', `  解析 ${nick} 出错: ${e.message.slice(0, 50)}`);
          // 尝试恢复到消息列表
          for (let k = 0; k < 3; k++) {
            await this.adb.back(); await abortableSleep(700, this.signal);
            const c = await this.dump();
            if (c.nodes.some(n => n.shortId === 'item_layout_conversation_list' ||
                                  n.shortId === 'item_layout_stranger_conversation_list')) break;
          }
        }
      }
      if(visited >= maxConversations || (wanted && [...wanted].every(uid=>map[uid]))) return;
      const size = await this.adb.screenSize();
      await this.adb.swipe(size.w/2,size.h*0.75,size.w/2,size.h*0.35,400);
      await abortableSleep(800,signal);
      }
    };

    // 1) 顶层会话
    await processList(convs, '会话');

    // 2) 陌生人分组
    if (strangerEntry && visited < maxConversations && (!wanted || ![...wanted].every(uid => map[uid]))) {
      try {
        log('info', '进入陌生人消息分组...');
        await this.adb.launchApp({ waitMs: 3000 });
        await ui.switchTab(this.adb, 'message');
        await abortableSleep(1200, this.signal);
        ({ nodes } = await this.dump());
        convs = await ui.readConversations(this.adb, nodes);
        const se = convs.find(c => c.isStranger);
        if (se) {
          await this.adb.tap(se.x, se.y);
          await abortableSleep(1800, this.signal);
          const { nodes: sn } = await this.dump();
          const list2 = await ui.readConversations(this.adb, sn);
          await processList(list2, '陌生人');
        }
      } catch (e) {
        if(isAbortError(e)) throw e;
        log('warn', '陌生人分组处理失败: ' + e.message.slice(0, 50));
      }
    }

    return { map, pairs, visited };
  }

}

export default AndroidDriver;
