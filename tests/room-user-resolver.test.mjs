import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveVisibleRoomUsers} from '../src/room-user-resolver.mjs';
const n=(shortId,text='',extra={})=>({shortId,text,x:20,y:100,x2:300,y2:180,...extra});
const root=(y=0)=>n('','',{packageName:'com.sybl.voiceroom',x:0,y,x2:1080,y2:1920});
const room=[root(),n('tv_room_name','Test'),n('tv_room_code','ID:9277'),n('tv_wheat_name','A')];
const card=(nickname='A',code='12345678')=>[root(770),n('rv_top_bg','',{x:0,y:770,x2:1080,y2:1250}),n('tv_nickname',nickname,{x:461,y:1363,x2:613,y2:1430}),n('tv_user_code',code,{x:84,y:1280,x2:212,y2:1319}),n('tv_user_operate_item','私聊',{y:1500,y2:1600})];
const users=[{uid:'n123',uidReal:false,nickname:'A'}];
function mock(frames){let i=0;return {taps:[],backs:0,bridge:{dumpUi:async()=>({nodes:frames[Math.min(i++,frames.length-1)]})},adb:{}};}
function driver(frames){const d=mock(frames);d.bridge.tapByCoord=async(...args)=>{d.taps.push(args);return {ok:true};};d.adb.back=async()=>{d.backs++;};return d;}
test('enriches only exact visible seat from verified public card and closes it',async()=>{for(const code of ['12345678','(12345678)','ID:12345678']){const d=driver([room,card('A',code),card('A',code),room]);const seen=[];const r=await resolveVisibleRoomUsers(d,users,{roomCode:'9277',onUser:u=>seen.push(u)});assert.equal(r.resolved.length,1);assert.equal(r.resolved[0].uid,'12345678');assert.equal(r.resolved[0].resolvedFrom,'n123');assert.equal(seen.length,1);assert.equal(d.taps.length,1);assert.equal(d.backs,1);}});

test('a gender badge is attached only after matching the public profile UID and nickname',async()=>{
 const d=driver([room,card(),card(),room]);let checked;
 d.readProfileGender=async(_nodes,options)=>{checked=options;return {sex:'female',evidence:{kind:'gender_badge_symbol',sex:'female',confidence:0.9}};};
 const r=await resolveVisibleRoomUsers(d,users,{roomCode:'9277'});assert.equal(checked.expectedUid,'12345678');assert.equal(checked.expectedNickname,'A');assert.equal(r.resolved[0].sex,'female');assert.equal(r.resolved[0].sexEvidence.kind,'gender_badge_symbol');
});
test('skips duplicate visible nicknames instead of guessing seat',async()=>{const d=driver([[...room,n('tv_wheat_name','A')]]);const r=await resolveVisibleRoomUsers(d,users);assert.equal(r.resolved.length,0);assert.equal(d.taps.length,0);});
test('wrong nickname and ambiguous UID remain unresolved while recognized cards close',async()=>{for(const c of [card('B'),[...card(),n('tv_user_code','87654321',{y:1280,y2:1319})],card('A','靓号12345678')]){const d=driver([room,c,c,room]);const r=await resolveVisibleRoomUsers(d,users,{maxDurationMs:70});assert.equal(r.resolved.length,0);assert.equal(d.backs,1);assert.equal(d.taps.length,1);}});
test('never interprets tv_nice_num as public-card UID',async()=>{const c=[...card('A',''),n('tv_nice_num','12345678',{y:1280,y2:1319})];const d=driver([room,c,c,room]);const r=await resolveVisibleRoomUsers(d,users,{maxDurationMs:50});assert.equal(r.resolved.length,0);});
test('cancelled late card does not publish or back',async()=>{const c=new AbortController(),d=driver([room]);let i=0;d.bridge.dumpUi=async()=>{if(i++===1){c.abort();return {nodes:card()};}return {nodes:room};};await assert.rejects(resolveVisibleRoomUsers(d,users,{signal:c.signal}),{name:'AbortError'});assert.equal(d.backs,0);assert.equal(d.taps.length,1);});
test('unrecognized destination is never dismissed with blind back',async()=>{const d=driver([room,[],[]]);const r=await resolveVisibleRoomUsers(d,users,{maxDurationMs:40});assert.equal(r.resolved.length,0);assert.equal(d.backs,0);});
test('known gender mappings and verified users with gender skip profile navigation',async()=>{const d=driver([room]);const r=await resolveVisibleRoomUsers(d,[...users,{uid:'12345678',uidReal:true,nickname:'A',sex:'male'}],{knownMappings:new Map([['n123',{uid:'12345678',sex:'male'}]])});assert.equal(r.profilesRead,0);assert.equal(d.taps.length,0);});

test('verified UID with unknown gender is checked and a mismatched profile cannot overwrite it',async()=>{
 const d=driver([room,card(),card(),room]);d.readProfileGender=async()=>({sex:'female'});
 const r=await resolveVisibleRoomUsers(d,[{uid:'12345678',uidReal:true,nickname:'A',sex:'unknown'}]);assert.equal(r.resolved[0].sex,'female');
 const wrong=driver([room,card('A','99999999'),card('A','99999999'),room]);const mismatch=await resolveVisibleRoomUsers(wrong,[{uid:'12345678',uidReal:true,nickname:'A',sex:'unknown'}]);assert.equal(mismatch.resolved.length,0);
});

