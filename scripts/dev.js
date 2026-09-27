import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Order matters: billing and ingest answer the gateway's synchronous calls. */
const services = [
  { name: 'billing-service', port: 8084 },
  { name: 'ingest-gateway', port: 8081 },
  { name: 'notifier-service', port: 8083 },
  { name: 'delivery-worker', port: 8082 },
  { name: 'mock-target', port: 8090, entry: 'services/mock-target/index.js' },
  { name: 'dashboard-service', port: 8080 },
];

const colors = ['\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[32m', '\x1b[34m', '\x1b[36m'];
const children = [];

services.forEach((service, index) => {
  const entry = service.entry ?? `services/${service.name}/index.js`;
  const child = spawn(process.execPath, [path.join(root, entry)], {
    cwd: root,
    env: {
      ...process.env,
      SERVICE_NAME: service.name,
      PORT: String(service.port),
      DATA_DIR: process.env.DATA_DIR ?? path.join(root, '.data'),
      INTERNAL_TOKEN: process.env.INTERNAL_TOKEN ?? 'dev-internal-token',
      INGEST_URL: `http://127.0.0.1:8081`,
      BILLING_URL: `http://127.0.0.1:8084`,
      NOTIFIER_URL: `http://127.0.0.1:8083`,
      DELIVERY_URL: `http://127.0.0.1:8082`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const color = colors[index % colors.length];
  const tag = `${color}[${service.name}]${'\x1b[0m '}`;
  const write = (stream) => (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue;
      stream.write(`${tag}${line}\n`);
    }
  };
  child.stdout.on('data', write(process.stdout));
  child.stderr.on('data', write(process.stderr));
  child.on('exit', (code) => {
    process.stderr.write(`${tag} exited with code ${code}\n`);
  });

  children.push(child);
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown() {
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 200);
}

console.log(`\x1b[32mHookWatch dev stack starting — dashboard on http://localhost:8080${'\x1b[0m'}\n`);
