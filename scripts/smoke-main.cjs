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
    Object.assign(checks,await win.webContents.executeJavaScript(`(async()=>{
      const responses=await Promise.all(['welcome','call'].map(name=>window.api.task.start(name,{executionMode:'demo'})));
      const status=await window.api.task.getStatus();
      return {removedRoomTasks:!document.querySelector('[data-task="welcome"],[data-task="call"]')&&!document.getElementById('taskWelcomeStart')&&!document.getElementById('taskCallStart')&&!Object.hasOwn(status,'welcome')&&!Object.hasOwn(status,'call')&&responses.every(r=>!r.ok&&r.reason==='UNKNOWN_TASK')};
    })()`));
    if(!checks.removedRoomTasks)throw Error('Deleted room tasks still exposed');
    store.setConfig('settings', { ...store.getConfig('settings'), senderDeviceKey: 'smoke-device' });
    store.recordOutcome({ runId: `smoke-legacy-${Date.now()}`, machineCode: 'DEMO-MACHINE', targetUid: '99999', mode: 'android', outcome: 'unconfirmed' });
    Object.assign(checks, await win.webContents.executeJavaScript(`(async()=>{
      document.getElementById('senderAccountUid').value='77777';
      document.getElementById('setSenderAccountBtn').click();
      const deadline=Date.now()+3000;
      while((await window.api.config.get('settings')).senderAccountUid!=='77777') {
        if(Date.now()>deadline) throw Error('Sender account form did not save');
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      const switched=await window.api.config.set('settings',{executionMode:'demo',senderDeviceKey:'spoof'});
      const settings=await window.api.config.get('settings');
      const cleared=await window.api.portal.clearDemo(false);
      const source=await window.api.portal.getStatus();
      await window.api.config.set('settings',{executionMode:'android'});
      const pending=(await window.api.task.getPending()).results.find(r=>r.machineCode==='DEMO-MACHINE'&&r.targetUid==='99999');
      const resolved=await window.api.task.resolvePending({machineCode:pending.machineCode,targetUid:pending.targetUid,runId:pending.runId,resolution:'not_sent'});
      await Settings.refresh();
      return {senderSettings:switched.ok&&settings.senderAccountUid==='77777'&&settings.senderDeviceKey==='smoke-device',clearKeepsDemo:cleared.ok&&source.source==='demo'&&source.streaming,legacyReview:resolved.ok};
    })()`));
    if (!checks.senderSettings || !checks.clearKeepsDemo || !checks.legacyReview)
      throw Error(`Review fix assertions failed: ${JSON.stringify(checks)}`);
    Object.assign(checks, await win.webContents.executeJavaScript(`(async()=>{
      const input=document.getElementById('copywritingNewInput');
      input.value='😀'.repeat(2001);document.getElementById('copywritingAddBtn').click();
      const oversizedDraftPreserved=[...input.value].length===2001;
      const draft='验收<&> "😀"\\n多行';input.value=draft;
      const copy=await Copywriting.flush();
      const editorRoundTrip=copy.contents.at(-1)===draft&&(await window.api.config.get('copywriting')).contents.at(-1)===draft;
      document.querySelector('.copy-item[data-idx="'+(copy.contents.length-1)+'"]').click();
      await Copywriting.flush();
      document.querySelector('input[name="source"][value="local"]').click();
      document.getElementById('localIdList').value='11111\\n11111';
      document.getElementById('delayMin').value='0';document.getElementById('delayMax').value='0';document.getElementById('sendLimit').value='1';
      await window.api.config.set('settings',{executionMode:'demo'});
      const originalConfirm=Dialog.confirm;let confirmations=0;
      Dialog.confirm=async()=>{confirmations++;await new Promise(resolve=>setTimeout(resolve,120));return false;};
      const button=document.getElementById('taskPrivateStart');button.click();button.click();
      const cancelDeadline=Date.now()+3000;
      while(button.disabled){if(Date.now()>cancelDeadline)throw Error('Preparation did not settle');await new Promise(resolve=>setTimeout(resolve,30));}
      const oneConfirmation=confirmations===1;
      Dialog.confirm=async()=>true;button.click();
      const runDeadline=Date.now()+3000;let status;
      do{status=await window.api.task.getStatus();if(status.private.stats.simulated===1&&!status.private.running)break;if(Date.now()>runDeadline)throw Error('Demo UI private flow did not finish');await new Promise(resolve=>setTimeout(resolve,30));}while(true);
      Dialog.confirm=originalConfirm;await window.api.config.set('settings',{executionMode:'android'});await Settings.refresh();
      return {oversizedDraftPreserved,editorRoundTrip,oneConfirmation,demoPrivateLimit:status.private.stats.simulated===1&&status.private.stats.ok===0};
    })()`));
    if (!checks.oversizedDraftPreserved || !checks.editorRoundTrip || !checks.oneConfirmation || !checks.demoPrivateLimit)
      throw Error(`Customer UI assertions failed: ${JSON.stringify(checks)}`);
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
