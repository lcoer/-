// electron/config.js - 客户端配置模块(集中管理)
// 说明:本模块集中管理所有可调参数(路径/端口/超时/任务节奏),
//       便于统一维护。任务层通过 require('../config') 读取。

const path = require('path');
const fs = require('fs');

let _app = null;
try { _app = require('electron').app; } catch { _app = null; }

// ===== 检测官方"双鱼部落"客户端安装位置 =====
// 优先级:用户手动指定(config) > 环境变量 > 打包内嵌(pisces-client) > 本机安装 > 系统常规位置
// 返回: { exe, dir } 或 null

// 读取用户手动指定的客户端路径(存于 userData/client-path.txt,单行文本)
function readUserClientPath() {
  try {
    const fs2 = fs;
    let file = null;
    if (_app) {
      try { file = path.join(_app.getPath('userData'), 'client-path.txt'); } catch { file = null; }
    }
    if (!file) file = path.join(process.env.APPDATA || '', 'shuangyu-assistant', 'client-path.txt');
    if (!file || !fs2.existsSync(file)) return null;
    const p = fs2.readFileSync(file, 'utf8').trim().replace(/^"|"$/g, '');
    return p && fs2.existsSync(p) ? p : null;
  } catch { return null; }
}

function detectSyblInstall() {
  // 0. 用户手动指定(最高优先级)
  const userPath = readUserClientPath();
  if (userPath) {
    // 若指向安装目录,则补 exe 文件名
    const isExe = /\.exe$/i.test(userPath);
    const exe = isExe ? userPath : path.join(userPath, 'sybl-electron.exe');
    if (fs.existsSync(exe)) return { exe, dir: path.dirname(exe) };
  }
  // 1. 环境变量覆盖(开发调试后门)
  if (process.env.SYBL_EXE_PATH && fs.existsSync(process.env.SYBL_EXE_PATH)) {
    return {
      exe: process.env.SYBL_EXE_PATH,
      dir: process.env.SYBL_WORK_DIR || path.dirname(process.env.SYBL_EXE_PATH),
    };
  }
  // 2. 打包后:本程序自己 resources 目录下内嵌的 pisces-client
  if (_app && _app.isPackaged) {
    const pkgDir = path.join(process.resourcesPath, 'pisces-client');
    const pkgExe = path.join(pkgDir, 'sybl-electron.exe');
    if (fs.existsSync(pkgExe)) return { exe: pkgExe, dir: pkgDir };
  }
  // 3. 系统常规安装位置(用户单独装过官方客户端)
  const local = process.env.LOCALAPPDATA;
  const pf = process.env.ProgramFiles;
  const pf86 = process.env['ProgramFiles(x86)'];
  const candidates = [
    local && path.join(local, 'Programs', 'sybl-electron'),
    local && path.join(local, 'sybl-electron'),
    local && path.join(local, 'Programs', 'shuangyu-assistant'),
    local && path.join(local, 'shuangyu-assistant'),
    local && path.join(local, 'Programs', 'shuangyu-planet'),
    pf && path.join(pf, 'sybl-electron'),
    pf86 && path.join(pf86, 'sybl-electron'),
    'E:\\Program Files\\sybl-electron',
    'D:\\Program Files\\sybl-electron',
  ].filter(Boolean);
  for (const dir of candidates) {
    const exe = path.join(dir, 'sybl-electron.exe');
    if (fs.existsSync(exe)) return { exe, dir };
    // 有些版本 exe 名不同,扫一遍目录
    try {
      if (fs.existsSync(dir)) {
        const hit = fs.readdirSync(dir).find((f) => /electron\.exe$/i.test(f) || /^sybl.*\.exe$/i.test(f));
        if (hit) return { exe: path.join(dir, hit), dir };
      }
    } catch { /* 忽略 */ }
  }
  return null;
}

// 让外部(IPC)在用户指定新路径后重新探测
function redetect() {
  const inst = detectSyblInstall();
  module.exports.syblExePath = inst ? inst.exe : null;
  module.exports.syblWorkingDir = inst ? inst.dir : null;
  return inst;
}

