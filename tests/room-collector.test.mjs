import test from 'node:test';
import assert from 'node:assert/strict';
import {extractRoomUsers,RoomCollector} from '../src/room-collector.mjs';
test('parenthesized UID is canonical and observations do not imply online',()=>{
 const users=extractRoomUsers([{shortId:'nickname',text:'A',centerX:100,centerY:100},{shortId:'tv_user_code',text:'(12345)',centerX:150,centerY:100}]);
 assert.equal(users[0].uid,'12345'); assert.equal(users[0].online,null); assert.equal(users[0].guildKnown,false);
});
test('stop waits for current read and never publishes its late result',async()=>{
 let release,entered;const began=new Promise(r=>entered=r);let writes=0;
 const driver={setSignal(){},dumpRoom:async()=>{entered();return new Promise(r=>release=()=>r({nodes:[{shortId:'nickname',text:'A',centerX:100,centerY:100}]}));}};
 const collector=new RoomCollector(driver,{onUsers:()=>writes++});collector._isInRoom=async()=>true;
 const start=collector.start();await began;let stopped=false;const stop=collector.stop().then(()=>stopped=true);
 await Promise.resolve();assert.equal(stopped,false);release();await Promise.all([start,stop]);assert.equal(writes,0);
});
test('equidistant user IDs remain unknown rather than assigned arbitrarily',()=>{
 const users=extractRoomUsers([{shortId:'nickname',text:'A',centerX:100,centerY:100},{shortId:'tv_user_code',text:'12345',centerX:50,centerY:100},{shortId:'tv_user_code',text:'67890',centerX:150,centerY:100}]);
 assert.equal(users[0].uidReal,false);
});
test('adjacent message rows cannot borrow a closer UID from another row',()=>{
 const users=extractRoomUsers([
  {shortId:'nickname',text:'Alice',centerX:100,centerY:100},
  {shortId:'tv_user_code',text:'11111',centerX:400,centerY:100},
  {shortId:'nickname',text:'Bob',centerX:100,centerY:140},
  {shortId:'tv_user_code',text:'22222',centerX:150,centerY:140},
 ]);
 assert.equal(users.find(u=>u.nickname==='Alice').uid,'11111');
 assert.equal(users.find(u=>u.nickname==='Bob').uid,'22222');
});
test('ambiguous same-row nicknames and codes remain unverified',()=>{
 const users=extractRoomUsers([
  {shortId:'nickname',text:'Alice',centerX:100,centerY:100},
  {shortId:'nickname',text:'Bob',centerX:200,centerY:100},
  {shortId:'tv_user_code',text:'11111',centerX:150,centerY:100},
 ]);
 assert.ok(users.every(u=>u.uidReal===false));
});
test('a wheat nickname never inherits a public-screen UID',()=>{
 const users=extractRoomUsers([
  {shortId:'nickname',text:'Alice',centerX:100,centerY:100},
  {shortId:'tv_user_code',text:'11111',centerX:150,centerY:100},
  {shortId:'tv_wheat_name',text:'Alice',centerX:100,centerY:500},
 ]);
 assert.equal(users.length,2);
 assert.equal(users.find(u=>u.seenFrom==='wheat').uidReal,false);
 assert.equal(users.find(u=>u.seenFrom==='publicScreen').uid,'11111');
});
test('an anonymous container cannot prove identity across separate text rows',()=>{
 const users=extractRoomUsers([
  {shortId:'message_row',x:0,y:80,x2:500,y2:180},
  {shortId:'nickname',text:'Alice',x:20,y:90,x2:120,y2:110,centerX:70,centerY:100},
  {shortId:'tv_user_code',text:'11111',x:200,y:150,x2:300,y2:170,centerX:250,centerY:160},
  {shortId:'nickname',text:'Bob',x:20,y:190,x2:120,y2:210,centerX:70,centerY:200},
  {shortId:'tv_user_code',text:'22222',x:200,y:190,x2:300,y2:210,centerX:250,centerY:200},
 ]);
 assert.equal(users.find(u=>u.nickname==='Alice').uidReal,false);
 assert.equal(users.find(u=>u.nickname==='Bob').uid,'22222');
});
test('a root containing only one visible nickname cannot borrow a missing row UID',()=>{
 const users=extractRoomUsers([
  {shortId:'root',x:0,y:0,x2:500,y2:1000},
  {shortId:'nickname',text:'Alice',x:20,y:90,x2:120,y2:110,centerX:70,centerY:100},
  {shortId:'tv_user_code',text:'22222',x:200,y:170,x2:300,y2:190,centerX:250,centerY:180},
 ]);
 assert.equal(users[0].uidReal,false);
});
test('text bounds must overlap vertically even when their centers are close',()=>{
 const users=extractRoomUsers([
  {shortId:'nickname',text:'Alice',x:20,y:98,x2:120,y2:102,centerX:70,centerY:100},
  {shortId:'tv_user_code',text:'22222',x:200,y:106,x2:300,y2:110,centerX:250,centerY:108},
 ]);
 assert.equal(users[0].uidReal,false);
});
test('collector ignores a room activity left in the history stack',async()=>{
 const collector=new RoomCollector({adb:{sh:async()=>({out:'topResumedActivity=ActivityRecord{abc u0 com.sybl.voiceroom/.ui.MainActivity t10}\nHist #1: ActivityRecord{old u0 com.sybl.voiceroom/.ui.RoomPageActivity t10}'})}});
 assert.equal(await collector._isInRoom(),false);
});
