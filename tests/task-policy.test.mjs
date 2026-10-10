import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePrivateConfig } from '../src/task-policy.mjs';
const valid = () => ({ targets: [{ uid: '12345', nickname: 'fixture', source: 'local', uidReal: true }], contents: ['hello'], mode: 'random', delayMin: 1, delayMax: 2, sendLimit: 0 });
test('acceptance rejects malformed blacklist, overlong text and unsafe primitive UIDs', () => {
  for (const change of [{ blacklist: '12345' }, { blacklist: [null] }, { contents: ['x'.repeat(2001)] }, { targets: [true] }, { targets: [12345] }, { targets: [{ uid: '1'.repeat(33), source: 'local' }] }]) {
    assert.equal(validatePrivateConfig({ ...valid(), ...change }).ok, false, JSON.stringify(change).slice(0, 100));
  }
});
test('reject empty text and unsupported media before navigation', () => {
  for (const change of [{ contents: [] }, { contents: ['   '] }, { mode: 'mediaonly' }, { image: { enable: true } }, { voice: { enable: true } }, { mode: 'select', selectedIndex: 9 }]) {
    assert.equal(validatePrivateConfig({ ...valid(), ...change }).ok, false);
  }
});
test('reject invalid limits and delays, never silently default', () => {
  for (const change of [{ delayMin: -1 }, { delayMax: NaN }, { delayMin: 5, delayMax: 2 }, { sendLimit: -1 }, { sendLimit: 1.5 }, { delayMin: '' }]) {
    assert.equal(validatePrivateConfig({ ...valid(), ...change }).ok, false);
  }
  assert.equal(validatePrivateConfig(valid()).ok, true);
});
test('invalid targets reject whole batch instead of silently dropping targets', () => {
  const cfg = valid(); cfg.targets.push({ uid: 'n123', nickname: 'fixture', source: 'room', uidReal: false });
  assert.equal(validatePrivateConfig(cfg).ok, false);
});
