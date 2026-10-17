const test=require('node:test'),assert=require('node:assert/strict');
const {safeHandle}=require('../electron/ipc/safe-handle');
const {createTaskRunner}=require('../electron/services/task-runner');
test('unlicensed business IPC is rejected while window controls and license status remain available',async()=>{
 const callbacks=new Map(),frame={},contents={mainFrame:frame},win={isDestroyed:()=>false,webContents:contents};
 let active=false,calls=0;const register=safeHandle({handle:(name,callback)=>callbacks.set(name,callback)},{getMainWindow:()=>win,authorize:()=>{if(!active)throw Error('请先激活软件');}});
 for(const name of ['task:start','portal:getRecords','config:set','window:close','license:status','collect:stop'])register(name,()=>{calls++;return {ok:true};});
 const event={sender:contents,senderFrame:frame};
 for(const name of ['task:start','portal:getRecords','config:set'])assert.equal((await callbacks.get(name)(event)).ok,false);
 assert.equal(calls,0);
 for(const name of ['window:close','license:status','collect:stop'])assert.equal((await callbacks.get(name)(event)).ok,true);
 active=true;assert.equal((await callbacks.get('portal:getRecords')(event)).ok,true);
 assert.equal((await callbacks.get('license:status')({...event,senderFrame:{}})).reason,'UNTRUSTED_IPC_SENDER');
});
test('task runner authorization blocks direct starts and expiry immediately before message dispatch',async()=>{
 let active=false,dispatches=0,intents=0;
 const dataStore={getConfig:()=>({senderAccountUid:'77777'}),setConfig(){},getMachineCode:()=> 'fixture',getCounts:()=>({}),recordOutcome:()=>intents++,isPending:()=>false,isSentToday:()=>false};
 const runner=createTaskRunner({silent:true,dataStore,clientManager:{getClientState:()=>({mode:'android'}),ensureClient:async()=>({mode:'android',serial:'fixture'})},authorize:()=>{if(!active)throw Error('授权已失效');},createDriver:async()=>({ensureReady:async()=>{},setSignal(){},sendPrivateMessage:async(_name,_text,options)=>{active=false;await options.onBeforeSend();dispatches++;return {};} })});
 const config={executionMode:'android',targets:[{uid:'12345',uidReal:true,source:'local'}],contents:['test'],delayMin:0,delayMax:0};
 assert.equal((await runner.start('private',config)).ok,false);assert.equal(runner.getStatus().deviceOwner,null);
 active=true;assert.equal((await runner.start('private',config)).ok,true);await runner.waitForIdle();assert.equal(dispatches,0);
 // The failed prepare outcome may be recorded; no dispatch intent is emitted.
 assert.ok(intents<=1);assert.equal(runner.getStatus().deviceOwner,null);
});
