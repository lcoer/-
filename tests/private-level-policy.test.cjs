const test=require('node:test'),assert=require('node:assert/strict');
const {classifyRecommendations}=require('../src/recommendation-policy.cjs');
const {previewLevelTargets,assertLevelTargets}=require('../src/private-level-policy.cjs');
const records=[53,54,'?',undefined].map((level,i)=>({uid:String(12340+i),uidReal:true,source:'room',wealthLevel:level,charmLevel:1,nickname:'fixture',ts:1}));
const classification=()=>classifyRecommendations(records,{levelField:'wealthLevel',threshold:54});
test('intersects original targets with high/low, excludes unknown, deduplicates and retains source order',()=>{
 const targets=[{uid:'12340',source:'local'},...['12341','12342','12343','99999','12341'].map(uid=>({uid,source:'room'}))];
 const high=previewLevelTargets(classification(),{targets,groups:['high']});
 assert.deepEqual(high.targets.map(t=>t.uid),['12341','12342']);assert.equal(high.excludedUnknown,2);assert.equal(high.excludedOther,1);
 const low=previewLevelTargets(classification(),{targets,groups:['low']});assert.deepEqual(low.targets.map(t=>t.uid),['12340']);
 const both=previewLevelTargets(classification(),{targets,groups:['high','low']});assert.equal(both.targets.length,3);
 assert.deepEqual(previewLevelTargets(classification(),{targets:[{uid:'12342',uidReal:false}],groups:['high']}).targets,[]);
 assert.throws(()=>previewLevelTargets(classification(),{targets,groups:[]}),/选择/);
 assert.throws(()=>previewLevelTargets(classification(),{targets,groups:['unclassified']}),/选择/);
});
test('main validation rejects settings, relevant membership and target-list changes',()=>{
 const result=previewLevelTargets(classification(),{targets:records.map(r=>({uid:r.uid})),groups:['high']});
 assert.equal(assertLevelTargets(classification(),result.targets,result.levelFilter),true);
 assert.throws(()=>assertLevelTargets(classification(),[...result.targets,{uid:'12340'}],result.levelFilter),/重新确认/);
 assert.throws(()=>assertLevelTargets(classifyRecommendations(records,{levelField:'wealthLevel',threshold:55}),result.targets,result.levelFilter),/重新确认/);
 const changed=records.map(r=>r.uid==='12341'?{...r,wealthLevel:1}:r);
 assert.throws(()=>assertLevelTargets(classifyRecommendations(changed,{levelField:'wealthLevel',threshold:54}),result.targets,result.levelFilter),/重新确认/);
 const unrelated=[...records,{uid:'77777',source:'room',uidReal:true,wealthLevel:90}];
 assert.equal(assertLevelTargets(classifyRecommendations(unrelated,{levelField:'wealthLevel',threshold:54}),result.targets,result.levelFilter),true);
});
