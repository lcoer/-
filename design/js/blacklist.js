// js/blacklist.js - 黑名单设置视图
const Blacklist = (function () {
  const api = window.api;
  const input = document.getElementById('blacklistInput');

  function count() {
    const list = parse();
    document.getElementById('blacklistCount').textContent = list.length;
  }

  function parse() {
    return input.value.split('\n').map(s => s.trim()).filter(Boolean);
  }

  async function save(notify) {
    await api.config.set('blacklist', parse());
    if (notify) toast(`黑名单已保存(${parse().length} 个 ID)`, 'ok');
  }

  async function init() {
    const list = await api.config.get('blacklist');
    input.value = Array.isArray(list) ? list.join('\n') : '';
    count();
    input.addEventListener('input', debounce(count, 200));
    input.addEventListener('change', () => save(false));
    document.getElementById('blacklistSaveBtn').addEventListener('click', () => save(true));
  }

  return { init };
})();
