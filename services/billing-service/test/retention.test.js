import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { FileStore } from '@hookwatch/shared';
import { createBillingApp } from '../src/app.js';
import { startRetentionSweeper, sweepExpired } from '../src/retention.js';

const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

function serve(handler) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => handler(req, res));
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hookwatch-retention-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new FileStore(path.join(dir, 'store'));
  await store.init();
  return { store };
}

const subscribe = (store, org_id, plan_id) =>
  store.insert('subscriptions', {
    id: org_id,
    org_id,
    plan_id,
    status: 'active',
    created_at: ago(200),
    updated_at: ago(200),
  });

const delivery = (store, org_id, status, created_at) =>
  store.insert('deliveries', {
    org_id,
    endpoint_id: 'e1',
    attempt: 1,
    status,
    request: { method: 'POST', body: {}, raw: '{}' },
    created_at,
    available_at: created_at,
  });

test('purgeOlderThan respects the cutoff, the status allowlist and the org list', async (t) => {
  const { store } = await setup(t);
  const old = await delivery(store, 'acme', 'delivered', ago(5));
  const fresh = await delivery(store, 'acme', 'delivered', ago(1));
  const other = await delivery(store, 'someone-else', 'delivered', ago(5));

  const removed = await store.purgeOlderThan('deliveries', {
    beforeIso: ago(2),
    statuses: ['delivered', 'dead'],
    orgIds: ['acme'],
  });

  assert.deepEqual(removed, [old.id]);
  assert.ok(await store.get('deliveries', fresh.id), 'inside the window survives');
  assert.ok(await store.get('deliveries', other.id), 'another org is untouched');
});

test('purgeOlderThan never touches a status outside the allowlist', async (t) => {
  const { store } = await setup(t);
  const inflight = await delivery(store, 'acme', 'retrying', ago(400));
  const dead = await delivery(store, 'acme', 'dead', ago(400));

  const removed = await store.purgeOlderThan('deliveries', {
    beforeIso: ago(1),
    statuses: ['delivered', 'dead'],
    orgIds: ['acme'],
  });

  assert.deepEqual(removed, [dead.id]);
  assert.ok(
    await store.get('deliveries', inflight.id),
    'an unfinished delivery must outlive a retention sweep',
  );
});

test('purgeOlderThan refuses an out-of-scope table and an empty allowlist', async (t) => {
  const { store } = await setup(t);
  await store.appendUsage('acme', { period: '2026-09', requests: 5, bytes: 10 });

  await assert.rejects(
    () => store.purgeOlderThan('usage', { beforeIso: ago(1), statuses: ['delivered'] }),
    /not purgeable/,
    'the billing record is out of retention scope',
  );
  await assert.rejects(
    () => store.purgeOlderThan('endpoints; drop table deliveries', {
      beforeIso: ago(1),
      statuses: ['delivered'],
    }),
    /not purgeable/,
    'a table name is allowlisted, never interpolated',
  );
  await assert.rejects(
    () => store.purgeOlderThan('deliveries', { beforeIso: ago(1), statuses: [] }),
    /explicit status allowlist/,
  );

  assert.equal((await store.list('usage')).length, 1, 'usage survives a rejected sweep');
});

test('sweep prunes each org by its own plan window', async (t) => {
  const { store } = await setup(t);
  await subscribe(store, 'freeman', 'free'); // 1 day
  await subscribe(store, 'team', 'pro'); // 14 days
  await subscribe(store, 'bigcorp', 'scale'); // 90 days

  const threeDays = ago(3);
  const freeman = await delivery(store, 'freeman', 'delivered', threeDays);
  const team = await delivery(store, 'team', 'delivered', threeDays);
  const bigcorp = await delivery(store, 'bigcorp', 'delivered', threeDays);
  await store.insert('alerts', {
    org_id: 'freeman',
    endpoint_id: 'e1',
    kind: 'delivery_failed',
    channel: 'log',
    payload: {},
    status: 'sent',
    created_at: threeDays,
  });

  const report = await sweepExpired({ store });

  assert.equal(await store.get('deliveries', freeman.id), undefined, 'free is 1 day deep');
  assert.ok(await store.get('deliveries', team.id), 'pro keeps 14 days');
  assert.ok(await store.get('deliveries', bigcorp.id), 'scale keeps 90 days');

  assert.equal(report.removed.deliveries, 1);
  assert.equal(report.removed.alerts, 1);
  assert.deepEqual(report.by_window['1'].orgs, ['freeman']);
});

test('sweep skips an org with history but no priced plan instead of guessing', async (t) => {
  const { store } = await setup(t);
  // No subscription row: charging rules were never decided for this org, so
  // neither were deletion rules.
  const ancient = await delivery(store, 'orphan', 'delivered', ago(900));

  const report = await sweepExpired({ store });

  assert.ok(await store.get('deliveries', ancient.id), 'unpriced org keeps its history');
  assert.deepEqual(report.skipped_no_plan, ['orphan']);
  assert.equal(report.removed.deliveries, 0);
});

test('sweep leaves an in-flight retry alone even a year past a free window', async (t) => {
  const { store } = await setup(t);
  await subscribe(store, 'acme', 'free');
  const inflight = await delivery(store, 'acme', 'in_progress', ago(365));
  const queued = await delivery(store, 'acme', 'queued', ago(365));

  await sweepExpired({ store });

  assert.ok(await store.get('deliveries', inflight.id));
  assert.ok(await store.get('deliveries', queued.id));
});

test('POST /v1/retention/sweep is internal-only and returns the report', async (t) => {
  const { store } = await setup(t);
  await subscribe(store, 'acme', 'free');
  await delivery(store, 'acme', 'delivered', ago(30));

  // kickoffMs: null — a boot sweep racing the route call would empty the
  // table before the request gets to report on it.
  const sweeper = startRetentionSweeper({ store, kickoffMs: null });
  t.after(() => sweeper.stop());
  const billing = await serve(createBillingApp({ store, queue: null, sweeper }));
  t.after(() => billing.server.close());

  const denied = await fetch(`${billing.url}/v1/retention/sweep`, { method: 'POST' });
  assert.equal(denied.status, 401, 'a sweep deletes data, so it is never public');

  const res = await fetch(`${billing.url}/v1/retention/sweep`, {
    method: 'POST',
    headers: { 'x-hookwatch-internal': 'dev-internal-token' },
  });
  assert.equal(res.status, 200);
  const report = await res.json();
  assert.equal(report.removed.deliveries, 1);
  assert.equal((await store.list('deliveries')).length, 0, 'the swept row is really gone');
});
