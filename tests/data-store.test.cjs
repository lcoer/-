const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDataStore } = require('../electron/services/data-store');
const today = new Date(2026, 9, 9, 12).getTime();
function store(options = {}) { const s = createDataStore({ clock: () => today, persist: false, ...options }); s.init(); return s; }
test('isolated stores default to room and filter dates including unknown gender', () => {
  const s = store(); const other = store();
  s.ingestRealRecords([{uid:'123',sex:'unknown',ts:today},{uid:'456',sex:'female',ts:today-86400000}]);
  assert.equal(other.getRecords().total,0);
  assert.equal(s.getStatus().streaming,false);
  assert.equal(s.getRecords('2026-10-09').total,1);
  assert.equal(s.getStats().todayTotal,1);
  assert.equal(s.getStats().femaleCount,0);
  const b=s.getSummary('2026-10-09')[0]; assert.equal(b.unknownCount,1); assert.equal(b.preview[0].source,'room');
  assert.equal(b.preview[0].uidReal,true);
  assert.deepEqual(s.getTargetsByHour('2026-10-09','auto','all','all'),['123']);
  assert.equal(s.getRecords(null,null,NaN,0).page,1);
  assert.equal(Number.isFinite(s.getRecords(null,null,1,0.2).pages),true);
});
test('unknown online and guild remain unknown; placeholders do not merge by nickname',()=>{
 const s=store(); s.ingestRealRecords([{uid:'nabc',uidReal:false,nickname:'same'},{uid:'123',nickname:'same'}]);
 assert.equal(s.getRecords().total,2); const r=s.getRecords().records[0]; assert.equal(r.online,null);assert.equal(r.guildKnown,false);
});
test('persistent history and pending outcomes survive restart; legacy and simulation are isolated',()=>{
 const dir=fs.mkdtempSync(path.join(__dirname,'syl-store-'));
 try {
 fs.writeFileSync(path.join(dir,'stats.json'),JSON.stringify({'m:private':{'2026-10-09':7}}));
 fs.writeFileSync(path.join(dir,'sent.json'),JSON.stringify({'2026-10-09':{m:['123']}}));
 let s=store({dataDir:dir,persist:true});s.ingestRealRecords([{uid:'123',room:'r'}]);
 assert.equal(s.getCounts('m','private').today,0); assert.equal(s.getLegacyCounts('m','private').today,7);assert.equal(s.isSentToday('m','123'),false);
 s.recordOutcome({machineCode:'m',targetUid:'123',mode:'android',outcome:'unconfirmed'});
 s.recordOutcome({machineCode:'m',targetUid:'456',mode:'demo',outcome:'simulated'});s.shutdown();
 s=store({dataDir:dir,persist:true}); assert.equal(s.getRecords().total,1);assert.equal(s.isPending('m','123'),true);assert.equal(s.isSentToday('m','456'),false);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'stats.json')))['m:private']['2026-10-09'],7);s.shutdown();
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('configuration save failure propagates without changing memory',()=>{
 const dir=fs.mkdtempSync(path.join(__dirname,'syl-store-'));try {const s=store({dataDir:dir,persist:true});fs.mkdirSync(path.join(dir,'config.json')); assert.throws(()=>s.setConfig('x',1));assert.equal(s.getConfig('x'),undefined);s.shutdown();}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('confirmed Android results count; cancelled retries cannot clear pending ambiguity',()=>{
 const s=store();
 s.recordOutcome({machineCode:'m',targetUid:'123',mode:'android',outcome:'unconfirmed'});
 s.recordOutcome({machineCode:'m',targetUid:'123',mode:'android',outcome:'cancelled'});
 assert.equal(s.isPending('m','123'),true);
 s.recordOutcome({machineCode:'m',targetUid:'456',mode:'android',outcome:'confirmed_ui'});
 assert.equal(s.getCounts('m','private').today,1); assert.equal(s.isSentToday('m','456'),true);
});
test('reinitializing one instance does not retain another clock or demo timer',()=>{
 const s=store();s.setSource('demo'); assert.equal(s.getStatus().streaming,true);s.shutdown();assert.equal(s.getStatus().streaming,false);
 s.init();assert.equal(s.getRecords().total,0);s.shutdown();
});
test('saved historical dates remain selectable beyond the recent three days',()=>{
 const s=store();s.ingestRealRecords([{uid:'123',ts:today-10*86400000}]);assert.ok(s.getDates().dates.includes('2026-09-29'));
});
test('confirmed outcomes are idempotent by run and target and resolve pending',()=>{
 const s=store();const r={runId:'r1',machineCode:'m',targetUid:'123',mode:'android',task:'private'};
 s.recordOutcome({...r,outcome:'unconfirmed'});s.recordOutcome({...r,outcome:'confirmed_ui'});s.recordOutcome({...r,outcome:'confirmed_ui'});
 assert.equal(s.getCounts('m','private').today,1);assert.equal(s.isPending('m','123'),false);
});
test('outcome journal is canonical; auxiliary stats failures cannot cause partial confirmation',()=>{
 const dir=fs.mkdtempSync(path.join(__dirname,'syl-store-'));try{
 const s=store({dataDir:dir,persist:true});fs.mkdirSync(path.join(dir,'stats-v2.json'));fs.mkdirSync(path.join(dir,'sent-v2.json'));
 s.recordOutcome({runId:'r1',machineCode:'m',targetUid:'123',mode:'android',outcome:'confirmed_ui'});
 assert.equal(s.getCounts('m','private').today,1);assert.equal(s.isSentToday('m','123'),true);
 const restarted=store({dataDir:dir,persist:true});assert.equal(restarted.getCounts('m','private').today,1);assert.equal(restarted.isSentToday('m','123'),true);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('corrupt outcome journal recovers pending backup, otherwise fails closed',()=>{
 const dir=fs.mkdtempSync(path.join(__dirname,'syl-store-'));try{
 const s=store({dataDir:dir,persist:true});s.recordOutcome({runId:'r1',machineCode:'m',targetUid:'123',mode:'android',outcome:'unconfirmed'});
 s.recordOutcome({runId:'r1',machineCode:'m',targetUid:'123',mode:'android',outcome:'confirmed_ui'});
 fs.writeFileSync(path.join(dir,'outcomes-v2.json'),'{broken');const recovered=store({dataDir:dir,persist:true});assert.equal(recovered.isPending('m','123'),true);
 assert.equal(recovered.isPending('m','999'),true);assert.equal(recovered.getStatus().recoveryRequired,true);
 fs.writeFileSync(path.join(dir,'outcomes-v2.json.bak'),'{broken');assert.throws(()=>store({dataDir:dir,persist:true}),/DATA_CORRUPT/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('syntactically valid but malformed journal fails closed',()=>{
 const dir=fs.mkdtempSync(path.join(__dirname,'syl-store-'));try{fs.writeFileSync(path.join(dir,'outcomes-v2.json'),JSON.stringify({schemaVersion:2,results:[null]}));assert.throws(()=>store({dataDir:dir,persist:true}),/DATA_CORRUPT/);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('manual resolution is scoped to pending run and is idempotent',()=>{
 const s=store();const r={runId:'r1',machineCode:'m',targetUid:'123',mode:'android',task:'private'};
 assert.throws(()=>s.resolvePending({...r,resolution:'confirmed'}),/PENDING_NOT_FOUND/);
 s.recordOutcome({...r,outcome:'unconfirmed'});
 assert.throws(()=>s.resolvePending({...r,runId:'wrong',resolution:'not_sent'}),/PENDING_NOT_FOUND/);
 s.resolvePending({...r,resolution:'confirmed'});s.resolvePending({...r,resolution:'confirmed'});
 assert.equal(s.isPending('m','123'),false);assert.equal(s.getCounts('m','private').today,1);
 s.recordOutcome({...r,runId:'r2',targetUid:'456',outcome:'unconfirmed'});
 s.resolvePending({...r,runId:'r2',targetUid:'456',resolution:'not_sent'});
 s.resolvePending({...r,runId:'r2',targetUid:'456',resolution:'not_sent'});
 assert.equal(s.isPending('m','456'),false);assert.equal(s.isSentToday('m','456'),false);assert.equal(s.getCounts('m','private').today,1);
});
test('manual resolution persists and a failed write leaves pending unchanged',()=>{
 const dir=fs.mkdtempSync(path.join(__dirname,'syl-store-'));try{
 let s=store({dataDir:dir,persist:true});const r={runId:'r1',machineCode:'m',targetUid:'123',mode:'android'};
 s.recordOutcome({...r,outcome:'unconfirmed'});s.resolvePending({...r,resolution:'not_sent'});
 s=store({dataDir:dir,persist:true});assert.equal(s.isPending('m','123'),false);
 s.recordOutcome({...r,runId:'r2',outcome:'unconfirmed'});
 fs.unlinkSync(path.join(dir,'outcomes-v2.json'));fs.mkdirSync(path.join(dir,'outcomes-v2.json'));
 assert.throws(()=>s.resolvePending({...r,runId:'r2',resolution:'confirmed'}));assert.equal(s.isPending('m','123'),true);assert.equal(s.getCounts('m','private').today,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('proven same-run rejected send clears intent, unknown and cross-run failures do not',()=>{
 const {proveSendRejection}=require('../src/send-proof.cjs');
 const node=(shortId,text,x,y,x2,y2)=>({shortId,text,x,y,x2,y2,packageName:'com.sybl.voiceroom',enabled:true});
 const text='你好呀，很高兴认识你~';const after=[node('rc_message_list','',0,326,1080,1500),{...node('row','',0,326,1080,648),className:'android.widget.LinearLayout'},node('rc_text',text,345,442,858,547),node('rc_right_portrait','',907,442,1022,557),node('rc_errorhint','您当前的贡献等级不够，快去直播看看吧。',0,571,1080,619)];
 const rejection=proveSendRejection([],after,text);assert.ok(rejection);
 const r={runId:'r1',machineCode:'m',targetUid:'123',mode:'android',task:'private'};
 const failed={...r,outcome:'failed',reason:'ACCOUNT_CONTRIBUTION_LEVEL_REQUIRED',evidence:{inputMatched:true,beforeExactCount:0,afterExactCount:1,actualUid:'123',rejection}};
 const s=store();s.recordOutcome({...r,outcome:'unconfirmed'});
 s.recordOutcome({...r,outcome:'failed',reason:'SEND_FAILURE_INDICATOR'});assert.equal(s.isPending('m','123'),true);
 s.recordOutcome({...failed,runId:'other-run'});assert.equal(s.isPending('m','123'),true);
 s.recordOutcome({...failed,evidence:{...failed.evidence,actualUid:'999'}});assert.equal(s.isPending('m','123'),true);
 s.recordOutcome(failed);assert.equal(s.isPending('m','123'),false);assert.equal(s.isSentToday('m','123'),false);assert.equal(s.getCounts('m','private').today,0);
});
test('keyword filters complete record set before pagination',()=>{
 const s=store();s.ingestRealRecords(Array.from({length:60},(_,i)=>({uid:String(1000+i),nickname:i===59?'needle':'other',room:'room',ts:today-i})));
 const result=s.getRecords('2026-10-09','all',1,50,'needle');assert.equal(result.total,1);assert.equal(result.records[0].uid,'1059');
 assert.equal(s.getConfig('settings').executionMode,'android');
});
test('legacy demo source cannot activate generation without explicit demo settings',()=>{
 const dir=fs.mkdtempSync(path.join(__dirname,'syl-store-'));try{
 fs.writeFileSync(path.join(dir,'source.json'),JSON.stringify({source:'demo'}));let s=store({dataDir:dir,persist:true});assert.equal(s.getStatus().source,'room');assert.equal(s.getStatus().streaming,false);s.shutdown();
 fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({settings:{executionMode:'demo'}}));s=store({dataDir:dir,persist:true});assert.equal(s.getStatus().source,'demo');assert.equal(s.getStatus().streaming,true);s.shutdown();
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('empty data has no fictional update time; observed timestamp is displayed',()=>{
 const s=store();assert.equal(s.getStats().updatedAt,'--:--');s.ingestRealRecords([{uid:'123',ts:today-3600000}]);assert.notEqual(s.getStats().updatedAt,'--:--');
});
test('selected historical stats use the requested date',()=>{
 const s=store();s.ingestRealRecords([{uid:'123',sex:'male',ts:today},{uid:'456',sex:'female',ts:today-86400000}]);assert.equal(s.getStats('2026-10-08').femaleCount,1);assert.equal(s.getStats('2026-10-08').maleCount,0);assert.equal(s.getStats('2026-10-08').todayTotal,1);assert.equal(s.getStats('2026-10-01').updatedAt,'--:--');
});
test('non-private pending results do not block private targets',()=>{
 const s=store();s.recordOutcome({machineCode:'m',targetUid:'123',task:'call',mode:'android',outcome:'unconfirmed'});assert.equal(s.isPending('m','123'),false);assert.deepEqual(s.getPendingResults(),[]);
});

test('collection normalizes observation timestamps and separates verified additions',()=>{
 const s=store();const result=s.ingestRealRecords([{uid:'123',lastSeenAt:new Date(today).toISOString()},{uid:'room:9277:nabc',uidReal:false}],{roomCode:'9277'});
 assert.equal(result.addedVerified,1);assert.equal(result.addedUnverified,1);assert.equal(result.unchanged,0);
 assert.equal(s.getRecords().records.find(r=>r.uid==='123').lastSeenAt,today);
 assert.equal(s.getRecords().records[0].roomCode,'9277');
 assert.equal(s.getStats().verifiedCount,1);assert.equal(s.getStats().placeholderCount,1);assert.notEqual(s.getStats().updatedAt,'--:--');
});

test('weak repeat observations preserve established verified fields without merging nicknames',()=>{
 const s=store();s.ingestRealRecords([{uid:'123',nickname:'same',sex:'female',guild:'guild',rongCloudId:'rc1',lastSeenAt:today}]);
 const result=s.ingestRealRecords([{uid:'123',nickname:'same',sex:'unknown',guild:'',rongCloudId:null,lastSeenAt:today},{uid:'room:2:nabc',nickname:'same',uidReal:false}]);
 const record=s.getRecords().records.find(r=>r.uid==='123');assert.equal(record.sex,'female');assert.equal(record.guild,'guild');assert.equal(record.guildKnown,true);assert.equal(record.rongCloudId,'rc1');
 assert.equal(result.addedVerified,0);assert.equal(result.addedUnverified,1);assert.equal(result.unchanged,1);assert.equal(s.getRecords().total,2);
});

test('identical snapshots do not rewrite persistence; later observations and next-day records do',()=>{
 const dir=fs.mkdtempSync(path.join(__dirname,'syl-store-'));try {
 let clock=today;const s=createDataStore({dataDir:dir,clock:()=>clock});s.init();const row={uid:'123',nickname:'A',ts:today,lastSeenAt:today};s.ingestRealRecords([row]);
 const file=path.join(dir,'records-v2.json');fs.unlinkSync(file);fs.mkdirSync(file);
 const repeat=s.ingestRealRecords([row]);assert.equal(repeat.unchanged,1);assert.equal(repeat.updated,0);
 fs.rmdirSync(file);s.ingestRealRecords([{...row,lastSeenAt:today+1000}]);assert.ok(fs.existsSync(file));
 clock+=86400000;const next=s.ingestRealRecords([{uid:'123',nickname:'A'}]);assert.equal(next.addedVerified,1);assert.equal(s.getRecords().total,2);s.shutdown();
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('historical ISO timestamps are normalized in stats and malformed timestamps fall back',()=>{
 const s=store();s.ingestRealRecords([{uid:'123',ts:'invalid',lastSeenAt:'invalid'}],{ts:today});const r=s.getRecords().records[0];assert.equal(r.ts,today);assert.equal(r.lastSeenAt,today);
});

test('failed observation persistence keeps prior records and addition counts retryable',()=>{
 const dir=fs.mkdtempSync(path.join(__dirname,'syl-store-'));try {
 const s=store({dataDir:dir,persist:true});s.ingestRealRecords([{uid:'123',sex:'female'}]);const file=path.join(dir,'records-v2.json');fs.unlinkSync(file);fs.mkdirSync(file);
 assert.throws(()=>s.ingestRealRecords([{uid:'456',sex:'male'}]));assert.equal(s.getRecords().total,1);
 fs.rmdirSync(file);const retry=s.ingestRealRecords([{uid:'456',sex:'male'}]);assert.equal(retry.addedVerified,1);assert.equal(s.getRecords().total,2);s.shutdown();
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('restart normalizes legacy ISO observations without cross-room placeholder merging',()=>{
 const dir=fs.mkdtempSync(path.join(__dirname,'syl-store-'));try {
 fs.writeFileSync(path.join(dir,'records-v2.json'),JSON.stringify({schemaVersion:2,records:[{uid:'123',uidReal:true,source:'room',ts:today,lastSeenAt:new Date(today).toISOString()}]}));
 const s=store({dataDir:dir,persist:true});assert.equal(s.getRecords().records[0].lastSeenAt,today);assert.notEqual(s.getStats().updatedAt,'--:--');
 const result=s.ingestRealRecords([{uid:'room:1:nabc',nickname:'same',uidReal:false},{uid:'room:2:nabc',nickname:'same',uidReal:false},{uid:'room:1:nabc',nickname:'same',uidReal:false}]);
 assert.equal(result.addedUnverified,2);assert.equal(result.unchanged,1);assert.equal(s.getRecords().total,3);s.shutdown();
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('collection coverage deduplicates all historical verified users and rooms',()=>{
 const s=store();s.ingestRealRecords([{uid:'123',room:'one',ts:today-86400000},{uid:'123',room:'two',ts:today},{uid:'456',room:'one',ts:today},{uid:'room:1:nabc',uidReal:false,room:'one'},{uid:'789',room:''}]);
 const coverage=s.getCollectionCoverage();assert.deepEqual(coverage.knownVerifiedUids.sort(),['123','456','789']);assert.deepEqual(coverage.knownRoomNames.sort(),['one','two']);
 coverage.knownVerifiedUids.push('injected');assert.equal(s.getCollectionCoverage().knownVerifiedUids.includes('injected'),false);
 s.setConfig('settings',{executionMode:'demo'});s.setSource('demo');assert.equal(s.getCollectionCoverage().knownVerifiedUids.some(uid=>!['123','456','789'].includes(uid)),false);s.shutdown();
});

const hintUid = (nick,room) => 'n'+require('node:crypto').createHash('sha256').update(`${room}\0${nick}`).digest('hex').slice(0,24);
function cardProof(overrides={}) { return {uid:'12345',uidReal:true,nickname:'Alice',roomCode:'9277',source:'room_observation',seenFrom:'roomProfile',evidence:'matched_room_user_card',resolvedFrom:hintUid('Alice','9277'),...overrides}; }
test('exact room-card evidence resolves only its scoped hint and preserves proven fields',()=>{
 const s=store();s.ingestRealRecords([{uid:hintUid('Alice','9277'),uidReal:false,nickname:'Alice',roomCode:'9277',sex:'female',guild:'hintGuild'}]);
 const result=s.ingestRealRecords([cardProof({guild:'cardGuild'})]);assert.equal(result.resolvedHints,1);assert.equal(result.addedVerified,1);assert.equal(result.addedUnverified,0);assert.equal(result.total,1);
 const r=s.getRecords().records[0];assert.equal(r.uid,'12345');assert.equal(r.sex,'female');assert.equal(r.guild,'cardGuild');assert.equal(r.evidence,'matched_room_user_card');
});
test('resolving an existing verified UID removes the hint without inflating additions',()=>{
 const s=store();s.ingestRealRecords([{uid:'12345',nickname:'Alice',sex:'male',guild:'verified'},{uid:hintUid('Alice','9277'),uidReal:false,nickname:'Alice',roomCode:'9277',sex:'female',guild:'hint'}]);
 const r=s.ingestRealRecords([cardProof()]);assert.equal(r.resolvedHints,1);assert.equal(r.addedVerified,0);assert.equal(r.total,1);assert.equal(s.getRecords().records[0].sex,'male');assert.equal(s.getRecords().records[0].guild,'verified');
 // A subsequent nickname-only sighting remains a hint rather than becoming UID.
 s.ingestRealRecords([{uid:hintUid('Alice','9277'),uidReal:false,nickname:'Alice',roomCode:'9277'}]);assert.equal(s.getRecords().total,2);
});
test('missing proof, wrong room, wrong nickname and legacy placeholder never merge',()=>{
 for(const change of [{evidence:undefined},{roomCode:'other'},{nickname:'Other'},{source:undefined},{seenFrom:'publicScreen'},{resolvedFrom:'nabc'}]) {
 const s=store();s.ingestRealRecords([{uid:change.resolvedFrom==='nabc'?'nabc':hintUid('Alice','9277'),uidReal:false,nickname:'Alice',roomCode:'9277'}]);
 const r=s.ingestRealRecords([cardProof(change)]);assert.equal(r.resolvedHints,0);assert.equal(r.total,2);
 }
});
test('resolved hints retain historical daily observations and roll back on failed persistence',()=>{
 const dir=fs.mkdtempSync(path.join(__dirname,'syl-store-'));try {
 const s=store({dataDir:dir,persist:true});const hint={uid:hintUid('Alice','9277'),uidReal:false,nickname:'Alice',roomCode:'9277'};
 s.ingestRealRecords([{...hint,ts:today-86400000},hint]);const file=path.join(dir,'records-v2.json');fs.unlinkSync(file);fs.mkdirSync(file);
 assert.throws(()=>s.ingestRealRecords([cardProof()]));assert.equal(s.getRecords().records.filter(r=>r.uidReal===false).length,2);
 fs.rmdirSync(file);const r=s.ingestRealRecords([cardProof()]);assert.equal(r.resolvedHints,1);assert.equal(r.total,2);assert.equal(s.getRecords('2026-10-08').records[0].uidReal,false);s.shutdown();
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
