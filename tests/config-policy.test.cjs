const test = require('node:test');
const assert = require('node:assert/strict');
const { validateConfigChange } = require('../electron/services/config-policy');
test('configuration only accepts known keys and valid execution modes',()=>{
  assert.equal(validateConfigChange('__proto__',{}).ok,false);
  assert.equal(validateConfigChange('settings',{executionMode:'auto'}).ok,false);
  assert.equal(validateConfigChange('settings',{executionMode:'demo'}).ok,true);
});
test('configuration validates shapes without silently dropping existing unsupported media',()=>{
  assert.equal(validateConfigChange('copywriting',{contents:'bad'}).ok,false);
  assert.equal(validateConfigChange('blacklist',['12345']).ok,true);
  assert.equal(validateConfigChange('rules',{delayMin:5,delayMax:1}).ok,false);
  assert.equal(validateConfigChange('copywriting',{contents:['hello'],mode:'mediaonly',image:{enable:true}}).ok,true);
});
test('collection preferences require a bounded known scope',()=>{
  assert.equal(validateConfigChange('collection',{scope:'multi',maxRooms:12,maxPages:6}).ok,true);
  assert.equal(validateConfigChange('collection',{scope:'multi',maxRooms:999,maxPages:6}).ok,false);
});
