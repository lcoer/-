import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomCollector,extractRoomUsers} from '../src/room-collector.mjs';
const nodes = uid => [
  {shortId:'nickname',text:'fixture'+uid,centerX:100,centerY:100},
  {shortId:'tv_nice_num',text:uid,centerX:150,centerY:100},
];
function setup() {
  let current=0;
  const rooms=['12345','23456','34567'].map((uid,i)=>({room:'room'+i,roomCode:String(1000+i),nodes:nodes(uid),onlineCount:10}));
  const navigator={getStatus:()=>({visitedCount:current+1,failed:0}),ensureRoom:async()=>rooms[current],nextRoom:async()=>rooms[++current]||null};
  const driver={setSignal(){},dumpRoom:async()=>({nodes:rooms[current]?.nodes||[]}),bridge:{dumpUi:async()=>({nodes:rooms[current]?.nodes||[]})}};
  const updates=[];
  const collector=new RoomCollector(driver,{scope:'multi',navigator,scanMembers:false,intervalMs:1000,knownVerifiedUids:['12345'],onUsers:(users)=>{updates.push(users);return {addedVerified:users.filter(u=>u.uid!=='12345').length,added:users.length,updated:0};}});
  collector.stopped=false;
  collector._isInRoom=async()=>true;
  return {collector,updates};
}
test('multi-room coverage discovers different verified UIDs instead of repeating one room',async()=>{
  const {collector,updates}=setup();
  for(let i=0;i<3;i++)await collector._collectOnce();
  assert.equal(collector.getStatus().roomsVisited,3);
  assert.equal(collector.getStatus().newVerified,2);
  assert.equal(new Set(updates.flat().map(u=>u.uid)).size,3);
  assert.ok(updates.flat().every(u=>u.roomCode));
});
test('single-room mode does not rotate and skips unchanged observations',async()=>{
  const {collector,updates}=setup();collector.scope='single';
  for(let i=0;i<3;i++)await collector._collectOnce();
  assert.equal(collector.getStatus().roomsVisited,1);
  assert.equal(updates.length,1);
  assert.equal(collector.getStatus().newVerified,0);
});
test('identical nickname observations in different rooms remain separate unverified hints',()=>{
  const input=[{shortId:'tv_wheat_name',text:'same',centerX:100,centerY:100}];
  const first=extractRoomUsers(input,{roomCode:'1001',room:'one'});
  const second=extractRoomUsers(input,{roomCode:'1002',room:'two'});
  assert.notEqual(first[0].uid,second[0].uid);
  assert.equal(first[0].uidReal,false);assert.equal(second[0].uidReal,false);
});
test('matched room-card evidence is published as a UID, not a nickname-derived identity',async()=>{
  const updates=[];
  const meta={room:'room',roomCode:'1001',nodes:[{shortId:'tv_wheat_name',text:'fixture',centerX:100,centerY:100}]};
  const driver={setSignal(){},bridge:{}};
  const navigator={ensureRoom:async()=>meta,getStatus:()=>({})};
  const collector=new RoomCollector(driver,{scope:'single',navigator,scanMembers:false,onUsers:users=>{updates.push(users);return {added:users.length};},
    userResolver:async(_driver,users,options)=>{
      if(options.knownMappings.has(users[0].uid))return {profilesRead:0,resolved:[],reason:'complete'};
      const user=users[0];await options.onUser({...user,uid:'12345',uidReal:true,resolvedFrom:user.uid,evidence:'matched_room_user_card',seenFrom:'roomProfile'});
      return {profilesRead:1,resolved:[],reason:'complete'};
    }});
  collector.stopped=false;await collector._collectOnce();await collector._collectOnce();
  assert.equal(collector.getStatus().newVerified,1);assert.equal(collector.getStatus().profilesRead,1);
  assert.equal(updates.length,2);assert.equal(updates[1][0].uid,'12345');
  assert.equal(updates[1][0].evidence,'matched_room_user_card');
});

test('collection enriches an already verified public UID whose gender is still unknown',async()=>{
 const meta={room:'room',roomCode:'1001',nodes:nodes('12345')};let calls=0;const updates=[];
 const collector=new RoomCollector({setSignal(){},bridge:{}},{scope:'single',navigator:{ensureRoom:async()=>meta,getStatus:()=>({})},scanMembers:false,onUsers:users=>{updates.push(users);return {added:0};},userResolver:async(_driver,users,opts)=>{
  calls++;assert.equal(users[0].uidReal,true);await opts.onUser({...users[0],sex:'male',resolvedFrom:users[0].uid});return {profilesRead:1,reason:'complete'};
 }});
 collector.stopped=false;await collector._collectOnce();assert.equal(calls,1);assert.equal(updates.at(-1)[0].sex,'male');
});
test('pre-cancelled collection does not report running or perform navigation',async()=>{
  const collector=new RoomCollector({setSignal(){}},{scope:'multi'});
  await assert.rejects(collector.start({signal:AbortSignal.abort()}),{name:'AbortError'});
  assert.equal(collector.getStatus().running,false);
});
