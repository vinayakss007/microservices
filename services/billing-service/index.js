import { config, createQueue, createStore, listen, logger } from '@hookwatch/shared';

import { createBillingApp } from './src/app.js';
import { startRetentionSweeper } from './src/retention.js';

const log = logger({ service: 'billing-service' });

const store = await createStore();
const queue = await createQueue();
const sweeper = startRetentionSweeper({ store });
const server = await listen(createBillingApp({ store, queue, sweeper }), {
  port: config.port,
  host: config.host,
});

log.info('billing-service listening', {
  port: config.port,
  store: store.driver,
  queue: queue.driver,
  retention_sweep_ms: config.retentionSweepMs,
});

async function shutdown() {
  sweeper.stop();
  server.close();
  await queue.close();
  await store.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
