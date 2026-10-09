// Shared by the UI observer and the durable journal. A historical error or a
// generic failure icon cannot resolve an uncertain dispatch.
const APP = 'com.sybl.voiceroom';
const REASON = 'ACCOUNT_CONTRIBUTION_LEVEL_REQUIRED';
const HINT = '您当前的贡献等级不够，快去直播看看吧。';
const rect = n => n && ['x', 'y', 'x2', 'y2'].every(k => Number.isFinite(n[k])) && n.x >= 0 && n.y >= 0 && n.x2 > n.x && n.y2 > n.y;
const contains = (outer, inner) => rect(outer) && rect(inner) && inner.x >= outer.x && inner.y >= outer.y && inner.x2 <= outer.x2 && inner.y2 <= outer.y2;
const bounds = n => ({ x: n.x, y: n.y, x2: n.x2, y2: n.y2 });
const failures = nodes => nodes.filter(n => /error|failed/i.test(n.shortId || '') && n.enabled !== false);
function failureMessageIndex(nodes, indicator) {
  if (indicator.packageName !== APP || !rect(indicator)) return -1;
  const lists = nodes.filter(n => n.shortId === 'rc_message_list' && n.packageName === APP && contains(n, indicator));
  const texts = nodes.filter(n => n.shortId === 'rc_text');
  const rows = nodes.filter(n => n.className === 'android.widget.LinearLayout' && n.packageName === APP && lists.some(list => contains(list, n)) && contains(n, indicator));
  rows.sort((a, b) => (a.x2 - a.x) * (a.y2 - a.y) - (b.x2 - b.x) * (b.y2 - b.y));
  const row = rows[0];
  if (!row) return -1;
  const messages = texts.filter(n => contains(row, n) && n.packageName === APP);
  return messages.length === 1 ? texts.indexOf(messages[0]) : -1;
}
function hasUncertainSendFailure(before, after, text) {
  const indicators = failures(after);
  const baselineIndicators = failures(before);
  if (!indicators.length && !baselineIndicators.length) return false;
  const oldMessages = before.filter(n => n.shortId === 'rc_text');
  const messages = after.filter(n => n.shortId === 'rc_text');
  // Without the complete ordered history plus one appended exact bubble, an
  // error cannot be assigned to the old history. Coordinates may move freely.
  if (messages.length !== oldMessages.length + 1 || messages.at(-1)?.text !== text || oldMessages.some((n, i) => n.text !== messages[i].text)) return true;
  const oldFailures = new Map();
  for (const indicator of baselineIndicators) {
    const index = failureMessageIndex(before, indicator);
    if (index < 0) continue;
    const key = `${index}:${indicator.shortId}:${indicator.text || ''}`;
    oldFailures.set(key, (oldFailures.get(key) || 0) + 1);
  }
  for (const indicator of indicators) {
    const index = failureMessageIndex(after, indicator);
    if (index < 0 || index >= oldMessages.length) return true;
    const key = `${index}:${indicator.shortId}:${indicator.text || ''}`;
    const count = oldFailures.get(key) || 0;
    if (!count) return true;
    oldFailures.set(key, count - 1);
  }
  return false;
}
function proveSendRejection(before, after, text) {
  const oldTexts = before.filter(n => n.shortId === 'rc_text');
  const texts = after.filter(n => n.shortId === 'rc_text');
  // Require an append to the observed history, not a replaced/scrolled window.
  if (texts.length !== oldTexts.length + 1 || oldTexts.some((n, i) => n.text !== texts[i].text)) return null;
  const message = texts.at(-1);
  if (message.text !== text || message.packageName !== APP || !rect(message)) return null;
  const hints = after.filter(n => n.shortId === 'rc_errorhint' && n.packageName === APP && n.text === HINT && rect(n) && failureMessageIndex(after, n) === texts.length - 1);
  if (hints.length !== 1) return null;
  const hint = hints[0];
  const list = after.find(n => n.shortId === 'rc_message_list' && n.packageName === APP && contains(n, message) && contains(n, hint));
  if (!list || hint.y < message.y2 || hint.y - message.y2 > 160) return null;
  // The smallest LinearLayout containing the hint and message must contain
  // exactly one bubble, plus the app's outgoing portrait on the same line.
  const rows = after.filter(n => n.className === 'android.widget.LinearLayout' && n.packageName === APP && contains(list, n) && contains(n, message) && contains(n, hint));
  rows.sort((a, b) => (a.x2 - a.x) * (a.y2 - a.y) - (b.x2 - b.x) * (b.y2 - b.y));
  const row = rows[0];
  if (!row || texts.filter(n => contains(row, n)).length !== 1) return null;
  const portraits = after.filter(n => n.shortId === 'rc_right_portrait' && n.packageName === APP && contains(row, n) && n.x >= message.x2 && n.y < message.y2 && n.y2 > message.y);
  if (portraits.length !== 1) return null;
  return { kind: 'new_outgoing_row_rejection', reason: REASON, hintId: 'rc_errorhint', hintText: HINT, text, beforeMessageCount: oldTexts.length, afterMessageCount: texts.length, messageBounds: bounds(message), hintBounds: bounds(hint), rowBounds: bounds(row), packageName: APP };
}
function isDefinitiveSendRejection(result, targetUid) {
  const e = result?.evidence, p = e?.rejection;
  return !!(result?.outcome === 'failed' && result.reason === REASON && e?.inputMatched === true && /^\d+$/.test(String(targetUid)) && String(e.actualUid) === String(targetUid)
    && Number.isInteger(e.beforeExactCount) && e.beforeExactCount >= 0 && e.afterExactCount === e.beforeExactCount + 1
    && p?.kind === 'new_outgoing_row_rejection' && p.reason === REASON && p.hintId === 'rc_errorhint' && p.hintText === HINT && p.packageName === APP && typeof p.text === 'string' && p.text.trim()
    && Number.isInteger(p.beforeMessageCount) && p.beforeMessageCount >= 0 && p.afterMessageCount === p.beforeMessageCount + 1
    && contains(p.rowBounds, p.messageBounds) && contains(p.rowBounds, p.hintBounds) && p.hintBounds.y >= p.messageBounds.y2 && p.hintBounds.y - p.messageBounds.y2 <= 160);
}
exports.proveSendRejection = proveSendRejection;
exports.isDefinitiveSendRejection = isDefinitiveSendRejection;
exports.hasUncertainSendFailure = hasUncertainSendFailure;
