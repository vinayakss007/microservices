const orgInput = document.getElementById('org');
const autoBox = document.getElementById('auto');
const statusDot = document.getElementById('status-dot');

const org = () => orgInput.value.trim() || 'acme';
let statusFilter = '';
let timer = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toast(message, isError = false) {
  const box = el('div', `toast${isError ? ' err' : ''}`, message);
  document.body.append(box);
  setTimeout(() => box.remove(), 4500);
}

async function api(path, init = {}) {
  const res = await fetch(`/api/${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-org-id': org(),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `${path} -> ${res.status}`);
  return data;
}

function kpi(label, value, sub) {
  const card = el('div', 'kpi');
  card.append(el('div', 'label', label), el('div', 'value', String(value)));
  if (sub) card.append(el('div', 'sub', sub));
  return card;
}

function empty(container, text) {
  container.append(el('div', 'empty', text));
}

async function renderKpis(deliveries, billing) {
  const box = document.getElementById('kpis');
  box.textContent = '';
  const counts = deliveries.reduce((acc, d) => ({ ...acc, [d.status]: (acc[d.status] ?? 0) + 1 }), {});
  const failed = (counts.dead ?? 0) + (counts.retrying ?? 0);
  const rate = deliveries.length ? Math.round(((deliveries.length - failed) / deliveries.length) * 100) : 100;

  box.append(
    kpi('deliveries', deliveries.length, `${counts.delivered ?? 0} delivered`),
    kpi('success rate', `${rate}%`, `${failed} failing / dead`),
    kpi('requests used', billing?.used ?? 0, `${billing?.limit ?? '-'} included`),
    kpi('plan', billing?.plan ?? 'free', `$${((billing?.price_monthly_cents ?? 0) / 100).toFixed(2)}/mo`),
  );
}

function deliveryCard(delivery) {
  const card = el('div', 'card');
  const row = el('div', 'row');
  row.append(
    el('div', 'name', `${delivery.endpoint_id.slice(0, 8)} · ${delivery.request?.method ?? 'POST'}`),
    el('span', `badge ${delivery.status}`, delivery.status),
  );
  card.append(row);

  const meta = el('div', 'meta');
  meta.append(
    el('span', '', `attempt ${delivery.attempt}`),
    el('span', '', delivery.response?.status ? `http ${delivery.response.status}` : 'no response'),
    el('span', '', delivery.response?.latency_ms ? `${delivery.response.latency_ms}ms` : ''),
    el('span', '', new Date(delivery.created_at).toLocaleTimeString()),
  );
  card.append(meta);

  if (delivery.error) card.append(el('pre', 'payload', `error: ${delivery.error}`));
  card.append(el('pre', 'payload', `body: ${JSON.stringify(delivery.request?.body ?? null, null, 1)}`));

  const actions = el('div', 'row');
  const replay = el('button', 'tiny ghost', 'replay');
  replay.addEventListener('click', async () => {
    replay.disabled = true;
    try {
      const result = await api(`ingest/v1/deliveries/${delivery.id}/replay`, { method: 'POST' });
      toast(`replay queued as ${result.id.slice(0, 8)}`);
      load();
    } catch (error) {
      toast(error.message, true);
    } finally {
      replay.disabled = false;
    }
  });
  actions.append(replay);
  card.append(actions);
  return card;
}

function endpointCard(endpoint) {
  const card = el('div', 'card');
  const row = el('div', 'row');
  row.append(el('div', 'name', endpoint.name), el('span', `badge ${endpoint.status ?? 'active'}`, endpoint.status ?? 'active'));
  card.append(row);
  card.append(el('div', 'url', endpoint.ingest_url ?? ''));
  card.append(el('div', 'meta', `target: ${endpoint.target_url}`));

  const actions = el('div', 'row');

  const send = el('button', 'tiny', 'send test event');
  send.addEventListener('click', async () => {
    try {
      // Go through the dashboard proxy so the browser keeps one origin.
      const path = new URL(endpoint.ingest_url).pathname;
      const res = await fetch(`/api/ingest${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'test.event', endpoint: endpoint.name, at: new Date().toISOString() }),
      });
      const data = await res.json();
      toast(res.ok ? `queued ${data.id?.slice(0, 8)} — used ${data.quota?.used}/${data.quota?.limit}` : data.error, !res.ok);
      load();
    } catch (error) {
      toast(error.message, true);
    }
  });

  const pause = el('button', 'tiny ghost', endpoint.status === 'paused' ? 'resume' : 'pause');
  pause.addEventListener('click', async () => {
    pause.disabled = true;
    try {
      await api(`ingest/v1/endpoints/${endpoint.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: endpoint.status === 'paused' ? 'active' : 'paused' }),
      });
      toast(endpoint.status === 'paused' ? 'resumed' : 'paused — the sink now rejects events');
      load();
    } catch (error) {
      toast(error.message, true);
      pause.disabled = false;
    }
  });

  actions.append(send, pause);
  card.append(actions);
  return card;
}

function alertCard(alert) {
  const card = el('div', 'card');
  const row = el('div', 'row');
  row.append(el('div', 'name', `${alert.kind} → ${alert.channel}`), el('span', `badge ${alert.status}`, alert.status));
  card.append(row);
  if (alert.payload?.detail) card.append(el('div', 'meta', alert.payload.detail));
  card.append(el('div', 'meta', new Date(alert.created_at).toLocaleString()));
  return card;
}

function renderBilling(subscription, usage) {
  const box = document.getElementById('billing');
  box.textContent = '';
  if (!subscription) return;
  const card = el('div', 'card');
  card.append(el('div', 'name', `${subscription.plan.name} plan`));
  card.append(
    el(
      'div',
      'meta',
      `invoice ${subscription.invoice.period}: $${(subscription.invoice.total_cents / 100).toFixed(2)} · overage $${(subscription.invoice.overage_cents / 100).toFixed(2)}`,
    ),
  );

  const limit = subscription.invoice.included;
  const used = subscription.invoice.used;
  const bar = el('div', 'bar');
  const fill = el('i');
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100;
  fill.style.width = `${pct}%`;
  if (usage?.over_limit) fill.classList.add('over');
  bar.append(fill);
  card.append(bar);
  card.append(el('div', 'meta', limit > 0 ? `${used} / ${limit} requests (${pct}%)` : `${used} requests · unlimited`));
  box.append(card);
}

function renderSenders(endpoints) {
  const box = document.getElementById('senders');
  box.textContent = '';
  for (const endpoint of endpoints) {
    const card = el('div', 'card');
    card.append(el('div', 'name', endpoint.name));
    card.append(el('div', 'meta', endpoint.target_url));
    box.append(card);
  }
  if (!endpoints.length) empty(box, 'add an endpoint above — a failing target shows the retry ladder');
}

async function load() {
  try {
    const [health, endpoints, billing, usage] = await Promise.all([
      api('health'),
      api('ingest/v1/endpoints'),
      api('billing/v1/subscriptions'),
      api('billing/v1/usage'),
    ]);
    statusDot.className = `dot ${health.services.every((s) => s.ok) ? 'ok' : 'bad'}`;
    health.services.filter((s) => !s.ok).forEach((s) => toast(`${s.name} is down`, true));

    const deliveries = await api(`ingest/v1/deliveries?limit=25${statusFilter ? `&status=${statusFilter}` : ''}`);
    const alerts = await api('notifier/v1/alerts?limit=15');

    await renderKpis(deliveries, { ...usage, price_monthly_cents: billing.plan.price_monthly_cents });

    const endpointBox = document.getElementById('endpoints');
    endpointBox.textContent = '';
    endpoints.forEach((e) => endpointBox.append(endpointCard(e)));
    if (!endpoints.length) empty(endpointBox, 'no endpoints yet — add one below');

    const deliveryBox = document.getElementById('deliveries');
    deliveryBox.textContent = '';
    deliveries.forEach((d) => deliveryBox.append(deliveryCard(d)));
    if (!deliveries.length) empty(deliveryBox, 'no deliveries captured');

    const alertBox = document.getElementById('alerts');
    alertBox.textContent = '';
    alerts.forEach((a) => alertBox.append(alertCard(a)));
    if (!alerts.length) empty(alertBox, 'no alerts — they fire when a delivery permanently fails');

    renderBilling(billing, usage);
    renderSenders(endpoints);
  } catch (error) {
    statusDot.className = 'dot bad';
    toast(error.message, true);
  }
}

document.getElementById('new-endpoint').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const channel = form.get('channel');
  const target = form.get('channel_target');
  try {
    await api('ingest/v1/endpoints', {
      method: 'POST',
      body: JSON.stringify({
        org_id: org(),
        name: form.get('name'),
        target_url: form.get('target_url'),
        alert_channels: target ? [{ channel, target }] : [channel],
      }),
    });
    event.target.reset();
    toast('endpoint created');
    load();
  } catch (error) {
    toast(error.message, true);
  }
});

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    statusFilter = chip.dataset.status;
    load();
  });
});

document.getElementById('refresh').addEventListener('click', load);
orgInput.addEventListener('change', load);
autoBox.addEventListener('change', () => {
  clearInterval(timer);
  if (autoBox.checked) timer = setInterval(load, 3000);
});

if (!autoBox.checked) timer = null;
else timer = setInterval(load, 3000);
load();
