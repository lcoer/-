// Read-only classification of the records-v2 observation dataset.
const own=(object,key)=>Object.hasOwn(object,key);
const LEVEL_FIELDS=['vipLevel','userLevel','level','vip_level','user_level'];
const safeField=field=>typeof field==='string'&&/^[a-zA-Z][a-zA-Z0-9_]*$/.test(field)&&!['constructor','prototype','__proto__'].includes(field);
function timestamp(value){
 const time=typeof value==='number'?value:/^\d+$/.test(String(value||''))?Number(value):Date.parse(value);
 return Number.isFinite(time)&&time>=0&&time<=8.64e15?time:0;
}
function gender(value){
 const text=String(value??'').trim().toLowerCase();
 return ['male','m','男'].includes(text)?'male':['female','f','女'].includes(text)?'female':['other','其他'].includes(text)?'other':'unknown';
}
function level(value){
 return (typeof value==='string'&&value.trim()&&value.length<=128)?value.trim():typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?String(value):'unknown';
}
function classifyUsers(records,{genderField='sex',levelField=null,date=null,source='room'}={}){
 if(!Array.isArray(records))throw Error('INVALID_RECORDS');
 if(!safeField(genderField)||(levelField!==null&&!safeField(levelField)))throw Error('INVALID_FIELD');
 if(date!==null){const parsed=new Date(`${date}T00:00:00Z`);if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==date)throw Error('INVALID_DATE');}
 const formatter=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
 let excludedDemoRecords=0,rejectedRecords=0;
 const selected=[];
 records.forEach((record,index)=>{
  if(!record||typeof record!=='object'||Array.isArray(record)||typeof record.uid!=='string'||!record.uid.trim()){rejectedRecords++;return;}
  if(record.source==='demo'){excludedDemoRecords++;return;}
  if(source&&record.source!==source)return;
  if(date&&formatter.format(new Date(timestamp(record.ts)))!==date)return;
  selected.push({record,index});
 });
 const warnings=[];
 if(levelField===null){
  const detected=LEVEL_FIELDS.filter(field=>selected.some(({record})=>own(record,field)&&level(record[field])!=='unknown'));
  if(detected.length===1)levelField=detected[0];
  else warnings.push(detected.length?'Multiple level fields exist; specify --level-field to select a single level system.':'No collected level field exists; all levels are unknown.');
 }
 else if(!selected.some(({record})=>own(record,levelField)&&level(record[levelField])!=='unknown'))warnings.push(`Selected level field ${levelField} has no usable values; all levels are unknown.`);
 const users=new Map();
 for(const {record,index} of selected){
  const uid=record.uid.trim(),verified=(record.uidReal===true||record.uidReal===undefined)&&/^\d{1,32}$/.test(uid);
  const identity=JSON.stringify(verified?['uid',uid]:['hint',record.source,record.roomCode||record.room||'',uid]);
  const observedAt=timestamp(record.lastSeenAt??record.ts),prior=users.get(identity);
  if(prior){prior.sourceRecordIndexes.push(index);if(observedAt>=prior.observedAt){prior.record=record;prior.sourceRecordIndex=index;prior.observedAt=observedAt;}}
  else users.set(identity,{uid,verified,record,sourceRecordIndex:index,sourceRecordIndexes:[index],observedAt});
 }
 const groups=new Map(),details=[];
 for(const entry of users.values()){
  const sex=gender(own(entry.record,genderField)?entry.record[genderField]:null),tier=levelField&&own(entry.record,levelField)?level(entry.record[levelField]):'unknown';
  const key=JSON.stringify([sex,tier]);
  if(!groups.has(key))groups.set(key,{gender:sex,level:tier,userCount:0,unverifiedCount:0,observationCount:0,userIds:[],detailIndexes:[]});
  const group=groups.get(key);group[entry.verified?'userCount':'unverifiedCount']++;group.observationCount+=entry.sourceRecordIndexes.length;
  if(entry.verified)group.userIds.push(entry.uid);
  group.detailIndexes.push(details.length);
  details.push({uid:entry.uid,uidReal:entry.verified,gender:sex,level:tier,sourceRecordIndex:entry.sourceRecordIndex,sourceRecordIndexes:entry.sourceRecordIndexes,original:entry.record});
 }
 const totals={userCount:details.filter(d=>d.uidReal).length,unverifiedCount:details.filter(d=>!d.uidReal).length,observationCount:selected.length,excludedDemoRecords,rejectedRecords};
 return {schemaVersion:1,fields:{gender:genderField,level:levelField},filter:{date,source,timezone:'Asia/Shanghai'},strategy:'latest_observation_per_verified_uid; hints scoped by source and room',totals,warnings,groups:[...groups.values()].sort((a,b)=>a.gender.localeCompare(b.gender)||a.level.localeCompare(b.level,undefined,{numeric:true})),details};
}
module.exports={classifyUsers};
