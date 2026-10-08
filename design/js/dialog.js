// js/dialog.js - 自定义确认弹窗(替代原生 confirm)
const Dialog = (function () {
  const overlay = document.getElementById('confirmOverlay');
  const titleEl = document.getElementById('confirmTitle');
  const msgEl = document.getElementById('confirmMsg');
  const okBtn = document.getElementById('confirmOk');
  const cancelBtn = document.getElementById('confirmCancel');

  let resolver = null;

  function close(result) {
    overlay.classList.remove('show');
    if (resolver) { resolver(result); resolver = null; }
  }

  okBtn.addEventListener('click', () => close(true));
  cancelBtn.addEventListener('click', () => close(false));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });

  // confirm(text, title) → Promise<boolean>
  function confirm(text, title = '确认') {
    titleEl.textContent = title;
    msgEl.textContent = text;
    overlay.classList.add('show');
    return new Promise((resolve) => { resolver = resolve; });
  }

  return { confirm };
})();
