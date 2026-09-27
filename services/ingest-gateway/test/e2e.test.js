import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { config, FileQueue, FileStore, planById } from '@hookwatch/shared';
import { createIngestApp } from '../src/app.js';
import { createBillingApp } from '../../billing-service/src/app.js';
import { createNotifier } from '../../notifier-service/src/notifier.js';
import { createDeliveryWorker } from '../../delivery-worker/src/worker.js';

/** Fast timers so a full retry ladder completes inside a test run. */
config.maxAttempts = 3;
config.backoffBaseMs = 40;
config.backoffCapMs = 200;
config.pollIntervalMs = 20;
config.deliveryTimeoutMs = 2000;

function serve(handler) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => handler(req, res));
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}

/**
 * The gateway builds public sink URLs from its own address, which only exists
 * after listen(). Bind through a late-bound dispatcher to break the cycle.
 */
async function serveIngest({ store, queue }) {
  let app;
  const server = await serve((req, res) => app(req, res));
  app = createIngestApp({ store, queue, publicBaseUrl: server.url });
  return server;
}

async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hookwatch-e2e-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const store = new FileStore(path.join(dir, 'store'));
  await store.init();

  const deliverQueue = new FileQueue(path.join(dir, 'queue'));
  await deliverQueue.init();
  // Same journal, second handle == independent cursor. In production these are
  // separate processes; here they are separate consumer groups.
  const alertQueue = new FileQueue(path.join(dir, 'queue'));
  await alertQueue.init();

  const billing = await serve(createBillingApp({ store, queue: alertQueue }));
  config.billingUrl = billing.url;
  t.after(() => billing.server.close());

  const ingest = await serveIngest({ store, queue: deliverQueue });
  t.after(() => ingest.server.close());

  const worker = createDeliveryWorker({ store, queue: deliverQueue });
  const notifier = createNotifier({ store, queue: alertQueue });
  worker.run().catch(() => {});
  notifier.run().catch(() => {});
  t.after(() => {
    worker.stop();
    notifier.stop();
  });

  return { store, billing, ingest, worker, notifier };
}

const auth = { 'content-type': 'application/json', 'x-hookwatch-internal': 'dev-internal-token' };

async function createEndpoint(ingestUrl, body) {
  const res = await fetch(`${ingestUrl}/v1/endpoints`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('pipeline: ingest persists, retries a flaky target, then delivers', async (t) => {
  const { store, billing, ingest } = await setup(t);

  let hits = 0;
  const target = await serve(async (req, res) => {
    hits += 1;
    for await (const _chunk of req) {
      // Drain the request body so the socket closes cleanly.
    }
    const status = hits <= 2 ? 503 : 200; // fail twice, then recover
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: status === 200, hits }));
  });
  t.after(() => target.server.close());

  const created = await createEndpoint(ingest.url, {
    org_id: 'acme',
    name: 'stripe',
    target_url: `${target.url}/hook`,
    secret: 'whsec_test',
    alert_channels: ['log'],
  });
  assert.equal(created.status, 200);
  const endpoint = created.body;
  assert.match(endpoint.ingest_url, new RegExp(`^${ingest.url}/i/`), 'sink URL must point at the gateway');
  // Shown exactly once at creation, so the user can configure verification.
  assert.equal(endpoint.secret, 'whsec_test');
  const listed = await (await fetch(`${ingest.url}/v1/endpoints`, { headers: { 'x-org-id': 'acme' } })).json();
  assert.equal(listed[0].secret, undefined, 'listing must never re-expose the secret');

  const accepted = await fetch(endpoint.ingest_url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'invoice.paid', amount: 4200 }),
  });
  assert.equal(accepted.status, 202, 'gateway acknowledges before delivering');
  const receipt = await accepted.json();
  assert.equal(receipt.quota.used, 1, 'metered once per ingest, not per attempt');

  const delivered = await waitFor(async () => {
    const row = await store.get('deliveries', receipt.id);
    return row?.status === 'delivered' ? row : null;
  });

  assert.equal(delivered.attempt, 3, 'walked the retry ladder');
  assert.equal(hits, 3, 'target saw every attempt');
  assert.equal(delivered.response.status, 200);
  assert.equal(delivered.request.body.type, 'invoice.paid', 'payload preserved verbatim');

  const usage = await (await fetch(`${billing.url}/v1/usage?org_id=acme`)).json();
  assert.equal(usage.used, 1, 'three delivery attempts must not bill three requests');
  assert.equal(usage.plan, 'free');
});

test('pipeline: a permanently failing target dead-letters and raises an alert', async (t) => {
  const { store, ingest } = await setup(t);

  let hits = 0;
  const target = await serve(async (_req, res) => {
    hits += 1;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"boom"}');
  });
  t.after(() => target.server.close());

  const created = await createEndpoint(ingest.url, {
    org_id: 'acme',
    name: 'always-down',
    target_url: `${target.url}/hook`,
  });
  const receipt = await (
    await fetch(created.body.ingest_url, { method: 'POST', body: '{"type":"dead.test"}' })
  ).json();

  const dead = await waitFor(async () => {
    const row = await store.get('deliveries', receipt.id);
    return row?.status === 'dead' ? row : null;
  });

  assert.equal(hits, config.maxAttempts, 'every attempt reached the target');
  assert.equal(dead.attempt, config.maxAttempts);
  assert.match(dead.error, /after 3 attempts/);

  const alerts = await waitFor(async () => {
    const rows = await store.list('alerts', (row) => row.endpoint_id === created.body.id);
    return rows.length ? rows : null;
  });
  assert.equal(alerts[0].kind, 'delivery_failed');
  assert.equal(alerts[0].status, 'sent');
  assert.match(alerts[0].payload.detail, /500/);
});

