const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(overrides = {}) {
  const elements = new Map(), errors = [];
  function element(id) {
    if (!elements.has(id)) elements.set(id, { textContent: '', disabled: false, value: '6', hidden: false, classList: { toggle() {}, add() {}, remove() {} }, listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; } });
    return elements.get(id);
  }
  element('collectScope').value = 'multi';
  let current = { running: false, state: 'stopped', stats: {}, source: 'room' }, owner = null;
  const api = {
    config: { set: async () => ({ ok: true }) },
    portal: { getRecords: async () => ({ ok: true, records: [] }), getStats: async () => ({ ok: true, data: {} }), ...overrides.portal },
    collect: { status: async () => ({ ok: true, ...current.stats, ...current }), start: async () => ({ ok: true }), stop: async () => ({ ok: true }), ...overrides.collect },
    task: { getStatus: async () => ({ collect: current, deviceOwner: owner }), ...overrides.task },
  };
  const context = vm.createContext({ window: { api }, document: { getElementById: element }, console, fmtNum: n => n || 0, debounce: callback => callback, escapeHtml: s => s, toast: msg => errors.push(msg), alert: msg => errors.push(msg), confirm: () => true });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../design/js/guest-view.js'), 'utf8') + '\n globalThis.view = GuestView;', context);
  return { element, errors, click: () => element('guestCollectBtn').listeners.click(), view: context.view,
    status(status, nextOwner = status.running ? { owner: 'collect' } : null) { current = status; owner = nextOwner; context.view.onTaskStatus({ collect: current, deviceOwner: owner }); } };
}

test('late start acknowledgement cannot overwrite a stopped status', async () => {
  const start = deferred(), h = setup({ collect: { start: () => start.promise } });
  const opening = h.click(); await tick();
  h.status({ running: true, state: 'starting', stats: {} });
  h.status({ running: false, state: 'stopped', stats: {} });
  start.resolve({ ok: true }); await opening;
  assert.equal(h.element('guestCollectBtnText').textContent, '开始实时采集');
  assert.equal(h.element('guestCollectBtn').disabled, false);
});

test('stop remains disabled when an earlier start response arrives during cancellation', async () => {
  const start = deferred(), stop = deferred();
  const h = setup({ collect: { start: () => start.promise, stop: () => stop.promise } });
  const opening = h.click(); await tick();
  h.status({ running: true, state: 'starting', stats: {} });
  assert.equal(h.element('guestCollectBtn').disabled, false, 'startup must allow cancellation');
  const closing = h.click();
  h.status({ running: true, state: 'stopping', stats: {} });
  start.resolve({ ok: true }); await opening;
  assert.equal(h.element('guestCollectBtnText').textContent, '停止中...');
  assert.equal(h.element('guestCollectBtn').disabled, true);
  h.status({ running: false, state: 'stopped', stats: {} });
  stop.resolve({ ok: true }); await closing;
  assert.equal(h.element('guestCollectBtnText').textContent, '开始实时采集');
});

test('stop acknowledgement does not unlock collection while another task owns the device', async () => {
  const stop = deferred(), h = setup({ collect: { stop: () => stop.promise } });
  h.status({ running: true, state: 'running', stats: {} });
  const closing = h.click();
  h.status({ running: false, state: 'stopped', stats: {} }, { owner: 'private' });
  stop.resolve({ ok: true }); await closing;
  assert.equal(h.element('guestCollectBtn').disabled, true);
});

test('stop transport errors are shown and controls recover from authoritative task status', async () => {
  const h = setup({ collect: { stop: async () => { h.status({ running: false, state: 'stopped', stats: {} }); throw Error('IPC disconnected'); } } });
  h.status({ running: true, state: 'running', stats: {} });
  await h.click();
  assert.ok(h.errors.some(message => message.includes('IPC disconnected')));
  assert.equal(h.element('guestCollectBtnText').textContent, '开始实时采集');
  assert.equal(h.element('guestCollectBtn').disabled, false);
});

test('an in-flight status query cannot overwrite a newer stop event', async () => {
  const query = deferred(), h = setup({ collect: { status: () => query.promise }, task: { getStatus: async () => ({ collect: { running: true, state: 'running', stats: {} }, deviceOwner: { owner: 'collect' } }) } });
  const refreshing = h.view.refreshCollectStatus();
  h.status({ running: false, state: 'stopped', stats: {} });
  query.resolve({ ok: true, running: true, state: 'running' }); await refreshing;
  assert.equal(h.element('guestCollectBtnText').textContent, '开始实时采集');
});

test('stopped collection no longer shows an active room retry hint', () => {
  const h = setup();
  h.status({ running: false, state: 'stopped', stats: { waitingForNextCycle: true, navigationStatus: 'retry' } });
  assert.equal(h.element('collectCoverageHint').textContent, '采集已停止，已采集记录已保留。');
});

