// src/conversation-refresh.mjs - 会话列表刷新
// 职责:发送后刷新会话列表,抹平 UI 痕迹,与真人收发无异
// 实现:触发客户端自身的会话列表同步(通过内部 API),best-effort

export async function refreshConversationList(cdp, rongModule, targetId) {
  try {
    return await cdp.evaluate(`(async function(){
      try {
        // 优先:调用客户端内部会话同步接口
        if (window.electronAPI && window.electronAPI.getCommonData) {
          await window.electronAPI.getCommonData('conversationListRefresh', {}).catch(() => {});
        }
        // 回退:触发一次会话列表输入焦点刷新
        const evt = new Event('visibilitychange');
        document.dispatchEvent(evt);
        return { ok: true };
      } catch (e) { return { ok: false, reason: String(e && e.message || e).slice(0, 60) }; }
    })()`, true);
  } catch {
    return { ok: false };
  }
}
