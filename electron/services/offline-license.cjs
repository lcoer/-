const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const DAY = 86400000;
const MESSAGES = {
  REQUIRED: '请输入激活码完成激活', INVALID_FORMAT: '激活码格式不正确',
  INVALID_CODE: '激活码无效，请检查后重试', CODE_USED: '激活码已使用',
  EXPIRED: '授权已过期，请使用新的激活码', CLOCK_ROLLBACK: '系统时间异常，请校准时间后重试',
  STORAGE: '无法安全读取或保存授权，请检查系统凭据保护和文件权限后重试',
  CORRUPT: '本机授权记录损坏，请联系软件提供方', NOT_CONFIGURED: '激活验证公钥尚未配置，请联系软件提供方',
  CLOSED: '授权验证已关闭，请重新打开软件',
};

function createOfflineLicense({ config = {}, dataDir, encrypt, decrypt, wallClock = Date.now, monotonicClock = () => performance.now(), onChange = () => {} }) {
  let status = { active: false, state: 'activation_required', reason: MESSAGES.REQUIRED, expiresAt: null };
  let record, initialized = false, closed = false, inFlight, verifier, blockedReason;
  let timer, expiryTimer, anchorNow = 0, anchorMono = 0, anchorId;
  const file = path.join(dataDir, 'credential-v1.bin');
  try { verifier = crypto.createPublicKey(config.publicKey); if (verifier.asymmetricKeyType !== 'ed25519') verifier = undefined; } catch {}

  function emit(active, state, reason, expiresAt = status.expiresAt) {
    const changed = status.active !== active || status.state !== state || status.reason !== reason || status.expiresAt !== expiresAt;
    status = { active, state, reason, expiresAt };
    if (changed) try { Promise.resolve(onChange({ ...status })).catch(() => {}); } catch {}
    return { ...status };
  }
  function stopTimers() { clearTimeout(timer); clearTimeout(expiryTimer); timer = expiryTimer = undefined; }
  function fault(reason, state = 'suspended') {
    if (['STORAGE','CORRUPT','CLOCK_ROLLBACK','NOT_CONFIGURED'].includes(reason)) blockedReason = reason;
    stopTimers(); return emit(false, state, MESSAGES[reason], record?.active?.expiresAt ?? null);
  }
  function serialized(work) {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      if (closed) return fault('CLOSED');
      try { return await work(); } catch { return fault('STORAGE'); }
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  }
  function verifyCode(code) {
    if (typeof code !== 'string' || code.length > 4096) throw Error('INVALID_FORMAT');
    const parts = code.trim().split('.');
    if (parts.length !== 3 || parts[0] !== 'SYBL1' || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) throw Error('INVALID_FORMAT');
    const bytes = Buffer.from(parts[1], 'base64url'), signature = Buffer.from(parts[2], 'base64url');
    if (bytes.toString('base64url') !== parts[1] || signature.toString('base64url') !== parts[2] || signature.length !== 64 || !crypto.verify(null, bytes, verifier, signature)) throw Error('INVALID_CODE');
    let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { throw Error('INVALID_CODE'); }
    if (value.version !== 1 || value.productId !== 'shuangyu-assistant' || typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id) || !Number.isSafeInteger(value.durationDays) || value.durationDays < 1 || value.durationDays > 3650 || !Number.isSafeInteger(value.issuedAt) || value.issuedAt < 0) throw Error('INVALID_CODE');
    return { value, payload: parts[1], signature: parts[2], codeHash: crypto.createHash('sha256').update(parts.join('.')).digest('hex') };
  }
  function validateRecord(data) {
    if (!data || !Array.isArray(data.usedCodeIds) || new Set(data.usedCodeIds).size !== data.usedCodeIds.length || data.usedCodeIds.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) || !Number.isSafeInteger(data.lastSeenAt) || data.lastSeenAt < 0) throw Error();
    if (data.active) {
      const a = data.active;
      const verified = verifyCode('SYBL1.' + a.payload + '.' + a.signature);
      if (a.id !== verified.value.id || a.codeHash !== verified.codeHash || !data.usedCodeIds.includes(a.id) || !Number.isSafeInteger(a.activatedAt) || a.activatedAt < 0 || !Number.isSafeInteger(a.expiresAt) || a.expiresAt !== a.activatedAt + verified.value.durationDays * DAY || data.lastSeenAt < a.activatedAt) throw Error();
    }
    return data;
  }
  async function save(next) {
    if (typeof encrypt !== 'function' || typeof decrypt !== 'function') throw Error();
    const bytes = await encrypt(Buffer.from(JSON.stringify(next), 'utf8'));
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw Error();
    await fs.mkdir(dataDir, { recursive: true });
    const tmp = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      await fs.writeFile(tmp, bytes, { flag: 'wx', mode: 0o600 });
      // Windows antivirus/indexing may briefly lock the destination. Keep the
      // old credential intact and retry only transient replacement failures.
      const delays = [25, 50, 100];
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(tmp, file); break; }
        catch (error) {
          if (!['EPERM', 'EBUSY'].includes(error.code) || attempt >= delays.length) throw error;
          await new Promise(resolve => setTimeout(resolve, delays[attempt]));
        }
      }
    }
    finally { await fs.unlink(tmp).catch(() => {}); }
    record = next;
  }
  function effectiveNow() {
    const wall = wallClock();
    if (!Number.isSafeInteger(wall) || wall < 0 || wall < record.lastSeenAt - 5 * 60000) throw Error('CLOCK_ROLLBACK');
    const elapsed = anchorId === record.active?.id ? Math.max(0, monotonicClock() - anchorMono) : 0;
    return Math.max(wall, record.lastSeenAt, anchorId === record.active?.id ? anchorNow + elapsed : 0);
  }
  function inspect() {
    if (closed) return fault('CLOSED');
    if (blockedReason) return { ...status };
    if (!initialized) return { ...status };
    let now; try { now = effectiveNow(); } catch { return fault('CLOCK_ROLLBACK'); }
    if (!record.active) return emit(false, 'activation_required', MESSAGES.REQUIRED, null);
    if (now >= record.active.expiresAt) return fault('EXPIRED', 'expired');
    if (anchorId !== record.active.id) { anchorId = record.active.id; anchorNow = now; anchorMono = monotonicClock(); }
    return emit(true, 'active', '', record.active.expiresAt);
  }
  function armTimers() {
    stopTimers();
    if (!status.active || closed) return;
    const remaining = record.active.expiresAt - effectiveNow();
    // setTimeout cannot represent intervals beyond signed 32-bit milliseconds.
    expiryTimer = setTimeout(() => { inspect(); if (status.active) armTimers(); }, Math.min(remaining, 2147483647)); expiryTimer.unref?.();
    timer = setTimeout(() => { retry(); }, Math.min(60000, remaining)); timer.unref?.();
  }
  async function initializeCore() {
    if (initialized) return inspect();
    if (!verifier) return fault('NOT_CONFIGURED', 'not_configured');
    let raw;
    try { raw = await fs.readFile(file); } catch (error) { if (error.code !== 'ENOENT') return fault('STORAGE'); }
    if (raw) {
      try {
        const plaintext = await decrypt(raw);
        record = validateRecord(JSON.parse(Buffer.isBuffer(plaintext) ? plaintext.toString('utf8') : plaintext));
      } catch { return fault('CORRUPT'); }
    } else {
      const now = wallClock(); if (!Number.isSafeInteger(now) || now < 0) return fault('CLOCK_ROLLBACK');
      record = { usedCodeIds: [], active: null, lastSeenAt: now };
    }
    initialized = true;
    blockedReason = undefined;
    const value = inspect(); armTimers(); return value;
  }
  function initialize() { return serialized(initializeCore); }
  function activate(code) {
    return serialized(async () => {
      await initializeCore(); if (!initialized || !verifier) return { ...status };
      blockedReason = undefined;
      let now; try { now = effectiveNow(); } catch { return fault('CLOCK_ROLLBACK'); }
      let verified; try { verified = verifyCode(code); } catch (error) { return emit(false, 'activation_required', MESSAGES[error.message] || MESSAGES.INVALID_CODE); }
      if (record.usedCodeIds.includes(verified.value.id)) return emit(false, 'activation_required', MESSAGES.CODE_USED);
      now = Math.floor(now);
      const active = { id: verified.value.id, codeHash: verified.codeHash, payload: verified.payload, signature: verified.signature, activatedAt: now, expiresAt: now + verified.value.durationDays * DAY };
      if (!Number.isSafeInteger(active.expiresAt)) return fault('CLOCK_ROLLBACK');
      await save({ usedCodeIds: [...record.usedCodeIds, active.id], active, lastSeenAt: now });
      anchorId = undefined;
      const value = inspect(); armTimers(); return value;
    });
  }
  function retry() {
    return serialized(async () => {
      if (!initialized) return initializeCore();
      blockedReason = undefined;
      const value = inspect();
      if (value.reason === MESSAGES.CLOCK_ROLLBACK || closed) return value;
      if (record.active) await save({ ...record, lastSeenAt: Math.floor(effectiveNow()) });
      armTimers(); return { ...status };
    });
  }
  function getStatus() { return inspect(); }
  function assertActive() { const value = getStatus(); if (!value.active) throw Error(value.reason); }
  function ensureActive() { return retry(); }
  function close() { closed = true; stopTimers(); emit(false, 'suspended', MESSAGES.CLOSED); }
  return { initialize, activate, retry, getStatus, assertActive, ensureActive, close };
}
module.exports = { createOfflineLicense };
