// CJS lets task-runner acquire synchronously before its first await.
class DeviceSession {
  constructor() {
    this.current = null;
  }
  acquire({ owner, runId, serial = null }) {
    if (this.current)
      return { ok: false, reason: 'DEVICE_BUSY', owner: this.current.owner };
    this.current = { owner, runId, serial };
    return { ok: true, ...this.current };
  }
  release(owner, runId) {
    if (this.current?.owner !== owner || this.current.runId !== runId)
      return false;
    this.current = null;
    return true;
  }
  getStatus() {
    return this.current ? { ...this.current } : null;
  }
}
module.exports = { DeviceSession };
