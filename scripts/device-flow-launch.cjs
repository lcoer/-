const {spawn}=require('child_process');const path=require('path');
const root=path.resolve(__dirname,'..');const env={...process.env,SYBL_DEVICE_FLOW:'1'};
delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
const child=spawn(require('electron'),[path.join(__dirname,'device-flow.cjs')],{cwd:root,env,stdio:'inherit',windowsHide:true});
child.on('exit',code=>process.exitCode=code??1);child.on('error',e=>{console.error(e);process.exitCode=1;});
