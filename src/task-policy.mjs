import { normalizeTargets } from './target-policy.mjs';
const invalid = reason => ({ ok: false, reason });
const number = v => typeof v === 'number' && Number.isFinite(v);

export function validatePrivateConfig(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return invalid('INVALID_CONFIG');
  if (!['random', 'select'].includes(config.mode ?? 'random')) return invalid('UNSUPPORTED_MODE: 当前仅支持文字发送');
  if (config.image?.enable || config.voice?.enable) return invalid('UNSUPPORTED_MEDIA: Android 图片/语音发送尚未实现，请关闭附件');
  const contents = config.contents;
  if (!Array.isArray(contents) || !contents.length || contents.some(t => typeof t !== 'string' || !t.trim())) return invalid('EMPTY_CONTENT: 请填写有效文字文案');
  if (config.mode === 'select' && (!Number.isInteger(config.selectedIndex) || !contents[config.selectedIndex])) return invalid('INVALID_SELECTED_CONTENT');
  const min = config.delayMin ?? 15, max = config.delayMax ?? 40, limit = config.sendLimit ?? 0;
  if (!number(min) || !number(max) || min < 0 || max < min || max > 86400) return invalid('INVALID_DELAY: 延迟应为有效数字且最小值不大于最大值');
  if (!Number.isSafeInteger(limit) || limit < 0) return invalid('INVALID_SEND_LIMIT');
  if (config.executionMode != null && !['android', 'demo'].includes(config.executionMode)) return invalid('INVALID_EXECUTION_MODE');
  const demo = config.executionMode === 'demo';
  const checked = normalizeTargets(config.targets || config.targetIds, { demo });
  if (checked.rejected.length) return { ...invalid('INVALID_TARGETS: 存在演示、占位或不合法来源/用户ID'), ...checked };
  if (!checked.targets.length) return invalid('NO_TARGETS');
  return { ok: true, config: { ...config, mode: config.mode ?? 'random', contents: [...contents], delayMin: min, delayMax: max, sendLimit: limit, executionMode: demo ? 'demo' : 'android', targets: checked.targets }, duplicates: checked.duplicates };
}

export function validateCallConfig(config = {}) {
  const delayMin = config.delayMin ?? 3, delayMax = config.delayMax ?? 5;
  if (!number(delayMin) || !number(delayMax) || delayMin < 1 || delayMax < delayMin || delayMax > 86400) return invalid('INVALID_DELAY');
  if (config.executionMode != null && !['android', 'demo'].includes(config.executionMode)) return invalid('INVALID_EXECUTION_MODE');
  return { ok: true, config: { ...config, delayMin, delayMax, emoji: config.emoji || '打call' } };
}
