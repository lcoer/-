// electron/services/client-manager.js - 官方客户端生命周期接管
// 职责:发现官方"双鱼部落"客户端 → 拉起 → 返回可用驱动
//
// 重要变更(2026-10-08):
//   「双鱼部落」是 **Android 应用**(com.sybl.voiceroom),没有 Windows 客户端。
//   真实模式改为:连接雷电模拟器(LDPlayer) + ADB,用无障碍桥接读取控件树并驱动。
//   原 CDP 方案仅适用于 Electron 应用,对 Android 无效,已保留作历史参考。

const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const net = require('net');
const fs = require('fs');
const path = require('path');
const appConfig = require('../config');

const execFileAsync = promisify(execFile);
const delay = (ms) => new Promise(r => setTimeout(r, ms));

const STATE = {
  // CDP(历史方案)
  managedPid: null,
  managedPort: null,
  clientVersion: null,
  launching: null,
  demoForced: false,
  // Android(现方案)
  mode: 'demo',            // 'android' | 'demo'
  adbPath: null,
  serial: null,
  bridgeReady: false,
};

// ===== 雷电模拟器探测 =====
const LDPLAYER_CANDIDATES = [
  'D:\\leidian\\LDPlayer14',
  'D:\\leidian\\LDPlayer9',
  'C:\\leidian\\LDPlayer14',
  'C:\\leidian\\LDPlayer9',
  'D:\\LDPlayer\\LDPlayer14',
  'C:\\LDPlayer\\LDPlayer14',
  'C:\\Program Files\\LDPlayer\\LDPlayer14',
];

// 找到可用的 adb.exe(优先雷电自带,其次 PATH 中的 adb)
function findAdb() {
  if (appConfig.emulatorAdbPath && fs.existsSync(appConfig.emulatorAdbPath)) {
    return appConfig.emulatorAdbPath;
  }
  for (const dir of LDPLAYER_CANDIDATES) {
    const p = path.join(dir, 'adb.exe');
    if (fs.existsSync(p)) return p;
  }
  return 'adb'; // 交给 PATH
}

// 快速探测模拟器是否在线(避免每次都跑完整流程)
async function probeEmulator(adbPath) {
  try {
    await execFileAsync(adbPath, ['start-server'], { timeout: 20000 }).catch(() => {});
    const { stdout } = await execFileAsync(adbPath, ['devices'], { timeout: 10000 });
    const lines = stdout.split(/\r?\n/).filter(l => /\bdevice\b/.test(l) && !/offline/.test(l));
    for (const l of lines) {
      const m = l.match(/^(\S+)/);
      if (m && (m[1].startsWith('emulator-') || m[1].includes('127.0.0.1'))) return m[1];
    }
    // 试着 connect
    await execFileAsync(adbPath, ['connect', '127.0.0.1:5555'], { timeout: 10000 }).catch(() => {});
    const { stdout: s2 } = await execFileAsync(adbPath, ['devices'], { timeout: 10000 });
    const l2 = s2.split(/\r?\n/).filter(l => /\bdevice\b/.test(l) && !/offline/.test(l));
    const m2 = l2.map(x => x.match(/^(\S+)/)).filter(Boolean);
    if (m2.length) return m2[0][1];
  } catch { /* 探测失败 */ }
  return null;
}

// 检查应用是否装好
async function isAppInstalled(adbPath, serial) {
  try {
    const { stdout } = await execFileAsync(adbPath, ['-s', serial, 'shell', 'pm list packages com.sybl.voiceroom'],
      { timeout: 15000 });
    return stdout.includes('com.sybl.voiceroom');
  } catch { return false; }
}

// 检查无障碍桥接服务是否就绪
async function isBridgeReady(adbPath, serial) {
  try {
    const { stdout } = await execFileAsync(adbPath, ['-s', serial, 'shell', 'dumpsys accessibility'],
      { timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
    return stdout.includes('com.syl.bridge') && /Bound services:[\s\S]*SYL Bridge/.test(stdout);
  } catch { return false; }
}

// ===== 主接口:确保"真实模式"可用 =====
// 返回 { mode:'android', adbPath, serial, bridgeReady } 或 { mode:'demo', demo:true }
async function ensureClient(opts = {}) {
  const onLog = opts.onLog || (() => {});

  // 已就绪:直接返回
  if (STATE.mode === 'android' && STATE.serial && STATE.adbPath) {
    const stillOnline = await probeEmulator(STATE.adbPath);
    if (stillOnline) {
      return { mode: 'android', adbPath: STATE.adbPath, serial: STATE.serial, bridgeReady: STATE.bridgeReady };
    }
    STATE.mode = 'demo'; STATE.serial = null;
  }

  const adbPath = findAdb();
  onLog('info', `检测模拟器(adb: ${adbPath})...`);
  const serial = await probeEmulator(adbPath);

  if (!serial) {
    if (appConfig.demoAutoFallback) {
      STATE.demoForced = true;
      STATE.mode = 'demo';
      onLog('info', '未检测到雷电模拟器,已切换到演示模式');
      return { mode: 'demo', demo: true };
    }
    throw new Error('EMULATOR_NOT_FOUND: 未检测到雷电模拟器(请先启动模拟器)');
  }

  if (!await isAppInstalled(adbPath, serial)) {
    if (appConfig.demoAutoFallback) {
      STATE.demoForced = true;
      STATE.mode = 'demo';
      onLog('info', '模拟器中未安装「双鱼部落」,已切换到演示模式');
      return { mode: 'demo', demo: true };
    }
    throw new Error('APP_NOT_INSTALLED: 模拟器中未安装「双鱼部落」');
  }

  const bridgeReady = await isBridgeReady(adbPath, serial);
  if (!bridgeReady) onLog('warn', '无障碍桥接服务未就绪(房间页读取将受限)');

  STATE.mode = 'android';
  STATE.adbPath = adbPath;
  STATE.serial = serial;
  STATE.bridgeReady = bridgeReady;
  onLog('ok', `模拟器已连接: ${serial}${bridgeReady ? ',桥接就绪' : ''}`);
  return { mode: 'android', adbPath, serial, bridgeReady };
}

function getClientState() { return { ...STATE }; }
function isDemoForced() { return STATE.demoForced; }

// 保留旧接口签名(向后兼容)
async function isCdpAlive() { return false; }

module.exports = {
  ensureClient,
  getClientState,
  isDemoForced,
  isCdpAlive,
  findAdb,
  probeEmulator,
  isAppInstalled,
  isBridgeReady,
};