test('a late stopping event cannot overwrite a newer backend stopped revision', () => {
  const h = setup();
  h.view.onTaskStatus({ statusRevision: 3, collect: { running: false, state: 'stopped', stats: {} }, deviceOwner: null });
  h.view.onTaskStatus({ statusRevision: 2, collect: { running: true, state: 'stopping', stats: {} }, deviceOwner: { owner: 'collect' } });
  assert.equal(h.element('guestCollectBtnText').textContent, '开始实时采集');
  assert.equal(h.element('guestCollectBtn').disabled, false);
});

test('a newer backend query remains valid when an older event arrives during the query', async () => {
  const query = deferred(), h = setup({ collect: { status: () => query.promise }, task: { getStatus: async () => ({ statusRevision: 3, collect: { running: false, state: 'stopped', stats: {} }, deviceOwner: null }) } });
  const refreshing = h.view.refreshCollectStatus();
  h.view.onTaskStatus({ statusRevision: 2, collect: { running: true, state: 'stopping', stats: {} }, deviceOwner: { owner: 'collect' } });
  query.resolve({ ok: true, statusRevision: 3, running: false, state: 'stopped' }); await refreshing;
  assert.equal(h.element('guestCollectBtnText').textContent, '开始实时采集');
  assert.equal(h.element('guestCollectBtn').disabled, false);
});

test('same stopped backend revision unlocks controls when the stop acknowledgement settles', async () => {
  const stop = deferred(), h = setup({ collect: { stop: () => stop.promise, status: async () => ({ ok: true, statusRevision: 3, running: false, state: 'stopped' }) }, task: { getStatus: async () => ({ statusRevision: 3, collect: { running: false, state: 'stopped', stats: {} }, deviceOwner: null }) } });
  h.view.onTaskStatus({ statusRevision: 1, collect: { running: true, state: 'running', stats: {} }, deviceOwner: { owner: 'collect' } });
  const closing = h.click();
  h.view.onTaskStatus({ statusRevision: 3, collect: { running: false, state: 'stopped', stats: {} }, deviceOwner: null });
  assert.equal(h.element('guestCollectBtn').disabled, true, 'stop acknowledgement is still pending');
  stop.resolve({ ok: true, state: 'stopped' }); await closing;
  assert.equal(h.element('guestCollectBtnText').textContent, '开始实时采集');
  assert.equal(h.element('guestCollectBtn').disabled, false);
});

test('an older backend query cannot overwrite a newer stopped event', async () => {
  const query = deferred(), h = setup({ collect: { status: () => query.promise }, task: { getStatus: async () => ({ statusRevision: 2, collect: { running: true, state: 'stopping', stats: {} }, deviceOwner: { owner: 'collect' } }) } });
  const refreshing = h.view.refreshCollectStatus();
  h.view.onTaskStatus({ statusRevision: 3, collect: { running: false, state: 'stopped', stats: {} }, deviceOwner: null });
  query.resolve({ ok: true, statusRevision: 2, running: true, state: 'stopping' }); await refreshing;
  assert.equal(h.element('guestCollectBtnText').textContent, '开始实时采集');
  assert.equal(h.element('guestCollectBtn').disabled, false);
});

test('latest record query wins and displayed count uses full filtered total', async () => {
  const old = deferred(), fresh = deferred(); let calls = 0;
  const h = setup({ portal: { getRecords: () => ++calls === 1 ? old.promise : fresh.promise } });
  h.view.onStream({type:'batch',payload:{added:1}});
  h.view.onStream({type:'batch',payload:{added:1}});
  fresh.resolve({ok:true, records:[{uid:'22222',nickname:'fresh'}],total:60}); await tick();
  old.resolve({ok:true,records:[{uid:'11111',nickname:'old'}],total:1}); await tick();
  assert.match(h.element('guestGrid').innerHTML,/fresh/);
  assert.doesNotMatch(h.element('guestGrid').innerHTML,/old/);
  assert.equal(h.element('guestNavCount').textContent,60);
});

test('live record events reload stored page instead of inserting duplicate or wrong-date payloads', async () => {
  let calls = 0;
  const h = setup({portal:{getRecords:async()=>{ calls++; return {ok:true,records:[{uid:'11111',nickname:'stored'}],total:1}; }}});
  h.view.onStream({type:'record',payload:{uid:'22222',nickname:'wrong date'}});
  h.view.onStream({type:'record',payload:{uid:'22222',nickname:'wrong date'}});
  await tick();
  assert.equal(calls,2); assert.match(h.element('guestGrid').innerHTML,/stored/);
  assert.doesNotMatch(h.element('guestGrid').innerHTML,/wrong date/);
});

test('clear failure is visible and clear button becomes usable again', async () => {
  const h=setup({portal:{clearDemo:async()=>{throw Error('disk failed');}}});
  await h.element('guestClearBtn').listeners.click();
  assert.match(h.errors.at(-1),/disk failed/); assert.equal(h.element('guestClearBtn').disabled,false);
});
