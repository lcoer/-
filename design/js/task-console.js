// js/task-console.js - 控制台(三任务控制 + 实时日志)
const TaskConsole = (function () {
  const api = window.api;
  const LOG_MAX = 400;

  const logList = document.getElementById('taskLogList');

  // ===== 日志渲染 =====
  function appendLog(entry) {
    const emptyEl = logList.querySelector('.task-log-empty');
    if (emptyEl) emptyEl.remove();
    const line = document.createElement('div');
    line.className = `log-line ${entry.level}`;
    const t = new Date(entry.time).toLocaleTimeString('zh-CN');
    const taskName = { system: '系统', private: '私聊', welcome: '欢迎', call: '打call' }[entry.task] || entry.task;
    line.innerHTML = `<span class="log-time">${t}</span><span class="log-task ${entry.task}">[${taskName}]</span><span class="log-msg">${escapeHtml(entry.msg)}</span>`;
    logList.appendChild(line);
    while (logList.children.length > LOG_MAX) logList.removeChild(logList.firstChild);
    logList.scrollTop = logList.scrollHeight;
  }

  function setStatus(name, running) {
    const map = {
      private: { dot: 'taskPrivateDot', text: 'taskPrivateText', on: '运行中', off: '已停止' },
      welcome: { dot: 'taskWelcomeDot', on: '运行中', off: '已停止' },
      call: { dot: 'taskCallDot', on: '运行中', off: '已停止' },
    }[name];
    if (!map) return;
    const dot = document.getElementById(map.dot);
    dot.classList.toggle('running', running);
    dot.classList.toggle('stopped', !running);
    if (map.text) document.getElementById(map.text).textContent = running ? map.on : map.off;
    // 按钮状态
    const startBtn = document.getElementById(`task${cap(name)}Start`);
    const stopBtn = document.getElementById(`task${cap(name)}Stop`);
    if (startBtn) startBtn.disabled = running;
    if (stopBtn) stopBtn.disabled = !running;
  }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function updateStats(status) {
    const p = status.private?.stats || {};
    document.getElementById('taskPrivateSent').textContent = p.sent || 0;
    document.getElementById('taskPrivateOk').textContent = p.ok || 0;
    document.getElementById('taskPrivateFail').textContent = p.fail || 0;
    document.getElementById('taskPrivateToday').textContent = p.today || 0;
    document.getElementById('taskPrivateWeek').textContent = p.week || 0;
    document.getElementById('taskPrivateMonth').textContent = p.month || 0;

    const w = status.welcome?.stats || {};
    document.getElementById('taskWelcomeClicked').textContent = w.clicked || 0;
    document.getElementById('taskWelcomeSkipped').textContent = w.skipped || 0;

    const c = status.call?.stats || {};
    document.getElementById('taskCallSent').textContent = c.sent || 0;

    setStatus('private', status.private?.running);
    setStatus('welcome', status.welcome?.running);
    setStatus('call', status.call?.running);
  }

  // ===== 私聊启动配置组装 =====
  async function buildPrivateConfig() {
    const rules = RulesView.readForm();
    const copy = await api.config.get('copywriting');
    const blacklist = await api.config.get('blacklist');
    // 目标列表:{ uid, nickname } —— Android 真实模式按昵称定位会话
    const targets = await RulesView.getTargets();

    return {
      targets,
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
      const config = await buildPrivateConfig();
      if (config.targets.length === 0) { toast('没有可发送的目标,请先在规则设定中选择来源', 'error'); return; }
      const withNick = config.targets.filter(t => t.nickname).length;
      const ok = await Dialog.confirm(`即将向 ${config.targets.length} 个目标启动自动私聊(其中 ${withNick} 个带昵称,可真实发送),确认开始?`, '启动自动私聊');
      if (!ok) return;
      const res = await api.task.start('private', config);
      if (res.ok) toast('自动私聊已启动', 'ok');
      else toast(`启动失败: ${res.reason}`, 'error');
    });
    document.getElementById('taskPrivateStop').addEventListener('click', async () => {
      await api.task.stop('private');
      toast('正在停止自动私聊', 'info');
    });

    // 欢迎
    document.getElementById('taskWelcomeStart').addEventListener('click', async () => {
      const res = await api.task.start('welcome', {});
      toast(res.ok ? '自动欢迎已启动' : `启动失败: ${res.reason}`, res.ok ? 'ok' : 'error');
    });
    document.getElementById('taskWelcomeStop').addEventListener('click', async () => {
      await api.task.stop('welcome');
      toast('自动欢迎已停止', 'info');
    });

    // 打call
    document.getElementById('taskCallStart').addEventListener('click', async () => {
      const res = await api.task.start('call', { emoji: '打call', delayMin: 3, delayMax: 5 });
      toast(res.ok ? '自动打call已启动' : `启动失败: ${res.reason}`, res.ok ? 'ok' : 'error');
    });
    document.getElementById('taskCallStop').addEventListener('click', async () => {
      await api.task.stop('call');
      toast('自动打call已停止', 'info');
    });

    document.getElementById('taskLogClear').addEventListener('click', () => {
      logList.innerHTML = '<div class="task-log-empty">暂无日志,启动任务后将显示运行记录</div>';
    });

    // 日志与状态订阅
    api.task.onLog(appendLog);
    api.task.onStatus(updateStats);

    updateStats(await api.task.getStatus());
  }

  return { init };
})();
