function safeHandle(ipcMain, ctx) {
  return (channel, fn) => ipcMain.handle(channel, async (event, ...args) => {
    const win = ctx.getMainWindow();
    if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame)
      return { ok: false, reason: 'UNTRUSTED_IPC_SENDER' };
    try {
      if(!channel.startsWith('window:')&&!channel.startsWith('license:')&&channel!=='task:stop'&&channel!=='collect:stop')await ctx.authorize?.(channel);
      return await fn(event, ...args);
    }
    catch (e) {
      return { ok: false, reason: e.message };
    }
  });
}
module.exports = { safeHandle };
