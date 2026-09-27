import { createQueue, createStore, listen, logger, config } from '@hookwatch/shared';

import { createIngestApp } from './src/app.js';

const log = logger({ service: 'ingest-gateway' });

const store = await createStore();
const queue = await createQueue();
const server = await listen(createIngestApp({ store, queue }));

log.info('ingest-gateway listening', {
  port: config.port,
  host: config.host,
  store: store.driver,
  queue: queue.driver,
});

async function shutdown() {
  server.close();
  await queue.close();
  await store.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
