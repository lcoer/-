// electron/services/task-runner.js - 任务运行器
// 职责:管理 私聊 / 自动欢迎 / 自动打call 三个自动化任务的生命周期
//
// 双模式:
//   - 真实模式:连接雷电模拟器 + ADB,用无障碍桥接驱动「双鱼部落」Android 应用
//   - 演示模式:未检测到模拟器/应用时,按同样的节奏与日志流程模拟执行(不真实发送)
// 两种模式共用同一套任务框架、统计与日志,保证演示体验与真实一致。
//
// 【历史变更】原方案用 CDP 接管 Electron 客户端。因「双鱼部落」实为 Android 应用,
//   Android 无 CDP,已改为 ADB + 无障碍桥接方案(src/adb-client.mjs、android-driver.mjs)。

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const appConfig = require('../config');
const dataStore = require('./data-store');
const clientManager = require('./client-manager');

// 傀儡独立 userData 开关
if (appConfig.syblPuppetAppData) {
  process.env.SYBL_PUPPET_APPDATA = appConfig.syblPuppetAppData;
}

// src 模块路径(ESM,用 dynamic import 加载)
const _isPackaged = __dirname.includes('app.asar');
const SRC_DIR = _isPackaged
  ? path.join(__dirname, '..', '..', 'src')
  : path.join(__dirname, '..', '..', 'src');
const modulePath = (name) => pathToFileURL(path.join(SRC_DIR, name)).href;

let driver = null;        // AndroidDriver 实例
let driverInfo = null;    // { mode, adbPath, serial, bridgeReady }
let demoMode = false;

const tasks = {
  private: { running: false, stopFlag: false, stats: { sent: 0, ok: 0, fail: 0 }, loop: null },
  welcome: { running: false, stopFlag: false, stats: { clicked: 0, skipped: 0 }, pollTimer: null, handle: null },
  call: { running: false, stopFlag: false, stats: { sent: 0 }, loop: null, handle: null },
};

let logCallback = null;
let statusCallback = null;
function setLogCallback(fn) { logCallback = fn; }
function setStatusCallback(fn) { statusCallback = fn; }

function log(task, level, msg) {
  const time = new Date().toLocaleTimeString('zh-CN');
  console.log(`[${time}][${task}][${level}] ${msg}`);
  if (logCallback) logCallback({ task, level, msg, time: Date.now() });
}

function emitStatus() {
  if (statusCallback) statusCallback(getStatus());
}

// ===== Android 驱动初始化(懒加载,三任务共用) =====
async function ensureDriver() {
  if (driver) return driver;
  if (demoMode) return null;

  const info = await clientManager.ensureClient({
    onLog: (level, msg) => log('system', level, msg),
  });

  if (info.demo || info.mode === 'demo') {
    demoMode = true;
    log('system', 'info', '演示模式:未检测到雷电模拟器或双鱼部落,任务将以模拟方式运行');
    return null;
  }

  driverInfo = info;
  const { AndroidDriver } = await import(modulePath('android-driver.mjs'));
  driver = new AndroidDriver({
    adbOpts: { adbPath: info.adbPath, serial: info.serial },
    onLog: (level, msg) => log('system', level, msg),
  });

  log('system', 'info', '正在检查模拟器与无障碍服务...');
  await driver.ensureReady();
  log('system', 'ok', `真实模式就绪(设备 ${info.serial}${info.bridgeReady ? ',无障碍桥接可用' : ''})`);
  return driver;
}

// 判断当前是否演示模式
function shouldDemo() {
  return demoMode || !clientManager.getClientState().serial;
}

// ===== 私聊任务 =====
function validatePrivateConfig(config) {
  if (tasks.private.running) return { ok: false, reason: 'ALREADY_RUNNING' };
  const targets = config.targets || config.targetIds || [];
  if (!targets.length) return { ok: false, reason: 'NO_TARGETS' };
  // Android 端需要昵称才能定位会话(纯 uid 只能靠房间公屏反查)
  const noNick = targets.filter(t => typeof t !== 'object' || !t.nickname);
  if (noNick.length === targets.length) {
    return { ok: false, reason: 'NEED_NICKNAME: 真实模式下需要在目标列表中提供昵称(Android 端无法仅凭 uid 定位会话)' };
  }
  return null;
}

