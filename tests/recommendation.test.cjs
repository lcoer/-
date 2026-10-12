const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {classifyRecommendations,normalizeLevel}=require('../src/recommendation-policy.cjs');
const {createDataStore}=require('../electron/services/data-store');
const options={levelField:'wealthLevel',threshold:30};
test('recommendations sort hidden and numeric levels, deduplicate real UID and keep source traces',()=>{
 const base={source:'room',uidReal:true,nickname:'fixture'};
 const result=classifyRecommendations([
  {...base,uid:'1',ts:1,wealthLevel:99}, {...base,uid:'1',ts:2,wealthLevel:29},
  {...base,uid:'2',wealthLevel:30}, {...base,uid:'3',wealthLevel:'???'},
  {...base,uid:'4',wealthLevel:null}, {...base,uid:'5',wealthLevel:70},
  {...base,uid:'6',wealthLevel:'unknown'}, {...base,uid:'7',source:'demo',wealthLevel:99},
  {...base,uid:'8',uidReal:false,wealthLevel:99}],options);
 assert.deepEqual(result.counts,{high:3,low:1,unclassified:2,total:6});
 assert.deepEqual(result.groups.high.map(user=>user.uid),['3','5','2']);
 assert.equal(result.groups.low[0].uid,'1');assert.deepEqual(result.groups.low[0].sourceRecordIndexes,[0,1]);
 assert.equal(normalizeLevel('？'),'?' );assert.equal(normalizeLevel('unknown'),null);
 assert.equal(normalizeLevel(-1),null);assert.equal(normalizeLevel(1.5),null);assert.equal(normalizeLevel(' 20 '),20);
 assert.throws(()=>classifyRecommendations([],{}),/INVALID_LEVEL_FIELD/);
 for(const threshold of [-1,NaN,'30',0.5]) assert.throws(()=>classifyRecommendations([],{...options,threshold}),/INVALID_LEVEL_THRESHOLD/);
});
test('verified identity excludes malformed flags and ISO latest observation controls classification at 54',()=>{
 const result=classifyRecommendations([
  {source:'room',uid:'123',ts:'2026-10-11T02:00:00Z',wealthLevel:54},
  {source:'room',uid:'123',ts:'2026-10-11T01:00:00Z',wealthLevel:10},
  {source:'room',uid:'456',wealthLevel:53},
  {source:'room',uid:'789',wealthLevel:'???'},
  {source:'room',uid:'1',uidReal:'false',wealthLevel:99},
  {source:'room',uid:'2',uidReal:1,wealthLevel:99},
  {source:'room',uid:'3',uidReal:null,wealthLevel:99},
  {source:'room',uid:4,uidReal:true,wealthLevel:99}],{levelField:'wealthLevel',threshold:54});
 assert.deepEqual(result.counts,{high:2,low:1,unclassified:0,total:3});
 assert.equal(result.groups.high.find(item=>item.uid==='123').level,54);
});

test('classification settings and observed levels survive restart without assignment APIs',()=>{
 const dir=fs.mkdtempSync(path.join(__dirname,'syl-recommendation-'));let store;
 try {
  store=createDataStore({dataDir:dir});store.init();assert.equal(store.getRecommendations().threshold,54);
  store.ingestRealRecords([{uid:'123',wealthLevel:30,charmLevel:'???'},{uid:'456',wealthLevel:0}]);
  store.ingestRealRecords([{uid:'123',wealthLevel:null}]);
  assert.equal(store.getRecommendations(options).groups.high[0].original.charmLevel,'?');
  assert.equal(store.assignRecommendations,undefined);assert.equal(store.getAssignments,undefined);
  store.shutdown();store=createDataStore({dataDir:dir});store.init();
  assert.equal(store.getRecommendations().threshold,30);assert.equal(store.getRecommendations().counts.total,2);
 }finally{store?.shutdown();fs.rmSync(dir,{recursive:true,force:true});}
});
test('legacy recommendation files keep classification settings while retired fields are ignored',()=>{
 const dir=fs.mkdtempSync(path.join(__dirname,'syl-recommendation-'));let store;
 try {
  fs.writeFileSync(path.join(dir,'recommendations-v1.json'),JSON.stringify({schemaVersion:1,settings:options,assignments:[{content:'legacy'}]}));
  store=createDataStore({dataDir:dir});store.init();assert.equal(store.getRecommendations().threshold,30);
  store.getRecommendations({...options,threshold:54});
  const saved=JSON.parse(fs.readFileSync(path.join(dir,'recommendations-v1.json'),'utf8'));assert.equal(saved.settings.threshold,54);assert.equal(saved.assignments,undefined);
 }finally{store?.shutdown();fs.rmSync(dir,{recursive:true,force:true});}
});
test('corrupt classification settings fail closed; failed persistence preserves memory and backup',()=>{
 const dir=fs.mkdtempSync(path.join(__dirname,'syl-recommendation-'));let store;
 try {
  const file=path.join(dir,'recommendations-v1.json');fs.writeFileSync(file,'{broken');
  store=createDataStore({dataDir:dir});assert.throws(()=>store.init(),/DATA_CORRUPT/);
  fs.unlinkSync(file);store.init();store.getRecommendations(options);store.getRecommendations({...options,threshold:54});
  fs.mkdirSync(file+'.tmp');assert.throws(()=>store.getRecommendations({...options,threshold:55}));assert.equal(store.getRecommendations().threshold,54);fs.rmdirSync(file+'.tmp');store.shutdown();
  fs.writeFileSync(file,'{broken');store=createDataStore({dataDir:dir});store.init();assert.equal(store.getRecommendations().threshold,54);
 }finally{store?.shutdown();fs.rmSync(dir,{recursive:true,force:true});}
});
