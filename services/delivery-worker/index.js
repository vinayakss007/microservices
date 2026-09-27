import { config, createQueue, createStore, listen, logger, router } from '@hookwatch/shared';

import { createDeliveryWorker } from './src/worker.js';

const log = logger({ service: 'delivery-worker' });

const store = await createStore();
const queue = await createQueue();
const worker = createDeliveryWorker({ store, queue });

// Health endpoint only; the real work happens on the stream consumer loop.
const server = await listen(
  router({
    'GET /health': async () => ({
      ok: true,
      service: 'delivery-worker',
      store: store.driver,
      queue: queue.driver,
    }),
  }),
  { port: config.port, host: config.host },
);

log.info('delivery-worker ready', {
  port: config.port,
  store: store.driver,
  queue: queue.driver,
  max_attempts: config.maxAttempts,
});

async function shutdown() {
  worker.stop();
  server.close();
  await queue.close();
  await store.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

worker.run().catch((error) => {
  log.error('worker crashed', { error: error.message, stack: error.stack });
  process.exitCode = 1;
});

