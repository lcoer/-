'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
function setup({privateDir=path.join(__dirname,'private'),configPath=path.join(__dirname,'../electron/license-config.json')}={}) {
  const priv=path.join(privateDir,'private-key.pem'),pub=path.join(privateDir,'public-key.pem');
  let privateKey;
  if(fs.existsSync(priv))privateKey=crypto.createPrivateKey(fs.readFileSync(priv));
  else {
    if(fs.existsSync(pub))throw new Error('公钥已存在但私钥丢失；请恢复原私钥，不会覆盖已有密钥。');
    if(fs.existsSync(configPath)&&JSON.parse(fs.readFileSync(configPath,'utf8')).publicKey)throw new Error('客户端公钥已存在；请恢复与它匹配的原私钥，不会替换公钥。');
    fs.mkdirSync(privateDir,{recursive:true,mode:0o700});privateKey=crypto.generateKeyPairSync('ed25519').privateKey;
    fs.writeFileSync(priv,privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});
  }
  if(privateKey.asymmetricKeyType!=='ed25519')throw new Error('需要 Ed25519 私钥');
  const publicKey=crypto.createPublicKey(privateKey).export({type:'spki',format:'pem'});
  if(fs.existsSync(pub)&&fs.readFileSync(pub,'utf8')!==publicKey)throw new Error('已有公钥与私钥不匹配，拒绝覆盖。');
  if(!fs.existsSync(pub))fs.writeFileSync(pub,publicKey,{flag:'wx',mode:0o600});
  const existing=fs.existsSync(configPath)?JSON.parse(fs.readFileSync(configPath,'utf8')):{};
  if(existing.publicKey&&existing.publicKey!==publicKey)throw new Error('客户端公钥不匹配，拒绝覆盖。');
  fs.mkdirSync(path.dirname(configPath),{recursive:true});
  fs.writeFileSync(configPath,JSON.stringify({publicKey},null,2)+'\n');
  return {privateKeyPath:priv,publicKeyPath:pub,configPath};
}
if(require.main===module){try{const paths=setup();for(const value of Object.values(paths))console.log(value);}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={setup};
