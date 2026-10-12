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
  // Each isolated smoke run starts with its own known observation fixtures.
  store.clearDemoRecords(true);
  const { startStaticServer } = load('electron/services/static-server.js');
  const { server, port } = await startStaticServer({ port: 0 });
  const win = new BrowserWindow({ width: 1360, height: 860, show: false, webPreferences: { preload: path.join(productRoot, 'electron/preload.js'), contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  const ctx = { getMainWindow: () => win };
  const errors = [];
  // Acceptance UI must start with external networking unavailable.
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{
    const host=new URL(details.url).hostname;
    callback({cancel:host!=='127.0.0.1'&&host!=='localhost'});
  });
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
    const localFonts=await win.webContents.executeJavaScript(`(async()=>{
      const families=['Inter','JetBrains Mono','Material Symbols Outlined'];
      for(const family of families){const faces=await document.fonts.load('400 16px "'+family+'"');if(!faces.length||faces.some(face=>face.status!=='loaded'))throw Error('Local font unavailable: '+family);}
      return true;
    })()`);
    const checks = await win.webContents.executeJavaScript(`(async()=>{
      const policy=await import('/engine/task-policy.mjs');
      const config=await window.api.config.get('settings');
      const empty=policy.validatePrivateConfig({contents:[],targets:[]});
      const dates=await window.api.portal.getDates();
      const rejected=await window.api.task.start('private',{contents:[],targets:[]});
      return {mode:config.executionMode,mediaDisabled:document.getElementById('copyImageEnable').disabled,emptyRejected:!empty.ok,mainValidation:!rejected.ok&&rejected.reason.startsWith('EMPTY_CONTENT'),today:dates.today,ui:!!document.getElementById('taskPrivatePending')};
  })()`);
    checks.localFontsOffline=localFonts;
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
    const numericBadge=fs.readFileSync(path.join(__dirname,'../tests/fixtures/levels/numeric.png'));
    const digitValues=load('src/level-digits.cjs').readLevelDigits(numericBadge,{x:0,y:0,width:180,height:41}).values;
    if(digitValues.wealthLevel!==37||digitValues.charmLevel!==103)throw Error('Bundled level digit templates failed');
    if(!fs.readFileSync(path.join(productRoot,'src/level-ocr.ps1'),'utf8').includes('OcrEngine'))throw Error('Bundled OCR fallback missing');
    checks.levelAssets=true;
    store.ingestRealRecords([
      {uid:'810001',uidReal:true,nickname:'等级37<&>',wealthLevel:37,charmLevel:103,sex:'female'},
      {uid:'810002',uidReal:true,nickname:'等级54',wealthLevel:54,charmLevel:1,sex:'male'},
      {uid:'810003',uidReal:true,nickname:'隐藏等级',wealthLevel:'?',charmLevel:'?',sex:'male'},
      {uid:'810004',uidReal:true,nickname:'尚未读取',sex:'unknown'},
      {uid:'nsmoke-vanity-hint',uidReal:false,nickname:'待核验档案<&>',room:'独立测试房间',roomCode:'smoke-room',publicIdentityType:'nice_number',publicIdentityValue:'22217',wealthLevel:37,charmLevel:'?',sex:'female'}
    ]);
    Object.assign(checks,await win.webContents.executeJavaScript(`(async()=>{
      document.querySelector('.nav-item[data-view="recommendation"]').click();
      document.getElementById('recommendLevelField').value='wealthLevel';
      document.getElementById('recommendThreshold').value='54';
      await RecommendationView.saveClassification();
      const list=await window.api.recommendation.list();
      if(list.users.some(user=>user.uid==='nsmoke-vanity-hint'||user.uid==='22217'))throw Error('Unverified vanity identity became recommendation author');
      if(getComputedStyle(document.getElementById('recommendEmpty')).display!=='none')throw Error('Empty recommendation hint visible with users');
      const group=uid=>list.users.find(user=>user.uid===uid)?.group;
      if(group('810001')!=='low'||group('810002')!=='high'||group('810003')!=='high'||group('810004')!=='unclassified')throw Error('Level boundary or question mark grouping failed');
      if(document.querySelector('#recommendRows input')||document.getElementById('recommendContent')||window.api.recommendation.assign||window.api.recommendation.assignments)throw Error('Removed recommendation actions remain exposed');
      return {recommendationClassification:true,recommendationActionsRemoved:true};
    })()`));
    Object.assign(checks,await win.webContents.executeJavaScript(`(async()=>{
      document.querySelector('.nav-item[data-view="ranking"]').click();
      GuestView.onStream({type:'batch',payload:{added:1}});
      let card;const deadline=Date.now()+3000;
      do{card=[...document.querySelectorAll('#guestGrid .guest-card')].find(item=>item.textContent.includes('待核验档案<&>'));if(card)break;await new Promise(resolve=>setTimeout(resolve,30));}while(Date.now()<deadline);
      if(!card||!card.textContent.includes('待核验')||!card.textContent.includes('靓号')||!card.textContent.includes('22217')||!card.textContent.includes('财富等级')||!card.textContent.includes('37')||!card.textContent.includes('???（隐藏）')||!card.textContent.includes('女神'))throw Error('Unverified public profile rendering failed');
      if(card.textContent.includes('nsmoke-vanity-hint'))throw Error('Placeholder hash displayed as real UID');
      return {vanityProfileRendering:true};
    })()`));
    Object.assign(checks,await win.webContents.executeJavaScript(`(async()=>{
      document.querySelector('.nav-item[data-view="task"]').click();
      await window.api.config.set('settings',{executionMode:'demo'});
      const source=document.querySelector('input[name="source"][value="local"]');source.checked=true;source.dispatchEvent(new Event('change'));
      document.getElementById('localIdList').value='810001\\n810002\\n810003\\n810004';
      document.getElementById('delayMin').value='0';document.getElementById('delayMax').value='0';document.getElementById('sendLimit').value='0';
      const enabled=document.getElementById('privateLevelEnabled'),high=document.getElementById('privateLevelHigh'),low=document.getElementById('privateLevelLow'),button=document.getElementById('taskPrivateStart');
      const original=Dialog.confirm;let prompt='';Dialog.confirm=async text=>{prompt=text;return true;};
      try{
        for(const [useHigh,useLow,count] of [[true,false,2],[false,true,1],[true,true,3]]){
          enabled.checked=true;high.checked=useHigh;low.checked=useLow;
          for(const input of [enabled,high,low])input.dispatchEvent(new Event('change'));
          button.click();const deadline=Date.now()+4000;let status;
          do{await new Promise(r=>setTimeout(r,30));status=await window.api.task.getStatus();if(!button.disabled&&!status.private.running)break;if(Date.now()>deadline)throw Error('Level-filter UI did not settle');}while(true);
          if(status.private.stats.simulated!==count||status.private.stats.ok!==0)throw Error('Wrong level-filter recipients: '+JSON.stringify(status.private));
          if(!prompt.includes('等级筛选')||!prompt.includes('未识别或未核验 1 人'))throw Error('Level exclusion count missing from confirmation');
        }
        let confirmations=0;Dialog.confirm=async()=>{confirmations++;return true;};high.checked=false;low.checked=false;high.dispatchEvent(new Event('change'));low.dispatchEvent(new Event('change'));button.click();await new Promise(r=>setTimeout(r,150));if(confirmations)throw Error('Empty level selection started task');
        high.checked=true;high.dispatchEvent(new Event('change'));await new Promise(r=>setTimeout(r,100));
        const preference=await window.api.config.get('privateLevelFilter');if(!preference.enabled||preference.groups.join()!=='high')throw Error('Level preference not saved');
        enabled.checked=false;enabled.dispatchEvent(new Event('change'));
        const saveDeadline=Date.now()+2000;while((await window.api.config.get('privateLevelFilter')).enabled){if(Date.now()>saveDeadline)throw Error('Disabled preference not saved');await new Promise(r=>setTimeout(r,30));}
        return {consoleHighLowSelection:true,consoleUnknownExcluded:true,consoleEmptySelectionRejected:true,consoleLevelPreferenceSaved:true};
      }finally{Dialog.confirm=original;await window.api.config.set('settings',{executionMode:'android'});}
    })()`));
    const reload=store.createDataStore({dataDir:path.join(out,'user-data')});reload.init();
    const levelPreference=reload.getConfig('privateLevelFilter');
    if(levelPreference?.enabled!==false||levelPreference.groups.join()!=='high')throw Error('Level preference did not survive restart');
    checks.consoleLevelPreferenceRestart=true;
    if(reload.getRecommendations().threshold!==54)throw Error('Classification threshold did not survive restart');
    reload.shutdown();checks.classificationRestart=true;
    for (const view of ['ranking', 'recommendation', 'rules', 'task', 'copywriting', 'blacklist', 'settings']) {
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
