import {placeholderUid} from './observation-identity.mjs';
import {resolveVisibleRoomUsers} from './room-user-resolver.mjs';
import {abortableSleep,throwIfAborted,isAbortError} from './async-control.mjs';
const id=n=>n.shortId||String(n.resourceId||'').split('/').pop();
const text=n=>String(n?.text||'').trim();
const valid=n=>n&&n.enabled!==false&&[n.x,n.y,n.x2,n.y2].every(Number.isFinite)&&n.x>=0&&n.y>=0&&n.x2>n.x&&n.y2>n.y;
const inside=(n,r)=>valid(n)&&valid(r)&&n.x>=r.x&&n.x2<=r.x2&&n.y>=r.y&&n.y2<=r.y2;
const trusted=nodes=>nodes[0]?.packageName==='com.sybl.voiceroom'&&!nodes.some(n=>n.packageName&&n.packageName!=='com.sybl.voiceroom');
const selected=(nodes,label)=>nodes.filter(n=>text(n)===label&&n.selected===true&&valid(n)).length===1;
export const isContributionPage=nodes=>trusted(nodes)&&nodes.some(n=>text(n)==='房间贡献榜')&&nodes.some(n=>id(n)==='ivToolbarBack'&&valid(n));
export const isDailyContribution=nodes=>isContributionPage(nodes)&&selected(nodes,'房间贡献榜')&&selected(nodes,'今日');
const uid=n=>/^ID\s*[:：]\s*\d{5,32}$/i.test(text(n))?text(n).replace(/^ID\s*[:：]\s*/i,''):null;
function rows(nodes){
 if(!isDailyContribution(nodes))return [];
 const result=[];
 for(let rank=1;rank<=3;rank++){
  const names=nodes.filter(n=>id(n)===`tv_nickname_rank_${rank}`&&valid(n));
  if(names.length!==1||!text(names[0]))continue;
  const codes=nodes.filter(n=>id(n)===`tv_user_code_rank_${rank}`&&valid(n));
  const nice=nodes.filter(n=>id(n)===`tv_nice_num_rank_${rank}`&&valid(n));
  result.push({name:names[0],code:codes.length===1?codes[0]:null,nice:nice.length===1?nice[0]:null,rank,click:names[0].clickable?names[0]:nodes.find(n=>id(n)===`iv_avatar_rank_${rank}`&&valid(n)&&n.clickable)});
 }
 const lists=nodes.filter(n=>id(n)==='rv_rank_list'&&valid(n));if(lists.length!==1)return result;
 const list=lists[0],ranks=nodes.filter(n=>id(n)==='tv_rank'&&inside(n,list));
 const scale=(nodes[0]?.x2||1080)/1080;
 const names=nodes.filter(n=>id(n)==='tv_nickname'&&inside(n,list)&&text(n));
 for(const name of names){
  // Bound each row by its rank marker: repeated flattened IDs must never cross users.
  const markers=ranks.filter(r=>r.y>=name.y&&r.y<name.y+100*scale);
  if(markers.length!==1)continue;
  const rank=Number(text(markers[0]));if(!Number.isInteger(rank)||rank<4)continue;
  const inRow=n=>inside(n,list)&&n.y>=name.y-2*scale&&n.y<name.y+110*scale;
  if(names.filter(inRow).length!==1)continue;
  const codes=nodes.filter(n=>id(n)==='tv_user_code'&&inRow(n));
  const nice=nodes.filter(n=>id(n)==='tv_nice_num'&&inRow(n));
  const avatars=nodes.filter(n=>id(n)==='iv_avatar'&&inRow(n)&&n.clickable&&n.y2-n.y>=60*scale);
  result.push({name,code:codes.length===1?codes[0]:null,nice:nice.length===1?nice[0]:null,rank,click:avatars.length===1?avatars[0]:null});
 }
 return result;
}
export function extractContributionUsers(nodes,context={}){
 return rows(nodes).map(row=>{
  const real=uid(row.code),nickname=text(row.name),nice=text(row.nice);
  return {uid:real||placeholderUid(nickname,context),uidReal:!!real,nickname,sex:'unknown',guild:'',guildKnown:false,online:null,source:'room_observation',seenFrom:'dailyContribution',evidence:'visible_daily_contribution_row',room:context.room||'',roomCode:context.roomCode||'',contributionRank:row.rank,...(!real&&/^\d+$/.test(nice)?{publicIdentityType:'nice_number',publicIdentityValue:nice}:{})};
 });
}
function sourceNode(nodes,user){
 const matches=rows(nodes).filter(r=>text(r.name)===user.nickname&&(user.uidReal?uid(r.code)===user.uid:!uid(r.code)&&text(r.nice)===(user.publicIdentityValue||'')));
 return matches.length===1?matches[0].click:null;
}
/** Browse public daily contribution entries only. Never touch follow controls or pinned self. */
export async function scanDailyContribution(driver,{room,roomCode,signal,maxPages=6,maxProfiles=6,maxDurationMs=120000,onUsers=()=>{},onLog=()=>{},userResolver=resolveVisibleRoomUsers,knownMappings,attemptHistory}={}){
 throwIfAborted(signal);
 const deadline=Date.now()+Math.min(180000,Math.max(1000,maxDurationMs)),seen=new Set(),signatures=new Set();
 let pages=0,profilesRead=0,status='unavailable',reason='entry_missing',opened=false;
 const read=async(timeout=Math.max(1,Math.min(2000,deadline-Date.now())))=>{throwIfAborted(signal);const d=await driver.bridge.dumpUi({signal,retries:0,timeout});throwIfAborted(signal);return d.nodes||[];};
 const tap=async n=>{if(!valid(n)||!n.clickable)throw Error('RANK_CONTROL_UNAVAILABLE');throwIfAborted(signal);return driver.bridge.tapByCoord((n.x+n.x2)/2,(n.y+n.y2)/2,{signal,timeout:1500});};
 const waitFor=async(predicate,cleanup=false)=>{const until=cleanup?Date.now()+5000:Math.min(deadline,Date.now()+5000);while(Date.now()<until){const n=await read(cleanup?1200:undefined);if(predicate(n))return n;await abortableSleep(150,signal);}return null;};
 try{
  let nodes=await read();if(!trusted(nodes)){reason='wrong_app';return result();}
  if(!isContributionPage(nodes)){
   if(!nodes.some(n=>id(n)==='tv_room_code'&&valid(n)))return result();
   const entry=nodes.filter(n=>id(n)==='iv_rank'&&valid(n)&&n.clickable);
   if(entry.length!==1)return result();
   if(!(await tap(entry[0]))?.ok){reason='entry_click_failed';return result();}
   nodes=await waitFor(isContributionPage);if(!nodes){reason='rank_not_ready';return result();}
  }
  opened=true;
  for(const label of ['房间贡献榜','今日']){
   if(selected(nodes,label))continue;
   const tabs=nodes.filter(n=>text(n)===label&&n.clickable&&valid(n));
   if(tabs.length!==1){reason='tab_missing';return result();}
   await tap(tabs[0]);nodes=await waitFor(n=>isContributionPage(n)&&selected(n,label));
   if(!nodes){reason='tab_not_ready';return result();}
  }
  await abortableSleep(350,signal);
  nodes=await waitFor(n=>isDailyContribution(n)&&(rows(n).length>0||n.some(v=>/^(暂无数据|暂无榜单|暂无上榜用户)$/.test(text(v)))));
  if(!nodes){reason='list_not_ready';return result();}
  status='partial';reason='max_pages';
  while(Date.now()<deadline&&pages<maxPages){
   if(!isDailyContribution(nodes)){reason='rank_lost';break;}
   const users=extractContributionUsers(nodes,{room,roomCode});
   const signature=JSON.stringify(users.map(u=>[u.contributionRank,u.uid]));
   if(signatures.has(signature)){status='complete';reason='end_of_list';break;}
   signatures.add(signature);pages++;
   const fresh=users.filter(u=>!seen.has(u.uid));fresh.forEach(u=>seen.add(u.uid));
   if(fresh.length)await onUsers(fresh);
   if(profilesRead<maxProfiles&&users.length){
    const enriched=await userResolver(driver,users,{room,roomCode,signal,maxProfiles:maxProfiles-profilesRead,maxDurationMs:Math.max(1,Math.min(60000,deadline-Date.now())),knownMappings,attemptHistory,sourcePage:isDailyContribution,sourceNode,onLog,onUser:record=>onUsers([{...record,seenFrom:'roomProfile'}])});
    profilesRead+=enriched.profilesRead;
    if(['room_restore_failed','card_lost','unknown_page','profile_read_failed'].includes(enriched.reason)){reason=enriched.reason;break;}
   }
   if(!users.length){status='empty';reason='empty_list';break;}
   if(pages>=maxPages)break;
   nodes=await read();if(!isDailyContribution(nodes)){reason='rank_lost';break;}
   const lists=nodes.filter(n=>id(n)==='rv_rank_list'&&valid(n));if(lists.length!==1){reason='list_missing';break;}
   const r=lists[0],x=(r.x+r.x2)/2,h=r.y2-r.y;
   await driver.adb.swipe(x,r.y+h*.85,x,r.y+h*.2,350);await abortableSleep(300,signal);nodes=await read();
   // Confirm an unchanged page with a fresh read before concluding bottom.
   if(JSON.stringify(extractContributionUsers(nodes,{room,roomCode}).map(u=>[u.contributionRank,u.uid]))===signature){await abortableSleep(300,signal);nodes=await read();}
  }
  if(Date.now()>=deadline)reason='max_duration';
 }catch(error){if(isAbortError(error))throw error;reason='read_failed';onLog('warn',`今日贡献榜采集未完成：${error.message}`);}
 finally{
  if(opened&&!signal?.aborted){
   try{
    const current=await read(1200);
    if(isContributionPage(current)){
     const backs=current.filter(n=>id(n)==='ivToolbarBack'&&valid(n)&&n.clickable);
     if(backs.length===1){await driver.adb.back();const restored=await waitFor(n=>trusted(n)&&n.some(v=>id(v)==='tv_room_code'&&(!roomCode||text(v).match(/\d+/)?.[0]===String(roomCode))),true);if(!restored){status='partial';reason='room_restore_failed';}}
    }else{status='partial';reason='room_restore_failed';}
   }catch(error){if(isAbortError(error))throw error;status='partial';reason='room_restore_failed';onLog('warn','今日贡献榜关闭后未确认原房间，请检查模拟器页面。');}
  }
 }
 return result();
 function result(){return {pages,profilesRead,status,reason};}
}
