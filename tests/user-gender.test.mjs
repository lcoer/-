import test from 'node:test';import assert from 'node:assert/strict';
import {genderFromBadgeNodes,readProfileGender} from '../src/user-gender.mjs';
import fs from 'node:fs';
const maleBadge=fs.readFileSync(new URL('../src/assets/gender/male-badge.png',import.meta.url));
const node=(shortId,text,x=10,y=10,x2=100,y2=60)=>({shortId,text,x,y,x2,y2,packageName:'com.sybl.voiceroom',enabled:true});
const profile=()=>[node('root','',0,0,1080,1920),node('tv_nickname','Alice'),node('tv_user_code','12345'),node('tv_age','26',356,94,410,133)];
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
 const driver={adb:{screenshotBuffer:async()=>Buffer.from('unused')},bridge:{dumpUi:async()=>({nodes:profile().map(n=>n.shortId==='tv_user_code'?{...n,text:'99999'}:n)})}};
 assert.equal((await readProfileGender(driver,profile(),{expectedUid:'12345',expectedNickname:'Alice'})).sex,'unknown');
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
