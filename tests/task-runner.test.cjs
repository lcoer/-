const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskRunner } = require('../electron/services/task-runner');
const tick = () => new Promise(r => setImmediate(r));
const cfg = (executionMode = 'android') => ({ executionMode, targets: [{ uid: '12345', nickname: 'fixture', source: 'local', uidReal: true }], contents: ['hello'], mode: 'random', delayMin: 1, delayMax: 1 });
function setup(overrides = {}) {
  const outcomes = [];
  const ds = { getMachineCode: () => 'test', getCounts: () => ({today:0,week:0,month:0}), getStatus: () => ({source:'room'}), isSentToday: () => false, isPending: () => false, recordOutcome: r => outcomes.push(r), ingestRealRecords: () => ({added:0,updated:0,total:0}), setSource() {}, ...overrides.store };
  const drv = { ensureReady: async () => {}, setSignal() {}, bridge: { ensureCompatible: async () => true }, sendPrivateMessage: async () => ({outcome:'confirmed_ui',evidence:{inputMatched:true,inputCleared:true,beforeExactCount:0,afterExactCount:1,actualUid:'12345'}}), ...overrides.driver };
  const cm = { ensureClient: async () => ({mode:'android',serial:'test-device',adbPath:'fixture',bridgeReady:true}), getClientState: () => ({mode:'android',serial:'test-device'}), ...overrides.client };
  return { outcomes, runner: createTaskRunner({dataStore:ds,clientManager:cm,createDriver:async()=>drv,createCollector:overrides.createCollector}) };
}
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
  const second = await runner.start('call',{delayMin:1,delayMax:1});
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
  assert.equal((await runner.start('call',{})).reason,'DEVICE_BUSY');
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
