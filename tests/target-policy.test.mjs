import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLocalTargets, normalizeTargets } from '../src/target-policy.mjs';

test('local parsing preserves full nickname including commas and spaces', () => {
  assert.deepEqual(parseLocalTargets('12345,小 明,同学\n23456 小 王\n34567'), [
    { uid: '12345', nickname: '小 明,同学', source: 'local', uidReal: true },
    { uid: '23456', nickname: '小 王', source: 'local', uidReal: true },
    { uid: '34567', nickname: null, source: 'local', uidReal: true },
  ]);
});
test('real targets exclude demo, unknown identity and malformed uid; dedupe by uid', () => {
  const { targets, rejected, duplicates } = normalizeTargets([
    { uid: '12345', nickname: 'fixture', source: 'room', uidReal: true },
    { uid: '12345', nickname: 'fixture', source: 'local' },
    { uid: '23456', nickname: 'sample', source: 'demo' },
    { uid: 'n123', nickname: 'unresolved', source: 'room', uidReal: false },
    { uid: 'abc34567', nickname: 'bad', source: 'local' },
  ]);
  assert.equal(targets.length, 1);
  assert.equal(rejected.length, 3);
  assert.equal(duplicates.length, 1);
});
test('real UID search accepts missing nickname but still requires known source', () => {
  const r=normalizeTargets([{ uid: '12345', nickname: 'fixture' }, { uid: '23456', source: 'local' }]);
  assert.equal(r.targets.length,1);assert.equal(r.targets[0].uid,'23456');assert.equal(r.targets[0].nickname,null);assert.equal(r.rejected.length,1);
});
