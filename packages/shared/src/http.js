import http from 'node:http';

import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // The local dashboard is a file:// page talking to these ports.
    'access-control-allow-origin': process.env.DASHBOARD_ORIGIN || '*',
  });
  res.end(payload);
}

export async function readBody(req, limitBytes = config.maxPayloadBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new HttpError(413, 'payload too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return { raw: '', data: undefined };
  try {
    return { raw, data: JSON.parse(raw) };
  } catch {
    return { raw, data: undefined };
  }
}

export function requireInternalToken(req) {
  if (req.headers['x-hookwatch-internal'] !== config.internalToken) {
    throw new HttpError(401, 'invalid internal token');
  }
}

export function requireOrg(req, body) {
  const orgId =
    body?.org_id || req.headers['x-org-id'] || new URL(req.url, 'http://x').searchParams.get('org_id');
  if (!orgId) throw new HttpError(400, 'org_id is required');
  return orgId;
}

export async function callJson(url, { method = 'GET', body, token = config.internalToken, timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-hookwatch-internal': token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new HttpError(res.status, data?.error || `request failed: ${res.status}`, data);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** Match 'POST /i/:path' style patterns against the incoming request. */
function matchRoute(pattern, method, pathname) {
  const [pMethod, pPath] = pattern.split(' ');
  if (pMethod !== method) return null;
  const parts = pPath.split('/');
  const actual = (pathname.replace(/\/+$/, '') || '/').split('/');
  if (parts.length !== actual.length) return null;

  const params = {};
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].startsWith(':')) params[parts[i].slice(1)] = decodeURIComponent(actual[i]);
    else if (parts[i] !== actual[i]) return null;
  }
  return params;
}

export function router(handlers) {
  const patterns = Object.keys(handlers);
  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    for (const pattern of patterns) {
      const params = matchRoute(pattern, req.method, url.pathname);
      if (!params) continue;
      try {
        const result = await handlers[pattern]({ req, res, url, params });
        if (result !== undefined && !res.writableEnded) json(res, 200, result);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        if (!res.writableEnded) {
          json(res, status, {
            error: error.message || 'internal error',
            ...(error.details ? { details: error.details } : {}),
          });
        }
      }
      return;
    }
    json(res, 404, { error: 'not found', path: url.pathname });
  };
}

export function listen(handler, { port = config.port, host = config.host } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(port, host, () => resolve(server));
  });
}
