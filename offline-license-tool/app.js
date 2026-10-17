'use strict';
(() => {
  const $=id=>document.getElementById(id);let codes=[],busy=false;
  const base64url=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  async function importPrivate(pem){
    if(!/^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----\s*$/.test(pem.trim()))throw new Error('请选择 PKCS8 格式的 Ed25519 私钥 PEM 文件。');
    const text=pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,'');
    const bytes=Uint8Array.from(atob(text),x=>x.charCodeAt(0));
    return crypto.subtle.importKey('pkcs8',bytes,{name:'Ed25519'},false,['sign']);
  }
  $('generate').addEventListener('click',async()=>{
    if(busy)return;busy=true;$('generate').disabled=true;codes=[];$('output').value='';$('download').disabled=true;
    try{
      if(!crypto.subtle)throw new Error('浏览器不支持本地 WebCrypto，请使用新版 Edge/Chrome 或命令行工具。');
      const days=Number($('days').value),count=Number($('count').value);
      if(!Number.isInteger(days)||days<1||days>3650)throw new Error('有效天数应为 1–3650 的整数。');
      if(!Number.isInteger(count)||count<1||count>100)throw new Error('数量应为 1–100 的整数。');
      const file=$('key').files[0];if(!file)throw new Error('请先选择管理员私钥。');if(file.size>16384)throw new Error('私钥文件过大。');
      const key=await importPrivate(await file.text());
      for(let i=0;i<count;i++){
        const bytes=new TextEncoder().encode(JSON.stringify({version:1,productId:'shuangyu-assistant',id:crypto.randomUUID(),durationDays:days,issuedAt:Date.now()}));
        const signature=await crypto.subtle.sign({name:'Ed25519'},key,bytes);codes.push(`SYBL1.${base64url(bytes)}.${base64url(new Uint8Array(signature))}`);
      }
      $('output').value=codes.join('\n');$('download').disabled=false;$('status').textContent=`已生成 ${count} 个激活码，每个激活后 ${days} 天有效。`;
    }catch(e){codes=[];$('output').value='';$('status').textContent=e.message.includes('Ed25519')||e.message.includes('私钥')||e.message.includes('整数')||e.message.includes('浏览器')?e.message:'生成失败，请检查私钥格式及浏览器是否支持 Ed25519。';}
    finally{busy=false;$('generate').disabled=false;}
  });
  $('download').addEventListener('click',()=>{if(!codes.length)return;const url=URL.createObjectURL(new Blob([codes.join('\n')+'\n'],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='codes.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  $('clear').addEventListener('click',()=>{if(busy)return;codes=[];$('key').value='';$('output').value='';$('download').disabled=true;$('status').textContent='私钥选择及生成结果已清空。';});
  window.addEventListener('pagehide',()=>{codes=[];$('key').value='';$('output').value='';});
})();
