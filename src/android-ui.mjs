// src/android-ui.mjs - 双鱼部落界面自动化(页面识别 + 导航 + 通用操作)
// 职责:把 docs/阶段1-探测结果.md 里探测到的控件 id 封装成语义化操作
//
// 所有页面操作都基于 uiautomator dump 的控件树,不依赖坐标硬编码(优先按 id 定位)。

import { findById, findByText } from './adb-client.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 各页面特征控件(用于识别当前在哪个页面)
const PAGE_MARKERS = {
  tabHome: 'tv_tab_home',          // 主界面(聊天室 tab)
  tabRoom: 'tv_tab_room',
  tabMessage: 'tv_tab_message',
  tabMine: 'tv_tab_mine',
  strangerList: 'tvToolbarTitle',   // 陌生人消息列表(title=陌生人消息)
  chatInput: 'input_message',       // 聊天窗口(有输入框)
  sendBtn: 'iv_send',
  back: 'ivToolbarBack',
};

// ===== 页面识别 =====
export function detectPage(nodes) {
  const has = (id) => nodes.some(n => n.shortId === id);
  if (has('input_message')) return 'chat';            // 聊天窗口
  if (has('item_layout_conversation_list') || has('item_layout_stranger_conversation_list')) {
    const title = nodes.find(n => n.shortId === 'tvToolbarTitle');
    if (title && title.text.includes('陌生人')) return 'strangerList';
    return 'conversationList';
  }
  if (has('tv_tab_message')) {
    // 判断在哪个 tab:看标题栏或内容
    const title = nodes.find(n => n.shortId === 'tvToolbarTitle' || n.shortId === 'tv_customer');
    if (title) return 'message';
    return 'home';
  }
  if (has('tv_room_name')) return 'roomList';
  return 'unknown';
}

// ===== 通用等待 =====
// 轮询 dump 直到 predicate(nodes) 为真,或超时
export async function waitFor(adb, predicate, { timeout = 8000, interval = 600, desc = '条件' } = {}) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    try {
      last = await adb.dumpUi();
      if (predicate(last.nodes, last)) return last;
    } catch { /* dump 偶发失败,重试 */ }
    await sleep(interval);
  }
  throw new Error(`WAIT_TIMEOUT(${desc}): 等待 ${timeout}ms 未满足条件`);
}

export const waitById = (adb, id, opts = {}) =>
  waitFor(adb, (nodes) => nodes.some(n => n.shortId === id), { desc: `id=${id}`, ...opts });

export const waitByText = (adb, text, opts = {}) =>
  waitFor(adb, (nodes) => nodes.some(n => n.text.includes(text)), { desc: `text=${text}`, ...opts });

// ===== 点击抽象 =====
// 点击指定 id(优先取 clickable 的,否则点其父级/中心)
export async function tapById(adb, nodes, id, { index = 0, preferClickable = true } = {}) {
  let targets = findById(nodes, id);
  if (!targets.length) throw new Error(`NOT_FOUND(id=${id})`);
  if (preferClickable) {
    const clickableOnes = targets.filter(n => n.clickable);
    if (clickableOnes.length) targets = clickableOnes;
  }
  const t = targets[Math.min(index, targets.length - 1)];
  await adb.tap(t.centerX, t.centerY);
  return t;
}

export async function tapByText(adb, nodes, text, opts = {}) {
  const targets = findByText(nodes, text);
  if (!targets.length) throw new Error(`NOT_FOUND(text=${text})`);
  const t = opts.clickable ? (targets.find(n => n.clickable) || targets[0]) : targets[0];
  await adb.tap(t.centerX, t.centerY);
  return t;
}