test('a unique public-screen nickname also opens a verified profile for gender enrichment',async()=>{
 const publicRoom=room.filter(n=>n.shortId!=='tv_wheat_name').concat(n('nickname','A'),n('tv_user_code','12345678'));
 const d=driver([publicRoom,card(),card(),publicRoom]);d.readProfileGender=async()=>({sex:'male'});
 const r=await resolveVisibleRoomUsers(d,[{uid:'12345678',uidReal:true,nickname:'A',sex:'unknown'}]);assert.equal(r.resolved[0].sex,'male');assert.equal(d.taps.length,1);
});

test('a recognized full profile with real UID supports gender enrichment and safe return',async()=>{
 const full=card().filter(n=>n.shortId!=='rv_top_bg'&&n.shortId!=='tv_user_operate_item').concat(n('iv_chat','',{y:1600,y2:1700}),n('iv_follow','',{y:1600,y2:1700}),n('ll_copy','',{y:1200,y2:1250}));
 const d=driver([room,full,full,room]);d.readProfileGender=async()=>({sex:'male'});
 const result=await resolveVisibleRoomUsers(d,[{uid:'12345678',uidReal:true,nickname:'A',sex:'unknown'}]);assert.equal(result.resolved[0].sex,'male');assert.equal(d.backs,1);
});

test('unknown-gender cache expires and profile budget rotates across remaining users',async()=>{
 const history=new Map(),scope=[...room,n('tv_wheat_name','B',{y:300,y2:380})];let active=null;const attempts=[];
 const d={bridge:{dumpUi:async()=>({nodes:active?card(active,active==='A'?'12345678':'87654321'):scope}),tapByCoord:async(_x,y)=>{active=y===140?'A':'B';attempts.push(active);return {ok:true};}},adb:{back:async()=>{active=null;}},readProfileGender:async()=>({sex:'unknown'})};
 const pending=[...users,{uid:'nb',uidReal:false,nickname:'B'}];
 await resolveVisibleRoomUsers(d,pending,{roomCode:'9277',maxProfiles:1,attemptHistory:history});
 await resolveVisibleRoomUsers(d,pending,{roomCode:'9277',maxProfiles:1,attemptHistory:history,knownMappings:new Map([['n123',{uid:'12345678',sex:'unknown',retryAfter:0}]])});
 assert.deepEqual(attempts,['A','B']);
});
test('maxProfiles limits attempts and wrong room code prevents clicks',async()=>{const d=driver([room,card(),card(),room]);const r=await resolveVisibleRoomUsers(d,[...users,{uid:'nb',uidReal:false,nickname:'B'}],{maxProfiles:1});assert.equal(r.profilesRead,1);assert.equal(r.reason,'max_profiles');const other=driver([room]);await resolveVisibleRoomUsers(other,users,{roomCode:'9999'});assert.equal(other.taps.length,0);});
test('blank preload fields are waited for before identity is emitted',async()=>{const d=driver([room,card('',''),card(),card(),room]);const r=await resolveVisibleRoomUsers(d,users);assert.equal(r.resolved[0].uid,'12345678');assert.equal(d.taps.length,1);assert.equal(d.backs,1);});
test('card overlay with room behind it is not accepted as room readiness',async()=>{const d=driver([[...room,...card()]]);const r=await resolveVisibleRoomUsers(d,users);assert.equal(r.reason,'not_in_room');assert.equal(d.taps.length,0);});
test('hidden matching nickname or code is never identity proof',async()=>{for(const field of ['tv_nickname','tv_user_code']){const c=card().map(node=>node.shortId===field?{...node,x2:node.x}:node);const d=driver([room,c,c,room]);const r=await resolveVisibleRoomUsers(d,users,{maxDurationMs:40});assert.equal(r.resolved.length,0);assert.equal(d.backs,1);}});
test('foreign first root prevents identity publication and back',async()=>{const c=card().map((node,i)=>i===0?{...node,packageName:'other.app'}:node);const d=driver([room,c,c]);const r=await resolveVisibleRoomUsers(d,users,{maxDurationMs:40});assert.equal(r.resolved.length,0);assert.equal(d.backs,0);});
test('missing expected room code does not permit a profile click',async()=>{const d=driver([room.filter(node=>node.shortId!=='tv_room_code').concat(n('layout_online_user'))]);const r=await resolveVisibleRoomUsers(d,users,{roomCode:'9277'});assert.equal(r.reason,'room_unverified');assert.equal(d.taps.length,0);});
test('card marker with invalid geometry never authorizes back',async()=>{const c=card().map(node=>node.shortId==='rv_top_bg'?{...node,x2:node.x}:node);const d=driver([room,c,c]);const r=await resolveVisibleRoomUsers(d,users,{maxDurationMs:40});assert.equal(r.resolved.length,0);assert.equal(d.backs,0);});

test('operation-row card with nice number only is closed without emitting an unproved UID',async()=>{
 const alternative=[...card().filter(n=>n.shortId!=='tv_user_code'&&n.shortId!=='tv_user_operate_item'),n('tv_nice_num','111105',{y:1280,y2:1319}),n('iv_copy','',{y:1280,y2:1319}),...['关注','送礼','私聊Ta'].map((text,i)=>n('tv_user_operate_item',text,{x:200+i*200,x2:350+i*200,y:1756,y2:1815}))];
 const d=driver([]);d.bridge.dumpUi=async()=>({nodes:d.taps.length&&!d.backs?alternative:room});
 const r=await resolveVisibleRoomUsers(d,users,{maxDurationMs:50});assert.equal(r.resolved.length,0);assert.equal(d.backs,1);
});
