// src/adb-client.mjs - ADB 底层客户端
// 职责:与雷电模拟器内的 Android 系统通信(执行 adb 命令、dump 控件树、输入、点击)
//
// 关键坑(实测,详见 docs/阶段1-探测结果.md):
//   1. 每个新 shell 会话都会杀掉并重启 adb server → 设备列表丢失
//      对策:每次命令前 ensureServer()
//   2. Git Bash 会把 /sdcard/xxx 转成 Windows 路径
//      对策:调用方设置 MSYS_NO_PATHCONV=1(本模块通过 spawn 直接传参,不经过 shell,天然规避)
//   3. 设备名优先 emulator-5554

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

// ===== 默认配置 =====
const DEFAULTS = {
  // 雷电模拟器自带 adb
  adbPath: 'D:\\leidian\\LDPlayer14\\adb.exe',
  // 优先用 emulator-5554(比 127.0.0.1:5555 稳定)
  serial: 'emulator-5554',
  // 兜底串口
  fallbackSerial: '127.0.0.1:5555',
  connectPort: 5555,
  appPackage: 'com.sybl.voiceroom',
  // 启动入口(实测:LaunchActivity 才是 LAUNCHER,MainActivity 不是)
  launchActivity: 'com.sybl.voiceroom/.ui.LaunchActivity',
  mainActivity: 'com.sybl.voiceroom/.ui.MainActivity',
  // ADBKeyboard 包名
  adbIme: 'com.android.adbkeyboard/.AdbIME',
  nativeIme: 'com.android.inputmethod.pinyin/.InputService',
  adbImePkg: 'com.android.adbkeyboard',
};

