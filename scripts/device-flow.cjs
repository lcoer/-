// Explicit real-device acceptance. Uses the actual renderer/preload/IPC with
// isolated data and a send boundary that cancels before any message is sent.
const {app,BrowserWindow}=require('electron');
const fs=require('fs');const path=require('path');const {pathToFileURL}=require('url');
if(process.env.SYBL_DEVICE_FLOW!=='1')throw Error('Explicit SYBL_DEVICE_FLOW=1 required');
const root=path.resolve(__dirname,'..');
const out=path.join(root,'tmp','device-flow');fs.mkdirSync(out,{recursive:true});
app.setPath('userData',path.join(out,'user-data'));app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function bounded(p,ms,label){let timer;try{return await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error(label+' timeout')),ms))]);}finally{clearTimeout(timer);}}
const report={startedAt:new Date().toISOString(),cases:[],logs:[],errors:[],realDevice:true,sends:0};
let win,server,runner,store;
async function save(){fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));}
app.whenReady().then(async()=>{
 try{
  store=require('../electron/services/data-store');store.init();
  const source=path.join(process.env.APPDATA||'','shuangyu-assistant','config.json');
  const cfg=fs.existsSync(source)?JSON.parse(fs.readFileSync(source,'utf8')):{};
  for(const key of ['copywriting','rules','settings','blacklist'])if(cfg[key])store.setConfig(key,cfg[key]);
  store.setConfig('settings',{...(cfg.settings||{}),executionMode:'android'});
  store.setConfig('collection',{scope:'multi',maxRooms:1,maxPages:2,maxProfiles:2});
  const {AndroidDriver}=await import(pathToFileURL(path.join(root,'src/android-driver.mjs')).href);
  const send=AndroidDriver.prototype.sendPrivateMessage;
  AndroidDriver.prototype.sendPrivateMessage=async function(nickname,text,opts={}){
   return send.call(this,nickname,text,{...opts,onBeforeSend:async()=>{
    report.sendBoundaryReached=true;
    report.privateStopPromise=undefined;
    void runner.stop('private').catch(e=>report.errors.push(e.message));
    const error=Error('DEVICE_FLOW_CANCELLED_BEFORE_SEND');error.name='AbortError';throw error;
   }});
  };
  runner=require('../electron/services/task-runner');
  const originalStopCollect=runner.stopCollect;
  runner.stopCollect=async()=>{console.log('stop IPC began');const r=await originalStopCollect();console.log('stop IPC returned',JSON.stringify(r));return r;};
  const hosted=await require('../electron/services/static-server').startStaticServer({port:0});server=hosted.server;
  win=new BrowserWindow({width:1360,height:860,show:true,title:'双鱼助手 · 全流程验证',webPreferences:{preload:path.join(root,'electron/preload.js'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  win.webContents.on('console-message',(_event,level,message)=>{if(level>=2){report.errors.push('renderer: '+message);console.log('renderer:',message);save();}});
  const ctx={getMainWindow:()=>win};
  for(const part of ['data','task','system','window'])require('../electron/ipc/'+part+'-ipc')['register'+part[0].toUpperCase()+part.slice(1)+'Ipc'](ctx);
  store.setStreamCallback(ev=>win?.webContents.send('portal:stream',ev));
  runner.setLogCallback(log=>{report.logs.push(log);console.log(`[${log.task}] ${log.msg}`);win?.webContents.send('task:log',log);save();});
  runner.setStatusCallback(status=>win?.webContents.send('task:status',status));
  await win.loadURL(`http://127.0.0.1:${hosted.port}/index.html`);
  await bounded(win.webContents.executeJavaScript('window.__appReady'),30000,'renderer ready');
  await win.webContents.executeJavaScript("window.alert=message=>{console.warn('flow alert',message)};window.flowStatusEvents=[];window.api.task.onStatus(s=>window.flowStatusEvents.push({revision:s.statusRevision,state:s.collect.state,owner:s.deviceOwner,time:Date.now()}));window.addEventListener('unhandledrejection',e=>console.error('Unhandled flow',e.reason?.stack||String(e.reason)));void 0");
  const js=code=>win.webContents.executeJavaScript(code);
  const state=()=>runner.getStatus();
  async function until(predicate,ms,label){const start=Date.now();while(Date.now()-start<ms){const s=state();if(predicate(s))return s;await delay(100);}throw Error(label+' timeout '+JSON.stringify(state().collect));}
  async function capture(name){const image=await win.webContents.capturePage();fs.writeFileSync(path.join(out,name+'.png'),image.toPNG());}
  async function stopCollect(label){
   await capture(label+'-before');const started=performance.now();
   const button=await js("({disabled:document.getElementById('guestCollectBtn').disabled,text:document.getElementById('guestCollectBtnText').textContent})");
   if(button.disabled)throw Error(label+' stop button disabled: '+button.text);
   await js("document.getElementById('guestCollectBtn').click()");
   await until(s=>!s.collect.running&&!s.deviceOwner,15000,label+' stop');
   const backendStopMs=Math.round(performance.now()-started);
   for(let i=0;i<30;i++){
    const ready=await js("!document.getElementById('guestCollectBtn').disabled&&!document.getElementById('guestCollectBtnText').textContent.includes('停止中')");
    if(ready)break;await delay(100);
   }
   const ui=await js("({disabled:document.getElementById('guestCollectBtn').disabled,text:document.getElementById('guestCollectBtnText').textContent,live:document.getElementById('portalLiveText').textContent})");
   const events=await js('window.flowStatusEvents.slice(-5)');
   const item={name:label,backendStopMs,stopMs:Math.round(performance.now()-started),ui,state:state().collect.state,deviceOwner:state().deviceOwner,events};
   report.cases.push(item);await capture(label+'-after');await save();console.log(JSON.stringify(item));
   if(ui.disabled||ui.text.includes('停止中'))throw Error(label+' stale stopping UI');
  }
  await js("document.getElementById('guestCollectBtn').click()");
  await until(s=>s.collect.running,10000,'collect initializing');
  await stopCollect('collect-initialization');
  await js("document.getElementById('guestCollectBtn').click()");
  await until(s=>s.collect.stats.waitingForNextCycle,90000,'collect cooldown');
  if(!state().collect.stats.rounds)throw Error('Collection did not finish a real room scan');
  report.collectedRecords=store.getRecords().total;
  await stopCollect('collect-cooldown');
  await js("document.getElementById('guestCollectBtn').click()");
  await until(s=>s.collect.stats.room&&s.collect.running,45000,'collect room');
  await stopCollect('collect-room-read');
  await js("document.querySelector('.nav-item[data-view=task]').click()");
  const privateCfg={executionMode:'android',targets:[{uid:'888188',nickname:'音-8v',source:'local',uidReal:true}],contents:cfg.copywriting?.contents?.slice(0,1)||['你好呀，很高兴认识你~'],mode:'select',selectedIndex:0,delayMin:0,delayMax:0};
  const startResult=await js(`window.api.task.start('private',${JSON.stringify(privateCfg)})`);
  if(!startResult.ok)throw Error('private start '+startResult.reason);
  await until(s=>report.sendBoundaryReached&&!s.private.running&&!s.deviceOwner,90000,'private full navigation');
  report.cases.push({name:'private-navigation-input-cancel',sendBoundaryReached:report.sendBoundaryReached,state:state().private.state,sent:false});
  const drv=new AndroidDriver({forceBridge:true,adbOpts:{adbPath:'D:\\leidian\\LDPlayer14\\adb.exe',serial:'emulator-5554'}});
  const chat=await drv.bridge.dumpUi();if(chat.nodes.some(n=>n.shortId==='input_message'&&n.text===privateCfg.contents[0]))await drv.bridge.setText('input_message','');
  const again=await js(`window.api.task.start('private',${JSON.stringify(privateCfg)})`);if(!again.ok)throw Error('private restart '+again.reason);
  await until(s=>s.private.running,10000,'private restarted');const at=performance.now();
  await js("document.getElementById('taskPrivateStop').click()");
  await until(s=>!s.private.running&&!s.deviceOwner,15000,'private stop');
  await delay(250);
  const privateUi=await js("({text:document.getElementById('taskPrivateText').textContent,startDisabled:document.getElementById('taskPrivateStart').disabled})");
  report.cases.push({name:'private-restart-stop',stopMs:Math.round(performance.now()-at),state:state().private.state,ui:privateUi});
  if(privateUi.startDisabled||privateUi.text==='停止中')throw Error('Private UI stale stopping');
  await capture('private-stopped');
  await js("document.querySelector('.nav-item[data-view=ranking]').click();document.getElementById('guestCollectBtn').click()");
  await until(s=>s.collect.stats.room&&s.collect.running,45000,'collection after private');
  await stopCollect('collect-after-private');report.ok=true;
 }catch(e){report.ok=false;report.errors.push(e.stack||e.message);console.error(e.stack||e);process.exitCode=1;}
 finally{await save();if(runner)await bounded(runner.stopAll(),8000,'shutdown').catch(e=>console.error(e.message));store?.shutdown();server?.closeAllConnections?.();server?.close();win?.destroy();app.exit(process.exitCode||0);}
}).catch(e=>{console.error(e);app.exit(1);});
