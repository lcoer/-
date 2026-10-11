const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskRunner } = require('../electron/services/task-runner');
const tick = () => new Promise(r => setImmediate(r));
const cfg = (executionMode = 'android') => ({ executionMode, targets: [{ uid: '12345', nickname: 'fixture', source: 'local', uidReal: true }], contents: ['hello'], mode: 'random', delayMin: 1, delayMax: 1 });
function setup(overrides = {}) {
  const outcomes = [];
  let settings = { executionMode: 'android', senderAccountUid: '77777' };
  const ds = { getConfig: key => key === 'settings' ? settings : undefined, setConfig: (key, value) => { if (key === 'settings') settings = value; }, getMachineCode: () => 'test', getCounts: () => ({today:0,week:0,month:0}), getStatus: () => ({source:'room'}), isSentToday: () => false, isPending: () => false, recordOutcome: r => outcomes.push(r), ingestRealRecords: () => ({added:0,updated:0,total:0}), setSource() {}, ...overrides.store };
  const drv = { ensureReady: async () => {}, setSignal() {}, bridge: { ensureCompatible: async () => true }, sendPrivateMessage: async () => ({outcome:'confirmed_ui',evidence:{inputMatched:true,inputCleared:true,beforeExactCount:0,afterExactCount:1,actualUid:'12345'}}), ...overrides.driver };
  const cm = { ensureClient: async () => ({mode:'android',serial:'test-device',adbPath:'fixture',bridgeReady:true}), getClientState: () => ({mode:'android',serial:'test-device'}), ...overrides.client };
  return { outcomes, runner: createTaskRunner({dataStore:ds,clientManager:cm,createDriver:async()=>drv,createCollector:overrides.createCollector}) };
}

test('acceptance rejects bad blacklist and long copy before connecting', async () => {
  let connects = 0;
  const {runner} = setup({client:{ensureClient:async()=>{connects++;throw Error('unexpected');}}});
  for (const change of [{blacklist:'12345'}, {contents:['x'.repeat(2001)]}]) {
    assert.equal((await runner.start('private',{...cfg(),...change})).ok,false);
  }
  assert.equal(connects,0);
});

test('acceptance freezes original target, copy and blacklist during initialization', async () => {
  let release;
  const sent=[];
  const {runner}=setup({client:{ensureClient:()=>new Promise(r=>release=r)},driver:{sendPrivateMessage:async(nick,text,opts)=>{
    sent.push({nick,text,uid:opts.expectedUid});
    return {outcome:'confirmed_ui',evidence:{inputMatched:true,inputCleared:true,beforeExactCount:0,afterExactCount:1,actualUid:opts.expectedUid}};
  }}});
  const input={...cfg(),blacklist:[]};
  const ready=runner.start('private',input);await tick();
  input.contents[0]='mutated';input.targets[0].uid='99999';input.blacklist.push('12345');
  release({mode:'android',serial:'test-device',adbPath:'fixture'});
  await ready;await runner.waitForIdle();
  assert.deepEqual(sent,[{nick:'fixture',text:'hello',uid:'12345'}]);
});

test('acceptance selected special-character copy, dedup, blacklist and batch limit',async()=>{
  const sent=[];
  const {runner}=setup({driver:{sendPrivateMessage:async(nick,text,opts)=>{
    sent.push({text,uid:opts.expectedUid});
    return {outcome:'confirmed_ui',evidence:{inputMatched:true,inputCleared:true,beforeExactCount:0,afterExactCount:1,actualUid:opts.expectedUid}};
  }}});
  const special='验收 🌊\n"引号" & <标签> \\ 路径';
  await runner.start('private',{...cfg(),delayMin:0,delayMax:0,mode:'select',selectedIndex:1,contents:['unused',special],sendLimit:1,blacklist:['23456'],targets:['12345','12345','23456','34567']});
  await runner.waitForIdle();assert.deepEqual(sent,[{text:special,uid:'12345'}]);
  assert.equal(runner.getStatus().private.stats.ok,1);
});