// ===== 导航 =====
// 确保回到主界面(带底部 tab 栏的页面)。
// 房间页 / 聊天页 / 二级页都没有 tab 栏,需要先回退。
export async function ensureMainPage(adb, { maxBack = 4 } = {}) {
  const { nodes } = await adb.dumpUi();
  const hasTab = nodes.some(n => n.shortId === 'll_tab_message' || n.shortId === 'tv_tab_message');
  if (hasTab) return nodes;
  for (let i = 0; i < maxBack; i++) {
    await adb.back();
    await sleep(900);
    const r = await adb.dumpUi();
    if (r.nodes.some(n => n.shortId === 'll_tab_message' || n.shortId === 'tv_tab_message')) {
      return r.nodes;
    }
  }
  return (await adb.dumpUi()).nodes;
}

// 回到底部某个 tab(自动先退出房间/二级页)
export async function switchTab(adb, tab) {
  const map = { home: 'll_tab_home', room: 'll_tab_room', message: 'll_tab_message', mine: 'll_tab_mine' };
  const id = map[tab];
  if (!id) throw new Error(`UNKNOWN_TAB(${tab})`);
  const nodes = await ensureMainPage(adb);
  await tapById(adb, nodes, id, { preferClickable: false });
  await sleep(1200);
}

// 从聊天窗口返回
export async function goBack(adb, times = 1) {
  for (let i = 0; i < times; i++) {
    await adb.back();
    await sleep(800);
  }
}

// ===== 消息页:读取会话列表 =====
// 返回 [{ nickname, content, time, unread, isStranger, isSystem, x, y }]
export async function readConversations(adb, nodes, pageXml) {
  const ns = nodes || (await adb.dumpUi()).nodes;
  const items = ns.filter(n =>
    n.shortId === 'item_layout_stranger_conversation_list' ||
    n.shortId === 'item_layout_system_conversation_list' ||
    n.shortId === 'item_layout_conversation_list');

  return items.map(item => {
    const inner = ns.filter(n => n.x >= item.x && n.y >= item.y && n.x2 <= item.x2 && n.y2 <= item.y2);
    const pick = (id) => (inner.find(n => n.shortId === id) || {}).text || '';
    return {
      nickname: pick('tv_nickname'),
      content: pick('tv_content'),
      time: pick('tv_time'),
      unread: parseInt(pick('tv_count') || '0', 10) || 0,
      hasRedPoint: inner.some(n => n.shortId === 'tv_red_point'),
      isStranger: item.shortId === 'item_layout_stranger_conversation_list',
      isSystem: item.shortId === 'item_layout_system_conversation_list',
      x: item.centerX,
      y: item.centerY,
    };
  });
}

// 在消息页找到指定昵称的会话并打开(支持滚动查找)
export async function openConversation(adb, nickname, { maxScroll = 4 } = {}) {
  for (let s = 0; s <= maxScroll; s++) {
    const { nodes } = await adb.dumpUi();
    const convs = await readConversations(adb, nodes);
    const hit = convs.find(c => c.nickname === nickname) ||
                convs.find(c => c.nickname.includes(nickname));
    if (hit) {
      await adb.tap(hit.x, hit.y);
      await waitById(adb, 'input_message', { timeout: 8000, desc: '聊天窗口打开' });
      return hit;
    }
    // 没找到 → 上滑加载更多
    await adb.swipe(540, 1400, 540, 700, 400);
    await sleep(1000);
  }
  throw new Error(`CONVERSATION_NOT_FOUND(${nickname})`);
}

// ===== 聊天窗口:读取消息列表 =====
export async function readMessages(adb, nodes) {
  const ns = nodes || (await adb.dumpUi()).nodes;
  const texts = findById(ns, 'rc_text');
  return texts.map(n => ({
    text: n.text,
    x: n.centerX, y: n.centerY,
    // 左半屏更可能是对方发的,右半屏是自己发的(气泡位置)
    side: n.centerX > 540 ? 'right' : 'left',
  }));
}

// 取聊天窗口最后一条消息
export function lastMessage(nodes) {
  const texts = findById(nodes, 'rc_text');
  if (!texts.length) return null;
  // 按 y 排序取最下面一条
  const sorted = [...texts].sort((a, b) => a.y2 - b.y2);
  const n = sorted[sorted.length - 1];
  return { text: n.text, side: n.centerX > 540 ? 'right' : 'left' };
}

