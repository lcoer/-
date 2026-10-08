// js/rules-view.js - 规则设定视图
const RulesView = (function () {
  const api = window.api;
  let cfg = null;
  let hourly = [];
  let filterGender = 'all';
  let filterGuild = 'all';

  const cloudDateSel = document.getElementById('cloudDateSel');
  const cloudHourSel = document.getElementById('cloudHourSel');
  const cloudIdPreview = document.getElementById('cloudIdPreview');
  const cloudIdCount = document.getElementById('cloudIdCount');
  const localIdList = document.getElementById('localIdList');

  function currentHourLabels() {
    return hourly.map(h => ({ value: String(h.hour), label: h.label, count: h.count }));
  }

  // 从已加载的 hourly 数据中按小时/性别/工会筛选出预览条目列表
  function filterPreview(hour, gender, guild) {
    let list = [];
    if (hour === 'auto') {
      const allF = [], allM = [];
      for (const h of hourly) for (const p of h.preview) (p.sex === 'female' ? allF : allM).push(p);
      list = [...allF, ...allM];
    } else {
      const h = hourly.find(x => String(x.hour) === hour);
      if (h) list = h.preview;
    }
    if (gender === 'f') list = list.filter(p => p.sex === 'female');
    if (gender === 'm') list = list.filter(p => p.sex === 'male');
    if (guild === 'has') list = list.filter(p => p.guild);
    if (guild === 'none') list = list.filter(p => !p.guild);
    return list;
  }

  function renderPreview() {
    const list = filterPreview(cloudHourSel.value, filterGender, filterGuild);

    cloudIdCount.textContent = `${list.length} 个 ID`;
    if (list.length === 0) {
      cloudIdPreview.innerHTML = '<span style="color:var(--muted)">该时段暂无匹配的 ID</span>';
      return;
    }
    cloudIdPreview.innerHTML = list.slice(0, 200).map(p =>
      `<span class="id-chip ${p.sex}">${escapeHtml(p.uid)}</span>`).join('');
  }

  async function loadCloudData() {
    const res = await api.portal.getSummary(cloudDateSel.value);
    hourly = Array.isArray(res) ? res : (res?.hourly || []);
    const opts = [{ value: 'auto', label: '自动(全部时段)' }];
    for (const h of currentHourLabels()) opts.push({ value: h.value, label: `${h.label}(${h.count})` });
    cloudHourSel.innerHTML = opts.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
    cloudHourSel.value = 'auto';
    renderPreview();
  }

  // 收集当前生效的私聊目标 ID 列表(供控制台启动使用)
  async function getTargetIds() {
    const source = $$('input[name="source"]').find(r => r.checked)?.value || 'cloud';
    if (source === 'local') {
      return localIdList.value.split('\n').map(s => s.trim()).filter(Boolean);
    }
    // 从已加载的 hourly 数据中按小时/性别/工会筛选
    return filterPreview(cloudHourSel.value, filterGender, filterGuild).map(p => p.uid);
  }

  // 新版:返回带昵称的目标列表(Android 真实模式按昵称定位会话)
  // 返回 [{ uid, nickname }]
  async function getTargets() {
    const source = $$('input[name="source"]').find(r => r.checked)?.value || 'cloud';
    if (source === 'local') {
      // 本地列表:每行支持 "uid" 或 "uid,昵称" 或 "uid 昵称"
      return localIdList.value.split('\n').map(s => s.trim()).filter(Boolean).map(line => {
        const m = line.split(/[,\s，]+/).filter(Boolean);
        return { uid: m[0], nickname: m[1] || null };
      });
    }
    return filterPreview(cloudHourSel.value, filterGender, filterGuild)
      .map(p => ({ uid: p.uid, nickname: p.nickname || null }));
  }

  function readForm() {
    return {
      source: $$('input[name="source"]').find(r => r.checked)?.value || 'cloud',
      cloudDate: cloudDateSel.value,
      cloudHour: cloudHourSel.value,
      cloudGender: filterGender,
      cloudGuild: filterGuild,
      localIdList: localIdList.value,
      delayMin: Number(document.getElementById('delayMin').value) || 15,
      delayMax: Number(document.getElementById('delayMax').value) || 40,
      noDuplicate: document.getElementById('optNoDuplicate').checked,
      sendLimit: Number(document.getElementById('sendLimit').value) || 0,
    };
  }

  function applyForm(r) {
    if (!r) return;
    $$('input[name="source"]').forEach(el => { el.checked = el.value === (r.source || 'cloud'); });
    toggleSource(r.source);
    localIdList.value = r.localIdList || '';
    document.getElementById('delayMin').value = r.delayMin ?? 15;
    document.getElementById('delayMax').value = r.delayMax ?? 40;
    document.getElementById('delaySlider').value = r.delayMin ?? 15;
    document.getElementById('optNoDuplicate').checked = r.noDuplicate !== false;
    document.getElementById('sendLimit').value = r.sendLimit ?? 0;
    filterGender = r.cloudGender || 'all';
    filterGuild = r.cloudGuild || 'all';
    $$('#cloudGenderSeg .guest-seg-btn').forEach(b => b.classList.toggle('active', b.dataset.g === filterGender));
    $$('#cloudGuildSeg .guest-seg-btn').forEach(b => b.classList.toggle('active', b.dataset.gu === filterGuild));
    updateDelayPreview();
  }

  function toggleSource(source) {
    document.getElementById('cloudIdInput').hidden = source === 'local';
    document.getElementById('localIdInput').hidden = source !== 'local';
  }

  function updateDelayPreview() {
    const min = Number(document.getElementById('delayMin').value) || 15;
    const max = Number(document.getElementById('delayMax').value) || 40;
    document.getElementById('delayPreview').textContent = `${min} ~ ${max}`;
  }

  async function init() {
    cfg = await api.config.get('rules');

    const dates = await api.portal.getDates();
    cloudDateSel.innerHTML = dates.dates.map(d =>
      `<option value="${d}"${d === dates.today ? ' selected' : ''}>${d}${d === dates.today ? ' (今天)' : ''}</option>`).join('');

    await loadCloudData();
    applyForm(cfg);

    // 事件绑定
    $$('input[name="source"]').forEach(el => el.addEventListener('change', () => toggleSource(el.value)));
    cloudDateSel.addEventListener('change', async () => { await loadCloudData(); save(false); });
    cloudHourSel.addEventListener('change', () => { renderPreview(); save(false); });

    document.getElementById('cloudGenderSeg').addEventListener('click', (e) => {
      const b = e.target.closest('.guest-seg-btn'); if (!b) return;
      $$('#cloudGenderSeg .guest-seg-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); filterGender = b.dataset.g; renderPreview(); save(false);
    });
    document.getElementById('cloudGuildSeg').addEventListener('click', (e) => {
      const b = e.target.closest('.guest-seg-btn'); if (!b) return;
      $$('#cloudGuildSeg .guest-seg-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); filterGuild = b.dataset.gu; renderPreview(); save(false);
    });

    document.getElementById('cloudCopyBtn').addEventListener('click', async () => {
      const ids = await getTargetIds();
      if (ids.length === 0) { toast('没有可复制的 ID', 'info'); return; }
      await navigator.clipboard.writeText(ids.join('\n'));
      toast(`已复制 ${ids.length} 个 ID`, 'ok');
    });

    document.getElementById('delaySlider').addEventListener('input', (e) => {
      document.getElementById('delayMin').value = e.target.value;
      updateDelayPreview();
    });
    ['delayMin', 'delayMax'].forEach(id => {
      document.getElementById(id).addEventListener('input', () => {
        updateDelayPreview();
        document.getElementById('delaySlider').value = document.getElementById('delayMin').value;
      });
    });

    // 自动保存
    ['delayMin', 'delayMax', 'sendLimit'].forEach(id =>
      document.getElementById(id).addEventListener('change', () => save(false)));
    document.getElementById('optNoDuplicate').addEventListener('change', () => save(false));
    localIdList.addEventListener('input', debounce(() => save(false), 800));

    document.getElementById('saveRulesBtn').addEventListener('click', () => save(true));

    // 自动解析昵称:把本地 ID 列表里的纯 uid 补全为 "uid,昵称"
    document.getElementById('resolveNickBtn')?.addEventListener('click', async () => {
      const btn = document.getElementById('resolveNickBtn');
      const hint = document.getElementById('resolveNickHint');
      const raw = localIdList.value.split('\n').map(s => s.trim()).filter(Boolean);
      // 只要第一段是数字就当作 uid(兼容已带昵称的行)
      const uids = raw.map(line => line.split(/[,\s，]+/)[0]).filter(s => /^\d+$/.test(s));
      if (!uids.length) { toast('请先在本地列表里填入 ID', 'info'); return; }

      btn.disabled = true;
      if (hint) { hint.className = 'resolve-nick-hint busy'; hint.textContent = `正在解析 ${uids.length} 个 ID... 可切到「控制台」看实时进度`; }
      toast(`正在解析 ${uids.length} 个昵称,可切到「控制台」查看进度`, 'info');

      try {
        const res = await api.task.resolveNicknames(uids);
        if (!res || !res.ok) {
          const reason = res?.reason || '未知原因';
          if (hint) { hint.className = 'resolve-nick-hint err'; hint.textContent = reason; }
          toast(`解析失败: ${reason}`, 'error');
          return;
        }
        const map = res.map || {};
        // 回填:能解析到的写成 "uid,昵称",解析不到的保留原 uid
        const outLines = raw.map(line => {
          const uid = line.split(/[,\s，]+/)[0];
          return map[uid] ? `${uid},${map[uid]}` : uid;
        });
        localIdList.value = outLines.join('\n');
        await save(false);

        const hit = res.matched?.length || 0;
        if (hint) {
          hint.className = 'resolve-nick-hint done';
          hint.textContent = `解析完成:命中 ${hit} / ${uids.length}`
            + (res.unmatched?.length ? `,未匹配 ${res.unmatched.length} 个(可能不在当前会话列表中)` : '');
        }
        toast(`已解析 ${hit} 个昵称,列表已自动补全`, 'ok');
      } catch (e) {
        if (hint) { hint.className = 'resolve-nick-hint err'; hint.textContent = e.message; }
        toast('解析出错: ' + e.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  async function save(notify) {
    const data = readForm();
    await api.config.set('rules', data);
    if (notify) toast('规则配置已保存', 'ok');
  }

  return { init, getTargetIds, getTargets, readForm };
})();
