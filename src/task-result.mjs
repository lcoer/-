const outcomes = new Set(['confirmed_ui', 'failed', 'unconfirmed', 'cancelled', 'skipped', 'simulated']);
export function normalizeResult(result = {}, context = {}) {
  const mode = context.mode || 'android';
  let outcome = mode === 'demo' ? 'simulated' : (outcomes.has(result.outcome) && result.outcome !== 'simulated' ? result.outcome : 'unconfirmed');
  const e = result.evidence || {};
  if (outcome === 'confirmed_ui' && !(e.inputMatched === true && e.inputCleared === true && Number.isInteger(e.beforeExactCount) && Number.isInteger(e.afterExactCount) && e.afterExactCount > e.beforeExactCount && String(e.actualUid) === context.targetUid)) outcome = 'unconfirmed';
  return { ...result, ...context, mode, outcome, ok: outcome === 'confirmed_ui', stage: result.stage || 'verify', reason: result.reason || null, evidence: result.evidence || {} };
}
export function countResult(stats, result) {
  if (result.outcome !== 'skipped') stats.sent = (stats.sent || 0) + 1;
  const key = { confirmed_ui: 'ok', failed: 'fail', unconfirmed: 'unconfirmed', cancelled: 'cancelled', skipped: 'skipped', simulated: 'simulated' }[result.outcome];
  if (key) stats[key] = (stats[key] || 0) + 1;
  return stats;
}
