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
    try {
      const res = await api.config.set('blacklist', parse());
      if (!res?.ok) throw Error(res?.reason || '保存失败');
      if (notify) toast(`黑名单已保存(${parse().length} 个 ID)`, 'ok');
    } catch(e) { toast(e.message, 'error'); }
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
