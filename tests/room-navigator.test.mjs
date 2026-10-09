import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomNavigator } from '../src/room-navigator.mjs';

const passwordDialog=()=>[
 node('dialog_title','请输入房间密码',200,600,880,680),
 node('et_password','',200,700,880,800,{className:'android.widget.EditText'}),
 node('cancel','取消',200,850,400,950,{clickable:true}),
 node('confirm','确定',600,850,800,950,{clickable:true})
];

const pkg='com.sybl.voiceroom';
const node=(shortId,text,x,y,x2,y2,extra={})=>({shortId,text,x,y,x2,y2,centerX:(x+x2)/2,centerY:(y+y2)/2,packageName:pkg,...extra});
function home(names=['A','B']) {
 return [node('ll_tab_home','',0,1700,200,1900),node('rv_recommend_room','',0,500,1080,1700,{className:'androidx.recyclerview.widget.RecyclerView',scrollable:true}),...names.map((name,i)=>node('tv_room_name',name,46+i*337,968,360+i*337,1019))];
}
function room(name) {return [node('tv_room_name',name,0,20,500,80),node('tv_room_code','ID:1234',0,90,300,140),node('layout_online_user','',800,100,1050,200),node('iv_quit','',950,20,1050,80)];}
function device({names=['A','B'],fail=new Set(),extra=[]}={}) {
 let current=home(names).concat(extra),clicks=[],swipes=0;
 const driver={bridge:{dumpUi:async()=>({nodes:current})},adb:{screenSize:async()=>({w:1080,h:1920}),tap:async(x,y)=>{const hit=current.find(n=>n.shortId==='iv_quit'&&n.centerX===x&&n.centerY===y)||current.find(n=>n.shortId==='tv_room_name'&&n.centerX===x&&n.centerY===y);clicks.push(hit?.shortId+':'+hit?.text);if(hit?.shortId==='iv_quit')current=home(names).concat(extra);else if(hit&&!fail.has(hit.text))current=room(hit.text);},swipe:async()=>swipes++}};
 return {driver,clicks,getSwipes:()=>swipes,setNodes:nodes=>current=nodes};
}
test('failed first card is skipped and verified second room is entered',async()=>{
 const d=device({fail:new Set(['A'])});const n=new RoomNavigator(d.driver,{entryTimeoutMs:5,pollIntervalMs:1});
 assert.equal((await n.nextRoom()).room,'B');assert.deepEqual(d.clicks,['tv_room_name:A','tv_room_name:B']);assert.equal(n.getStatus().failed,1);
});
test('hidden inflated cards and tiny partial cards are never tapped',async()=>{
 const d=device({names:[],extra:[node('tv_room_name','hidden',10,2048,350,1747),node('tv_room_name','tiny',100,900,123,950)]});
 const n=new RoomNavigator(d.driver,{entryTimeoutMs:5,pollIntervalMs:1});assert.equal(await n.nextRoom(),null);assert.equal(d.clicks.length,0);assert.ok(d.getSwipes()<=4);
});
test('room rotation is capped and never retries visited names',async()=>{
 const d=device();const n=new RoomNavigator(d.driver,{maxRooms:2,entryTimeoutMs:5,pollIntervalMs:1});
 assert.equal((await n.nextRoom()).room,'A');assert.equal((await n.nextRoom()).room,'B');assert.equal(await n.nextRoom(),null);assert.deepEqual(n.getStatus().visited,['A','B']);
});
test('cancellation prevents all navigation actions',async()=>{
 const d=device();const c=new AbortController();c.abort();const n=new RoomNavigator(d.driver,{signal:c.signal});await assert.rejects(n.nextRoom(),{name:'AbortError'});assert.equal(d.clicks.length,0);
});
test('fixed preferred room does not rotate to other rooms',async()=>{
 const d=device();const n=new RoomNavigator(d.driver,{entryTimeoutMs:5,pollIntervalMs:1});assert.equal((await n.ensureRoom({preferredRoomName:'B'})).room,'B');assert.equal((await n.nextRoom()).room,'B');assert.deepEqual(d.clicks,['tv_room_name:B']);
});
test('existing room accepts only valid visible header and never follows or sends',async()=>{
 const d=device();d.setNodes(room('Existing').concat([node('tv_room_name','hidden',0,0,0,0),node('iv_send','发送',20,200,100,300),node('follow','关注',100,200,200,300),node('iv_room_gift','礼物',200,200,300,300)]));
 const n=new RoomNavigator(d.driver);assert.equal((await n.ensureRoom()).room,'Existing');assert.equal(d.clicks.length,0);
});
test('observed member popup is closed with ivBack and current room is retained',async()=>{
 const d=device();let clicks=[];d.setNodes(room('Existing').concat([node('tvTitle','房间在线用户(0人)',375,567,705,626),node('ivBack','',46,562,115,631)]));
 d.driver.adb.tap=async(x,y)=>{clicks.push([x,y]);d.setNodes(room('Existing'));};
 const n=new RoomNavigator(d.driver,{entryTimeoutMs:5,pollIntervalMs:1});assert.equal((await n.ensureRoom()).room,'Existing');assert.deepEqual(clicks,[[80.5,596.5]]);
});
test('fixed room remains selected even with a one-room cap',async()=>{
 const d=device();const n=new RoomNavigator(d.driver,{maxRooms:1,entryTimeoutMs:5,pollIntervalMs:1});await n.ensureRoom({preferredRoomName:'B'});assert.equal((await n.nextRoom()).room,'B');
});
test('rooms not collected before are preferred and recommended strip scrolls horizontally',async()=>{
 const d=device();const n=new RoomNavigator(d.driver,{knownRoomNames:['A'],entryTimeoutMs:5,pollIntervalMs:1});assert.equal((await n.nextRoom()).room,'B');
 const empty=device({names:[]});let swipe;empty.driver.adb.swipe=async(...args)=>swipe=args;
 await new RoomNavigator(empty.driver,{pollIntervalMs:1}).nextRoom();assert.equal(swipe[1],swipe[3]);assert.ok(swipe[0]>swipe[2]);
});
test('main home RecyclerView is the only vertical scroll target',async()=>{
 const d=device({names:[]});d.setNodes(home([]).concat([node('mRecyclerView','',0,400,1080,1700,{className:'androidx.recyclerview.widget.RecyclerView',scrollable:true})]));let swipe;d.driver.adb.swipe=async(...args)=>swipe=args;
 await new RoomNavigator(d.driver,{pollIntervalMs:1}).nextRoom();assert.equal(swipe[0],swipe[2]);assert.ok(swipe[1]>swipe[3]);
});
test('exit confirms only exact observed exit control, never generic confirm',async()=>{
 const d=device();d.setNodes(room('Current'));let clicks=[];
 d.driver.adb.tap=async(x,y)=>{
   clicks.push([x,y]);
   if(clicks.length===1)d.setNodes([node('button_ok','确定',20,300,120,400,{clickable:true}),node('button_exit','退出房间',200,300,400,400,{clickable:true})]);
   else if(x===300)d.setNodes(home());
   else if(x===100)d.setNodes(home());
   else d.setNodes(room('A'));
 };
 const n=new RoomNavigator(d.driver,{entryTimeoutMs:100,pollIntervalMs:1});assert.equal((await n.nextRoom()).room,'A');assert.equal(clicks.some(([x])=>x===70),false);assert.deepEqual(clicks[1],[300,350]);
});
test('wrong package and cancellation during a click never continue navigation',async()=>{
 const d=device();d.setNodes(home().map(n=>({...n,packageName:'other.app'})));await assert.rejects(new RoomNavigator(d.driver).nextRoom(),/WRONG_PACKAGE/);assert.equal(d.clicks.length,0);
 const d2=device();const c=new AbortController();let attempts=0;d2.driver.adb.tap=async()=>{attempts++;c.abort();};
 await assert.rejects(new RoomNavigator(d2.driver,{signal:c.signal}).nextRoom(),{name:'AbortError'});assert.equal(attempts,1);
});
test('trusted bridge root overrides landscape wm size for portrait viewport',async()=>{
 const d=device();d.driver.adb.screenSize=async()=>({w:1920,h:1080});
 const initial=home().concat([node('mRecyclerView','',0,637,1080,1747,{className:'androidx.recyclerview.widget.RecyclerView'})]);
 d.setNodes([node('root','',0,0,1080,1920,{className:'android.widget.FrameLayout'}),...initial]);let tapped=[];
 d.driver.adb.tap=async(x,y)=>{tapped.push([x,y]);d.setNodes([node('root','',0,0,1080,1920,{className:'android.widget.FrameLayout'}),...room('A')]);};
 const n=new RoomNavigator(d.driver,{entryTimeoutMs:5,pollIntervalMs:1});assert.equal((await n.nextRoom()).room,'A');assert.equal(n.size.h,1920);assert.equal(tapped.length,1);
});
test('room toolbar closes with back then verified room backs home; close room is never tapped',async()=>{
 const d=device();const menu=room('Current').concat([node('close_room','关闭房间',100,300,350,400,{clickable:true}),node('tv_mini','最小化',400,300,600,400,{clickable:true})]);d.setNodes(menu);let backs=0;
 d.driver.adb.back=async()=>{backs++;d.setNodes(backs===1?room('Current'):home());};
 const n=new RoomNavigator(d.driver,{entryTimeoutMs:5,pollIntervalMs:1});assert.equal((await n.nextRoom()).room,'A');assert.equal(backs,2);assert.deepEqual(d.clicks,['tv_room_name:A']);
});
test('unknown page never receives blind back',async()=>{
 const d=device();d.setNodes([node('unknown','',0,0,1080,1920)]);let backs=0;d.driver.adb.back=async()=>backs++;
 assert.equal(await new RoomNavigator(d.driver,{entryTimeoutMs:5,pollIntervalMs:1}).nextRoom(),null);assert.equal(backs,0);
});
test('failed room back route stops after two verified attempts',async()=>{
 const d=device();d.setNodes(room('Current'));let backs=0;d.driver.adb.back=async()=>backs++;
 const n=new RoomNavigator(d.driver,{entryTimeoutMs:2,pollIntervalMs:1});assert.equal(await n.nextRoom(),null);assert.equal(backs,2);assert.equal(d.clicks.length,0);
});
test('observed user card recovers once into current room with popup viewport',async()=>{
 const d=device();d.driver.adb.screenSize=async()=>({w:1920,h:1080});
 d.setNodes([node('root','',0,1000,1080,1920,{className:'android.widget.FrameLayout'}),node('rv_top_bg','',0,1100,1080,1400),node('tv_nickname','Alice',100,1200,500,1250),node('tv_user_code','12345',100,1280,500,1330)]);let backs=0;
 d.driver.adb.back=async()=>{backs++;d.setNodes(room('Current'));};
 const n=new RoomNavigator(d.driver,{entryTimeoutMs:5,pollIntervalMs:1});assert.equal((await n.ensureRoom()).room,'Current');assert.equal(backs,1);assert.equal(n.size.h,1920);
});
test('incomplete user-card markers never cause a back action',async()=>{
 const d=device();d.setNodes([node('rv_top_bg','',0,800,1080,1300),node('tv_nickname','Alice',100,1100,500,1150)]);let backs=0;d.driver.adb.back=async()=>backs++;
 assert.equal(await new RoomNavigator(d.driver,{entryTimeoutMs:5,pollIntervalMs:1}).ensureRoom(),null);assert.equal(backs,0);
});

