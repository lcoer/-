import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {profileIdentity} from './profile-identity.mjs';
import {readLevelDigits} from './level-digits.cjs';
import {hiddenLevelSides} from './level-hidden.mjs';
import {throwIfAborted,isAbortError} from './async-control.mjs';
const run=promisify(execFile),id=n=>n.shortId||String(n.resourceId||'').split('/').pop();
const normalized=v=>{const s=String(v??'').trim();if(/^[?？]+$/.test(s))return '?';const m=s.match(/^(?:LV\.?\s*)?(\d{1,3})$/i);return m?Number(m[1]):null;};
function identity(nodes,uid,nickname,options={}){
 return profileIdentity(nodes,{expectedUid:uid,expectedNickname:nickname,...options})?.visible||false;
}
/** Parse only words from the two side-by-side level badges, never screen-wide OCR. */
export function levelsFromOcr(words,width,height=Infinity){
 const result={};for(const [field,side] of [['wealthLevel',0],['charmLevel',1]]){
  const candidates=(Array.isArray(words)?words:[]).filter(w=>Number.isFinite(w.x)&&Number.isFinite(w.width)&&Number.isFinite(w.height)&&Number.isFinite(w.y)&&w.x>=0&&w.y>=0&&w.width>0&&w.x+w.width<=width&&w.y+w.height<=height&&w.height>=8&&((w.x+w.width/2<width/2)?0:1)===side).map(w=>normalized(w.text)).filter(v=>v!==null);
  if(candidates.length===1)result[field]=candidates[0];
 }return result;
}
export function profileLevelRegion(nodes,uid,nickname,options={}){
 const visible=identity(nodes,uid,nickname,options);if(!visible)return null;
 const name=nodes.find(n=>id(n)==='tv_nickname'&&visible(n)),ages=nodes.filter(n=>id(n)==='tv_age'&&visible(n));
 const statuses=nodes.filter(n=>id(n)==='tv_online_status'&&visible(n));
 if(ages.length===1&&['iv_chat','iv_back'].every(key=>nodes.some(n=>id(n)===key&&visible(n)))&&nodes.some(n=>['iv_copy','ll_copy'].includes(id(n))&&visible(n))){
  const signs=nodes.filter(n=>id(n)==='tv_sign'&&visible(n));
  if(signs.length===1){
   const root=nodes[0],w=root.x2-root.x,h=ages[0].y2-ages[0].y;
   const top=Math.ceil(ages[0].y2+h*.5),bottom=Math.floor(signs[0].y-h*.4);
   if(bottom-top>=12&&bottom-top<=150*w/1080)return {x:Math.ceil(root.x+w*.055),y:top,width:Math.floor(w*.245),height:bottom-top};
  }
 }
 if(ages.length!==1||statuses.length!==1)return null;
 const root=nodes[0],height=ages[0].y2-ages[0].y;
 const top=Math.max(name.y2+4,Math.floor(statuses[0].y-2.5*height)),bottom=Math.floor(statuses[0].y-.35*height);
 if(bottom-top<12||bottom-top>150)return null;
 const x=Math.ceil(root.x+(root.x2-root.x)*.27),x2=Math.floor(root.x+(root.x2-root.x)*.73);
 return {x,y:top,width:x2-x,height:bottom-top};
}
export async function windowsLevelOcr(png,region,{signal,timeout=3000}={}){
 if(process.platform!=='win32')throw Error('WINDOWS_OCR_UNAVAILABLE');
 throwIfAborted(signal);const directory=await fs.mkdtemp(path.join(os.tmpdir(),'shuangyu-level-'));
 try{
  const input=path.join(directory,'badge.png');await fs.writeFile(input,png);throwIfAborted(signal);
  const script=(await fs.readFile(fileURLToPath(new URL('./level-ocr.ps1',import.meta.url)),'utf8')).replace(/^\uFEFF/,'');
  const quote=v=>"'"+String(v).replace(/'/g,"''")+"'";
  const source=`& {${script}} -InputPath ${quote(input)} -X ${region.x} -Y ${region.y} -Width ${region.width} -Height ${region.height}`;
  const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{windowsHide:true,signal,timeout,maxBuffer:65536,encoding:'utf8'});
  return JSON.parse(stdout.trim()).words||[];
 }finally{await fs.rm(directory,{recursive:true,force:true});}
}
export async function readProfileLevels(driver,nodes,{expectedUid,expectedNiceNumber,expectedNickname,signal,timeout=4500,ocr=windowsLevelOcr}={}){
 throwIfAborted(signal);const deadline=Date.now()+Math.max(1,timeout),remaining=()=>Math.max(1,deadline-Date.now());
 const identityOptions={expectedNiceNumber};
 const visible=identity(nodes,expectedUid,expectedNickname,identityOptions);if(!visible)return {reason:'identity_unverified'};
 // Accessible explicit fields take precedence; age, XP fractions and next-level labels are excluded.
 const result={};for(const [field,keys]of [['wealthLevel',['tv_rich_level','tv_wealth_level']],['charmLevel',['tv_charm_level']]]){
  const matches=nodes.filter(n=>keys.includes(id(n))&&visible(n));if(matches.length===1){const value=normalized(matches[0].text||matches[0].contentDesc);if(value!==null)result[field]=value;}
 }
 if(Object.keys(result).length===2)return result;
 let region=profileLevelRegion(nodes,expectedUid,expectedNickname,identityOptions);if(!region||typeof driver.adb?.screenshotBuffer!=='function')return {...result,reason:'badge_unavailable'};
 try{
  for(let attempt=0;attempt<2&&Date.now()<deadline;attempt++){
  const png=await driver.adb.screenshotBuffer({signal,timeout:remaining()});throwIfAborted(signal);
  const fresh=await driver.bridge.dumpUi({signal,retries:0,timeout:remaining()});throwIfAborted(signal);
  if(!identity(fresh.nodes,expectedUid,expectedNickname,identityOptions))return {reason:'identity_or_layout_changed'};
  const after=profileLevelRegion(fresh.nodes,expectedUid,expectedNickname,identityOptions);
  if(!after)return {reason:'identity_or_layout_changed'};
  if(Object.keys(region).some(k=>region[k]!==after[k])){region=after;continue;}
  const explicitFields=new Set(Object.keys(result)),hidden=hiddenLevelSides(png,region),templateValues=readLevelDigits(png,region).values||{};
  for(const [field,value] of Object.entries(templateValues))if(!explicitFields.has(field))result[field]=value;
  for(const side of hidden){const field=side===0?'wealthLevel':'charmLevel';if(!explicitFields.has(field))result[field]='?';}
  if(!['wealthLevel','charmLevel'].every(field=>result[field]!==undefined)){
   const words=await ocr(png,region,{signal,timeout:remaining()});throwIfAborted(signal);
   for(const [field,value] of Object.entries(levelsFromOcr(words,region.width*3,region.height*3)))if(result[field]===undefined)result[field]=value;
  }
  return {...result,reason:Object.keys(result).length?'read':'symbol_not_read'};
  }
  return {...result,reason:'layout_unstable'};
 }catch(error){if(isAbortError(error)||signal?.aborted){throwIfAborted(signal);throw error;}return {...result,reason:error.code==='ETIMEDOUT'?'ocr_timeout':'capture_failed'};}
}
