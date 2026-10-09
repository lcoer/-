const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness(api) {
  const elements = new Map();
  function element() {
    const listeners = {};
    return {
      value: '', checked: false, options: [], children: [], dataset: {}, innerHTML: '',
      classList: { toggle() {}, add() {}, remove() {} },
      addEventListener(type, fn) { listeners[type] = fn; },
      fire(type, event = {}) { return listeners[type]?.({ target: this, ...event }); },
      appendChild(child) { this.options.push(child); this.children.push(child); },
      querySelector() { return null; },
    };
  }
  const get = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const radios = {
    'input[name="copyMode"]': ['random', 'select', 'mediaonly'].map(value => Object.assign(element(), { value })),
    'input[name="source"]': ['cloud', 'local'].map(value => Object.assign(element(), { value })),
  };
  const notices = [];
  const context = vm.createContext({
    window: { api },
    document: { getElementById: get, createElement: element, querySelector: () => element() },
    $$: selector => radios[selector] || [],
    toast: text => notices.push(text), escapeHtml: text => text, debounce: fn => fn,
  });
  function load(file, name, transform = s => s) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'design/js', file), 'utf8');
    vm.runInContext(transform(source) + `\nthis.${name} = ${name};`, context);
    return context[name];
  }
  return { get, radios, context, notices, load };
}

test('保存文案纳入未点击新增的文字，启动 flush 等待串行持久化', async () => {
  let release;
  const writes = [];
  const h = harness({ config: {
    get: async () => ({ contents: ['旧文案'], mode: 'random' }),
    set: async (_, value) => {
      writes.push(value);
      if (writes.length === 1) await new Promise(resolve => { release = resolve; });
      return { ok: true };
    },
  } });
  const copy = h.load('copywriting.js', 'Copywriting');
  await copy.init();
  h.get('copywritingNewInput').value = ' 新文案 ';
  const save = h.get('copySaveBtn').fire('click');
  await new Promise(resolve => setImmediate(resolve));
  h.get('copywritingNewInput').value = '启动前草稿';
  let finished = false;
  const flushing = copy.flush().then(value => { finished = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(writes.length, 1);
  release();
  await save;
  const snapshot = await flushing;
  assert.deepEqual(Array.from(snapshot.contents), ['旧文案', '新文案', '启动前草稿']);
  assert.equal(writes.length, 2);
  assert.equal(h.get('copywritingNewInput').value, '');
});

test('文案 flush 保存失败会抛出，保留草稿供重试', async () => {
  let fail = true;
  const h = harness({ config: {
    get: async () => ({ contents: [], mode: 'random' }),
    set: async () => fail ? { ok: false, reason: '磁盘写入失败' } : { ok: true },
  } });
  const copy = h.load('copywriting.js', 'Copywriting');
  await copy.init();
  h.get('copywritingNewInput').value = '消息正文';
  await assert.rejects(copy.flush(), /磁盘写入失败/);
  fail = false;
  assert.deepEqual(Array.from((await copy.flush()).contents), ['消息正文']);
});

test('规则加载使用保存日期与小时，来源切换持久化', async () => {
  const requests = [], writes = [];
  const h = harness({
    config: { get: async () => ({ cloudDate: '2026-10-08', cloudHour: '18', source: 'cloud' }),
      set: async (_, value) => { writes.push(value); return { ok: true }; } },
    portal: {
      getDates: async () => ({ dates: ['2026-10-09', '2026-10-08'], today: '2026-10-09' }),
      getSummary: async date => { requests.push(date); return { hourly: [
        { hour: 18, label: '18 时', count: 1, preview: [{ uid: '123456', sex: 'female' }] },
        { hour: 19, label: '19 时', count: 1, preview: [{ uid: '654321', sex: 'male' }] },
      ] }; },
    },
  });
  const rules = h.load('rules-view.js', 'RulesView');
  await rules.init();
  assert.deepEqual(requests, ['2026-10-08']);
  assert.equal(h.get('cloudHourSel').value, '18');
  assert.deepEqual(Array.from(await rules.getTargetIds()), ['123456']);
  h.radios['input[name="source"]'][0].checked = false;
  const local = h.radios['input[name="source"]'][1]; local.checked = true;
  await local.fire('change');
  assert.equal(writes.at(-1).source, 'local');
});

test('保存小时当前无记录时不会回退到全部时段', async () => {
  const h = harness({
    config: { get: async () => ({ cloudDate: '2026-10-08', cloudHour: '17' }) },
    portal: { getDates: async () => ({ dates: [], today: '2026-10-09' }), getSummary: async () => ({ hourly: [] }) },
  });
  const rules = h.load('rules-view.js', 'RulesView');
  await rules.init();
  assert.equal(h.get('cloudDateSel').value, '2026-10-08');
  assert.equal(h.get('cloudHourSel').value, '17');
  assert.deepEqual(Array.from(await rules.getTargetIds()), []);
});

test('启动确认列出随机候选文案，文案保存失败不会启动任务', async () => {
  const confirmations = [], starts = [];
  const h = harness({
    config: { get: async key => key === 'settings' ? { executionMode: 'android' } : [] },
    task: { getStatus: async () => ({}), onStatus() {}, onLog() {}, start: async (...args) => { starts.push(args); return { ok: true }; } },
  });
  h.context.RulesView = { readForm: () => ({}), getTargets: async () => [{ uid: '123456' }] };
  h.context.Copywriting = { flush: async () => ({ contents: ['甲', '乙'], mode: 'random' }) };
  h.context.Dialog = { confirm: async text => { confirmations.push(text); return true; } };
  h.context.policy = { validatePrivateConfig: config => ({ ok: true, config }) };
  const consoleView = h.load('task-console.js', 'TaskConsole', source => source.replace(
    "await import('/engine/task-policy.mjs')", 'globalThis.policy'));
  await consoleView.init();
  await h.get('taskPrivateStart').fire('click');
  assert.match(confirmations[0], /随机选择以下 2 条文案/);
  assert.match(confirmations[0], /1\. 甲\n2\. 乙/);
  assert.equal(starts.length, 1);
  h.context.Copywriting.flush = async () => ({ contents: ['甲', '乙'], mode: 'select', selectedIndex: 1 });
  await h.get('taskPrivateStart').fire('click');
  assert.match(confirmations[1], /使用文案：乙/);
  assert.doesNotMatch(confirmations[1], /使用文案：甲/);
  h.context.Copywriting.flush = async () => { throw Error('保存失败'); };
  await h.get('taskPrivateStart').fire('click');
  assert.equal(starts.length, 2);
  assert.match(h.notices.at(-1), /保存失败/);
});
