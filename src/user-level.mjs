import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {readLevelDigits} from './level-digits.cjs';
import {hiddenLevelSides} from './level-hidden.mjs';
import {throwIfAborted,isAbortError} from './async-control.mjs';
const run=promisify(execFile),id=n=>n.shortId||String(n.resourceId||'').split('/').pop();
const normalized=v=>{const s=String(v??'').trim();if(/^[?？]+$/.test(s))return '?';const m=s.match(/^(?:LV\.?\s*)?(\d{1,3})$/i);return m?Number(m[1]):null;};
function identity(nodes,uid,nickname){
 const root=nodes?.[0];if(root?.packageName!=='com.sybl.voiceroom'||nodes.some(n=>n.packageName&&n.packageName!==root.packageName))return false;
 const visible=n=>n.enabled!==false&&[n.x,n.y,n.x2,n.y2].every(Number.isFinite)&&n.x>=root.x&&n.y>=root.y&&n.x2<=root.x2&&n.y2<=root.y2&&n.x2>n.x&&n.y2>n.y;
 const names=nodes.filter(n=>id(n)==='tv_nickname'&&visible(n)),codes=nodes.filter(n=>id(n)==='tv_user_code'&&visible(n));
 return names.length===1&&codes.length===1&&names[0].text===nickname&&String(codes[0].text).replace(/^ID\s*[:：]?\s*/i,'').replace(/[()]/g,'')===String(uid)?visible:false;
}
/** Parse only words from the two side-by-side level badges, never screen-wide OCR. */
export function levelsFromOcr(words,width,height=Infinity){
 const result={};for(const [field,side] of [['wealthLevel',0],['charmLevel',1]]){
  const candidates=(Array.isArray(words)?words:[]).filter(w=>Number.isFinite(w.x)&&Number.isFinite(w.width)&&Number.isFinite(w.height)&&Number.isFinite(w.y)&&w.x>=0&&w.y>=0&&w.width>0&&w.x+w.width<=width&&w.y+w.height<=height&&w.height>=8&&((w.x+w.width/2<width/2)?0:1)===side).map(w=>normalized(w.text)).filter(v=>v!==null);
  if(candidates.length===1)result[field]=candidates[0];
 }return result;
}
export function profileLevelRegion(nodes,uid,nickname){
 const visible=identity(nodes,uid,nickname);if(!visible)return null;
 const name=nodes.find(n=>id(n)==='tv_nickname'&&visible(n)),ages=nodes.filter(n=>id(n)==='tv_age'&&visible(n));
 const statuses=nodes.filter(n=>id(n)==='tv_online_status'&&visible(n));
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
export async function readProfileLevels(driver,nodes,{expectedUid,expectedNickname,signal,timeout=4500,ocr=windowsLevelOcr}={}){
 throwIfAborted(signal);const deadline=Date.now()+Math.max(1,timeout),remaining=()=>Math.max(1,deadline-Date.now());
 const visible=identity(nodes,expectedUid,expectedNickname);if(!visible)return {reason:'identity_unverified'};
 // Accessible explicit fields take precedence; age, XP fractions and next-level labels are excluded.
 const result={};for(const [field,keys]of [['wealthLevel',['tv_rich_level','tv_wealth_level']],['charmLevel',['tv_charm_level']]]){
  const matches=nodes.filter(n=>keys.includes(id(n))&&visible(n));if(matches.length===1){const value=normalized(matches[0].text||matches[0].contentDesc);if(value!==null)result[field]=value;}
 }
 if(Object.keys(result).length===2)return result;
 const region=profileLevelRegion(nodes,expectedUid,expectedNickname);if(!region||typeof driver.adb?.screenshotBuffer!=='function')return {...result,reason:'badge_unavailable'};
 try{
  const png=await driver.adb.screenshotBuffer({signal,timeout:remaining()});throwIfAborted(signal);
  const fresh=await driver.bridge.dumpUi({signal,retries:0,timeout:remaining()});throwIfAborted(signal);
  const after=profileLevelRegion(fresh.nodes,expectedUid,expectedNickname);
  if(!after||Object.keys(region).some(k=>region[k]!==after[k]))return {reason:'identity_or_layout_changed'};
  const explicitFields=new Set(Object.keys(result)),hidden=hiddenLevelSides(png,region),templateValues=readLevelDigits(png,region).values||{};
  for(const [field,value] of Object.entries(templateValues))if(!explicitFields.has(field))result[field]=value;
  for(const side of hidden){const field=side===0?'wealthLevel':'charmLevel';if(!explicitFields.has(field))result[field]='?';}
  if(!['wealthLevel','charmLevel'].every(field=>result[field]!==undefined)){
   const words=await ocr(png,region,{signal,timeout:remaining()});throwIfAborted(signal);
   for(const [field,value] of Object.entries(levelsFromOcr(words,region.width*3,region.height*3)))if(result[field]===undefined)result[field]=value;
  }
  return {...result,reason:Object.keys(result).length?'read':'symbol_not_read'};
 }catch(error){if(isAbortError(error)||signal?.aborted){throwIfAborted(signal);throw error;}return {...result,reason:error.code==='ETIMEDOUT'?'ocr_timeout':'capture_failed'};}
}
