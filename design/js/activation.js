(()=>{
 const api=window.api,form=document.getElementById('activationForm'),input=document.getElementById('activationCode'),button=document.getElementById('activateBtn'),error=document.getElementById('activationError'),retry=document.getElementById('retryBtn');
 let pending=false;
 function render(status){
   error.textContent=status.reason||'';
   document.getElementById('expiryInfo').textContent=status.expiresAt?`授权到期：${new Date(status.expiresAt).toLocaleString('zh-CN')}`:'';
 }
 async function run(action){
   if(pending)return;pending=true;button.disabled=true;input.disabled=true;retry.disabled=true;button.textContent='正在校验…';error.textContent='';
   try{const status=await action();if(status.active){input.value='';api.license.openApp().catch(()=>{});}else render(status);}
   catch(_){error.textContent='授权校验失败，请稍后重试。';}
   finally{pending=false;button.disabled=false;input.disabled=false;retry.disabled=false;button.textContent='激活并进入';}
 }
 form.addEventListener('submit',event=>{event.preventDefault();const code=input.value.trim();if(!code){error.textContent='请输入激活码。';return;}run(()=>api.license.activate(code));});
 retry.addEventListener('click',()=>run(()=>api.license.retry()));
 document.getElementById('minimize').addEventListener('click',()=>api.window.minimize());
 document.getElementById('close').addEventListener('click',()=>api.window.close());
 api.license.status().then(render).catch(()=>{error.textContent='无法读取授权状态，请重新打开软件。';});
})();
