const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(overrides = {}) {
  const elements = new Map(), notices = [], writes = [];
  const get = id => {
    if (!elements.has(id)) {
      const handlers = {};
      elements.set(id, { value: '', innerHTML: '', textContent: '', dataset: {}, disabled: false,
        addEventListener: (type, fn) => { handlers[type] = fn; },
        fire: (type, event = {}) => handlers[type]?.({ target: elements.get(id), ...event }),
      });
    }
    return elements.get(id);
  };
  get('recommendGroupFilter').value = 'all';
  get('recommendLevelField').value = 'wealthLevel';
  const settings = { levelField: 'wealthLevel', threshold: 54 };
  const users = [
    { uid: '101', nickname: '<script>攻击</script>', sex: 'female', group: 'high', original: { wealthLevel: 54, charmLevel: 103 } },
    { uid: '102', nickname: '低等级', sex: 'male', group: 'low', original: { wealthLevel: 53 } },
    { uid: '103', nickname: '隐藏', group: 'high', levelHidden: true, original: { wealthLevel: '???' } },
  ];
  const api = { list: async () => ({ ok: true, ...settings, settings, users, counts: { high: 2, low: 1, unclassified: 0, total: 3 } }),
    assignments: async () => ({ ok: true, settings, assignments: [] }),
    assign: async payload => { writes.push(payload); return { ok: true, assignment: {} }; }, ...overrides };
  const context = vm.createContext({ window: { api: { recommendation: api } }, document: { getElementById: get },
    toast: text => notices.push(text), crypto: { randomUUID: () => 'request-1' } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../design/js/utils.js'), 'utf8'), context);
  // Keep toast independent of a real document while using the actual HTML escaping helper.
  vm.runInContext('toast = text => notices.push(text)', Object.assign(context, { notices }));
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../design/js/recommendation-view.js'), 'utf8') + '\nthis.view = RecommendationView;', context);
  return { get, notices, writes, view: context.view, api };
}

test('推荐列表默认财富 54 分类，隐藏等级展示，按可见分组选中且转义昵称', async () => {
  const h = harness(); await h.view.init();
  assert.equal(h.get('recommendThreshold').value, '54');
  assert.equal(h.get('recommendHighCount').textContent, 2);
  assert.match(h.get('recommendRows').innerHTML, /&lt;script&gt;/);
  assert.match(h.get('recommendRows').innerHTML, /\?\?\?（隐藏）/);
  h.get('recommendGroupFilter').value = 'high';
  h.get('recommendGroupFilter').fire('change');
  assert.doesNotMatch(h.get('recommendRows').innerHTML, /data-uid="102"/);
  h.get('recommendSelectAllBtn').fire('click');
  assert.equal(h.get('recommendSelectedCount').textContent, '已选 2 人');
  h.get('recommendContent').value = '推荐任务';
  await h.view.assign();
  assert.deepEqual(Array.from(h.writes[0].uids), ['101', '103']);
  assert.equal(h.writes[0].threshold, 54);
  assert.equal(h.get('recommendSelectedCount').textContent, '已选 0 人');
});

test('指定作者阻止并发，失败保留选择与草稿，重试使用同一requestId', async () => {
  let resolve, attempts = 0;
  const payloads = [];
  const h = harness({ assign: async payload => { payloads.push(payload); attempts++;
    if (attempts === 1) return new Promise(done => { resolve = done; });
    return { ok: true };
  } });
  await h.view.init();
  h.get('recommendSelectAllBtn').fire('click');
  h.get('recommendContent').value = '保留草稿';
  const first = h.view.assign(); await h.view.assign();
  assert.equal(attempts, 1);
  assert.equal(h.get('recommendAssignBtn').disabled, true);
  resolve({ ok: false, reason: 'DISK_FULL' }); await first;
  assert.equal(h.get('recommendContent').value, '保留草稿');
  assert.equal(h.get('recommendSelectedCount').textContent, '已选 3 人');
  await h.view.assign();
  assert.equal(payloads[0].requestId, payloads[1].requestId);
});

test('修改未保存阈值禁止分配，空值/超长Unicode拒绝，变更分类清空选择', async () => {
  const h = harness(); await h.view.init();
  h.get('recommendSelectAllBtn').fire('click');
  h.get('recommendContent').value = '内容';
  h.get('recommendThreshold').value = '55';
  await h.view.assign(); assert.equal(h.writes.length, 0);
  h.get('recommendThreshold').value = '';
  await h.view.saveClassification();
  assert.match(h.notices.at(-1), /非负整数/);
  h.get('recommendThreshold').value = '54';
  h.get('recommendContent').value = '😀'.repeat(2001);
  await h.view.assign(); assert.equal(h.writes.length, 0);
  h.get('recommendContent').value = '😀'.repeat(2000);
  await h.view.assign(); assert.equal(h.writes.length, 1);
  h.get('recommendSelectAllBtn').fire('click');
  await h.view.saveClassification();
  assert.equal(h.get('recommendSelectedCount').textContent, '已选 0 人');
});
