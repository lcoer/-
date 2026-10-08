// electron/ipc/system-ipc.js - 系统能力 IPC
// 运行环境信息 / 模拟器连接(真实模式) / 无障碍桥接 / 文件选择 / 配置持久化
//
// 重要变更(2026-10-08):
//   「双鱼部落」是 Android 应用(com.sybl.voiceroom),没有 Windows 客户端。
//   真实模式 = 连接雷电模拟器(LDPlayer) + ADB 驱动。
//   因此原「打开官方客户端 / 选择客户端 exe」等 CDP 处理器已改为「模拟器连接 / 选择 adb / 装桥接」。

const { ipcMain, dialog, shell, app } = require('electron');
const fs = require('fs');
const path = require('path');
const appConfig = require('../config');
const dataStore = require('../services/data-store');
const clientManager = require('../services/client-manager');

// task-runner(CommonJS) — 用于刷新已缓存的驱动实例
const taskRunner = require('../services/task-runner');

const pushLog = (level, msg) => {
  try { dataStore.pushSystemLog(level, msg); } catch { /* 忽略 */ }
};

// 写单行文本到 userData 下(如 emulator-adb.txt)
function writeUserDataFile(name, content) {
  let dir = null;
  try { dir = app.getPath('userData'); } catch { dir = null; }
  if (!dir) dir = path.join(process.env.APPDATA || '', 'shuangyu-assistant');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function registerSystemIpc(ctx) {
  // ===== 运行环境信息 =====
  // 返回: { emulatorConnected, serial, adbPath, bridgeReady, appInstalled, demoMode, version, platform, demoForced }
  ipcMain.handle('system:getInfo', async () => {
    const st = clientManager.getClientState();
    let emulatorConnected = st.mode === 'android' && !!st.serial;
    let bridgeReady = !!st.bridgeReady;
    let appInstalled = emulatorConnected;

    // 状态可能过期:轻量复检一次(仅当已有 adb 时)
    if (st.adbPath) {
      try {
        const serial = await clientManager.probeEmulator(st.adbPath);
        emulatorConnected = !!serial;
        if (serial) {
          appInstalled = await clientManager.isAppInstalled(st.adbPath, serial);
          bridgeReady = await clientManager.isBridgeReady(st.adbPath, serial);
        } else {
          appInstalled = false; bridgeReady = false;
        }
      } catch { /* 复检失败沿用旧状态 */ }
    }

    return {
      emulatorConnected,
      serial: emulatorConnected ? (st.serial || null) : null,
      adbPath: st.adbPath || null,
      bridgeReady,
      appInstalled,
      demoMode: !emulatorConnected && appConfig.demoAutoFallback,
      version: appConfig.appVersion,
      platform: process.platform,
      demoForced: clientManager.isDemoForced(),
    };
  });

  // ===== 连接模拟器(真实模式入口) =====
  ipcMain.handle('system:connectEmulator', async () => {
    try {
      const info = await clientManager.ensureClient({ onLog: pushLog });
      if (info.mode === 'android') {
        return { ok: true, serial: info.serial, adbPath: info.adbPath, bridgeReady: info.bridgeReady, mode: 'android' };
      }
      return {
        ok: false, mode: 'demo',
        reason: '未检测到雷电模拟器或模拟器中未安装「双鱼部落」,已回落到演示模式。请先启动模拟器并登录。',
      };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  });

  // ===== 一键安装并启用无障碍桥接 APK =====
  ipcMain.handle('system:installBridge', async () => {
    try {
      const st = clientManager.getClientState();
      if (st.mode !== 'android' || !st.serial) {
        return { ok: false, reason: '请先连接模拟器' };
      }
      const apk = appConfig.bridgeApkPath;
      if (!fs.existsSync(apk)) {
        return { ok: false, reason: `未找到桥接 APK: ${apk}` };
      }
      // 装入驱动 → 安装 → 启用无障碍服务
      const { BridgeClient } = await import('../../src/bridge-client.mjs');
      const { AdbClient } = await import('../../src/adb-client.mjs');
      const adb = new AdbClient({ adbPath: st.adbPath, serial: st.serial });
      const bridge = new BridgeClient(adb);

      pushLog('info', '正在安装无障碍桥接 APK...');
      await bridge.install(apk);
      const enabled = await bridge.enableService();
      const ready = enabled || await bridge.isServiceEnabled();
      // 让 task-runner 丢弃已缓存的旧驱动实例,下次任务会用带桥接的新实例
      try { await taskRunner.refreshDriver(); } catch { /* 忽略 */ }
      pushLog(ready ? 'ok' : 'warn', ready ? '无障碍桥接已安装并启用' : '桥接已安装,但服务未成功启用(请手动在系统设置中开启)');
      return { ok: true, bridgeReady: ready };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  });

  // ===== 手动指定 adb.exe 路径 =====
  ipcMain.handle('system:pickAdb', async () => {
    const win = ctx.getMainWindow();
    const result = await dialog.showOpenDialog(win, {
      title: '选择雷电模拟器的 adb.exe(通常位于 ...\\LDPlayer14\\adb.exe)',
      properties: ['openFile'],
      filters: [
        { name: 'adb', extensions: ['exe'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    const picked = result.filePaths[0];
    try { writeUserDataFile('emulator-adb.txt', picked); } catch { /* 写失败不阻止探测 */ }
    // 刷新内存中的 adb 路径并重新连接
    appConfig.emulatorAdbPath = picked;
    try {
      const info = await clientManager.ensureClient({ onLog: pushLog });
      return {
        canceled: false, path: picked,
        ok: info.mode === 'android',
        serial: info.serial || null,
        bridgeReady: !!info.bridgeReady,
      };
    } catch (e) {
      return { canceled: false, path: picked, ok: false, reason: e.message };
    }
  });

  // ===== 重新检测模拟器 =====
  ipcMain.handle('system:redetect', async () => {
    const adbPath = appConfig.emulatorAdbPath || clientManager.findAdb();
    const serial = await clientManager.probeEmulator(adbPath);
    if (!serial) return { emulatorConnected: false, connected: false, adbPath };
    const appInstalled = await clientManager.isAppInstalled(adbPath, serial);
    const bridgeReady = await clientManager.isBridgeReady(adbPath, serial);
    return { emulatorConnected: true, connected: true, serial, adbPath, appInstalled, bridgeReady };
  });

  // ===== 向后兼容:保留旧的"打开客户端"接口名,内部走模拟器连接 =====
  ipcMain.handle('system:openClient', async () => {
    try {
      const info = await clientManager.ensureClient({ onLog: pushLog });
      return { ok: true, ...info };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  });

  // ===== 文件选择(图片/语音) =====
  ipcMain.handle('system:pickFile', async (_e, type) => {
    const filters = type === 'image'
      ? [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
      : [{ name: '音频', extensions: ['mp3', 'wav', 'amr', 'aac', 'm4a'] }];
    const win = ctx.getMainWindow();
    const result = await dialog.showOpenDialog(win, {
      title: type === 'image' ? '选择图片' : '选择音频',
      properties: ['openFile'],
      filters,
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    const p = result.filePaths[0];
    let dataUrl = null;
    try {
      if (type === 'image') {
        const ext = p.toLowerCase().split('.').pop();
        const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif'
          : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        const buf = fs.readFileSync(p);
        if (buf.length < 2 * 1024 * 1024) dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      }
    } catch { /* 预览失败不影响选择 */ }
    return { canceled: false, path: p, name: path.basename(p), dataUrl };
  });

  ipcMain.handle('system:showInFolder', (_e, p) => {
    try { shell.showItemInFolder(p); return { ok: true }; } catch { return { ok: false }; }
  });

  // ===== 配置持久化 =====
  ipcMain.handle('config:get', (_e, key) => dataStore.getConfig(key));
  ipcMain.handle('config:set', (_e, key, value) => { dataStore.setConfig(key, value); return { ok: true }; });
  ipcMain.handle('config:all', () => dataStore.allConfig());
}

module.exports = { registerSystemIpc };
