'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
function generate({privateKey,durationDays=7,count=1,clock=Date.now}={}) {
  if(!Number.isInteger(durationDays)||durationDays<1||durationDays>3650)throw new Error('有效天数应为 1–3650 的整数');
  if(!Number.isInteger(count)||count<1||count>100)throw new Error('数量应为 1–100 的整数');
  const key=crypto.createPrivateKey(privateKey);if(key.asymmetricKeyType!=='ed25519')throw new Error('需要 Ed25519 私钥');
  return Array.from({length:count},()=>{const bytes=Buffer.from(JSON.stringify({version:1,productId:'shuangyu-assistant',id:crypto.randomUUID(),durationDays,issuedAt:clock()}),'utf8');return `SYBL1.${bytes.toString('base64url')}.${crypto.sign(null,bytes,key).toString('base64url')}`;});
}
if(require.main===module){try{
  const opts={privateKeyPath:path.join(__dirname,'private/private-key.pem'),durationDays:7,count:1,output:null};
  const args=process.argv.slice(2);const names={'--key':'privateKeyPath','--days':'durationDays','--count':'count','--out':'output'};
  for(let i=0;i<args.length;i++){const name=names[args[i]];if(!name||!args[i+1])throw new Error('用法：node generate.cjs [--key 私钥路径] [--days 7] [--count 1] [--out codes.txt]');opts[name]=['durationDays','count'].includes(name)?Number(args[++i]):args[++i];}
  const codes=generate({...opts,privateKey:fs.readFileSync(opts.privateKeyPath,'utf8')});
  if(opts.output){fs.writeFileSync(opts.output,codes.join('\n')+'\n',{flag:'wx',mode:0o600});console.log(path.resolve(opts.output));}else console.log(codes.join('\n'));
}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={generate};
