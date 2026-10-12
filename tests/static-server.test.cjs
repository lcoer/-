const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {startStaticServer}=require('../electron/services/static-server');
const request=(port,url)=>new Promise((resolve,reject)=>{const r=http.get({host:'127.0.0.1',port,path:url},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body,type:res.headers['content-type']}));});r.on('error',reject);});
test('serves shared frontend policies and refuses traversal / malformed URL',async t=>{
  const {server,port}=await startStaticServer({port:0});t.after(()=>new Promise(r=>server.close(r)));
  assert.equal((await request(port,'/engine/target-policy.mjs')).status,200);
  assert.match((await request(port,'/engine/task-policy.mjs')).type,/javascript/);
  assert.equal((await request(port,'/engine/adb-client.mjs')).status,404);
  assert.equal((await request(port,'/%ZZ')).status,400);
  assert.equal((await request(port,'/..%2fpackage.json')).status,403);
  const fontCss=await request(port,'/fonts/fonts.css');
  assert.equal(fontCss.status,200);
  const urls=[...fontCss.body.matchAll(/url\(\.\/([^)]+)\)/g)].map(match=>match[1]);
  assert.ok(urls.length>0);
  assert.doesNotMatch(fontCss.body,/url\(https?:/);
  for(const file of new Set(urls)){
    const font=await request(port,'/fonts/'+file);
    assert.equal(font.status,200);assert.equal(font.type,'font/woff2');
  }
  assert.doesNotMatch((await request(port,'/index.html')).body,/<link[^>]*https:\/\/fonts\./);
});
test('occupied port creates owned service on a new port',async t=>{
  const first=await startStaticServer({port:0});t.after(()=>new Promise(r=>first.server.close(r)));
  const second=await startStaticServer({port:first.port});t.after(()=>new Promise(r=>second.server.close(r)));
  assert.notEqual(first.port,second.port);
});
