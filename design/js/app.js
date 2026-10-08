// js/app.js - 应用入口(视图路由 + 初始化)
(function () {
  const api = window.api;

  // ===== 视图路由 =====
  const VIEWS = ['ranking', 'rules', 'task', 'copywriting', 'blacklist', 'settings'];
  function switchView(name) {
    $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    VIEWS.forEach(v => {
      const sec = document.querySelector(`.${v}-view`);
      if (!sec) return;
      const active = v === name;
      sec.hidden = !active;
      sec.classList.toggle('active', active);
    });
  }

  function bindNav() {
    $$('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });
  }

  // ===== 刷新界面 =====
  async function refreshAll() {
    await GuestView.updateStats();
    GuestView.onStream({ type: 'stats' });
  }

  // 单步容错执行:任一视图初始化失败不阻断后续初始化
  async function safeStep(name, fn) {
    try {
      await fn();
    } catch (e) {
      console.error(`[app] 初始化步骤失败: ${name}`, e);
    }
  }

  // ===== 初始化 =====
  async function init() {
    bindNav();

    // 实时流订阅(先于各视图初始化,避免早期事件丢失)
    try {
      api.portal.onStream((ev) => {
        if (ev.type === 'log') return;
        try { GuestView.onStream(ev); } catch (e) { console.warn('[app] stream 处理失败', e); }
      });
    } catch (e) {
      console.warn('[app] 实时流订阅失败', e);
    }

    // 各视图初始化(相互独立,单点失败不影响整体)
    await safeStep('GuestView', () => GuestView.init());
    await safeStep('RulesView', () => RulesView.init());
    await safeStep('Copywriting', () => Copywriting.init());
    await safeStep('Blacklist', () => Blacklist.init());
    await safeStep('Settings', () => Settings.init());
    await safeStep('TaskConsole', () => TaskConsole.init());

    // 顶部刷新按钮
    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        await refreshAll();
        toast('界面已刷新', 'ok');
      });
    }

    // 初始统计(失败也不影响界面其余部分)
    await safeStep('refreshAll', refreshAll);

    console.log('[app] 初始化完成');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