export class AdbClient {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...opts };
    this._serverReady = false;
    this._resolvedSerial = null;
    this._tmpDir = path.join(os.tmpdir(), 'syl-adb');
    // 可选:无障碍桥接客户端(用于 uiautomator 失败的页面,如游戏/动效页)
    this.bridge = null;
    try { fs.mkdirSync(this._tmpDir, { recursive: true }); } catch {}
  }

  // 注入桥接客户端:此后 dumpUi 在 uiautomator 失败时会自动改用桥接
  setBridge(bridge) { this.bridge = bridge; return this; }

  // 执行 adb 命令(直接 spawn,不经 shell → 避免一切路径/引号问题)
  async adb(args, { timeout = 20000, allowFail = false } = {}) {
    try {
      const { stdout, stderr } = await execFileAsync(this.cfg.adbPath, args, {
        timeout,
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      });
      return { ok: true, out: (stdout || '').trim(), err: (stderr || '').trim() };
    } catch (e) {
      if (allowFail) return { ok: false, out: (e.stdout || '').trim(), err: (e.stderr || e.message || '').trim() };
      throw new Error(`ADB_FAIL(${args.join(' ')}): ${(e.stderr || e.message || '').trim()}`);
    }
  }

  // 设备维度命令
  async sh(cmd, opts = {}) {
    const serial = await this.serial();
    return this.adb(['-s', serial, 'shell', cmd], opts);
  }

  // ===== 连接管理 =====
  // 确保 adb server 存活 + 目标设备在线;返回可用 serial
  async serial() {
    if (this._resolvedSerial && await this.isOnline(this._resolvedSerial)) {
      return this._resolvedSerial;
    }
    await this.ensureServer();

    // 先试 emulator-5554
    if (await this.isOnline(this.cfg.serial)) {
      this._resolvedSerial = this.cfg.serial;
      return this._resolvedSerial;
    }
    // 再试 127.0.0.1:5555
    await this.adb(['connect', `127.0.0.1:${this.cfg.connectPort}`], { allowFail: true });
    if (await this.isOnline(this.cfg.fallbackSerial)) {
      this._resolvedSerial = this.cfg.fallbackSerial;
      return this._resolvedSerial;
    }
    if (await this.isOnline(this.cfg.serial)) {
      this._resolvedSerial = this.cfg.serial;
      return this._resolvedSerial;
    }
    throw new Error('EMULATOR_OFFLINE: 未找到在线的模拟器设备(请确认雷电模拟器已启动)');
  }

  async ensureServer() {
    await this.adb(['start-server'], { timeout: 30000, allowFail: true });
    this._serverReady = true;
  }

  async isOnline(serial) {
    try {
      const r = await this.adb(['devices'], { timeout: 10000 });
      return r.out.split(/\r?\n/).some(l => l.startsWith(serial) && /\bdevice\b/.test(l) && !/offline/.test(l));
    } catch { return false; }
  }

  async devices() {
    await this.ensureServer();
    const r = await this.adb(['devices', '-l'], { timeout: 10000 });
    return r.out;
  }

  // ===== 健康检查 =====
  async ping() {
    try {
      const serial = await this.serial();
      const r = await this.sh('echo pong');
      return r.out.includes('pong');
    } catch { return false; }
  }

  // 模拟器可执行文件是否存在
  adbExists() {
    return fs.existsSync(this.cfg.adbPath);
  }

  // ===== 应用 =====
  async isAppInstalled() {
    try {
      const r = await this.sh(`pm list packages ${this.cfg.appPackage}`);
      return r.out.includes(this.cfg.appPackage);
    } catch { return false; }
  }

  async isAppForeground() {
    try {
      const r = await this.sh('dumpsys activity activities');
      const m = r.out.match(/topResumedActivity.*?\s([\w.]+)\/([\w.$]+)/);
      return m ? m[1] : null;
    } catch { return null; }
  }

  // 拉起应用并等待到达前台(优先 am start 指定 LaunchActivity,比 monkey 可靠)
  async launchApp({ waitMs = 8000 } = {}) {
    await this.sh(`am start -n ${this.cfg.launchActivity}`, { allowFail: true });
    const start = Date.now();
    while (Date.now() - start < waitMs) {
      const fg = await this.isAppForeground();
      if (fg === this.cfg.appPackage) return true;
      await new Promise(r => setTimeout(r, 600));
    }
    return false;
  }

  // 冷启(先强杀再拉起),用于需要干净状态的场景
  async relaunchApp({ waitMs = 10000 } = {}) {
    await this.sh(`am force-stop ${this.cfg.appPackage}`, { allowFail: true });
    await new Promise(r => setTimeout(r, 1200));
    return this.launchApp({ waitMs });
  }

  async currentFocus() {
    try {
      const r = await this.sh('dumpsys window | grep -E "mCurrentFocus|mFocusedApp"');
      return r.out;
    } catch { return ''; }
  }

  // ===== 屏幕 =====
  async screenSize() {
    const r = await this.sh('wm size');
    const m = r.out.match(/(\d+)x(\d+)/);
    return m ? { w: parseInt(m[1]), h: parseInt(m[2]) } : { w: 1080, h: 1920 };
  }

  async isKeyboardShown() {
    try {
      const r = await this.sh('dumpsys input_method | grep -E "mInputShown|mIsInputViewShown"');
      return /mInputShown=true|mIsInputViewShown=true/.test(r.out);
    } catch { return false; }
  }

  // ===== 输入 =====
  async tap(x, y) {
    return this.sh(`input tap ${Math.round(x)} ${Math.round(y)}`);
  }

  async swipe(x1, y1, x2, y2, ms = 300) {
    return this.sh(`input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${ms}`);
  }

  async keyevent(code) {
    return this.sh(`input keyevent ${code}`);
  }

  async back() { return this.keyevent(4); }

  // 英文/数字:直接 input text(中文会崩,勿用)
  async inputAscii(text) {
    const escaped = text.replace(/ /g, '%s').replace(/([&|<>()$`"';\\])/g, '\\$1');
    return this.sh(`input text "${escaped}"`);
  }

  // ===== ADBKeyboard(中文) =====
  async isAdbImeInstalled() {
    try {
      const r = await this.sh(`ime list -s`);
      return r.out.includes('com.android.adbkeyboard');
    } catch { return false; }
  }

  async switchToAdbIme() {
    await this.sh(`ime enable ${this.cfg.adbIme}`, { allowFail: true });
    await this.sh(`ime set ${this.cfg.adbIme}`, { allowFail: true });
    // 校验
    const r = await this.sh('settings get secure default_input_method', { allowFail: true });
    return r.out.includes('adbkeyboard');
  }

  async switchToNativeIme() {
    await this.sh(`ime set ${this.cfg.nativeIme}`, { allowFail: true });
  }

  // 通过 ADBKeyboard 发送任意 Unicode(含中文/emoji)
  async sendUnicode(text) {
    const b64 = Buffer.from(String(text), 'utf8').toString('base64');
    return this.sh(`am broadcast -a ADB_INPUT_B64 --es msg "${b64}"`, { allowFail: true });
  }

  async clearInputField() {
    // 通用清空:聚焦后全选删除(逐字符退格兜底)
    await this.sh('input keyevent KEYCODE_MOVE_END', { allowFail: true });
    for (let i = 0; i < 3; i++) {
      await this.sh('input keyevent --longpress KEYCODE_DEL', { allowFail: true });
    }
    return true;
  }

  // ===== 控件树 =====
  // dump 并解析成节点数组
  // 关键:uiautomator 需要等界面"静止"(idle)。游戏化/带动效的页面(如双鱼部落房间页)
  //       会一直 `ERROR: could not get idle state`。此时自动改用无障碍桥接(如已注入)。
  async dumpUi({ tmpName = `ui-${Date.now()}.xml`, allowBridge = true } = {}) {
    const remote = `/sdcard/${tmpName}`;
    const local = path.join(this._tmpDir, tmpName);

    const serial = await this.serial();
    const dump = await this.adb(['-s', serial, 'shell', `uiautomator dump ${remote}`], { timeout: 25000, allowFail: true });
    const failed = !dump.ok || /ERROR|could not/.test(dump.out + dump.err);

    if (!failed) {
      const pull = await this.adb(['-s', serial, 'pull', remote, local], { timeout: 20000, allowFail: true });
      if (pull.ok && fs.existsSync(local)) {
        const xml = fs.readFileSync(local, 'utf8');
        try { fs.unlinkSync(local); } catch {}
        return { xml, nodes: parseNodes(xml) };
      }
    }

    // uiautomator 不可用 → 桥接兜底
    if (allowBridge && this.bridge) {
      const r = await this.bridge.dumpUi();
      return { xml: null, nodes: r.nodes, viaBridge: true };
    }
    throw new Error(`UI_DUMP_FAILED: ${(dump.err || dump.out).slice(0, 200)}`);
  }

  // 截图(PNG 文件路径)
  async screenshot({ tmpName = `shot-${Date.now()}.png` } = {}) {
    const serial = await this.serial();
    const remote = `/sdcard/${tmpName}`;
    const local = path.join(this._tmpDir, tmpName);
    await this.adb(['-s', serial, 'shell', `screencap -p ${remote}`], { timeout: 20000 });
    await this.adb(['-s', serial, 'pull', remote, local], { timeout: 20000 });
    return local;
  }
}

// ===== XML 解析 =====
// 把 uiautomator dump 的 XML 解析为扁平节点数组
export function parseNodes(xml) {
  const nodes = [];
  const re = /<node\b([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const get = (k) => {
      const r = new RegExp(`${k}="([^"]*)"`).exec(attrs);
      return r ? r[1] : '';
    };
    const bounds = get('bounds');
    const bm = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    const node = {
      text: decodeEntities(get('text')),
      resourceId: get('resource-id'),
      className: get('class'),
      packageName: get('package'),
      contentDesc: decodeEntities(get('content-desc')),
      clickable: get('clickable') === 'true',
      focusable: get('focusable') === 'true',
      enabled: get('enabled') === 'true',
      checkable: get('checkable') === 'true',
      checked: get('checked') === 'true',
      selected: get('selected') === 'true',
      scrollable: get('scrollable') === 'true',
      bounds: bounds,
      x: bm ? +bm[1] : 0,
      y: bm ? +bm[2] : 0,
      x2: bm ? +bm[3] : 0,
      y2: bm ? +bm[4] : 0,
    };
    node.centerX = Math.round((node.x + node.x2) / 2);
    node.centerY = Math.round((node.y + node.y2) / 2);
    node.shortId = node.resourceId.split('/').pop();
    nodes.push(node);
  }
  return nodes;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// ===== 节点查找工具 =====
export function findById(nodes, shortId) {
  return nodes.filter(n => n.shortId === shortId);
}
export function findByText(nodes, text, { exact = false } = {}) {
  const t = String(text);
  return nodes.filter(n => exact ? n.text === t : n.text.includes(t));
}
export function findClickable(nodes) {
  return nodes.filter(n => n.clickable);
}
// 在指定范围内查找(用于判断消息气泡归属等)
export function nodesInRect(nodes, rect) {
  return nodes.filter(n =>
    n.x >= rect.x && n.y >= rect.y && n.x2 <= rect.x2 && n.y2 <= rect.y2);
}

export const ADB_DEFAULTS = DEFAULTS;
export default AdbClient;
