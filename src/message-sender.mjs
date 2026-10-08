// src/message-sender.mjs - 消息发送模块
// 职责:通过 CDP 在页面上下文调用融云 SDK 发送文字 / 图片消息,并做送达确认
//
// 设计要点:
//   1. callSend 错误归一化:融云 reject 的 {code,msg} 统一转 {code,msg,data}
//   2. SDK 接受(code=0)即算成功;历史未确认仅标记 confirmed=false(不翻转成功判定)
//   3. 图片:dataURL → blob → File 后发送;靠"新 UID 出现"确认送达(图片无文本可比对)

const HISTORY_COUNT = 50;
const VERIFY_ATTEMPTS = 10;
const VERIFY_INTERVAL_MS = 1000;

// 发送文本消息
export async function sendTextMessage(cdp, rongModule, targetId, content, userInfo) {
  const user = {
    id: String(userInfo.rongCloudId || ''),
    name: userInfo.nickname || '',
    portraitUri: userInfo.avatar || '',
  };
  return await cdp.evaluate(`(async function(){
    const mod = await import('${rongModule.url}');
    const mapping = ${JSON.stringify(rongModule.mapping)};
    const targetId = ${JSON.stringify(String(targetId))};
    const content = ${JSON.stringify(content)};
    const user = ${JSON.stringify(user)};

    const callSend = async (fn, payload) => {
      try {
        const data = await fn(payload);
        if (data && typeof data === 'object' && data.code !== undefined) return data;
        return { code: 0, data: data ?? null, msg: '' };
      } catch (error) {
        if (error && typeof error === 'object' && ('code' in error || 'msg' in error)) {
          return { code: error.code ?? 'RONGCLOUD_REJECTED', msg: String(error.msg || error.message || ''), data: null };
        }
        throw error;
      }
    };

    const result = await callSend(mod[mapping.text], {
      targetId, content, user, type: 'PRIVATE',
    });
    return {
      ok: result.code === 0,
      code: result.code,
      msg: result.msg || '',
      messageUId: result.data?.messageUId || result.data?.messageUID || null,
    };
  })()`, true);
}

// 发送后验证:轮询会话历史,按服务端 messageUId 精确匹配确认送达
export async function verifyMessageSent(cdp, rongModule, targetId, expectedContent, sentUid) {
  return await cdp.evaluate(`(async function(){
    const mod = await import('${rongModule.url}');
    const mapping = ${JSON.stringify(rongModule.mapping)};
    const targetId = ${JSON.stringify(String(targetId))};
    const expectedContent = ${JSON.stringify(expectedContent)};
    const sentUid = ${JSON.stringify(sentUid || null)};

    const pullHistory = async () => {
      try {
        const history = await mod[mapping.history]({ targetId, type: 'PRIVATE', count: ${HISTORY_COUNT} });
        if (Array.isArray(history?.list)) return history.list;
        if (Array.isArray(history)) return history;
        if (history?.latestMessage) return [history.latestMessage];
        return [];
      } catch { return []; }
    };

    for (let attempt = 0; attempt < ${VERIFY_ATTEMPTS}; attempt++) {
      const messages = await pullHistory();
      for (const msg of messages) {
        const uid = msg?.messageUId || msg?.messageUID || null;
        const direction = Number(msg?.messageDirection || msg?.direction || 0);
        const isOurs = direction === 1 || String(msg?.messageDirection).toUpperCase() === 'SEND';
        if (sentUid) {
          if (uid === sentUid) return { ok: true, confirmed: true, attempts: attempt + 1, messageUId: uid, isOurs };
          continue;
        }
        const content = msg?.content?.content || msg?.content?.text || '';
        if (content === expectedContent && uid && isOurs) {
          return { ok: true, confirmed: true, attempts: attempt + 1, messageUId: uid, isOurs };
        }
      }
      if (attempt < ${VERIFY_ATTEMPTS - 1}) await new Promise(r => setTimeout(r, ${VERIFY_INTERVAL_MS}));
    }
    return { ok: true, confirmed: false, attempts: ${VERIFY_ATTEMPTS}, messageUId: null, isOurs: false };
  })()`, true);
}

