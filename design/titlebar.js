// titlebar.js - 自定义标题栏窗口控制
(function () {
  const api = window.api;
  if (!api?.window) return;

  const minBtn = document.getElementById('titlebarMinimize');
  const maxBtn = document.getElementById('titlebarMaximize');
  const closeBtn = document.getElementById('titlebarClose');
  const maxIcon = document.getElementById('titlebarMaximizeIcon');

  const ICON_MAX = '<rect x="3" y="3" width="10" height="10" rx="1.5"/>';
  const ICON_RESTORE = '<rect x="3" y="5" width="8" height="8" rx="1.5"/><path d="M6 5V3.5A1.5 1.5 0 0 1 7.5 2h5A1.5 1.5 0 0 1 14 3.5v5A1.5 1.5 0 0 1 12.5 10H11"/>';

  function setIcon(isMax) {
    maxIcon.innerHTML = isMax ? ICON_RESTORE : ICON_MAX;
  }

  minBtn.addEventListener('click', () => api.window.minimize());
  maxBtn.addEventListener('click', () => api.window.maximize());
  closeBtn.addEventListener('click', () => api.window.close());

  api.window.isMaximized().then(setIcon);
  api.window.onMaximizeChange(setIcon);
})();
