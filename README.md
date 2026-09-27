# HookWatch

Webhook monitoring, logging and automatic retries for indie hackers and small teams.

You point Stripe, GitHub or Shopify at a HookWatch URL. HookWatch accepts the event
immediately, records it, then delivers it to your real endpoint with retries, backoff
and alerting when your endpoint is down. Your endpoint being offline never makes the
sender think the event was lost, and you never lose the payload.

Node 22, ESM, npm workspaces. The only runtime dependencies are `pg` and `ioredis` —
everything else is the standard library.

## Services

| Service | Port | Responsibility |
| --- | --- | --- |
| `dashboard-service` | 8080 | Static UI + BFF proxy; the browser talks to one origin |
| `ingest-gateway` | 8081 | Public sink `POST /i/:path`, endpoint CRUD, delivery log, replay |
| `delivery-worker` | 8082 | Consumes the deliver stream, retries with backoff, dead-letters |
| `notifier-service` | 8083 | Consumes the alert stream, dispatches to Slack/Discord/Telegram/webhook/log |
| `billing-service` | 8084 | Plans, usage metering, quota gates, subscriptions, MRR, retention sweep |
| `mock-target` | 8090 | Local stand-in for a customer receiver (`/`, `/flaky`, `/down`) |

`packages/shared` holds what every service needs: config, logger, the store and queue
abstractions, retry maths, payload signing and the HTTP router.

## Run it

The stack runs with **no Docker, Postgres or Redis**. When `DATABASE_URL` / `REDIS_URL`
are empty, the shared layer falls back to file drivers: JSON files under `.data/` behind
a cross-process `mkdir` lock, and an append-only JSONL journal with a per-consumer cursor
file. Set those env vars and the same code paths use Postgres and Redis Streams instead.

```bash
npm install
npm run dev          # boots all six processes
npm run seed         # demo org: happy path, a flaky target, a dead letter, an alert
open http://localhost:8080
npm test             # 36 tests
```

With Docker:

```bash
docker compose up --build
```

Compose wires Postgres 16 and Redis 7 with healthchecks and `depends_on: service_healthy`.
One image, six services, parameterised by `ENTRY` / `PORT`. `delivery-worker` is pinned to
a single replica on purpose — see the note below.

## How a webhook flows

1. `POST /i/:path` looks up an `active` endpoint. Anything else is a 404, so a paused
   endpoint stops accepting traffic at the door.
2. The payload is metered through `billing-service` and written to the `deliveries` table
   with the raw body and redacted headers (`authorization`, `cookie`, `token`, `secret`,
   `api-key` become `[redacted]`).
3. A job goes on the deliver stream and the sink answers **202 immediately**. Slow or dead
   targets must never make the sender re-send.
4. `delivery-worker` POSTs to the target with `x-hookwatch-signature` (Stripe-style HMAC:
   `v1,ts=…,sig=…`), `x-hookwatch-attempt` and `x-hookwatch-delivery-id`.
5. Statuses in `{408, 425, 429, 500, 502, 503, 504}` are retryable. Delay is
   `base * 4^(attempt-1)` with 20% jitter, capped at `BACKOFF_CAP_MS`. After
   `MAX_ATTEMPTS` the row goes `dead` and an alert is queued.
6. `notifier-service` dispatches the alert to the endpoint's `alert_channels`, each entry
   being either a bare channel name or `{channel, target}` — a Slack or Discord webhook URL,
   or a Telegram `{bot_token, target: chat_id}`. Unconfigured channels fall back to `log`.
   A per-endpoint-and-kind cooldown means a sustained outage pages once rather than every
   retry.

Two kinds of job reach the alert stream: `delivery_failed` from the worker and
`quota_warning` from billing at 80% and 100% of a plan's request limit.

Delivery is **at-least-once**: the queue cursor advances only after the handler returns,
and Redis acks after it too. A crash mid-job re-reads the job. That is the right trade for
webhooks — a duplicate is recoverable, a silent drop is not.

## Recovery loop

The operational path when something broke is: find the dead delivery, fix or repoint the
endpoint, replay.

```bash
curl -X PATCH localhost:8081/v1/endpoints/$ID \
  -H 'x-hookwatch-internal: dev-internal-token' \
  -H 'content-type: application/json' \
  -d '{"status":"active","target_url":"https://fixed.example/hook"}'

curl -X POST localhost:8081/v1/deliveries/$DEAD_ID/replay \
  -H 'x-hookwatch-internal: dev-internal-token'
```

Replay inserts a **new** delivery carrying `replayed_from`; the original stays `dead`.
Rewriting history would make the log useless for the one question that matters after an
outage — "how many events did I actually miss?"

## API

Write and internal routes require `x-hookwatch-internal`. The browser only ever talks to
the dashboard, which injects that header when it fans out to `/api/(ingest|delivery|notifier|billing)/…`.

Because the proxy holds the token, it cannot rely on the upstream's token check to protect
itself. Two classes of route are therefore denied at the proxy and return 404 there:
`/v1/retention/*` (it deletes rows) and `/v1/revenue` (aggregate MRR is not this org's
data). Everything else the dashboard needs is reachable.

ingest-gateway
- `GET/POST /v1/endpoints`, `PATCH/DELETE /v1/endpoints/:id`
- `POST /i/:path` — public sink
- `GET /v1/deliveries` (filter by `endpoint_id`, `status`, `limit`), `GET /v1/deliveries/:id`
- `POST /v1/deliveries/:id/replay`

