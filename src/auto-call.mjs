// src/auto-call.mjs - 房间自动打call
// 职责:在房间内自动发送表情(打call / 666 等)
//
// 实现:定位房内表情按钮并点击,或调用客户端暴露的表情接口。
//       优先走 DOM 点击(最贴近真人操作),失败时回退接口调用。

// 发送单个表情
export async function sendEmoji(cdp, emoji = '打call') {
  return await cdp.evaluate(`(async function(){
    const emoji = ${JSON.stringify(emoji)};
    // 1. 优先:查找页面上带表情名称的元素并点击
    try {
      const all = [...document.querySelectorAll('div,span,button,img')];
      const target = all.find(el => {
        const t = (el.textContent || '').trim();
        const alt = el.getAttribute && (el.getAttribute('alt') || el.getAttribute('title') || '');
        return (t === emoji || alt === emoji) && el.offsetParent !== null;
      });
      if (target) {
        target.click();
        return { ok: true, emoji, method: 'dom-click' };
      }
    } catch (e) {}

    // 2. 回退:查找带有表情容器 class 的可点击元素
    try {
      const btns = [...document.querySelectorAll('[class*="emoji"],[class*="expression"],[class*="Emoji"]')];
      const visible = btns.filter(b => b.offsetParent !== null);
      if (visible.length > 0) {
        visible[0].click();
        return { ok: true, emoji, method: 'class-click' };
      }
    } catch (e) {}

    return { ok: false, reason: 'EMOJI_BUTTON_NOT_FOUND', emoji };
  })()`, true);
}