test('acceptance blacklist and same-day dedup skip targets before driver dispatch',async()=>{
 for(const policy of [{blacklist:['12345']},{alreadySent:true}]){
  const calls=[];
  const {runner}=setup({store:{isSentToday:(_machine,uid)=>!!policy.alreadySent&&uid==='12345'},driver:{sendPrivateMessage:async(_nick,_text,opts)=>{
   calls.push(opts.expectedUid);return {outcome:'confirmed_ui',evidence:{inputMatched:true,inputCleared:true,beforeExactCount:0,afterExactCount:1,actualUid:opts.expectedUid}};
  }}});
  await runner.start('private',{...cfg(),blacklist:policy.blacklist||[],targets:['12345','23456'],delayMin:0,delayMax:0});await runner.waitForIdle();
  assert.deepEqual(calls,['23456']);assert.equal(runner.getStatus().private.stats.skipped,1);
 }
});

test('acceptance random candidate boundaries choose exact current templates',async t=>{
 const values=[0,0,0.5,0,0.999];t.mock.method(Math,'random',()=>values.shift()??0);
 const calls=[];const {runner}=setup({driver:{sendPrivateMessage:async(_nick,text,opts)=>{calls.push(text);return {outcome:'confirmed_ui',evidence:{inputMatched:true,inputCleared:true,beforeExactCount:0,afterExactCount:1,actualUid:opts.expectedUid}};}}});
 await runner.start('private',{...cfg(),contents:['首条😀','中间\n文案','最后<&>'],targets:['12345','23456','34567'],delayMin:0,delayMax:0});await runner.waitForIdle();
 assert.deepEqual(calls,['首条😀','中间\n文案','最后<&>']);
});

test('acceptance account change during batch blocks the next recipient',async()=>{
  let settings={executionMode:'android',senderAccountUid:'77777'},calls=0;
  const {runner}=setup({store:{getConfig:()=>settings,setConfig:(_k,v)=>settings=v},driver:{sendPrivateMessage:async(_n,_t,opts)=>{
    calls++;await opts.onBeforeSend();settings={...settings,senderAccountUid:'88888'};
    return {outcome:'confirmed_ui',evidence:{inputMatched:true,inputCleared:true,beforeExactCount:0,afterExactCount:1,actualUid:opts.expectedUid}};
  }}});
  await runner.start('private',{...cfg(),targets:['12345','23456'],delayMin:0,delayMax:0});await runner.waitForIdle();
  assert.equal(calls,1);assert.equal(runner.getStatus().private.state,'failed');
  assert.match(runner.getStatus().private.error,/SENDER_ACCOUNT_CHANGED/);
});

test('acceptance real-mode batch observes configured send interval',async()=>{
  const times=[];
  const {runner}=setup({driver:{sendPrivateMessage:async(_n,_t,opts)=>{
    times.push(performance.now());
    return {outcome:'confirmed_ui',evidence:{inputMatched:true,inputCleared:true,beforeExactCount:0,afterExactCount:1,actualUid:opts.expectedUid}};
  }}});
  await runner.start('private',{...cfg(),targets:['12345','23456','34567'],delayMin:0.02,delayMax:0.02});await runner.waitForIdle();
  assert.equal(times.length,3);assert.ok(times[1]-times[0]>=18);assert.ok(times[2]-times[1]>=18);
});

test('real private sending requires a configured sender account before device connection', async () => {
  let connects = 0;
  const {runner} = setup({store:{getConfig:()=>({executionMode:'android'})},client:{ensureClient:async()=>{connects++;}}});
  const response = await runner.start('private', cfg());
  assert.equal(response.ok,false);
  assert.match(response.reason,/SENDER_ACCOUNT_REQUIRED/);
  assert.equal(connects,0);
});

test('changing sender settings after frontend confirmation rejects the stale account',async()=>{
  let connects=0;
  const {runner}=setup({client:{ensureClient:async()=>{connects++;}}});
  const result=await runner.start('private',{...cfg(),senderAccountUid:'88888'});
  assert.equal(result.ok,false);assert.match(result.reason,/SENDER_ACCOUNT_CHANGED/);assert.equal(connects,0);
});

