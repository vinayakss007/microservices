import { config } from '@hookwatch/shared';

/**
 * Seeds a demo org against a running `npm run dev` stack and drives traffic
 * through it, so the dashboard shows a live retry ladder, a dead letter and an alert.
 *   node scripts/seed.js
 */
const ingest = process.env.INGEST_URL ?? 'http://127.0.0.1:8081';
const billing = process.env.BILLING_URL ?? 'http://127.0.0.1:8084';
const target = process.env.MOCK_TARGET_URL ?? 'http://127.0.0.1:8090';

const internal = { 'content-type': 'application/json', 'x-hookwatch-internal': config.internalToken };

async function createEndpoint(name, targetUrl) {
  const res = await fetch(`${ingest}/v1/endpoints`, {
    method: 'POST',
    headers: internal,
    body: JSON.stringify({ org_id: 'acme', name, target_url: targetUrl, alert_channels: ['log'] }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${name}: ${res.status} ${body.error}`);
  return body;
}

const fire = async (url, payload) => {
  const res = await fetch(url, { method: 'POST', body: JSON.stringify(payload) });
  const body = await res.json().catch(() => ({}));
  return `${res.status} (used ${body.quota?.used ?? '?'}/${body.quota?.limit ?? '?'})`;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Free allows one endpoint; upgrading to Pro first is what lets the demo have three.
const upgrade = await fetch(`${billing}/v1/subscriptions`, {
  method: 'POST',
  headers: internal,
  body: JSON.stringify({ org_id: 'acme', plan_id: 'pro' }),
});
console.log(`acme -> pro: ${upgrade.status}`);

const endpoints = [
  await createEndpoint('orders-ok', `${target}/`),
  await createEndpoint('stripe-flaky', `${target}/flaky`),
  await createEndpoint('broken-sink', `${target}/down`),
];
console.log('seeded endpoints:');
for (const e of endpoints) console.log(`  ${e.name.padEnd(13)} ${e.ingest_url}`);

for (let i = 1; i <= 2; i += 1) {
  for (const e of endpoints) {
    console.log(`  fire ${e.name.padEnd(13)} -> ${await fire(e.ingest_url, { type: `${e.name}.event`, n: i })}`);
  }
}

// Wait for the ladder to settle instead of guessing a sleep: with the default
// MAX_ATTEMPTS=6 the full backoff runs past two minutes.
console.log('\nwaiting for deliveries to settle...');
const deadline = Date.now() + 180_000;
let deliveries = [];
for (;;) {
  deliveries = await (await fetch(`${ingest}/v1/deliveries?limit=30`, { headers: { 'x-org-id': 'acme' } })).json();
  const pending = deliveries.filter((d) => d.status === 'queued' || d.status === 'retrying' || d.status === 'in_progress');
  if (!pending.length || Date.now() > deadline) break;
  console.log(`  ${pending.length} still retrying (highest attempt ${Math.max(...pending.map((d) => d.attempt))})...`);
  await sleep(10_000);
}

const summary = deliveries.reduce((acc, d) => ({ ...acc, [d.status]: (acc[d.status] ?? 0) + 1 }), {});
console.log('delivery states:', summary);
console.log('attempts seen:', deliveries.map((d) => `${d.status}/${d.attempt}`).slice(0, 8).join(', '));

const alerts = await (await fetch(`${process.env.NOTIFIER_URL ?? 'http://127.0.0.1:8083'}/v1/alerts?limit=10`, { headers: { 'x-org-id': 'acme' } })).json();
console.log('alerts:', alerts.map((a) => `${a.kind} -> ${a.channel} ${a.status}`).join(' | ') || 'none');

console.log('billing:', await (await fetch(`${billing}/v1/revenue`, { headers: internal })).json());
console.log('\ndashboard: http://localhost:8080 (org "acme")');
