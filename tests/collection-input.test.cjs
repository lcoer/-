const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createDataStore} = require('../electron/services/data-store');
const now = new Date(2026,9,10,12).getTime();
function store(options={}) {const s=createDataStore({clock:()=>now,persist:false,...options});s.init();return s;}
test('invalid collection shapes and ambiguous identity cannot become sendable users',()=>{
 const s=store();const result=s.ingestRealRecords([null,7,'abc',[],{}, {uid:'abc123'}, {uid:'12-34'}, {uid:{}}, {uid:'123',nickname:{}}, {uid:'456',nickname:'x'.repeat(257)}, {uid:' 789 ',nickname:'<>&"😀'}],null);
 assert.equal(result.rejected,10);assert.equal(result.addedVerified,1);assert.equal(s.getRecords().total,1);assert.equal(s.getRecords().records[0].nickname,'<>&"😀');assert.equal(s.getRecords().records[0].uid,'789');
});

test('collection identity flags and real UID lengths match the sender contract',()=>{
 const s=store();const result=s.ingestRealRecords([{uid:'123',uidReal:'false'},{uid:'1'.repeat(33),uidReal:true},{uid:'456',uidReal:false}]);
 assert.equal(result.rejected,2);assert.equal(s.getRecords().total,1);assert.equal(s.getRecords().records[0].uidReal,false);
});
test('late arrival cannot roll back the latest profile, room or event timestamp',()=>{
 const s=store();s.ingestRealRecords([{uid:'123',nickname:'new',room:'new-room',online:true,ts:now,lastSeenAt:now}]);
 const result=s.ingestRealRecords([{uid:'123',nickname:'old',room:'old-room',online:false,ts:now-1000,lastSeenAt:now-1000}]);
 const r=s.getRecords().records[0];assert.equal(r.nickname,'new');assert.equal(r.room,'new-room');assert.equal(r.online,true);assert.equal(r.ts,now);assert.equal(result.unchanged,1);
});
test('malformed metadata and out-of-range timestamp do not poison stored fields',()=>{
 const s=store();s.ingestRealRecords([{uid:'123',ts:1e20}],{room:{wrong:true},roomCode:[],seenFrom:4});
 const r=s.getRecords().records[0];assert.equal(r.ts,now);assert.equal(r.room,'');assert.equal(r.roomCode,null);assert.equal(r.seenFrom,'unknown');
});
test('concurrent entry callbacks deduplicate and survive restart with special text intact',async()=>{
 const dir=fs.mkdtempSync(path.join(__dirname,'collection-accept-'));let s;
 try {s=store({dataDir:dir,persist:true});const row={uid:'23581742',nickname:'测试<>&"😀',room:'房间\\路径',ts:now};
 const results=await Promise.all(Array.from({length:50},()=>Promise.resolve().then(()=>s.ingestRealRecords([row]))));
 assert.equal(results.reduce((n,r)=>n+r.added,0),1);assert.equal(s.getRecords().total,1);s.shutdown();s=store({dataDir:dir,persist:true});assert.equal(s.getRecords().total,1);assert.equal(s.getRecords().records[0].nickname,row.nickname);
 }finally{s?.shutdown();fs.rmSync(dir,{recursive:true,force:true});}
});
test('unrecoverable collection history reports corruption instead of silently becoming empty',()=>{
 const dir=fs.mkdtempSync(path.join(__dirname,'collection-accept-'));let s;
 try {s=store({dataDir:dir,persist:true});s.ingestRealRecords([{uid:'123'}]);s.shutdown();
 fs.writeFileSync(path.join(dir,'records-v2.json'),'{broken');fs.writeFileSync(path.join(dir,'records-v2.json.bak'),'{broken');
 assert.throws(()=>store({dataDir:dir,persist:true}),/DATA_CORRUPT/);
 }finally{s?.shutdown();fs.rmSync(dir,{recursive:true,force:true});}
});

test('collection backup recovery does not block an intact sender journal',()=>{
 const dir=fs.mkdtempSync(path.join(__dirname,'collection-accept-'));let s;
 try{s=store({dataDir:dir,persist:true});s.ingestRealRecords([{uid:'123'}]);s.ingestRealRecords([{uid:'456'}]);s.shutdown();fs.writeFileSync(path.join(dir,'records-v2.json'),'{broken');
 s=store({dataDir:dir,persist:true});assert.equal(s.getRecords().total,1);assert.equal(s.getStatus().recoveryRequired,false);assert.equal(s.getStatus().collectionRecoveryRequired,true);assert.equal(s.isPending('m','789'),false);
 assert.doesNotThrow(()=>s.recordOutcome({runId:'r',machineCode:'m',targetUid:'789',mode:'android',outcome:'unconfirmed'}));
 }finally{s?.shutdown();fs.rmSync(dir,{recursive:true,force:true});}
});

test('structurally invalid collection primary recovers validated backup and preserves it on save',()=>{
 const dir=fs.mkdtempSync(path.join(__dirname,'collection-accept-'));let s;
 try{fs.writeFileSync(path.join(dir,'records-v2.json'),JSON.stringify({schemaVersion:2,records:[null]}));fs.writeFileSync(path.join(dir,'records-v2.json.bak'),JSON.stringify({schemaVersion:2,records:[{uid:'123',nickname:'good',source:'room',uidReal:true,ts:now}]}));
 s=store({dataDir:dir,persist:true});assert.equal(s.getRecords().records[0].nickname,'good');s.ingestRealRecords([{uid:'456'}]);assert.ok(JSON.parse(fs.readFileSync(path.join(dir,'records-v2.json.bak'))).records.every(Boolean));
 }finally{s?.shutdown();fs.rmSync(dir,{recursive:true,force:true});}
});

test('legacy numeric-string collection timestamps are normalized before date queries',()=>{
 const dir=fs.mkdtempSync(path.join(__dirname,'collection-accept-'));let s;
 try{fs.writeFileSync(path.join(dir,'records-v2.json'),JSON.stringify({schemaVersion:2,records:[{uid:'123',source:'room',uidReal:true,ts:String(now),lastSeenAt:new Date(now).toISOString()}]}));
 s=store({dataDir:dir,persist:true});assert.equal(s.getRecords().records[0].ts,now);assert.equal(s.getRecords('2026-10-10').total,1);
 }finally{s?.shutdown();fs.rmSync(dir,{recursive:true,force:true});}
});