test('device identity and sender scope stay pinned through send intent and result', async () => {
  let settings = {executionMode:'android',senderAccountUid:'77777'};
  const machine = () => `${settings.senderAccountUid}:${settings.senderDeviceKey}`;
  const scopes = [];
  const {runner,outcomes} = setup({
    store:{getConfig:()=>settings,setConfig:(_key,value)=>{settings=value;},getMachineCode:machine,isPending:(scope)=>{scopes.push(scope);return false;}},
    driver:{sendPrivateMessage:async(_nickname,_text,opts)=>{
      await opts.onBeforeSend();
      settings = {...settings,senderAccountUid:'88888'};
      return {outcome:'confirmed_ui',evidence:{inputMatched:true,inputCleared:true,beforeExactCount:0,afterExactCount:1,actualUid:'12345'}};
    }}
  });
  await runner.start('private', cfg());await runner.waitForIdle();
  assert.equal(outcomes.length,2);
  assert.match(scopes[0],/test-device/);
  assert.equal(outcomes[0].machineCode,scopes[0]);
  assert.equal(outcomes[1].machineCode,scopes[0]);
  assert.equal(outcomes[1].senderAccountUid,'77777');
});

test('changing the ADB executable does not reset dedup for the same emulator',async()=>{
  let settings={executionMode:'android',senderAccountUid:'77777'},adbPath='first-adb.exe';
  const {runner,outcomes}=setup({
    store:{getConfig:()=>settings,setConfig:(_key,value)=>{settings=value;},getMachineCode:()=>`${settings.senderAccountUid}:${settings.senderDeviceKey}`},
    client:{ensureClient:async()=>({mode:'android',serial:'test-device',adbPath})}
  });
  await runner.start('private',cfg());await runner.waitForIdle();const first=outcomes.at(-1).machineCode;
  adbPath='second-adb.exe';await runner.start('private',cfg());await runner.waitForIdle();
  assert.equal(outcomes.at(-1).machineCode,first);
});
test('invalid content rejected before any device connection', async () => {
  let connects = 0;
  const {runner} = setup({client:{ensureClient:async()=>{connects++;throw Error('unexpected')}}});
  assert.equal((await runner.start('private',{...cfg(),contents:[]})).ok,false);
  assert.equal(connects,0);
});
test('disconnected real task fails instead of simulated success; lease releases', async () => {
  const {runner,outcomes} = setup({client:{ensureClient:async()=>{throw Error('EMULATOR_OFFLINE')}}});
  const result = await runner.start('private',cfg());
  assert.equal(result.ok,false);
  assert.match(result.reason,/EMULATOR_OFFLINE/);
  assert.equal(outcomes.length,0);
  assert.equal(runner.getStatus().deviceOwner,null);
});
test('simultaneous starts are mutually exclusive during initialization', async () => {
  let resolve;
  const {runner} = setup({client:{ensureClient:()=>new Promise(r=>{resolve=r})}});
  const first = runner.start('private',cfg());
  const second = await runner.withDeviceOperation('connect',async()=>({ok:true}));
  assert.equal(second.ok,false); assert.equal(second.reason,'DEVICE_BUSY');
  await tick(); resolve({mode:'android',serial:'test-device',adbPath:'fixture'});
  await first; await runner.stopAll();
});
test('demo only runs when explicit and never writes real outcomes', async () => {
  const {runner,outcomes} = setup();
  assert.equal((await runner.start('private',cfg('demo'))).ok,true);
  await runner.waitForIdle();
  assert.equal(outcomes.length,0);
  assert.equal(runner.getStatus().private.stats.simulated,1);
  assert.equal(runner.getStatus().private.stats.ok,0);
});
test('unconfirmed is persisted and never counted as success', async () => {
  const {runner,outcomes} = setup({driver:{sendPrivateMessage:async()=>({outcome:'unconfirmed',reason:'VERIFY_TIMEOUT'})}});
  await runner.start('private',cfg()); await runner.waitForIdle();
  assert.equal(runner.getStatus().private.stats.unconfirmed,1);
  assert.equal(runner.getStatus().private.stats.ok,0);
  assert.equal(outcomes.at(-1).outcome,'unconfirmed');
});
test('stop awaits in-flight work and retains lease until completion', async () => {
  let finish;
  const {runner} = setup({driver:{sendPrivateMessage:()=>new Promise(r=>{finish=r})}});
  await runner.start('private',cfg()); await tick();
  const stopping = runner.stop('private');
  assert.equal(runner.getStatus().private.state,'stopping');
  assert.equal((await runner.withDeviceOperation('connect',async()=>({ok:true}))).reason,'DEVICE_BUSY');
  finish({outcome:'unconfirmed',reason:'STOP_AFTER_DISPATCH'});
  await stopping;
  assert.equal(runner.getStatus().deviceOwner,null);
});

