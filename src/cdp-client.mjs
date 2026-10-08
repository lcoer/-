// src/cdp-client.mjs - CDP 客户端封装
// 职责:管理 CDP WebSocket 连接,提供 evaluate(执行 JS)/ on(订阅事件)接口
//
// 说明:Electron 主进程的 Node 环境可能没有全局 WebSocket,
//       统一使用 ws 包(CJS、零依赖、兼容所有 Node 版本)。
//
// 安全:
//   1. 端口由 client-manager 动态分配(随机回环)
//   2. ws://127.0.0.1 前缀强校验(防 CDP 被重定向到非回环地址)
//   3. 目标优先选主页面(index.html),多页面时回退第一个 page

import WebSocket from 'ws';

const CDP_TIMEOUT = 30000;

// 获取页面 target
async function fetchTarget(port) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/json`, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`CDP_DISCOVERY_FAILED: HTTP ${resp.status}`);
    const targets = await resp.json();
    const pageTargets = targets.filter(t => t.type === 'page' && !t.url.startsWith('devtools://'));
    if (pageTargets.length === 0) throw new Error('CDP_PAGE_TARGET_NOT_FOUND: 客户端是否已启动?');
    const main = pageTargets.find(t => t.url.includes('index.html')) || pageTargets[0];
    if (!main.webSocketDebuggerUrl.startsWith('ws://127.0.0.1:')) {
      throw new Error(`CDP_WS_HIJACK_SUSPECTED: ${main.webSocketDebuggerUrl}`);
    }
    return main;
  } finally { clearTimeout(timer); }
}

// 连接 CDP,返回 { send, evaluate, on, close }
export async function connectCDP(port) {
  const target = await fetchTarget(port);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 1;
  const pending = new Map();
  const eventHandlers = new Map();

  ws.on('message', (data) => {
    try {
      const text = typeof data === 'string' ? data : data.toString();
      const msg = JSON.parse(text);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        const handlers = eventHandlers.get(msg.method);
        if (handlers) for (const h of handlers) { try { h(msg.params || {}); } catch {} }
      }
    } catch { /* 非 CDP 帧,忽略 */ }
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP_WS_OPEN_TIMEOUT')), 10000);
    ws.on('open', () => { clearTimeout(timer); resolve(); });
    ws.on('error', (err) => { clearTimeout(timer); reject(new Error('CDP_WS_ERROR: ' + (err.message || '连接失败'))); });
  });

  return {
    send(method, params = {}, timeout = CDP_TIMEOUT) {
      return new Promise((resolve, reject) => {
        const id = msgId++;
        const timer = setTimeout(() => {
          if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP_TIMEOUT: ${method}`)); }
        }, timeout);
        pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },

    async evaluate(expression, awaitPromise = true, timeout) {
      const result = await this.send('Runtime.evaluate', {
        expression, awaitPromise, returnByValue: true,
      }, timeout);
      if (result.exceptionDetails) {
        const desc = result.exceptionDetails.exception?.description || '';
        throw new Error(`JS 异常: ${result.exceptionDetails.text}\n${desc}`);
      }
      return result.result.value;
    },

    on(method, handler) {
      if (!eventHandlers.has(method)) eventHandlers.set(method, new Set());
      eventHandlers.get(method).add(handler);
      return () => { eventHandlers.get(method)?.delete(handler); };
    },

    close() { ws.close(); },
  };
}

// 融云模块候选表(不同版本 chunk 文件名与导出名会漂移,运行时逐个探测)
// mapping.text = 发送文字函数导出名;image = 发送图片;history = 拉历史
const MODULE_CANDIDATES = [
  { path: './assets/index-CN_wFc22.js', mapping: { text: 'af', image: 'ai', history: 'ak' } },
  { path: './assets/index-DRn1GQ8G.js', mapping: { text: 'ar', image: 'aq', history: 'Q' } },
  { path: './assets/index-DrMbkcCJ.js', mapping: { text: 'ar', image: 'aq', history: 'Q' } },
  { path: './assets/index-BdKnAw1D.js', mapping: { text: 'ar', image: 'aq', history: 'Q' } },
];

// 运行时探测融云模块(逐个 import 候选 chunk,验证函数签名)
export async function getRongcloudModuleUrl(cdp) {
  return await cdp.evaluate(`(async function(){
    let main = null;
    for (let i = 0; i < 10; i++) {
      const scripts = [...document.querySelectorAll('script[src]')];
      main = scripts.map(s => s.getAttribute('src')).find(s => s && s.includes('main-'));
      if (main && document.readyState !== 'loading') break;
      await new Promise(r => setTimeout(r, 500));
    }
    if (!main) return { failed: [{ path: '(main script)', reason: 'MAIN_SCRIPT_NOT_FOUND' }] };
    const pageBase = new URL('./', location.href).href;
    const candidates = ${JSON.stringify(MODULE_CANDIDATES)};
    const failed = [];
    for (const candidate of candidates) {
      const url = new URL(candidate.path, pageBase).href;
      try {
        const mod = await import(url);
        const m = candidate.mapping;
        if (typeof mod[m.text] === 'function' && typeof mod[m.history] === 'function') {
          return { url, mapping: m };
        }
        failed.push({ path: candidate.path, reason: 'SIGNATURE_MISMATCH' });
      } catch (e) {
        failed.push({ path: candidate.path, reason: 'IMPORT_FAILED' });
      }
    }
    return { failed };
  })()`, true);
}

// 获取当前登录用户(用于构造消息 user 字段)
export async function getCurrentUser(cdp) {
  return await cdp.evaluate(`(function(){
    const me = window.UserInfo || {};
    return {
      rongCloudId: String(me.rongCloudId || me.id || ''),
      nickname: me.name || me.nickname || '',
      avatar: me.portrait || me.avatar || '',
      displayId: String(me.displayId || me.uid || ''),
    };
  })()`, false);
}
