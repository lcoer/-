function safeHandle(ipcMain, ctx) {
  return (channel, fn) => ipcMain.handle(channel, async (event, ...args) => {
    const win = ctx.getMainWindow();
    if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame)
      return { ok: false, reason: 'UNTRUSTED_IPC_SENDER' };
    try {
      return await fn(event, ...args);
    }
    catch (e) {
      return { ok: false, reason: e.message };
    }
  });
}
module.exports = { safeHandle };