function pickContent(config, generateMessage) {
  if (config.mode === 'select' && config.contents?.[config.selectedIndex] != null) {
    return config.contents[config.selectedIndex];
  }
  if (config.contents && config.contents.length > 0) {
    return config.contents[Math.floor(Math.random() * config.contents.length)];
  }
  return generateMessage();
}

// 说明:原 CDP 时代的 sendTargetChain(文字→图片→语音链)已废弃。
// Android 端目前仅支持"文字"发送(图片/语音待后续版本),逻辑见 sendByNickname()。

// 演示模式的单目标模拟发送
async function demoSendTarget(cfg, uid, idx, total) {
  log('private', 'info', `[${idx + 1}/${total}] ${uid} → 正在发送`);
  const content = cfg.mode === 'mediaonly' ? '' : pickDemoContent(cfg);
  if (content) {
    await sleep(400 + Math.random() * 600);
    log('private', 'info', `  └ 发送结果: code=0, 服务端UID=DEMO-${Date.now()}`);
    log('private', 'ok', `  文字发送成功`);
  }
  if (cfg.image?.enable) {
    await sleep(cfg.mediaGapMinMs + Math.random() * cfg.mediaGapRangeMs);
    log('private', 'ok', `  图片发送已确认`);
  }
  if (cfg.voice?.enable) {
    await sleep(cfg.mediaGapMinMs + Math.random() * cfg.mediaGapRangeMs);
    log('private', 'ok', `  语音发送已确认`);
  }
  return true;
}

