import { startDashboard } from './src/app.js';

const server = await startDashboard();

async function shutdown() {
  server.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
