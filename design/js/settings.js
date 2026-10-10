// js/settings.js - 设置视图(模拟器连接与运行环境)
const Settings = (function () {
  const api = window.api;

  function setHint(text) {
    const el = document.getElementById('setRealHint');
    if (!el) return;
    if (!text) { el.style.display = 'none'; el.textContent = ''; return; }
    el.style.display = '';
    el.innerHTML = text;
  }

  function setText(id, v) {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  }

  async function refresh() {
    let info = {};
    try { info = await api.system.getInfo(); } catch (_) { info = {}; }

    const connected = !!info.emulatorConnected;
    setText('setEmuStatus', connected ? '已连接' : '未检测到');
    setText('setEmuSerial', info.serial || '--');
    setText('setEmuAdb', info.adbPath || '--');
    setText('setEmuBridge', info.bridgeReady ? '协议 v2 已就绪' : (info.bridgeServiceEnabled ? '已启用 · 尚未通过 v2 验证' : (connected ? '未就绪' : '--')));
    const demo = info.executionMode === 'demo';
    setText('setRunMode', demo ? '演示（不发送，不计入真实统计）' : (connected ? '真实模式' : '真实模式 · 设备未连接'));
    const modeSelect = document.getElementById('executionMode');
    if (modeSelect) modeSelect.value = demo ? 'demo' : 'android';
    const settings = await api.config.get('settings') || {};
    const accountInput = document.getElementById('senderAccountUid');
    if (accountInput && document.activeElement !== accountInput) accountInput.value = settings.senderAccountUid || '';
    setText('setVersion', info.version || '--');

    // 侧边栏 + 标题栏徽标
    const dot = document.getElementById('clientDot');
    const text = document.getElementById('clientText');
    const badge = document.getElementById('modeBadge');
    if (connected) {
      dot.className = 'status-dot';
      text.textContent = '模拟器已连接';
      badge.textContent = demo ? '演示模式' : '真实模式';
      badge.classList.toggle('live', !demo);
      setHint('');
    } else {
      dot.className = 'status-dot error';
      text.textContent = '模拟器未连接';
      badge.textContent = demo ? '演示模式' : '设备未连接';
      badge.classList.remove('live');
    }
    if (info.recoveryRequired) setHint('发送历史需要恢复核验，可能缺少最近的发送记录。当前已禁止发送，请先核对原始数据及备份，恢复完整记录。');
    else if (info.collectionRecoveryRequired) setHint('采集历史已从有效备份恢复，最近一次采集可能不完整。请保留原文件并核对名单；正常发送记录和去重仍然有效。');
    return info;
  }

  async function init() {
    const info = await refresh();
    document.getElementById('executionMode').addEventListener('change', async e => {
      const res = await api.config.set('settings', { executionMode: e.target.value });
      toast(res?.ok ? '执行模式已保存' : (res?.reason || '保存失败'), res?.ok ? 'ok' : 'error');
      await refresh();
    });
    document.getElementById('setSenderAccountBtn').addEventListener('click', async () => {
      const button = document.getElementById('setSenderAccountBtn');
      const uid = document.getElementById('senderAccountUid').value.trim();
      if (uid && !/^\d{1,32}$/.test(uid)) { toast('发送账号 UID 应为纯数字', 'error'); return; }
      button.disabled = true;
      try {
        const settings = await api.config.get('settings') || { executionMode: 'android' };
        const res = await api.config.set('settings', { executionMode: settings.executionMode, senderAccountUid: uid });
        toast(res?.ok ? '发送账号已保存' : (res?.reason || '保存失败'), res?.ok ? 'ok' : 'error');
        await refresh();
      } catch (e) { toast(`保存失败: ${e.message}`, 'error'); }
      finally { button.disabled = false; }
    });
    if (!info.emulatorConnected && !info.recoveryRequired) {
      setHint('<span class="material-symbols-outlined">lightbulb</span>'
        + '使用真实模式需要:<b>① 启动雷电模拟器</b> → <b>② 在模拟器内安装并登录「双鱼部落」</b>'
        + ' → <b>③ 点「检测并连接模拟器」</b>。'
        + '若连接成功但桥接未就绪,点「安装/启用无障碍桥接」即可。');
    }

    document.getElementById('aboutBtn')?.addEventListener('click', () => {
      toast('双鱼部落写作业机器人', 'info');
    });

    // 检测并连接模拟器
    document.getElementById('setEmuConnectBtn')?.addEventListener('click', async () => {
      toast('正在检测雷电模拟器...', 'info');
      const res = await api.system.connectEmulator();
      if (res.ok) {
        toast(`模拟器已连接(${res.serial})`, 'ok');
        if (!res.bridgeReady) {
          setHint('<span class="material-symbols-outlined">warning</span>'
            + '模拟器已连接,但<b>无障碍桥接未就绪</b>——房间页可能读不到控件。'
            + '请点「安装/启用无障碍桥接」修复。');
          if (res.protocolError) toast(res.protocolError, 'error');
        }
      } else {
        toast(`连接失败: ${res.reason || '未知原因'}`, 'error');
        setHint('<span class="material-symbols-outlined">warning</span>'
          + '未检测到雷电模拟器。请确认:<br>'
          + '① 雷电模拟器已启动;<br>'
          + '② 模拟器内已安装「双鱼部落」;<br>'
          + '③ 若模拟器装在非默认目录,请点「手动指定 adb 路径」。');
      }
      await refresh();
    });

    // 安装/启用无障碍桥接
    document.getElementById('setEmuInstallBridgeBtn')?.addEventListener('click', async () => {
      toast('正在安装/启用无障碍桥接...', 'info');
      const res = await api.system.installBridge();
      if (res.ok) {
        toast('无障碍桥接已就绪,房间页可正常读取', 'ok');
        setHint('');
      } else {
        toast(`桥接启用失败: ${res.reason || '未知原因'}`, 'error');
        setHint('<span class="material-symbols-outlined">warning</span>'
          + '自动启用失败。请在模拟器中手动开启:'
          + '<b>设置 → 无障碍 → 已安装的服务 → SYL Bridge → 开启</b>。');
      }
      await refresh();
    });

    // 手动指定 adb 路径
    document.getElementById('setPickAdbBtn')?.addEventListener('click', async () => {
      const res = await api.system.pickAdb();
      if (res?.canceled) return;
      if (res?.ok) toast('已保存 adb 路径,正在重新检测', 'ok');
      else toast('该文件不是有效的 adb.exe', 'error');
      await refresh();
    });

    // 重新检测
    document.getElementById('setRedetectBtn')?.addEventListener('click', async () => {
      const res = await api.system.redetect();
      if (res?.emulatorConnected) toast('已连接模拟器', 'ok');
      else toast('仍未检测到模拟器,请确认雷电已启动', 'info');
      await refresh();
    });
  }

  return { init, refresh };
})();
