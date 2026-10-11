import {classifyGenderBadge} from './gender-badge.cjs';
import {throwIfAborted,isAbortError} from './async-control.mjs';
const id=node=>node.shortId||String(node.resourceId||'').split('/').pop();
const rect=n=>n&&[n.x,n.y,n.x2,n.y2].every(Number.isFinite)&&n.x>=0&&n.y>=0&&n.x2>n.x&&n.y2>n.y?{x:n.x,y:n.y,x2:n.x2,y2:n.y2}:null;
const uid=text=>{const value=String(text||'').trim();return /^(?:\d{1,32}|\(\d{1,32}\)|ID\s*[:：]\s*\d{1,32})$/i.test(value)?value.replace(/^ID\s*[:：]\s*/i,'').replace(/[()]/g,''):null;};
function semantic(nodes){
 const found=new Set();
 for(const node of nodes){
  const key=id(node).replace(/([a-z])([A-Z])/g,'$1_$2').toLowerCase();
  if(!/(?:sex|gender)|^tv_(?:user_)?age$/.test(key)||node.enabled===false)continue;
  for(const value of [node.text,node.contentDesc,node.desc]){
   const label=String(value||'').trim();
   if(/^(?:♀|女(?:生|性)?|female)(?:[\s,，:：]*\d{1,3}(?:岁)?|\s*)$/i.test(label))found.add('female');
   if(/^(?:♂|男(?:生|性)?|male)(?:[\s,，:：]*\d{1,3}(?:岁)?|\s*)$/i.test(label))found.add('male');
  }
  if(/(?:^|_)(?:female|woman|girl)(?:_|$)/.test(key))found.add('female');
  if(/(?:^|_)(?:male|man|boy)(?:_|$)/.test(key))found.add('male');
 }
 return {sex:found.size===1?[...found][0]:'unknown',conflict:found.size>1};
}
export function genderFromBadgeNodes(nodes){return semantic(nodes).sex;}
function context(nodes,expectedUid,expectedNickname){
 if(nodes?.[0]?.packageName!=='com.sybl.voiceroom'||nodes.some(n=>n.packageName&&n.packageName!=='com.sybl.voiceroom'))return null;
 const viewport=rect(nodes[0]);if(!viewport)return null;
 const visible=n=>{const r=rect(n);return r&&n.enabled!==false&&r.x>=viewport.x&&r.y>=viewport.y&&r.x2<=viewport.x2&&r.y2<=viewport.y2;};
 const names=nodes.filter(n=>id(n)==='tv_nickname'&&visible(n)),codes=nodes.filter(n=>id(n)==='tv_user_code'&&visible(n));
 if(names.length!==1||codes.length!==1||uid(codes[0].text)!==String(expectedUid)||String(names[0].text||'').trim()!==expectedNickname)return null;
 return {visible,ages:nodes.filter(n=>/^(?:tv_age|tv_user_age|tv_sex_age|tv_gender_age)$/.test(id(n))&&visible(n)&&/^\d{1,3}\s*(?:岁)?$/.test(String(n.text||'').trim())),icons:nodes.filter(n=>/^(?:iv|img|image)_(?:sex|gender)$/.test(id(n))&&visible(n))};
}
/** Read only the age-adjacent symbol on an identity-verified public profile. */
export async function readProfileGender(driver,nodes,{expectedUid,expectedNickname,signal,timeout=4000}={}){
 throwIfAborted(signal);const deadline=Date.now()+Math.max(1,timeout);
 try{
  for(let attempt=0;attempt<2;attempt++){
   throwIfAborted(signal);const current=context(nodes,expectedUid,expectedNickname);if(!current)return {sex:'unknown',reason:'identity_unverified'};
   const direct=semantic(nodes.filter(current.visible));
   if(direct.conflict)return {sex:'unknown',reason:'conflicting_symbols'};
   if(direct.sex!=='unknown')return {sex:direct.sex,evidence:{kind:'gender_badge_text',sex:direct.sex,confidence:1}};
   if(current.icons.length>1||(!current.icons.length&&current.ages.length!==1))return {sex:'unknown',reason:'badge_unavailable'};
   if(typeof driver.adb?.screenshotBuffer!=='function'||Date.now()>=deadline)return {sex:'unknown',reason:'capture_unavailable'};
   const marker=current.icons[0]||current.ages[0],explicit=!!current.icons.length,height=marker.y2-marker.y;
   const left=Math.max(0,Math.floor(marker.x-2.2*height)),top=Math.max(0,Math.floor(marker.y-0.4*height));
   const roi=explicit?{x:marker.x,y:marker.y,width:marker.x2-marker.x,height}:{x:left,y:top,width:marker.x2-left,height:Math.min(Math.ceil(1.8*height),nodes[0].y2-top)};
   let png,fresh;
   try{
    png=await driver.adb.screenshotBuffer({signal,timeout:Math.max(1,deadline-Date.now())});throwIfAborted(signal);
    fresh=await driver.bridge.dumpUi({signal,retries:0,timeout:Math.max(1,deadline-Date.now())});throwIfAborted(signal);
   }catch(error){if(isAbortError(error)||signal?.aborted){throwIfAborted(signal);throw error;}if(attempt===0&&Date.now()<deadline)continue;return {sex:'unknown',reason:'capture_failed'};}
   const after=context(fresh.nodes,expectedUid,expectedNickname);
   if(!after)return {sex:'unknown',reason:'identity_changed'};
   const markers=explicit?after.icons:after.ages;
   if(markers.length!==1||['x','y','x2','y2','text'].some(k=>markers[0][k]!==marker[k])){nodes=fresh.nodes;continue;}
   const matched=classifyGenderBadge(png,roi),sex=matched.sex==='女'?'female':matched.sex==='男'?'male':'unknown';
   if(sex!=='unknown')return {sex,evidence:{kind:'gender_badge_symbol',sex,confidence:matched.confidence,bounds:roi}};
   nodes=fresh.nodes;
  }
  return {sex:'unknown',reason:'symbol_not_matched'};
 }catch(error){if(isAbortError(error)||signal?.aborted){throwIfAborted(signal);throw error;}return {sex:'unknown',reason:'capture_failed'};}
}
