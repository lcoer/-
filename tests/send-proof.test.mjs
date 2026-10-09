import test from 'node:test';
import assert from 'node:assert/strict';
import { proveSendRejection, isDefinitiveSendRejection, hasUncertainSendFailure } from '../src/send-proof.cjs';
import { n, rejectedRow } from './fixtures/send-rejection.cjs';
test('known rejection is bound to the only new outgoing exact message row', () => {
  const proof = proveSendRejection([], rejectedRow(), 'hello');
  assert.equal(proof.reason, 'ACCOUNT_CONTRIBUTION_LEVEL_REQUIRED');
  assert.equal(isDefinitiveSendRejection({ outcome: 'failed', reason: proof.reason, evidence: { inputMatched: true, beforeExactCount: 0, afterExactCount: 1, actualUid: '12345', rejection: proof } }, '12345'), true);
});
test('historical, unrelated, unknown, foreign-package and ambiguous rows are not definitive', () => {
  assert.equal(proveSendRejection(rejectedRow(), rejectedRow(), 'hello'), null);
  assert.equal(proveSendRejection([], rejectedRow('other'), 'hello'), null);
  assert.equal(proveSendRejection([], rejectedRow().map(n => n.shortId === 'rc_errorhint' ? { ...n, text: '发生错误' } : n), 'hello'), null);
  assert.equal(proveSendRejection([], rejectedRow().map(n => ({ ...n, packageName: 'foreign' })), 'hello'), null);
  assert.equal(proveSendRejection([], [...rejectedRow(), n('rc_text', 'other', 20, 350, 200, 410)], 'hello'), null);
  assert.equal(proveSendRejection([], rejectedRow().filter(n => n.shortId !== 'rc_right_portrait'), 'hello'), null);
});
test('a prior message rejection cannot attach to a new successful row', () => {
  const old = rejectedRow('old');
  const fresh = rejectedRow().map(n => ({ ...n, y: n.y + 400, y2: n.y2 + 400 })).filter(n => n.shortId !== 'rc_errorhint');
  assert.equal(proveSendRejection(old, [...old, ...fresh], 'hello'), null);
});

test('rejection validation requires current recipient and complete geometric proof', () => {
  const rejection = proveSendRejection([], rejectedRow(), 'hello');
  const result = { outcome: 'failed', reason: rejection.reason, evidence: { inputMatched: true, beforeExactCount: 0, afterExactCount: 1, actualUid: '12345', rejection } };
  assert.equal(isDefinitiveSendRejection(result, '54321'), false);
  assert.equal(isDefinitiveSendRejection({ ...result, evidence: { ...result.evidence, rejection: { ...rejection, rowBounds: {} } } }, '12345'), false);
  assert.equal(isDefinitiveSendRejection({ ...result, evidence: { ...result.evidence, beforeExactCount: 1 } }, '12345'), false);
});

const move = (nodes, dy) => nodes.map(n => ({ ...n, y: n.y + dy, y2: n.y2 + dy }));
const freshRow = () => move(rejectedRow('hello').filter(n => n.shortId !== 'rc_errorhint'), 400);
test('old failure can move geometrically while the new successful row is confirmed', () => {
  const before = rejectedRow('old');
  const after = [...move(before, 40), ...freshRow()];
  assert.equal(hasUncertainSendFailure(before, after, 'hello'), false);
});
test('an unknown failure on the new row is never hidden by old failure history', () => {
  const before = rejectedRow('old');
  const fresh = move(rejectedRow('hello'), 400).map(n => n.shortId === 'rc_errorhint' ? { ...n, text: '未知发送错误' } : n);
  assert.equal(hasUncertainSendFailure(before, [...move(before, 40), ...fresh], 'hello'), true);
});
test('lost old rows and unbound errors remain uncertain', () => {
  const before = rejectedRow('old');
  assert.equal(hasUncertainSendFailure(before, rejectedRow('hello'), 'hello'), true);
  assert.equal(hasUncertainSendFailure(before, freshRow(), 'hello'), true);
  assert.equal(hasUncertainSendFailure(before, [...move(before, 40), ...freshRow(), n('unknown_error', '', 50, 5, 100, 55)], 'hello'), true);
});

test('new definitive rejection can coexist with geometrically moved old rejection', () => {
  const before = rejectedRow('old');
  const after = [...move(before, 40), ...move(rejectedRow('hello'), 400)];
  const proof = proveSendRejection(before, after, 'hello');
  assert.equal(proof.reason, 'ACCOUNT_CONTRIBUTION_LEVEL_REQUIRED');
  assert.equal(proof.beforeMessageCount, 1);
  assert.equal(proof.afterMessageCount, 2);
});
