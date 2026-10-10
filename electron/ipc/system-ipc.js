const { ipcMain, dialog, shell, app } = require('electron');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const dataStore = require('../services/data-store');
const clientManager = require('../services/client-manager');
const taskRunner = require('../services/task-runner');
const { validateConfigChange } = require('../services/config-policy');
const { safeHandle } = require('./safe-handle');
function registerSystemIpc(ctx) {
  const mode = () => dataStore.getConfig('settings')?.executionMode === 'demo' ? 'demo' : 'android';
  const register = safeHandle(ipcMain, ctx);
  const handle = (channel, fn) => register(channel, (_e, ...args) => fn(...args));
  const connect = () => taskRunner.withDeviceOperation('connect', async (signal) => {
    clientManager.reset();
    const info = await clientManager.ensureClient({ signal, onLog: (l, m) => dataStore.pushSystemLog(l, m) });
    let protocolError = null;
    if (info.bridgeServiceEnabled) {
      try {
        const { AdbClient } = await import('../../src/adb-client.mjs');
        const { BridgeClient } = await import('../../src/bridge-client.mjs');
        const bridge = new BridgeClient(new AdbClient({ adbPath: info.adbPath, serial: info.serial }));
        const result = await bridge.ensureCompatible({ signal });
        clientManager.recordBridgeHandshake({ ...info, protocolVersion: result.protocolVersion });
      }
      catch (e) {
        if (e.name === 'AbortError')
          throw e;
        protocolError = e.message;
      }
    }
    return { ok: true, ...clientManager.getClientState(), protocolError };
  });
  handle('system:getInfo', async () => {
    const health = await clientManager.getHealth();
    const recoveryRequired = !!dataStore.getStatus().recoveryRequired;
    const collectionRecoveryRequired = !!dataStore.getStatus().collectionRecoveryRequired;
    return { ...health, executionMode: mode(), demoMode: mode() === 'demo', version: config.appVersion, platform: process.platform,
      capabilities: { text: true, image: false, voice: false, requiresBridge: true }, deviceOwner: taskRunner.getStatus().deviceOwner, recoveryRequired, collectionRecoveryRequired };
  });
  handle('system:connectEmulator', connect);
  handle('system:openClient', connect);
  handle('system:redetect', () => clientManager.getHealth());
  handle('system:installBridge', () => taskRunner.withDeviceOperation('installBridge', async (signal) => {
    const info = await clientManager.ensureClient({ signal });
    if (!fs.existsSync(config.bridgeApkPath))
      return { ok: false, reason: 'BRIDGE_APK_NOT_FOUND' };
    const { AdbClient } = await import('../../src/adb-client.mjs');
    const { BridgeClient } = await import('../../src/bridge-client.mjs');
    const adb = new AdbClient({ adbPath: info.adbPath, serial: info.serial });
    adb.setSignal(signal);
    const bridge = new BridgeClient(adb);
    bridge.setSignal(signal);
    await bridge.install(config.bridgeApkPath, { signal });
    if (!await bridge.enableService({ signal }))
      return { ok: false, bridgeReady: false, reason: 'BRIDGE_NOT_ENABLED: 请在模拟器无障碍设置中启用 SYL Bridge' };
    const result = await bridge.ensureCompatible({ signal });
    if (!result.connected)
      return { ok: false, bridgeReady: false, reason: 'BRIDGE_NOT_CONNECTED' };
    clientManager.recordBridgeHandshake({ ...info, protocolVersion: result.protocolVersion });
    return { ok: true, bridgeReady: true, protocolVersion: result.protocolVersion };
  }));
  handle('system:pickAdb', async () => {
    const result = await dialog.showOpenDialog(ctx.getMainWindow(), { title: '选择模拟器的 adb.exe', properties: ['openFile'], filters: [{ name: 'adb', extensions: ['exe'] }] });
    if (result.canceled || !result.filePaths.length)
      return { canceled: true };
    return taskRunner.withDeviceOperation('changeAdb', async (signal) => {
      const picked = result.filePaths[0], previous = config.emulatorAdbPath;
      // Validate executable by running ADB version before changing saved settings.
      const { execFile } = require('child_process');
      const { promisify } = require('util');
      const response = await promisify(execFile)(picked, ['version'], { timeout: 10000, signal, windowsHide: true });
      if (!/Android Debug Bridge/.test(response.stdout))
        return { ok: false, reason: 'INVALID_ADB' };
      const dir = app.getPath('userData');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'emulator-adb.txt'), picked, 'utf8');
      config.emulatorAdbPath = picked;
      clientManager.reset(picked);
      try {
        return { ok: true, canceled: false, path: picked, ...await clientManager.ensureClient({ signal }) };
      }
      catch (e) {
        return { ok: false, canceled: false, path: picked, reason: e.message, saved: true, previousPath: previous };
      }
    });
  });
  handle('system:pickFile', async (type) => {
    if (!['image', 'voice'].includes(type))
      return { ok: false, reason: 'INVALID_FILE_TYPE' };
    const result = await dialog.showOpenDialog(ctx.getMainWindow(), { properties: ['openFile'], filters: [{ name: type, extensions: type === 'image' ? ['png', 'jpg', 'jpeg', 'gif', 'webp'] : ['mp3', 'wav', 'amr', 'aac', 'm4a'] }] });
    if (result.canceled || !result.filePaths.length)
      return { canceled: true };
    const p = result.filePaths[0];
    let dataUrl = null;
    if (type === 'image') {
      const buf = fs.readFileSync(p), ext = path.extname(p).slice(1).toLowerCase();
      if (buf.length < 2 * 1024 * 1024)
        dataUrl = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buf.toString('base64')}`;
    }
    return { canceled: false, path: p, name: path.basename(p), dataUrl };
  });
  handle('system:showInFolder', p => {
    if (typeof p !== 'string')
      throw Error('INVALID_PATH');
    shell.showItemInFolder(p);
    return { ok: true };
  });
  register('config:get', (_e, key) => dataStore.getConfig(key));
  register('config:all', () => dataStore.allConfig());
  handle('config:set', async (key, value) => {
    const valid = validateConfigChange(key, value);
    if (!valid.ok)
      return valid;
    if (key === 'settings')
      return taskRunner.withDeviceOperation('changeMode', async () => {
        const previous = dataStore.getConfig('settings') || { executionMode: 'android' };
        // Preserve the device identity maintained by the main process and the
        // account UID when older clients only submit an execution mode.
        const next = { ...previous, executionMode: value.executionMode };
        if (Object.hasOwn(value, 'senderAccountUid')) next.senderAccountUid = value.senderAccountUid;
        dataStore.setConfig(key, next);
        try {
          dataStore.setSource(value.executionMode === 'demo' ? 'demo' : 'room');
        }
        catch (e) {
          dataStore.setConfig(key, previous);
          throw e;
        }
        return { ok: true };
      });
    dataStore.setConfig(key, value);
    return { ok: true };
  });
}
module.exports = { registerSystemIpc };
