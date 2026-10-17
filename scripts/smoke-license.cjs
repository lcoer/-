const {app,BrowserWindow,safeStorage}=require('electron');
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const out=path.resolve('tmp/license-smoke'),root=process.env.SYBL_SMOKE_APP_ROOT||path.resolve(__dirname,'..');
fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'user-data'));app.disableHardwareAcceleration();app.commandLine.appendSwitch('no-sandbox');
app.whenReady().then(async()=>{
 const load=file=>require(path.join(root,file));
 const manager=load('electron/services/client-manager.js');manager.getHealth=async()=>({mode:'disconnected'});manager.ensureClient=async()=>{throw Error('TEST_DEVICE_DISABLED');};
 const store=load('electron/services/data-store.js'),runner=load('electron/services/task-runner.js');
 const {server,port}=await load('electron/services/static-server.js').startStaticServer({port:0});
 const keys=crypto.generateKeyPairSync('ed25519'),config={publicKey:keys.publicKey.export({format:'pem',type:'spki'})};
 const {createOfflineLicense}=load('electron/services/offline-license.cjs');
 const directory=path.join(out,'credentials-'+crypto.randomUUID());
 const options={config,dataDir:directory,encrypt:b=>safeStorage.encryptString(b.toString('utf8')),decrypt:b=>safeStorage.decryptString(b)};
 const license=createOfflineLicense(options);await license.initialize();
 const win=new BrowserWindow({width:1360,height:860,show:false,webPreferences:{preload:path.join(root,'electron/preload.js'),contextIsolation:true,nodeIntegration:false,offscreen:true}});
 const ctx={getMainWindow:()=>win,license,authorize:()=>license.assertActive(),isAuthorized:()=>license.getStatus().active,openBusiness:()=>{store.init();return win.loadURL(`http://127.0.0.1:${port}/index.html`);}};
 for(const [file,method]of [['window-ipc','registerWindowIpc'],['data-ipc','registerDataIpc'],['task-ipc','registerTaskIpc'],['system-ipc','registerSystemIpc'],['license-ipc','registerLicenseIpc']])load('electron/ipc/'+file+'.js')[method](ctx);
 runner.setAuthorizationGuard(()=>license.assertActive());
 let restored;
 try{
  await win.loadURL(`http://127.0.0.1:${port}/activation.html`);
  const blocked=await win.webContents.executeJavaScript("window.api.collect.start({})");if(blocked.ok)throw Error('Unlicensed collection allowed');
  await win.webContents.executeJavaScript("document.getElementById('activationCode').value='invalid';document.getElementById('activationForm').requestSubmit()");
  let text='';for(let i=0;i<50;i++){text=await win.webContents.executeJavaScript("document.getElementById('activationError').textContent");if(text.includes('格式'))break;await new Promise(r=>setTimeout(r,30));}if(!text.includes('格式'))throw Error('Invalid code prompt missing');
  fs.writeFileSync(path.join(out,'activation.png'),(await win.webContents.capturePage()).toPNG());
  const payload=Buffer.from(JSON.stringify({version:1,productId:'shuangyu-assistant',id:crypto.randomUUID(),durationDays:7,issuedAt:Date.now()}));
  const code='SYBL1.'+payload.toString('base64url')+'.'+crypto.sign(null,payload,keys.privateKey).toString('base64url');
  const loaded=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
  await win.webContents.executeJavaScript(`document.getElementById('activationCode').value=${JSON.stringify(code)};document.getElementById('activationForm').requestSubmit()`);
  await Promise.race([loaded,new Promise((_,reject)=>setTimeout(()=>reject(Error('Activation navigation timeout')),10000))]);
  await win.webContents.executeJavaScript('window.__appReady');if(!license.getStatus().active)throw Error('Valid code not active');
  const sevenDays=license.getStatus().expiresAt-Date.now();if(sevenDays<7*86400000-20000||sevenDays>7*86400000)throw Error('Wrong activation duration');
  const raw=fs.readFileSync(path.join(directory,'credential-v1.bin'));if(raw.includes(Buffer.from(payload.toString('utf8'))))throw Error('Plaintext credential stored');
  const repeat=await license.activate(code);if(!repeat.reason.includes('已使用'))throw Error('Used code accepted');license.close();
  restored=createOfflineLicense(options);if(!(await restored.initialize()).active)throw Error('Restart lost authorization');
  const result={ok:true,checks:{loginPage:true,invalidCodePrompt:true,unlicensedCollectionBlocked:true,validCodeEntersBusiness:true,defaultSevenDays:true,dpapiEncrypted:true,usedCodeRejected:true,restartRestoresAuthorization:true}};
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log('LICENSE SMOKE PASSED',JSON.stringify(result.checks));
 }catch(error){console.error('LICENSE SMOKE FAILED',error.message);process.exitCode=1;}
 finally{license.close();restored?.close();runner.setAuthorizationGuard(undefined);await runner.stopAll();store.shutdown();win.destroy();server.closeAllConnections?.();server.close();app.exit(process.exitCode||0);}
}).catch(e=>{console.error('LICENSE SMOKE FAILED',e.message);app.exit(1);});
