import { AdbClient } from './adb-client.mjs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const BRIDGE_PKG = 'com.syl.bridge';
const BRIDGE_SVC = `${BRIDGE_PKG}/com.syl.bridge.SylAccessibilityService`;
const queues = new Map();
function check(signal) { if(signal?.aborted) { const e=new Error('任务已取消'); e.name='AbortError'; throw e; } }
function quote(value) { return "'"+String(value).replace(/'/g,"'\\''")+"'"; }
// cat returns adjacent JSON documents; split only outside quoted strings.
// Text in a dump can itself contain braces, quotes and newlines.
function documents(output) {
  const result=[];let depth=0,start=-1,quoted=false,escaped=false;
  for(let i=0;i<output.length;i++) {
    const ch=output[i];
    if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}
    if(ch==='"'&&depth){quoted=true;continue;}
    if(ch==='{'){if(depth===0)start=i;depth++;}
    else if(ch==='}'&&depth){depth--;if(depth===0){try{result.push(JSON.parse(output.slice(start,i+1)));}catch{return [];}start=-1;}}
  }
  return result;
}
export class BridgeClient {
  constructor(adb) { this.adb=adb||new AdbClient(); this.signal=undefined; }
  setSignal(signal) { this.signal=signal; return this; }
  _signal(options={}) { return options.signal ?? this.signal; }
  async isInstalled(options={}) { const r=await this.adb.sh(`pm list packages ${BRIDGE_PKG}`,{allowFail:true,signal:this._signal(options)}); return r.out.includes(BRIDGE_PKG); }
  async isServiceEnabled(options={}) { const r=await this.adb.sh('dumpsys accessibility',{allowFail:true,signal:this._signal(options)}); return r.out.includes(BRIDGE_SVC) && /Bound services:.*SYL Bridge/s.test(r.out); }
  async enableService(options={}) {
    const signal=this._signal(options); check(signal);
    const r=await this.adb.sh('settings get secure enabled_accessibility_services',{signal});
    const services=r.out.trim()==='null'?[]:r.out.trim().split(':').filter(Boolean);
    if(!services.includes(BRIDGE_SVC)) services.push(BRIDGE_SVC);
    await this.adb.sh(`settings put secure enabled_accessibility_services ${quote(services.join(':'))}`,{signal});
    await this.adb.sh('settings put secure accessibility_enabled 1',{signal});
    await delay(500,undefined,{signal}); return this.isServiceEnabled({signal});
  }
  async install(apkPath,options={}) {
    const signal=this._signal(options); check(signal); const serial=await this.adb.serial({signal});
    const r=await this.adb.adb(['-s',serial,'install','--no-incremental','-r','-t',apkPath],{timeout:90000,allowFail:true,signal});
    if(!/Success/.test(r.out)) throw new Error(`BRIDGE_INSTALL_FAILED: ${(r.err||r.out).slice(0,200)}`); return true;
  }
  async _read(serial,file,signal) {
    check(signal); const r=await this.adb.adb(['-s',serial,'exec-out','run-as',BRIDGE_PKG,'cat',`files/${file}`],{allowFail:true,signal}); check(signal);
    try { return JSON.parse(r.out); } catch { return null; }
  }
  async _queued(operation,signal) {
    check(signal); const serial=await this.adb.serial({signal}); check(signal);
    const key=`${this.adb.cfg?.adbPath||'adb'}:${serial}`; const prior=queues.get(key)||Promise.resolve();
    const next=prior.catch(()=>{}).then(()=>{check(signal);return operation(serial);});
    const tail=next.catch(()=>{}); queues.set(key,tail);
        const cleanup = () => { if(queues.get(key)===tail) queues.delete(key); };
    tail.then(cleanup);
    if (!signal) return next;
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => { try { check(signal); } catch (error) { reject(error); } };
      signal.addEventListener('abort', onAbort, {once:true});
      if(signal.aborted) onAbort();
    });
    try { return await Promise.race([next, aborted]); }
    finally { signal.removeEventListener('abort', onAbort); }
  }
  async _command(cmd,args='',options={}) {
    const signal=this._signal(options);
    return this._queued(async serial=>{
      const requestId=randomUUID(); const resultFile=`result-${requestId}.json`; const dumpFile=`dump-${requestId}.json`;
      check(signal);
      // The receiver publishes atomically before the synchronous broadcast
      // completes. Read its private response in the same device round trip.
      // Broadcast once only: subsequent polling never repeats the action.
      const initial=await this.adb.adb(['-s',serial,'shell',`am broadcast -a com.syl.bridge.CMD -p ${BRIDGE_PKG} --ei protocolVersion 2 --es requestId ${requestId} --es cmd ${cmd} ${args} > /dev/null && run-as ${BRIDGE_PKG} cat files/${resultFile}${cmd==='dump'?' files/'+dumpFile:''}`],{allowFail:true,signal});
      check(signal);
      let inline=documents(initial.out || '');
      const deadline=Date.now()+(options.timeout??6000);
      while(Date.now()<deadline) {
        const result=inline.length?inline[0]:await this._read(serial,resultFile,signal);
        if(result?.requestId===requestId && result.protocolVersion===2 && typeof result.ok==='boolean') {
          if(cmd==='dump' && result.ok && !result.rootNull) {
            const dump=inline.length>1?inline[1]:await this._read(serial,dumpFile,signal);
            if(dump?.requestId!==requestId||dump.protocolVersion!==2||!Array.isArray(dump.nodes)) return {ok:false,error:'BRIDGE_DUMP_MISMATCH'};
            return {...result,nodes:dump.nodes.map(normalizeNode),count:dump.nodes.length,xml:null};
          }
          return result;
        }
        inline=[];
        await delay(Math.min(100,Math.max(1,deadline-Date.now())),undefined,{signal});
      }
      if(cmd==='ping') {
        const legacy=await this._read(serial,'result.json',signal);
        if(legacy && legacy.protocolVersion!==2) throw new Error('BRIDGE_PROTOCOL_MISMATCH: 请安装新版 SYL Bridge APK');
      }
      return {ok:false,error:'BRIDGE_TIMEOUT'};
    },signal);
  }
  async ensureCompatible(options={}) { const result=await this._command('ping','',options); if(!result.ok) throw new Error(`BRIDGE_UNAVAILABLE: ${result.error}`); if(result.connected!==true) throw new Error('BRIDGE_UNAVAILABLE: SERVICE_NOT_CONNECTED'); return result; }
  async ping(options={}) { const result=await this.ensureCompatible(options); return !!result.connected; }
  async dumpUi(options={}) {
    const retries=options.retries??2; for(let i=0;i<=retries;i++) {
      const result=await this._command('dump','',{...options,timeout:options.timeout??8000});
      if(result.ok&&!result.rootNull) return result;
      if(i===retries) throw new Error(`BRIDGE_DUMP_FAILED: ${result.rootNull?'ROOT_NULL':result.error}`);
      await delay(200,undefined,{signal:this._signal(options)});
    }
  }
  tapById(id,options={}) { return this._command('tap',`--es id ${quote(id)}`,{...options,timeout:options.timeout??4000}); }
  tapByCoord(x,y,options={}) { if(!Number.isFinite(x)||!Number.isFinite(y)) throw new Error('BRIDGE_INVALID_COORD'); return this._command('tapxy',`--ei x ${Math.round(x)} --ei y ${Math.round(y)}`,{...options,timeout:options.timeout??4000}); }
  clickText(text,options={}) { return this._command('clicktext',`--es value ${quote(text)}`,{...options,timeout:options.timeout??4000}); }
  setText(id,value,options={}) { return this._command('settextb64',`--es id ${quote(id)} --es value ${quote(Buffer.from(String(value),'utf8').toString('base64'))}`,{...options,timeout:options.timeout??4000}); }
}
function normalizeNode(n) {
  const x = n.x || 0, y = n.y || 0, x2 = n.x2 || 0, y2 = n.y2 || 0;
  const rid = n.resourceId || '';
  return {
    text: n.text || '',
    resourceId: rid,
    shortId: rid.split('/').pop(),
    className: n.className || '',
    packageName: n.packageName || '',
    contentDesc: n.contentDesc || '',
    clickable: !!n.clickable,
    focusable: !!n.focusable,
    enabled: n.enabled !== false,
    checkable: !!n.checkable,
    checked: !!n.checked,
    selected: !!n.selected,
    scrollable: !!n.scrollable,
    editable: !!n.editable,
    bounds: n.bounds || `[${x},${y}][${x2},${y2}]`,
    x, y, x2, y2,
    centerX: Math.round((x + x2) / 2),
    centerY: Math.round((y + y2) / 2),
  };
}

export default BridgeClient;
