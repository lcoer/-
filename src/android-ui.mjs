// src/android-ui.mjs - 双鱼部落界面自动化(页面识别 + 导航 + 通用操作)
// 职责:把 docs/阶段1-探测结果.md 里探测到的控件 id 封装成语义化操作
//
// 所有页面操作都基于 uiautomator dump 的控件树,不依赖坐标硬编码(优先按 id 定位)。

import { findById, findByText } from './adb-client.mjs';

import { abortableSleep, throwIfAborted, isAbortError } from './async-control.mjs';
import { proveSendRejection, hasUncertainSendFailure } from './send-proof.cjs';

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
    } catch (e) { if (isAbortError(e)) throw e; }
    await abortableSleep(interval, adb.signal);
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
    await abortableSleep(900, adb.signal);
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
  await abortableSleep(1200, adb.signal);
}

// 从聊天窗口返回
export async function goBack(adb, times = 1) {
  for (let i = 0; i < times; i++) {
    await adb.back();
    await abortableSleep(800, adb.signal);
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
    const matches = convs.filter(c => c.nickname === nickname && !c.isSystem && !c.isStranger);
    if (matches.length > 1) throw new Error('AMBIGUOUS_NICKNAME');
    const hit = matches[0];
    if (hit) {
      await adb.tap(hit.x, hit.y);
      await waitById(adb, 'input_message', { timeout: 8000, desc: '聊天窗口打开' });
      return hit;
    }
    if (s === maxScroll) break;
    // 没找到 → 上滑加载更多
    await adb.swipe(540, 1400, 540, 700, 400);
    await abortableSleep(1000, adb.signal);
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
export async function typeAndSend(adb, text, { onLog = () => {}, onBeforeSend, sendTimeout = 6000, verifyGapMs = 1200, signal = adb.signal, dump, setText } = {}) {
  let clicked = false, stage = 'validate', originalIme = null;
  const evidence = {};
  const result = (outcome, reason) => ({ ok: outcome === 'confirmed_ui', status: outcome, outcome, stage, reason, evidence, typed: evidence.inputMatched === true });
  if (!String(text || '').trim()) return result('failed', 'EMPTY_TEXT');
  const pause = ms => abortableSleep(ms, signal);
  const read = dump || (()=>adb.dumpUi());
  try {
    throwIfAborted(signal);
    let { nodes } = await read();
    const input = findById(nodes, 'input_message')[0];
    if (!input) return result('failed', 'INPUT_BOX_NOT_FOUND');
    stage = 'input';
    if (setText) {
      throwIfAborted(signal);
      const cleared = await setText('');
      if (cleared?.ok !== true) return result('failed', cleared?.error || 'BRIDGE_INPUT_CLEAR_FAILED');
    } else {
      originalIme = (await adb.sh('settings get secure default_input_method')).out;
      await adb.tap(input.centerX, input.centerY);
      await adb.switchToAdbIme();
      await adb.clearInputField();
      await pause(400);
    }
    throwIfAborted(signal);
    const empty = findById((await read()).nodes, 'input_message')[0];
    if (!empty || !['', '请输入消息...'].includes(empty.text)) return result('failed', 'INPUT_NOT_CLEARED');
    if (setText) {
      const typed = await setText(text);
      if (typed?.ok !== true) return result('failed', typed?.error || 'BRIDGE_INPUT_SET_FAILED');
    } else {
      await adb.sendUnicode(text);
      await pause(verifyGapMs);
    }
    throwIfAborted(signal);
    const before = (await read()).nodes;
    evidence.inputMatched = findById(before, 'input_message')[0]?.text === text;
    if (!evidence.inputMatched) return result('failed', 'INPUT_MISMATCH');
    const beforeCount = findById(before, 'rc_text').filter(n => n.text === text).length;
    evidence.beforeExactCount = beforeCount;
    const send = findById(before, 'iv_send')[0];
    if (!send) return result('failed', 'SEND_BUTTON_NOT_FOUND');
    throwIfAborted(signal);
    await onBeforeSend?.({stage:'send', evidence});
    throwIfAborted(signal);
    // Persisting intent can take time. Revalidate the current recipient/input
    // through the supplied guarded dump and locate the current send control.
    const final = (await read()).nodes;
    if (findById(final,'input_message')[0]?.text !== text) return result('failed','INPUT_CHANGED_BEFORE_SEND');
    const finalSend = findById(final,'iv_send')[0];
    if (!finalSend) return result('failed','SEND_BUTTON_NOT_FOUND');
    evidence.beforeExactCount = findById(final,'rc_text').filter(n=>n.text===text).length;
    const finalCount = evidence.beforeExactCount;
    throwIfAborted(signal);
    stage = 'send'; clicked = true;
    await adb.tap(finalSend.centerX, finalSend.centerY);
    stage = 'confirm';
    let uncertaintyReason = 'CONFIRMATION_TIMEOUT';
    const start = Date.now();
    while (Date.now() - start < sendTimeout) {
      await pause(Math.min(800, Math.max(1, sendTimeout)));
      nodes = (await read()).nodes;
      throwIfAborted(signal);
      const now = findById(nodes, 'input_message')[0];
      evidence.afterExactCount = findById(nodes, 'rc_text').filter(n => n.text === text).length;
      evidence.inputCleared = !!now && ['', '请输入消息...'].includes(now.text);
      const rejection = proveSendRejection(final, nodes, text);
      if (rejection) {
        evidence.rejection = rejection;
        onLog('warn', '平台拒绝本条消息：当前账号贡献等级不够，记录失败并继续下一个用户');
        return result('failed', rejection.reason);
      }
      if (hasUncertainSendFailure(final, nodes, text)) {
        // A slow refresh can still show just the old failed history. Wait
        // for a conclusive new row, without clicking send again.
        uncertaintyReason = 'SEND_FAILURE_INDICATOR';
        if (evidence.afterExactCount > finalCount) return result('unconfirmed', uncertaintyReason);
        continue;
      }
      if (evidence.inputCleared && evidence.afterExactCount > finalCount) return result('confirmed_ui', 'NEW_EXACT_TEXT_VISIBLE');
    }
    return result('unconfirmed', uncertaintyReason);
  } catch (e) {
    onLog('warn', e.message);
    return result(clicked ? 'unconfirmed' : isAbortError(e) ? 'cancelled' : 'failed', clicked ? 'POST_CLICK_UNCERTAINTY' : e.message);
  } finally {
    if (originalIme && /^[\w./$]+$/.test(originalIme)) {
      const previous = adb.signal;
      try { adb.setSignal?.(null); await adb.sh('ime set ' + originalIme, { signal: null, allowFail: true, timeout: 3000 }); } catch {}
      finally { adb.setSignal?.(previous); }
    }
  }
}
