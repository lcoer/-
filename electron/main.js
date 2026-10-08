// electron/main.js - Electron 主进程入口
// 职责:
//   1. 主窗口创建与事件接线(无边框暗色窗口 / 自定义标题栏)
//   2. 应用生命周期聚合(启动内置静态服务 → 创建窗口 → 挂 IPC)
//   3. IPC 控制层挂载(窗口 / 数据 / 任务 三域)

// ===== 启动日志(诊断用)=====
// 把主进程的关键节点写到 APPDATA 下的 main.log,便于无人值守排查
// "窗口一闪就没" 这类问题(无 GPU / 单实例锁被占 / 端口占用 / RUN_AS_NODE 等)。
(function initEarlyLog() {
  try {
    const os = require('os');
    const p = require('path');
    const f = require('fs');
    const dir = p.join(process.env.APPDATA || os.tmpdir(), 'shuangyu-assistant');
    f.mkdirSync(dir, { recursive: true });
    const logFile = p.join(dir, 'main.log');
    if (f.existsSync(logFile) && f.statSync(logFile).size > 512 * 1024) f.writeFileSync(logFile, '');
    const write = (tag, msg) => {
      const line = `[${new Date().toISOString()}] [${tag}] ${msg}\n`;
      try { f.appendFileSync(logFile, line); } catch (_) {}
      try { console.log(line.trim()); } catch (_) {}
    };
    write('boot', `启动 electron=${process.versions.electron} node=${process.versions.node} pid=${process.pid}`);
    write('boot', `RUN_AS_NODE=${JSON.stringify(process.env.ELECTRON_RUN_AS_NODE)} argv=${JSON.stringify(process.argv.slice(1))}`);
    process.on('uncaughtException', (e) => write('fatal', 'uncaughtException ' + ((e && e.stack) || e)));
    process.on('unhandledRejection', (e) => write('fatal', 'unhandledRejection ' + ((e && e.stack) || e)));
    global.__sylog = write;
  } catch (_) { /* 日志失败不影响主流程 */ }
})();

// ===== 启动参数加固 =====
// 部分环境(远程桌面 / 虚拟机 / 无 GPU 会话 / 服务会话)下 GPU 上下文创建失败
// (Failed to create GLES3 context / kFatalFailure),导致渲染进程崩溃、窗口秒退。
const electron = require('electron');
const { app, BrowserWindow, Menu, globalShortcut, ipcMain, dialog } = electron;

// 若被误以 Node 模式启动(ELECTRON_RUN_AS_NODE 非空),app 会是 undefined,
// 直接给出可读报错并退出,避免"一闪而过"的静默失败。
if (!app) {
  if (global.__sylog) global.__sylog('fatal', 'app 不可用:疑似 ELECTRON_RUN_AS_NODE 被置位,请清空该环境变量后再启动');
  else console.error('[fatal] app 不可用:疑似 ELECTRON_RUN_AS_NODE 被置位');
  process.exit(1);
}
if (global.__sylog) global.__sylog('boot', `app 已加载,adding switches`);
app.on('will-quit', () => global.__sylog && global.__sylog('boot', 'will-quit'));
app.on('quit', (_e, code) => global.__sylog && global.__sylog('boot', `quit code=${code}`));

// GPU 与渲染:全面禁用硬件加速,走软件光栅
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-gpu-rasterization');
app.commandLine.appendSwitch('disable-accelerated-2d-canvas');
app.commandLine.appendSwitch('disable-accelerated-video-decode');
app.commandLine.appendSwitch('disable-features', 'Vulkan,UseSkiaRenderer,UseChromeOSDirectVideoDecoder,CanvasOopRasterization');
app.commandLine.appendSwitch('use-gl', 'disabled');
app.commandLine.appendSwitch('use-angle', 'disabled');
// 稳定性:沙箱与共享内存
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('disable-setuid-sandbox');
// 缓存:无 GPU / 受限权限环境下,磁盘缓存与 GPU 缓存会报
// "Unable to move the cache / Unable to create cache"(0x5 拒绝访问),
// 且多实例会争抢缓存目录。直接禁用磁盘缓存,消除这类噪音报错。
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disk-cache-size', '1');

// 单实例锁:避免多开导致缓存目录争抢
const gotTheLock = app.requestSingleInstanceLock();
if (global.__sylog) global.__sylog('lock', `requestSingleInstanceLock -> ${gotTheLock}`);
if (!gotTheLock) {
  if (global.__sylog) global.__sylog('lock', '已有实例在运行,退出本进程');
  app.quit();
  process.exit(0);
}

const path = require('path');
const http = require('http');
const fs = require('fs');
const appConfig = require('./config');

// 服务层
const taskRunner = require('./services/task-runner');
const dataStore = require('./services/data-store');

// 控制层(IPC 注册器)
const { registerWindowIpc } = require('./ipc/window-ipc');
const { registerDataIpc } = require('./ipc/data-ipc');
const { registerTaskIpc } = require('./ipc/task-ipc');
const { registerSystemIpc } = require('./ipc/system-ipc');