function pickDemoContent(cfg) {
  if (cfg.mode === 'select' && cfg.contents?.[cfg.selectedIndex] != null) return cfg.contents[cfg.selectedIndex];
  if (cfg.contents && cfg.contents.length) return cfg.contents[Math.floor(Math.random() * cfg.contents.length)];
  return '你好呀~';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ===== 真实模式:向单个目标发私聊(Android 实现) =====
// 说明:Android 侧不支持"按 uid 直接发送"。需要 uid → 昵称 的映射
//       (来自目标列表里的昵称,或房间公屏上的 uid↔昵称对应)。
async function sendTargetAndroid(cfg, drv, target) {
  // target 可能是 uid 字符串,也可能是 { uid, nickname }
  const nickname = typeof target === 'object' ? target.nickname : null;
  const uid = typeof target === 'object' ? target.uid : target;

  if (!nickname) {
    // 尝试通过房间公屏反查(需在房间内)
    try {
      const found = await drv.resolveUidToNickname(uid);
      if (found) {
        log('private', 'info', `  └ uid ${uid} 反查到昵称: ${found}`);
        return await sendByNickname(cfg, drv, found, uid);
      }
    } catch (e) { /* 不在房间,忽略 */ }
    log('private', 'fail', `  └ uid ${uid} 缺少昵称映射,无法在 Android 端发送`);
    return { ok: false, reason: 'NO_NICKNAME_MAPPING' };
  }
  return await sendByNickname(cfg, drv, nickname, uid);
}

async function sendByNickname(cfg, drv, nickname, uid) {
  const content = cfg.mode === 'mediaonly' ? '' : pickContent(cfg, () => '');
  let allOk = true;

  if (content) {
    if (cfg.image?.enable || cfg.voice?.enable) {
      // 有媒体:先发文字建立会话,再逐条补发(媒体仍走原 CDP 逻辑不适用,
      // Android 端图片/语音发送暂未支持,此处仅发文字并提示)
      log('private', 'warn', '  └ Android 端暂不支持图片/语音发送,仅发送文字');
    }
    const r = await drv.sendPrivateMessage(nickname, content, { onLog: (l, m) => log('private', l, `  └ ${m}`) });
    if (r.ok) log('private', 'ok', `  文字发送成功`);
    else { allOk = false; log('private', 'fail', `  文字发送失败(未确认)`); }
  }
  return { ok: allOk, nickname, uid };
}

async function runPrivateLoop(cfg) {
  try {
    const demo = shouldDemo();
    if (demo) {
      demoMode = true;
    } else {
      await ensureDriver();
    }

    // 目标列表:支持纯 uid 数组,或 { uid, nickname } 数组
    const rawTargets = cfg.targets || cfg.targetIds || [];
    const blacklist = new Set((cfg.blacklist || []).map(String));
    const machineCode = dataStore.getMachineCode();

    log('private', 'info', `${demo ? '[演示模式] ' : ''}私聊任务启动,目标 ${rawTargets.length} 个,黑名单 ${blacklist.size} 个`);

    let consecutiveFail = 0;
    for (let i = 0; i < rawTargets.length; i++) {
      if (tasks.private.stopFlag) { log('private', 'info', '私聊任务已停止'); break; }
      const t = rawTargets[i];
      const uid = String(typeof t === 'object' ? t.uid : t);

      if (blacklist.has(uid)) { log('private', 'skip', `[${i + 1}/${rawTargets.length}] ${uid} 在黑名单,跳过`); continue; }
      if (cfg.noDuplicate && dataStore.isSentToday(machineCode, uid)) {
        log('private', 'skip', `[${i + 1}/${rawTargets.length}] ${uid} 今日已发送,跳过`); continue;
      }

      log('private', 'info', `[${i + 1}/${rawTargets.length}] 正在处理 ${uid}`);
      let ok = false;
      if (demo) {
        ok = await demoSendTarget(cfg, uid, i, rawTargets.length);
      } else {
        const r = await sendTargetAndroid(cfg, driver, t).catch(e => ({ ok: false, reason: e.message }));
        ok = r.ok;
        if (!ok) {
          consecutiveFail++;
          if (consecutiveFail >= 5) { log('private', 'fail', '连续 5 个目标失败,任务中止'); tasks.private.stopFlag = true; break; }
        } else consecutiveFail = 0;
      }

      tasks.private.stats.sent++;
      if (ok) {
        tasks.private.stats.ok++;
        dataStore.markSent(machineCode, uid);
        dataStore.recordSend(machineCode, 'private');
        log('private', 'ok', `${uid} 发送成功`);
        if (cfg.sendLimit > 0 && tasks.private.stats.ok >= cfg.sendLimit) {
          log('private', 'info', `已达发送上限 ${cfg.sendLimit},自动停止`);
          tasks.private.stopFlag = true;
          break;
        }
      } else {
        tasks.private.stats.fail++;
        log('private', 'fail', `${uid} 发送失败`);
      }
      emitStatus();

      if (i < rawTargets.length - 1 && !tasks.private.stopFlag) {
        const delayMs = cfg.delayMin * 1000 + Math.floor(Math.random() * ((cfg.delayMax - cfg.delayMin) * 1000));
        const realDelay = demo ? Math.min(delayMs, 2500) : delayMs;
        log('private', 'info', `等待 ${Math.round(realDelay / 1000)} 秒...`);
        await sleep(realDelay);
      }
    }
    log('private', 'info', `私聊任务结束,发送 ${tasks.private.stats.sent},成功 ${tasks.private.stats.ok},失败 ${tasks.private.stats.fail}`);
  } catch (e) {
    log('private', 'fail', '私聊任务异常: ' + e.message);
  } finally {
    tasks.private.running = false;
    tasks.private.loop = null;
    log('private', 'ended', '私聊任务已结束');
    emitStatus();
  }
}

// 说明:原 CDP 时代的 loadPrivateModules / syncAndPreResolve(uid→rongCloudId 预解析)已废弃。
// Android 端不需要预解析,直接按昵称在消息列表中定位会话。

async function startPrivate(config) {
  const invalid = validatePrivateConfig(config);
  if (invalid) return invalid;

  tasks.private.running = true;
  tasks.private.stopFlag = false;
  tasks.private.stats = { sent: 0, ok: 0, fail: 0 };
  emitStatus();

  const cfg = {
    ...config,
    mediaGapMinMs: appConfig.taskRunner.mediaGapMinMs,
    mediaGapRangeMs: appConfig.taskRunner.mediaGapRangeMs,
  };
  tasks.private.loop = runPrivateLoop(cfg);
  return { ok: true };
}

function stopPrivate() {
  if (!tasks.private.running) return { ok: false, reason: 'NOT_RUNNING' };
  tasks.private.stopFlag = true;
  log('private', 'info', '正在停止私聊任务...');
  return { ok: true };
}

// ===== 自动欢迎任务 =====
async function startWelcome() {
  if (tasks.welcome.running) return { ok: false, reason: 'ALREADY_RUNNING' };
  tasks.welcome.running = true;
  tasks.welcome.stopFlag = false;
  tasks.welcome.stats = { clicked: 0, skipped: 0 };
  emitStatus();

  if (shouldDemo()) {
    demoMode = true;
    log('welcome', 'info', '[演示模式] 自动欢迎已启动,监听房间新用户');
    tasks.welcome.pollTimer = setInterval(() => {
      if (tasks.welcome.stopFlag) return;
      // 模拟随机进入的新用户
      if (Math.random() < 0.6) {
        tasks.welcome.stats.clicked++;
        log('welcome', 'ok', `已点击欢迎(第 ${tasks.welcome.stats.clicked} 次)`);
      } else {
        tasks.welcome.stats.skipped++;
      }
      emitStatus();
    }, 3500);
    return { ok: true };
  }

  try {
    await ensureDriver();
    const handle = await driver.startAutoWelcome({
      intervalMs: appConfig.taskRunner.welcomePollIntervalMs,
      onEvent: (ev) => {
        if (ev.ok) {
          tasks.welcome.stats.clicked++;
          log('welcome', 'ok', `已欢迎: ${ev.key} (第 ${tasks.welcome.stats.clicked} 次)`);
        } else {
          tasks.welcome.stats.skipped++;
        }
        emitStatus();
      },
    });
    tasks.welcome.handle = handle;
    log('welcome', 'info', '自动欢迎已启动,监听房间新用户');
    // 状态同步
    tasks.welcome.pollTimer = setInterval(() => {
      if (tasks.welcome.stopFlag) return;
      const st = handle.getStatus();
      tasks.welcome.stats.clicked = st.clickedCount || 0;
      tasks.welcome.stats.skipped = st.skippedCount || 0;
      emitStatus();
    }, appConfig.taskRunner.welcomePollIntervalMs);
    return { ok: true };
  } catch (e) {
    tasks.welcome.running = false;
    log('welcome', 'fail', '启动失败: ' + e.message);
    return { ok: false, reason: e.message };
  }
}

async function stopWelcomeInternal() {
  if (tasks.welcome.handle) {
    try {
      const r = tasks.welcome.handle.stop();
      log('welcome', 'info', `自动欢迎已停止,点击 ${r.clickedCount},跳过 ${r.skippedCount}`);
    } catch (e) { log('welcome', 'fail', '停止失败: ' + e.message); }
    tasks.welcome.handle = null;
  }
  if (tasks.welcome.pollTimer) { clearInterval(tasks.welcome.pollTimer); tasks.welcome.pollTimer = null; }
  tasks.welcome.running = false;
  tasks.welcome.stopFlag = true;
  log('welcome', 'ended', '自动欢迎任务已结束');
  emitStatus();
}

async function stopWelcome() {
  if (!tasks.welcome.running) return { ok: false, reason: 'NOT_RUNNING' };
  await stopWelcomeInternal();
  return { ok: true };
}

// ===== 自动打call任务 =====
async function startCall(config) {
  if (tasks.call.running) return { ok: false, reason: 'ALREADY_RUNNING' };
  tasks.call.running = true;
  tasks.call.stopFlag = false;
  tasks.call.stats = { sent: 0 };
  emitStatus();

  tasks.call.loop = (async () => {
    try {
      const demo = shouldDemo();
      if (demo) demoMode = true;
      else await ensureDriver();
      const emoji = config.emoji || '打call';
      const dMin = (config.delayMin || 3) * 1000;
      const dMax = (config.delayMax || 5) * 1000;
      log('call', 'info', `${demo ? '[演示模式] ' : ''}自动打call启动,表情: ${emoji}`);

      while (!tasks.call.stopFlag) {
        if (demo) {
          log('call', 'ok', `已发送 ${emoji} (第 ${++tasks.call.stats.sent} 次)`);
        } else {
          const ok = await driver._sendCallOnce(emoji);
          if (ok) { tasks.call.stats.sent++; log('call', 'ok', `已发送 ${emoji} (第 ${tasks.call.stats.sent} 次)`); }
          else log('call', 'fail', `发送失败(未找到${emoji}入口)`);
        }
        emitStatus();
        if (tasks.call.stopFlag) break;
        const delayMs = dMin + Math.floor(Math.random() * (dMax - dMin));
        const realDelay = demo ? Math.min(delayMs, 3000) : delayMs;
        log('call', 'info', `等待 ${Math.round(realDelay / 1000)} 秒...`);
        await sleep(realDelay);
      }
      log('call', 'info', `打call任务已停止,共发送 ${tasks.call.stats.sent} 次`);
    } catch (e) {
      log('call', 'fail', '打call任务异常: ' + e.message);
    } finally {
      tasks.call.running = false;
      tasks.call.loop = null;
      log('call', 'ended', '打call任务已结束');
      emitStatus();
    }
  })();

  return { ok: true };
}

function stopCall() {
  if (!tasks.call.running) return { ok: false, reason: 'NOT_RUNNING' };
  tasks.call.stopFlag = true;
  log('call', 'info', '正在停止打call任务...');
  return { ok: true };
}

// ===== 统一接口 =====
async function start(name, config) {
  switch (name) {
    case 'private': return startPrivate(config);
    case 'welcome': return await startWelcome();
    case 'call': return await startCall(config);
    default: return { ok: false, reason: 'UNKNOWN_TASK' };
  }
}

async function stop(name) {
  switch (name) {
    case 'private': return stopPrivate();
    case 'welcome': return await stopWelcome();
    case 'call': return stopCall();
    default: return { ok: false, reason: 'UNKNOWN_TASK' };
  }
}

async function stopAll() {
  for (const n of ['private', 'welcome', 'call']) {
    try { await stop(n); } catch {}
  }
}

function getStatus() {
  const machineCode = dataStore.getMachineCode();
  const result = {};
  for (const name of ['private', 'welcome', 'call']) {
    const stats = { ...tasks[name].stats };
    if (name === 'private') {
      const counts = dataStore.getCounts(machineCode, 'private');
      stats.today = counts.today; stats.week = counts.week; stats.month = counts.month;
    }
    result[name] = { running: tasks[name].running, stats };
  }
  const cs = clientManager.getClientState();
  result.demoMode = demoMode || shouldDemo();
  result.mode = cs.mode;                 // 'android' | 'demo'
  result.serial = cs.serial || null;
  result.bridgeReady = !!cs.bridgeReady;
  result.adbPath = cs.adbPath || null;
  return result;
}

// 供 IPC 主动查询/重连模拟器
async function refreshDriver() {
  driver = null;
  driverInfo = null;
  demoMode = false;
  return await ensureDriver().then(() => getStatus()).catch(e => ({ error: e.message }));
}

// ===== 昵称解析:把纯 uid 列表补全为 {uid, nickname} =====
// 真实模式下 Android 会话列表只显示昵称,无法凭 uid 定位。
// 本函数遍历模拟器里的会话(含陌生人分组),逐个进主页读取 uid↔昵称 映射,
// 再用该映射回填用户提供的 uid 列表。
async function resolveNicknames(uids = []) {
  const wanted = new Set(uids.map(u => String(u).trim()).filter(Boolean));
  // 解析会大量操作模拟器界面,若此时有任务在跑会互相打架
  const anyRunning = Object.values(tasks).some(t => t.running);
  if (anyRunning) {
    return { ok: false, reason: 'BUSY: 有任务正在运行,请先停止所有任务再解析昵称' };
  }
  try {
    const drv = await ensureDriver();
    if (!drv) return { ok: false, reason: 'DEMO_MODE: 演示模式下无法解析昵称(请先连接模拟器)' };

    log('system', 'info', `开始解析昵称,需要匹配 ${wanted.size} 个 ID...`);
    const { pairs, map } = await drv.harvestConversationUids({
      onLog: (level, msg) => log('system', level, msg),
    });

    const matched = pairs.filter(p => wanted.has(String(p.uid)));
    const unmatched = [...wanted].filter(u => !map[u]);
    log('system', 'ok', `解析完成:共读到 ${pairs.length} 个用户,命中 ${matched.length} 个`);

    return {
      ok: true,
      pairs,                       // 全部读到的 {uid, nickname}
      matched,                     // 命中用户 uid 列表的部分
      unmatched,                   // 未匹配到的 uid
      map,                         // { uid: nickname }
    };
  } catch (e) {
    log('system', 'fail', `解析昵称失败: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

module.exports = { start, stop, stopAll, getStatus, setLogCallback, setStatusCallback, refreshDriver, resolveNicknames };
