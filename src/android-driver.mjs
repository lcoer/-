// src/android-driver.mjs - 双鱼部落 Android 驱动的业务实现
// 对应原 CDP 方案的三条功能:自动私聊 / 自动欢迎 / 自动打call
//
// 驱动选择策略(自动降级):
//   1) 优先用 BridgeClient(无障碍服务) —— 房间页唯一可行方案
//   2) 普通页面用 uiautomator(AdbClient.dumpUi) —— 更轻量
//   两者 API 已统一为 { nodes } / tapById / tapByCoord

import { AdbClient, findById, findByText } from './adb-client.mjs';
import { BridgeClient } from './bridge-client.mjs';
import * as ui from './android-ui.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ===== 房间页控件 id(实测,见 docs/阶段1-探测结果.md) =====
export const ROOM_IDS = {
  publicScreen: 'roomPublicScreen',     // 公屏消息容器
  msgNickname: 'tv_nickname',           // 公屏消息-发言者
  msgUserCode: 'tv_user_code',          // 公屏消息-用户ID(形如 (22830141))
  msgContent: 'tv_bubble_content',      // 公屏消息-内容
  inputMessage: 'tv_input_message',      // 房间内输入框
  expression: 'iv_input_expression',    // 表情
  gift: 'iv_room_gift',                 // 礼物
  roomMessage: 'iv_room_message',       // 消息
  roomMore: 'iv_room_more',             // 更多
  seat: 'cl_seat',                      // 麦位
  wheatName: 'tv_wheat_name',           // 麦位昵称
  upSeat: 'up_seat',                     // 上麦
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
    if (!await this.bridge.isServiceEnabled()) {
      this.log('warn', '无障碍桥接服务未启用,正在启用...');
      const ok = await this.bridge.enableService();
      if (!ok) {
        throw new Error('BRIDGE_NOT_ENABLED: 请在模拟器「设置-无障碍」中手动开启 SYL Bridge');
      }
    }
    return true;
  }

  async isAppForeground() { return this.adb.isAppForeground(); }

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
      this.log('warn', `uiautomator dump 失败(${e.message.slice(0, 40)}),改用桥接服务`);
      return this.bridge.dumpUi(opts);
    }
  }

  async _isRoomPage() {
    try {
      const r = await this.adb.sh('dumpsys activity activities');
      return r.out.includes('RoomPageActivity');
    } catch { return false; }
  }

  // 强制用桥接 dump(房间页)
  async dumpRoom(opts = {}) { return this.bridge.dumpUi(opts); }

  // ===== 点击(按 id) =====
  // 优先走 bridge ACTION_CLICK(更可靠,元素被遮挡也能点);失败回落坐标点击
  async tapId(id, { nodes = null, index = 0, useBridge = false } = {}) {
    if (useBridge || this.forceBridge) {
      const r = await this.bridge.tapById(id);
      if (r && r.ok) return r;
      this.log('warn', `桥接点击 ${id} 失败,回落坐标点击`);
      await sleep(300);
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
   * 打开指定昵称的会话并发送文本
   * @param {string} nickname 目标昵称(消息列表里的展示名)
   * @param {string} text 要发送的内容(支持中文)
   */
  async sendPrivateMessage(nickname, text, { onLog } = {}) {
    const log = onLog || ((l, m) => this.log(l, m));

    // 1. 确保在消息页
    await this.adb.launchApp({ waitMs: 8000 });
    await ui.switchTab(this.adb, 'message');
    await sleep(1200);

    // 2. 处理"陌生人消息"分组:若目标在分组内,先进入分组
    let { nodes } = await this.dump();
    let convs = await ui.readConversations(this.adb, nodes);
    let target = convs.find(c => c.nickname === nickname) || convs.find(c => c.nickname.includes(nickname));

    if (!target) {
      const stranger = convs.find(c => c.isStranger);
      if (stranger) {
        log('info', '进入陌生人消息分组查找...');
        await this.adb.tap(stranger.x, stranger.y);
        await sleep(1800);
        ({ nodes } = await this.dump());
        convs = await ui.readConversations(this.adb, nodes);
        target = convs.find(c => c.nickname === nickname) || convs.find(c => c.nickname.includes(nickname));
      }
    }
    if (!target) throw new Error(`CONVERSATION_NOT_FOUND(${nickname})`);

    // 3. 打开会话
    await this.adb.tap(target.x, target.y);
    await ui.waitById(this.adb, 'input_message', { timeout: 9000, desc: '聊天窗口' });
    await sleep(800);

    // 4. 输入并发送
    const r = await ui.typeAndSend(this.adb, text, { onLog: log });
    return { ok: r.ok, nickname, text };
  }

  // 按 uid 反查昵称(房间公屏/麦位上有 uid 与昵称的对应关系)
  async resolveUidToNickname(uid) {
    const { nodes } = await this.dumpRoom();
    const needle = `(${uid})`;
    const codeNodes = findById(nodes, ROOM_IDS.msgUserCode).concat(findById(nodes, 'tv_nice_num'));
    for (const c of codeNodes) {
      if (c.text.includes(needle) || c.text.includes(String(uid))) {
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
    const uid = code ? String(code).replace(/\D/g, '') : null;
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
    await sleep(2200);
    return this.readUserProfile();
  }

  // 批量解析:遍历"消息页所有会话"(含陌生人分组),逐个进会话→进主页→读 uid/昵称
  // 返回 { map: { uid: nickname }, pairs: [{uid,nickname}], visited }
  async harvestConversationUids({ onLog, maxConversations = 60 } = {}) {
    const log = onLog || ((l, m) => this.log(l, m));
    const map = {};
    const pairs = [];
    let visited = 0;

    // 打开 App 到消息页
    await this.adb.launchApp({ waitMs: 8000 });
    await ui.switchTab(this.adb, 'message');
    await sleep(1500);

    // 先在顶层收集会话(含陌生人分组入口)
    let { nodes } = await this.dump();
    let convs = await ui.readConversations(this.adb, nodes);
    const strangerEntry = convs.find(c => c.isStranger);

    // 逐个处理函数
    const processList = async (list, label) => {
      const names = list.filter(c => !c.isSystem && !c.isStranger).map(c => c.nickname);
      for (let i = 0; i < names.length && visited < maxConversations; i++) {
        const nick = names[i];
        try {
          log('info', `[${label} ${i + 1}/${names.length}] 解析 ${nick}...`);
          // 重新读列表(每次位置可能变),找到该会话点击
          const cur = await ui.readConversations(this.adb, (await this.dump()).nodes);
          const hit = cur.find(c => c.nickname === nick);
          if (!hit) continue;
          await this.adb.tap(hit.x, hit.y);
          await ui.waitById(this.adb, 'input_message', { timeout: 8000, desc: '聊天窗口' });
          await sleep(800);
          const prof = await this.openPeerProfileFromChat();
          if (prof) {
            map[prof.uid] = prof.nickname;
            if (!pairs.some(p => p.uid === prof.uid)) pairs.push(prof);
            log('ok', `  → ${prof.nickname}(${prof.uid})`);
          } else {
            log('warn', `  → ${nick} 未能读到 uid,跳过`);
          }
          // 从主页返回聊天,再从聊天返回列表
          await this.adb.back(); await sleep(800);
          await this.adb.back(); await sleep(900);
          visited++;
        } catch (e) {
          log('warn', `  解析 ${nick} 出错: ${e.message.slice(0, 50)}`);
          // 尝试恢复到消息列表
          for (let k = 0; k < 3; k++) {
            await this.adb.back(); await sleep(700);
            const c = await this.dump();
            if (c.nodes.some(n => n.shortId === 'item_layout_conversation_list' ||
                                  n.shortId === 'item_layout_stranger_conversation_list')) break;
          }
        }
      }
    };

    // 1) 顶层会话
    await processList(convs, '会话');

    // 2) 陌生人分组
    if (strangerEntry && visited < maxConversations) {
      try {
        log('info', '进入陌生人消息分组...');
        await this.adb.launchApp({ waitMs: 3000 });
        await ui.switchTab(this.adb, 'message');
        await sleep(1200);
        ({ nodes } = await this.dump());
        convs = await ui.readConversations(this.adb, nodes);
        const se = convs.find(c => c.isStranger);
        if (se) {
          await this.adb.tap(se.x, se.y);
          await sleep(1800);
          const { nodes: sn } = await this.dump();
          const list2 = await ui.readConversations(this.adb, sn);
          await processList(list2, '陌生人');
        }
      } catch (e) {
        log('warn', '陌生人分组处理失败: ' + e.message.slice(0, 50));
      }
    }

    return { map, pairs, visited };
  }

  // ===================================================================
  // 功能 2:自动欢迎
  // ===================================================================
  /**
   * 房间内的轮询监听:检测公屏新出现的用户,点击欢迎
   * Android 没有 MutationObserver,改用"轮询 + 差分"
   */
  async startAutoWelcome({ intervalMs = 2200, onEvent } = {}) {
    const log = (l, m) => this.log(l, m);
    let seen = new Set();
    let clicked = 0, skipped = 0;
    let stopped = false;

    // 先建立基线
    try {
      const { nodes } = await this.dumpRoom();
      seen = new Set(extractJoinEvents(nodes));
    } catch { /* 首次失败忽略 */ }

    const timer = setInterval(async () => {
      if (stopped) return;
      try {
        const { nodes } = await this.dumpRoom();
        const events = extractJoinEvents(nodes);
        for (const key of events) {
          if (seen.has(key)) continue;
          seen.add(key);
          // 新用户出现 → 尝试点击欢迎
          const ok = await this._tryWelcome(nodes, key);
          if (ok) { clicked++; log('ok', `已欢迎: ${key} (第 ${clicked} 次)`); }
          else skipped++;
          onEvent?.({ type: 'welcome', key, ok });
        }
      } catch (e) {
        log('warn', '自动欢迎轮询异常: ' + e.message.slice(0, 60));
      }
    }, intervalMs);

    return {
      stop: () => { stopped = true; clearInterval(timer); return { clickedCount: clicked, skippedCount: skipped }; },
      getStatus: () => ({ running: !stopped, clickedCount: clicked, skippedCount: skipped }),
    };
  }

  async _tryWelcome(nodes, key) {
    // 策略1:公屏消息里有"欢迎"相关的可点击按钮
    const welcomeBtns = findById(nodes, 'cl_welcome').concat(findByText(nodes, '欢迎'));
    for (const b of welcomeBtns) {
      if (b.clickable) {
        const r = await this.bridge.tapById(b.shortId).catch(() => null);
        if (r && r.ok) return true;
        await this.adb.tap(b.centerX, b.centerY);
        return true;
      }
    }
    // 策略2:房间内无欢迎按钮 → 在公屏发送一句欢迎语
    return false;
  }

  // 在房间公屏发送文本(用于欢迎/互动)
  // 实测:点房间内的 tv_input_message 会弹出**独立输入面板**,面板里
  //   输入框 id = et_screen_message,发送按钮 id = send_screen_message
  // 因此必须等这个面板出现后再输入,不能直接在 tv_input_message 上注入。
  async sendRoomMessage(text) {
    const { nodes } = await this.dumpRoom();
    const input = findById(nodes, ROOM_IDS.inputMessage)[0];
    if (!input) throw new Error('ROOM_INPUT_NOT_FOUND');
    // 1. 点输入框唤起输入面板
    await this.adb.tap(input.centerX, input.centerY);
    await sleep(1200);

    // 2. 等待输入面板出现(et_screen_message)
    let panel = null;
    for (let i = 0; i < 6; i++) {
      const { nodes: ns } = await this.dumpRoom();
      panel = findById(ns, 'et_screen_message')[0];
      if (panel) break;
      await sleep(500);
    }
    if (!panel) throw new Error('ROOM_INPUT_PANEL_NOT_FOUND');

    // 3. 点面板输入框聚焦 → 注入文本(走 ADBKeyboard 广播)
    await this.adb.tap(panel.centerX, panel.centerY);
    await sleep(600);
    await this.adb.sendUnicode(text);
    await sleep(800);

    // 4. 点发送按钮
    const { nodes: ns2 } = await this.dumpRoom();
    const sendBtn = findById(ns2, 'send_screen_message')[0];
    if (!sendBtn) throw new Error('ROOM_SEND_BTN_NOT_FOUND');
    await this.adb.tap(sendBtn.centerX, sendBtn.centerY);
    await sleep(1000);

    // 5. 校验:输入面板消失(或输入框清空)视为发送成功
    const { nodes: ns3 } = await this.dumpRoom();
    const stillOpen = findById(ns3, 'et_screen_message')[0];
    const cleared = !stillOpen || stillOpen.text === '' || stillOpen.text === '说点什么吧~';
    return { ok: cleared, typed: true };
  }

  // ===================================================================
  // 功能 3:自动打call
  // ===================================================================
  /**
   * 循环发送打call表情。
   * 房间内的打call通常是:点"表情"→ 选择打call表情。
   * 若找不到,降级为在公屏发文字"打call"。
   */
  async startAutoCall({ emoji = '打call', delayMin = 3, delayMax = 6, onEvent } = {}) {
    const log = (l, m) => this.log(l, m);
    let sent = 0;
    let stopped = false;

    const loop = (async () => {
      while (!stopped) {
        try {
          const ok = await this._sendCallOnce(emoji);
          if (ok) { sent++; log('ok', `已发送 ${emoji} (第 ${sent} 次)`); }
          else log('fail', `发送 ${emoji} 失败`);
          onEvent?.({ type: 'call', sent, ok });
        } catch (e) {
          log('fail', '打call异常: ' + e.message.slice(0, 70));
        }
        if (stopped) break;
        const ms = delayMin * 1000 + Math.floor(Math.random() * (delayMax - delayMin) * 1000);
        await sleep(ms);
      }
    })();

    return {
      stop: () => { stopped = true; return { sent }; },
      getStatus: () => ({ running: !stopped, sent }),
    };
  }

  async _sendCallOnce(emoji) {
    // 1. 优先:房间里若有直接的"打call"按钮
    const { nodes } = await this.dumpRoom();
    const direct = findByText(nodes, emoji).find(n => n.clickable);
    if (direct) {
      await this.adb.tap(direct.centerX, direct.centerY);
      await sleep(800);
      return true;
    }
    // 2. 打开表情面板(若已开着则跳过点击,避免误关)
    const emojiBtn = findById(nodes, ROOM_IDS.expression)[0];
    let panelNodes = null;
    if (findById(nodes, 'rv_expression')[0]) {
      panelNodes = nodes;                       // 面板已开
    } else if (emojiBtn) {
      await this.adb.tap(emojiBtn.centerX, emojiBtn.centerY);
      await sleep(1400);
      const { nodes: ns2 } = await this.dumpRoom();
      panelNodes = findById(ns2, 'rv_expression')[0] ? ns2 : null;
    }
    if (panelNodes) {
      const item = findByText(panelNodes, emoji).find(n => n.clickable) ||
                   findByText(panelNodes, emoji)[0];
      if (item) {
        await this.adb.tap(item.centerX, item.centerY);
        await sleep(1200);
        // 实测:点击表情项后面板会【自动关闭】,且仍停留在房间页。
        // 千万不要用 adb.back() 关面板 —— 那会直接退出整个房间!
        const { nodes: ns3 } = await this.dumpRoom();
        if (findById(ns3, 'rv_expression')[0]) {
          // 面板意外未关:点公屏空白区关闭(仍不能用 back)
          await this.adb.tap(300, 1050);
          await sleep(600);
        }
        return true;
      }
    }
    // 没找到目标表情:点公屏关闭面板后降级为发文字
    const { nodes: ns4 } = await this.dumpRoom();
    if (findById(ns4, 'rv_expression')[0]) {
      await this.adb.tap(300, 1050);
      await sleep(500);
    }
    // 3. 降级:公屏发文字
    const r = await this.sendRoomMessage(emoji);
    return r.ok;
  }
}

// ===== 从房间控件树中提取"新用户进入"事件 =====
// 房间公屏里"XX 来了/进入房间"这类消息的昵称,视为新用户
export function extractJoinEvents(nodes) {
  const events = new Set();
  const contents = findById(nodes, ROOM_IDS.msgContent);
  for (const c of contents) {
    const t = c.text || '';
    if (/来了|进入|欢迎大家|欢迎/.test(t)) {
      // 取同行的昵称
      const line = nodes.filter(n => Math.abs(n.centerY - c.centerY) < 45);
      const nick = line.find(n => n.shortId === ROOM_IDS.msgNickname);
      if (nick && nick.text) events.add(nick.text);
      else if (t.length < 30) events.add(t);
    }
  }
  // 麦位上出现的新昵称也算
  for (const w of findById(nodes, ROOM_IDS.wheatName)) {
    if (w.text && !/贵宾席位/.test(w.text)) events.add('麦位:' + w.text);
  }
  return [...events];
}

export default AndroidDriver;
