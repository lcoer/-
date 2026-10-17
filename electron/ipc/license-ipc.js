const {safeHandle}=require('./safe-handle');
function registerLicenseIpc(ctx){
 const handle=safeHandle(require('electron').ipcMain,ctx);
 handle('license:status',()=>ctx.license.getStatus());
 handle('license:activate',(_e,code)=>ctx.license.activate(code));
 handle('license:retry',()=>ctx.license.retry());
 handle('license:openApp',async()=>{ctx.license.assertActive();await ctx.openBusiness();return {ok:true};});
}
module.exports={registerLicenseIpc};