const _syblInstall = detectSyblInstall();

// ===== 模拟器(雷电) + 无障碍桥接配置 =====
// 读取用户手动指定的 adb 路径(存于 userData/emulator-adb.txt)
function readUserAdbPath() {
  try {
    let file = null;
    if (_app) {
      try { file = path.join(_app.getPath('userData'), 'emulator-adb.txt'); } catch { file = null; }
    }
    if (!file) file = path.join(process.env.APPDATA || '', 'shuangyu-assistant', 'emulator-adb.txt');
    if (!file || !fs.existsSync(file)) return null;
    const p = fs.readFileSync(file, 'utf8').trim().replace(/^"|"$/g, '');
    return p && fs.existsSync(p) ? p : null;
  } catch { return null; }
}

module.exports = {
  // ===== 官方客户端接管配置 (legacy: CDP 方案, 现已不适用 Android 应用) =====
  syblExePath: _syblInstall ? _syblInstall.exe : null,
  syblWorkingDir: _syblInstall ? _syblInstall.dir : null,
  // CDP 调试端口(优先随机回环端口;此值仅作 legacy 复用探测)
  cdpPort: 9222,
  // 客户端启动就绪等待超时(官方客户端启动较慢)
  syblReadyTimeoutMs: 30000,
  // 傀儡独立 userData:与用户手动开的客户端隔离,避免单实例锁冲突
  syblPuppetAppData: (_app && _app.isPackaged)
    ? path.join(_app.getPath('userData'), 'sybl-puppet')
    : null,

  // ===== 模拟器 / Android 配置(当前真实模式) =====
  // 「双鱼部落」是 Android 应用(com.sybl.voiceroom),真实模式 = 雷电模拟器 + ADB
  emulatorAdbPath: process.env.SYBL_ADB_PATH || readUserAdbPath() || null,
  emulatorPackage: 'com.sybl.voiceroom',
  emulatorLaunchActivity: 'com.sybl.voiceroom/.ui.LaunchActivity',
  // 无障碍桥接(自建 APK,用于读取 uiautomator 读不到的房间页)
  bridgePackage: 'com.syl.bridge',
  bridgeService: 'com.syl.bridge/com.syl.bridge.SylAccessibilityService',
  // 打包后 APK 会被 asarUnpack 释放到 app.asar.unpacked/tools/... —— adb install 需要真实文件路径
  bridgeApkPath: process.env.SYBL_BRIDGE_APK
    || ((_app && _app.isPackaged)
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'tools', 'syl-bridge', 'syl-bridge.apk')
      : path.join(__dirname, '..', 'tools', 'syl-bridge', 'syl-bridge.apk')),
  readUserAdbPath,

  // ===== 媒体存储(图片/语音落盘目录) =====
  mediaDir: process.env.SYBL_MEDIA_DIR
    || ((_app && _app.isPackaged)
      ? path.join(_app.getPath('userData'), 'media')
      : path.join(__dirname, '..', 'media')),

  // ===== 演示模式 =====
  // 未检测到官方客户端时,是否自动进入演示模式(全流程模拟,不真实发送)
  demoAutoFallback: false,

  // ===== 真实模式强制开关 =====
  // 为 true 时即使检测不到客户端也不降级(用于排查为何进入演示模式)
  forceRealMode: false,

  // 官方客户端安装包缓存位置(供"一键安装客户端"使用)
  clientInstallerPaths: [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'shuangyu-assistant-updater', 'installer.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'shuangyu-assistant-updater'),
  ].filter(Boolean),

  // 重新探测客户端(用户手动指定路径后调用)
  redetect,

  // ===== 任务运行器(task-runner) =====
  taskRunner: {
    mediaGapMinMs: 1000,         // 文字→图片→语音之间的随机间隔下限
    mediaGapRangeMs: 2000,       // 随机间隔范围(1-3 秒)
  },

  // ===== 数据通道(演示模式下生成模拟数据) =====
  dataFeed: {
    sampleIntervalMs: 8000,      // 演示模式模拟采集间隔
  },

  appVersion: '1.3.2',
};
