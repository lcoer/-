const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createOfflineLicense } = require('../electron/services/offline-license.cjs');
async function fixture(t) {
  const tmpRoot = path.join(__dirname, '..', 'tmp');
  await fs.mkdir(tmpRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(tmpRoot,'sybl-offline-'));
  const pair = crypto.generateKeyPairSync('ed25519');
  let now = 1800000000000, mono = 0;
  const config = { publicKey: pair.publicKey.export({type:'spki',format:'pem'}) };
  const code = (changes={}) => {
    const payload=Buffer.from(JSON.stringify({version:1,productId:'shuangyu-assistant',id:crypto.randomUUID(),durationDays:7,issuedAt:now,...changes}));
    return 'SYBL1.'+payload.toString('base64url')+'.'+crypto.sign(null,payload,pair.privateKey).toString('base64url');
  };
  const clients=[];
  const make=(options={})=>{const c=createOfflineLicense({config,dataDir:dir,encrypt:b=>Buffer.from(b),decrypt:b=>b.toString(),wallClock:()=>now,monotonicClock:()=>mono,...options});clients.push(c);return c;};
  t.after(async()=>{clients.forEach(c=>c.close());await fs.rm(dir,{recursive:true,force:true});});
  return {dir,code,make,setNow:v=>now=v,setMono:v=>mono=v,now:()=>now};
}
test('first code grants seven days, restart automatically enters and duplicate code is rejected',async t=>{
  const f=await fixture(t),c=f.make(),code=f.code();assert.equal((await c.initialize()).state,'activation_required');
  const active=await c.activate(code);assert.equal(active.active,true);assert.equal(active.expiresAt,f.now()+7*86400000);
  assert.equal((await c.activate(code)).reason,'激活码已使用');c.close();
  const next=f.make();assert.equal((await next.initialize()).active,true);next.assertActive();
});
test('signature, product, duration, version and format are strictly verified',async t=>{
  const f=await fixture(t),c=f.make();await c.initialize();
  for(const code of [f.code({productId:'other'}),f.code({version:2}),f.code({durationDays:0}),f.code({durationDays:3651}),'SYBL1.bad.bad','a'.repeat(4097)]) assert.equal((await c.activate(code)).active,false);
  const token=f.code().split('.'); const sig=Buffer.from(token[2],'base64url');sig[0]^=1;token[2]=sig.toString('base64url');assert.equal((await c.activate(token.join('.'))).active,false);
});
test('expiry retains used IDs and permits a fresh code',async t=>{
  const f=await fixture(t),c=f.make(),old=f.code();await c.initialize();await c.activate(old);f.setNow(f.now()+7*86400000);
  assert.equal(c.getStatus().state,'expired');assert.throws(()=>c.assertActive(),/过期/);assert.equal((await c.activate(old)).reason,'激活码已使用');
  assert.equal((await c.activate(f.code({durationDays:1}))).active,true);
});
test('monotonic deadline and persisted timestamp reject clock rollback',async t=>{
  const f=await fixture(t),c=f.make();await c.initialize();await c.activate(f.code());
  f.setMono(7*86400000);assert.equal(c.getStatus().state,'expired');c.close();
  const f2=await fixture(t),c2=f2.make();await c2.initialize();await c2.activate(f2.code());await c2.retry();c2.close();f2.setNow(f2.now()-6*60000);
  const next=f2.make();assert.equal((await next.initialize()).reason,'系统时间异常，请校准时间后重试');
});
test('corrupted storage and unavailable encryption fail closed without consuming code',async t=>{
  const f=await fixture(t),code=f.code(),c=f.make({encrypt:()=>{throw Error('unavailable')}});await c.initialize();assert.equal((await c.activate(code)).active,false);
  const next=f.make();await next.initialize();assert.equal((await next.activate(code)).active,true);next.close();
  const file=path.join(f.dir,'credential-v1.bin');const data=JSON.parse(await fs.readFile(file,'utf8'));data.active.expiresAt+=1;await fs.writeFile(file,JSON.stringify(data));
  assert.equal((await f.make().initialize()).state,'suspended');
});
test('concurrent submit consumes once and status contains no token or key',async t=>{
  const f=await fixture(t),c=f.make();await c.initialize();await Promise.all([c.activate(f.code()),c.activate(f.code())]);
  assert.equal(c.getStatus().active,true);assert.deepEqual(Object.keys(c.getStatus()).sort(),['active','expiresAt','reason','state']);
  const stored=JSON.parse(await fs.readFile(path.join(f.dir,'credential-v1.bin'),'utf8'));assert.equal(stored.usedCodeIds.length,1);
});
test('missing verifier configuration blocks access',async t=>{const f=await fixture(t),c=f.make({config:{}});assert.equal((await c.initialize()).state,'not_configured');assert.throws(()=>c.assertActive());});
test('save failure blocks runtime access until successful retry, without consuming a new code',async t=>{
  const f=await fixture(t);let failing=false;
  const c=f.make({encrypt:b=>{if(failing)throw Error('failure');return Buffer.from(b);}});
  await c.initialize();await c.activate(f.code());failing=true;
  assert.equal((await c.ensureActive()).active,false);assert.throws(()=>c.assertActive(),/安全/);
  const fresh=f.code();assert.equal((await c.activate(fresh)).active,false);assert.throws(()=>c.assertActive());
  failing=false;assert.equal((await c.retry()).active,true);assert.equal((await c.activate(fresh)).active,true);
});
test('a signed code is intentionally portable between computers and small rollback does not extend a running lease',async t=>{
  const f=await fixture(t),c=f.make(),code=f.code();await c.initialize();await c.activate(code);
  const secondDir=path.join(f.dir,'another-device'),other=f.make({dataDir:secondDir});assert.equal((await other.activate(code)).active,true);
  f.setMono(7*86400000-1);f.setNow(f.now()-60000);assert.equal(c.getStatus().active,true);
  f.setMono(7*86400000);assert.equal(c.getStatus().active,false);
});
test('expiration timer emits revocation without UI polling and callbacks are never awaited',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=await fixture(t),seen=[];
  const c=f.make({onChange:s=>{seen.push(s);return new Promise(()=>{});}});
  await c.initialize();await c.activate(f.code({durationDays:1}));
  f.setMono(86400000);f.setNow(f.now()+86400000);t.mock.timers.tick(86400000);
  assert.ok(seen.some(s=>s.state==='expired'&&!s.active));
});
test('transient Windows replacement locks retry without deleting the previous credential',async t=>{
  const f=await fixture(t),c=f.make();await c.initialize();await c.activate(f.code());
  const file=path.join(f.dir,'credential-v1.bin'),previous=await fs.readFile(file);
  const original=fs.rename;let attempts=0;
  t.mock.method(fs,'rename',async(...args)=>{
    attempts++;
    if(attempts<3){assert.deepEqual(await fs.readFile(file),previous);throw Object.assign(Error('locked'),{code:attempts===1?'EPERM':'EBUSY'});}
    return original(...args);
  });
  assert.equal((await c.activate(f.code())).active,true);assert.equal(attempts,3);
});
test('permanent replacement failure preserves old file and does not consume the new code',async t=>{
  const f=await fixture(t),c=f.make();await c.initialize();await c.activate(f.code());
  const file=path.join(f.dir,'credential-v1.bin'),previous=await fs.readFile(file),code=f.code();
  let attempts=0;
  const mock=t.mock.method(fs,'rename',async()=>{attempts++;throw Object.assign(Error('denied'),{code:'EACCES'});});
  assert.equal((await c.activate(code)).active,false);assert.equal(attempts,1);assert.deepEqual(await fs.readFile(file),previous);assert.throws(()=>c.assertActive());
  mock.mock.restore();assert.equal((await c.activate(code)).active,true);
});
test('closing while atomic save is pending never reopens active access',async t=>{
  const f=await fixture(t),c=f.make();await c.initialize();const original=fs.rename;
  let release,entered;const ready=new Promise(resolve=>entered=resolve),wait=new Promise(resolve=>release=resolve);
  t.mock.method(fs,'rename',async(...args)=>{entered();await wait;return original(...args);});
  const pending=c.activate(f.code());await ready;c.close();release();
  assert.equal((await pending).active,false);assert.equal(c.getStatus().active,false);assert.throws(()=>c.assertActive(),/关闭/);
});
test('persistent transient locks stop after four attempts and clean only their temporary file',async t=>{
  const f=await fixture(t),c=f.make();await c.initialize();await c.activate(f.code());
  const file=path.join(f.dir,'credential-v1.bin'),previous=await fs.readFile(file);let attempts=0;
  t.mock.method(fs,'rename',async()=>{attempts++;throw Object.assign(Error('busy'),{code:'EPERM'});});
  assert.equal((await c.activate(f.code())).active,false);assert.equal(attempts,4);
  assert.deepEqual(await fs.readFile(file),previous);assert.deepEqual(await fs.readdir(f.dir),['credential-v1.bin']);
});
