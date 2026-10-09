// Read-only: no start-server, connect, install, launch, keyboard, click or send.
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const require = createRequire(import.meta.url);
const manager = require('../electron/services/client-manager');
const run = promisify(execFile);
const info = await manager.getHealth();
let appVersion = null;
if (info.serial && info.appInstalled) {
  try {
    const { stdout } = await run(info.adbPath, ['-s', info.serial, 'shell', 'dumpsys package com.sybl.voiceroom'], { timeout: 10000, windowsHide: true });
    appVersion = /versionName=(\S+)/.exec(stdout)?.[1] || null;
  }
  catch {
  }
}
console.log(JSON.stringify({ ...info, appVersion, bridgeProtocol: '未握手；此诊断不发送广播或启用服务', readOnly: true }, null, 2));
if (!info.emulatorConnected || !info.appInstalled)
  process.exitCode = 1;
