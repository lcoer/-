import test from 'node:test';
import assert from 'node:assert/strict';
import {rejectedRow} from './fixtures/send-rejection.cjs';

import {AndroidDriver} from '../src/android-driver.mjs';
function fakeDriver() {
 let taps=0;const nodes=[{shortId:'ll_tab_message',centerX:5,centerY:5},{shortId:'input_message'},{shortId:'item_layout_conversation_list',x:0,y:0,x2:100,y2:100,centerX:30,centerY:30},{shortId:'tv_nickname',text:'Alice',x:1,y:1,x2:90,y2:90}];
 const adb={setBridge(){},setSignal(signal){this.signal=signal;},isAppForeground:async()=> 'com.sybl.voiceroom',launchApp:async()=>true,dumpUi:async()=>({nodes}),tap:async()=>taps++,back:async()=>{},};
 const driver=new AndroidDriver({adb,bridge:{setSignal(){}}});driver.openPeerProfileFromChat=async()=>({uid:'99999',nickname:'Alice'});
 driver.openPrivateChat=async()=>({profile:{uid:'99999',nickname:'Alice'}});
 return {driver,taps:()=>taps};
}
test('missing expected UID fails before any interaction',async()=>{
 const {driver,taps}=fakeDriver();const r=await driver.sendPrivateMessage('Alice','hello');
 assert.equal(r.reason,'EXPECTED_UID_REQUIRED');assert.equal(taps(),0);
});

test('private send locates by UID instead of requiring an existing nickname conversation',async()=>{
 const {driver}=fakeDriver();let searched;
 driver.openPrivateChat=async uid=>{searched=uid;return {profile:{uid:'99999',nickname:'Renamed'}};};
 driver.adb.dumpUi=async()=>{throw Error('OLD_CONVERSATION_SCAN');};driver.adb.launchApp=async()=>{throw Error('FOREGROUND_APP_RELAUNCHED');};
 const r=await driver.sendPrivateMessage(null,'hello',{expectedUid:'12345'});
 assert.equal(searched,'12345');assert.equal(r.reason,'UID_MISMATCH');
});

test('verified new chat sends the selected full copy with durable intent before send',async()=>{
 const {driver}=fakeDriver();const text='你好呀，很高兴认识你~';let input='请输入消息...',messages=[],intent=false,sent=false;
 driver.openPrivateChat=async uid=>({profile:{uid,nickname:'Renamed'},navigator:{clickSend:async()=>driver.bridge.tapById('iv_send'),readChat:async()=>({nodes:[{shortId:'input_message',text:input,centerX:10,centerY:10},{shortId:'iv_send',centerX:20,centerY:20},...(messages.length?rejectedRow(text).filter(n=>n.shortId!=='rc_errorhint'):[])]})}});
 Object.assign(driver.adb,{sh:async()=>({out:'original/.IME'}),switchToAdbIme:async()=>{},clearInputField:async()=>{input='';},sendUnicode:async v=>{input=v;},tap:async x=>{if(x===20){assert.equal(intent,true);sent=true;messages.push(input);input='';}}});
 driver.bridge.setText=async(id,value)=>{assert.equal(id,'input_message');input=value;return {ok:true};};
 driver.bridge.tapById=async id=>{assert.equal(id,'iv_send');assert.equal(intent,true);sent=true;messages.push(input);input='';return {ok:true};};
 driver.adb.tap=async()=>{throw Error('COORDINATE_SEND_FORBIDDEN');};
 const r=await driver.sendPrivateMessage('Outdated name',text,{expectedUid:'12345',onBeforeSend:async()=>{intent=true;}});
 assert.equal(r.outcome,'confirmed_ui');assert.equal(sent,true);assert.deepEqual(messages,[text]);assert.equal(r.nickname,'Renamed');assert.equal(r.evidence.actualUid,'12345');
});

test('uncertain private send control acknowledgement never falls back to coordinate sending',async()=>{
 const {driver}=fakeDriver();let input='',attempts=0;
 driver.openPrivateChat=async uid=>({profile:{uid,nickname:'A'},navigator:{clickSend:async()=>{attempts++;return {ok:false,error:'BRIDGE_TIMEOUT'};},readChat:async()=>({nodes:[{shortId:'input_message',text:input},{shortId:'iv_send',centerX:20,centerY:20}]})}});
 driver.bridge.setText=async(id,value)=>{input=value;return {ok:true};};driver.adb.tap=async()=>{throw Error('FALLBACK_FORBIDDEN');};
 const result=await driver.sendPrivateMessage(null,'hello',{expectedUid:'12345'});assert.equal(result.outcome,'unconfirmed');assert.equal(attempts,1);
});
test('wrong profile UID blocks typing and send intent',async()=>{
 const {driver}=fakeDriver();let intent=false;
 const r=await driver.sendPrivateMessage('Alice','hello',{expectedUid:'12345',onBeforeSend:()=>intent=true});
 assert.equal(r.reason,'UID_MISMATCH');assert.equal(intent,false);assert.equal(r.evidence.actualUid,'99999');
});
test('readiness reports unavailable bridge without modifying accessibility settings',async()=>{
 let enabled=0;const {driver}=fakeDriver();
 Object.assign(driver.adb,{adbExists:()=>true,ping:async()=>true,isAppInstalled:async()=>true});
 Object.assign(driver.bridge,{isInstalled:async()=>true,isServiceEnabled:async()=>false,enableService:async()=>enabled++});
 await assert.rejects(driver.ensureReady(),/BRIDGE_NOT_ENABLED/);assert.equal(enabled,0);
});
test('room detection uses current activity and correct package, never history',async()=>{
 const {driver}=fakeDriver();
 driver.adb.sh=async()=>({out:'topResumedActivity=ActivityRecord{abc u0 com.sybl.voiceroom/.ui.RoomPageActivity t10}'});
 assert.equal(await driver._isRoomPage(),true);
 driver.adb.sh=async()=>({out:'topResumedActivity=ActivityRecord{def u0 com.sybl.voiceroom/.ui.MainActivity t10}\n Hist #1: ActivityRecord{abc u0 com.sybl.voiceroom/.ui.RoomPageActivity t10}'});
 assert.equal(await driver._isRoomPage(),false);
 driver.adb.sh=async()=>({out:'topResumedActivity=ActivityRecord{abc u0 other.app/.RoomPageActivity t10}'});
 assert.equal(await driver._isRoomPage(),false);
});
test('uncertain bridge click never falls back to a second coordinate click',async()=>{
 const {driver,taps}=fakeDriver();driver.bridge.tapById=async()=>({ok:false,error:'BRIDGE_TIMEOUT'});
 await assert.rejects(driver.tapId('iv_send',{useBridge:true}),/BRIDGE_TIMEOUT/);assert.equal(taps(),0);
});
