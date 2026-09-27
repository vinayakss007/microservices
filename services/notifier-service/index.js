import {
  config,
  createQueue,
  createStore,
  listen,
  logger,
  requireOrg,
  router,
} from '@hookwatch/shared';

import { createNotifier } from './src/notifier.js';

const log = logger({ service: 'notifier-service' });

export function createNotifierApp({ store }) {
  return router({
    'GET /health': async () => ({
      ok: true,
      service: 'notifier-service',
      store: store.driver,
    }),

    'GET /v1/alerts': async ({ req, url }) => {
      const orgId = requireOrg(req);
      const limit = Number(url.searchParams.get('limit') || 50);
      const rows = await store.list('alerts', (row) => row.org_id === orgId);
      return rows
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit);
    },
  });
}

const store = await createStore();
const queue = await createQueue();
const notifier = createNotifier({ store, queue });

const server = await listen(createNotifierApp({ store }), { port: config.port, host: config.host });

log.info('notifier-service listening', { port: config.port, store: store.driver, queue: queue.driver });

async function shutdown() {
  notifier.stop();
  server.close();
  await queue.close();
  await store.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

notifier.run().catch((error) => {
  log.error('notifier crashed', { error: error.message, stack: error.stack });
  process.exitCode = 1;
});