// 内置静态文件服务(提供 design/ 下的 UI 文件;用本地 HTTP 而非 file:// 避免 ES 模块 CORS 限制)
const STATIC_PORT = 39110;
function startStaticServer() {
  const designDir = path.join(__dirname, '..', 'design');
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      // 防目录穿越
      const filePath = path.join(designDir, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
      if (!filePath.startsWith(designDir)) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, { 'Content-Type': mime[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.on('error', () => resolve(STATIC_PORT)); // 端口占用则复用
    server.listen(STATIC_PORT, '127.0.0.1', () => resolve(STATIC_PORT));
  });
}

const IS_DEV = process.env.NODE_ENV === 'development';
let mainWindow = null;

async function createWindow(port) {
  const LOG = (t, m) => global.__sylog && global.__sylog(t, m);
  LOG('win', '开始创建 BrowserWindow');
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    title: '双鱼部落写作业机器人',
    icon: path.join(__dirname, 'logo.png'),
    backgroundColor: '#0f1117',
    frame: false,               // 无边框窗口(自定义标题栏)
    titleBarStyle: 'hidden',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: IS_DEV,
    },
  });
  LOG('win', 'BrowserWindow 已构造');

  Menu.setApplicationMenu(null);

  // 关键:必须在 loadURL 之前注册,否则 ready-to-show 可能在加载期间触发而被漏掉,
  // 导致 show() 永不调用 → 窗口永久不可见(表现为"启动后什么也没出现")。
  let shown = false;
  const doShow = (why) => {
    if (shown) return;
    shown = true;
    LOG('win', `show() 触发来源=${why}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      // 无边框窗口在部分环境下首帧可能是透明的,强制重绘一次
      try { mainWindow.setBounds(mainWindow.getBounds()); } catch (_) {}
    }
  };
  mainWindow.once('ready-to-show', () => doShow('ready-to-show'));
  mainWindow.webContents.on('did-finish-load', () => {
    LOG('win', 'did-finish-load');
    setTimeout(() => doShow('did-finish-load+300ms'), 300);
  });
  // 终极兜底:无论加载成功与否,4 秒后一定把窗口显示出来
  setTimeout(() => doShow('timeout-4s'), 4000);

  // 窗口最大化状态变化 → 通知渲染进程(标题栏按钮图标切换)
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximizeChange', true));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximizeChange', false));

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    LOG('win', `页面加载失败 code=${code} desc=${desc} url=${url}`);
  });

  // ===== 崩溃守护 =====
  // 渲染进程崩溃(常见于 GPU 上下文失败)→ 自动重载页面,而不是让窗口消失
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    LOG('win', `渲染进程退出 reason=${details.reason} exitCode=${details.exitCode}`);
    if (details.reason !== 'clean-exit' && mainWindow && !mainWindow.isDestroyed()) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(`http://127.0.0.1:${port}/index.html`).catch(() => {});
        }
      }, 800);
    }
  });
  // 子进程(GPU / 网络服务)异常 → 仅记录,不退出主进程
  mainWindow.webContents.on('child-process-gone', (_e, details) => {
    LOG('win', `子进程退出 type=${details.type} reason=${details.reason}`);
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  if (IS_DEV) {
    globalShortcut.register('F12', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.toggleDevTools();
    });
  }

  // 最后再发起加载:不 await 阻塞,加载失败也不会影响窗口显示(有 timeout 兜底)
  LOG('win', '开始 loadURL');
  mainWindow.loadURL(`http://127.0.0.1:${port}/index.html`)
    .then(() => LOG('win', 'loadURL resolve'))
    .catch((e) => LOG('win', 'loadURL reject ' + ((e && e.message) || e)));
}

// ========== IPC 控制层挂载 ==========
const ipcContext = { getMainWindow: () => mainWindow };

// ========== App 生命周期 ==========
app.whenReady().then(async () => {
  const LOG = (t, m) => global.__sylog && global.__sylog(t, m);
  try {
    LOG('boot', 'app ready');
    const port = await startStaticServer();
    LOG('boot', `静态服务端口=${port}`);

    // 初始化数据存储与应用元信息
    LOG('boot', 'dataStore.init ...');
    dataStore.init();
    LOG('boot', 'dataStore.init 完成');

    registerWindowIpc(ipcContext);
    registerDataIpc(ipcContext);
    registerTaskIpc(ipcContext);
    registerSystemIpc(ipcContext);
    LOG('boot', 'IPC 注册完成');

    // 任务日志 → 渲染进程
    taskRunner.setLogCallback((entry) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('task:log', entry);
      }
    });
    // 任务状态变化推送
    taskRunner.setStatusCallback((status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('task:status', status);
      }
    });
    LOG('boot', '任务回调挂载完成,准备创建窗口');

    await createWindow(port);
    LOG('boot', 'createWindow 完成');

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
    });
  } catch (e) {
    LOG('fatal', 'whenReady 内异常 ' + ((e && e.stack) || e));
  }
});

// 重复启动:聚焦已有窗口,而不是再开一个实例
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('before-quit', () => {
  taskRunner.stopAll().catch(() => {});
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
