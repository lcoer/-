// 用户等级分类与明细展示。
const RecommendationView = (function () {
  const api = window.api;
  const labels = { high: '高等级', low: '低等级', unclassified: '未识别' };
  const sexLabels = { male: '男', female: '女', other: '其他', unknown: '未识别' };
  let users = [], activeSettings = null, revision = 0, classificationPending = false, initialized = false;
  const selected=new Set();
  let busy=false,selectionRevision=0;
  const el = id => document.getElementById(id);
  function status(text) { el('recommendStatus').textContent = text; }
  function visibleUsers() {
    const filter = el('recommendGroupFilter').value;
    return users.filter(user => filter === 'all' || user.group === filter);
  }
  function updateControls() {
    el('recommendSelectedCount').textContent=`已选 ${selected.size} 人`;
    ['recommendRefreshBtn', 'recommendLevelField', 'recommendThreshold', 'recommendGroupFilter','recommendSelectAllBtn','recommendClearBtn'].forEach(id => { el(id).disabled = classificationPending||busy; });
  }
  function badge(original, field) {
    const hiddenField = field === 'wealthLevel' ? 'wealthLevelHidden' : 'charmLevelHidden';
    const value = original?.[field];
    return original?.[hiddenField] || /^[?？]+$/.test(String(value).trim()) ? '???（隐藏）' : (value ?? '未识别');
  }
  function render() {
    const visible = visibleUsers();
    el('recommendRows').innerHTML = visible.map(user => `<tr data-uid="${escapeHtml(user.uid)}" class="${selected.has(user.uid)?'selected':''}">
      <td><input type="checkbox" data-uid="${escapeHtml(user.uid)}" aria-label="选择 ${escapeHtml(user.nickname||user.uid)}" ${selected.has(user.uid)?'checked':''} ${busy||classificationPending?'disabled':''}></td>
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
  async function refresh(options) {
    if (busy || (classificationPending && !options) || !initialized) return;
    const requestRevision = ++revision;
    try {
      const response = await api.recommendation.list(options);
      if (requestRevision !== revision||busy) return;
      if (!response?.ok) {
        if (response?.reason === 'CONFIGURATION_REQUIRED') {
          users = []; activeSettings = null;selected.clear();selectionRevision++;
          ['recommendHighCount', 'recommendLowCount', 'recommendUnknownCount'].forEach(id => { el(id).textContent = '0'; });
          status('请设置整数阈值后刷新分类。'); render(); return;
        }
        throw new Error(response?.reason || '推荐列表读取失败');
      }
      users = response.users;
      const firstLoad = !activeSettings;
      if(activeSettings&&(response.levelField!==activeSettings.levelField||response.threshold!==activeSettings.threshold)){selected.clear();selectionRevision++;}
      activeSettings = { levelField: response.levelField, threshold: response.threshold };
      const known=new Set(users.map(user=>user.uid));for(const uid of selected)if(!known.has(uid)){selected.delete(uid);selectionRevision++;}
      if (options || firstLoad || !el('recommendThreshold').value.trim()) showSettings(activeSettings);
      el('recommendHighCount').textContent = response.counts.high;
      el('recommendLowCount').textContent = response.counts.low;
      el('recommendUnknownCount').textContent = response.counts.unclassified;
      status(`${response.levelField === 'charmLevel' ? '魅力等级' : '财富等级'} ≥ ${response.threshold} 为高等级；隐藏等级默认高等级。共 ${response.counts.total} 个真实用户。`);
      render();
    } catch (error) { if (requestRevision === revision) { activeSettings = null; updateControls(); status(`刷新失败：${error.message}`); toast(`推荐列表：${error.message}`, 'error'); } }
  }
  async function saveClassification() {
    if (classificationPending||busy) return;
    const raw = el('recommendThreshold').value.trim();
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) { toast('请填写非负整数等级阈值', 'error'); return; }
    const options = { levelField: el('recommendLevelField').value, threshold: Number(raw) };
    if(!activeSettings||options.levelField!==activeSettings.levelField||options.threshold!==activeSettings.threshold){selected.clear();selectionRevision++;}
    classificationPending = true; updateControls();
    try { await refresh(options); }
    finally { classificationPending = false; render(); }
  }
  async function init() {
    if (initialized) return;
    initialized = true;
    el('recommendRefreshBtn').addEventListener('click', saveClassification);
    el('recommendGroupFilter').addEventListener('change', render);
    el('recommendSelectAllBtn').addEventListener('click',()=>{if(busy||classificationPending)return;visibleUsers().forEach(user=>selected.add(user.uid));selectionRevision++;render();});
    el('recommendClearBtn').addEventListener('click',()=>{if(busy||classificationPending)return;selected.clear();selectionRevision++;render();});
    el('recommendRows').addEventListener('click',event=>{
      if(busy||classificationPending)return;const row=event.target.closest('tr[data-uid]');if(!row||!users.some(user=>user.uid===row.dataset.uid))return;
      selected.has(row.dataset.uid)?selected.delete(row.dataset.uid):selected.add(row.dataset.uid);selectionRevision++;render();
    });
    await refresh();
  }
  const refreshOnStream = debounce(() => {
    const section = document.querySelector('.task-view');
    if (section && !section.hidden) refresh();
  }, 300);
  function onStream(event) {
    if (['record', 'batch', 'cleared', 'source'].includes(event?.type)) refreshOnStream();
  }
  function getSelection(){
    if(classificationPending||!activeSettings||el('recommendLevelField').value!==activeSettings.levelField||Number(el('recommendThreshold').value)!==activeSettings.threshold||!el('recommendThreshold').value.trim())throw Error('等级设置尚未保存，请先保存阈值并刷新');
    if(!selected.size)throw Error('请先在控制台推荐列表中勾选要私聊的用户');
    return {uids:[...selected],revision:selectionRevision,settings:{...activeSettings}};
  }
  function setBusy(value){busy=!!value;if(initialized)render();}
  return { init, refresh, saveClassification, onStream, getSelection, setBusy };
})();
