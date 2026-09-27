import { config, createQueue, createStore, listen, logger } from '@hookwatch/shared';

import { createBillingApp } from './src/app.js';

const log = logger({ service: 'billing-service' });

const store = await createStore();
const queue = await createQueue();
const server = await listen(createBillingApp({ store, queue }), { port: config.port, host: config.host });

log.info('billing-service listening', { port: config.port, store: store.driver, queue: queue.driver });

async function shutdown() {
  server.close();
  await queue.close();
  await store.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
