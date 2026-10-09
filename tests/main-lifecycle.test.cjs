const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const tick=()=>new Promise(r=>setImmediate(r));
function load({boot=false,stop=async()=>{}}={}){
  const handlers=new Map(),calls=[];
  const app={commandLine:{appendSwitch(){}},disableHardwareAcceleration(){},requestSingleInstanceLock:()=>true,on:(n,fn)=>handlers.set(n,fn),whenReady:()=>boot?Promise.resolve():new Promise(()=>{}),quit:()=>calls.push('quit'),exit:c=>calls.push(`exit:${c}`),getPath:()=>'/fixture'};
  const electron={app,BrowserWindow:{getAllWindows:()=>[]},Menu:{},globalShortcut:{unregisterAll(){}},dialog:{showErrorBox:()=>calls.push('errorDialog')}};
  const store={init:()=>{throw Error('DATA_CORRUPT');},shutdown:()=>calls.push('storeShutdown')};
  const server={close:()=>calls.push('serverClosed'),closeAllConnections:()=>calls.push('connectionsClosed')};
  const mocks={electron,'./services/task-runner':{stopAll:stop},'./services/data-store':store,'./config':{},'./services/static-server':{startStaticServer:async()=>({server,port:1})},fs:{mkdirSync(){},existsSync:()=>false,appendFileSync(){}},'./ipc/window-ipc':{},'./ipc/task-ipc':{},'./ipc/data-ipc':{},'./ipc/system-ipc':{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../electron/main.js'),'utf8'),{
    require:n=>Object.hasOwn(mocks,n)?mocks[n]:require(n),__dirname:path.join(__dirname,'../electron'),
    process:{env:{},versions:{},pid:1,argv:[],on(){},platform:'win32',exit:()=>{}},global:{},console:{log(){},error(){}},setTimeout,
  });
  return {handlers,calls};
}
test('corrupt journal startup displays error, closes service and exits',async()=>{
  const {calls}=load({boot:true});await tick();
  assert.ok(calls.includes('errorDialog'));assert.ok(calls.includes('serverClosed'));assert.ok(calls.includes('exit:1'));
});
test('before-quit waits for task shutdown before releasing resources',async()=>{
  let finish;const {handlers,calls}=load({stop:()=>new Promise(r=>{finish=r;})});
  let prevented=false;handlers.get('before-quit')({preventDefault:()=>{prevented=true;}});
  assert.equal(prevented,true);assert.equal(calls.includes('quit'),false);
  finish();await tick();
  assert.ok(calls.includes('storeShutdown'));assert.ok(calls.includes('quit'));
  prevented=false;handlers.get('before-quit')({preventDefault:()=>{prevented=true;}});assert.equal(prevented,false);
});
