const test=require('node:test');
const assert=require('node:assert/strict');
const { safeHandle }=require('../electron/ipc/safe-handle');
test('IPC only accepts the main window and its main frame',async()=>{
  const handlers=new Map(),webContents={mainFrame:{}};
  const handle=safeHandle({handle:(n,fn)=>handlers.set(n,fn)},{getMainWindow:()=>({isDestroyed:()=>false,webContents})});
  handle('test',async(_e,x)=>({ok:true,x}));
  assert.equal((await handlers.get('test')({sender:{},senderFrame:{}},1)).reason,'UNTRUSTED_IPC_SENDER');
  assert.equal((await handlers.get('test')({sender:webContents,senderFrame:{}},1)).ok,false);
  assert.deepEqual(await handlers.get('test')({sender:webContents,senderFrame:webContents.mainFrame},1),{ok:true,x:1});
});
test('IPC exceptions become visible structured failure',async()=>{
  let handler;const webContents={mainFrame:{}};
  safeHandle({handle:(_n,fn)=>{handler=fn;}},{getMainWindow:()=>({isDestroyed:()=>false,webContents})})('save',()=>{throw Error('DISK_FULL');});
  assert.deepEqual(await handler({sender:webContents,senderFrame:webContents.mainFrame}),{ok:false,reason:'DISK_FULL'});
});
