// js/utils.js - 通用工具
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Toast 提示
function toast(msg, type = 'info') {
  const wrap = $('#toastWrap');
  if (!wrap) return;
  const icons = { ok: 'check_circle', error: 'error', info: 'info' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="material-symbols-outlined">${icons[type] || 'info'}</span><span>${escapeHtml(msg)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(24px)';
    setTimeout(() => el.remove(), 260);
  }, 2600);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// 防抖
function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// 本地时间格式化
function nowTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// 数字千分位
function fmtNum(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}
