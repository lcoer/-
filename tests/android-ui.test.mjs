import test from 'node:test';
import assert from 'node:assert/strict';
import { openConversation, typeAndSend } from '../src/android-ui.mjs';
import { rejectedRow } from './fixtures/send-rejection.cjs';
test('conversation matching never selects a partial nickname', async () => {
  let taps = 0;
  const adb = { dumpUi: async () => ({nodes:[{shortId:'item_layout_conversation_list',x:0,y:0,x2:100,y2:100},{shortId:'tv_nickname',text:'Alice other',x:1,y:1,x2:90,y2:90}]}), tap:async()=>taps++,swipe:async()=>{} };
  await assert.rejects(openConversation(adb,'Alice',{maxScroll:0}));
  assert.equal(taps,0);
});
test('empty message does not perform device actions', async () => {
  const r = await typeAndSend({dumpUi:async()=>{throw Error('device touched');}},'   ');
  assert.equal(r.status,'failed');
});
function sendingFake(afterNodes, {abortOnTap=false}={}) {
 let reads=0, sendTap=0; const controller=new AbortController();
 const node=(shortId,text='')=>({shortId,text,centerX:20,centerY:20});
 const adb={signal:controller.signal,setSignal(signal){this.signal=signal;},sh:async()=>({out:'original/.IME'}),switchToAdbIme:async()=>true,clearInputField:async()=>{},sendUnicode:async()=>{},tap:async()=>{if(++sendTap===2&&abortOnTap)controller.abort();},dumpUi:async()=>({nodes:++reads===1?[node('input_message')]:reads===2?[node('input_message')]:reads<=4?[node('input_message','hello'),node('iv_send'),node('rc_text','old')]:afterNodes.map(([id,text])=>node(id,text))})};
 return {adb,controller};
}
test('unrelated message growth never confirms a send',async()=>{
 const {adb}=sendingFake([['input_message',''],['rc_text','old'],['rc_text','unrelated']]);
 const r=await typeAndSend(adb,'hello',{sendTimeout:1,verifyGapMs:0});
 assert.equal(r.outcome,'unconfirmed');
});
test('new exact text and cleared input confirm UI with durable intent first',async()=>{
 const {adb}=sendingFake([['input_message',''],['rc_text','old'],['rc_text','hello']]);let called=false;
 const r=await typeAndSend(adb,'hello',{sendTimeout:10,verifyGapMs:0,onBeforeSend:async()=>{called=true;}});
 assert.equal(called,true);assert.equal(r.outcome,'confirmed_ui');
});
test('cancellation after click remains unconfirmed',async()=>{
 const {adb}=sendingFake([],{abortOnTap:true});
 const r=await typeAndSend(adb,'hello',{sendTimeout:1,verifyGapMs:0});
 assert.equal(r.outcome,'unconfirmed');
});
test('failed durable intent blocks the send and restores original IME',async()=>{
 const {adb}=sendingFake([]);let restored=false,taps=0;
 adb.sh=async cmd=>{if(cmd==='ime set original/.IME')restored=true;return {out:'original/.IME'};};adb.tap=async()=>taps++;
 const r=await typeAndSend(adb,'hello',{verifyGapMs:0,onBeforeSend:async()=>{throw Error('DISK_FULL');}});
 assert.equal(r.outcome,'failed');assert.equal(taps,1);assert.equal(restored,true);
});

test('chat changed while saving intent is rechecked and never clicked send',async()=>{
 const {adb}=sendingFake([]);const dump=adb.dumpUi;let changed=false,taps=0;
 adb.tap=async()=>taps++;adb.dumpUi=async()=>{if(changed)throw Error('CHAT_CONTEXT_CHANGED');return dump();};
 const r=await typeAndSend(adb,'hello',{verifyGapMs:0,onBeforeSend:async()=>{changed=true;}});
 assert.equal(r.outcome,'failed');assert.equal(r.reason,'CHAT_CONTEXT_CHANGED');assert.equal(taps,1);
});

test('new message with bound contribution-level rejection is a definite failure', async () => {
 const {adb}=sendingFake([]); const read=adb.dumpUi; let reads=0;
 adb.dumpUi=async()=>++reads<=4?read():({nodes:[{shortId:'input_message',text:''},...rejectedRow()]});
 // Keep the pre-send history empty so exact sequence growth is attributable.
 const base=adb.dumpUi; adb.dumpUi=async()=>{const r=await base();return {nodes:r.nodes.filter(n=>!(n.shortId==='rc_text'&&n.text==='old'))};};
 const r=await typeAndSend(adb,'hello',{sendTimeout:10,verifyGapMs:0});
 assert.equal(r.outcome,'failed');assert.equal(r.reason,'ACCOUNT_CONTRIBUTION_LEVEL_REQUIRED');assert.ok(r.evidence.rejection);
});

