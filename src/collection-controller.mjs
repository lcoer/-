import { RoomNavigator } from './room-navigator.mjs';
import { scanRoomMembers } from './member-scanner.mjs';
import { resolveVisibleRoomUsers } from './room-user-resolver.mjs';
import { abortableSleep, throwIfAborted, isAbortError } from './async-control.mjs';
export class CollectionController {
  constructor(driver, opts = {}) {
    this.driver = driver;
    this.opts = opts;
    this.onUsers = opts.onUsers || (() => {
    });
    this.onLog = opts.onLog || (() => {
    });
    this.onRoom = opts.onRoom || (() => {
    });
    this.onError = opts.onError || (() => {
    });
    this.onProgress = opts.onProgress || (() => {
    });
    this.scope = opts.scope || 'single';
    this.intervalMs = opts.intervalMs || 1500;
    this.roomName = opts.roomName || null;
    this.maxRooms = opts.maxRooms || 12;
    this.scanMembers = opts.scanMembers !== false;
    this.memberScanner = opts.memberScanner || scanRoomMembers;
    this.userResolver = opts.userResolver || resolveVisibleRoomUsers;
    this.resolvedHintCache = new Map();
    this.profileAttempts = new Map();
    this.navigator = opts.navigator || null;
    this.clock = opts.clock || Date.now;
    this.stopped = true;
    this.rounds = 0;
    this.cycleNumber = 1;
    this.lastRoom = null;
    this.roomCode = null;
    this.consecutiveErrors = 0;
    this.knownVerified = new Set(opts.knownVerifiedUids || []);
    this.knownRoomNames = new Set(opts.knownRoomNames || []);
    this.sessionVerified = new Set();
    this.visitedRooms = new Set();
    this.published = new Map();
    this.memberScans = new Map();
    this.stats = { newVerified: 0, newUnverified: 0, duplicateSightings: 0, pagesScanned: 0, profilesRead: 0, newRecords: 0, newVerifiedRecords: 0, lastNewAt: null, memberStatus: 'not_scanned', profileStatus: 'not_checked', scanDurationMs: 0, lastRoundNew: 0 };
    this.advance = false;
    this.cycleWait = false;
    this.cooldownMs = opts.cooldownMs ?? 15000;
  }
  log(level, message) {
    this.onLog(level, message);
  }
  _progress() {
    if (!this.stopped && !this.signal?.aborted)
      this.onProgress(this.getStatus());
  }
  _makeNavigator() {
    return new RoomNavigator(this.driver, { signal: this.signal, maxRooms: this.maxRooms, knownRoomNames: [...this.knownRoomNames], onLog: (l, m) => this.log(l, m) });
  }
  async start({ intervalMs, signal } = {}) {
    if (!this.stopped)
      return { ok: false, reason: 'ALREADY_RUNNING' };
    throwIfAborted(signal);
    if (intervalMs)
      this.intervalMs = intervalMs;
    this.controller = new AbortController();
    this.externalSignal = signal;
    this.externalAbort = () => this.controller.abort();
    signal?.addEventListener('abort', this.externalAbort, { once: true });
    if (signal?.aborted)
      this.controller.abort();
    this.signal = this.controller.signal;
    this.driver.setSignal?.(this.signal);
    if (this.navigator)
      this.navigator.signal = this.signal;
    else if (this.driver.bridge)
      this.navigator = this._makeNavigator();
    this.stopped = false;
    const collect = async () => {
      try {
        await this._collectOnce();
      }
      catch (e) {
        if (!isAbortError(e) && !this.stopped) {
          this.consecutiveErrors++;
          this.onError(e.message);
          this.log('warn', e.message);
          this._progress();
        }
      }
    };
    this.pending = collect();
    await this.pending;
    if (!this.stopped && !this.signal.aborted) {
      this.pending = (async () => {
        while (!this.stopped) {
          try {
            await abortableSleep(this.cycleWait ? this.cooldownMs : this.intervalMs, this.signal);
            if (this.cycleWait) {
              this.cycleWait = false;
              this.advance = false;
              this.navigator = this._makeNavigator();
              this.cycleNumber++;
            }
            throwIfAborted(this.signal);
            await collect();
          }
          catch (e) {
            if (isAbortError(e))
              break;
            throw e;
          }
        }
      })();
    }
    return { ok: true, intervalMs: this.intervalMs, scope: this.scope };
  }
  async stop() {
    this.stopped = true;
    this.controller?.abort();
    await this.pending;
    this.externalSignal?.removeEventListener('abort', this.externalAbort);
    return { ok: true, rounds: this.rounds, ...this.getStatus() };
  }
  getStatus() {
    return { running: !this.stopped, scope: this.scope, rounds: this.rounds, intervalMs: this.intervalMs, room: this.lastRoom, roomCode: this.roomCode,
      roomsVisited: this.visitedRooms.size, uniqueVerified: this.sessionVerified.size, cycleNumber: this.cycleNumber,
      waitingForNextCycle: this.cycleWait, failedRooms: this.navigator?.getStatus?.().failed || 0, ...this.stats };
  }
  async _isInRoom() {
    try {
      const r = await this.driver.adb.sh('dumpsys activity activities');
      const top = r.out.match(/topResumedActivity=\S+\s+\S+\s+(\S+)/)?.[1] || '';
      return top.startsWith('com.sybl.voiceroom/') && top.includes('RoomPageActivity');
    }
    catch (e) {
      if (isAbortError(e))
        throw e;
      return false;
    }
  }
  async _meta() {
    if (this.navigator) {
      if (this.scope === 'multi' && this.advance) {
        this.advance = false;
        return this.navigator.nextRoom();
      }
      return this.navigator.ensureRoom({ preferredRoomName: this.roomName || undefined });
    }
    // Compatibility for standalone drivers without the new bridge navigator.
    if (!await this._isInRoom())
      throw Error('NOT_IN_ROOM');
    const { nodes } = await this.driver.dumpRoom();
    return { nodes, room: this.opts.extractRoomName(nodes) || this.roomName || '当前房间', roomCode: this.opts.extractRoomCode(nodes), onlineCount: this.opts.extractOnlineCount(nodes) };
  }
  async _publish(users, meta) {
    throwIfAborted(this.signal);
    if (this.stopped)
      return;
    const now = this.clock(), fresh = [];
    let duplicates = 0;
    for (const user of users) {
      if (!user.uidReal && this.resolvedHintCache.has(user.uid)) {
        duplicates++;
        continue;
      }
      if (user.uidReal)
        this.sessionVerified.add(user.uid);
      const record = { ...user, room: meta.room, roomCode: meta.roomCode || null, lastSeenAt: now, ts: now };
      const signature = JSON.stringify([record.nickname, record.sex, record.guild, record.guildKnown, record.rongCloudId, record.room, record.roomCode]);
      const prior = this.published.get(record.uid);
      if (prior && prior.signature === signature && now - prior.at < (this.opts.observationRefreshMs || 30000)) {
        duplicates++;
        continue;
      }
      fresh.push({ record, signature });
    }
    this.stats.duplicateSightings += duplicates;
    if (!fresh.length)
      return;
    const result = await this.onUsers(fresh.map(v => v.record), { room: meta.room, roomCode: meta.roomCode, ts: now });
    throwIfAborted(this.signal);
    if (this.stopped)
      return;
    for (const { record, signature } of fresh) {
      if (record.uidReal && !this.knownVerified.has(record.uid)) {
        this.knownVerified.add(record.uid);
        this.stats.newVerified++;
        this.stats.lastRoundNew++;
        this.stats.lastNewAt = now;
      }
      else if (!record.uidReal && !this.published.has(record.uid))
        this.stats.newUnverified++;
      this.published.set(record.uid, { signature, at: now });
    }
    this.stats.newRecords += result?.added || 0;
    this.stats.newVerifiedRecords += result?.addedVerified || 0;
    this._progress();
  }
  async _collectOnce() {
    throwIfAborted(this.signal);
    if (this.stopped)
      return;
    const started = this.clock();
    const meta = await this._meta();
    throwIfAborted(this.signal);
    if (this.stopped)
      return;
    if (!meta) {
      this.cycleWait = true;
      const nav = this.navigator?.getStatus?.();
      this.stats.navigationStatus = nav?.visitedCount >= this.maxRooms ? 'limit' : nav?.exhausted ? 'exhausted' : 'retry';
      this.log('info', this.stats.navigationStatus === 'retry' ? '暂未确认更多可访问房间，稍后重试。' : '已达到本轮访问范围，稍后继续下一轮。');
      this._progress();
      return;
    }
    this.stats.navigationStatus = 'scanning';
    this.stats.lastRoundNew = 0;
    for (const [key, value] of this.resolvedHintCache)
      if (this.clock() - value.at > 120000)
        this.resolvedHintCache.delete(key);
    this.lastRoom = meta.room;
    this.roomCode = meta.roomCode || null;
    const roomKey = meta.roomCode || meta.room;
    this.visitedRooms.add(roomKey);
    this.knownRoomNames.add(meta.room);
    this.onRoom(meta.room);
    let visibleUsers = this.opts.extractUsers(meta.nodes, { room: meta.room, roomCode: meta.roomCode, now: this.clock() });
    await this._publish(visibleUsers, meta);
    if (this.scanMembers && this.driver.bridge && !this.signal?.aborted && this.clock() - (this.memberScans.get(roomKey) ?? -Infinity) >= 30000) {
      const result = await this.memberScanner(this.driver, { ...meta, signal: this.signal, maxPages: this.opts.maxPages || 6, maxDurationMs: this.opts.memberBudgetMs || 6000,
        onLog: (l, m) => this.log(l, m), onUsers: users => this._publish(users, meta) });
      throwIfAborted(this.signal);
      if (this.stopped)
        return;
      this.memberScans.set(roomKey, this.clock());
      this.stats.pagesScanned += result.pages;
      this.stats.memberStatus = result.status;
      // The scanner closes its observed popup; read the room once more for late public messages.
      const next = this.navigator ? await this.navigator.ensureRoom({ preferredRoomName: this.roomName || undefined }) : null;
      if (next?.roomCode === meta.roomCode) {
        visibleUsers = this.opts.extractUsers(next.nodes, { room: meta.room, roomCode: meta.roomCode, now: this.clock() });
        await this._publish(visibleUsers, meta);
      }
    }
    if (this.opts.resolveUsers !== false && this.driver.bridge && visibleUsers.some(u => !u.uidReal || !['male','female'].includes(u.sex))) {
      const profileLimit=this.opts.maxProfiles??6;
      const resolved = await this.userResolver(this.driver, visibleUsers, { ...meta, signal: this.signal, maxProfiles:profileLimit, maxDurationMs:Math.min(30000,5000+profileLimit*4000), knownMappings: this.resolvedHintCache,attemptHistory:this.profileAttempts,
        onLog: (l, m) => this.log(l, m), onUser: async (record) => {
          await this._publish([record], meta);
          const cached={uid:record.uid,sex:record.sex||'unknown',at:this.clock(),retryAfter:this.clock()+10000};
          this.resolvedHintCache.set(record.resolvedFrom,cached);
          this.resolvedHintCache.set(record.uid,cached);
        } });
      this.stats.profilesRead += resolved.profilesRead;
      this.stats.profileStatus = resolved.reason;
    }
    throwIfAborted(this.signal);
    if (this.stopped)
      return;
    this.rounds++;
    this.consecutiveErrors = 0;
    this.stats.scanDurationMs = Math.max(0, this.clock() - started);
    this.log('info', `本轮新发现真实UID ${this.stats.lastRoundNew}，本次累计 ${this.stats.newVerified}；已访问 ${this.visitedRooms.size} 个房间，成员扫描 ${this.stats.pagesScanned} 页`);
    this.advance = this.scope === 'multi' && !this.roomName;
    this._progress();
  }
}
