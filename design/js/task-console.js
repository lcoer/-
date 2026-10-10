// js/task-console.js - Private task controls and live log
const TaskConsole = (function () {
  const api = window.api;
  const LOG_MAX = 400;
  let latestStatusRevision = -1;
  let privateStartPending = false, latestTaskStatus = null;

  const logList = document.getElementById('taskLogList');

  // ===== 日志渲染 =====
  function appendLog(entry) {
    const emptyEl = logList.querySelector('.task-log-empty');
    if (emptyEl) emptyEl.remove();
    const line = document.createElement('div');
    line.className = `log-line ${entry.level}`;
    const t = new Date(entry.time).toLocaleTimeString('zh-CN');
    const taskName = { system: '系统', private: '私聊' }[entry.task] || entry.task;
    line.innerHTML = `<span class="log-time">${t}</span><span class="log-task ${entry.task}">[${taskName}]</span><span class="log-msg">${escapeHtml(entry.msg)}</span>`;
    logList.appendChild(line);
    while (logList.children.length > LOG_MAX) logList.removeChild(logList.firstChild);
    logList.scrollTop = logList.scrollHeight;
  }

  function setStatus(name, task = {}, owner = null) {
    const running = !!task.running;
    const map = {
      private: { dot: 'taskPrivateDot', text: 'taskPrivateText', on: '运行中', off: '已停止' },
    }[name];
    if (!map) return;
    const dot = document.getElementById(map.dot);
    dot.classList.toggle('running', running);
    dot.classList.toggle('stopped', !running);
    const stateLabel = name === 'private' && task.state === 'running' && task.stats?.phase === 'waiting'
      ? `等待间隔 ${Math.ceil((task.stats.waitMs || 0) / 1000)} 秒 · 下一目标 ${task.stats.nextTargetUid || ''}`
      : { starting: '启动中', running: '运行中', stopping: '停止中', stopped: '已停止', failed: '失败' }[task.state] || map.off;
    const label = document.getElementById(map.text || `task${cap(name)}Text`);
    if (label) label.textContent = stateLabel;
    // 按钮状态
    const startBtn = document.getElementById(`task${cap(name)}Start`);
    const stopBtn = document.getElementById(`task${cap(name)}Stop`);
    if (startBtn) startBtn.disabled = running || !!owner || (name === 'private' && privateStartPending);
    if (stopBtn) stopBtn.disabled = !running || task.state === 'stopping';
  }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function updateStats(status) {
    if (Number.isSafeInteger(status.statusRevision) && status.statusRevision >= 0) {
      if (status.statusRevision < latestStatusRevision) return;
      latestStatusRevision = status.statusRevision;
    }
    latestTaskStatus = status;
    const p = status.private?.stats || {};
    document.getElementById('taskPrivateSent').textContent = p.sent || 0;
    document.getElementById('taskPrivateOk').textContent = p.ok || 0;
    document.getElementById('taskPrivateFail').textContent = p.fail || 0;
    document.getElementById('taskPrivatePending').textContent = p.pending ?? p.unconfirmed ?? 0;
    document.getElementById('taskPrivateSimulated').textContent = p.simulated || 0;
    document.getElementById('taskPrivateSkipped').textContent = p.skipped || 0;
    document.getElementById('taskPrivateToday').textContent = p.today || 0;
    document.getElementById('taskPrivateWeek').textContent = p.week || 0;
    document.getElementById('taskPrivateMonth').textContent = p.month || 0;

    setStatus('private', status.private, status.deviceOwner);
    document.getElementById('taskOwner').textContent = status.deviceOwner ? `设备当前由 ${status.deviceOwner.owner} 占用` : '设备空闲；任务之间互斥';
  }

  // ===== 私聊启动配置组装 =====
  async function buildPrivateConfig() {
    const rulesSnapshot = JSON.stringify(RulesView.readForm());
    const rules = JSON.parse(rulesSnapshot);
    const copy = await Copywriting.flush();
    const blacklist = await api.config.get('blacklist');
    const settings = await api.config.get('settings') || {};
    // 目标列表按 UID 搜索；昵称用于展示，不作为发送身份依据。
    const executionMode = settings.executionMode === 'demo' ? 'demo' : 'android';
    const targets = await RulesView.getTargets({ demo: executionMode === 'demo' });
    if (rulesSnapshot !== JSON.stringify(RulesView.readForm())) throw Error('目标规则在准备期间发生变化，请重新确认并启动');

    return {
      targets,
      executionMode,
      senderAccountUid: settings.senderAccountUid || '',
      targetIds: targets.map(t => t.uid),
      contents: copy.contents || [],
      mode: copy.mode || 'random',
      selectedIndex: copy.selectedIndex || 0,
      delayMin: rules.delayMin,
      delayMax: rules.delayMax,
      blacklist: blacklist || [],
      noDuplicate: rules.noDuplicate,
      sendLimit: rules.sendLimit,
      image: { enable: !!copy.image?.enable, path: copy.image?.path || null },
      voice: { enable: !!copy.voice?.enable, path: copy.voice?.path || null, duration: 0 },
    };
  }

  async function init() {
    // 私聊
    document.getElementById('taskPrivateStart').addEventListener('click', async () => {
      if (privateStartPending) return;
      privateStartPending = true;
      document.getElementById('taskPrivateStart').disabled = true;
      try {
        const config = await buildPrivateConfig();
        if (config.targets.length === 0) { toast('没有可发送的目标,请先在规则设定中选择来源', 'error'); return; }
        const { validatePrivateConfig } = await import('/engine/task-policy.mjs');
        const checked = validatePrivateConfig(config);
        if (!checked.ok) { toast(checked.reason, 'error'); return; }
        if (config.executionMode === 'android' && !/^\d{1,32}$/.test(config.senderAccountUid)) {
          toast('请先在设置页填写并核对当前登录的发送账号 UID', 'error'); return;
        }
        const label = config.executionMode === 'demo' ? '演示模拟（不发送）' : '真实文字私聊（先核对对方 UID）';
        const copyPreview = config.mode === 'select'
          ? `使用文案：${config.contents[config.selectedIndex]}`
          : `每位用户随机选择以下 ${config.contents.length} 条文案中的一条：\n${config.contents.map((text, i) => `${i + 1}. ${text}`).join('\n')}`;
        const senderPreview = config.executionMode === 'android' ? `\n发送账号 UID：${config.senderAccountUid}。请确认与模拟器当前登录账号一致。` : '';
        const ok = await Dialog.confirm(`${label}${senderPreview}\n按 UID 搜索共 ${checked.config.targets.length} 个目标。\n${copyPreview}\n待确认结果会停止本批次，确认开始？`, '启动自动私聊');
        if (!ok) return;
        const res = await api.task.start('private', config);
        if (res.ok) toast('自动私聊已启动', 'ok');
        else toast(`启动失败: ${res.reason}`, 'error');
      } catch (e) {
        toast(`启动失败: ${e.message}`, 'error');
      } finally {
        privateStartPending = false;
        if (latestTaskStatus) updateStats(latestTaskStatus);
      }
    });
    document.getElementById('taskPrivateStop').addEventListener('click', async () => {
      const res = await api.task.stop('private');
      toast(res.ok ? '自动私聊已停止' : res.reason, res.ok ? 'info' : 'error');
    });

    document.getElementById('taskLogClear').addEventListener('click', () => {
      logList.innerHTML = '<div class="task-log-empty">暂无日志,启动任务后将显示运行记录</div>';
    });
    document.getElementById('pendingReviewBtn').addEventListener('click', async () => {
      const res = await api.task.getPending();
      if (!res?.results?.length) { toast('没有待确认记录', 'info'); return; }
      for (const record of res.results) {
        let device = record.senderDeviceKey || '未知';
        try { const identity = JSON.parse(device); if (Array.isArray(identity) && typeof identity[1] === 'string') device = identity[1]; } catch (_) {}
        const sender = record.senderAccountUid ? `发送账号 UID：${record.senderAccountUid}；设备：${device}。` : '此记录来自旧版，发送账号和设备未归属，请核对原账号。';
        const sent = await Dialog.confirm(`${sender}\n请先在对应模拟器账号中核对 UID ${record.targetUid} 的消息。若已找到本次消息，点确认；未找到或不确定请取消。`, '人工核对：已发送');
        let resolution = sent ? 'confirmed' : null;
        if (!sent) {
          const notSent = await Dialog.confirm(`只有确定本次消息没有发送，才可解除 UID ${record.targetUid} 的重发限制。不确定请取消，保留待确认。`, '人工核对：确定未发送');
          if (notSent) resolution = 'not_sent';
        }
        if (resolution) {
          const r = await api.task.resolvePending({ machineCode: record.machineCode, targetUid: record.targetUid, runId: record.runId, resolution });
          toast(r?.ok ? '核对结果已保存' : (r?.reason || '保存失败'), r?.ok ? 'ok' : 'error');
        }
      }
      updateStats(await api.task.getStatus());
    });

    // 日志与状态订阅
    api.task.onLog(appendLog);
    api.task.onStatus(updateStats);

    updateStats(await api.task.getStatus());
  }

  return { init };
})();