test('status snapshots have increasing revisions and stop query carries the final revision',async()=>{
 let finish;const snapshots=[];
 const {runner}=setup({driver:{sendPrivateMessage:()=>new Promise(resolve=>{finish=resolve;})}});
 runner.setStatusCallback(s=>snapshots.push(s));
 await runner.start('private',cfg());await tick();const stopping=runner.stop('private');
 finish({outcome:'cancelled'});await stopping;
 assert.ok(snapshots.every(s=>Number.isSafeInteger(s.statusRevision)));
 assert.ok(snapshots.every((s,i)=>i===0||s.statusRevision>snapshots[i-1].statusRevision));
 assert.equal(runner.getStatus().statusRevision,snapshots.at(-1).statusRevision);
 assert.equal(runner.getCollectStatus().statusRevision,snapshots.at(-1).statusRevision);
 assert.equal(snapshots.at(-1).private.state,'stopped');
});

test('restarting collection never reports the previous collector as the initializing run',async()=>{
 let calls=0,release;const {runner}=setup({client:{ensureClient:async()=>{if(++calls===2)await new Promise(r=>release=r);return {mode:'android',serial:'fixture',adbPath:'fixture'};}},createCollector:async()=>({start:async()=>({ok:true}),stop:async()=>{},getStatus:()=>({room:'Previous room',rounds:1,running:false})})});
 await runner.startCollect();await runner.stopCollect();const restart=runner.startCollect();await tick();
 assert.equal(runner.getStatus().collect.state,'starting');assert.equal(runner.getStatus().collect.stats.room,undefined);assert.equal(runner.getCollectStatus().room,undefined);
 release();await restart;await runner.stopCollect();
});
test('pending target blocks resend even when noDuplicate disabled', async () => {
  let sends=0;
  const {runner} = setup({store:{isPending:()=>true},driver:{sendPrivateMessage:async()=>{sends++;return {outcome:'confirmed_ui'}}}});
  await runner.start('private',{...cfg(),noDuplicate:false}); await runner.waitForIdle();
  assert.equal(sends,0); assert.equal(runner.getStatus().private.stats.skipped,1);
});
test('collector and nickname resolution cannot overlap other tasks', async () => {
  let resolve;
  const {runner} = setup({client:{ensureClient:()=>new Promise(r=>{resolve=r})}});
  const collecting = runner.startCollect({intervalMs:5000});
  assert.equal((await runner.resolveNicknames(['12345'])).reason,'DEVICE_BUSY');
  assert.equal((await runner.start('private',cfg())).reason,'DEVICE_BUSY');
  await tick(); resolve({mode:'android',serial:'test-device',adbPath:'fixture'});
  await runner.stopAll(); await collecting;
});
test('collector startup cancellation stops constructed collector before releasing device',async()=>{
  let finishStart, stopped=0;
  const {runner}=setup({createCollector:async()=>({start:()=>new Promise(r=>{finishStart=r}),stop:async()=>{stopped++},getStatus:()=>({running:true})})});
  const starting=runner.startCollect({intervalMs:1000});
  while(!finishStart)await tick();
  const stopping=runner.stopCollect();
  assert.equal(runner.getStatus().deviceOwner.owner,'collect');
  finishStart({ok:true});await starting;await stopping;
  assert.equal(stopped,1);assert.equal(runner.getStatus().deviceOwner,null);
});
test('dispatch intent followed by returned cancellation remains unconfirmed',async()=>{
  const {runner,outcomes}=setup({driver:{sendPrivateMessage:async(n,t,opts)=>{await opts.onBeforeSend();return {outcome:'cancelled'};}}});
  await runner.start('private',cfg());await runner.waitForIdle();
  assert.equal(outcomes.at(-1).outcome,'unconfirmed');assert.equal(runner.getStatus().private.stats.unconfirmed,1);
});
test('status reflects durable pending after restart and manual resolution',()=>{
  const pending=[{targetUid:'12345'}];
  const {runner}=setup({store:{getPendingResults:()=>pending}});
  assert.equal(runner.getStatus().private.stats.pending,1);
  pending.length=0;
  assert.equal(runner.getStatus().private.stats.pending,0);
});
test('invalid collection scope is rejected before connecting',async()=>{
  let connects=0;
  const {runner}=setup({client:{ensureClient:async()=>{connects++;return {mode:'android',serial:'fixture'};}},createCollector:async()=>({start:async()=>({ok:true}),stop:async()=>{},getStatus:()=>({})})});
  try{assert.equal((await runner.startCollect({scope:'unknown'})).ok,false);assert.equal(connects,0);}finally{await runner.stopAll();}
});

