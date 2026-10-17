const {spawn}=require('child_process');const path=require('path');
const root=path.resolve(__dirname,'..'),env={...process.env,APPDATA:path.join(root,'tmp','license-smoke')};
delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
if(process.argv.includes('--packaged'))env.SYBL_SMOKE_APP_ROOT=path.join(root,'dist','win-unpacked','resources','app.asar');
const child=spawn(require('electron'),[path.join(root,'scripts','smoke-license.cjs')],{cwd:root,env,stdio:'inherit',windowsHide:true});
const timer=setTimeout(()=>{child.kill();process.exitCode=1;},30000);
child.on('error',error=>{clearTimeout(timer);console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{clearTimeout(timer);process.exitCode=code??1;});
