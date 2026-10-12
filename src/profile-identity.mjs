import {isOperationRoomCard} from './room-card.mjs';
const id=n=>n.shortId||String(n.resourceId||'').split('/').pop();
const value=n=>String(n?.text||'').trim();
function rect(n){
 if(!n)return null;
 const p=String(n.bounds||'').match(/-?\d+/g)?.map(Number);
 const [x,y,x2,y2]=p?.length===4?p:[n.x,n.y,n.x2,n.y2];
 return [x,y,x2,y2].every(Number.isFinite)&&x>=0&&y>=0&&x2>x&&y2>y?{x,y,x2,y2}:null;
}
const code=text=>{const s=String(text||'').trim();return /^(?:\d{1,32}|\(\d{1,32}\)|ID\s*[:：]\s*\d{1,32})$/i.test(s)?s.replace(/^ID\s*[:：]\s*/i,'').replace(/[()]/g,''):null;};
// A public nice-number binds only this observed card's attributes. It is not a
// verified UID and cannot authorize sending or assigning a user.
export function profileIdentity(nodes,{expectedUid,expectedNiceNumber,expectedNickname}={}){
 if(!Array.isArray(nodes)||nodes[0]?.packageName!=='com.sybl.voiceroom'||nodes.some(n=>n.packageName&&n.packageName!=='com.sybl.voiceroom'))return null;
 const viewport=rect(nodes[0]);if(!viewport)return null;
 const visible=n=>{const r=rect(n);return r&&n.enabled!==false&&r.x>=viewport.x&&r.y>=viewport.y&&r.x2<=viewport.x2&&r.y2<=viewport.y2;};
 const names=nodes.filter(n=>id(n)==='tv_nickname'&&visible(n));
 if(typeof expectedNickname!=='string'||!expectedNickname.trim()||names.length!==1||value(names[0])!==expectedNickname.trim())return null;
 const codes=nodes.filter(n=>id(n)==='tv_user_code'&&visible(n));
 if(expectedUid!=null){
  if(expectedNiceNumber!=null||typeof expectedUid!=='string'||!/^\d{1,32}$/.test(expectedUid)||codes.length!==1||code(value(codes[0]))!==expectedUid)return null;
  return {visible,kind:'uid',value:expectedUid,nickname:value(names[0])};
 }
 if(typeof expectedNiceNumber!=='string'||!/^\d{1,32}$/.test(expectedNiceNumber)||codes.some(n=>value(n)))return null;
 const nice=nodes.filter(n=>id(n)==='tv_nice_num'&&visible(n));
 if(nice.length!==1||value(nice[0])!==expectedNiceNumber||!isOperationRoomCard(nodes.filter(visible)))return null;
 return {visible,kind:'nice_number',value:expectedNiceNumber,nickname:value(names[0])};
}
