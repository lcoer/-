// Electron renderer test using actual UI/preload/IPC with isolated storage and no physical device.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const out = process.env.SYBL_SMOKE_DIR;
const productRoot = process.env.SYBL_SMOKE_APP_ROOT || path.resolve(__dirname, '..');
const load = file => require(path.join(productRoot, file));
if (!out)
  throw Error('Run through npm run smoke');
fs.mkdirSync(path.join(out, 'user-data'), { recursive: true });
app.setPath('userData', path.join(out, 'user-data'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.whenReady().then(async () => {
  const store = load('electron/services/data-store.js');
  const manager = load('electron/services/client-manager.js');
  manager.getHealth = async () => ({ emulatorConnected: false, mode: 'disconnected', serial: null, bridgeReady: false, appInstalled: false });
  manager.ensureClient = async () => {
    throw Error('SMOKE_DEVICE_DISABLED');
  };
  store.init();
  const { startStaticServer } = load('electron/services/static-server.js');
  const { server, port } = await startStaticServer({ port: 0 });
  const win = new BrowserWindow({ width: 1360, height: 860, show: false, webPreferences: { preload: path.join(productRoot, 'electron/preload.js'), contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  const ctx = { getMainWindow: () => win };
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3 && !message.includes('net::ERR'))
      errors.push(message);
  });
  win.webContents.on('render-process-gone', (_e, d) => errors.push(`Renderer exited ${d.reason}`));
  load('electron/ipc/data-ipc.js').registerDataIpc(ctx);
  load('electron/ipc/task-ipc.js').registerTaskIpc(ctx);
  load('electron/ipc/system-ipc.js').registerSystemIpc(ctx);
  load('electron/ipc/window-ipc.js').registerWindowIpc(ctx);
  try {
    await win.loadURL(`http://127.0.0.1:${port}/index.html`);
    await win.webContents.executeJavaScript('window.__appReady');
    const checks = await win.webContents.executeJavaScript(`(async()=>{
      const policy=await import('/engine/task-policy.mjs');
      const config=await window.api.config.get('settings');
      const empty=policy.validatePrivateConfig({contents:[],targets:[]});
      const dates=await window.api.portal.getDates();
      const rejected=await window.api.task.start('private',{contents:[],targets:[]});
      return {mode:config.executionMode,mediaDisabled:document.getElementById('copyImageEnable').disabled,emptyRejected:!empty.ok,mainValidation:!rejected.ok&&rejected.reason.startsWith('EMPTY_CONTENT'),today:dates.today,ui:!!document.getElementById('taskPrivatePending')};
  })()`);
    if (checks.mode !== 'android' || !checks.mediaDisabled || !checks.emptyRejected || !checks.mainValidation || !checks.ui)
      throw Error(`Renderer assertions failed: ${JSON.stringify(checks)}`);
    for (const view of ['ranking', 'rules', 'task', 'copywriting', 'blacklist', 'settings']) {
      await win.webContents.executeJavaScript(`document.querySelector('.nav-item[data-view="${view}"]').click()`);
      const active = await win.webContents.executeJavaScript(`document.querySelector('.nav-item.active')?.dataset.view`);
      if (active !== view)
        throw Error(`Navigation failed: ${view} => ${active}`);
      await new Promise(r => setTimeout(r, 450));
      const shot = await win.webContents.capturePage();
      fs.writeFileSync(path.join(out, `${view}.png`), shot.toPNG());
    }
    if (errors.length)
      throw Error(errors.join('\n'));
    console.log('SMOKE PASSED', JSON.stringify(checks));
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: true, checks, errors }, null, 2));
  }
  catch (e) {
    console.error('SMOKE FAILED', e.stack);
    process.exitCode = 1;
  }
  finally {
    store.shutdown();
    server.closeAllConnections?.();
    server.close();
    win.destroy();
    app.exit(process.exitCode || 0);
  }
}).catch(e => {
  console.error(e.stack);
  app.exit(1);
});