billing-service
- `GET /v1/plans`, `POST /v1/usage`, `GET /v1/usage`
- `POST /v1/quota/endpoints`, `POST /v1/subscriptions`, `GET /v1/subscriptions`
- `GET /v1/revenue` (internal only), `POST /v1/retention/sweep` (internal only)

notifier-service
- `GET /v1/alerts?org_id=…&limit=…`

An endpoint's `secret` is returned **once**, at creation. Every later read strips it, which
is the Stripe behaviour and the one a leaked dashboard screenshot should not be able to undo.

## Pricing

| Plan | $/mo | Requests | Endpoints | Retention |
| --- | --- | --- | --- | --- |
| Free | 0 | 1,000 | 1 | 1 day |
| Pro | 12 | 25,000 | 10 | 14 days |
| Production | 49 | 250,000 | 25 | 30 days |
| Scale | 149 | 2,000,000 | unlimited | 90 days |

Request limits are **soft**. Going over still returns 202 and never drops a webhook; the
invoice shows `overage_cents: 0` and the dashboard nudges an upgrade. Dropping a customer's
events because of a billing counter is the fastest way to lose the account that generated the
overage. The hard limit is endpoint count, which returns HTTP 402.

Retention **is** enforced, and the window above is the window the sweeper applies. Billing
runs it hourly (`RETENTION_SWEEP_MS`) and once shortly after boot; `POST /v1/retention/sweep`
forces a pass for ops. The rules that make deletion safe to run unattended:

- Only settled rows go. Deliveries purge at `delivered`/`dead`, alerts at
  `sent`/`failed`/`error`. A row that is `queued`, `retrying` or `in_progress` is
  mid-flight — pruning it would drop an event the customer was promised. `purgeOlderThan`
  requires an explicit status allowlist rather than defaulting to "everything".
- An org with history but no subscription row is skipped and reported in
  `skipped_no_plan`, not swept on the Free tier's aggressive 1-day default. Deletion rules
  you never agreed to are not implied by the existence of a row.
- A non-positive `retention_days` is treated as unlimited, matching `endpoint_limit: -1`.
  A typo in a plan table must never mean "delete the world".
- Only `deliveries` and `alerts` are purgeable. `usage` and `subscriptions` are refused by
  name, so a bug in the sweep can never erase the billing record.
- Orgs are grouped by window, so the file driver rewrites each table once per distinct
  period rather than once per org.

## Design notes

- **Two drivers, one interface.** `FileStore`/`PostgresStore` and `FileQueue`/`RedisQueue`
  both sit behind `createStore()` / `createQueue()`. The file store serialises mutations
  through an atomic `mkdir` lock and deep-clones on read, so it behaves like Postgres rather
  than handing out shared references. This is what makes the whole system demoable on a laptop.
- **Per-consumer cursors.** The worker and the notifier read the same journal but each keep
  their own cursor file, so neither steals the other's jobs.
- **Worker is single-replica.** The retry scheduler merges an in-process due map with a sweep
  of `retrying`/`in_progress` rows whose `available_at` passed, which is how a restarted
  worker picks up its own pending retries. Running two would need per-row claims in
  `PostgresStore` first; the compose file says so rather than letting someone scale it blind.
- **Boot ordering.** The gateway calls billing synchronously when an endpoint is created, so
  billing must be up. `scripts/dev.js` starts it first.
- **The proxy is a trust boundary, not a pass-through.** It injects the internal token, so
  upstream auth cannot protect it from itself; denylisted paths are rejected before the
  request leaves the process.
- **Deletion is the one irreversible thing here.** Retention is the only code that destroys
  customer data, which is why it is allowlisted three ways: table, status, and a priced plan
  window. See Pricing.

## Environment

`NODE_ENV`, `LOG_LEVEL`, `HOST`, `PORT`, `SERVICE_NAME`, `DATA_DIR`, `DATABASE_URL`,
`REDIS_URL`, `INTERNAL_TOKEN`, `PUBLIC_BASE_URL`, `DASHBOARD_ORIGIN` (CORS, defaults to `*`),
`INGEST_URL`, `DELIVERY_URL`, `NOTIFIER_URL`, `BILLING_URL`, `MAX_ATTEMPTS` (6),
`BACKOFF_BASE_MS` (2000), `BACKOFF_CAP_MS` (300000), `DELIVERY_TIMEOUT_MS` (8000),
`POLL_INTERVAL_MS` (1000), `MAX_PAYLOAD_BYTES` (262144, above it the sink answers 413),
`ALERT_COOLDOWN_MS` (600000), `RETENTION_SWEEP_MS` (3600000).

`INTERNAL_TOKEN` defaults to `dev-internal-token`, and `DASHBOARD_ORIGIN` defaults to `*`.
Change both before exposing any of this.

## Tests

```
npm test
```

Six suites, 36 tests. Shared (12) covers retry maths, signing, the plans table, locking,
the file store round-trip and the queue's per-consumer cursors. Delivery worker (5) covers
status classification, header forwarding, timeouts and connection refusal. Ingest gateway (5)
is end-to-end: it boots the real gateway, worker, notifier and billing apps against an
in-process HTTP target and asserts the whole ladder — delivery, retry, dead-letter, alert,
quota gating, pause → sink 404 → repoint → replay, and that `PATCH` rejects bad input
instead of silently corrupting an endpoint. Billing (7) covers the retention sweeper:
per-plan windows, in-flight rows surviving a sweep a year past their window, an unpriced org
being skipped, and the purge allowlists refusing out-of-scope tables. Dashboard (7) pins the
proxy boundary — token injected on allowed paths, never leaked in a response, destructive
routes 404 before reaching the upstream, and path traversal tested over a raw socket because
`fetch` normalises `../` before it hits the wire.

