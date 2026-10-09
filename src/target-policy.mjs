// Shared pure policy; the main process always rechecks renderer input.
export function parseLocalTargets(value = '') {
  return String(value).split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(line => {
    const m = /^(\S+?)(?:[,，]\s*|\s+)(.*)$/.exec(line);
    const uid = m ? m[1] : line;
    return { uid, nickname: m?.[2]?.trim() || null, source: 'local', uidReal: /^\d+$/.test(uid) };
  });
}

export function normalizeTargets(input, { demo = false } = {}) {
  const targets = [], rejected = [], duplicates = [], seen = new Set();
  for (const raw of Array.isArray(input) ? input : []) {
    const t = raw && typeof raw === 'object' ? raw : { uid: raw, source: 'local' };
    const uid = String(t.uid ?? '').trim();
    const nickname = typeof t.nickname === 'string' ? t.nickname.trim() : '';
    let reason = null;
    if (!/^\d+$/.test(uid) || t.uidReal === false) reason = 'UID_NOT_VERIFIED';
    else if (!demo && !['local', 'room'].includes(t.source)) reason = 'INVALID_TARGET_SOURCE';
    if (reason) { rejected.push({ uid, reason }); continue; }
    if (seen.has(uid)) { duplicates.push(uid); continue; }
    seen.add(uid);
    targets.push({ ...t, uid, nickname: nickname || null, uidReal: true });
  }
  return { targets, rejected, duplicates };
}
