import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { FileQueue, FileStore, STREAMS } from '@hookwatch/shared';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hookwatch-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('FileStore round-trips a record through insert/get/update/remove', async (t) => {
  const store = new FileStore(path.join(await tempDir(t), 'store'));
  await store.init();

  const created = await store.insert('endpoints', { org_id: 'acme', name: 'stripe', url_path: 'abc' });
  assert.ok(created.id);
  assert.equal((await store.get('endpoints', created.id)).name, 'stripe');

  const updated = await store.update('endpoints', created.id, { status: 'paused' });
  assert.equal(updated.status, 'paused');

  assert.equal(await store.remove('endpoints', created.id), true);
  assert.equal(await store.get('endpoints', created.id), undefined);
});

test('FileStore filters by predicate', async (t) => {
  const store = new FileStore(path.join(await tempDir(t), 'store'));
  await store.init();
  await store.insert('endpoints', { org_id: 'acme', url_path: 'a' });
  await store.insert('endpoints', { org_id: 'other', url_path: 'b' });

  const mine = await store.list('endpoints', (row) => row.org_id === 'acme');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].url_path, 'a');
});

test('appendUsage accumulates within a period', async (t) => {
  const store = new FileStore(path.join(await tempDir(t), 'store'));
  await store.init();
  await store.appendUsage('acme', { period: '2026-09', requests: 1, bytes: 100 });
  const row = await store.appendUsage('acme', { period: '2026-09', requests: 4, bytes: 50 });
  assert.equal(row.requests, 5);
  assert.equal(row.bytes, 150);
});

test('concurrent inserts never lose a write', async (t) => {
  const store = new FileStore(path.join(await tempDir(t), 'store'));
  await store.init();
  await Promise.all(Array.from({ length: 25 }, (_, i) => store.insert('deliveries', { org_id: 'acme', n: i })));
  const rows = await store.list('deliveries');
  assert.equal(rows.length, 25);
});

test('FileQueue delivers a produced job to a consumer at-least-once', async (t) => {
  const queue = new FileQueue(path.join(await tempDir(t), 'queue'));
  await queue.init();

  const seen = [];
  const signal = { aborted: false };
  const handler = (job) => {
    seen.push(job);
    if (seen.length >= 1) signal.aborted = true;
  };
  handler.onError = (error) => {
    throw error;
  };

  await queue.produce(STREAMS.deliver, { delivery_id: 'd1' });
  await queue.consume(STREAMS.deliver, handler, { signal, pollIntervalMs: 10 });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].delivery_id, 'd1');
});

test('FileQueue keeps separate cursors per consumer group', async (t) => {
  const queue = new FileQueue(path.join(await tempDir(t), 'queue'));
  await queue.init();
  await queue.produce(STREAMS.alert, { kind: 'delivery_failed' });

  const notifier = [];
  const audit = [];
  const s1 = { aborted: false };
  const s2 = { aborted: false };
  const h1 = (job) => {
    notifier.push(job);
    s1.aborted = true;
  };
  const h2 = (job) => {
    audit.push(job);
    s2.aborted = true;
  };

  await Promise.all([
    queue.consume(STREAMS.alert, h1, { signal: s1, pollIntervalMs: 10, consumer: 'notifier-service' }),
    queue.consume(STREAMS.alert, h2, { signal: s2, pollIntervalMs: 10, consumer: 'audit' }),
  ]);

  assert.equal(notifier.length, 1);
  assert.equal(audit.length, 1);
});
