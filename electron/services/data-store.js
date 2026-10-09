// electron/services/data-store.js - 数据存储与演示数据流
// 职责:
//   1. 配置持久化(规则/文案/黑名单),存于 userData/config.json
//   2. 采集数据面板的数据供应(演示模式:模拟采集流;实际部署替换为真实数据源)
//   3. 发送统计与当日去重持久化
//
// 说明:参考软件的正式版本通过独立后端(HTTP+MQTT)下发采集数据;
//       本实现将数据源抽离为可替换模块,默认内置"演示数据生成器",
//       接入真实数据源时只需替换 _generateSample 与 getRecords 的实现。

const fs = require('fs');
const path = require('path');
const appConfig = require('../config');

let _app = null;
try { _app = require('electron').app; } catch { _app = null; }

function userDataDir() {
  if (_app) return _app.getPath('userData');
  return path.join(process.cwd(), '.data');
}

const STATE = {
  configFile: null,
  statsFile: null,
  sentFile: null,
  sourceFile: null,
  sourcePref: { source: 'demo' },  // 持久化的数据源偏好
  config: {},
  stats: {},
  sentToday: {},          // { 'YYYY-MM-DD': { machineCode: [uid...] } }
  records: [],            // 采集记录(demo 生成的 + 真实房间采集的)
  streamCallback: null,
  connected: true,
  lastEventAt: null,
  timer: null,
  // 数据源:demonstration 生成器 or 真实房间采集
  source: 'demo',         // 'demo' | 'room'
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
function dateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ===== 初始化 =====
function init() {
  if (!_app) return;
  STATE.configFile = path.join(userDataDir(), 'config.json');
  STATE.statsFile = path.join(userDataDir(), 'stats.json');
  STATE.sentFile = path.join(userDataDir(), 'sent.json');
  STATE.sourceFile = path.join(userDataDir(), 'source.json');
  loadJson(STATE.configFile, STATE.config, defaultConfig());
  loadJson(STATE.statsFile, STATE.stats, {});
  loadJson(STATE.sentFile, STATE.sentToday, {});
  loadJson(STATE.sourceFile, STATE.sourcePref, { source: 'demo' });

  // 真实采集模式下:不生成任何演示数据,保持面板干净(只等真实采集写入)
  if (STATE.sourcePref.source === 'room') {
    STATE.source = 'room';
    STATE.records = [];
  } else {
    buildDemoRecords();
    startDemoStream();
  }
}

function loadJson(file, target, fallback) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    Object.assign(target, raw);
  } catch { Object.assign(target, fallback); }
}
function saveJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  } catch { /* 忽略写失败 */ }
}

