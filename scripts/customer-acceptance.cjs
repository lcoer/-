// Real Electron/preload/IPC acceptance against a selected physical emulator.
// All application state is isolated; a durable guard caps real dispatch at one.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),{promisify}=require('node:util'),{execFile}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const target=process.env.SYBL_ACCEPTANCE_TARGET, sender=process.env.SYBL_ACCEPTANCE_SENDER;
if(!/^\d{1,32}$/.test(target||'')||!/^\d{1,32}$/.test(sender||''))throw Error('Explicit sender and test recipient UID required');
const base=path.join(root,'tmp','acceptance-2026-10-10');
const runId=new Date().toISOString().replace(/[:.]/g,'-');
const out=path.join(base,runId);fs.mkdirSync(out,{recursive:true});
const guard=path.join(base,`real-send-${target}.json`);
const originalConfig=path.join(process.env.APPDATA||'','shuangyu-assistant','config.json');
app.setPath('userData',path.join(out,'user-data'));fs.mkdirSync(app.getPath('userData'),{recursive:true});
app.disableHardwareAcceleration();app.commandLine.appendSwitch('no-sandbox');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const report={runId,realDevice:true,targetUid:target,senderUid:sender,maxDispatches:1,cases:[],logs:[],errors:[],dispatches:0};
let window,server,runner,store;
function save(){fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(base,'latest-real.json'),JSON.stringify({out,runId,...report},null,2));}
async function until(read,predicate,ms,label){const start=Date.now();while(Date.now()-start<ms){const value=await read();if(predicate(value))return value;await sleep(150);}throw Error(`${label}: timeout`);}
app.whenReady().then(async()=>{
 try{
  const cfg=fs.existsSync(originalConfig)?JSON.parse(fs.readFileSync(originalConfig,'utf8')):{};
  store=require('../electron/services/data-store');store.init();
  for(const key of ['rules','copywriting'])if(cfg[key])store.setConfig(key,cfg[key]);
  store.setConfig('settings',{executionMode:'android',senderAccountUid:sender});
  store.setConfig('blacklist',[]);store.setConfig('collection',{scope:'multi',maxRooms:2,maxPages:2,maxProfiles:2});
  const {AndroidDriver}=await import('../src/android-driver.mjs');
  const client=require('../electron/services/client-manager');
  runner=require('../electron/services/task-runner').createTaskRunner({dataStore:store,clientManager:client,createDriver:async info=>{
   const driver=new AndroidDriver({forceBridge:true,adbOpts:{adbPath:info.adbPath,serial:info.serial},onLog:(level,msg)=>{report.logs.push({level,msg,time:Date.now()});save();}});
   const dump=driver.bridge.dumpUi.bind(driver.bridge);
   driver.bridge.dumpUi=async options=>{
    const result=await dump(options);const activePackage=result.nodes?.[0]?.packageName;
    if(activePackage&&activePackage!=='com.sybl.voiceroom'){
     report.crossPackageSnapshots=(report.crossPackageSnapshots||0)+1;
     fs.writeFileSync(path.join(out,`cross-package-${report.crossPackageSnapshots}.json`),JSON.stringify(result,null,2));save();
    }
    return result;
   };
   const send=driver.sendPrivateMessage.bind(driver);
   driver.sendPrivateMessage=async(nickname,text,options)=>{
    report.actualCopy=text;report.actualRequestedTarget=options.expectedUid;save();
    if(options.expectedUid!==target)throw Error('ACCEPTANCE_TARGET_MISMATCH');
    return send(nickname,text,{...options,onBeforeSend:async()=>{
     if(fs.existsSync(guard))throw Error('ACCEPTANCE_DISPATCH_ALREADY_ATTEMPTED: no retry');
     await options.onBeforeSend();
     const fd=fs.openSync(guard,'wx');
     try{fs.writeFileSync(fd,JSON.stringify({runId,senderUid:sender,targetUid:target,text,at:new Date().toISOString(),state:'dispatch_intent'},null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
     report.dispatches++;report.dispatchIntentAt=Date.now();
     fs.writeFileSync(path.join(out,'private-before-send.json'),JSON.stringify(await driver.bridge.dumpUi(),null,2));
     const screenshot=await promisify(execFile)(info.adbPath,['-s',info.serial,'exec-out','screencap','-p'],{encoding:null,windowsHide:true,maxBuffer:10*1024*1024});fs.writeFileSync(path.join(out,'private-before-send.png'),screenshot.stdout);
     save();
    }});
   };
   return driver;
  }});
  require.cache[require.resolve('../electron/services/task-runner')].exports=runner;
  const hosted=await require('../electron/services/static-server').startStaticServer({port:0});server=hosted.server;
  window=new BrowserWindow({width:1360,height:860,show:false,title:'双鱼助手 · 客户验收',webPreferences:{preload:path.join(root,'electron/preload.js'),contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
  const ctx={getMainWindow:()=>window};for(const part of ['data','task','system','window'])require(`../electron/ipc/${part}-ipc`)[`register${part[0].toUpperCase()+part.slice(1)}Ipc`](ctx);
  runner.setLogCallback(entry=>{report.logs.push(entry);window.webContents.send('task:log',entry);console.log(`[${entry.task}] ${entry.msg}`);save();});runner.setStatusCallback(status=>window.webContents.send('task:status',status));
  window.webContents.on('console-message',(_e,level,msg)=>{if(level>=3)report.errors.push(`renderer: ${msg}`);});
  const js=code=>window.webContents.executeJavaScript(code);
  const capture=async name=>fs.writeFileSync(path.join(out,`${name}.png`),(await window.webContents.capturePage()).toPNG());
  await window.loadURL(`http://127.0.0.1:${hosted.port}/index.html`);await js('window.__appReady');
  const connected=await js('window.api.system.connectEmulator()');report.environment=connected;
  if(!connected.ok||!connected.bridgeReady)throw Error(`Device unavailable: ${JSON.stringify(connected)}`);
  report.cases.push({id:'R01',module:'采集',path:'实时贵宾位 → 设置多房间2/成员2页/资料卡2 → 开始实时采集',input:{maxRooms:2,maxPages:2,maxProfiles:2},expected:'启动实际采集，入库后显示记录，停止释放设备'});save();
  await js("document.getElementById('guestCollectBtn').click()");
  const requiredRounds=process.env.SYBL_ACCEPTANCE_COLLECT_ONLY==='1'?2:1;
  await until(()=>runner.getStatus(),s=>s.collect.stats.rounds>=requiredRounds||s.collect.state==='failed',90000,'Real collection rounds');
  const collection=runner.getStatus().collect;if(collection.state==='failed')throw Error(`Collection failed: ${collection.error}`);
  await capture('collection-running');
  await js("document.getElementById('guestCollectBtn').click()");await until(()=>runner.getStatus(),s=>!s.collect.running&&!s.deviceOwner,20000,'Collection stop');
  await sleep(300);await capture('collection-stopped');
  const records=store.getRecords(null,null,1,500);report.collection={...collection,records:records.records,total:records.total,statusAfterStop:runner.getStatus().collect};
  const persisted=JSON.parse(fs.readFileSync(path.join(out,'user-data','records-v2.json'),'utf8'));
  const duplicateKeys=persisted.records.map(r=>`${r.source}:${r.uidReal}:${r.uid}:${new Date(r.ts).toDateString()}`);
  Object.assign(report.cases.at(-1),{actual:{rounds:collection.stats.rounds,total:records.total,persisted:persisted.records.length,duplicates:duplicateKeys.length-new Set(duplicateKeys).size,verified:records.records.filter(r=>r.uidReal).length},passed:records.total>0&&persisted.records.length===records.total&&new Set(duplicateKeys).size===duplicateKeys.length});save();
  const restarted=store.createDataStore({dataDir:path.join(out,'user-data')});restarted.init();
  report.cases.push({id:'R02',module:'采集',path:'停止采集 → 重新加载隔离存储',input:'实际采集历史',expected:'记录数量和字段保持不变',actual:{before:records.total,after:restarted.getRecords().total},passed:records.total===restarted.getRecords().total});restarted.shutdown();save();
  if(process.env.SYBL_ACCEPTANCE_COLLECT_ONLY==='1'){report.ok=report.cases.every(c=>c.passed===true)&&collection.stats.roomsVisited>=2;report.verdict=report.ok?'passed_collection_only':'failed_collection';if(!report.ok)process.exitCode=2;return;}
  if(fs.existsSync(guard)){report.ok=false;report.verdict='dispatch_already_attempted';process.exitCode=2;report.cases.push({id:'R03',module:'私信',path:'真实发送保护检查',passed:null,actual:'已存在本次验收发送意图，禁止再次真实发送',guard});return;}
  const beforePending=await js('window.api.task.getPending()');if(beforePending.results?.length)throw Error('Pending results exist in isolated run');
  await js("document.querySelector('.nav-item[data-view=copywriting]').click()");
  const copy=await js("(async()=>{const cfg=await window.api.config.get('copywriting');if(!cfg.contents?.length)throw Error('No saved copy');cfg.mode='select';cfg.selectedIndex=0;const saved=await window.api.config.set('copywriting',cfg);if(!saved.ok)throw Error(saved.reason);await Copywriting.init();return Copywriting.flush();})()");
  await capture('copywriting-selected');
  await js(`(async()=>{const cfg=await window.api.config.get('rules');cfg.source='local';cfg.localIdList=${JSON.stringify(target)};cfg.sendLimit=1;await window.api.config.set('rules',cfg);await RulesView.init();})()`);
  await js("document.querySelector('.nav-item[data-view=task]').click();window.acceptanceConfirmations=[];Dialog.confirm=async(text)=>{window.acceptanceConfirmations.push(text);return true;};document.getElementById('taskPrivateStart').click()");
  await until(()=>runner.getStatus(),s=>s.private.running||s.private.state==='failed'||!!report.actualCopy,10000,'Private task initialization');
  await until(()=>runner.getStatus(),s=>!s.private.running&&!s.deviceOwner,120000,'Private task completion');
  const status=runner.getStatus().private;const pending=await js('window.api.task.getPending()');
  report.confirmations=await js('window.acceptanceConfirmations');
  report.private={status,pending:pending.results,outcomeJournal:fs.existsSync(path.join(out,'user-data','outcomes-v3.jsonl'))?fs.readFileSync(path.join(out,'user-data','outcomes-v3.jsonl'),'utf8'):null};
  report.cases.push({id:'R03',module:'私信',path:'文案编辑 → 选择已保存第1条 → 保存 → 本地UID名单 → 控制台 → 开始自动私聊',input:{targetUid:target,senderUid:sender,text:copy.contents[0],sendLimit:1},expected:'核对对方真实UID，完整输入已选文案，最多一次发送，保存界面证据',actual:{requestedUid:report.actualRequestedTarget,copy:report.actualCopy,dispatches:report.dispatches,state:status.state,stats:status.stats,pending:pending.results},passed:status.stats.ok===1&&report.dispatches===1&&report.actualCopy===copy.contents[0]});
  await capture('private-completed');
  const {BridgeClient}=await import('../src/bridge-client.mjs');const {AdbClient}=await import('../src/adb-client.mjs');const bridge=new BridgeClient(new AdbClient({adbPath:connected.adbPath,serial:connected.serial}));
  fs.writeFileSync(path.join(out,'private-after-send.json'),JSON.stringify(await bridge.dumpUi(),null,2));
  const shot=await promisify(execFile)(connected.adbPath,['-s',connected.serial,'exec-out','screencap','-p'],{encoding:null,windowsHide:true,maxBuffer:10*1024*1024});fs.writeFileSync(path.join(out,'private-after-send.png'),shot.stdout);
  if(report.dispatches)fs.writeFileSync(path.join(base,`real-send-${target}-result.json`),JSON.stringify(report.private,null,2));
  report.ok=report.cases.every(c=>c.passed===true);
  report.verdict=report.ok?'passed':status.stats.fail&&report.private.outcomeJournal?.includes('ACCOUNT_CONTRIBUTION_LEVEL_REQUIRED')?'blocked_account_permission':'failed';
  if(!report.ok)process.exitCode=2;save();
 }catch(error){report.ok=false;report.errors.push(error.stack||error.message);console.error(error);process.exitCode=1;}
 finally{await runner?.stopAll().catch(error=>report.errors.push(error.message));store?.shutdown();save();server?.closeAllConnections?.();server?.close();window?.destroy();console.log('ACCEPTANCE REPORT',out);app.exit(process.exitCode||0);}
}).catch(error=>{console.error(error);app.exit(1);});
