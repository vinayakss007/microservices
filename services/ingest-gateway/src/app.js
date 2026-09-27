import { randomUUID } from 'node:crypto';

import {
  HttpError,
  callJson,
  config,
  json,
  logger,
  readBody,
  requireInternalToken,
  requireOrg,
  router,
  sign,
  STREAMS,
} from '@hookwatch/shared';

const log = logger({ service: 'ingest-gateway' });

export function createIngestApp({ store, queue, publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${config.port}` }) {
  return router({
    'GET /health': async () => ({
      ok: true,
      service: 'ingest-gateway',
      store: store.driver,
      queue: queue.driver,
    }),

    'GET /v1/endpoints': async ({ req }) => {
      const orgId = requireOrg(req);
      const rows = await store.list('endpoints', (row) => row.org_id === orgId);
      return rows.map((row) => ({ ...row, secret: undefined, ingest_url: `${publicBaseUrl}/i/${row.url_path}` }));
    },

    'POST /v1/endpoints': async ({ req }) => {
      requireInternalToken(req);
      const { data } = await readBody(req);
      const orgId = requireOrg(req, data);
      if (!data?.target_url) throw new HttpError(400, 'target_url is required');

      const existing = await store.list('endpoints', (row) => row.org_id === orgId);
      // Endpoint limits are billing's decision, not the gateway's.
      await callJson(`${config.billingUrl}/v1/quota/endpoints`, {
        method: 'POST',
        body: { org_id: orgId, current: existing.length },
      });

      const urlPath = (data.url_path || randomUUID().replaceAll('-', '').slice(0, 16))
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '');
      if (await store.find('endpoints', (row) => row.url_path === urlPath)) {
        throw new HttpError(409, 'url_path already taken');
      }

      const endpoint = await store.insert('endpoints', {
        org_id: orgId,
        name: data.name || urlPath,
        url_path: urlPath,
        target_url: data.target_url,
        secret: data.secret || randomUUID(),
        method: (data.method || 'POST').toUpperCase(),
        headers: data.headers || {},
        alert_channels: data.alert_channels || ['log'],
        status: 'active',
        created_at: new Date().toISOString(),
      });

      return { ...endpoint, ingest_url: `${publicBaseUrl}/i/${endpoint.url_path}` };
    },

    /** Pause/resume, repoint the target after fixing it, reconfigure alerts. */
    'PATCH /v1/endpoints/:id': async ({ req, params }) => {
      requireInternalToken(req);
      const { data } = await readBody(req);
      const existing = await store.get('endpoints', params.id);
      if (!existing) throw new HttpError(404, 'endpoint not found');

      const patch = {};
      if (data?.name !== undefined) patch.name = String(data.name);
      if (data?.target_url !== undefined) {
        if (!/^https?:\/\//i.test(data.target_url)) throw new HttpError(400, 'target_url must be http(s)');
        patch.target_url = data.target_url;
      }
      if (data?.headers !== undefined) patch.headers = data.headers;
      if (data?.alert_channels !== undefined) patch.alert_channels = data.alert_channels;
      if (data?.status !== undefined) {
        if (!['active', 'paused'].includes(data.status)) throw new HttpError(400, "status must be 'active' or 'paused'");
        patch.status = data.status;
      }
      // A paused endpoint must stop accepting traffic, so the sink lookup
      // filters on status; resuming is the same call with status: 'active'.
      const updated = await store.update('endpoints', params.id, patch);
      return { ...updated, secret: undefined, ingest_url: `${publicBaseUrl}/i/${updated.url_path}` };
    },

    'DELETE /v1/endpoints/:id': async ({ req, params }) => {
      requireInternalToken(req);
      if (!(await store.remove('endpoints', params.id))) throw new HttpError(404, 'endpoint not found');
      return { deleted: true, id: params.id };
    },

    /** Public sink: the URL Stripe / GitHub / Shopify is configured to call. */
    'POST /i/:path': async ({ req, res, params }) => {
      const endpoint = await store.find(
        'endpoints',
        (row) => row.url_path === params.path && row.status === 'active',
      );
      if (!endpoint) throw new HttpError(404, 'unknown endpoint');

      const { raw } = await readBody(req);
      const bytes = Buffer.byteLength(raw ?? '');

      const usage = await callJson(`${config.billingUrl}/v1/usage`, {
        method: 'POST',
        body: { org_id: endpoint.org_id, requests: 1, bytes },
      });

      const receivedAt = new Date().toISOString();
      const record = await store.insert('deliveries', {
        endpoint_id: endpoint.id,
        org_id: endpoint.org_id,
        attempt: 1,
        status: 'queued',
        request: {
          method: req.method,
          headers: sanitize(req.headers),
          body: safeParse(raw),
          raw: raw ?? '',
          received_at: receivedAt,
        },
        available_at: receivedAt,
        created_at: receivedAt,
      });

      await queue.produce(STREAMS.deliver, {
        delivery_id: record.id,
        endpoint_id: endpoint.id,
        org_id: endpoint.org_id,
        signature: endpoint.secret ? sign(endpoint.secret, raw ?? '') : undefined,
      });

      // 202 immediately: slow or failing targets must never make the sender re-send.
      json(res, 202, {
        id: record.id,
        status: 'queued',
        quota: {
          plan: usage?.plan,
          used: usage?.requests,
          limit: usage?.limit,
          over_limit: Boolean(usage?.over_limit),
        },
      });
    },

    'GET /v1/deliveries': async ({ req, url }) => {
      const orgId = requireOrg(req);
      const endpointId = url.searchParams.get('endpoint_id');
      const status = url.searchParams.get('status');
      const limit = Number(url.searchParams.get('limit') || 50);
      const rows = await store.list(
        'deliveries',
        (row) =>
          row.org_id === orgId &&
          (!endpointId || row.endpoint_id === endpointId) &&
          (!status || row.status === status),
      );
      return rows
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit)
        .map(publicDelivery);
    },

    'GET /v1/deliveries/:id': async ({ req, params }) => {
      requireInternalToken(req);
      const row = await store.get('deliveries', params.id);
      if (!row) throw new HttpError(404, 'delivery not found');
      return publicDelivery(row);
    },

    'POST /v1/deliveries/:id/replay': async ({ req, params }) => {
      requireInternalToken(req);
      const row = await store.get('deliveries', params.id);
      if (!row) throw new HttpError(404, 'delivery not found');

      const replay = await store.insert('deliveries', {
        endpoint_id: row.endpoint_id,
        org_id: row.org_id,
        attempt: 1,
        status: 'queued',
        request: { ...row.request, replayed_from: row.id, replayed_at: new Date().toISOString() },
        available_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      });
      await queue.produce(STREAMS.deliver, {
        delivery_id: replay.id,
        endpoint_id: replay.endpoint_id,
        org_id: replay.org_id,
      });
      log.info('replay queued', { delivery_id: replay.id, source: row.id });
      return { id: replay.id, status: 'queued', replayed_from: row.id };
    },
  });
}

function sanitize(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = /authorization|cookie|token|secret|api[-_]?key/i.test(key) ? '[redacted]' : value;
  }
  return out;
}

function safeParse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { text: String(raw).slice(0, 4000) };
  }
}

function publicDelivery(row) {
  return {
    id: row.id,
    endpoint_id: row.endpoint_id,
    attempt: row.attempt,
    status: row.status,
    error: row.error ?? null,
    response: row.response ?? null,
    created_at: row.created_at,
    completed_at: row.completed_at ?? null,
    request: {
      method: row.request?.method,
      received_at: row.request?.received_at,
      body: row.request?.body,
    },
  };
}