function defaultConfig() {
  return {
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
  STATE.config[key] = value;
  saveJson(STATE.configFile, STATE.config);
}
function allConfig() { return STATE.config; }

// ===== 演示数据生成 =====
function makeRecord(sex, ts) {
  const isFemale = sex === 'female';
  const uid = String(randInt(10000000, 99999999));
  const rcid = String(randInt(10000000, 99999999));
  const t = ts || Date.now();
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
  const now = Date.now();
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
    STATE.lastEventAt = Date.now();
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
  if (!Array.isArray(list) || !list.length) return { added: 0, updated: 0, total: STATE.records.length };
  const now = Date.now();
  const t = meta && meta.ts ? meta.ts : now;
  let added = 0, updated = 0;

  for (const raw of list) {
    if (!raw) continue;
    const isReal = raw.uidReal !== false;
    // 真实 uid 只保留数字;占位 uid(n+哈希)保留原样,否则字母会被过滤掉变成乱码数字
    let uid = raw.uid ? String(raw.uid).trim() : '';
    if (isReal) uid = uid.replace(/\D/g, '');
    if (!uid) continue;
    const rec = {
      uid,
      rongCloudId: raw.rongCloudId ? String(raw.rongCloudId) : null,
      nickname: raw.nickname || `用户${uid.slice(-4)}`,
      avatar: raw.avatar || null,
      sex: raw.sex === 'female' ? 'female' : (raw.sex === 'male' ? 'male' : 'unknown'),
      room: raw.room || meta.room || '',
      guild: raw.guild || '',
      online: raw.online !== false,
      source: 'room',
      // uidReal=false 表示 uid 是"昵称哈希占位",不是真实用户ID(不能用于发送)
      uidReal: isReal,
      ts: raw.ts || t,
      time: new Date(raw.ts || t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    };
    // 同 uid 覆盖(保留最新信息);否则新增
    const idx = STATE.records.findIndex(r => r.uid === uid && dateStr(new Date(r.ts)) === dateStr(new Date(rec.ts)));
    if (idx >= 0) {
      // 若已有记录是真实 uid,不要被占位 uid 覆盖
      if (STATE.records[idx].uidReal === false && rec.uidReal === true) {
        STATE.records.splice(idx, 1);
        STATE.records.unshift(rec);
        updated++;
        continue;
      }
      STATE.records[idx] = { ...STATE.records[idx], ...rec, uidReal: STATE.records[idx].uidReal || rec.uidReal };
      updated++;
    } else {
      STATE.records.unshift(rec);
      added++;
    }
  }
  STATE.records.sort((a, b) => b.ts - a.ts);
  if (STATE.records.length > 800) STATE.records.length = 800;

  STATE.source = 'room';
  STATE.lastCollectAt = now;
  STATE.lastCollectRoom = (meta && meta.room) || STATE.lastCollectRoom;
  STATE.collectError = null;
  STATE.lastEventAt = now;

  if (STATE.streamCallback) {
    STATE.streamCallback({ type: 'batch', payload: { added, updated, source: 'room', room: STATE.lastCollectRoom, at: now } });
    STATE.streamCallback({ type: 'stats', payload: getStats() });
  }
  return { added, updated, total: STATE.records.length };
}

// 采集器报告一次错误(供界面提示)
function reportCollectError(msg) {
  STATE.collectError = msg ? String(msg) : null;
  if (STATE.streamCallback) {
    STATE.streamCallback({ type: 'collect-status', payload: { error: STATE.collectError, at: Date.now() } });
  }
}

// 采集器报告"正在采集的房间"(即使本轮没抓到用户也刷新)
function reportCollectRoom(roomName) {
  if (roomName) STATE.lastCollectRoom = roomName;
  STATE.lastCollectAt = Date.now();
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
    const d = new Date(Date.now() - i * 86400000);
    dates.push(dateStr(d));
  }
  return { dates, today: dateStr() };
}

function getStats() {
  const female = STATE.records.filter(r => r.sex === 'female').length;
  const male = STATE.records.filter(r => r.sex === 'male').length;
  const realCount = STATE.records.filter(r => r.source === 'room').length;
  return {
    femaleCount: female,
    maleCount: male,
    todayTotal: STATE.records.length,
    realCount,
    source: STATE.source,
    updatedAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
  };
}

function getRecords(date, sex, page = 1, size = 50) {
  let list = STATE.records;
  if (sex === 'female' || sex === 'male') list = list.filter(r => r.sex === sex);
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
    const h = new Date(r.ts).getHours();
    if (!buckets[h]) buckets[h] = { hour: h, female: [], male: [], ids: [] };
    buckets[h][r.sex].push(r);
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
      ids: b.ids,
      // 预览用精简列表
      preview: [...b.female, ...b.male].map(r => ({
        uid: r.uid, sex: r.sex, guild: r.guild, nickname: r.nickname,
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
    const allF = [], allM = [];
    for (const b of summary) { allF.push(...b.preview.filter(p => p.sex === 'female')); allM.push(...b.preview.filter(p => p.sex === 'male')); }
    list = [...allF, ...allM];
  } else {
    const b = summary.find(x => String(x.hour) === String(hour));
    if (b) list = b.preview;
  }
  if (gender === 'f') list = list.filter(p => p.sex === 'female');
  if (gender === 'm') list = list.filter(p => p.sex === 'male');
  if (guild === 'has') list = list.filter(p => p.guild);
  if (guild === 'none') list = list.filter(p => !p.guild);
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
  };
}

// ===== 发送统计 & 当日去重 =====
function recordSend(machineCode, task) {
  const key = `${machineCode}:${task}`;
  const today = dateStr();
  if (!STATE.stats[key]) STATE.stats[key] = {};
  const now = new Date();
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
  const now = new Date();
  return {
    today: s[dateStr(now)] || 0,
    week: s[`${now.getFullYear()}-W${weekOfYear(now)}`] || 0,
    month: s[`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`] || 0,
  };
}

function isSentToday(machineCode, uid) {
  const today = dateStr();
  const bucket = STATE.sentToday[today] || {};
  return (bucket[machineCode] || []).includes(uid);
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

module.exports = {
  init, getConfig, setConfig, allConfig,
  getDates, getStats, getRecords, getSummary, getTargetsByHour, getStatus,
  setStreamCallback, recordSend, getCounts, isSentToday, markSent,
  pushSystemLog, getMachineCode,
  // 真实数据采集
  ingestRealRecords, reportCollectError, reportCollectRoom, setSource, clearDemoRecords,
};
