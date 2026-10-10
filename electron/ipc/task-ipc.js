// electron/ipc/task-ipc.js - 任务控制 IPC
// 私聊任务的启停与状态查询

const { ipcMain } = require('electron');
const taskRunner = require('../services/task-runner');
const dataStore = require('../services/data-store');
const { safeHandle } = require('./safe-handle');

function registerTaskIpc(ctx) {
  const handle = safeHandle(ipcMain,ctx);
  handle('task:start', async (_e, name, config) => {
    return await taskRunner.start(name, config || {});
  });

  handle('task:stop', async (_e, name) => {
    return await taskRunner.stop(name);
  });

  handle('task:status', () => taskRunner.getStatus());
  handle('task:pending', () => ({ ok: true, results: dataStore.getPendingResults() }));
  handle('task:resolvePending', async (_e, request) => taskRunner.withDeviceOperation('reviewPending', async () => {
    // Historical records retain their original sender scope, including the
    // legacy scope. Resolving them must not reassign them to the active account.
    const record = dataStore.resolvePending(request || {});
    return { ok: true, outcome: record.outcome };
  }));

  // 把纯 uid 列表解析为 {uid, nickname}(真实模式必须带昵称才能发送)
  handle('task:resolveNicknames', async (_e, uids) => {
    return await taskRunner.resolveNicknames(Array.isArray(uids) ? uids : []);
  });

  // ===== 房间实时数据采集(真实数据源) =====
  handle('collect:start', async (_e, opts) => taskRunner.startCollect(opts || {}));
  handle('collect:stop', async () => taskRunner.stopCollect());
  handle('collect:status', () => taskRunner.getCollectStatus());
}
module.exports = { registerTaskIpc };