test('billing gates endpoint creation but never drops an over-limit webhook', async (t) => {
  const { store, billing, ingest } = await setup(t);

  const okTarget = await serve(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  t.after(() => okTarget.server.close());

  const makeEndpoint = (name) =>
    createEndpoint(ingest.url, { org_id: 'quota', name, target_url: `${okTarget.url}/hook` });

  // Free plan allows exactly one endpoint.
  assert.equal((await makeEndpoint('a')).status, 200);
  const blocked = await makeEndpoint('b');
  assert.equal(blocked.status, 402, 'over-plan endpoint is refused');
  assert.match(blocked.body.error, /upgrade/);

  // Upgrading unlocks it — the core monetisation motion, end to end.
  await fetch(`${billing.url}/v1/subscriptions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ org_id: 'quota', plan_id: 'pro' }),
  });
  assert.equal((await makeEndpoint('b2')).status, 200);

  const pro = planById('pro');
  const existing = await store.list('endpoints', (row) => row.org_id === 'quota');
  await store.insert('usage', {
    id: 'seed',
    org_id: 'quota',
    period: new Date().toISOString().slice(0, 7),
    requests: pro.request_limit,
    bytes: 0,
  });

  // Past the request cap the sender is still accepted: no webhook is dropped.
  const over = await fetch(`${ingest.url}/i/${existing[0].url_path}`, {
    method: 'POST',
    body: '{"type":"over"}',
  });
  assert.equal(over.status, 202, 'over quota must never reject the sender');
  const body = await over.json();
  assert.equal(body.quota.over_limit, true, 'receipt must surface the overage');
  assert.equal(body.quota.limit, pro.request_limit);

  const revenue = await (await fetch(`${billing.url}/v1/revenue`, { headers: auth })).json();
  assert.equal(revenue.mrr_cents, pro.price_monthly_cents, 'the upgrade is real MRR');
});

test('ops loop: pause blocks the sink, repointing the target then replaying recovers a dead delivery', async (t) => {
  const { store, ingest } = await setup(t);

  let healthy = false;
  const target = await serve(async (_req, res) => {
    // Same URL, flips from broken to fixed: mirrors a deploy that recovers.
    res.writeHead(healthy ? 200 : 500, { 'content-type': 'application/json' });
    res.end('{}');
  });
  t.after(() => target.server.close());

  const created = await createEndpoint(ingest.url, {
    org_id: 'ops',
    name: 'payments',
    target_url: `${target.url}/hook`,
  });
  assert.equal(created.status, 200);

  // Break it, let it exhaust into the dead letter queue.
  const receipt = await (
    await fetch(created.body.ingest_url, { method: 'POST', body: '{"type":"charge.failed"}' })
  ).json();
  const dead = await waitFor(async () => {
    const row = await store.get('deliveries', receipt.id);
    return row?.status === 'dead' ? row : null;
  });
  assert.equal(dead.status, 'dead');

  // Pause stops accepting inbound events at the sink entirely.
  const paused = await (
    await fetch(`${ingest.url}/v1/endpoints/${created.body.id}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ status: 'paused' }),
    })
  ).json();
  assert.equal(paused.status, 'paused');
  assert.equal(paused.secret, undefined, 'PATCH must not re-expose the secret');

  const whilePaused = await fetch(created.body.ingest_url, { method: 'POST', body: '{"type":"x"}' });
  assert.equal(whilePaused.status, 404, 'a paused endpoint must not accept traffic');

  // Resume, fix the target, and replay the dead event.
  await fetch(`${ingest.url}/v1/endpoints/${created.body.id}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ status: 'active' }),
  });
  healthy = true;

  const replay = await (
    await fetch(`${ingest.url}/v1/deliveries/${dead.id}/replay`, { method: 'POST', headers: auth })
  ).json();
  assert.ok(replay.id, 'replay creates a new delivery');
  assert.notEqual(replay.id, dead.id, 'replay must not mutate the original record');

  const recovered = await waitFor(async () => {
    const row = await store.get('deliveries', replay.id);
    return row?.status === 'delivered' ? row : null;
  });
  assert.equal(recovered.request.body.type, 'charge.failed', 'replay sends the original payload');
  assert.equal(recovered.request.replayed_from, dead.id);

  // The dead original stays dead: replay is an audit-safe copy, not a rewrite.
  const original = await store.get('deliveries', dead.id);
  assert.equal(original.status, 'dead');
});

test('PATCH validates input rather than silently corrupting an endpoint', async (t) => {
  const { ingest } = await setup(t);

  const okTarget = await serve(async (_req, res) => res.writeHead(200).end('{}'));
  t.after(() => okTarget.server.close());

  const created = await createEndpoint(ingest.url, {
    org_id: 'val',
    name: 'x',
    target_url: `${okTarget.url}/hook`,
  });
  const patch = (body) =>
    fetch(`${ingest.url}/v1/endpoints/${created.body.id}`, { method: 'PATCH', headers: auth, body: JSON.stringify(body) });

  assert.equal((await patch({ status: 'exploded' })).status, 400, 'unknown status rejected');
  assert.equal((await patch({ target_url: 'javascript:alert(1)' })).status, 400, 'non-http target rejected');
  assert.equal((await patch({ target_url: 'https://example.com/ok' })).status, 200);

  const missing = await fetch(`${ingest.url}/v1/endpoints/does-not-exist`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ name: 'y' }),
  });
  assert.equal(missing.status, 404);

  // No token, no write.
  const unauthed = await fetch(`${ingest.url}/v1/endpoints/${created.body.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'z' }),
  });
  assert.equal(unauthed.status, 401, 'endpoint writes require the internal token');
});
