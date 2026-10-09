// Every operation owns the device until its run has completely stopped.
const path = require('path');
const { pathToFileURL } = require('url');
const { randomUUID } = require('crypto');
const { DeviceSession } = require('./device-session');
const appConfig = require('../config');
const { isDefinitiveSendRejection } = require('../../src/send-proof.cjs');
const modulePath = name => pathToFileURL(path.join(__dirname, '..', '..', 'src', name)).href;
const modules = Promise.all(['task-policy.mjs', 'task-result.mjs'].map(n => import(modulePath(n))));
function cancelled(signal) {
  if (signal?.aborted) {
    const e = Error('任务已取消');
    e.name = 'AbortError';
    throw e;
  }
}
function sleep(ms, signal) {
  cancelled(signal);
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      const e = Error('任务已取消');
      e.name = 'AbortError';
      reject(e);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted)
      abort();
  });
}
function untilAbort(signal) {
  if (signal.aborted)
    return Promise.resolve();
  return new Promise(r => signal.addEventListener('abort', r, { once: true }));
}
function createTaskRunner(deps = {}) {
  const dataStore = deps.dataStore || require('./data-store');
  const clientManager = deps.clientManager || require('./client-manager');
  const createDriver = deps.createDriver || (async (info) => {
    const { AndroidDriver } = await import(modulePath('android-driver.mjs'));
    return new AndroidDriver({ adbOpts: { adbPath: info.adbPath, serial: info.serial }, onLog: (l, m) => log('system', l, m) });
  });
  const createCollector = deps.createCollector || (async (drv, opts) => {
    const { RoomCollector } = await import(modulePath('room-collector.mjs'));
    return new RoomCollector(drv, opts);
  });
  const session = new DeviceSession(), tasks = new Map();
  let logCallback = null, statusCallback = null, collector = null, collectorRunId = null, statusRevision = 0;
  const emptyStats = () => ({
    sent: 0, ok: 0, fail: 0, unconfirmed: 0, cancelled: 0, skipped: 0, simulated: 0, clicked: 0
  });
  for (const name of ['private', 'welcome', 'call', 'collect', 'resolve'])
    tasks.set(name, { name, state: 'stopped', running: false, stats: emptyStats(), mode: 'android' });
  function log(task, level, msg) {
    try {
      logCallback?.({ task, level, msg, time: Date.now() });
    }
    catch (e) {
      console.error('日志订阅错误:', e.message);
    }
    if (!deps.silent)
      console.log(`[${task}][${level}] ${msg}`);
  }
  function emitStatus() {
    statusRevision++;
    try {
      statusCallback?.(getStatus());
    }
    catch (e) {
      console.error('状态订阅错误:', e.message);
    }
  }
  function getStatus() {
    const result = {statusRevision};
    for (const [name, t] of tasks) {
      const stats = { ...t.stats };
      if (name === 'private') {
        Object.assign(stats, dataStore.getCounts(dataStore.getMachineCode(), 'private'));
        stats.pending = dataStore.getPendingResults ? dataStore.getPendingResults().length : stats.unconfirmed;
      }
      if (name === 'collect' && collector && collectorRunId === t.runId)
        Object.assign(stats, collector.getStatus());
      result[name] = {
        running: t.running, state: t.state, runId: t.runId || null, mode: t.mode, stats, error: t.error || null
      };
    }
    const cs = clientManager.getClientState();
    result.deviceOwner = session.getStatus();
    result.mode = result.deviceOwner ? tasks.get(result.deviceOwner.owner)?.mode || cs.mode : cs.mode;
    result.demoMode = result.mode === 'demo';
    result.serial = cs.serial || null;
    result.bridgeReady = !!cs.bridgeReady;
    result.adbPath = cs.adbPath || null;
    return result;
  }
  function finish(t, error) {
    if (tasks.get(t.name) !== t)
      return;
    t.running = false;
    t.state = error && error.name !== 'AbortError' ? 'failed' : 'stopped';
    t.error = t.state === 'failed' ? error.message : null;
    session.release(t.name, t.runId);
    log(t.name, 'ended', t.error ? `任务失败: ${t.error}` : '任务已结束');
    emitStatus();
  }
  async function readyDriver(t) {
    // The chosen serial stays fixed for the run; readiness checks never send messages.
    const signal = t.controller.signal, info = await clientManager.ensureClient({ signal, onLog: (l, m) => log('system', l, m) });
    cancelled(signal);
    if (!info || info.mode !== 'android' || !info.serial)
      throw Error('REAL_MODE_REQUIRED: 请连接模拟器');
    const drv = await createDriver(info);
    cancelled(signal);
    drv.setSignal?.(signal);
    await drv.ensureReady();
    if (drv.bridge?.ensureCompatible) {
      const handshake = await drv.bridge.ensureCompatible({ signal });
      clientManager.recordBridgeHandshake?.({ ...info, protocolVersion: handshake.protocolVersion });
    }
    cancelled(signal);
    t.driver = drv;
    return drv;
  }
  function launch(name, config, initialize, execute) {
    // Hold the device lease through initialization, execution, and cancellation cleanup.
    const runId = randomUUID(), lease = session.acquire({ owner: name, runId });
    if (!lease.ok)
      return Promise.resolve(lease);
    const t = {
      name, runId, mode: config.executionMode === 'demo' ? 'demo' : 'android', controller: new AbortController(), state: 'starting', running: true, stats: emptyStats(), loop: null, ready: null
    };
    tasks.set(name, t);
    emitStatus();
    t.ready = (async () => {
      try {
        const context = await initialize(t);
        cancelled(t.controller.signal);
        t.state = 'running';
        emitStatus();
        t.loop = (async () => {
          await Promise.resolve();
          let failure;
          try {
            t.result = await execute(t, context);
          }
          catch (e) {
            failure = e;
            if (e.name !== 'AbortError')
              log(name, 'fail', e.message);
          }
          finally {
            finish(t, failure);
          }
        })();
        return { ok: true, runId, mode: t.mode };
      }
      catch (e) {
        if (t.cleanup)
          await t.cleanup().catch(cleanupError => log(name, 'fail', cleanupError.message));
        finish(t, e);
        return { ok: false, reason: e.name === 'AbortError' ? 'CANCELLED' : e.message };
      }
    })();
    return t.ready;
  }
  async function recordPrivate(t, result) {
    // Real counts derive from the durable journal; demo results remain separate.
    const [, { normalizeResult, countResult }] = await modules;
    const r = normalizeResult(result, { runId: t.runId, mode: t.mode, targetUid: result.targetUid, machineCode: dataStore.getMachineCode(), task: 'private' });
    if (t.mode === 'android')
      dataStore.recordOutcome(r);
    countResult(t.stats, r);
    log('private', r.outcome === 'confirmed_ui' ? 'ok' : r.outcome === 'failed' ? 'fail' : 'warn', `${r.targetUid}: ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`);
    emitStatus();
    return r;
  }
  function startPrivate(config) {
    return launch('private', config, async (t) => {
      const [{ validatePrivateConfig }] = await modules, checked = validatePrivateConfig(config);
      if (!checked.ok)
        throw Error(checked.reason);
      if (checked.duplicates.length)
        log('private', 'skip', `去除 ${checked.duplicates.length} 个重复目标`);
      if (t.mode === 'android')
        await readyDriver(t);
      return checked.config;
    }, async (t, cfg) => {
      const signal = t.controller.signal, black = new Set((cfg.blacklist || []).map(String)), machine = dataStore.getMachineCode();
      let failures = 0;
      log('private', 'info', `本次共 ${cfg.targets.length} 个目标，用户间隔 ${cfg.delayMin}–${cfg.delayMax} 秒`);
      for (let i = 0; i < cfg.targets.length; i++) {
        cancelled(signal);
        const target = cfg.targets[i];
        if (black.has(target.uid) || (t.mode === 'android' && (dataStore.isPending(machine, target.uid) || (cfg.noDuplicate !== false && dataStore.isSentToday(machine, target.uid))))) {
          t.stats.skipped++;
          log('private', 'skip', `${target.uid}: 黑名单、今日已处理或存在待确认结果`);
          emitStatus();
          continue;
        }
        let result, intent = false;
        if (t.mode === 'demo')
          result = { outcome: 'simulated', stage: 'simulate' };
        else
          try {
            result = await t.driver.sendPrivateMessage(target.nickname, cfg.contents[cfg.mode === 'select' ? cfg.selectedIndex : Math.floor(Math.random() * cfg.contents.length)], {
              expectedUid: target.uid, signal, onLog: (l, m) => log('private', l, m),
              onBeforeSend: async () => {
                // Save intent before clicking send so a process crash cannot trigger a retry.
                cancelled(signal);
                dataStore.recordOutcome({
                  mode: 'android', outcome: 'unconfirmed', stage: 'dispatch', reason: 'DISPATCH_INTENT', runId: t.runId, targetUid: target.uid, machineCode: machine, task: 'private'
                });
                intent = true;
              },
            });
          }
          catch (e) {
            result = { outcome: intent ? 'unconfirmed' : e.name === 'AbortError' ? 'cancelled' : 'failed', stage: intent ? 'dispatch' : 'prepare', reason: e.message };
          }
        if (intent && result?.outcome !== 'confirmed_ui' && (signal.aborted || !isDefinitiveSendRejection(result, target.uid)))
          result = { ...result, outcome: 'unconfirmed', reason: result?.reason || 'DISPATCH_NOT_CONFIRMED' };
        const r = await recordPrivate(t, { ...result, targetUid: target.uid });
        failures = r.outcome === 'failed' && !isDefinitiveSendRejection(r, target.uid) ? failures + 1 : 0;
        if (signal.aborted || ['unconfirmed', 'cancelled'].includes(r.outcome) || failures >= 5 || (cfg.sendLimit > 0 && t.stats.ok + t.stats.simulated >= cfg.sendLimit)) {
          if (r.outcome === 'unconfirmed')
            log('private', 'warn', `本条发送结果不确定，保留待确认并停止；尚余 ${cfg.targets.length - i - 1} 个目标，核对后可继续`);
          else if (failures >= 5)
            log('private', 'warn', '连续 5 次导航或准备失败，停止本轮，请检查当前界面');
          else if (!signal.aborted && cfg.sendLimit > 0)
            log('private', 'info', `已达到本轮发送上限 ${cfg.sendLimit}`);
          break;
        }
        if (i < cfg.targets.length - 1)
          await sleep(t.mode === 'demo' ? 0 : (cfg.delayMin + Math.random() * (cfg.delayMax - cfg.delayMin)) * 1000, signal);
      }
      return { ...t.stats };
    });
  }
  function startCall(config) {
    return launch('call', config, async (t) => {
      const [{ validateCallConfig }] = await modules, checked = validateCallConfig(config);
      if (!checked.ok)
        throw Error(checked.reason);
      if (t.mode === 'android')
        await readyDriver(t);
      return checked.config;
    }, async (t, cfg) => {
      while (!t.controller.signal.aborted) {
        const ok = t.mode === 'demo' ? true : await t.driver._sendCallOnce(cfg.emoji);
        if (t.mode === 'demo')
          t.stats.simulated++;
        else if (ok) {
          t.stats.sent++;
          t.stats.unconfirmed++;
        }
        else
          t.stats.fail++;
        log('call', ok ? 'info' : 'fail', t.mode === 'demo' ? '模拟打call（未操作设备）' : ok ? '已执行打call动作（未核验送达）' : '未找到可用表情入口');
        emitStatus();
        await sleep((cfg.delayMin + Math.random() * (cfg.delayMax - cfg.delayMin)) * 1000, t.controller.signal);
      }
    });
  }
  function startWelcome(config) {
    return launch('welcome', config, async (t) => {
      if (t.mode === 'android')
        await readyDriver(t);
    }, async (t) => {
      if (t.mode === 'demo') {
        while (!t.controller.signal.aborted) {
          t.stats.simulated++;
          log('welcome', 'info', '模拟欢迎（未操作设备）');
          emitStatus();
          await sleep(3500, t.controller.signal);
        }
        return;
      }
      const handle = await t.driver.startAutoWelcome({ signal: t.controller.signal, intervalMs: appConfig.taskRunner.welcomePollIntervalMs, onEvent: ev => {
          if (t.controller.signal.aborted)
            return;
          if (ev.ok) {
            t.stats.clicked++;
            t.stats.unconfirmed++;
          }
          else
            t.stats.skipped++;
          log('welcome', ev.ok ? 'info' : 'skip', `${ev.key}: ${ev.ok ? '欢迎动作已执行（未核验送达）' : '未找到欢迎入口'}`);
          emitStatus();
        } });
      try {
        await untilAbort(t.controller.signal);
      }
      finally {
        await handle.stop();
      }
    });
  }
  function start(name, config = {}) {
    if (!config || typeof config !== 'object' || Array.isArray(config))
      return Promise.resolve({ ok: false, reason: 'INVALID_CONFIG' });
    if (config.executionMode != null && !['android', 'demo'].includes(config.executionMode))
      return Promise.resolve({ ok: false, reason: 'INVALID_EXECUTION_MODE' });
    if (name === 'private')
      return startPrivate(config);
    if (name === 'call')
      return startCall(config);
    if (name === 'welcome')
      return startWelcome(config);
    return Promise.resolve({ ok: false, reason: 'UNKNOWN_TASK' });
  }
  async function stop(name) {
    // Request cancellation, then keep ownership until all work has settled.
    const t = tasks.get(name);
    if (!t?.running)
      return { ok: true, state: t?.state || 'stopped' };
    t.state = 'stopping';
    t.controller.abort();
    emitStatus();
    await t.ready;
    if (t.loop)
      await t.loop;
    return { ok: true, state: t.state };
  }
  async function stopAll() {
    await Promise.all([...tasks.keys()].map(stop));
  }
  async function waitForIdle() {
    for (const t of tasks.values()) {
      if (t.ready)
        await t.ready;
      if (t.loop)
        await t.loop;
    }
  }
  function startCollect(opts = {}) {
    return launch('collect', { executionMode: 'android' }, async (t) => {
      if (dataStore.getConfig?.('settings')?.executionMode === 'demo')
        throw Error('REAL_MODE_REQUIRED: 演示模式不执行真实房间采集');
      const scope = opts.scope ?? 'multi';
      if (!['single', 'multi'].includes(scope))
        throw Error('INVALID_COLLECT_SCOPE');
      const maxRooms = opts.maxRooms ?? 12, maxPages = opts.maxPages ?? 6, maxProfiles = opts.maxProfiles ?? 6;
      if (!Number.isInteger(maxRooms) || maxRooms < 1 || maxRooms > 30 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 12 || !Number.isInteger(maxProfiles) || maxProfiles < 0 || maxProfiles > 12)
        throw Error('INVALID_COLLECT_LIMIT');
      const intervalMs = opts.intervalMs ?? (scope === 'multi' ? 1500 : 5000);
      if (!Number.isFinite(intervalMs) || intervalMs < 1000 || intervalMs > 60000)
        throw Error('INVALID_COLLECT_INTERVAL');
      const drv = await readyDriver(t);
      collector = await createCollector(drv, {
        intervalMs, scope, maxRooms, maxPages, maxProfiles, roomName: opts.roomName || null, signal: t.controller.signal,
        ...(dataStore.getCollectionCoverage?.() || {}),
        onProgress: () => {
          if (!t.controller.signal.aborted)
            emitStatus();
        },
        onLog: (l, m) => log('collect', l, m), onUsers: (users, meta) => {
          if (!t.controller.signal.aborted) {
            return dataStore.ingestRealRecords(users, meta);
          }
        },
        onRoom: room => {
          if (!t.controller.signal.aborted)
            dataStore.reportCollectRoom?.(room);
        }, onError: msg => {
          if (!t.controller.signal.aborted)
            dataStore.reportCollectError?.(msg);
        },
      });
      const currentCollector = collector;
      collectorRunId = t.runId;
      t.cleanup = () => currentCollector.stop();
      cancelled(t.controller.signal);
      dataStore.setSource('room');
      await currentCollector.start({ intervalMs, signal: t.controller.signal });
      return currentCollector;
    }, async (t, c) => {
      try {
        await untilAbort(t.controller.signal);
      }
      finally {
        await c.stop();
      }
    });
  }
  function stopCollect() {
    return stop('collect');
  }
  function getCollectStatus() {
    const t = tasks.get('collect');
    return { ok: true, ...(collector && collectorRunId === t.runId ? collector.getStatus() : { rounds: 0 }), running: t.running, state: t.state, statusRevision, source: dataStore.getStatus().source };
  }
  async function resolveNicknames(uids = []) {
    let run;
    const response = await launch('resolve', { executionMode: 'android' }, async (t) => {
      const wantedUids = [...new Set(uids.map(String).filter(u => /^\d+$/.test(u)))];
      if (!wantedUids.length)
        throw Error('NO_TARGETS');
      await readyDriver(t);
      run = t;
      return wantedUids;
    }, async (t, wantedUids) => {
      const r = await t.driver.harvestConversationUids({ wantedUids, signal: t.controller.signal, onLog: (l, m) => log('resolve', l, m) });
      return { ok: true, ...r, matched: r.pairs.filter(p => wantedUids.includes(String(p.uid))), unmatched: wantedUids.filter(u => !r.map[u]) };
    });
    if (!response.ok)
      return response;
    await run.loop;
    return run.result || { ok: false, reason: run.error || 'CANCELLED' };
  }
  async function withDeviceOperation(name, action) {
    let run;
    const response = await launch(name, { executionMode: 'android' }, async (t) => {
      run = t;
      return t.controller.signal;
    }, async (t, signal) => action(signal));
    if (!response.ok)
      return response;
    await run.loop;
    if (run.error)
      return { ok: false, reason: run.error };
    return run.result || { ok: false, reason: 'CANCELLED' };
  }
  async function refreshDriver() {
    return { ok: true, ...getStatus() };
  }
  return {
    start, stop, stopAll, waitForIdle, getStatus, startCollect, stopCollect, getCollectStatus, resolveNicknames, withDeviceOperation, refreshDriver, setLogCallback: fn => {
      logCallback = fn;
    }, setStatusCallback: fn => {
      statusCallback = fn;
    }
  };
}
module.exports = { ...createTaskRunner(), createTaskRunner };
