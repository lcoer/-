// electron/preload.js - 预加载脚本
// 通过 contextBridge 暴露安全的 API 给渲染进程(不直接接触 Node API)

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ===== 应用/系统信息 + 模拟器连接(真实模式) =====
  system: {
    // 获取运行环境信息
    // { emulatorConnected, serial, adbPath, bridgeReady, appInstalled, demoMode, version, platform, demoForced }
    getInfo: () => ipcRenderer.invoke('system:getInfo'),
    // 连接模拟器(真实模式入口)→ { ok, serial, adbPath, bridgeReady, mode } | { ok:false, reason }
    connectEmulator: () => ipcRenderer.invoke('system:connectEmulator'),
    // 一键安装并启用无障碍桥接 APK → { ok, bridgeReady }
    installBridge: () => ipcRenderer.invoke('system:installBridge'),
    // 手动指定模拟器 adb.exe 路径 → 持久化 + 重新连接
    pickAdb: () => ipcRenderer.invoke('system:pickAdb'),
    // 重新检测模拟器 → { connected, serial, adbPath, appInstalled, bridgeReady }
    redetect: () => ipcRenderer.invoke('system:redetect'),
    // 向后兼容:旧的打开客户端接口(内部已改为模拟器连接)
    openClient: () => ipcRenderer.invoke('system:openClient'),
    // 选择本地文件(图片/语音),返回 { canceled, path, name, dataUrl }
    pickFile: (type) => ipcRenderer.invoke('system:pickFile', type),
    // 在文件管理器中显示文件
    showInFolder: (p) => ipcRenderer.invoke('system:showInFolder', p),
  },

  // ===== 数据面板 =====
  portal: {
    // 获取可用日期 → { ok, dates:[...], today }
    getDates: () => ipcRenderer.invoke('portal:getDates'),
    // 获取统计卡片数据 → { ok, data:{ femaleCount, maleCount, todayTotal, updatedAt } }
    getStats: (date) => ipcRenderer.invoke('portal:getStats', date),
    // 获取采集记录(分页) → { ok, records, page, pages, total }
    getRecords: (date, sex, page, size) => ipcRenderer.invoke('portal:getRecords', date, sex, page, size),
    // 获取整点汇总(按小时聚合的 ID 列表) → { ok, hourly:[...] }
    getSummary: (date) => ipcRenderer.invoke('portal:getSummary', date),
    // 连接状态 → { connected, source, realCount, lastCollectAt, lastCollectRoom, collectError, ... }
    getStatus: () => ipcRenderer.invoke('portal:getStatus'),
    // 清除虚拟(演示)数据:all=false 只清演示数据,all=true 全部清空
    clearDemo: (all) => ipcRenderer.invoke('portal:clearDemo', !!all),
    // 实时事件订阅(SSE 风格) callback(ev), ev={type:'record'|'batch'|'stats'|'source'|'collect-status', payload}
    onStream: (cb) => {
      const handler = (_e, ev) => cb(ev);
      ipcRenderer.on('portal:stream', handler);
      return () => ipcRenderer.removeListener('portal:stream', handler);
    },
  },

  // ===== 房间实时数据采集(真实数据源) =====
  collect: {
    // 启动采集 → { ok, intervalMs } | { ok:false, reason }
    start: (opts) => ipcRenderer.invoke('collect:start', opts || {}),
    // 停止采集 → { ok, rounds }
    stop: () => ipcRenderer.invoke('collect:stop'),
    // 状态 → { ok, running, rounds, intervalMs, room, source }
    status: () => ipcRenderer.invoke('collect:status'),
  },

  // ===== 任务控制(私聊/欢迎/打call) =====
  task: {
    // 启动任务 name:'private'|'welcome'|'call'
    start: (name, config) => ipcRenderer.invoke('task:start', name, config),
    stop: (name) => ipcRenderer.invoke('task:stop', name),
    // 查询所有任务状态 → { private:{running,stats}, welcome:..., call:... }
    getStatus: () => ipcRenderer.invoke('task:status'),
    // 把纯 uid 列表解析为 {uid, nickname}(真实模式必需)
    // → { ok, pairs:[{uid,nickname}], matched:[...], unmatched:[...], map:{uid:nickname} }
    resolveNicknames: (uids) => ipcRenderer.invoke('task:resolveNicknames', uids),
    // 日志回调 callback(log), log={ task, level, msg, time }
    onLog: (cb) => {
      const handler = (_e, log) => cb(log);
      ipcRenderer.on('task:log', handler);
      return () => ipcRenderer.removeListener('task:log', handler);
    },
    // 状态变化回调 callback(status)
    onStatus: (cb) => {
      const handler = (_e, st) => cb(st);
      ipcRenderer.on('task:status', handler);
      return () => ipcRenderer.removeListener('task:status', handler);
    },
  },

  // ===== 配置持久化(规则设定/文案/黑名单) =====
  config: {
    get: (key) => ipcRenderer.invoke('config:get', key),
    set: (key, value) => ipcRenderer.invoke('config:set', key, value),
    all: () => ipcRenderer.invoke('config:all'),
  },

  // ===== 窗口控制(无边框标题栏按钮) =====
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onMaximizeChange: (cb) => {
      const handler = (_e, v) => cb(v);
      ipcRenderer.on('window:maximizeChange', handler);
      return () => ipcRenderer.removeListener('window:maximizeChange', handler);
    },
  },
});
