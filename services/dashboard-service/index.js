import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, json, logger } from '@hookwatch/shared';

const log = logger({ service: 'dashboard-service' });
const staticDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const upstreams = {
  ingest: config.ingestUrl,
  delivery: config.deliveryUrl,
  notifier: config.notifierUrl,
  billing: config.billingUrl,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/** BFF: the browser talks to one origin, the dashboard fans out with the internal token. */
async function proxy(res, service, restPath, req) {
  const base = upstreams[service];
  if (!base) return json(res, 404, { error: `unknown service: ${service}` });

  const target = new URL(restPath, base);
  target.search = new URL(req.url, 'http://x').search;

  const init = {
    method: req.method,
    headers: {
      'content-type': 'application/json',
      'x-hookwatch-internal': config.internalToken,
      ...(req.headers['x-org-id'] ? { 'x-org-id': req.headers['x-org-id'] } : {}),
    },
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw) init.body = raw;
  }

  try {
    const upstream = await fetch(target, { ...init, signal: AbortSignal.timeout(10_000) });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    });
    res.end(text);
  } catch (error) {
    json(res, 502, { error: `${service} unreachable`, detail: error.message });
  }
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(staticDir, rel);
  // Reject path traversal that would escape the public directory.
  if (!file.startsWith(staticDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return json(res, 404, { error: 'not found' });
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

export function createDashboardHandler() {
  return async function handle(req, res) {
    const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    const api = pathname.match(/^\/api\/(ingest|delivery|notifier|billing)(\/.*)?$/);
    if (api) return proxy(res, api[1], api[2] || '/', req);

    if (pathname === '/api/health' || pathname === '/health') {
      const results = await Promise.allSettled(
        Object.entries(upstreams).map(async ([name, base]) => {
          const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
          return { name, ok: r.ok, status: r.status };
        }),
      );
      return json(res, 200, {
        services: results.map((outcome, i) =>
          outcome.status === 'fulfilled' ? outcome.value : { name: Object.keys(upstreams)[i], ok: false, status: 0 },
        ),
      });
    }

    if (req.method === 'GET') return serveStatic(req, res, pathname);
    return json(res, 404, { error: 'not found' });
  };
}

const server = await (await import('node:http')).createServer(createDashboardHandler()).listen(config.port, config.host, () =>
  log.info('dashboard-service listening', { port: config.port }),
);

async function shutdown() {
  server.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
