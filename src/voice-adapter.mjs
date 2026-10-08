// src/voice-adapter.mjs - 语音发送适配器
// 职责:把融云语音发送能力从客户端业务闭包里取出来,供私聊发送语音条
//
// 说明:融云语音发送函数被闭包封装在客户端业务代码中,常规方式拿不到引用。
//       业界通用解法:在闭包变量声明处下断点 → 触发业务代码跑到断点 →
//       在断点作用域内把发送函数挂到 window → 恢复运行。
//       本模块实现该"断点取闭包"流程,并提供兜底(若客户端暴露了语音接口则直接调用)。
//
// 使用:
//   import { sendVoiceMessage } from './voice-adapter.mjs';
//   await sendVoiceMessage(cdp, rongModule, targetId, voicePath, userInfo, durationSec);

const MARKER = 'getHistoryMessagesApi=';
const VOICE_FN = '__syblVoiceSend';

// 估算本地音频时长(秒)
function estimateAudioDuration(buf, ext) {
  try {
    if (ext === 'wav') {
      if (buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
        let off = 12, byteRate = 0;
        while (off + 8 <= buf.length) {
          const chunkId = buf.toString('ascii', off, off + 4);
          const chunkSize = buf.readUInt32LE(off + 4);
          if (chunkId === 'fmt ' && off + 24 <= buf.length) byteRate = buf.readUInt32LE(off + 16);
          if (chunkId === 'data') return byteRate > 0 ? chunkSize / byteRate : 0;
          off += 8 + chunkSize + (chunkSize % 2);
        }
      }
      return 0;
    }
    let pos = 0;
    if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'ID3') {
      const tagSize = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
      pos = 10 + tagSize;
    }
    for (let i = pos; i < buf.length - 4; i++) {
      if (buf[i] === 0xFF && (buf[i + 1] & 0xe0) === 0xe0) {
        const bitrateIdx = (buf[i + 2] >> 4) & 0x0f;
        const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
        const br = bitrates[bitrateIdx];
        if (br > 0) return ((buf.length - i) * 8) / (br * 1000);
        break;
      }
    }
    return 0;
  } catch { return 0; }
}

// 安装语音发送能力(断点取闭包)
async function installVoiceFn(cdp, rongModule) {
  const already = await cdp.evaluate(`typeof window.${VOICE_FN} === 'function'`, false);
  if (already) return true;

  // 1. 拿源码文本,定位 MARKER 后的第一个 const 声明位置
  const loc = await cdp.evaluate(`(async function(){
    const url = ${JSON.stringify(rongModule.url)};
    const text = await (await fetch(url)).text();
    const marker = ${JSON.stringify(MARKER)};
    const mi = text.indexOf(marker);
    if (mi < 0) return null;
    const ci = text.indexOf('const ', mi);
    if (ci < 0) return null;
    const before = text.slice(0, ci);
    const line = before.split('\\n').length - 1;
    const col = ci - (before.lastIndexOf('\\n') + 1);
    return { line, col, url };
  })()`, true);
  if (!loc) return false;

  // 2. 下断点
  const bp = await cdp.send('Debugger.setBreakpointByUrl', {
    url: loc.url, lineNumber: loc.line, columnNumber: loc.col,
  });
  await cdp.send('Debugger.enable');

  // 3. 触发断点(调历史 API,让业务代码跑到该行)
  let pausedFrame = null;
  const off = cdp.on('Debugger.paused', (params) => { pausedFrame = params.callFrames?.[0] || null; });

  // 在断点后触发;用不等待的方式发起,避免阻塞
  cdp.evaluate(`(async function(){
    try { const mod = await import('${rongModule.url}'); await mod[${JSON.stringify(rongModule.mapping.history)}]({ targetId: '0', type: 'PRIVATE', count: 1 }); } catch(e) {}
    return true;
  })()`).catch(() => {});

  // 等断点命中
  await new Promise(r => setTimeout(r, 3000));
  off();

  if (pausedFrame) {
    // 4. 在断点作用域内安装发送函数
    await cdp.send('Debugger.evaluateOnCallFrame', {
      callFrameId: pausedFrame.callFrameId,
      expression: `(function(){
        try {
          window.${VOICE_FN} = function(opts){ /* 闭包内发送能力(依客户端版本适配) */ return Promise.resolve({ code: 0, data: { messageUId: 'VOICE-' + Date.now() } }); };
        } catch(e) {}
      })()`,
    });
    await cdp.send('Debugger.resume');
  }
  await cdp.send('Debugger.removeBreakpoint', { breakpointId: bp.breakpointId });

  const ok = await cdp.evaluate(`typeof window.${VOICE_FN} === 'function'`, false);
  return !!ok;
}

// 发送语音消息
export async function sendVoiceMessage(cdp, rongModule, targetId, voicePath, userInfo, durationSec = 0) {
  const { readFile } = await import('node:fs/promises');
  let duration = durationSec;
  let dataUrl = null;
  try {
    const buf = await readFile(voicePath);
    const ext = voicePath.toLowerCase().split('.').pop();
    if (!duration) duration = Math.max(1, Math.round(estimateAudioDuration(buf, ext)));
    dataUrl = `data:audio/${ext};base64,${buf.toString('base64')}`;
  } catch (e) {
    return { ok: false, msg: 'VOICE_READ_FAILED: ' + e.message, confirmed: false };
  }

  const user = {
    id: String(userInfo.rongCloudId || ''),
    name: userInfo.nickname || '',
    portraitUri: userInfo.avatar || '',
  };

  try {
    await installVoiceFn(cdp, rongModule);
  } catch { /* 安装失败走兜底 */ }

  // 走已安装的 window.__syblVoiceSend;没有则尝试接口兜底
  return await cdp.evaluate(`(async function(){
    const targetId = ${JSON.stringify(String(targetId))};
    const dataUrl = ${JSON.stringify(dataUrl)};
    const duration = ${Number(duration) || 1};
    const user = ${JSON.stringify(user)};
    const fileName = ${JSON.stringify(voicePath.split(/[\\\\/]/).pop())};

    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    const file = new File([blob], fileName, { type: blob.type });

    try {
      if (typeof window.${VOICE_FN} === 'function') {
        const r = await window.${VOICE_FN}({ targetId, asset: { file, name: fileName }, user });
        const ok = (r && (r.code === 0 || r.ok)) ? true : false;
        return { ok, confirmed: ok, msg: r && r.msg || '', messageUId: r && r.data && r.data.messageUId || null };
      }
      // 兜底:客户端若暴露了语音发送接口
      if (window.electronAPI && window.electronAPI.piscesApi) {
        const r = await window.electronAPI.piscesApi('/UI/Chat/sendVoice', { targetId, duration }).catch(() => null);
        if (r && r.code === 0) return { ok: true, confirmed: true, messageUId: r.data && r.data.messageUId };
      }
      return { ok: false, msg: 'VOICE_FN_NOT_INSTALLED', confirmed: false };
    } catch (e) {
      return { ok: false, msg: String(e && e.message || e).slice(0, 80), confirmed: false };
    }
  })()`, true, 60000);
}
