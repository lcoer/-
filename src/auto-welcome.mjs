// src/auto-welcome.mjs - 房间自动欢迎
// 职责:监听房间页内新增的"欢迎"图标,队列化按顺序点击(防重复/防多点)
//
// 设计要点:
//   1. MutationObserver 监听 DOM 变化,捕获新增的欢迎图标
//   2. 队列机制:捕获到的图标入队,按顺序逐个点击
//   3. 防重复:WeakSet 标记已处理元素
//   4. 随机延迟:点击间隔 1.5-3 秒随机,模拟人类节奏
//   5. 容错:点击前检查元素是否仍可见,消失则跳过

const CONFIG = {
  welcomeIconClass: 'bg-linear-gradient-7DEDFF',
  clickDelayMin: 1500,
  clickDelayMax: 3000,
  maxQueueSize: 50,
  minVisibleSize: 10,
};

function injectScript() {
  return `(function() {
    if (window.__welcomeState && window.__welcomeState.observer) {
      window.__welcomeState.observer.disconnect();
    }
    const state = {
      observer: null, queue: [], processed: new WeakSet(),
      clickedCount: 0, skippedCount: 0, errorCount: 0,
      running: false, logs: [], startedAt: Date.now(),
    };
    window.__welcomeState = state;
    const cfg = ${JSON.stringify(CONFIG)};

    function addLog(type, msg) {
      state.logs.push({ time: new Date().toLocaleTimeString('zh-CN'), type, msg });
      if (state.logs.length > 20) state.logs.shift();
    }

    // 判断元素是否可见
    function isVisible(el) {
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      return r.width >= cfg.minVisibleSize && r.height >= cfg.minVisibleSize;
    }

    // 队列处理器:逐个点击
    async function processQueue() {
      if (state.running) return;
      state.running = true;
      while (state.queue.length > 0) {
        const el = state.queue.shift();
        if (!isVisible(el)) { state.skippedCount++; continue; }
        try {
          el.click();
          state.clickedCount++;
          addLog('ok', '已点击欢迎');
        } catch (e) { state.errorCount++; }
        const delay = cfg.clickDelayMin + Math.floor(Math.random() * (cfg.clickDelayMax - cfg.clickDelayMin));
        await new Promise(r => setTimeout(r, delay));
      }
      state.running = false;
    }

    // 扫描现有 + 新增的欢迎图标
    function scan() {
      const nodes = document.querySelectorAll('[class*="' + cfg.welcomeIconClass + '"]');
      for (const el of nodes) {
        if (state.processed.has(el)) continue;
        state.processed.add(el);
        if (state.queue.length < cfg.maxQueueSize) state.queue.push(el);
      }
      processQueue();
    }

    state.observer = new MutationObserver(() => scan());
    state.observer.observe(document.body, { childList: true, subtree: true });
    scan();
    addLog('info', '自动欢迎监听已启动');
  })()`;
}

export async function startAutoWelcome(cdp) {
  const result = await cdp.evaluate(`(function(){ ${injectScript()}; return { started: true }; })()`, false);
  return result || { started: true };
}

export async function getWelcomeStatus(cdp) {
  return await cdp.evaluate(`(function(){
    const s = window.__welcomeState;
    if (!s) return { running: false, clickedCount: 0, skippedCount: 0, queueLength: 0 };
    return {
      running: true, clickedCount: s.clickedCount, skippedCount: s.skippedCount,
      queueLength: s.queue.length, errorCount: s.errorCount,
      logs: (s.logs || []).slice(-10),
    };
  })()`, false);
}

export async function stopAutoWelcome(cdp) {
  return await cdp.evaluate(`(function(){
    const s = window.__welcomeState;
    if (!s) return { clickedCount: 0, skippedCount: 0 };
    if (s.observer) s.observer.disconnect();
    s.queue = [];
    return { clickedCount: s.clickedCount, skippedCount: s.skippedCount };
  })()`, false);
}
