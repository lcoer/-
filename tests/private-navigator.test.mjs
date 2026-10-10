import test from 'node:test';
import assert from 'node:assert/strict';
import { PrivateNavigator } from '../src/private-navigator.mjs';

const pkg = 'com.sybl.voiceroom';
const node = (shortId, text, x, y, x2, y2, extra = {}) => ({shortId,text,x,y,x2,y2,centerX:(x+x2)/2,centerY:(y+y2)/2,packageName:pkg,...extra});
const root = () => node('root','',0,0,1080,1920,{className:'android.widget.FrameLayout'});
const home = () => [root(),node('ll_tab_home','',0,1747,270,1920,{clickable:true}),node('iv_search','',953,88,1034,169,{clickable:true})];
const search = query => [root(),node('et_search',query,138,65,907,163,{className:'android.widget.EditText'}),node('tv_search','搜索',925,42,1080,186,{clickable:true}),node('iv_back','',0,62,127,166,{clickable:true})];
function results(query, users, {hidden=false}={}) {
 return [root(),node('et_search',query,138,65,907,163),node('tv_cancel','取消',925,42,1080,186,{clickable:true}),node('iv_back','',0,62,127,166,{clickable:true}),node('','房间',390,221,482,302,{clickable:true}),node('','用户',597,221,689,302,{clickable:true}),
 ...users.flatMap((uid,i)=>{const x=hidden?1080:0,y=348+i*230;return [node('','',x,y,x+1080,y+207,{clickable:true,className:'android.view.ViewGroup'}),node('tv_name','Current name',x+300,y+43,x+600,y+103),node('tv_nice_num',uid,x+320,y+131,x+500,y+158)];})];
}
const profile = uid => [root(),node('tv_nickname','Current name',205,847,500,924),node('tv_nice_num',uid,104,936,300,963),node('iv_copy','',305,930,363,988,{clickable:true}),node('iv_follow','',58,1696,441,1834,{clickable:true}),node('iv_chat','',476,1696,1023,1834,{clickable:true}),node('iv_back','',0,48,167,180,{clickable:true})];
const chat = () => [root(),node('tv_nickname','Current name',127,58,400,118),node('tv_check','查看主页',816,194,956,245,{clickable:true}),node('input_message','请输入消息...',58,1652,707,1782),node('iv_send','',913,1681,1045,1753,{clickable:true}),node('iv_back','',0,62,127,166,{clickable:true})];
function fixture({users=['888188'],profileUid='888188',peerUid=profileUid,badInput=false,empty=false,normalProfile=false}={}) {
 let nodes=home(),query='',cameFromChat=false;const actions=[];
 const driver={bridge:{dumpUi:async()=>({nodes}),setText:async(id,text)=>{actions.push('set:'+text);query=badInput?'wrong':text;nodes=search(query);return {ok:true};}},adb:{screenSize:async()=>({w:1920,h:1080}),tap:async(x,y)=>{
 const hit=nodes.find(n=>n.centerX===x&&n.centerY===y);actions.push(hit?.shortId||hit?.text);
 if(hit?.shortId==='iv_search')nodes=search('搜索');
 else if(hit?.shortId==='tv_search')nodes=results(query,users,{hidden:true});
 else if(hit?.text==='用户')nodes=empty?results(query,[]).concat(node('tv_empty','暂无数据',100,600,900,700)):results(query,users);
 else if(hit?.shortId==='tv_name')nodes=profile(profileUid).map(n=>normalProfile&&n.shortId==='iv_copy'?{...n,shortId:'ll_copy'}:normalProfile&&n.shortId==='tv_nice_num'?{...n,shortId:'tv_user_code'}:n);
 else if(hit?.shortId==='iv_chat')nodes=chat();
 else if(hit?.shortId==='tv_check'){cameFromChat=true;nodes=profile(peerUid).map(n=>normalProfile&&n.shortId==='iv_copy'?{...n,shortId:'ll_copy'}:normalProfile&&n.shortId==='tv_nice_num'?{...n,shortId:'tv_user_code'}:n);}
 },back:async()=>{actions.push('back');nodes=cameFromChat?chat():home();cameFromChat=false;}}};
 return {driver,actions,setNodes:n=>nodes=n};
}
const options={timeoutMs:30,pollIntervalMs:1,actionGapMs:0};

