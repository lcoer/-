const test=require('node:test'),assert=require('node:assert/strict');
const {createDataStore}=require('../electron/services/data-store');
const {createTaskRunner}=require('../electron/services/task-runner');
function setup(mode='demo',client={}){
 const store=createDataStore({persist:false});store.init();
 store.setConfig('settings',{executionMode:mode,senderAccountUid:'77777'});
 store.ingestRealRecords([53,54,'?',undefined].map((wealthLevel,i)=>({uid:String(91000+i),uidReal:true,nickname:'fixture',wealthLevel})));
 let sends=0,connects=0;
 const runner=createTaskRunner({silent:true,dataStore:store,clientManager:{getClientState:()=>({mode:'android'}),ensureClient:async()=>{connects++;return {mode:'android',serial:'fixture'};},...client},createDriver:async()=>({ensureReady:async()=>{},setSignal(){},sendPrivateMessage:async()=>{sends++;throw Error('Unexpected send');}})});
 const targets=[91000,91001,91002,91003].map(uid=>({uid:String(uid),source:'local',uidReal:true}));
 const config={executionMode:mode,targets,contents:['test'],delayMin:0,delayMax:0};
 return {store,runner,targets,config,sends:()=>sends,connects:()=>connects};
}
test('demo sends only approved high/low groups; disabled filtering retains original unknown targets',async()=>{
 for(const groups of [['high'],['low'],['high','low'],null]){
  const h=setup();const preview=groups?h.store.previewPrivateLevelTargets({targets:h.targets,groups}):null;
  const config=preview?{...h.config,targets:preview.targets,levelFilter:preview.levelFilter}:h.config;
  try{assert.equal((await h.runner.start('private',config)).ok,true);await h.runner.waitForIdle();assert.equal(h.runner.getStatus().private.stats.simulated,groups?.length===2?3:groups?.[0]==='high'?2:groups?.[0]==='low'?1:4);assert.equal(h.sends(),0);}finally{await h.runner.stopAll();h.store.shutdown();}
 }
});
test('level filter retains blacklist and batch limit',async()=>{
 const h=setup(),p=h.store.previewPrivateLevelTargets({targets:h.targets,groups:['high']});
 try{await h.runner.start('private',{...h.config,targets:p.targets,levelFilter:p.levelFilter,blacklist:['91001'],sendLimit:1});await h.runner.waitForIdle();assert.equal(h.runner.getStatus().private.stats.simulated,1);assert.equal(h.runner.getStatus().private.stats.skipped,1);}finally{h.store.shutdown();}
});
test('classification changes before start reject before connection, including injected out-of-group UID',async()=>{
 const h=setup('android'),p=h.store.previewPrivateLevelTargets({targets:h.targets,groups:['high']});
 try{
  let result=await h.runner.start('private',{...h.config,targets:[...p.targets,{uid:'91000',source:'local'}],levelFilter:p.levelFilter});assert.equal(result.ok,false);
  h.store.getRecommendations({levelField:'wealthLevel',threshold:55});
  result=await h.runner.start('private',{...h.config,targets:p.targets,levelFilter:p.levelFilter});assert.equal(result.ok,false);assert.match(result.reason,/重新确认/);assert.equal(h.connects(),0);assert.equal(h.sends(),0);
 }finally{h.store.shutdown();}
});
test('classification changes during device initialization reject before executing sends',async()=>{
 let release;const h=setup('android',{ensureClient:()=>new Promise(r=>release=r)}),p=h.store.previewPrivateLevelTargets({targets:h.targets,groups:['high']});
 try{
  const starting=h.runner.start('private',{...h.config,targets:p.targets,levelFilter:p.levelFilter});
  while(!release)await new Promise(r=>setImmediate(r));
  h.store.getRecommendations({levelField:'charmLevel',threshold:54});release({mode:'android',serial:'fixture'});
  const result=await starting;assert.equal(result.ok,false);assert.match(result.reason,/重新确认/);assert.equal(h.sends(),0);assert.equal(h.runner.getStatus().deviceOwner,null);
 }finally{await h.runner.stopAll();h.store.shutdown();}
});
