// electron/ipc/task-ipc.js - 任务控制 IPC
// 私聊 / 自动欢迎 / 自动打call 三任务的启停与状态查询

const { ipcMain } = require('electron');
const taskRunner = require('../services/task-runner');

function registerTaskIpc(ctx) {
  ipcMain.handle('task:start', async (_e, name, config) => {
    return await taskRunner.start(name, config || {});
  });

  ipcMain.handle('task:stop', async (_e, name) => {
    return await taskRunner.stop(name);
  });

  ipcMain.handle('task:status', () => taskRunner.getStatus());

  // 把纯 uid 列表解析为 {uid, nickname}(真实模式必须带昵称才能发送)
  ipcMain.handle('task:resolveNicknames', async (_e, uids) => {
    return await taskRunner.resolveNicknames(Array.isArray(uids) ? uids : []);
  });

  // ===== 房间实时数据采集(真实数据源) =====
  ipcMain.handle('collect:start', async (_e, opts) => taskRunner.startCollect(opts || {}));
  ipcMain.handle('collect:stop', async () => taskRunner.stopCollect());
  ipcMain.handle('collect:status', () => taskRunner.getCollectStatus());
}
module.exports = { registerTaskIpc };