test('new operation-row user card can be dismissed without treating nice number as UID',async()=>{
 const d=device();d.setNodes([node('root','',0,770,1080,1920,{className:'android.widget.FrameLayout'}),node('rv_top_bg','',0,770,1080,1628),node('tv_nickname','Alice',200,1360,600,1430),node('tv_nice_num','111105',79,1286,157,1313),node('iv_copy','',194,1285,223,1314),...['关注','送礼','私聊Ta'].map((text,i)=>node('tv_user_operate_item',text,200+i*200,1756,350+i*200,1815))]);let backs=0;
 d.driver.adb.back=async()=>{backs++;d.setNodes(room('Current'));};
 const n=new RoomNavigator(d.driver,{entryTimeoutMs:100,pollIntervalMs:1});assert.equal((await n.ensureRoom()).room,'Current');assert.equal(backs,1);
});

test('collection recovers observed private chat and full profile back to home',async()=>{
 const d=device();const chat=[node('input_message','请输入消息...',58,1652,707,1782),node('iv_send','',913,1681,1045,1753),node('iv_back','',0,62,127,166),node('tv_nickname','A',127,58,400,118)];
 const profile=[node('iv_chat','',476,1696,1023,1834),node('iv_follow','',58,1696,441,1834),node('iv_copy','',194,1285,223,1314),node('tv_nickname','A',200,847,600,924),node('tv_nice_num','111105',104,936,300,963),node('iv_back','',0,48,167,180)];
 d.setNodes(chat);let exits=0;const tap=d.driver.adb.tap;
 d.driver.adb.tap=async(x,y)=>{if(x<100){exits++;d.setNodes(exits===1?profile:home());}else await tap(x,y);};
 const n=new RoomNavigator(d.driver,{entryTimeoutMs:100,pollIntervalMs:1});assert.equal((await n.ensureRoom()).room,'A');assert.equal(exits,2);
});

