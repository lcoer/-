const test = require('node:test');
const assert = require('node:assert/strict');
const { DeviceSession } = require('../electron/services/device-session');
test('exclusive acquisition is synchronous and old owners cannot release a new run', () => {
  const s = new DeviceSession();
  assert.equal(s.acquire({ owner: 'collect', runId: 'a' }).ok, true);
  assert.deepEqual(s.acquire({ owner: 'private', runId: 'b' }), { ok: false, reason: 'DEVICE_BUSY', owner: 'collect' });
  assert.equal(s.release('private', 'b'), false);
  assert.equal(s.release('collect', 'a'), true);
  assert.equal(s.acquire({ owner: 'private', runId: 'b' }).ok, true);
  assert.equal(s.release('collect', 'a'), false);
  assert.equal(s.getStatus().owner, 'private');
});