test('definitive rejection clears current intent and continues to next target',async()=>{
 const {proveSendRejection}=require('../src/send-proof.cjs');
 const {rejectedRow}=require('./fixtures/send-rejection.cjs');
 const rejection=proveSendRejection([],rejectedRow(),'hello');let calls=0;
 const {runner,outcomes}=setup({driver:{sendPrivateMessage:async(n,t,opts)=>{await opts.onBeforeSend();calls++;return calls===1?{outcome:'failed',reason:rejection.reason,evidence:{inputMatched:true,beforeExactCount:0,afterExactCount:1,actualUid:opts.expectedUid,rejection}}:{outcome:'confirmed_ui',evidence:{inputMatched:true,inputCleared:true,beforeExactCount:0,afterExactCount:1,actualUid:opts.expectedUid}};}}});
 await runner.start('private',{...cfg(),targets:[...cfg().targets,{uid:'54321',nickname:'next',source:'local',uidReal:true}],delayMin:0,delayMax:0});await runner.waitForIdle();
 assert.equal(calls,2);assert.equal(outcomes[1].outcome,'failed');assert.equal(runner.getStatus().private.stats.fail,1);assert.equal(runner.getStatus().private.stats.ok,1);
});

test('proven contribution rejection returns home before waiting for the next target',async()=>{
 const {proveSendRejection}=require('../src/send-proof.cjs');const {rejectedRow}=require('./fixtures/send-rejection.cjs');const rejection=proveSendRejection([],rejectedRow(),'hello');const events=[],states=[];let calls=0;
 const {runner}=setup({driver:{returnPrivateHome:async()=>{events.push('home');},sendPrivateMessage:async(_n,_text,opts)=>{events.push(opts.expectedUid);await opts.onBeforeSend();return ++calls===1?{outcome:'failed',reason:rejection.reason,evidence:{inputMatched:true,beforeExactCount:0,afterExactCount:1,actualUid:opts.expectedUid,rejection}}:{outcome:'confirmed_ui',evidence:{inputMatched:true,inputCleared:true,beforeExactCount:0,afterExactCount:1,actualUid:opts.expectedUid}};}}});
 runner.setStatusCallback(s=>states.push(s.private.stats));await runner.start('private',{...cfg(),targets:['12345','23456'],delayMin:0.02,delayMax:0.02});await runner.waitForIdle();
 assert.deepEqual(events,['12345','home','23456']);assert.ok(states.some(s=>s.phase==='waiting'&&s.nextTargetUid==='23456'&&s.waitMs===20));
});

