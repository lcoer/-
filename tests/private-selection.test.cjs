const test=require('node:test'),assert=require('node:assert/strict');
const {previewSelectedTargets,assertSelectedTargets}=require('../src/private-level-policy.cjs');
const user=(uid,group)=>({uid,group,nickname:`用户${uid}`,original:{uid,uidReal:true,nickname:`用户${uid}`,source:'room',room:'fixture'}});
const classification=()=>({levelField:'wealthLevel',threshold:54,users:[user('101','low'),user('102','high'),user('103','high'),user('104','unclassified')]});
test('selected targets include only checked real users, allow unknown level and preserve order after deduplication',()=>{
 const result=previewSelectedTargets(classification(),{uids:['104','102','104']});
 assert.deepEqual(result.targets.map(t=>t.uid),['104','102']);assert.deepEqual(result.selectionProof.uids,['104','102']);
 assert.equal(result.targets[0].source,'room');assert.equal(result.targets[0].uidReal,true);
 assert.equal(assertSelectedTargets(classification(),result.targets,result.selectionProof),true);
 for(const uids of [[],['999'],['101','999'],['nhint'],[101]])assert.throws(()=>previewSelectedTargets(classification(),{uids}));
 const unsafe=classification();unsafe.users.push({uid:'999',group:'high',original:{uid:'999',uidReal:false,source:'room'}});
 assert.throws(()=>previewSelectedTargets(unsafe,{uids:['999']}));
});
test('selection proof rejects changed threshold/group, missing users and expanded or replaced send list',()=>{
 const result=previewSelectedTargets(classification(),{uids:['101','102']});
 for(const targets of [[result.targets[0]],[...result.targets,user('103','high').original],[{...result.targets[0],uid:'103'},result.targets[1]]])assert.throws(()=>assertSelectedTargets(classification(),targets,result.selectionProof),/重新确认/);
 const changed=classification();changed.threshold=55;assert.throws(()=>assertSelectedTargets(changed,result.targets,result.selectionProof),/重新确认/);
 const changedGroup=classification();changedGroup.users[0].group='high';assert.throws(()=>assertSelectedTargets(changedGroup,result.targets,result.selectionProof),/重新确认/);
 const missing=classification();missing.users=missing.users.filter(user=>user.uid!=='101');assert.throws(()=>assertSelectedTargets(missing,result.targets,result.selectionProof),/重新确认/);
 assert.throws(()=>assertSelectedTargets(classification(),[{...result.targets[0],uidReal:false},result.targets[1]],result.selectionProof));
});
test('data store selection reads shared settings and cannot elevate public vanity aliases to UID',()=>{
 const {createDataStore}=require('../electron/services/data-store');
 const store=createDataStore({persist:false});store.init();
 try {
  store.ingestRealRecords([{uid:'101',wealthLevel:53},{uid:'102',wealthLevel:54},{uid:'103',wealthLevel:'?'},{uid:'104'},
   {uid:'22217',uidReal:false,nickname:'vanity',publicIdentityType:'nice_number',publicIdentityValue:'22217'}]);
  const selected=store.previewPrivateSelectedTargets({uids:['104','101','103']});
  assert.deepEqual(selected.targets.map(target=>target.uid),['104','101','103']);assert.equal(selected.selectionProof.threshold,54);
  assert.equal(store.assertPrivateSelectedTargets(selected.targets,selected.selectionProof),true);
  assert.throws(()=>store.previewPrivateSelectedTargets({uids:['22217']}),/未核验/);
  store.getRecommendations({levelField:'wealthLevel',threshold:55});
  assert.throws(()=>store.assertPrivateSelectedTargets(selected.targets,selected.selectionProof),/重新确认/);
 }finally{store.shutdown();}
});
