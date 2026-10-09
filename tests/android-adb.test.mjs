import test from 'node:test';
import assert from 'node:assert/strict';
import {AdbClient} from '../src/adb-client.mjs';
test('abort of running subprocess preserves AbortError even with allowFail',async()=>{
 const adb=new AdbClient({adbPath:process.execPath});const c=new AbortController();adb.setSignal(c.signal);
 const pending=adb.adb(['-e','setTimeout(()=>{},10000)'],{allowFail:true});setTimeout(()=>c.abort(),30);
 await assert.rejects(pending,{name:'AbortError'});
});
test('explicit device selection never falls back to another emulator',async()=>{
 const adb=new AdbClient({serial:'chosen-device'});const commands=[];
 adb.adb=async args=>{commands.push(args);return {out:'List of devices attached\nemulator-5554\tdevice',ok:true};};
 await assert.rejects(adb.serial(),/EMULATOR_OFFLINE/);
 assert.equal(commands.some(args=>args[0]==='connect'),false);
});
test('online device matching uses the entire serial',async()=>{
 const adb=new AdbClient({serial:'emulator-5554'});
 adb.adb=async()=>({out:'List of devices attached\nemulator-55540\tdevice',ok:true});
 assert.equal(await adb.isOnline('emulator-5554'),false);
});

test('short-lived serial cache avoids devices subprocess before every action and stays pinned',async()=>{
 const adb=new AdbClient({serial:'chosen-device',serialCacheMs:10000});let checks=0;
 adb.adb=async args=>{if(args[0]==='devices')checks++;return {ok:true,out:'List of devices attached\nchosen-device\tdevice\nother-device\tdevice'};};
 assert.equal(await adb.serial(),'chosen-device');assert.equal(await adb.serial(),'chosen-device');await adb.sh('input keyevent 4');
 assert.equal(checks,1);
 const c=new AbortController();c.abort();await assert.rejects(adb.serial({signal:c.signal}),{name:'AbortError'});
});

test('expired serial cache rechecks the chosen device without fallback',async()=>{
 const adb=new AdbClient({serial:'chosen-device',serialCacheMs:0});let checks=0;
 adb.adb=async args=>{if(args[0]==='devices')checks++;return {ok:true,out:'List of devices attached\n'+(checks===1?'chosen-device':'other-device')+'\tdevice'};};
 assert.equal(await adb.serial(),'chosen-device');await assert.rejects(adb.serial(),/EMULATOR_OFFLINE/);
});
