import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..', '..');

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',

  // Service identity
  serviceName: process.env.SERVICE_NAME || 'unknown',
  host: process.env.HOST || '0.0.0.0',
  port: num(process.env.PORT, 8080),

  // Infra
  databaseUrl: process.env.DATABASE_URL || '',
  redisUrl: process.env.REDIS_URL || '',
  dataDir: process.env.DATA_DIR || path.join(REPO_ROOT, '.data'),

  // Cross-service auth (shared secret on internal endpoints)
  internalToken: process.env.INTERNAL_TOKEN || 'dev-internal-token',

  // Service discovery
  ingestUrl: process.env.INGEST_URL || 'http://127.0.0.1:8081',
  deliveryUrl: process.env.DELIVERY_URL || 'http://127.0.0.1:8082',
  notifierUrl: process.env.NOTIFIER_URL || 'http://127.0.0.1:8083',
  billingUrl: process.env.BILLING_URL || 'http://127.0.0.1:8084',

  // Delivery behaviour
  maxAttempts: num(process.env.MAX_ATTEMPTS, 6),
  backoffBaseMs: num(process.env.BACKOFF_BASE_MS, 2000),
  backoffCapMs: num(process.env.BACKOFF_CAP_MS, 300_000),
  deliveryTimeoutMs: num(process.env.DELIVERY_TIMEOUT_MS, 8000),
  pollIntervalMs: num(process.env.POLL_INTERVAL_MS, 1000),
  maxPayloadBytes: num(process.env.MAX_PAYLOAD_BYTES, 256 * 1024),

  // Alerting
  alertCooldownMs: num(process.env.ALERT_COOLDOWN_MS, 10 * 60_000),

  // Retention sweeper (billing-service)
  retentionSweepMs: num(process.env.RETENTION_SWEEP_MS, 60 * 60_000),
};
