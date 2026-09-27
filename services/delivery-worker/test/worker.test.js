import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { attemptDelivery, isRetryable, isTerminalStatus } from '../src/worker.js';

function mockServer(responder) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { status, body } = await responder({
        method: req.method,
        url: req.url,
        headers: req.headers,
        raw: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body ?? {}));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('isRetryable only accepts transient failures', () => {
  assert.equal(isRetryable({ status: 500 }), true);
  assert.equal(isRetryable({ status: 503 }), true);
  assert.equal(isRetryable({ status: 429 }), true);
  assert.equal(isRetryable({ error: 'ECONNRESET' }), true);
  assert.equal(isRetryable({ status: 400 }), false);
  assert.equal(isRetryable({ status: 404 }), false);
  assert.equal(isRetryable({ status: 200 }), false);
});

test('isTerminalStatus blocks re-attempts on settled deliveries', () => {
  assert.equal(isTerminalStatus('delivered'), true);
  assert.equal(isTerminalStatus('dead'), true);
  assert.equal(isTerminalStatus('retrying'), false);
  assert.equal(isTerminalStatus('queued'), false);
});

test('attemptDelivery forwards body, headers and signature', async (t) => {
  let captured;
  const { server, port } = await mockServer((request) => {
    captured = request;
    return { status: 200, body: { ok: true } };
  });
  t.after(() => server.close());

  const result = await attemptDelivery(`http://127.0.0.1:${port}/hook`, {
    body: '{"type":"a"}',
    headers: { 'x-hookwatch-delivery-id': 'd1', 'x-hookwatch-attempt': '2', 'content-type': 'application/json' },
    signature: 'v1,ts=1,sig=abc',
  });

  assert.equal(result.status, 200);
  assert.equal(captured.raw, '{"type":"a"}');
  assert.equal(captured.headers['x-hookwatch-signature'], 'v1,ts=1,sig=abc');
  assert.equal(captured.headers['x-hookwatch-attempt'], '2');
  assert.equal(captured.headers['x-hookwatch-delivery-id'], 'd1');
  assert.ok(result.latency_ms >= 0);
});

test('attemptDelivery reports a timeout rather than hanging the worker', async (t) => {
  const { server, port } = await mockServer(
    () => new Promise((resolve) => setTimeout(() => resolve({ status: 200, body: {} }), 500)),
  );
  t.after(() => server.close());

  const result = await attemptDelivery(`http://127.0.0.1:${port}/slow`, {
    body: '{}',
    timeoutMs: 60,
  });

  assert.equal(result.status, 0);
  assert.match(result.error, /timed out/);
  assert.equal(isRetryable(result), true);
});

test('attemptDelivery surfaces connection refusal as a retryable error', async () => {
  // Port 1 is guaranteed closed; the failure must be classified, not thrown.
  const result = await attemptDelivery('http://127.0.0.1:1/hook', { body: '{}', timeoutMs: 500 });
  assert.equal(result.status, 0);
  assert.ok(result.error);
  assert.equal(isRetryable(result), true);
});