test('password room is dismissed immediately and next room is entered only once',async()=>{
 const d=device();let backs=0,dumps=0;
 const tap=d.driver.adb.tap;const dump=d.driver.bridge.dumpUi;
 d.driver.bridge.dumpUi=async()=>{dumps++;return dump();};
 d.driver.adb.tap=async(x,y)=>{await tap(x,y);d.setNodes(d.clicks.at(-1)==='tv_room_name:A'?home().concat(passwordDialog()):room('B'));};
 d.driver.adb.back=async()=>{backs++;d.setNodes(home());};
 const n=new RoomNavigator(d.driver,{entryTimeoutMs:5000,pollIntervalMs:1});
 assert.equal((await n.nextRoom()).room,'B');assert.equal(backs,1);
 assert.deepEqual(d.clicks,['tv_room_name:A','tv_room_name:B']);assert.ok(dumps<12);
 assert.equal(n.getStatus().passwordSkipped,1);assert.equal(n.getStatus().failed,1);
});

test('password prompt over a room is never accepted as an entered room',async()=>{
 const d=device();d.setNodes(room('A').concat(passwordDialog()));let backs=0;
 d.driver.adb.back=async()=>{backs++;d.setNodes(backs===1?room('A'):home(['B']));};
 const n=new RoomNavigator(d.driver,{entryTimeoutMs:5,pollIntervalMs:1});
 assert.equal((await n.ensureRoom()).room,'B');assert.equal(backs,2);
});

