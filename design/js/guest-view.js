// js/guest-view.js - 实时贵宾位视图
const GuestView = (function () {
  const api = window.api;
  let state = { date: null, seg: 'all', page: 1, kw: '', pages: 1, records: [] };

  const grid = document.getElementById('guestGrid');
  const emptyEl = document.getElementById('guestEmpty');
  const dateSel = document.getElementById('guestDateSel');
  const kwInput = document.getElementById('guestKw');
  const pageInfo = document.getElementById('guestPageInfo');
  const prevBtn = document.getElementById('guestPrevBtn');
  const nextBtn = document.getElementById('guestNextBtn');

  function avatarInitial(name) { return (name || '?').trim().charAt(0); }

  function renderCard(r) {
    const cls = r.sex === 'female' ? 'female' : 'male';
    return `
      <div class="guest-card">
        <div class="guest-card-head">
          <div class="guest-avatar ${cls}">${escapeHtml(avatarInitial(r.nickname))}</div>
          <div style="min-width:0;flex:1;">
            <div class="guest-card-name">${escapeHtml(r.nickname)}</div>
            <div class="guest-card-sub">${escapeHtml(r.room)} · ${escapeHtml(r.time)}</div>
          </div>
        </div>
        <div class="guest-card-rows">
          <div class="guest-row"><span class="guest-row-label">UID</span><span class="guest-row-value">${escapeHtml(r.uid)}</span></div>
          <div class="guest-row"><span class="guest-row-label">融云ID</span><span class="guest-row-value">${escapeHtml(r.rongCloudId)}</span></div>
        </div>
        <div class="guest-tags">
          <span class="guest-tag ${cls}">${r.sex === 'female' ? '女神' : '男神'}</span>
          ${r.guild ? `<span class="guest-tag guild">${escapeHtml(r.guild)}</span>` : ''}
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
    if (ev.type === 'stats') updateStats();
  }

  return { init, updateStats, onStream };
})();
