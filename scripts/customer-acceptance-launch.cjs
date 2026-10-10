const {spawn}=require('node:child_process');const path=require('node:path');
const args=process.argv.slice(2),get=name=>args[args.indexOf(name)+1];
if(!args.includes('--target')||!args.includes('--sender')||get('--max-sends')!=='1')throw Error('Usage: node scripts/customer-acceptance-launch.cjs --target UID --sender UID --max-sends 1');
const env={...process.env,SYBL_ACCEPTANCE_TARGET:get('--target'),SYBL_ACCEPTANCE_SENDER:get('--sender')};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
if(args.includes('--collect-only'))env.SYBL_ACCEPTANCE_COLLECT_ONLY='1';
const child=spawn(require('electron'),[path.join(__dirname,'customer-acceptance.cjs')],{cwd:path.resolve(__dirname,'..'),env,stdio:'inherit',windowsHide:true});
child.on('error',error=>{console.error(error);process.exitCode=1;});child.on('exit',code=>process.exitCode=code??1);