test('unknown failure indicator after dispatch stays unconfirmed', async () => {
 const {adb}=sendingFake([['input_message',''],['rc_errorhint','发生错误']]);
 const r=await typeAndSend(adb,'hello',{sendTimeout:1,verifyGapMs:0});
 assert.equal(r.outcome,'unconfirmed');assert.equal(r.reason,'SEND_FAILURE_INDICATOR');
});

test('bridge input verifies full Chinese content without IME or fixed typing waits', async () => {
 let value='',clicked=false,intent=false;const inputs=[];
 const adb={tap:async()=>{clicked=true;},dumpUi:async()=>({nodes:[{shortId:'input_message',text:clicked?'':value},{shortId:'iv_send',centerX:50,centerY:50},...(clicked?[{shortId:'rc_text',text:'你好呀～中文完整测试'}]:[])]})};
 const r=await typeAndSend(adb,'你好呀～中文完整测试',{sendTimeout:10,setText:async(text)=>{inputs.push(text);value=text;return {ok:true};},onBeforeSend:async()=>{intent=true;}});
 assert.deepEqual(inputs,['','你好呀～中文完整测试']);assert.equal(intent,true);assert.equal(r.outcome,'confirmed_ui');
});

test('bridge input rejection never falls back or clicks send', async () => {
 let taps=0;const adb={tap:async()=>taps++,dumpUi:async()=>({nodes:[{shortId:'input_message',text:''},{shortId:'iv_send'}]})};
 const r=await typeAndSend(adb,'hello',{setText:async()=>({ok:false,error:'SET_TEXT_FAILED'})});
 assert.equal(r.outcome,'failed');assert.equal(r.reason,'SET_TEXT_FAILED');assert.equal(taps,0);
});

test('bridge claimed typing success must still match the full visible body', async () => {
 let calls=0,taps=0;const adb={tap:async()=>taps++,dumpUi:async()=>({nodes:[{shortId:'input_message',text:''},{shortId:'iv_send'}]})};
 const r=await typeAndSend(adb,'hello',{setText:async()=>{calls++;return {ok:true};}});
 assert.equal(calls,2);assert.equal(r.reason,'INPUT_MISMATCH');assert.equal(taps,0);
});

async function withHistoricalFailure({ newFailure = false, dropHistory = false, delayed = false } = {}) {
 const before = rejectedRow('old');let value='', clicked=false,afterReads=0;
 const moved = before.map(n => ({ ...n, y: n.y + 40, y2: n.y2 + 40 }));
 const fresh = rejectedRow('hello').filter(n => newFailure || n.shortId !== 'rc_errorhint').map(n => ({ ...n, text: n.shortId === 'rc_errorhint' ? '未知发送错误' : n.text, y: n.y + 400, y2: n.y2 + 400 }));
 const adb={tap:async()=>{clicked=true;},dumpUi:async()=>({nodes:[{shortId:'input_message',text:clicked?'':value},{shortId:'iv_send',centerX:50,centerY:50},...(clicked&&(!delayed||++afterReads>1)?[...(dropHistory?[]:moved),...fresh]:before)]})};
 return typeAndSend(adb,'hello',{sendTimeout:delayed?2000:10,setText:async(text)=>{value=text;return {ok:true};}});
}
test('old moved failure does not stop a successful new message',async()=>{
 assert.equal((await withHistoricalFailure()).outcome,'confirmed_ui');
});

test('delayed new bubble is waited for without stopping on an old failure',async()=>{
 assert.equal((await withHistoricalFailure({delayed:true})).outcome,'confirmed_ui');
});
test('old failure plus unknown new failure remains pending',async()=>{
 assert.equal((await withHistoricalFailure({newFailure:true})).outcome,'unconfirmed');
});
test('scrolling loss of old failure row cannot establish history attribution',async()=>{
 assert.equal((await withHistoricalFailure({newFailure:true,dropHistory:true})).outcome,'unconfirmed');
 assert.equal((await withHistoricalFailure({dropHistory:true})).outcome,'unconfirmed');
});
