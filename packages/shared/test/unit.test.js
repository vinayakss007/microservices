import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PLANS, periodKey, planById } from '../src/index.js';
import { retryDelay } from '../src/index.js';
import { sign, verifySignature } from '../src/index.js';

test('plans ladder is monotonically more generous', () => {
  const limits = PLANS.map((plan) => plan.request_limit);
  assert.deepEqual(limits, [...limits].sort((a, b) => a - b));
  const prices = PLANS.map((plan) => plan.price_monthly_cents);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
});

test('planById resolves ids and rejects typos', () => {
  assert.equal(planById('pro').name, 'Pro');
  assert.equal(planById('enterprise'), undefined);
});

test('periodKey is a stable UTC month bucket', () => {
  assert.equal(periodKey(new Date(Date.UTC(2026, 8, 27))), '2026-09');
  assert.equal(periodKey(new Date(Date.UTC(2026, 0, 1))), '2026-01');
});

test('retryDelay grows ~4x per attempt and honours the cap', () => {
  const first = retryDelay(1, { baseMs: 1000, capMs: 100_000 });
  const third = retryDelay(3, { baseMs: 1000, capMs: 100_000 });
  assert.ok(first >= 1000 && first <= 1200, `first=${first}`);
  assert.ok(third >= 16000 && third <= 19200, `third=${third}`);
  assert.ok(retryDelay(50, { baseMs: 1000, capMs: 5000 }) <= 5000);
});

test('signature round-trips and rejects tampered bodies', () => {
  const secret = 'topsecret';
  const body = '{"type":"invoice.paid"}';
  const header = sign(secret, body);
  assert.equal(verifySignature(secret, header, body), true);
  assert.equal(verifySignature(secret, header, body + 'x'), false);
  assert.equal(verifySignature('other', header, body), false);
  assert.equal(verifySignature(secret, undefined, body), false);
});

test('signature rejects stale timestamps', () => {
  const secret = 'topsecret';
  const body = '{}';
  const old = sign(secret, body, Math.floor(Date.now() / 1000) - 3600);
  assert.equal(verifySignature(secret, old, body), false);
});
