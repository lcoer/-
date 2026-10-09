import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeResult, countResult } from '../src/task-result.mjs';
test('boolean ok without evidence cannot claim confirmed UI', () => {
  assert.equal(normalizeResult({ ok: true }, { mode: 'android' }).outcome, 'unconfirmed');
});
test('declared confirmation without complete input, message and identity evidence is downgraded',()=>{
  assert.equal(normalizeResult({outcome:'confirmed_ui',evidence:{newExactText:true}},{mode:'android',targetUid:'12345'}).outcome,'unconfirmed');
  const evidence={inputMatched:true,inputCleared:true,beforeExactCount:0,afterExactCount:1,actualUid:'12345'};
  assert.equal(normalizeResult({outcome:'confirmed_ui',evidence},{mode:'android',targetUid:'12345'}).outcome,'confirmed_ui');
});
test('non-confirmed outcomes never increment real success count', () => {
  const stats = {};
  for (const outcome of ['simulated', 'failed', 'unconfirmed', 'cancelled', 'skipped']) countResult(stats, { outcome });
  assert.equal(stats.ok || 0, 0);
  assert.equal(stats.unconfirmed, 1);
  countResult(stats, { outcome: 'confirmed_ui' });
  assert.equal(stats.ok, 1);
});