test('returnHome leaves a rejected chat without clicking its failed message or send button',async()=>{
 const d=fixture();d.setNodes(chat().concat(node('rc_errorhint','您当前的贡献等级不够，快去直播看看吧。',0,500,1080,550)));
 const nodes=await new PrivateNavigator(d.driver,options).returnHome();assert.ok(nodes.some(n=>n.shortId==='iv_search'));assert.deepEqual(d.actions,['back']);
});

test('returnHome refuses an unknown or foreign screen without any click',async()=>{
 for(const nodes of [[root(),node('unknown','',0,300,500,600)],chat().map(n=>({...n,packageName:'other.app'}))]){
  const d=fixture();d.setNodes(nodes);await assert.rejects(new PrivateNavigator(d.driver,options).returnHome());assert.equal(d.actions.length,0);
 }
});
test('UID search selects user tab and creates verified first conversation without nickname lookup',async()=>{
 const d=fixture();const n=new PrivateNavigator(d.driver,options);
 const p=await n.open('888188');assert.equal(p.uid,'888188');assert.equal(p.nickname,'Current name');
 assert.deepEqual(d.actions,['iv_search','set:888188','tv_search','用户','tv_name','iv_chat','tv_check','back']);
 assert.ok((await n.readChat()).nodes.some(n=>n.shortId==='input_message'));
});
test('a partial UID result never opens a profile',async()=>{
 const d=fixture({users:['22888188']});await assert.rejects(new PrivateNavigator(d.driver,options).open('888188'),/USER_NOT_FOUND/);
 assert.equal(d.actions.includes('tv_name'),false);
});
test('ambiguous exact UID results never choose the first user',async()=>{
 const d=fixture({users:['888188','888188']});await assert.rejects(new PrivateNavigator(d.driver,options).open('888188'),/AMBIGUOUS_USER/);assert.equal(d.actions.includes('tv_name'),false);
});
test('profile UID mismatch blocks private chat entry',async()=>{
 const d=fixture({profileUid:'99999'});await assert.rejects(new PrivateNavigator(d.driver,options).open('888188'),/UID_MISMATCH/);assert.equal(d.actions.includes('iv_chat'),false);
});
test('peer profile is independently checked after entering chat',async()=>{
 const d=fixture({peerUid:'99999'});await assert.rejects(new PrivateNavigator(d.driver,options).open('888188'),/UID_MISMATCH/);assert.equal(d.actions.includes('back'),false);
});
test('wrong application, invalid UID and unknown page cause no actions',async()=>{
 for(const mode of ['foreign','unknown','invalid']){
 const d=fixture();if(mode==='foreign')d.setNodes(home().map(n=>({...n,packageName:'other.app'})));if(mode==='unknown')d.setNodes([root(),node('unknown','',0,300,500,600)]);
 await assert.rejects(new PrivateNavigator(d.driver,options).open(mode==='invalid'?'n123':'888188'));assert.equal(d.actions.length,0);
 }
});
test('search text must match the complete UID before submitting',async()=>{
 const d=fixture({badInput:true});await assert.rejects(new PrivateNavigator(d.driver,options).open('888188'),/SEARCH_INPUT_MISMATCH/);assert.equal(d.actions.includes('tv_search'),false);
});
test('empty result and hidden user nodes do not open profiles',async()=>{
 const d=fixture({empty:true});await assert.rejects(new PrivateNavigator(d.driver,options).open('888188'),/USER_NOT_FOUND/);assert.equal(d.actions.includes('tv_name'),false);
});
test('cancellation after search navigation stops all later actions',async()=>{
 const d=fixture(),c=new AbortController();const tap=d.driver.adb.tap;d.driver.adb.tap=async(...a)=>{await tap(...a);c.abort();};
 await assert.rejects(new PrivateNavigator(d.driver,{...options,signal:c.signal}).open('888188'),{name:'AbortError'});assert.deepEqual(d.actions,['iv_search']);
});
test('a changed chat recipient blocks subsequent reads for typing and sending',async()=>{
 const d=fixture(),n=new PrivateNavigator(d.driver,options);await n.open('888188');
 d.setNodes(chat().map(n=>n.shortId==='tv_nickname'?{...n,text:'Other user'}:n));await assert.rejects(n.readChat(),/CHAT_CONTEXT_CHANGED/);
});

test('chat messages about room passwords never prevent searching the next user',async()=>{
 const d=fixture();d.setNodes(chat().concat(node('rc_text','房间密码是1234',100,500,800,580)));
 const p=await new PrivateNavigator(d.driver,options).open('888188');assert.equal(p.uid,'888188');assert.equal(d.actions[0],'back');
});

