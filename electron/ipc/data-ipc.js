// electron/ipc/data-ipc.js - 数据面板 IPC
// 实时贵宾位数据(演示模式:本地模拟采集流;接入正式数据源时替换 data-store 实现即可)

const { ipcMain } = require('electron');
const dataStore = require('../services/data-store');
const { safeHandle } = require('./safe-handle');

function registerDataIpc(ctx) {
  const handle = safeHandle(ipcMain,ctx);
  handle('portal:getDates', () => ({ ok: true, ...dataStore.getDates() }));
  handle('portal:getStats', (_e, date) => ({ ok: true, data: dataStore.getStats(date) }));
  handle('portal:getRecords', (_e, date, sex, page, size, keyword) =>
    ({ ok: true, ...dataStore.getRecords(date, sex, page, size, keyword) }));
  handle('portal:getSummary', (_e, date) => ({ ok: true, hourly: dataStore.getSummary(date) }));
  handle('portal:getStatus', () => ({ ok: true, ...dataStore.getStatus() }));

  // 清除虚拟(演示)数据:all=false 只清演示,all=true 全清
  handle('portal:clearDemo', (_e, all) => {
    const r = dataStore.clearDemoRecords(!!all);
    return { ok: true, ...r };
  });

  // 数据流事件 → 渲染进程
  dataStore.setStreamCallback((ev) => {
    const win = ctx.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('portal:stream', ev);
  });
}

module.exports = { registerDataIpc };
