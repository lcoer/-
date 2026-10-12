const {createHash}=require('node:crypto');
function levelGroups(groups){
 if(!Array.isArray(groups)||!groups.length||groups.length>2||groups.some(g=>!['high','low'].includes(g))||new Set(groups).size!==groups.length)throw Error('请至少选择一个有效的等级分组');
 return ['high','low'].filter(g=>groups.includes(g));
}
function previewLevelTargets(classification,{targets,groups}={}){
 groups=levelGroups(groups);
 if(!Array.isArray(targets))throw Error('INVALID_LEVEL_TARGETS');
 const users=new Map(classification.users.map(user=>[user.uid,user]));
 const seen=new Set(),sourceUids=[],selected=[];
 let excludedUnknown=0,excludedOther=0;
 for(const input of targets){
  const target=typeof input==='string'?{uid:input}:input;
  if(!target||typeof target.uid!=='string'||!/^\d{1,32}$/.test(target.uid))throw Error('INVALID_LEVEL_TARGETS');
  if(seen.has(target.uid))continue;seen.add(target.uid);
  if(target.uidReal===false||target.source==='demo'){excludedUnknown++;continue;}
  sourceUids.push(target.uid);
  const user=users.get(target.uid);
  if(!user||user.group==='unclassified'){excludedUnknown++;continue;}
  if(!groups.includes(user.group)){excludedOther++;continue;}
  selected.push(structuredClone(target));
 }
 const {levelField,threshold}=classification;
 const snapshot=createHash('sha256').update(JSON.stringify([levelField,threshold,groups,sourceUids.slice().sort().map(uid=>[uid,users.get(uid)?.group||null])])).digest('hex');
 return {ok:true,targets:selected,excludedUnknown,excludedOther,levelFilter:{groups,levelField,threshold,sourceUids,snapshot}};
}
function assertLevelTargets(classification,targets,filter){
 if(!filter||typeof filter!=='object'||!Array.isArray(filter.sourceUids)||typeof filter.snapshot!=='string'||!/^[a-f0-9]{64}$/.test(filter.snapshot))throw Error('INVALID_LEVEL_FILTER');
 const current=previewLevelTargets(classification,{targets:filter.sourceUids,groups:filter.groups});
 const actual=[...new Set(targets.map(t=>typeof t==='string'?t:t.uid))].sort();
 const allowed=current.targets.map(t=>t.uid).sort();
 if(current.levelFilter.snapshot!==filter.snapshot||current.levelFilter.levelField!==filter.levelField||current.levelFilter.threshold!==filter.threshold||JSON.stringify(actual)!==JSON.stringify(allowed))throw Error('等级设置或目标分组已变化，请重新确认并启动');
 return true;
}
module.exports={levelGroups,previewLevelTargets,assertLevelTargets};
