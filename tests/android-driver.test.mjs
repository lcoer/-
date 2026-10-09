import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJoinEvents } from '../src/android-driver.mjs';

test('room join detection supports the documented current content and nickname IDs', () => {
  const nodes = [
    { shortId: 'content', text: '进入房间', centerY: 300 },
    { shortId: 'nickname', text: 'fixture', centerY: 300 },
  ];
  assert.ok(extractJoinEvents(nodes).includes('fixture'));
});
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
 driver.openPrivateChat=async uid=>({profile:{uid,nickname:'Renamed'},navigator:{readChat:async()=>({nodes:[{shortId:'input_message',text:input,centerX:10,centerY:10},{shortId:'iv_send',centerX:20,centerY:20},...messages.map(text=>({shortId:'rc_text',text}))]})}});
 Object.assign(driver.adb,{sh:async()=>({out:'original/.IME'}),switchToAdbIme:async()=>{},clearInputField:async()=>{input='';},sendUnicode:async v=>{input=v;},tap:async x=>{if(x===20){assert.equal(intent,true);sent=true;messages.push(input);input='';}}});
 driver.bridge.setText=async(id,value)=>{assert.equal(id,'input_message');input=value;return {ok:true};};
 const r=await driver.sendPrivateMessage('Outdated name',text,{expectedUid:'12345',onBeforeSend:async()=>{intent=true;}});
 assert.equal(r.outcome,'confirmed_ui');assert.equal(sent,true);assert.deepEqual(messages,[text]);assert.equal(r.nickname,'Renamed');assert.equal(r.evidence.actualUid,'12345');
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
test('welcome never clicks a username containing the word welcome',async()=>{
 const {driver,taps}=fakeDriver();
 const nodes=[{shortId:'nickname',text:'欢迎Alice',centerY:30},{shortId:'other',text:'欢迎Alice',clickable:true,centerY:30,centerX:10}];
 assert.equal(await driver._tryWelcome(nodes,'欢迎Alice'),false);assert.equal(taps(),0);
});
test('missing or ambiguous welcome controls do not click',async()=>{
 const {driver,taps}=fakeDriver();const nick={shortId:'nickname',text:'Alice',centerY:30};
 assert.equal(await driver._tryWelcome([nick],'Alice'),false);
 const control={shortId:'cl_welcome',text:'欢迎',clickable:true,centerX:20,centerY:30};
 assert.equal(await driver._tryWelcome([nick,control,{...control,centerX:50}],'Alice'),false);assert.equal(taps(),0);
});
test('uncertain bridge click never falls back to a second coordinate click',async()=>{
 const {driver,taps}=fakeDriver();driver.bridge.tapById=async()=>({ok:false,error:'BRIDGE_TIMEOUT'});
 await assert.rejects(driver.tapId('iv_send',{useBridge:true}),/BRIDGE_TIMEOUT/);assert.equal(taps(),0);
});
test('welcome uses one exact control and preserves cancellation without retry',async()=>{
 const {driver}=fakeDriver();let attempts=0;
 driver.adb.tap=async()=>{attempts++;const error=Error('cancelled');error.name='AbortError';throw error;};
 const nodes=[{shortId:'nickname',text:'Alice',centerY:30},{shortId:'button',text:'欢迎',clickable:true,centerX:20,centerY:30}];
 await assert.rejects(driver._tryWelcome(nodes,'Alice'),{name:'AbortError'});assert.equal(attempts,1);
});
