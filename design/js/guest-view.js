// js/guest-view.js - 实时贵宾位视图
const GuestView = (function () {
  const api = window.api;
  const state = {
    date: null, seg: 'all', page: 1, kw: '', pages: 1, records: [],
    collecting: false, source: 'demo',
  };

  const grid = document.getElementById('guestGrid');
  const emptyEl = document.getElementById('guestEmpty');
  const dateSel = document.getElementById('guestDateSel');
  const kwInput = document.getElementById('guestKw');
  const pageInfo = document.getElementById('guestPageInfo');
  const prevBtn = document.getElementById('guestPrevBtn');
  const nextBtn = document.getElementById('guestNextBtn');

  function avatarInitial(name) { return (name || '?').trim().charAt(0); }

  function renderCard(r) {
    const cls = r.sex === 'female' ? 'female' : (r.sex === 'male' ? 'male' : 'unknown');
    const sexLabel = r.sex === 'female' ? '女神' : (r.sex === 'male' ? '男神' : '未知');
    const realTag = r.source === 'room'
      ? `<span class="guest-tag real" title="页面可见用户线索，不代表完整在线名单">最近观察</span>` : '';
    // uidReal=false 表示还没拿到真实用户ID(只有昵称)
    const uidText = r.uidReal === false ? '未获取(仅昵称)' : escapeHtml(r.uid);
    const uidCls = r.uidReal === false ? 'guest-row-value muted' : 'guest-row-value';
    return `
      <div class="guest-card">
        <div class="guest-card-head">
          <div class="guest-avatar ${cls}">${escapeHtml(avatarInitial(r.nickname))}</div>
          <div style="min-width:0;flex:1;">
            <div class="guest-card-name">${escapeHtml(r.nickname)}</div>
            <div class="guest-card-sub">${escapeHtml(r.room || '—')} · ${escapeHtml(r.time)}</div>
          </div>
        </div>
        <div class="guest-card-rows">
          <div class="guest-row"><span class="guest-row-label">UID</span><span class="${uidCls}">${uidText}</span></div>
          <div class="guest-row"><span class="guest-row-label">融云ID</span><span class="guest-row-value">${escapeHtml(r.rongCloudId || '—')}</span></div>
        </div>
        <div class="guest-tags">
          <span class="guest-tag ${cls}">${sexLabel}</span>
          ${r.guild ? `<span class="guest-tag guild">${escapeHtml(r.guild)}</span>` : ''}
          ${realTag}
        </div>
      </div>`;
  }

  function applyFilter(list) {
    if (!state.kw) return list;
    const kw = state.kw.toLowerCase();
    return list.filter(r =>
      (r.nickname || '').toLowerCase().includes(kw) ||
      String(r.uid).includes(kw) ||
      (r.room || '').toLowerCase().includes(kw));
  }

  function render() {
    const list = applyFilter(state.records);
    if (list.length === 0) {
      grid.innerHTML = '';
      emptyEl.hidden = false;
    } else {
      emptyEl.hidden = true;
      grid.innerHTML = list.map(renderCard).join('');
    }
    pageInfo.textContent = `第 ${state.page} / ${state.pages} 页`;
    prevBtn.disabled = state.page <= 1;
    nextBtn.disabled = state.page >= state.pages;
    document.getElementById('guestNavCount').textContent = fmtNum(state.records.length);
  }

  async function load() {
    const res = await api.portal.getRecords(state.date, state.seg, state.page, 24, state.kw);
    if (!res || !res.ok) return;
    state.records = res.records || [];
    state.pages = res.pages || 1;
    state.page = res.page || 1;
    render();
  }

  function newRecordCard(r) {
    // 实时流插入:(仅第一页且筛选匹配时置顶)
    if (state.page !== 1) return;
    if (state.seg !== 'all' && state.seg !== r.sex) return;
    state.records.unshift(r);
    if (state.records.length > 48) state.records.pop();
    render();
  }

  async function init() {
    const preferences = await api.config.get('collection') || { scope: 'multi', maxRooms: 12, maxPages: 6 };
    document.getElementById('collectScope').value = preferences.scope || 'multi';
    document.getElementById('collectMaxRooms').value = preferences.maxRooms || 12;
    document.getElementById('collectMaxPages').value = preferences.maxPages || 6;
    document.getElementById('collectMaxProfiles').value = preferences.maxProfiles ?? 6;
    const dates = await api.portal.getDates();
    if (dates && dates.dates && dates.dates.length) {
      state.date = dates.today || dates.dates[0];
      dateSel.innerHTML = dates.dates.map(d =>
        `<option value="${d}"${d === state.date ? ' selected' : ''}>${d}${d === state.date ? ' (今天)' : ''}</option>`).join('');
    }
    await load();

    dateSel.addEventListener('change', () => { state.date = dateSel.value; state.page = 1; load(); });

    document.getElementById('guestSeg').addEventListener('click', (e) => {
      const btn = e.target.closest('.guest-seg-btn');
      if (!btn) return;
      $$('#guestSeg .guest-seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.seg = btn.dataset.seg;
      state.page = 1;
      load();
    });

    kwInput.addEventListener('input', debounce(() => { state.kw = kwInput.value.trim(); state.page = 1; load(); }, 250));

    prevBtn.addEventListener('click', () => { if (state.page > 1) { state.page--; load(); } });
    nextBtn.addEventListener('click', () => { if (state.page < state.pages) { state.page++; load(); } });

    await refreshCollectStatus();
  }

  async function updateStats() {
    try {
      const res = await api.portal.getStats(state.date);
      if (!res || !res.ok) return;
      const d = res.data;
      document.getElementById('statFemalePool').textContent = fmtNum(d.femaleCount);
      document.getElementById('statMalePool').textContent = fmtNum(d.maleCount);
      document.getElementById('statTodayTotal').textContent = fmtNum(d.todayTotal);
      document.getElementById('statUpdatedAt').textContent = d.updatedAt || '--:--';
      document.getElementById('lastSyncTime').textContent = d.updatedAt || '--:--';
      document.getElementById('collectStoredVerified').textContent = fmtNum(d.verifiedCount);
      document.getElementById('collectStoredHints').textContent = fmtNum(d.placeholderCount);
    } catch (e) {
      console.warn('[guest-view] updateStats 失败', e);
    }
  }

  function onStream(ev) {
    if (ev.type === 'record') newRecordCard(ev.payload);
    if (ev.type === 'batch') {
      // 真实采集批量入库 → 整页刷新
      if (ev.payload.added || ev.payload.updated) load();
    }
    if (ev.type === 'stats') refreshStats();
    if (ev.type === 'cleared') { load().then(updateStats); }
    if (ev.type === 'source') { state.source = ev.payload.source; updateLiveBadge(); }
    if (ev.type === 'collect-status') updateLiveBadge(ev.payload);
  }

  // ===== 采集控制 =====
  const collectBtn = document.getElementById('guestCollectBtn');
  const collectBtnText = document.getElementById('guestCollectBtnText');
  const clearBtn = document.getElementById('guestClearBtn');
  const liveBox = document.getElementById('portalLiveBox');
  const liveText = document.getElementById('portalLiveText');
  const refreshStats = debounce(updateStats, 100);
  let latestCollectStatus = { running: false, state: 'stopped' };
  let deviceOwner = null, statusRevision = 0;
  let backendStatusRevision = -1;
  let startRequestPending = false, stopRequestPending = false;

  function acceptBackendRevision(revision) {
    if (!Number.isInteger(revision) || revision < 0) return true;
    if (revision < backendStatusRevision) return false;
    backendStatusRevision = revision;
    return true;
  }

  function renderCollectControls() {
    const stopping = latestCollectStatus.state === 'stopping' || stopRequestPending;
    collectBtn.classList.toggle('active', state.collecting);
    collectBtnText.textContent = stopping ? '停止中...' : state.collecting ? '停止采集' : startRequestPending ? '启动中...' : '开始实时采集';
    // A start request may still be awaiting its reply after the task is already
    // starting. Allow stopping then, but preserve cancellation/device ownership.
    collectBtn.disabled = stopping || (!!deviceOwner && deviceOwner.owner !== 'collect') || (startRequestPending && !state.collecting);
    for (const id of ['collectScope', 'collectMaxRooms', 'collectMaxPages', 'collectMaxProfiles']) document.getElementById(id).disabled = state.collecting || startRequestPending || stopRequestPending;
  }

  function applyCollectStatus(st, busy) {
    latestCollectStatus = st;
    deviceOwner = busy;
    state.collecting = !!st.running;
    state.source = st.source || state.source;
    renderCollectControls();
    document.getElementById('collectNewVerified').textContent = fmtNum(st.newVerified);
    document.getElementById('collectRooms').textContent = fmtNum(st.roomsVisited);
    document.getElementById('collectPages').textContent = fmtNum(st.pagesScanned);
    document.getElementById('collectProfiles').textContent = fmtNum(st.profilesRead);
    document.getElementById('collectDuplicates').textContent = fmtNum(st.duplicateSightings);
    const coverage = { empty: '成员名单显示暂无数据，已降级为公屏与麦位；多房间模式会继续下一房间。', unavailable: '未找到可用成员列表，读取公屏与麦位线索。', partial: '成员列表只完成部分扫描，保留已读数据并继续遍历。', complete: '本房间成员列表已扫描；真实 UID 与仅昵称记录分别统计。' };
    if (st.memberStatus) document.getElementById('collectCoverageHint').textContent = coverage[st.memberStatus] || '正在扫描公开可见用户；本次新 UID 已排除历史已采集 ID。';
    if (st.waitingForNextCycle) document.getElementById('collectCoverageHint').textContent = st.navigationStatus === 'retry' ? '暂未确认更多可访问房间，正在等待重试。' : '已达到本轮访问范围，正在等待下一轮。';
    if (!state.collecting) document.getElementById('collectCoverageHint').textContent = st.state === 'failed' ? `采集失败：${st.error || '请查看控制台日志'}` : '采集已停止，已采集记录已保留。';
    updateLiveBadge({ room: st.room });
  }

  function onTaskStatus(status) {
    if (!acceptBackendRevision(status.statusRevision)) return;
    statusRevision++;
    const collect = status.collect;
    if (collect) applyCollectStatus({ ...collect.stats, running: collect.running, state: collect.state, error: collect.error }, status.deviceOwner);
  }

  function updateLiveBadge(extra) {
    const real = state.source === 'room';
    if (liveBox) liveBox.classList.toggle('is-real', real);
    let txt = real ? (state.collecting ? '采集中' : '房间记录 · 采集未运行') : '演示数据';
    if (real && state.collecting && extra && extra.room) txt = `采集中 · ${extra.room}`;
    if (real && extra && extra.error) txt = '采集异常(见日志)';
    if (liveText) liveText.textContent = txt;
    const statusText = document.getElementById('portalLiveState');
    if (statusText) statusText.textContent = txt;
  }

  async function refreshCollectStatus() {
    const revision = statusRevision;
    try {
      const [st, tasks] = await Promise.all([api.collect.status(), api.task.getStatus()]);
      if (!st || !st.ok) return;
      const backendRevision = tasks.statusRevision ?? st.statusRevision;
      const versioned = Number.isInteger(backendRevision) && backendRevision >= 0;
      if (versioned ? !acceptBackendRevision(backendRevision) : revision !== statusRevision) return;
      // The task owns running/stopping state; collector metrics may reflect an
      // earlier snapshot while cancellation is settling.
      const collect = tasks.collect;
      applyCollectStatus(collect ? { ...st, ...collect.stats, running: collect.running, state: collect.state, error: collect.error } : st, tasks.deviceOwner);
    } catch (e) { /* 忽略 */ }
  }

  async function toggleCollect() {
    if (stopRequestPending || latestCollectStatus.state === 'stopping' || (startRequestPending && !state.collecting) || (deviceOwner && deviceOwner.owner !== 'collect')) return;
    const stopping = state.collecting;
    if (stopping) stopRequestPending = true;
    else startRequestPending = true;
    renderCollectControls();
    try {
      if (stopping) {
        const r = await api.collect.stop();
        if (!r?.ok) toast(r?.reason || '停止采集失败', 'error');
      } else {
        // 开启采集:自动进房 + 自动清除虚拟数据
        const preferences = { scope: document.getElementById('collectScope').value, maxRooms: Number(document.getElementById('collectMaxRooms').value), maxPages: Number(document.getElementById('collectMaxPages').value), maxProfiles: Number(document.getElementById('collectMaxProfiles').value) };
        const saved = await api.config.set('collection', preferences);
        if (!saved?.ok) { toast(saved?.reason || '参数保存失败', 'error'); return; }
        const r = await api.collect.start({ ...preferences, intervalMs: preferences.scope === 'multi' ? 1500 : 5000 });
        if (r && r.ok) {
          state.source = 'room';
          await load();
          await updateStats();
        } else {
          toast((r && r.reason) || '启动采集失败', 'error');
        }
      }
    } catch (e) {
      toast(`${stopping ? '停止' : '启动'}采集失败: ${e.message}`, 'error');
    } finally {
      if (stopping) stopRequestPending = false;
      else startRequestPending = false;
      await refreshCollectStatus();
      renderCollectControls();
    }
  }

  async function clearDemoData() {
    if (!confirm('确定清除虚拟(演示)数据吗?\n\n只删掉模拟生成的假用户,真实采集的数据会保留。')) return;
    clearBtn.disabled = true;
    try {
      const r = await api.portal.clearDemo(false);
      if (r && r.ok) {
        await load();
        await updateStats();
        alert(`已清除 ${r.removed} 条虚拟数据,当前剩余 ${r.kept} 条真实数据。`);
      }
    } finally {
      clearBtn.disabled = false;
    }
  }

  if (collectBtn) collectBtn.addEventListener('click', toggleCollect);
  if (clearBtn) clearBtn.addEventListener('click', clearDemoData);

  return { init, updateStats, onStream, refreshCollectStatus, onTaskStatus };
})();
