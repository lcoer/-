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
test('collector ignores a room activity left in the history stack',async()=>{
 const collector=new RoomCollector({adb:{sh:async()=>({out:'topResumedActivity=ActivityRecord{abc u0 com.sybl.voiceroom/.ui.MainActivity t10}\nHist #1: ActivityRecord{old u0 com.sybl.voiceroom/.ui.RoomPageActivity t10}'})}});
 assert.equal(await collector._isInRoom(),false);
});
