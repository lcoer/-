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
      ? `<span class="guest-tag real" title="来自模拟器实时采集">实时</span>` : '';
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
    const res = await api.portal.getRecords(state.date, state.seg, state.page, 24);
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

    kwInput.addEventListener('input', debounce(() => { state.kw = kwInput.value.trim(); render(); }, 250));

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
    } catch (e) {
      console.warn('[guest-view] updateStats 失败', e);
    }
  }

  function onStream(ev) {
    if (ev.type === 'record') newRecordCard(ev.payload);
    if (ev.type === 'batch') {
      // 真实采集批量入库 → 整页刷新
      load().then(updateStats);
    }
    if (ev.type === 'stats') updateStats();
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

  function updateLiveBadge(extra) {
    const real = state.source === 'room';
    if (liveBox) liveBox.classList.toggle('is-real', real);
    let txt = real ? '真实采集' : '演示数据';
    if (real && extra && extra.room) txt = `采集中 · ${extra.room}`;
    if (real && extra && extra.error) txt = '采集异常(见日志)';
    if (liveText) liveText.textContent = txt;
  }

  async function refreshCollectStatus() {
    try {
      const st = await api.collect.status();
      if (!st || !st.ok) return;
      state.collecting = !!st.running;
      state.source = st.source || state.source;
      collectBtn.classList.toggle('active', state.collecting);
      collectBtnText.textContent = state.collecting ? '停止采集' : '开始实时采集';
      updateLiveBadge({ room: st.room });
    } catch (e) { /* 忽略 */ }
  }

  async function toggleCollect() {
    collectBtn.disabled = true;
    try {
      if (state.collecting) {
        const r = await api.collect.stop();
        if (r && r.ok) {
          state.collecting = false;
          collectBtn.classList.remove('active');
          collectBtnText.textContent = '开始实时采集';
          updateLiveBadge();
        }
      } else {
        // 开启采集:自动进房 + 自动清除虚拟数据
        collectBtnText.textContent = '启动中...';
        const r = await api.collect.start({ intervalMs: 5000 });
        if (r && r.ok) {
          state.collecting = true;
          state.source = 'room';
          collectBtn.classList.add('active');
          collectBtnText.textContent = '停止采集';
          load().then(updateStats);
        } else {
          collectBtnText.textContent = '开始实时采集';
          alert((r && r.reason) || '启动采集失败');
        }
      }
    } finally {
      collectBtn.disabled = false;
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

  return { init, updateStats, onStream, refreshCollectStatus };
})();
