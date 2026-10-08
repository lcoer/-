// src/bridge-client.mjs - 无障碍桥接客户端
// 职责:通过 adb 广播驱动模拟器内自建的 syl-bridge 无障碍服务(com.syl.bridge),
//       读取那些 uiautomator dump 读不到的页面(尤其房间页:大量动效导致 uiautomator 永远等不到 idle)。
//
// 为什么需要它:
//   系统 uiautomator dump 依赖等待"界面静止"(idle)。双鱼部落房间页有花瓣/星光/麦位动效,
//   永远不静止 → `ERROR: could not get idle state`。自建 AccessibilityService 用
//   getRootInActiveWindow() 直取节点树,不走 idle 等待,稳定可读。
//
// 通信方式:
//   主机 → 模拟器: am broadcast -a com.syl.bridge.CMD --es cmd xxx ...
//   模拟器 → 主机: 结果写到应用私有目录,主机用 run-as 读取(APK 已设 debuggable=true)

import { AdbClient } from './adb-client.mjs';

const CMD_ACTION = 'com.syl.bridge.CMD';
const BRIDGE_PKG = 'com.syl.bridge';
const BRIDGE_SVC = 'com.syl.bridge/com.syl.bridge.SylAccessibilityService';
const FILES_DIR = '/data/data/com.syl.bridge/files';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class BridgeClient {
  constructor(adb) {
    this.adb = adb || new AdbClient();
  }

  // ===== 安装/启用 =====
  async isInstalled() {
    const r = await this.adb.sh(`pm list packages ${BRIDGE_PKG}`, { allowFail: true });
    return r.out.includes(BRIDGE_PKG);
  }

  async isServiceEnabled() {
    const r = await this.adb.sh('dumpsys accessibility', { allowFail: true });
    return r.out.includes('com.syl.bridge/com.syl.bridge.SylAccessibilityService') &&
           /Bound services:.*SYL Bridge/s.test(r.out);
  }

  async enableService() {
    await this.adb.sh(`settings put secure enabled_accessibility_services ${BRIDGE_SVC}`, { allowFail: true });
    await this.adb.sh('settings put secure accessibility_enabled 1', { allowFail: true });
    await sleep(2000);
    return this.isServiceEnabled();
  }

  async install(apkPath) {
    const s = await this.adb.serial();
    const r = await this.adb.adb(['-s', s, 'install', '--no-incremental', '-r', '-t', apkPath], {
      timeout: 90000, allowFail: true,
    });
    if (!/Success/.test(r.out)) {
      throw new Error(`BRIDGE_INSTALL_FAILED: ${(r.err || r.out).slice(0, 200)}`);
    }
    return true;
  }

  // ===== 底层指令 =====
  async _broadcast(args) {
    return this.adb.sh(`am broadcast -a ${CMD_ACTION} -p ${BRIDGE_PKG} ${args}`, { allowFail: true });
  }

  async _readResult() {
    const s = await this.adb.serial();
    const r = await this.adb.adb(['-s', s, 'exec-out', 'run-as', BRIDGE_PKG, 'cat', 'files/result.json'],
      { allowFail: true });
    if (!r.out) return null;
    try { return JSON.parse(r.out); } catch { return null; }
  }

  // 轮询读取结果直到 changed(结果文件的 mtime 变化)或超时
  async _waitResult({ timeout = 6000 } = {}) {
    const start = Date.now();
    let lastErr = null;
    while (Date.now() - start < timeout) {
      const j = await this._readResult();
      if (j && j.ok !== undefined) return j;
      if (j && j.error) lastErr = j;
      await sleep(300);
    }
    return lastErr || { ok: false, error: 'BRIDGE_TIMEOUT' };
  }

  // ===== 健康检查 =====
  async ping() {
    await this._broadcast('--es cmd ping');
    await sleep(800);
    const j = await this._readResult();
    return !!(j && j.ok && j.connected);
  }

  // ===== 核心:dump 控件树 =====
  // 返回 { ok, nodes, count, rootNull }
  async dumpUi({ timeout = 8000, retries = 2 } = {}) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      await this._broadcast('--es cmd dump');
      const j = await this._waitResult({ timeout });
      if (!j || !j.ok) {
        if (attempt < retries) { await sleep(600); continue; }
        throw new Error(`BRIDGE_DUMP_FAILED: ${j ? j.error : 'no result'}`);
      }
      if (j.rootNull) {
        if (attempt < retries) { await sleep(600); continue; }
        throw new Error('BRIDGE_DUMP_ROOT_NULL');
      }
      // 读 json 文件
      const s = await this.adb.serial();
      const raw = await this.adb.adb(['-s', s, 'exec-out', 'run-as', BRIDGE_PKG, 'cat', 'files/syl_ui.json'],
        { timeout: 20000, allowFail: true });
      let parsed;
      try { parsed = JSON.parse(raw.out); } catch (e) {
        if (attempt < retries) { await sleep(600); continue; }
        throw new Error('BRIDGE_JSON_PARSE_FAILED');
      }
      // 把扁平节点补上 uiautomator 风格字段(与 adb-client.parseNodes 输出对齐)
      const nodes = (parsed.nodes || []).map(normalizeNode);
      return { ok: true, nodes, count: nodes.length, xml: null };
    }
    throw new Error('BRIDGE_DUMP_EXHAUSTED');
  }

  // ===== 点击 =====
  async tapById(id) {
    await this._broadcast(`--es cmd tap --es id ${id}`);
    return this._waitResult({ timeout: 4000 });
  }

  async tapByCoord(x, y) {
    await this._broadcast(`--es cmd tapxy --ei x ${Math.round(x)} --ei y ${Math.round(y)}`);
    return this._waitResult({ timeout: 4000 });
  }

  // 点击文本包含某内容的节点
  async clickText(text) {
    // 需要转义 shell 特殊字符
    const safe = String(text).replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
    await this._broadcast(`--es cmd clicktext --es value "${safe}"`);
    return this._waitResult({ timeout: 4000 });
  }

  // ===== 文本设置(仅供验证;实际发送仍走 ADBKeyboard 广播,兼容性更好) =====
  async setText(id, value) {
    const b64 = Buffer.from(String(value), 'utf8').toString('base64');
    // 广播用 base64 传递,避免 shell 转义问题
    await this._broadcast(`--es cmd settextb64 --es id ${id} --es value "${b64}"`);
    return this._waitResult({ timeout: 4000 });
  }
}

// 把 bridge 返回的节点规范化为与 parseNodes 一致的字段
function normalizeNode(n) {
  const x = n.x || 0, y = n.y || 0, x2 = n.x2 || 0, y2 = n.y2 || 0;
  const rid = n.resourceId || '';
  return {
    text: n.text || '',
    resourceId: rid,
    shortId: rid.split('/').pop(),
    className: n.className || '',
    packageName: n.packageName || '',
    contentDesc: n.contentDesc || '',
    clickable: !!n.clickable,
    focusable: !!n.focusable,
    enabled: n.enabled !== false,
    checkable: !!n.checkable,
    checked: !!n.checked,
    selected: !!n.selected,
    scrollable: !!n.scrollable,
    editable: !!n.editable,
    bounds: n.bounds || `[${x},${y}][${x2},${y2}]`,
    x, y, x2, y2,
    centerX: Math.round((x + x2) / 2),
    centerY: Math.round((y + y2) / 2),
  };
}

export default BridgeClient;
