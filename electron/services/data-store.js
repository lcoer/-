// electron/services/data-store.js - 数据存储与演示数据流
// 职责:
//   1. 配置持久化(规则/文案/黑名单),存于 userData/config.json
//   2. 采集数据面板的数据供应(演示模式:模拟采集流;实际部署替换为真实数据源)
//   3. 发送统计与当日去重持久化
//
// 说明:参考软件的正式版本通过独立后端(HTTP+MQTT)下发采集数据;
//       默认使用真实采集模式;演示流必须显式开启。

const fs = require('fs');
const path = require('path');
const { createHash } = require('node:crypto');
const appConfig = require('../config');
const {isDefinitiveSendRejection} = require('../../src/send-proof.cjs');

let _app = null;
try { _app = require('electron').app; } catch { _app = null; }

function userDataDir() {
  if (_app) return _app.getPath('userData');
  return path.join(process.cwd(), '.data');
}

function createDataStore({ dataDir, clock = () => Date.now(), persist = true } = {}) {
const nowMs = () => { const value = clock(); return value instanceof Date ? value.getTime() : value; };
const STATE = {
  configFile: null,
  statsFile: null,
  sentFile: null,
  sourceFile: null,
  sourcePref: { source: 'room' },  // 持久化的数据源偏好
  config: {},
  stats: {},
  sentToday: {},          // { 'YYYY-MM-DD': { machineCode: [uid...] } }
  records: [],            // 采集记录(demo 生成的 + 真实房间采集的)
  streamCallback: null,
  connected: true,
  lastEventAt: null,
  timer: null,
  // 数据源:demonstration 生成器 or 真实房间采集
  source: 'room',         // 'demo' | 'room'
  lastCollectAt: null,    // 最近一次真实采集时间
  lastCollectRoom: null,  // 最近一次真实采集所在房间
  collectError: null,     // 最近一次真实采集错误
};

const NICKNAMES_F = ['软糖', '小鹿', '柚子', '琉璃', '安安', '绵绵', '晚风', '桃夭', '阿狸', '清欢'];
const NICKNAMES_M = ['子墨', '阿泽', '陈屿', '陆离', '沐辰', '江枫', '南风', '青栀', '思远', '望舒'];
const ROOMS = ['月下星河', '晚风轻语', '桃夭小筑', '云端茶话', '听雨轩', '拾光里', '鲸落湾', '鹿鸣台'];
const GUILDS = ['', '', '', '星海公会', '拾光社', '鲸落联盟'];

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[randInt(0, arr.length - 1)]; }
function dateStr(d = new Date(nowMs())) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function epoch(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : (/^\d+$/.test(String(value)) ? Number(value) : Date.parse(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// ===== 初始化 =====
function init() {
  shutdown();
  const dir = dataDir || userDataDir();
  STATE.configFile = path.join(dir, 'config.json');
  STATE.statsFile = path.join(dir, 'stats-v2.json');
  STATE.sentFile = path.join(dir, 'sent-v2.json');
  STATE.sourceFile = path.join(dir, 'source.json');
  STATE.recordsFile = path.join(dir, 'records-v2.json');
  STATE.outcomesFile = path.join(dir, 'outcomes-v2.json');
  STATE.config = defaultConfig(); STATE.stats = {}; STATE.sentToday = {}; STATE.records = []; STATE.outcomes = []; STATE.legacyStats = {}; STATE.recoveryRequired = false;
  if (persist) {
    loadJson(STATE.configFile, STATE.config, defaultConfig());
    STATE.config.settings = { executionMode: 'android', ...STATE.config.settings };
    loadJson(STATE.statsFile, STATE.stats, {});
    loadJson(STATE.sentFile, STATE.sentToday, {});
    loadJson(path.join(dir, 'stats.json'), STATE.legacyStats, {});
    loadJson(STATE.sourceFile, STATE.sourcePref, { source: 'room' });
    const history = {}; loadJson(STATE.recordsFile, history, {});
    if (history.schemaVersion === 2 && Array.isArray(history.records)) STATE.records = history.records.map(r => ({...r, lastSeenAt:epoch(r.lastSeenAt,epoch(r.ts,nowMs()))}));
    const results = {}; loadJson(STATE.outcomesFile, results, {}, true);
    if (Object.keys(results).length && (results.schemaVersion !== 2 || !Array.isArray(results.results))) throw Error('DATA_CORRUPT: Invalid outcome journal schema');
    if (results.results?.some(r => !r || typeof r !== 'object' || !Number.isFinite(r.at) || typeof r.targetUid !== 'string' || !['android','demo'].includes(r.mode) || !['confirmed_ui','failed','unconfirmed','cancelled','skipped','simulated'].includes(r.outcome))) throw Error('DATA_CORRUPT: Invalid outcome journal entry');
    if (results.schemaVersion === 2 && Array.isArray(results.results)) STATE.outcomes = results.results;
  }
  // Legacy source preferences predate explicit execution mode and cannot opt in.
  STATE.source = STATE.config.settings?.executionMode === 'demo' ? 'demo' : 'room';
  if (STATE.source === 'demo') startDemoStream();
}
function shutdown() { if (STATE.timer) clearInterval(STATE.timer); STATE.timer = null; }
function saveRecords(records = STATE.records) { saveJson(STATE.recordsFile, { schemaVersion: 2, records: records.filter(r => r.source !== 'demo') }); }

function loadJson(file, target, fallback, critical = false) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    Object.assign(target, raw);
  } catch (error) {
    if (error.code === 'ENOENT' && !fs.existsSync(`${file}.bak`)) { Object.assign(target, fallback); return; }
    try { Object.assign(target, JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'))); if (critical) STATE.recoveryRequired = true; }
    catch {
      if (critical) throw Error(`DATA_CORRUPT: Cannot read ${path.basename(file)} or its backup`);
      Object.assign(target, fallback);
    }
  }
}
function saveJson(file, obj, backup = true) {
  if (!persist) return;
  if (!file) throw new Error('Data store must be initialized before saving');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (backup && fs.existsSync(file) && fs.statSync(file).isFile()) {
    // Never replace a valid backup with a corrupt primary file.
    let previous;
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    if (previous) saveJson(`${file}.bak`, previous, false);
  }
  const temp = `${file}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(obj, null, 2), 'utf8');
    // Windows antivirus/indexing may briefly hold the destination open.
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temp, file); break; }
      catch (error) {
        if (attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

function defaultConfig() {
  return {
    settings: { executionMode: 'android' },
    rules: {
      source: 'cloud',
      cloudDate: dateStr(),
      cloudHour: 'auto',
      cloudGender: 'all',
      cloudGuild: 'all',
      localIdList: '',
      delayMin: 15,
      delayMax: 40,
      noDuplicate: true,
      sendLimit: 0,
    },
    copywriting: {
      mode: 'random',
      selectedIndex: 0,
      contents: [
        '你好呀，很高兴认识你~',
        '哈喽，在干嘛呢？',
        '晚上好呀，有空聊聊天嘛',
        '嗨，看到你在线，来打个招呼～',
      ],
      image: { enable: false, path: null },
      voice: { enable: false, path: null },
    },
    blacklist: [],
  };
}

// ===== 配置读写 =====
function getConfig(key) {
  if (!key) return STATE.config;
  return STATE.config[key];
}
function setConfig(key, value) {
  const next = { ...STATE.config, [key]: value };
  saveJson(STATE.configFile, next);
  STATE.config = next;
}
function allConfig() { return STATE.config; }

// ===== 演示数据生成 =====
function makeRecord(sex, ts) {
  const isFemale = sex === 'female';
  const uid = String(randInt(10000000, 99999999));
  const rcid = String(randInt(10000000, 99999999));
  const t = ts || nowMs();
  return {
    uid,
    rongCloudId: rcid,
    nickname: (isFemale ? pick(NICKNAMES_F) : pick(NICKNAMES_M)) + randInt(1, 99),
    avatar: null,
    sex: sex,
    room: pick(ROOMS),
    guild: pick(GUILDS),
    online: true,
    source: 'demo',
    ts: t,
    time: new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
  };
}

function buildDemoRecords() {
  const now = nowMs();
  const records = [];
  // 生成近 3 小时的历史记录
  for (let i = 0; i < 60; i++) {
    const ts = now - randInt(0, 3 * 3600 * 1000);
    records.push(makeRecord(Math.random() < 0.6 ? 'female' : 'male', ts));
  }
  records.sort((a, b) => b.ts - a.ts);
  STATE.records = records;
}

// 演示:定时生成新记录,模拟"实时采集流"
function startDemoStream() {
  if (STATE.timer) clearInterval(STATE.timer);
  STATE.timer = setInterval(() => {
    if (!STATE.connected) return;
    const rec = makeRecord(Math.random() < 0.6 ? 'female' : 'male');
    STATE.records.unshift(rec);
    if (STATE.records.length > 500) STATE.records.pop();
    STATE.lastEventAt = nowMs();
    if (STATE.streamCallback) {
      STATE.streamCallback({ type: 'record', payload: rec });
      STATE.streamCallback({ type: 'stats', payload: getStats() });
    }
  }, appConfig.dataFeed.sampleIntervalMs);
}

function setStreamCallback(fn) { STATE.streamCallback = fn; }

// ===== 真实数据注入(房间采集器调用) =====
// 把采集到的真实用户写入面板。去重规则:同一天同一 uid 只保留最新一条。
// @param {Array} list  形如 [{ uid, nickname, sex, room, guild, rongCloudId, ts }]
// @param {object} meta { room, source }
// 返回 { added, updated, total }
function ingestRealRecords(list = [], meta = {}) {
  if (!Array.isArray(list) || !list.length) return { added: 0, updated: 0, addedVerified:0, addedUnverified:0, unchanged:0, resolvedHints:0, total: STATE.records.length };
  const now = nowMs();
  const t = epoch(meta.ts,now);
  let added = 0, updated = 0, addedVerified = 0, addedUnverified = 0, unchanged = 0, resolvedHints = 0;
  // Build once per batch; appending keeps indices stable until the final sort.
  const records = STATE.records.slice();
  const removed = new Set();
  const key = r => `${r.source}:${r.uidReal !== false}:${r.uid}:${dateStr(new Date(r.ts))}`;
  const wanted = new Set(list.filter(Boolean).map(raw => raw.uidReal === false ? String(raw.uid || '').trim() : String(raw.uid || '').replace(/\D/g,'')));
  const indices = new Map();
  records.forEach((r,i)=>{ if(wanted.has(r.uid)) indices.set(key(r),i); });

  for (const raw of list) {
    if (!raw) continue;
    const isReal = raw.uidReal !== false;
    // 真实 uid 只保留数字;占位 uid(n+哈希)保留原样,否则字母会被过滤掉变成乱码数字
    let uid = raw.uid ? String(raw.uid).trim() : '';
    if (isReal) uid = uid.replace(/\D/g, '');
    if (!uid) continue;
    const observedAt = epoch(raw.lastSeenAt,epoch(raw.ts,t));
    const ts = epoch(raw.ts,observedAt);
    const rec = {
      uid,
      rongCloudId: raw.rongCloudId ? String(raw.rongCloudId) : null,
      nickname: raw.nickname || `用户${uid.slice(-4)}`,
      avatar: raw.avatar || null,
      sex: raw.sex === 'female' ? 'female' : (raw.sex === 'male' ? 'male' : 'unknown'),
      room: raw.room || meta.room || '',
      guild: raw.guild || '',
      online: typeof raw.online === 'boolean' ? raw.online : null,
      guildKnown: raw.guildKnown === true || !!raw.guild,
      roomCode: raw.roomCode || meta.roomCode || null,
      seenFrom: raw.seenFrom || meta.seenFrom || 'unknown',
      lastSeenAt: observedAt,
      source: 'room',
      // uidReal=false 表示 uid 是"昵称哈希占位",不是真实用户ID(不能用于发送)
      uidReal: isReal,
      ts,
      time: new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    };
    // Direct user-card evidence can resolve exactly one scoped observation.
    // Keep historical days intact and never infer identity from nickname alone.
    if(raw.uidReal === true && /^\d+$/.test(String(raw.uid)) && raw.source === 'room_observation' && rec.seenFrom === 'roomProfile' && raw.evidence === 'matched_room_user_card' && rec.roomCode && raw.nickname) {
      const expected = 'n'+createHash('sha256').update(`${rec.roomCode}\0${raw.nickname}`).digest('hex').slice(0,24);
      if(raw.resolvedFrom === expected) {
        rec.evidence = raw.evidence;
        rec.resolvedFrom = raw.resolvedFrom;
        const hintIdx = records.findIndex((r,i)=>!removed.has(i) && r.source === 'room' && r.uidReal === false && r.uid === expected && r.roomCode === rec.roomCode && r.nickname === raw.nickname && dateStr(new Date(r.ts)) === dateStr(new Date(ts)));
        if(hintIdx >= 0) {
          const hint = records[hintIdx];
          const priorVerified = records[indices.get(key(rec))];
          if(rec.sex === 'unknown') {
            if(['female','male'].includes(priorVerified?.sex)) rec.sex = priorVerified.sex;
            else if(['female','male'].includes(hint.sex)) rec.sex = hint.sex;
          }
          if(!rec.guild) {
            rec.guild = priorVerified?.guild || hint.guild || '';
            rec.guildKnown = priorVerified?.guildKnown === true || hint.guildKnown === true || !!rec.guild;
          }
          removed.add(hintIdx);indices.delete(key(hint));resolvedHints++;
        }
      }
    }
    // 同 uid 覆盖(保留最新信息);否则新增
    const recordKey = key(rec), idx = indices.get(recordKey);
    if (idx !== undefined) {
      const prev = records[idx];
      if (isReal) {
        if(rec.sex === 'unknown' && ['female','male'].includes(prev.sex)) rec.sex = prev.sex;
        if(!rec.guild) { rec.guild = prev.guild || ''; rec.guildKnown = prev.guildKnown === true || !!rec.guild; }
        if(!rec.rongCloudId) rec.rongCloudId = prev.rongCloudId || null;
        if(!raw.nickname) rec.nickname = prev.nickname;
        if(!rec.avatar) rec.avatar = prev.avatar || null;
        if(!rec.roomCode && rec.room === prev.room) rec.roomCode = prev.roomCode || null;
      }
      rec.lastSeenAt = Math.max(rec.lastSeenAt,epoch(prev.lastSeenAt,epoch(prev.ts,0)));
      const merged = {...prev,...rec};
      if(Object.keys(merged).every(field=>merged[field] === prev[field])) { unchanged++; continue; }
      records[idx] = merged;
      updated++;
    } else {
      indices.set(recordKey,records.length);
      records.push(rec);
      added++;
      if(isReal) addedVerified++; else addedUnverified++;
    }
  }
  if(added || updated || resolvedHints) {
    const nextRecords = removed.size ? records.filter((_,i)=>!removed.has(i)) : records;
    nextRecords.sort((a, b) => b.ts - a.ts);
    saveRecords(nextRecords);
    STATE.records = nextRecords;
  }
  // Preserve historical observations across dates.

  STATE.source = 'room';
  STATE.lastCollectAt = now;
  STATE.lastCollectRoom = (meta && meta.room) || STATE.lastCollectRoom;
  STATE.collectError = null;
  STATE.lastEventAt = now;
  shutdown();

  if (STATE.streamCallback) {
    STATE.streamCallback({ type: 'batch', payload: { added, updated, addedVerified, addedUnverified, unchanged, resolvedHints, source: 'room', room: STATE.lastCollectRoom, at: now } });
    STATE.streamCallback({ type: 'stats', payload: getStats() });
  }
  return { added, updated, addedVerified, addedUnverified, unchanged, resolvedHints, total: STATE.records.length };
}

// 采集器报告一次错误(供界面提示)
function reportCollectError(msg) {
  STATE.collectError = msg ? String(msg) : null;
  if (STATE.streamCallback) {
    STATE.streamCallback({ type: 'collect-status', payload: { error: STATE.collectError, at: nowMs() } });
  }
}

// 采集器报告"正在采集的房间"(即使本轮没抓到用户也刷新)
function reportCollectRoom(roomName) {
  if (roomName) STATE.lastCollectRoom = roomName;
  STATE.lastCollectAt = nowMs();
  if (STATE.streamCallback) {
    STATE.streamCallback({ type: 'collect-status', payload: { room: STATE.lastCollectRoom, at: STATE.lastCollectAt } });
  }
}

// ===== 清除虚拟(演示)数据 =====
// 只删 source==='demo' 的记录,保留真实采集的数据。
// @param {boolean} all  true = 连真实数据一起清空
// 返回 { removed, kept }
function clearDemoRecords(all = false) {
  const before = STATE.records.length;
  if (all) {
    STATE.records = [];
  } else {
    STATE.records = STATE.records.filter(r => r.source !== 'demo');
  }
  const removed = before - STATE.records.length;
  saveRecords();
  // 既然用户要清虚拟数据,就把数据源切到真实模式(避免演示流又生成新假数据)
  if (!all) {
    STATE.source = 'room';
    STATE.sourcePref = { source: 'room' };
    if (STATE.sourceFile) saveJson(STATE.sourceFile, STATE.sourcePref);
    if (STATE.timer) { clearInterval(STATE.timer); STATE.timer = null; }
  }
  if (STATE.streamCallback) {
    STATE.streamCallback({ type: 'cleared', payload: { removed, kept: STATE.records.length, all: !!all } });
    STATE.streamCallback({ type: 'stats', payload: getStats() });
  }
  return { removed, kept: STATE.records.length };
}

// 切换数据源模式:'demo'(模拟流) | 'room'(真实采集)
// 切到 room 时停掉演示定时器;切回 demo 时重启
function setSource(mode) {
  const next = mode === 'room' ? 'room' : 'demo';
  // 持久化,重启后保持
  STATE.sourcePref = { source: next };
  if (STATE.sourceFile) saveJson(STATE.sourceFile, STATE.sourcePref);

  if (next === STATE.source) {
    if (next === 'demo' && !STATE.timer) startDemoStream();
    return STATE.source;
  }
  STATE.source = next;
  if (next === 'room') {
    if (STATE.timer) { clearInterval(STATE.timer); STATE.timer = null; }
    // 清掉历史演示数据(来源标记 demo)
    clearDemoRecords(false);
  } else {
    if (!STATE.timer) startDemoStream();
  }
  if (STATE.streamCallback) {
    STATE.streamCallback({ type: 'source', payload: { source: STATE.source } });
    STATE.streamCallback({ type: 'stats', payload: getStats() });
  }
  return STATE.source;
}

// ===== 面板查询 =====
function getDates() {
  const dates = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(nowMs() - i * 86400000);
    dates.push(dateStr(d));
  }
  for (const r of STATE.records) dates.push(dateStr(new Date(r.ts)));
  return { dates: [...new Set(dates)].sort().reverse(), today: dateStr() };
}

function getCollectionCoverage() {
  const roomRecords = STATE.records.filter(r => r.source === 'room');
  return {
    knownVerifiedUids: [...new Set(roomRecords.filter(r => r.uidReal === true && /^\d+$/.test(String(r.uid))).map(r => String(r.uid)))],
    knownRoomNames: [...new Set(roomRecords.map(r => String(r.room || '').trim()).filter(Boolean))],
  };
}

function getStats(date = dateStr()) {
  const today = STATE.records.filter(r => dateStr(new Date(r.ts)) === (date || dateStr()));
  const female = today.filter(r => r.sex === 'female').length;
  const male = today.filter(r => r.sex === 'male').length;
  const realCount = today.filter(r => r.source === 'room').length;
  const observedAt = today.reduce((latest, r) => Math.max(latest, epoch(r.lastSeenAt,epoch(r.ts,0))), 0);
  return {
    femaleCount: female,
    maleCount: male,
    todayTotal: today.length,
    unknownCount: today.filter(r => r.sex === 'unknown').length,
    realCount,
    verifiedCount: today.filter(r => r.source === 'room' && r.uidReal !== false).length,
    placeholderCount: today.filter(r => r.source === 'room' && r.uidReal === false).length,
    source: STATE.source,
    updatedAt: observedAt ? new Date(observedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '--:--',
  };
}

function getRecords(date, sex, page = 1, size = 50, keyword = '') {
  let list = STATE.records.filter(r => !date || dateStr(new Date(r.ts)) === date);
  const query = String(keyword || '').trim().toLocaleLowerCase();
  if (query) list = list.filter(r => [r.uid, r.nickname, r.room].some(value => String(value || '').toLocaleLowerCase().includes(query)));
  size = Number.isFinite(Number(size)) && Number(size) > 0 ? Math.max(1, Math.min(500, Math.floor(Number(size)))) : 50;
  page = Number.isFinite(Number(page)) ? Math.floor(Number(page)) : 1;
  if (sex === 'female' || sex === 'male' || sex === 'unknown') list = list.filter(r => r.sex === sex);
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, page), pages);
  return {
    records: list.slice((p - 1) * size, p * size),
    page: p, pages, total,
  };
}

// 整点汇总:把记录按小时聚合,返回每小时内的 uid 列表
function getSummary(date) {
  const buckets = {};
  for (const r of STATE.records) {
    if (date && dateStr(new Date(r.ts)) !== date) continue;
    const h = new Date(r.ts).getHours();
    if (!buckets[h]) buckets[h] = { hour: h, female: [], male: [], unknown: [], ids: [] };
    buckets[h][['female','male'].includes(r.sex) ? r.sex : 'unknown'].push(r);
    buckets[h].ids.push(r.uid);
  }
  return Object.keys(buckets).sort((a, b) => a - b).map(h => {
    const b = buckets[h];
    return {
      hour: Number(h),
      label: `${String(h).padStart(2, '0')}-${String((Number(h) + 1) % 24).padStart(2, '0')}`,
      count: b.ids.length,
      femaleCount: b.female.length,
      maleCount: b.male.length,
      unknownCount: b.unknown.length,
      ids: b.ids,
      // 预览用精简列表
      preview: [...b.female, ...b.male, ...b.unknown].map(r => ({
        uid: r.uid, sex: r.sex, guild: r.guild, guildKnown: r.guildKnown, nickname: r.nickname, source: r.source, uidReal: r.uidReal, online: r.online, roomCode: r.roomCode, seenFrom: r.seenFrom, lastSeenAt: r.lastSeenAt,
      })),
    };
  });
}

// 按汇总小时 + 性别 + 工会筛选,返回待发送 uid 列表
function getTargetsByHour(date, hour, gender, guild) {
  const summary = getSummary(date);
  let list = [];
  if (hour === 'auto' || hour === '' || hour == null) {
    // 自动:取全部(女在前男在后)
    list = summary.flatMap(b => b.preview);
  } else {
    const b = summary.find(x => String(x.hour) === String(hour));
    if (b) list = b.preview;
  }
  if (gender === 'f') list = list.filter(p => p.sex === 'female');
  if (gender === 'm') list = list.filter(p => p.sex === 'male');
  if (guild === 'has') list = list.filter(p => p.guild);
  if (guild === 'none') list = list.filter(p => p.guildKnown === true && !p.guild);
  return list.map(p => p.uid);
}

function getStatus() {
  const realCount = STATE.records.filter(r => r.source === 'room').length;
  return {
    connected: STATE.connected,
    streaming: !!STATE.timer,
    mode: STATE.source,
    source: STATE.source,
    realCount,
    lastEventAt: STATE.lastEventAt,
    lastCollectAt: STATE.lastCollectAt,
    lastCollectRoom: STATE.lastCollectRoom,
    collectError: STATE.collectError,
    recoveryRequired: !!STATE.recoveryRequired,
  };
}

// ===== 发送统计 & 当日去重 =====
function recordSend(machineCode, task) {
  const key = `${machineCode}:${task}`;
  const today = dateStr();
  if (!STATE.stats[key]) STATE.stats[key] = {};
  const now = new Date(nowMs());
  const dayKey = today;
  const weekKey = `${now.getFullYear()}-W${weekOfYear(now)}`;
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  STATE.stats[key][dayKey] = (STATE.stats[key][dayKey] || 0) + 1;
  STATE.stats[key][weekKey] = (STATE.stats[key][weekKey] || 0) + 1;
  STATE.stats[key][monthKey] = (STATE.stats[key][monthKey] || 0) + 1;
  saveJson(STATE.statsFile, STATE.stats);
}

function weekOfYear(d) {
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - start) / 86400000 + start.getDay() + 1) / 7);
}

function getCounts(machineCode, task) {
  const key = `${machineCode}:${task}`;
  const s = STATE.stats[key] || {};
  const now = new Date(nowMs());
  const counts = {
    today: s[dateStr(now)] || 0,
    week: s[`${now.getFullYear()}-W${weekOfYear(now)}`] || 0,
    month: s[`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`] || 0,
  };
  for (const r of STATE.outcomes || []) {
    if (r.mode !== 'android' || r.outcome !== 'confirmed_ui' || r.machineCode !== machineCode || (r.task || 'private') !== task) continue;
    const at = new Date(r.at);
    if (dateStr(at) === dateStr(now)) counts.today++;
    if (at.getFullYear() === now.getFullYear() && weekOfYear(at) === weekOfYear(now)) counts.week++;
    if (at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth()) counts.month++;
  }
  return counts;
}

function isSentToday(machineCode, uid) {
  const today = dateStr();
  const bucket = STATE.sentToday[today] || {};
  return (bucket[machineCode] || []).includes(String(uid)) || STATE.outcomes.some(r => r.mode === 'android' && r.outcome === 'confirmed_ui' && r.machineCode === machineCode && r.targetUid === String(uid) && dateStr(new Date(r.at)) === today);
}

function markSent(machineCode, uid) {
  const today = dateStr();
  // 清理非今日的旧记录(0点清零)
  for (const k of Object.keys(STATE.sentToday)) {
    if (k !== today) delete STATE.sentToday[k];
  }
  if (!STATE.sentToday[today]) STATE.sentToday[today] = {};
  if (!STATE.sentToday[today][machineCode]) STATE.sentToday[today][machineCode] = [];
  if (!STATE.sentToday[today][machineCode].includes(uid)) {
    STATE.sentToday[today][machineCode].push(uid);
  }
  saveJson(STATE.sentFile, STATE.sentToday);
}

// 系统日志(供部分模块推送)
function pushSystemLog(level, msg) {
  if (STATE.streamCallback) STATE.streamCallback({ type: 'log', payload: { level, msg } });
}

function getMachineCode() {
  // 演示:用固定标识代替真实机器码
  return 'DEMO-MACHINE';
}

function getLegacyCounts(machineCode, task) {
  const real = STATE.stats, outcomes = STATE.outcomes; STATE.stats = STATE.legacyStats; STATE.outcomes = [];
  try { return getCounts(machineCode, task); } finally { STATE.stats = real; STATE.outcomes = outcomes; }
}
function recordOutcome(result) {
  if (STATE.recoveryRequired) throw Error('DATA_RECOVERY_REQUIRED: Outcome journal was recovered from an older backup; verify it before sending');
  const record = { ...result, targetUid: String(result.targetUid || ''), at: nowMs() };
  if (record.runId && record.outcome === 'confirmed_ui') {
    const prior = STATE.outcomes.find(r => r.runId === record.runId && r.machineCode === record.machineCode && r.targetUid === record.targetUid && (r.task || 'private') === (record.task || 'private') && r.mode === record.mode && r.outcome === 'confirmed_ui');
    if (prior) return prior;
  }
  const next = [...STATE.outcomes, record];
  saveJson(STATE.outcomesFile, { schemaVersion: 2, results: next }); STATE.outcomes = next;
  // Counts and dedup derive from this single durable journal. No cross-file commit.
  return record;
}
function getPendingResults() {
  const latest = new Map();
  for (const r of STATE.outcomes) {
    if (r.mode !== 'android' || (r.task || 'private') !== 'private') continue;
    const key = `${r.machineCode}:${r.targetUid}`;
    if (r.outcome === 'unconfirmed') latest.set(key, r);
    if (r.runId && latest.get(key)?.runId === r.runId && isDefinitiveSendRejection(r,r.targetUid)) latest.delete(key);
    if (r.outcome === 'confirmed_ui' || (r.manualResolution === 'not_sent' && latest.get(key)?.runId === r.runId)) latest.delete(key);
  }
  return [...latest.values()];
}
function isPending(machineCode, uid) { return !!STATE.recoveryRequired || getPendingResults().some(r => r.machineCode === machineCode && r.targetUid === String(uid)); }
function resolvePending({ machineCode, targetUid, runId, resolution } = {}) {
  if (STATE.recoveryRequired) throw Error('DATA_RECOVERY_REQUIRED: Verify the recovered journal before resolving results');
  if (!['confirmed', 'not_sent'].includes(resolution)) throw Error('INVALID_RESOLUTION');
  const uid = String(targetUid || '');
  if (!machineCode || !uid || !runId) throw Error('PENDING_NOT_FOUND');
  const pending = getPendingResults().find(r => r.machineCode === machineCode && r.targetUid === uid && r.runId === runId);
  if (!pending) {
    const prior = STATE.outcomes.find(r => r.machineCode === machineCode && r.targetUid === uid && r.runId === runId && r.manualResolution === resolution);
    if (prior) return prior;
    throw Error('PENDING_NOT_FOUND');
  }
  return recordOutcome({ ...pending, outcome: resolution === 'confirmed' ? 'confirmed_ui' : 'failed', stage: 'manual_review', reason: resolution === 'confirmed' ? 'MANUALLY_CONFIRMED' : 'MANUALLY_NOT_SENT', manualResolution: resolution, evidence: { ...pending.evidence, manualReview: true, resolution } });
}
return {
  init, shutdown, recordOutcome, resolvePending, isPending, getPendingResults, getLegacyCounts, getConfig, setConfig, allConfig,
  getDates, getStats, getRecords, getSummary, getTargetsByHour, getStatus,
  setStreamCallback, recordSend, getCounts, isSentToday, markSent,
  pushSystemLog, getMachineCode,
  // 真实数据采集
  ingestRealRecords, getCollectionCoverage, reportCollectError, reportCollectRoom, setSource, clearDemoRecords,
};

}
module.exports = { ...createDataStore(), createDataStore };
