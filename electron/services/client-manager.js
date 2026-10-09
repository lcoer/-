const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const execFileAsync = promisify(execFile);
const candidates = ['D:\\leidian\\LDPlayer14', 'D:\\leidian\\LDPlayer9', 'C:\\leidian\\LDPlayer14', 'C:\\leidian\\LDPlayer9', 'D:\\LDPlayer\\LDPlayer14', 'C:\\LDPlayer\\LDPlayer14', 'C:\\Program Files\\LDPlayer\\LDPlayer14'];
function findAdb() {
  if (config.emulatorAdbPath && fs.existsSync(config.emulatorAdbPath))
    return config.emulatorAdbPath;
  return candidates.map(p => path.join(p, 'adb.exe')).find(p => fs.existsSync(p)) || 'adb';
}
function pickSerial(stdout, preferred = null) {
  const serials = String(stdout || '').split(/\r?\n/).map(s => /^(\S+)\s+device(?:\s|$)/.exec(s)?.[1]).filter(Boolean);
  if (preferred)
    return serials.includes(preferred) ? preferred : null;
  return serials.find(s => s.startsWith('emulator-')) || serials.find(s => s.startsWith('127.0.0.1:')) || serials[0] || null;
}
function createClientManager(deps = {}) {
  const execute = deps.exec || execFileAsync;
  const locate = deps.findAdb || findAdb;
  let explicitPath = null;
  let state = {
    mode: 'disconnected', adbPath: null, serial: null, bridgeReady: false, appInstalled: false, demoForced: false
  };
  const run = (exe, args, signal, timeout = 15000) => execute(exe, args, { signal, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  async function probeEmulator(adbPath, { signal, preferred } = {}) {
    try {
      const r = await run(adbPath, ['devices'], signal, 10000);
      return pickSerial(r.stdout, preferred);
    }
    catch (e) {
      if (e.name === 'AbortError' || signal?.aborted)
        throw e;
      return null;
    }
  }
  async function isAppInstalled(adbPath, serial, { signal } = {}) {
    try {
      const r = await run(adbPath, ['-s', serial, 'shell', 'pm list packages com.sybl.voiceroom'], signal);
      return String(r.stdout).includes('package:com.sybl.voiceroom');
    }
    catch (e) {
      if (e.name === 'AbortError' || signal?.aborted)
        throw e;
      return false;
    }
  }
  async function isBridgeReady(adbPath, serial, { signal } = {}) {
    try {
      const r = await run(adbPath, ['-s', serial, 'shell', 'dumpsys accessibility'], signal);
      return /Bound services:[\s\S]*com\.syl\.bridge|Bound services:[\s\S]*SYL Bridge/.test(r.stdout);
    }
    catch (e) {
      if (e.name === 'AbortError' || signal?.aborted)
        throw e;
      return false;
    }
  }
  async function getHealth({ signal } = {}) {
    // Inspect state without launching the app or modifying accessibility settings.
    const adbPath = explicitPath || state.adbPath || locate();
    const serial = await probeEmulator(adbPath, { signal, preferred: state.serial });
    const appInstalled = serial ? await isAppInstalled(adbPath, serial, { signal }) : false;
    const bridgeServiceEnabled = appInstalled ? await isBridgeReady(adbPath, serial, { signal }) : false;
    const bridgeReady = bridgeServiceEnabled && state.protocolVersion === 2 && state.serial === serial && state.adbPath === adbPath;
    return {
      adbPath, serial, emulatorConnected: !!serial, connected: !!serial, appInstalled, bridgeServiceEnabled, bridgeReady, protocolVersion: bridgeReady ? 2 : null, mode: serial && appInstalled ? 'android' : 'disconnected'
    };
  }
  async function ensureClient({ signal, onLog = () => {
  } } = {}) {
    const adbPath = explicitPath || locate();
    onLog('info', `检测模拟器: ${adbPath}`);
    await run(adbPath, ['start-server'], signal, 20000);
    const serial = await probeEmulator(adbPath, { signal, preferred: state.adbPath === adbPath ? state.serial : null });
    if (!serial) {
      state = {
        ...state, mode: 'disconnected', adbPath, serial: null, bridgeReady: false, appInstalled: false
      };
      throw Error('EMULATOR_NOT_FOUND: 请启动模拟器并连接设备');
    }
    const appInstalled = await isAppInstalled(adbPath, serial, { signal });
    if (!appInstalled) {
      state = {
        ...state, mode: 'disconnected', adbPath, serial, bridgeReady: false, appInstalled: false
      };
      throw Error('APP_NOT_INSTALLED: 模拟器未安装双鱼部落');
    }
    const bridgeServiceEnabled = await isBridgeReady(adbPath, serial, { signal });
    state = {
      mode: 'android', adbPath, serial, bridgeServiceEnabled, bridgeReady: false, protocolVersion: null, appInstalled: true, demoForced: false
    };
    onLog('ok', `模拟器已连接: ${serial}`);
    return { ...state };
  }
  function reset(adbPath = null) {
    explicitPath = adbPath;
    state = {
      mode: 'disconnected', adbPath, serial: null, bridgeReady: false, appInstalled: false, demoForced: false
    };
  }
  function recordBridgeHandshake({ serial, adbPath, protocolVersion }) {
    // Service enablement alone does not prove the APK speaks protocol v2.
    if (serial === state.serial && adbPath === state.adbPath && protocolVersion === 2) {
      state.protocolVersion = 2;
      state.bridgeReady = true;
    }
  }
  return {
    findAdb: () => explicitPath || locate(), probeEmulator, isAppInstalled, isBridgeReady, getHealth, ensureClient, reset, recordBridgeHandshake, getClientState: () => ({ ...state }), isDemoForced: () => false, isCdpAlive: async () => false
  };
}
module.exports = { ...createClientManager(), createClientManager, pickSerial };
