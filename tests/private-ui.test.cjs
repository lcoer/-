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
      value: '', checked: false, options: [], children: [], dataset: {}, innerHTML: '', style: {},
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
    config: { get: async key => key === 'settings' ? { executionMode: 'android', senderAccountUid: '77777' } : [] },
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
  assert.match(confirmations[0], /发送账号 UID：77777/);
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

test('settings saves and validates sender UID independently of execution mode', async () => {
  let settings = {executionMode:'demo',senderAccountUid:'77777'};
  const writes=[];
  const h=harness({system:{getInfo:async()=>({executionMode:settings.executionMode,emulatorConnected:true})},
    config:{get:async()=>settings,set:async(_key,value)=>{writes.push(value);settings={...settings,...value};return {ok:true};}}});
  await h.load('settings.js','Settings').init();
  assert.equal(h.get('senderAccountUid').value,'77777');
  h.get('senderAccountUid').value=' 88888 ';
  await h.get('setSenderAccountBtn').fire('click');
  assert.equal(writes[0].senderAccountUid,'88888');assert.equal(writes[0].executionMode,'demo');
  h.get('senderAccountUid').value='wrong';await h.get('setSenderAccountBtn').fire('click');
  assert.equal(writes.length,1);assert.match(h.notices.at(-1),/纯数字/);
});

test('pending review submits the historical sender scope instead of the active account',async()=>{
  const resolutions=[];const prompts=[];
  const record={machineCode:'old-account-scope',senderAccountUid:'77777',senderDeviceKey:'device-old',targetUid:'12345',runId:'run-old'};
  const h=harness({task:{getStatus:async()=>({}),onStatus(){},onLog(){},getPending:async()=>({results:[record]}),resolvePending:async request=>{resolutions.push(request);return {ok:true};}}});
  h.context.Dialog={confirm:async text=>{prompts.push(text);return true;}};
  await h.load('task-console.js','TaskConsole').init();await h.get('pendingReviewBtn').fire('click');
  assert.equal(resolutions[0].machineCode,'old-account-scope');assert.match(prompts[0],/77777/);assert.match(prompts[0],/device-old/);
});

test('private start rejects a rule change while the asynchronous launch plan is prepared',async()=>{
 const starts=[];let rules={delayMin:1,delayMax:1,source:'local'};
 const h=harness({config:{get:async key=>key==='settings'?{executionMode:'android',senderAccountUid:'77777'}:[]},task:{getStatus:async()=>({}),onStatus(){},onLog(){},start:async(...args)=>{starts.push(args);return {ok:true};}}});
 h.context.RulesView={readForm:()=>rules,getTargets:async()=>{rules={...rules,delayMin:2};return [{uid:'12345'}];}};
 h.context.Copywriting={flush:async()=>({contents:['hello']})};h.context.Dialog={confirm:async()=>true};h.context.policy={validatePrivateConfig:config=>({ok:true,config})};
 await h.load('task-console.js','TaskConsole',source=>source.replace("await import('/engine/task-policy.mjs')",'globalThis.policy')).init();await h.get('taskPrivateStart').fire('click');
 assert.equal(starts.length,0);assert.match(h.notices.at(-1),/规则.*变化/);
});

test('parallel clicks during private preparation open only one confirmation and one task',async()=>{
 const starts=[];let release,onStatus;const confirmations=[];
 const h=harness({config:{get:async key=>key==='settings'?{executionMode:'android',senderAccountUid:'77777'}:[]},task:{getStatus:async()=>({}),onStatus:fn=>{onStatus=fn;},onLog(){},start:async(...args)=>{starts.push(args);return {ok:true};}}});
 h.context.RulesView={readForm:()=>({}),getTargets:()=>new Promise(resolve=>{release=resolve;})};h.context.Copywriting={flush:async()=>({contents:['hello']})};
 h.context.Dialog={confirm:async text=>{confirmations.push(text);return true;}};h.context.policy={validatePrivateConfig:config=>({ok:true,config})};
 await h.load('task-console.js','TaskConsole',source=>source.replace("await import('/engine/task-policy.mjs')",'globalThis.policy')).init();
 const first=h.get('taskPrivateStart').fire('click');await new Promise(resolve=>setImmediate(resolve));
 const second=h.get('taskPrivateStart').fire('click');await new Promise(resolve=>setImmediate(resolve));onStatus({});
 assert.equal(h.get('taskPrivateStart').disabled,true);release([{uid:'12345'}]);await Promise.all([first,second]);
 assert.equal(confirmations.length,1);assert.equal(starts.length,1);
});