// 发送图片消息
export async function sendImageMessage(cdp, rongModule, targetId, imagePath, userInfo) {
  const { readFile } = await import('node:fs/promises');
  const ext = imagePath.toLowerCase().split('.').pop();
  const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif'
    : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const buf = await readFile(imagePath);
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;

  const user = {
    id: String(userInfo.rongCloudId || ''),
    name: userInfo.nickname || '',
    portraitUri: userInfo.avatar || '',
  };

  return await cdp.evaluate(`(async function(){
    const mod = await import('${rongModule.url}');
    const mapping = ${JSON.stringify(rongModule.mapping)};
    const targetId = ${JSON.stringify(String(targetId))};
    const dataUrl = ${JSON.stringify(dataUrl)};
    const user = ${JSON.stringify(user)};
    const fileName = ${JSON.stringify(imagePath.split(/[\\\\/]/).pop())};

    const pullHistory = async () => {
      try {
        const h = await mod[mapping.history]({ targetId, type: 'PRIVATE', count: ${HISTORY_COUNT} });
        if (Array.isArray(h?.list)) return h.list;
        if (Array.isArray(h)) return h;
        return [];
      } catch { return []; }
    };

    const before = await pullHistory();
    const beforeUids = new Set(before.map(m => m?.messageUId).filter(Boolean));

    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    const file = new File([blob], fileName, { type: blob.type });

    const callSend = async (fn, payload) => {
      try {
        const data = await fn(payload);
        if (data && typeof data === 'object' && data.code !== undefined) return data;
        return { code: 0, data: data ?? null, msg: '' };
      } catch (error) {
        if (error && typeof error === 'object' && ('code' in error || 'msg' in error)) {
          return { code: error.code ?? 'RONGCLOUD_REJECTED', msg: String(error.msg || error.message || ''), data: null };
        }
        throw error;
      }
    };

    const sendResult = await callSend(mod[mapping.image], {
      targetId, content: { file }, user, type: 'PRIVATE',
    });
    const sentUid = sendResult?.data?.messageUId || null;
    if (sendResult.code !== 0) {
      return { ok: false, code: sendResult.code, msg: sendResult.msg || '', confirmed: false, messageUId: null };
    }

    for (let attempt = 0; attempt < ${VERIFY_ATTEMPTS}; attempt++) {
      const messages = await pullHistory();
      for (const msg of messages) {
        const uid = msg?.messageUId || null;
        const isOurs = Number(msg?.messageDirection || 0) === 1;
        if (msg?.messageType === 'RC:ImgMsg' && uid && !beforeUids.has(uid) && isOurs) {
          return { ok: true, code: 0, msg: '', confirmed: true, messageUId: uid };
        }
      }
      if (attempt < ${VERIFY_ATTEMPTS - 1}) await new Promise(r => setTimeout(r, ${VERIFY_INTERVAL_MS}));
    }
    return { ok: true, code: 0, msg: sentUid ? 'accepted_history_lag' : '', confirmed: false, messageUId: sentUid };
  })()`, true, 60000);
}

// 完整发送流程:发送 → 轮询确认
export async function sendWithVerification(cdp, rongModule, targetId, content, userInfo) {
  const log = [];
  const sendResult = await sendTextMessage(cdp, rongModule, targetId, content, userInfo);
  log.push(`发送结果: code=${sendResult.code}, 服务端UID=${sendResult.messageUId || '无'}`);
  if (!sendResult.ok) {
    return { ok: false, targetId, content, reason: 'SEND_REJECTED', sendResult, log };
  }
  const verifyResult = await verifyMessageSent(cdp, rongModule, targetId, content, sendResult.messageUId);
  log.push(verifyResult.confirmed
    ? `送达确认: 已确认(第 ${verifyResult.attempts} 次匹配)`
    : `送达确认: 服务端已受理(本地历史未同步)`);
  return { ok: true, targetId, content, sendResult, verifyResult, log };
}