test('a loading splash times out without navigation or recursive waits',async()=>{
 const d=fixture();d.setNodes([{...root(),shortId:''}]);
 await assert.rejects(new PrivateNavigator(d.driver,options).open('888188'),/APP_LOADING_TIMEOUT/);assert.equal(d.actions.length,0);
});

test('real control click submits search when coordinate input is consumed by the app',async()=>{
 const d=fixture();const coord=d.driver.adb.tap;
 d.driver.adb.tap=async()=>{throw Error('COORDINATE_INPUT_CONSUMED');};
 let live=home();const dump=d.driver.bridge.dumpUi;
 d.driver.bridge.dumpUi=async()=>{const r=await dump();live=r.nodes;return r;};
 const ids=[];d.driver.bridge.tapById=async id=>{ids.push(id);const n=live.find(n=>n.shortId===id);if(id==='iv_back')await d.driver.adb.back();else await coord(n.centerX,n.centerY);return {ok:true,via:'ACTION_CLICK'};};
 d.driver.bridge.tapByCoord=async(x,y)=>{await coord(x,y);return {ok:true};};
 const p=await new PrivateNavigator(d.driver,options).open('888188');assert.equal(p.uid,'888188');assert.ok(ids.includes('tv_search'));assert.ok(ids.includes('iv_chat'));
});

test('uncertain control click is never repeated with coordinates',async()=>{
 const d=fixture();let coords=0,clicks=0;
 d.driver.bridge.tapById=async()=>{clicks++;return {ok:false,error:'BRIDGE_TIMEOUT'};};d.driver.bridge.tapByCoord=async()=>{coords++;return {ok:true};};
 await assert.rejects(new PrivateNavigator(d.driver,options).open('888188'),/PRIVATE_CLICK_UNCONFIRMED/);assert.equal(clicks,1);assert.equal(coords,0);assert.equal(d.actions.length,0);
});

test('acknowledged app controls are paced so its click debounce cannot swallow search',async()=>{
 const d=fixture(),coord=d.driver.adb.tap;let live=home(),last=0,ignored=0;
 const dump=d.driver.bridge.dumpUi;d.driver.bridge.dumpUi=async()=>{const r=await dump();live=r.nodes;return r;};
 const act=async(x,y,id)=>{if(Date.now()-last<30){ignored++;return {ok:true};}last=Date.now();if(id==='iv_back')await d.driver.adb.back();else await coord(x,y);return {ok:true};};
 d.driver.bridge.tapById=async id=>{const n=live.find(n=>n.shortId===id);return act(n.centerX,n.centerY,id);};d.driver.bridge.tapByCoord=async(x,y)=>act(x,y);
 const p=await new PrivateNavigator(d.driver,{...options,actionGapMs:40}).open('888188');assert.equal(p.uid,'888188');assert.equal(ignored,0);
});

test('hidden duplicate resource ID uses the observed coordinate instead of the first ID match',async()=>{
 const d=fixture(),coord=d.driver.adb.tap;d.setNodes(home().concat(node('iv_search','',1100,88,1180,169)));
 const ids=[];let live;const dump=d.driver.bridge.dumpUi;d.driver.bridge.dumpUi=async()=>{const r=await dump();live=r.nodes;return r;};
 d.driver.bridge.tapById=async id=>{ids.push(id);const n=live.find(n=>n.shortId===id);if(id==='iv_back')await d.driver.adb.back();else await coord(n.centerX,n.centerY);return {ok:true};};
 d.driver.bridge.tapByCoord=async(x,y)=>{await coord(x,y);return {ok:true};};
 await new PrivateNavigator(d.driver,options).open('888188');assert.equal(ids.includes('iv_search'),false);assert.equal(d.actions[0],'iv_search');
});

test('ordinary UID profile uses ll_copy and tv_user_code instead of vanity-number iv_copy',async()=>{
 const d=fixture({normalProfile:true});assert.equal((await new PrivateNavigator(d.driver,options).open('888188')).uid,'888188');
});

test('real UID takes precedence over a conflicting vanity number',()=>{
 const d=fixture(),n=new PrivateNavigator(d.driver,options);const nodes=profile('111105').concat(node('tv_user_code','22315770',104,1000,400,1060));
 assert.equal(n._profile(nodes).uid,'22315770');assert.throws(()=>n._checkUid(n._profile(nodes),'111105'),/UID_MISMATCH/);
 const row=results('22315770',['111105']).concat(node('tv_user_code','22315770',500,479,750,506));
 assert.equal(n._userResult(row,'22315770').text,'Current name');assert.equal(n._userResult(row,'111105'),null);
});
