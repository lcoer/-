const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {classifyRecommendations,normalizeLevel}=require('../src/recommendation-policy.cjs');
const {createDataStore}=require('../electron/services/data-store');
const options={levelField:'wealthLevel',threshold:30};
test('a later incomplete sighting does not erase previously observed attributes of the same verified UID',()=>{
 const records=[{uid:'123',source:'room',uidReal:true,sex:'female',wealthLevel:37,charmLevel:103,ts:1000},
  {uid:'123',source:'room',uidReal:true,sex:'unknown',ts:2000}];
 const result=classifyRecommendations(records,{levelField:'wealthLevel',threshold:54});
 assert.equal(result.users[0].group,'low');assert.equal(result.users[0].sex,'female');
 assert.equal(result.users[0].attributeValues.wealthLevel,37);
 assert.equal(result.users[0].attributeSources.wealthLevel.sourceRecordIndex,0);
 assert.equal(result.users[0].original.wealthLevel,undefined);
 assert.equal(records[1].wealthLevel,undefined);
});
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
test('store retains observed levels; assignment is atomic, idempotent, isolated and survives restart',()=>{
 const dir=fs.mkdtempSync(path.join(__dirname,'syl-recommendation-'));let store;
 try {
  store=createDataStore({dataDir:dir,clock:()=>1000});store.init();
  assert.equal(store.getRecommendations().threshold,54);
  assert.equal(store.getRecommendations().levelField,'wealthLevel');
  store.ingestRealRecords([{uid:'123',nickname:'fixture',wealthLevel:30,charmLevel:'???'},{uid:'456',wealthLevel:0}]);
  store.ingestRealRecords([{uid:'123',wealthLevel:null,charmLevel:undefined}]);
  assert.equal(store.getRecommendations(options).groups.high[0].original.charmLevel,'?');
  const request={...options,uids:['123','456','123'],content:'负责内容 <>& 😀\n第二行',requestId:'retry-1'};
  const result=store.assignRecommendations(request);
  assert.deepEqual(result.assignment.authors.map(author=>author.uid),['123','456']);
  assert.equal(store.assignRecommendations(request).duplicate,true);
  assert.equal(store.getAssignments().assignments.length,1);
  assert.throws(()=>store.assignRecommendations({...request,content:'different'}),/REQUEST_CONFLICT/);
  assert.throws(()=>store.assignRecommendations({...request,uids:['999'],requestId:'missing'}),/USER_NOT_FOUND/);
  for(const content of ['', ' ', '😀'.repeat(2001),{}]) assert.throws(()=>store.assignRecommendations({...request,content}),/INVALID_ASSIGNMENT_CONTENT/);
  assert.throws(()=>store.assignRecommendations({...request,uids:[]}),/INVALID_ASSIGNMENT_UIDS/);
  assert.equal(store.getPendingResults().length,0);
  const external=store.getAssignments();external.assignments[0].content='mutated';
  assert.equal(store.getAssignments().assignments[0].content,request.content);
  store.shutdown();store=createDataStore({dataDir:dir});store.init();
  assert.equal(store.getAssignments().assignments[0].content,request.content);
  assert.equal(store.getRecommendations().threshold,30);
  store.clearDemoRecords(true);
  assert.equal(store.getAssignments().assignments[0].authors[0].uid,'123');
  assert.throws(()=>store.assignRecommendations({...request,requestId:'missing-after-clear'}),/USER_NOT_FOUND/);
 }finally {store?.shutdown();fs.rmSync(dir,{recursive:true,force:true});}
});
test('corrupt recommendation history fails closed rather than silently losing assignments',()=>{
 const dir=fs.mkdtempSync(path.join(__dirname,'syl-recommendation-'));let store;
 try {
  fs.writeFileSync(path.join(dir,'recommendations-v1.json'),'{broken');
  store=createDataStore({dataDir:dir});assert.throws(()=>store.init(),/DATA_CORRUPT/);
 }finally {store?.shutdown();fs.rmSync(dir,{recursive:true,force:true});}
});
test('failed assignment persistence leaves memory unchanged and a validated backup can recover',()=>{
 const dir=fs.mkdtempSync(path.join(__dirname,'syl-recommendation-'));let store;
 try {
  store=createDataStore({dataDir:dir});store.init();store.ingestRealRecords([{uid:'123',wealthLevel:50}]);
  const request={...options,uids:['123'],content:'fixture'};
  store.assignRecommendations(request);
  const file=path.join(dir,'recommendations-v1.json');
  store.assignRecommendations({...request,content:'second'});
  fs.mkdirSync(`${file}.tmp`);
  assert.throws(()=>store.assignRecommendations({...request,content:'cannot save'}));
  assert.equal(store.getAssignments().assignments.length,2);
  fs.rmdirSync(`${file}.tmp`);store.shutdown();
  fs.writeFileSync(file,'{corrupt');store=createDataStore({dataDir:dir});store.init();
  assert.ok(store.getAssignments().assignments.length>=1);
  assert.throws(()=>store.assignRecommendations(null),/INVALID_ASSIGNMENT_REQUEST/);
 }finally {store?.shutdown();fs.rmSync(dir,{recursive:true,force:true});}
});
