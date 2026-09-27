import { json, listen, logger, verifySignature, config } from '@hookwatch/shared';

/**
 * Local stand-in for a customer's webhook receiver.
 *   POST /             -> 200 (happy path)
 *   POST /flaky        -> 500 twice, then 200 (exercises the retry ladder)
 *   POST /down         -> 500 always (exercises dead-letter + alerting)
 */
const log = logger({ service: 'mock-target' });
const flaky = new Map();

const handler = async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');

  const signature = req.headers['x-hookwatch-signature'];
  const secret = process.env.MOCK_SECRET || '';
  const valid = secret ? verifySignature(secret, signature, raw) : null;

  const attempt = Number(req.headers['x-hookwatch-attempt'] || 1);
  const path = req.url.split('?')[0];

  if (path === '/down') {
    log.warn('rejecting', { attempt, reason: 'always 500' });
    return json(res, 500, { error: 'target is down' });
  }

  if (path === '/flaky') {
    const seen = (flaky.get(req.headers['x-hookwatch-delivery-id']) ?? 0) + 1;
    flaky.set(req.headers['x-hookwatch-delivery-id'], seen);
    if (seen <= 2) {
      log.warn('flaky failure', { seen, attempt });
      return json(res, 503, { error: 'temporarily unavailable' });
    }
    flaky.delete(req.headers['x-hookwatch-delivery-id']);
  }

  log.info('received webhook', {
    path,
    attempt,
    signature_valid: valid,
    body: raw.slice(0, 200),
  });
  return json(res, 200, { ok: true, received_at: new Date().toISOString(), attempt });
};

await listen(handler, { port: config.port || 8090, host: config.host });
log.info('mock-target listening', { port: config.port || 8090 });