// ===== 聊天窗口:输入并发送(核心) =====
// 支持中文(自动走 ADBKeyboard)
export async function typeAndSend(adb, text, {
  onLog = () => {},
  sendTimeout = 6000,
  verifyGapMs = 1200,
} = {}) {
  // 1. 找到并点击输入框
  let { nodes } = await adb.dumpUi();
  const input = findById(nodes, 'input_message')[0];
  if (!input) throw new Error('INPUT_BOX_NOT_FOUND');
  await adb.tap(input.centerX, input.centerY);
  await sleep(700);

  // 2. 清空残留
  const cur = findById((await adb.dumpUi()).nodes, 'input_message')[0];
  const hasPlaceholder = !cur || cur.text === '请输入消息...';
  if (!hasPlaceholder && cur.text) {
    onLog('info', '输入框有残留内容,清空中...');
    await adb.clearInputField();
    await sleep(400);
  }

  // 3. 输入
  //    实测重要结论:统一走 ADBKeyboard 广播最稳(中英文都支持),
  //    且【无需】把 ADBKeyboard 设为当前输入法 —— 即使系统输入法仍是拼音,
  //    ADB_INPUT_B64 广播也能正确注入(绕开雷电强制重置输入法的问题)。
  const wasAdb = await adb.switchToAdbIme();      // 尽力切换(失败也无妨)
  if (!wasAdb) onLog('info', 'ADBKeyboard 未成为默认输入法,仍将使用广播方式注入(实测有效)');
  await sleep(400);
  const r = await adb.sendUnicode(text);
  if (!/Broadcast completed/.test(r.out) && !r.ok) {
    onLog('warn', 'ADB_INPUT_B64 广播可能未送达,尝试 input text 兜底');
    if (/^[\x00-\x7F]*$/.test(text)) await adb.inputAscii(text);
  }
  await sleep(700);

  // 4. 校验输入框内容
  await sleep(verifyGapMs);
  const after = findById((await adb.dumpUi()).nodes, 'input_message')[0];
  const typed = after ? after.text : '';
  const okInput = typed.includes(text) || (text.length > 6 && typed.length > 0);
  if (!okInput) {
    onLog('warn', `输入校验:期望「${text}」实际「${typed}」`);
  }

  // 5. 点发送(记录发送前消息数用于验证)
  //    实测结论:气泡位置(side)不可靠 —— 对方发的消息也可能在右半屏。
  //    可靠信号:① 消息列表条数增加 ② 新出现的文本 == 所发内容 ③ 输入框被清空
  const beforeNodes = (await adb.dumpUi()).nodes;
  const beforeTexts = findById(beforeNodes, 'rc_text').map(n => n.y + ':' + n.text);
  const send = findById(beforeNodes, 'iv_send')[0];
  if (!send) throw new Error('SEND_BUTTON_NOT_FOUND');
  await adb.tap(send.centerX, send.centerY);

  // 6. 验证
  const start = Date.now();
  let confirmed = false;
  while (Date.now() - start < sendTimeout) {
    await sleep(800);
    try {
      const { nodes: ns } = await adb.dumpUi();
      const nowTexts = findById(ns, 'rc_text').map(n => n.y + ':' + n.text);
      const inputNow = findById(ns, 'input_message')[0];
      const inputCleared = !inputNow || inputNow.text === '请输入消息...' || inputNow.text === '';
      const grew = nowTexts.length > beforeTexts.length;
      const hasText = nowTexts.some(t => t.includes(text));
      if (inputCleared && hasText && grew) { confirmed = true; break; }
      // 兜底:输入框清空 + 消息数增加(内容可能被服务端规范化)
      if (inputCleared && grew) { confirmed = true; break; }
    } catch { /* 忽略单次 dump 失败 */ }
  }

  return { ok: confirmed, typed: !!okInput, finalText: typed };
}
