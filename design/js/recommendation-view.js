// 用户等级分类与本地作者职责分配。只使用真实 UID，不触发私信。
const RecommendationView = (function () {
  const api = window.api;
  const selected = new Set();
  const labels = { high: '高等级', low: '低等级', unclassified: '未识别' };
  const sexLabels = { male: '男', female: '女', other: '其他', unknown: '未识别' };
  let users = [], activeSettings = null, revision = 0, pending = false, classificationPending = false, initialized = false;
  let retryRequest = null;
  const el = id => document.getElementById(id);
  function status(text) { el('recommendStatus').textContent = text; }
  function visibleUsers() {
    const filter = el('recommendGroupFilter').value;
    return users.filter(user => filter === 'all' || user.group === filter);
  }
  function formMatchesSettings() {
    return activeSettings && el('recommendLevelField').value === activeSettings.levelField
      && el('recommendThreshold').value.trim() !== ''
      && Number(el('recommendThreshold').value) === activeSettings.threshold;
  }
  function updateControls() {
    el('recommendSelectedCount').textContent = `已选 ${selected.size} 人`;
    const length = Array.from(el('recommendContent').value.trim()).length;
    el('recommendContentCount').textContent = `${length} / 2000 字`;
    el('recommendAssignBtn').disabled = pending || classificationPending || !formMatchesSettings() || !selected.size || !length || length > 2000;
    ['recommendRefreshBtn', 'recommendSelectAllBtn', 'recommendClearBtn', 'recommendLevelField', 'recommendThreshold', 'recommendGroupFilter', 'recommendContent'].forEach(id => { el(id).disabled = pending || classificationPending; });
  }
  function badge(original, field) {
    const hiddenField = field === 'wealthLevel' ? 'wealthLevelHidden' : 'charmLevelHidden';
    const value = original?.[field];
    return original?.[hiddenField] || /^[?？]+$/.test(String(value).trim()) ? '???（隐藏）' : (value ?? '未识别');
  }
  function render() {
    const visible = visibleUsers();
    el('recommendRows').innerHTML = visible.map(user => `<tr data-uid="${escapeHtml(user.uid)}" class="${selected.has(user.uid) ? 'selected' : ''}">
      <td><input type="checkbox" data-uid="${escapeHtml(user.uid)}" aria-label="选择 ${escapeHtml(user.nickname || user.uid)}" ${selected.has(user.uid) ? 'checked' : ''} ${pending ? 'disabled' : ''}></td>
      <td>${escapeHtml(user.nickname || '未命名')}<small>UID ${escapeHtml(user.uid)}</small></td>
      <td>${escapeHtml(sexLabels[user.sex] || '未识别')}</td><td>${escapeHtml(badge(user.original, 'wealthLevel'))}</td><td>${escapeHtml(badge(user.original, 'charmLevel'))}</td>
      <td>${escapeHtml(labels[user.group] || '未识别')}${user.levelHidden ? '（等级隐藏）' : ''}</td></tr>`).join('');
    el('recommendEmpty').hidden = visible.length > 0;
    el('recommendEmpty').textContent = users.length ? '当前分组没有用户。' : '暂无用户，请先采集并设置阈值。';
    updateControls();
  }
  function showSettings(settings) {
    if (!settings) return;
    if (settings.levelField) el('recommendLevelField').value = settings.levelField;
    el('recommendThreshold').value = settings.threshold === null || settings.threshold === undefined ? '' : String(settings.threshold);
  }
  async function loadAssignments() {
    const response = await api.recommendation.assignments();
    if (!response?.ok) throw new Error(response?.reason || '分配记录读取失败');
    el('recommendAssignments').innerHTML = response.assignments.length ? response.assignments.map(item => `<div class="recommendation-history-item"><small>${escapeHtml(new Date(item.createdAt).toLocaleString('zh-CN'))} · ${escapeHtml(item.levelField === 'charmLevel' ? '魅力等级' : '财富等级')} ≥ ${escapeHtml(item.threshold)}</small><p>${escapeHtml(item.content)}</p><div>作者：${item.authors.map(author => `${escapeHtml(author.nickname || '未命名')}（UID ${escapeHtml(author.uid)}）`).join('、')}</div></div>`).join('') : '<p class="field-hint">暂无分配记录。</p>';
    return response.settings;
  }
  async function refresh(options) {
    if (pending || (classificationPending && !options) || !initialized) return;
    const requestRevision = ++revision;
    try {
      const response = await api.recommendation.list(options);
      if (requestRevision !== revision) return;
      if (!response?.ok) {
        if (response?.reason === 'CONFIGURATION_REQUIRED') {
          users = []; activeSettings = null; selected.clear();
          ['recommendHighCount', 'recommendLowCount', 'recommendUnknownCount'].forEach(id => { el(id).textContent = '0'; });
          status('请设置整数阈值后刷新分类。'); render(); return;
        }
        throw new Error(response?.reason || '推荐列表读取失败');
      }
      users = response.users;
      activeSettings = { levelField: response.levelField, threshold: response.threshold };
      if (options || !el('recommendThreshold').value.trim()) showSettings(activeSettings);
      const known = new Set(users.map(user => user.uid));
      for (const uid of selected) if (!known.has(uid)) selected.delete(uid);
      el('recommendHighCount').textContent = response.counts.high;
      el('recommendLowCount').textContent = response.counts.low;
      el('recommendUnknownCount').textContent = response.counts.unclassified;
      status(`${response.levelField === 'charmLevel' ? '魅力等级' : '财富等级'} ≥ ${response.threshold} 为高等级；隐藏等级默认高等级。共 ${response.counts.total} 个真实用户。`);
      render();
    } catch (error) { if (requestRevision === revision) { activeSettings = null; updateControls(); status(`刷新失败：${error.message}`); toast(`推荐列表：${error.message}`, 'error'); } }
  }
  async function saveClassification() {
    if (pending || classificationPending) return;
    const raw = el('recommendThreshold').value.trim();
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) { toast('请填写非负整数等级阈值', 'error'); return; }
    const options = { levelField: el('recommendLevelField').value, threshold: Number(raw) };
    classificationPending = true; selected.clear(); updateControls();
    try { await refresh(options); }
    finally { classificationPending = false; render(); }
  }
  async function assign() {
    if (pending || classificationPending) return;
    const content = el('recommendContent').value.trim();
    if (!formMatchesSettings()) { toast('等级设置已变更，请先保存阈值并刷新', 'error'); return; }
    if (!selected.size || !content || Array.from(content).length > 2000) { toast('请选择用户，并填写 1 至 2000 字的推荐内容', 'error'); return; }
    const payload = { uids: [...selected].sort(), content, ...activeSettings };
    const signature = JSON.stringify(payload);
    if (retryRequest?.signature !== signature) retryRequest = { signature, id: crypto.randomUUID() };
    pending = true; revision++; render();
    let saved = false;
    try {
      const response = await api.recommendation.assign({ ...payload, requestId: retryRequest.id });
      if (!response?.ok) throw new Error(response?.reason || '分配保存失败');
      saved = true; selected.clear(); el('recommendContent').value = ''; retryRequest = null;
      toast('作者分配已保存', 'ok');
      await loadAssignments();
    } catch (error) { toast(saved ? `分配已保存，但记录刷新失败：${error.message}` : `分配失败：${error.message}`, 'error'); }
    finally { pending = false; render(); }
  }
  async function init() {
    if (initialized) return;
    initialized = true;
    el('recommendRefreshBtn').addEventListener('click', saveClassification);
    el('recommendGroupFilter').addEventListener('change', render);
    el('recommendSelectAllBtn').addEventListener('click', () => { if (!pending) { visibleUsers().forEach(user => selected.add(user.uid)); render(); } });
    el('recommendClearBtn').addEventListener('click', () => { if (!pending) { selected.clear(); render(); } });
    el('recommendRows').addEventListener('click', event => {
      if (pending || classificationPending) return;
      const row = event.target.closest('tr[data-uid]');
      if (!row) return;
      const uid = row.dataset.uid;
      selected.has(uid) ? selected.delete(uid) : selected.add(uid);
      render();
    });
    ['recommendContent', 'recommendThreshold', 'recommendLevelField'].forEach(id => el(id).addEventListener('input', updateControls));
    el('recommendAssignBtn').addEventListener('click', assign);
    try { showSettings(await loadAssignments()); } catch (error) { toast(error.message, 'error'); }
    await refresh();
  }
  const refreshOnStream = debounce(() => {
    const section = document.querySelector('.recommendation-view');
    if (section && !section.hidden) refresh();
  }, 300);
  function onStream(event) {
    if (['record', 'batch', 'cleared', 'source'].includes(event?.type)) refreshOnStream();
  }
  return { init, refresh, assign, saveClassification, onStream };
})();