test('password dialog cancel fallback never submits password or confirm',async()=>{
 const d=device();d.setNodes(passwordDialog());let clicked=[];
 d.driver.adb.tap=async(x,y)=>{clicked.push([x,y]);d.setNodes(clicked.length===1?home():room('A'));};
 assert.equal((await new RoomNavigator(d.driver,{entryTimeoutMs:5,pollIntervalMs:1}).nextRoom()).room,'A');
 assert.deepEqual(clicked[0],[300,900]);assert.equal(clicked.some(([x,y])=>x===700&&y===900),false);
});

test('chat text mentioning room password does not trigger password recovery',async()=>{
 const d=device();d.setNodes(room('A').concat([node('tv_bubble_content','请输入房间密码',200,600,880,680),node('chat_input','',200,700,880,800,{className:'android.widget.EditText'})]));
 let backs=0;d.driver.adb.back=async()=>backs++;
 assert.equal((await new RoomNavigator(d.driver).ensureRoom()).room,'A');assert.equal(backs,0);
});

test('undismissed password dialog stops without further clicks; cancellation stops immediately',async()=>{
 const d=device();d.setNodes(passwordDialog().filter(n=>n.shortId!=='cancel'));let backs=0;d.driver.adb.back=async()=>backs++;
 assert.equal(await new RoomNavigator(d.driver,{entryTimeoutMs:3,pollIntervalMs:1}).nextRoom(),null);assert.equal(backs,2);assert.equal(d.clicks.length,0);
 const c=new AbortController();d.driver.adb.back=async()=>{c.abort();};
 await assert.rejects(new RoomNavigator(d.driver,{signal:c.signal}).nextRoom(),{name:'AbortError'});assert.equal(d.clicks.length,0);
});

test('back that hides keyboard only is followed by verified password cancel',async()=>{
 const d=device();d.setNodes(passwordDialog());let backs=0,actions=[];
 d.driver.adb.back=async()=>backs++;
 d.driver.adb.tap=async(x,y)=>{actions.push([x,y]);d.setNodes(actions.length===1?home():room('A'));};
 const n=new RoomNavigator(d.driver,{entryTimeoutMs:5,pollIntervalMs:1});
 assert.equal((await n.nextRoom()).room,'A');assert.equal(backs,1);assert.deepEqual(actions[0],[300,900]);
});
