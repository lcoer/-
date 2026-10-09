const test = require('node:test');
const assert = require('node:assert/strict');
const { createClientManager, pickSerial } = require('../electron/services/client-manager');
test('select online device only, never unauthorized or offline',()=>{
  assert.equal(pickSerial('List of devices attached\nemulator-5554 offline\nemulator-5556 unauthorized\n127.0.0.1:5555 device\n'),'127.0.0.1:5555');
});
test('connection failure never falls back to demo',async()=>{
  const cm=createClientManager({findAdb:()=> 'fixture',exec:async()=>({stdout:'List of devices attached\n'})});
  await assert.rejects(cm.ensureClient(),/EMULATOR_NOT_FOUND/);
  assert.equal(cm.getClientState().mode,'disconnected');
});
test('health probe does not connect, launch or mutate devices',async()=>{
  const commands=[];
  const cm=createClientManager({findAdb:()=> 'fixture',exec:async(p,args)=>{commands.push(args);return {stdout:''};}});
  await cm.getHealth();
  assert.deepEqual(commands,[['devices']]);
});
test('new adb path invalidates old connection and cached readiness',async()=>{
  const paths=[];
  const cm=createClientManager({findAdb:()=> 'first',exec:async(p,args)=>{
    paths.push(p);
    return {stdout:args[0]==='devices'?'emulator-5554 device':args.includes('pm list packages com.sybl.voiceroom')?'package:com.sybl.voiceroom':''};
  }});
  await cm.ensureClient();
  cm.reset('second');await cm.ensureClient();
  assert.equal(cm.getClientState().adbPath,'second');
  assert.equal(paths.at(-1),'second');
});
