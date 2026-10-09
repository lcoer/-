// electron/ipc/window-ipc.js - 窗口控制 IPC
// 无边框窗口的自定义标题栏(最小化/最大化/关闭/状态查询)

const { ipcMain } = require('electron');
const { safeHandle } = require('./safe-handle');

function registerWindowIpc(ctx) {
  const handle = safeHandle(ipcMain,ctx);
  handle('window:minimize', () => {
    ctx.getMainWindow()?.minimize();
    return { ok: true };
  });

  handle('window:maximize', () => {
    const win = ctx.getMainWindow();
    if (!win) return { ok: false };
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
    return { ok: true, isMaximized: win.isMaximized() };
  });

  handle('window:close', () => {
    ctx.getMainWindow()?.close();
    return { ok: true };
  });

  handle('window:isMaximized', () => {
    return ctx.getMainWindow()?.isMaximized() ?? false;
  });
}

module.exports = { registerWindowIpc };
