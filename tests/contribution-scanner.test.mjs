import test from 'node:test';
import assert from 'node:assert/strict';
import {extractContributionUsers,isDailyContribution,scanDailyContribution} from '../src/contribution-scanner.mjs';
import {profileLevelRegion} from '../src/user-level.mjs';
import {profileIdentity} from '../src/profile-identity.mjs';
import {RoomCollector} from '../src/room-collector.mjs';
import {RoomNavigator} from '../src/room-navigator.mjs';
const n=(shortId,text,x,y,x2,y2,extra={})=>({shortId,text,x,y,x2,y2,centerX:(x+x2)/2,centerY:(y+y2)/2,packageName:'com.sybl.voiceroom',enabled:true,...extra});
const fixture=()=>[n('','',0,0,1080,1920),n('','房间贡献榜',400,70,700,150,{selected:true,clickable:true}),n('','今日',370,230,456,287,{selected:true,clickable:true}),n('ivToolbarBack','',0,60,150,169,{clickable:true}),n('tv_nickname_rank_1','first',450,610,650,670,{clickable:true}),n('tv_user_code_rank_1','ID:123456',450,680,650,730),n('rv_rank_list','',0,820,1080,1690,{scrollable:true}),n('tv_rank','4',20,895,140,942),n('tv_nickname','fourth',290,860,410,917),n('tv_user_code','ID:234567',290,922,490,969),n('iv_avatar','',140,860,250,970,{clickable:true}),n('iv_bottom_follow','',160,950,230,995,{clickable:true}),n('tv_rank','5',20,1085,140,1132),n('tv_nickname','nice',290,1050,410,1107),n('tv_nice_num','888188',330,1120,410,1150),n('iv_avatar','',140,1050,250,1160,{clickable:true}),n('tv_nickname_me','self',360,1750,450,1800),n('tv_user_code_me','ID:999999',360,1810,560,1860)];
test('daily contribution extracts podium and ordinary rows, excludes fixed self, never trusts nice number',()=>{
 const users=extractContributionUsers(fixture(),{room:'test',roomCode:'911'});
 assert.deepEqual(users.map(u=>u.nickname),['first','fourth','nice']);
 assert.equal(users[0].uid,'123456');assert.equal(users[1].uid,'234567');
 assert.equal(users[2].uidReal,false);assert.notEqual(users[2].uid,'888188');
 assert.equal(users[2].publicIdentityValue,'888188');assert.equal(users[0].seenFrom,'dailyContribution');
});
test('requires selected contribution and today; rejects foreign package and ambiguous pairing',()=>{
 const nodes=fixture();nodes[1].selected=false;assert.equal(isDailyContribution(nodes),false);assert.deepEqual(extractContributionUsers(nodes),[]);
 nodes[1].selected=true;nodes[2].selected=false;assert.equal(isDailyContribution(nodes),false);
 nodes[2].selected=true;nodes[0].packageName='other';assert.equal(isDailyContribution(nodes),false);
});
test('scanner only publishes rank users, enriches in place and restores room',async()=>{
 const nodes=fixture(),published=[];let back=0;
 const driver={bridge:{dumpUi:async()=>({nodes:back?[n('','',0,0,1080,1920),n('tv_room_code','ID:911',10,10,100,50)]:nodes}),tapByCoord:async()=>({ok:true})},adb:{back:async()=>{back++;},swipe:async()=>{}}};
 const result=await scanDailyContribution(driver,{room:'test',maxPages:1,maxProfiles:1,onUsers:u=>published.push(...u),userResolver:async(_d,users,options)=>{assert.equal(options.sourcePage(nodes),true);const target=options.sourceNode(nodes,users[1]);assert.equal(target.shortId,'iv_avatar');await options.onUser({...users[0],sex:'female'});return {profilesRead:1,reason:'complete'};}});
 assert.equal(result.pages,1);assert.equal(result.profilesRead,1);assert.equal(back,1);assert.equal(published.length,4);
});
test('missing crown never falls back to collecting room users or clicking unrelated controls',async()=>{
 let tapped=0,published=0;
 const result=await scanDailyContribution({bridge:{dumpUi:async()=>({nodes:[n('','',0,0,1080,1920),n('tv_room_name','room',0,20,100,60)]}),tapByCoord:async()=>{tapped++;}}},{onUsers:()=>published++});
 assert.equal(result.reason,'entry_missing');assert.equal(tapped,0);assert.equal(published,0);
});
test('full public profile binds a nice number without requiring follow and reads the two level badges only',()=>{
 const nodes=[n('','',0,0,1080,1920),n('tv_nickname','fixture',83,847,187,924),n('tv_nice_num','888188',104,936,182,963),n('iv_copy','',205,930,263,988),n('tv_age','20',326,949,380,988),n('tv_sign','fixture text',123,1101,991,1153),n('iv_back','',0,48,167,180),n('iv_chat','',476,1696,1023,1834)];
 const expected={expectedNiceNumber:'888188',expectedNickname:'fixture'};
 assert.equal(profileIdentity(nodes,expected).kind,'nice_number');
 const region=profileLevelRegion(nodes,undefined,'fixture',expected);
 assert.ok(region.x<70&&region.x+region.width<330&&region.y>988&&region.y+region.height<1101);
 assert.equal(profileIdentity(nodes,{expectedUid:'888188',expectedNickname:'fixture'}),null);
});
test('rank navigation selects contribution and today instead of accepting another tab',async()=>{
 const nodes=fixture();nodes[1].selected=false;nodes[2].selected=false;let backs=0;const taps=[];
 const driver={bridge:{dumpUi:async()=>({nodes:backs?[n('','',0,0,1080,1920),n('tv_room_code','ID:911',0,20,100,60)]:nodes}),tapByCoord:async(x,y)=>{const tab=nodes.find(v=>v.clickable&&x>=v.x&&x<=v.x2&&y>=v.y&&y<=v.y2);taps.push(tab.text);tab.selected=true;return {ok:true};}},adb:{back:async()=>backs++}};
 const result=await scanDailyContribution(driver,{maxPages:1,maxProfiles:0});assert.deepEqual(taps,['房间贡献榜','今日']);assert.equal(result.pages,1);
});
test('unchanged page stops after a fresh read and cancellation never navigates',async()=>{
 const nodes=fixture();let backs=0,swipes=0,published=0;
 const driver={bridge:{dumpUi:async()=>({nodes:backs?[n('','',0,0,1080,1920),n('tv_room_code','ID:911',0,20,100,60)]:nodes})},adb:{back:async()=>backs++,swipe:async()=>swipes++}};
 const result=await scanDailyContribution(driver,{maxPages:6,maxProfiles:0,onUsers:()=>published++});
 assert.equal(result.reason,'end_of_list');assert.equal(result.pages,1);assert.equal(published,1);assert.equal(swipes,1);
 await assert.rejects(scanDailyContribution(driver,{signal:AbortSignal.abort()}),{name:'AbortError'});assert.equal(backs,1);
});
test('daily collection never publishes room chat or seats and persists scanner output only',async()=>{
 const published=[],meta={room:'test',roomCode:'911',nodes:[]};
 const collector=new RoomCollector({bridge:{}},{collectionSource:'dailyContribution',navigator:{ensureRoom:async()=>meta,getStatus:()=>({})},extractUsers:()=>{throw Error('room extraction must not run');},onUsers:users=>{published.push(...users);return {added:1,addedVerified:1};},contributionScanner:async(_d,opts)=>{await opts.onUsers([{uid:'123456',uidReal:true,nickname:'rank user',seenFrom:'dailyContribution'}]);return {pages:1,profilesRead:0,status:'partial',reason:'max_pages'};}});
 collector.stopped=false;await collector._collectOnce();assert.equal(published.length,1);assert.equal(published[0].seenFrom,'dailyContribution');assert.equal(collector.getStatus().newVerified,1);
});
test('starting from the contribution page returns to the same room without touching follow controls',async()=>{
 let current=fixture(),taps=0;
 const room=[n('','',0,0,1080,1920,{className:'android.widget.FrameLayout'}),n('tv_room_name','test',20,60,500,120),n('tv_room_code','ID:911',20,130,300,170),n('layout_online_user','',700,70,850,160),n('iv_quit','',950,70,1030,160)];
 const driver={bridge:{dumpUi:async()=>({nodes:current}),tapByCoord:async(x,y)=>{assert.equal(x,75);assert.equal(y,114.5);taps++;current=room;return {ok:true};}},adb:{screenSize:async()=>({w:1080,h:1920})}};
 driver.adb.tap=driver.bridge.tapByCoord;
 const navigator=new RoomNavigator(driver);const meta=await navigator.ensureRoom();assert.equal(meta.roomCode,'911');assert.equal(taps,1);
});
test('long first rank scan does not leave the start button waiting and stop waits for cleanup',async()=>{
 let finish;
 const pending=new Promise(r=>{finish=r;});
 const collector=new RoomCollector({},{collectionSource:'dailyContribution'});
 collector._collectOnce=()=>pending;
 const result=await Promise.race([collector.start(),new Promise((_,reject)=>setTimeout(()=>reject(Error('start blocked')),200))]);
 assert.equal(result.ok,true);finish();await collector.stop();assert.equal(collector.getStatus().running,false);
});
test('scan duration exhaustion still gives room restoration an independent cleanup budget',async()=>{
 let back=false;const nodes=fixture();const cleanupTimeouts=[];
 const driver={bridge:{dumpUi:async options=>{if(back)cleanupTimeouts.push(options.timeout);return {nodes:back?[n('','',0,0,1080,1920),n('tv_room_code','ID:911',0,20,100,60)]:nodes};}},adb:{back:async()=>{back=true;}}};
 const result=await scanDailyContribution(driver,{maxPages:1,maxProfiles:0,maxDurationMs:1000,onUsers:async()=>new Promise(r=>setTimeout(r,1100))});
 assert.equal(back,true);assert.equal(result.reason,'max_duration');assert.ok(cleanupTimeouts[0]>=1200);
});
