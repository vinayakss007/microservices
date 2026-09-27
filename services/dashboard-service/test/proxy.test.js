import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import { test } from 'node:test';

import { createDashboardHandler } from '../src/app.js';

function serve(handler) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => handler(req, res));
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}

/**
 * A stand-in for a backing service: records the headers it received so the
 * test can prove the token was injected for allowed paths and never reached
 * the upstream for denied ones.
 */
async function fakeService(t, { status = 200, body = { ok: true } } = {}) {
  const calls = [];
  const svc = await serve(async (req, res) => {
    calls.push({ method: req.method, url: req.url, token: req.headers['x-hookwatch-internal'] });
    for await (const _chunk of req) {
      // Drain the body so the socket closes cleanly.
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  t.after(() => svc.server.close());
  return { ...svc, calls };
}

async function dashboard(t, upstreams) {
  const dash = await serve(createDashboardHandler({ upstreams, internalToken: 'tok' }));
  t.after(() => dash.server.close());
  return dash;
}

test('proxy forwards an allowed path with the internal token attached', async (t) => {
  const billing = await fakeService(t, { body: { org_id: 'acme' } });
  const dash = await dashboard(t, { billing: billing.url });

  const res = await fetch(`${dash.url}/api/billing/v1/subscriptions?org_id=acme`, {
    headers: { 'x-org-id': 'acme' },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { org_id: 'acme' });
  assert.equal(billing.calls[0].token, 'tok', 'token injected server-side');
  assert.equal(billing.calls[0].url, '/v1/subscriptions?org_id=acme', 'path and query forwarded');
});

test('the internal token never appears in a proxied response', async (t) => {
  const billing = await fakeService(t, { body: { ok: true } });
  const dash = await dashboard(t, { billing: billing.url });

  const res = await fetch(`${dash.url}/api/billing/v1/usage`);
  assert.equal(res.headers.get('x-hookwatch-internal'), null);
  assert.doesNotMatch(await res.text(), /tok/);
});

test('destructive and business-internal routes are unreachable through the dashboard', async (t) => {
  const billing = await fakeService(t);
  const dash = await dashboard(t, { billing: billing.url });

  for (const path of ['/api/billing/v1/retention/sweep', '/api/billing/v1/revenue']) {
    for (const method of ['GET', 'POST']) {
      const res = await fetch(`${dash.url}${path}`, { method });
      assert.equal(res.status, 404, `${method} ${path} must not proxy`);
    }
  }
  assert.equal(billing.calls.length, 0, 'a denied path never reaches the upstream at all');
});

test('denylisting does not block the same prefix on another service', async (t) => {
  const ingest = await fakeService(t, { body: { id: 'd1' } });
  const dash = await dashboard(t, { ingest: ingest.url });

  const res = await fetch(`${dash.url}/api/ingest/v1/deliveries/d1/replay`, { method: 'POST' });
  assert.equal(res.status, 200, 'replay is a customer-facing action and stays reachable');
  assert.equal(ingest.calls[0].token, 'tok');
});

test('unknown service and traversal are refused', async (t) => {
  const billing = await fakeService(t);
  const dash = await dashboard(t, { billing: billing.url });

  assert.equal((await fetch(`${dash.url}/api/postgres/v1/databases`)).status, 404);
  assert.equal((await fetch(`${dash.url}/api/billing/../../etc/passwd`)).status, 404);
  assert.equal(billing.calls.length, 0, 'a traversal path must not be proxied upstream');
});

/**
 * fetch() normalises `/../` before it hits the wire, so a traversal test built
 * on it would pass without ever exercising the guard. Send literal paths.
 */
function rawGet(port, pathname) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${pathname} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (chunk) => (data += chunk));
    socket.on('close', () => {
      const [head, body] = [data.split('\r\n')[0], data.slice(data.indexOf('\r\n\r\n') + 4)];
      resolve({ head, body });
    });
  });
}

test('static serving resolves inside public/ and never escapes it', async (t) => {
  const dash = await dashboard(t, {});

  const page = await fetch(`${dash.url}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /HookWatch/);

  // The dashboard's own bundle is served; the file one directory up (index.js)
  // and the repo manifest are not.
  assert.equal((await fetch(`${dash.url}/app.js`)).status, 200);

  for (const pathname of [
    '/../index.js',
    '/../package.json',
    '/%2e%2e/package.json',
    '/..%2fpackage.json',
    '/../../etc/passwd',
  ]) {
    const { head, body } = await rawGet(new URL(dash.url).port, pathname);
    assert.match(head, / 404 /, `${pathname} must not resolve outside public/`);
    assert.doesNotMatch(body, /"workspaces"|"@hookwatch\/shared"|root:/);
  }
});

test('an unreachable upstream is a 502, not a stack trace', async (t) => {
  const dash = await dashboard(t, { billing: 'http://127.0.0.1:1' });
  const res = await fetch(`${dash.url}/api/billing/v1/usage`);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /unreachable/);
});
