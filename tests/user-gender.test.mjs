import test from 'node:test';import assert from 'node:assert/strict';
import {genderFromBadgeNodes,readProfileGender} from '../src/user-gender.mjs';
import fs from 'node:fs';
import {classifyGenderBadge} from '../src/gender-badge.cjs';
const maleBadge=fs.readFileSync(new URL('../src/assets/gender/male-badge.png',import.meta.url));
const node=(shortId,text,x=10,y=10,x2=100,y2=60)=>({shortId,text,x,y,x2,y2,packageName:'com.sybl.voiceroom',enabled:true});
const profile=()=>[node('root','',0,0,1080,1920),node('tv_nickname','Alice'),node('tv_user_code','12345'),node('tv_age','26',356,94,410,133)];

test('anonymous effects-card symbol crop recognizes male without age or identity text',()=>{
 const pixels=fs.readFileSync(new URL('./fixtures/gender/effects-male.png',import.meta.url));
 const result=classifyGenderBadge(pixels);assert.equal(result.sex,'男');assert.ok(result.confidence>=.67);
});
test('explicit gender symbols and descriptions are used only on badge controls',()=>{
 assert.equal(genderFromBadgeNodes([node('tv_age','♀26')]),'female');assert.equal(genderFromBadgeNodes([{...node('iv_gender',''),contentDesc:'♂ 20'}]),'male');
 assert.equal(genderFromBadgeNodes([node('tv_nickname','女神26')]),'unknown');assert.equal(genderFromBadgeNodes([node('iv_gender_female','')]),'female');
 assert.equal(genderFromBadgeNodes([node('iv_gender','男'),node('iv_sex','女')]),'unknown');
});
test('identity mismatch and duplicate age controls never request a screenshot',async()=>{
 let shots=0;const driver={adb:{screenshotBuffer:async()=>{shots++;}}};
 for(const nodes of [profile().map(n=>n.shortId==='tv_user_code'?{...n,text:'99999'}:n),[...profile(),node('tv_age','20')]])assert.equal((await readProfileGender(driver,nodes,{expectedUid:'12345',expectedNickname:'Alice'})).sex,'unknown');
 assert.equal(shots,0);
});
test('a profile change after capture refuses to attach a gender to the old UID',async()=>{
 let dumps=0;const driver={adb:{screenshotBuffer:async()=>Buffer.from('unused')},bridge:{dumpUi:async()=>({nodes:++dumps===1?profile():profile().map(n=>n.shortId==='tv_user_code'?{...n,text:'99999'}:n)})}};
 assert.equal((await readProfileGender(driver,profile(),{expectedUid:'12345',expectedNickname:'Alice'})).sex,'unknown');
 assert.equal(dumps,2);
});

const effectsProfile=()=>profile().filter(n=>n.shortId!=='tv_user_code'&&n.shortId!=='tv_age').concat(
 node('rv_top_bg',''),node('iv_copy',''),node('tv_nice_num','22217'),
 node('tv_user_operate_item','关注'),node('tv_user_operate_item','送礼'),node('tv_user_operate_item','私聊Ta'),node('iv_gender','',0,0,63,52));

test('effects card gender can bind to an explicit nice number without producing a UID',async()=>{
 const nodes=effectsProfile();const driver={adb:{screenshotBuffer:async()=>maleBadge},bridge:{dumpUi:async()=>({nodes})}};
 const result=await readProfileGender(driver,nodes,{expectedNiceNumber:'22217',expectedNickname:'Alice'});
 assert.equal(result.sex,'male');assert.equal(result.uid,undefined);assert.equal(result.evidence.identityValue,'22217');
});

test('nice-number capture rejects wrong nice number and cannot satisfy an expected real UID',async()=>{
 let shots=0;const nodes=effectsProfile();const driver={adb:{screenshotBuffer:async()=>{shots++;return maleBadge;}},bridge:{dumpUi:async()=>({nodes})}};
 for(const options of [{expectedNiceNumber:'99999'},{expectedUid:'22217',expectedNiceNumber:'22217'}]){
  assert.equal((await readProfileGender(driver,nodes,{...options,expectedNickname:'Alice'})).sex,'unknown');
 }
 assert.equal(shots,0);
});

test('nice-number identity changing after screenshot cannot reuse the old card gender',async()=>{
 const nodes=effectsProfile();let dumps=0;
 const driver={adb:{screenshotBuffer:async()=>maleBadge},bridge:{dumpUi:async()=>({nodes:++dumps===1?nodes:nodes.map(n=>n.shortId==='tv_nice_num'?{...n,text:'99999'}:n)})}};
 assert.equal((await readProfileGender(driver,nodes,{expectedNiceNumber:'22217',expectedNickname:'Alice'})).sex,'unknown');
 assert.equal(dumps,2);
});

test('refresh chooses settled badge coordinates before using one of the two captures',async()=>{
 const initial=profile().filter(n=>n.shortId!=='tv_age').concat(node('iv_gender','',200,100,263,152));
 const settled=profile().filter(n=>n.shortId!=='tv_age').concat(node('iv_gender','',0,0,63,52));let shots=0;
 const driver={adb:{screenshotBuffer:async()=>{shots++;return maleBadge;}},bridge:{dumpUi:async()=>({nodes:settled})}};
 assert.equal((await readProfileGender(driver,initial,{expectedUid:'12345',expectedNickname:'Alice'})).sex,'male');assert.equal(shots,1);
});

test('an initially absent effects badge is retried within the same capture budget',async()=>{
 const initial=effectsProfile().filter(n=>n.shortId!=='iv_gender');let dumps=0;
 const settled=initial.concat(node('iv_gender','男'));const driver={bridge:{dumpUi:async()=>({nodes:++dumps===1?initial:settled})}};
 assert.equal((await readProfileGender(driver,initial,{expectedNiceNumber:'22217',expectedNickname:'Alice'})).sex,'male');assert.equal(dumps,2);
});
test('cancellation during capture propagates without classifying stale pixels',async()=>{
 const controller=new AbortController();const driver={adb:{screenshotBuffer:async()=>{controller.abort();return Buffer.from('unused');}}};
 await assert.rejects(readProfileGender(driver,profile(),{expectedUid:'12345',expectedNickname:'Alice',signal:controller.signal}),{name:'AbortError'});
});

test('explicit image controls work without tv_age and a transient capture failure retries once',async()=>{
 const nodes=profile().filter(n=>n.shortId!=='tv_age').concat(node('iv_gender','',0,0,63,52));let shots=0;
 const driver={adb:{screenshotBuffer:async()=>++shots===1?Buffer.from('bad'):maleBadge},bridge:{dumpUi:async()=>({nodes})}};
 const r=await readProfileGender(driver,nodes,{expectedUid:'12345',expectedNickname:'Alice'});assert.equal(r.sex,'male');assert.equal(shots,2);
});

test('age badge aliases are recognized without guessing gender from the number',async()=>{
 const nodes=profile().map(n=>n.shortId==='tv_age'?{...n,shortId:'tv_gender_age',text:'♀26'}:n);
 assert.equal((await readProfileGender({},nodes,{expectedUid:'12345',expectedNickname:'Alice'})).sex,'female');
});