test('failed rejected-chat recovery stops safely and releases the device',async()=>{
 const {proveSendRejection}=require('../src/send-proof.cjs');const {rejectedRow}=require('./fixtures/send-rejection.cjs');const rejection=proveSendRejection([],rejectedRow(),'hello');let calls=0;
 const {runner}=setup({driver:{returnPrivateHome:async()=>{throw Error('PRIVATE_NAVIGATION_UNRECOGNIZED_PAGE');},sendPrivateMessage:async(_n,_t,opts)=>{calls++;await opts.onBeforeSend();return {outcome:'failed',reason:rejection.reason,evidence:{inputMatched:true,beforeExactCount:0,afterExactCount:1,actualUid:opts.expectedUid,rejection}};}}});
 await runner.start('private',{...cfg(),targets:['12345','23456'],delayMin:0,delayMax:0});await runner.waitForIdle();assert.equal(calls,1);assert.equal(runner.getStatus().private.state,'failed');assert.equal(runner.getStatus().deviceOwner,null);
});

test('unproven failure after intent stays pending and stops before another recipient',async()=>{
 let calls=0;
 const {runner,outcomes}=setup({driver:{sendPrivateMessage:async(n,t,opts)=>{calls++;await opts.onBeforeSend();return {outcome:'failed',reason:'SEND_FAILURE_INDICATOR'};}}});
 await runner.start('private',{...cfg(),targets:[...cfg().targets,{uid:'54321',nickname:'next',source:'local',uidReal:true}],delayMin:0,delayMax:0});await runner.waitForIdle();
 assert.equal(calls,1);assert.equal(outcomes.at(-1).outcome,'unconfirmed');
});

test('more than five proven target rejections do not stop remaining recipients',async()=>{
 const {proveSendRejection}=require('../src/send-proof.cjs');const {rejectedRow}=require('./fixtures/send-rejection.cjs');const rejection=proveSendRejection([],rejectedRow(),'hello');let calls=0;
 const {runner}=setup({driver:{sendPrivateMessage:async(n,t,opts)=>{await opts.onBeforeSend();calls++;return calls<=6?{outcome:'failed',reason:rejection.reason,evidence:{inputMatched:true,beforeExactCount:0,afterExactCount:1,actualUid:opts.expectedUid,rejection}}:{outcome:'confirmed_ui',evidence:{inputMatched:true,inputCleared:true,beforeExactCount:0,afterExactCount:1,actualUid:opts.expectedUid}};}}});
 const targets=Array.from({length:7},(_,i)=>({uid:String(10000+i),nickname:'fixture'+i,source:'local',uidReal:true}));
 await runner.start('private',{...cfg(),targets,delayMin:0,delayMax:0});await runner.waitForIdle();
 assert.equal(calls,7);assert.equal(runner.getStatus().private.stats.fail,6);assert.equal(runner.getStatus().private.stats.ok,1);
});

test('cancellation after dispatch keeps even observed rejection uncertain',async()=>{
 const {proveSendRejection}=require('../src/send-proof.cjs');const {rejectedRow}=require('./fixtures/send-rejection.cjs');const rejection=proveSendRejection([],rejectedRow(),'hello');let stopping;
 const {runner,outcomes}=setup({driver:{sendPrivateMessage:async(n,t,opts)=>{await opts.onBeforeSend();stopping=runner.stop('private');return {outcome:'failed',reason:rejection.reason,evidence:{inputMatched:true,beforeExactCount:0,afterExactCount:1,actualUid:opts.expectedUid,rejection}};}}});
 await runner.start('private',cfg());await runner.waitForIdle();await stopping;
 assert.equal(outcomes.at(-1).outcome,'unconfirmed');
});


test('removed room actions reject without acquiring device or connecting', async () => {
  let connects = 0;
  const {runner} = setup({client:{ensureClient:async()=>{connects++;throw Error('unexpected connection');}}});
  const before = runner.getStatus();
  for (const name of ['welcome', 'call']) {
    assert.deepEqual(await runner.start(name, {}), {ok:false, reason:'UNKNOWN_TASK'});
    assert.equal(runner.getStatus().deviceOwner, null);
    assert.equal(Object.hasOwn(runner.getStatus(), name), false);
  }
  assert.equal(connects, 0);
  assert.equal(runner.getStatus().statusRevision, before.statusRevision);
  assert.equal((await runner.withDeviceOperation('connect', async()=>({ok:true}))).ok, true);
});
