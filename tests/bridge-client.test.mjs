import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeClient } from '../src/bridge-client.mjs';
class FakeAdb {
  constructor() { this.cfg = { serial: 'fake' }; this.requests=[]; this.active=0; this.max=0; }
  async serial() { return 'fake'; }
  async sh(cmd) {
    if (cmd.includes('settings get')) return {out:'other/service'};
    if (!cmd.startsWith('am broadcast')) return {out:''};
    const requestId=cmd.match(/--es requestId ([\w-]+)/)?.[1];
    this.requests.push({requestId,cmd}); this.active++; this.max=Math.max(this.max,this.active);
    await new Promise(r=>setTimeout(r,5)); this.active--;
    return {out:''};
  }
  async adb(args, options) {
    if (args.includes("shell")) return this.sh(args.at(-1));
    this.lastOptions=options;
    const file=args.at(-1); const requestId=file.match(/(?:result|dump)-([\w-]+)\.json/)?.[1];
    if (file==='files/result.json') return {out:JSON.stringify({ok:true,connected:true})};
    return {out:JSON.stringify({protocolVersion:2,requestId,ok:true,connected:true,nodes:[{text:'hello'}]})};
  }
}
test('request scoped result and dump; signal reaches adb',async()=>{
 const adb=new FakeAdb(); const bridge=new BridgeClient(adb); const c=new AbortController();
 const result=await bridge.dumpUi({signal:c.signal,retries:0});
 assert.equal(result.nodes[0].text,'hello'); assert.ok(adb.requests[0].requestId); assert.equal(adb.lastOptions.signal,c.signal);
});
test('clients on same device serialize commands',async()=>{
 const adb=new FakeAdb(); await Promise.all([new BridgeClient(adb).tapById('send'),new BridgeClient(adb).tapByCoord(1,2)]); assert.equal(adb.max,1);
});
test('already cancelled operation does not broadcast',async()=>{
 const adb=new FakeAdb(); const c=new AbortController(); c.abort(); await assert.rejects(new BridgeClient(adb).tapById('send',{signal:c.signal}),{name:'AbortError'}); assert.equal(adb.requests.length,0);
});
test('old apk is reported incompatible',async()=>{
 const adb=new FakeAdb(); adb.adb=async()=>({out:JSON.stringify({ok:true,connected:true})});
 await assert.rejects(new BridgeClient(adb).ensureCompatible({timeout:20}),/BRIDGE_PROTOCOL_MISMATCH/);
});
test('unrelated response is never accepted or retried for click',async()=>{
 const adb=new FakeAdb(); adb.adb=async args=>args.includes("shell")?adb.sh(args.at(-1)):({out:JSON.stringify({protocolVersion:2,requestId:'other',ok:true})});
 const result=await new BridgeClient(adb).tapById('send',{timeout:20}); assert.equal(result.ok,false); assert.equal(adb.requests.length,1);
});
test('enable preserves other services',async()=>{
 const adb=new FakeAdb(); const commands=[]; adb.sh=async cmd=>{commands.push(cmd);return {out:cmd.includes('settings get')?'other/service':''};};
 const bridge=new BridgeClient(adb); bridge.isServiceEnabled=async()=>true; await bridge.enableService(); assert.ok(commands.some(c=>c.includes('other/service:com.syl.bridge')));
});


test('queued cancellation rejects promptly before active command completes', async()=>{
 const adb=new FakeAdb(); let release; adb.sh=async()=>new Promise(r=>{release=r;});
 const first=new BridgeClient(adb).tapById('one'); await new Promise(r=>setTimeout(r,5));
 const c=new AbortController(); const second=new BridgeClient(adb).tapById('two',{signal:c.signal}); await new Promise(r=>setTimeout(r,5)); c.abort();
 await assert.rejects(Promise.race([second,new Promise((_,rej)=>setTimeout(()=>rej(new Error('not prompt')),100))]),{name:'AbortError'});
 release({out:''}); await first;
});
test('compatible but disconnected bridge cannot be marked ready',async()=>{
 const adb=new FakeAdb(); adb.adb=async args=>args.includes('shell')?adb.sh(args.at(-1)):({out:JSON.stringify({protocolVersion:2,requestId:args.at(-1).match(/result-([\w-]+)\.json/)?.[1],ok:true,connected:false})});
 await assert.rejects(new BridgeClient(adb).ensureCompatible(),/SERVICE_NOT_CONNECTED/);
});

test('broadcast returns validated result and dump in one adb subprocess without extra reads',async()=>{
 const adb=new FakeAdb();let calls=0;
 adb.adb=async args=>{calls++;const requestId=args.at(-1).match(/--es requestId ([\w-]+)/)?.[1];
 return {out:JSON.stringify({protocolVersion:2,requestId,ok:true})+JSON.stringify({protocolVersion:2,requestId,nodes:[{text:'brace }{ and quote " inside text'}]})};};
 const r=await new BridgeClient(adb).dumpUi({retries:0});assert.equal(r.nodes[0].text,'brace }{ and quote " inside text');assert.equal(calls,1);
});

test('inline error response is returned without extra reads and never retries mutation',async()=>{
 const adb=new FakeAdb();let calls=0;
 adb.adb=async args=>{calls++;const requestId=args.at(-1).match(/--es requestId ([\w-]+)/)?.[1];return {out:JSON.stringify({protocolVersion:2,requestId,ok:false,error:'NOT_FOUND'})};};
 const r=await new BridgeClient(adb).tapById('send');assert.equal(r.error,'NOT_FOUND');assert.equal(calls,1);
});

test('inline stale response is never accepted and the click is broadcast once',async()=>{
 const adb=new FakeAdb();let broadcasts=0;
 adb.adb=async args=>{if(args.includes('shell'))broadcasts++;return {out:JSON.stringify({protocolVersion:2,requestId:'stale',ok:true})};};
 const r=await new BridgeClient(adb).tapById('send',{timeout:10});assert.equal(r.ok,false);assert.equal(broadcasts,1);
});
