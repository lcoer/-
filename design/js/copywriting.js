// js/copywriting.js - 文案编辑视图
const Copywriting = (function () {
  const api = window.api;
  let cfg = null;
  let pendingSave = Promise.resolve();

  const listEl = document.getElementById('copywritingList');

  function render() {
    document.getElementById('copyTotalCount').textContent = cfg.contents.length;
    listEl.innerHTML = cfg.contents.map((text, i) => `
      <div class="copy-item ${cfg.mode === 'select' && cfg.selectedIndex === i ? 'selected' : ''}" data-idx="${i}">
        <span class="copy-item-index">${i + 1}</span>
        <span class="copy-item-text">${escapeHtml(text)}</span>
        <button class="copy-item-del" data-del="${i}" title="删除"><span class="material-symbols-outlined">delete</span></button>
      </div>`).join('');
  }

  function syncMediaUI() {
    const img = cfg.image || {};
    const voice = cfg.voice || {};
    document.getElementById('copyImageEnable').checked = !!img.enable;
    document.getElementById('copyVoiceEnable').checked = !!voice.enable;
    // Existing enabled attachments can be switched off; new unsupported attachments cannot be enabled.
    document.getElementById('copyImageEnable').disabled = !img.enable;
    document.getElementById('copyVoiceEnable').disabled = !voice.enable;
    document.getElementById('copyImagePickBtn').disabled = true;
    document.getElementById('copyVoicePickBtn').disabled = true;
    document.querySelector('input[name="copyMode"][value="mediaonly"]').disabled = true;

    if (img.path) {
      document.getElementById('copyImageFileInfo').hidden = false;
      document.getElementById('copyImageFileName').textContent = img.path.split(/[\\/]/).pop();
      const preview = document.getElementById('copyImagePreview');
      if (img.dataUrl) preview.innerHTML = `<img src="${img.dataUrl}" alt="">`;
      else preview.innerHTML = `<span class="copywriting-media-empty">已选择:${escapeHtml(img.path.split(/[\\/]/).pop())}</span>`;
    } else {
      document.getElementById('copyImageFileInfo').hidden = true;
      document.getElementById('copyImagePreview').innerHTML = '<span class="copywriting-media-empty">选择文件后显示预览</span>';
    }

    if (voice.path) {
      document.getElementById('copyVoiceFileInfo').hidden = false;
      document.getElementById('copyVoiceFileName').textContent = voice.path.split(/[\\/]/).pop();
    } else {
      document.getElementById('copyVoiceFileInfo').hidden = true;
    }
  }

  function includeDraft() {
    const input = document.getElementById('copywritingNewInput');
    const text = input.value.trim();
    if (!text) return;
    if ([...text].length > 2000) throw Error('私信文案最多 2000 个字符，请缩短后保存');
    cfg.contents.push(text);
    input.value = '';
    render();
  }

  function persist() {
    if (!cfg) return Promise.reject(Error('文案尚未加载，请稍后再试'));
    const snapshot = JSON.parse(JSON.stringify(cfg));
    pendingSave = pendingSave.catch(() => {}).then(async () => {
      const result = await api.config.set('copywriting', snapshot);
      if (!result?.ok) throw Error(result?.reason || '文案保存失败');
      return snapshot;
    });
    return pendingSave;
  }

  async function flush() {
    if (!cfg) throw Error('文案尚未加载，请稍后再试');
    includeDraft();
    return persist();
  }

  async function save(notify) {
    try {
      if (notify) includeDraft();
      await persist();
      if (notify) toast('文案配置已保存', 'ok');
    } catch(e) { toast(e.message, 'error'); }
  }

  async function init() {
    cfg = await api.config.get('copywriting');
    cfg = cfg || {};
    cfg.contents = Array.isArray(cfg.contents) ? cfg.contents : [];
    cfg.mode = cfg.mode || 'random';
    cfg.selectedIndex = cfg.selectedIndex || 0;
    cfg.image = cfg.image || { enable: false, path: null };
    cfg.voice = cfg.voice || { enable: false, path: null };
    render();
    syncMediaUI();

    // 发送模式
    $$('input[name="copyMode"]').forEach(el => {
      el.checked = el.value === cfg.mode;
      el.addEventListener('change', () => { cfg.mode = el.value; render(); save(false); });
    });

    // 列表:选中 / 删除
    listEl.addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (del) {
        const i = Number(del.dataset.del);
        cfg.contents.splice(i, 1);
        if (i < cfg.selectedIndex) cfg.selectedIndex--;
        if (cfg.selectedIndex >= cfg.contents.length) cfg.selectedIndex = 0;
        render(); save(false);
        return;
      }
      const item = e.target.closest('.copy-item');
      if (item) {
        cfg.selectedIndex = Number(item.dataset.idx);
        $$('input[name="copyMode"]').forEach(el => { if (el.value === 'select') el.checked = true; });
        cfg.mode = 'select';
        render(); save(false);
      }
    });

    // 新增
    function addItem() {
      try {
        includeDraft();
        save(false);
      } catch (error) { toast(error.message, 'error'); }
    }
    document.getElementById('copywritingAddBtn').addEventListener('click', addItem);
    document.getElementById('copywritingNewInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); addItem(); }
    });

    document.getElementById('copySaveBtn').addEventListener('click', () => save(true));

    // 图片
    document.getElementById('copyImagePickBtn').addEventListener('click', async () => {
      const r = await api.system.pickFile('image');
      if (r.canceled) return;
      cfg.image.path = r.path; cfg.image.name = r.name; cfg.image.dataUrl = r.dataUrl;
      syncMediaUI(); save(false);
      toast('已选择图片', 'ok');
    });
    document.getElementById('copyImageRemoveBtn').addEventListener('click', () => {
      cfg.image = { enable: false, path: null }; syncMediaUI(); save(false);
    });
    document.getElementById('copyImageEnable').addEventListener('change', (e) => {
      if (e.target.checked && !cfg.image.path) { toast('请先选择图片文件', 'info'); e.target.checked = false; return; }
      cfg.image.enable = e.target.checked; syncMediaUI(); save(false);
    });

    // 语音
    document.getElementById('copyVoicePickBtn').addEventListener('click', async () => {
      const r = await api.system.pickFile('voice');
      if (r.canceled) return;
      cfg.voice.path = r.path; cfg.voice.name = r.name;
      syncMediaUI(); save(false);
      toast('已选择音频', 'ok');
    });
    document.getElementById('copyVoiceRemoveBtn').addEventListener('click', () => {
      cfg.voice = { enable: false, path: null }; syncMediaUI(); save(false);
    });
    document.getElementById('copyVoiceEnable').addEventListener('change', (e) => {
      if (e.target.checked && !cfg.voice.path) { toast('请先选择音频文件', 'info'); e.target.checked = false; return; }
      cfg.voice.enable = e.target.checked; syncMediaUI(); save(false);
    });
  }

  return { init, flush };
})();
