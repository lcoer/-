import test from 'node:test';
import assert from 'node:assert/strict';
import { abortableSleep } from '../src/async-control.mjs';
test('sleep rejects immediately on cancellation',async()=>{
 const c=new AbortController(); const p=abortableSleep(10000,c.signal); c.abort();
 await assert.rejects(p,{name:'AbortError'});
});