test('deleting an earlier copy preserves the selected message', async () => {
  const writes=[];
  const h=harness({config:{get:async()=>({contents:['first','selected','last'],mode:'select',selectedIndex:1}),set:async(_,v)=>{writes.push(v);return {ok:true};}}});
  const copy=h.load('copywriting.js','Copywriting'); await copy.init();
  await h.get('copywritingList').fire('click',{target:{closest:selector=>selector==='[data-del]'?{dataset:{del:'0'}}:null}});
  const saved=await copy.flush(); assert.equal(saved.selectedIndex,0); assert.equal(saved.contents[saved.selectedIndex],'selected');
});

test('overlength Unicode copy stays editable and is rejected before saving',async()=>{
  let writes=0;
  const h=harness({config:{get:async()=>({contents:[]}),set:async()=>{writes++;return {ok:true};}}});
  const copy=h.load('copywriting.js','Copywriting'); await copy.init();
  h.get('copywritingNewInput').value='😀'.repeat(2001);
  await h.get('copywritingAddBtn').fire('click'); assert.equal(writes,0); assert.match(h.notices.at(-1),/2000/);
  await assert.rejects(copy.flush(),/2000/); assert.equal(h.get('copywritingNewInput').value,'😀'.repeat(2001));
  h.get('copywritingNewInput').value='😀'.repeat(2000); assert.equal((await copy.flush()).contents.length,1);
});

test('Enter keeps a multiline draft and Ctrl+Enter adds its exact text',async()=>{
 const writes=[];const h=harness({config:{get:async()=>({contents:[],mode:'random'}),set:async(_key,value)=>{writes.push(value);return {ok:true};}}});
 await h.load('copywriting.js','Copywriting').init();const text='第一行😀\n第二行<&>';h.get('copywritingNewInput').value=text;
 await h.get('copywritingNewInput').fire('keydown',{key:'Enter'});assert.equal(h.get('copywritingNewInput').value,text);assert.equal(writes.length,0);
 let prevented=false;await h.get('copywritingNewInput').fire('keydown',{key:'Enter',ctrlKey:true,preventDefault:()=>{prevented=true;}});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(prevented,true);assert.equal(writes[0].contents[0],text);assert.equal(h.get('copywritingNewInput').value,'');
});

test('late date summary cannot replace a newer target date preview', async () => {
  const queries=[];
  const h=harness({config:{get:async()=>({cloudDate:'A'}),set:async()=>({ok:true})},portal:{getDates:async()=>({dates:['A','B','C']}),getSummary:date=>date==='A'?Promise.resolve({hourly:[]}):new Promise(resolve=>queries.push({date,resolve}))}});
  const rules=h.load('rules-view.js','RulesView'); await rules.init();
  h.get('cloudDateSel').value='B'; const b=h.get('cloudDateSel').fire('change');
  h.get('cloudDateSel').value='C'; const c=h.get('cloudDateSel').fire('change');
  queries[1].resolve({hourly:[{hour:1,count:1,preview:[{uid:'33333',sex:'female'}]}]}); await c;
  queries[0].resolve({hourly:[{hour:1,count:1,preview:[{uid:'22222',sex:'female'}]}]}); await b;
  assert.deepEqual(Array.from(await rules.getTargetIds()),['33333']);
});

test('concurrent rule saves are serialized so newest local targets remain persisted',async()=>{
  let release; const writes=[];
  const h=harness({config:{get:async()=>({source:'local'}),set:async(_,v)=>{writes.push(v);if(writes.length===1)await new Promise(r=>release=r);return {ok:true};}},portal:{getDates:async()=>({dates:[]}),getSummary:async()=>({hourly:[]})}});
  await h.load('rules-view.js','RulesView').init();
  h.get('localIdList').value='11111'; h.get('localIdList').fire('input');
  await new Promise(r=>setImmediate(r));
  h.get('localIdList').value='22222'; h.get('localIdList').fire('input');
  await new Promise(r=>setImmediate(r)); assert.equal(writes.length,1);
  release(); await new Promise(r=>setImmediate(r));assert.equal(writes.at(-1).localIdList,'22222');
});
