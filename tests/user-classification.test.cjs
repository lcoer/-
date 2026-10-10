const test=require('node:test');const assert=require('node:assert/strict');
const {classifyUsers}=require('../src/user-classification.cjs');
test('groups latest real users by explicit gender and level, retaining all source references',()=>{
 const rows=[{uid:'1',uidReal:true,source:'room',sex:'male',vipLevel:1,ts:1000},{uid:'1',uidReal:true,source:'room',sex:'female',vipLevel:2,ts:2000},{uid:'2',uidReal:true,source:'room',sex:'female',vipLevel:2,ts:2000},{uid:'3',uidReal:true,source:'room',sex:'other',vipLevel:0,ts:2000}];
 const result=classifyUsers(rows,{levelField:'vipLevel'});assert.equal(result.totals.userCount,3);assert.equal(result.groups.find(g=>g.gender==='female').userCount,2);assert.deepEqual(result.groups.find(g=>g.gender==='female').userIds,['1','2']);
 assert.deepEqual(result.details.find(d=>d.uid==='1').sourceRecordIndexes,[0,1]);assert.equal(result.groups.find(g=>g.gender==='other').level,'0');assert.equal(rows[0].sex,'male');
});
test('missing levels and genders remain unknown; unverified hints are not counted as real users',()=>{
 const result=classifyUsers([{uid:'1',source:'room',sex:'unknown',ts:1},{uid:'nabc',uidReal:false,source:'room',sex:'女',roomCode:'10',ts:1},{uid:'9',source:'demo',sex:'female',ts:1}]);
 assert.equal(result.fields.level,null);assert.equal(result.totals.userCount,1);assert.equal(result.totals.unverifiedCount,1);assert.equal(result.totals.excludedDemoRecords,1);assert.ok(result.groups.every(g=>g.level==='unknown'));
});
test('date filter uses Shanghai calendar and preserves original source row indexes',()=>{
 const result=classifyUsers([{uid:'1',source:'room',sex:'男',ts:Date.parse('2026-10-09T15:00:00Z')},{uid:'2',source:'room',sex:'女',ts:Date.parse('2026-10-09T17:00:00Z')}],{date:'2026-10-10'});
 assert.equal(result.totals.userCount,1);assert.deepEqual(result.details[0].sourceRecordIndexes,[1]);
});
test('auto selection detects existing level field without equating VIP with user levels',()=>{
 assert.equal(classifyUsers([{uid:'1',source:'room',userLevel:5}]).fields.level,'userLevel');
 const result=classifyUsers([{uid:'1',source:'room',vipLevel:1,userLevel:5}]);assert.equal(result.fields.level,null);assert.ok(result.warnings.some(w=>w.includes('level')));
 assert.throws(()=>classifyUsers([],{levelField:'__proto__'}),/INVALID_FIELD/);
});
test('invalid dates are rejected and malformed identity flags do not count as real users',()=>{
 assert.throws(()=>classifyUsers([],{date:'2026-02-30'}),/INVALID_DATE/);
 const result=classifyUsers([{uid:'1',source:'room',uidReal:'false'}],{levelField:'vipLevel'});assert.equal(result.totals.userCount,0);assert.equal(result.totals.unverifiedCount,1);assert.equal(result.warnings.length,1);
});
