import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { config } from './config.js';
import { acquireLock, releaseLock } from './lock.js';

/**
 * Storage contract used by every service:
 *   endpoints, deliveries, alerts, usage, plans
 *
 * Two drivers behind one interface:
 *   - PostgresStore  (production, docker-compose)
 *   - FileStore      (local dev, zero infrastructure)
 *
 * Both are async so services never depend on which one they got.
 */

const TABLES = ['endpoints', 'deliveries', 'alerts', 'usage', 'subscriptions'];

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export class FileStore {
  constructor(dir = path.join(config.dataDir, 'store')) {
    this.dir = dir;
  }

  driver = 'file';

  async init() {
    for (const table of TABLES) {
      await fsp.mkdir(this.dir, { recursive: true });
      const file = path.join(this.dir, `${table}.json`);
      if (!fs.existsSync(file)) await fsp.writeFile(file, '[]\n');
    }
  }

  async #read(table) {
    const file = path.join(this.dir, `${table}.json`);
    try {
      return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
      return [];
    }
  }

  async #write(table, rows) {
    const file = path.join(this.dir, `${table}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(rows, null, 2) + '\n');
    await fsp.rename(tmp, file);
  }

  // Serialise mutations so concurrent workers cannot clobber the file.
  // The lock is a directory on disk, so it holds across the separate service
  // processes started by `npm run dev`.
  async #exclusive(fn) {
    const handle = await acquireLock(path.join(this.dir, '.lock'));
    try {
      return await fn();
    } finally {
      await releaseLock(handle);
    }
  }

  async list(table, filter = () => true) {
    const rows = await this.#read(table);
    return rows.filter(filter).map(clone);
  }

  async find(table, predicate) {
    const rows = await this.#read(table);
    return clone(rows.find(predicate));
  }

  async get(table, id) {
    return this.find(table, (row) => row.id === id);
  }

  async insert(table, record) {
    const row = { id: record.id || randomUUID(), ...record };
    return this.#exclusive(async () => {
      const rows = await this.#read(table);
      rows.push(row);
      await this.#write(table, rows);
      return clone(row);
    });
  }

  async update(table, id, patch) {
    return this.#exclusive(async () => {
      const rows = await this.#read(table);
      const index = rows.findIndex((row) => row.id === id);
      if (index === -1) return undefined;
      rows[index] = { ...rows[index], ...patch };
      await this.#write(table, rows);
      return clone(rows[index]);
    });
  }

  async remove(table, id) {
    return this.#exclusive(async () => {
      const rows = await this.#read(table);
      const next = rows.filter((row) => row.id !== id);
      if (next.length === rows.length) return false;
      await this.#write(table, next);
      return true;
    });
  }

  async appendUsage(orgId, event) {
    return this.#exclusive(async () => {
      const rows = await this.#read('usage');
      const index = rows.findIndex((row) => row.org_id === orgId && row.period === event.period);
      if (index === -1) {
        rows.push({ id: randomUUID(), org_id: orgId, ...event });
      } else {
        rows[index] = {
          ...rows[index],
          requests: Number(rows[index].requests) + Number(event.requests),
          bytes: Number(rows[index].bytes) + Number(event.bytes),
          period: event.period,
        };
      }
      await this.#write('usage', rows);
      return clone(rows.find((row) => row.org_id === orgId && row.period === event.period));
    });
  }

  async close() {}
}

const SCHEMA = `
create table if not exists endpoints (
  id text primary key,
  org_id text not null,
  name text not null,
  url_path text not null unique,
  target_url text not null,
  secret text,
  method text not null default 'POST',
  headers jsonb not null default '{}'::jsonb,
  alert_channels jsonb not null default '[]'::jsonb,
  status text not null default 'active',
  created_at timestamptz not null default now()
);
create index if not exists endpoints_org_idx on endpoints (org_id);

create table if not exists deliveries (
  id text primary key,
  endpoint_id text not null,
  org_id text not null,
  attempt integer not null default 1,
  status text not null,
  request jsonb not null,
  response jsonb,
  error text,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists deliveries_pending_idx on deliveries (status, available_at);
create index if not exists deliveries_endpoint_idx on deliveries (endpoint_id, created_at desc);

create table if not exists alerts (
  id text primary key,
  org_id text not null,
  endpoint_id text not null,
  kind text not null,
  channel text not null,
  payload jsonb not null,
  status text not null,
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists alerts_org_idx on alerts (org_id, created_at desc);

create table if not exists usage (
  org_id text not null,
  period text not null,
  requests integer not null default 0,
  bytes integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (org_id, period)
);

create table if not exists subscriptions (
  id text primary key,
  org_id text not null unique,
  plan_id text not null,
  status text not null,
  stripe_customer_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
`;

function sql(value) {
  return value && typeof value === 'object' ? JSON.stringify(value) : value;
}

export class PostgresStore {
  constructor(pool) {
    this.pool = pool;
  }

  driver = 'postgres';

  async init() {
    await this.pool.query(SCHEMA);
  }

  async list(table, filter = () => true) {
    const { rows } = await this.pool.query(`select * from ${table}`);
    return rows.filter(filter);
  }

  async find(table, predicate) {
    const rows = await this.list(table, predicate);
    return rows[0];
  }

  async get(table, id) {
    const { rows } = await this.pool.query(`select * from ${table} where id = $1`, [id]);
    return rows[0];
  }

  async insert(table, record) {
    const row = { id: record.id || randomUUID(), ...record };
    const entries = Object.entries(row).filter(([, value]) => value !== undefined);
    const columns = entries.map(([key]) => key).join(', ');
    const placeholders = entries.map((_, i) => `$${i + 1}`).join(', ');
    const params = entries.map(([, value]) => sql(value));
    const { rows } = await this.pool.query(
      `insert into ${table} (${columns}) values (${placeholders}) returning *`,
      params,
    );
    return rows[0] ?? clone(row);
  }

  async update(table, id, patch) {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (!entries.length) return this.get(table, id);
    const sets = entries.map(([key], i) => `${key} = $${i + 1}`).join(', ');
    const params = entries.map(([, value]) => sql(value));
    const { rows } = await this.pool.query(
      `update ${table} set ${sets} where id = $${entries.length + 1} returning *`,
      [...params, id],
    );
    return rows[0];
  }

  async remove(table, id) {
    const { rowCount } = await this.pool.query(`delete from ${table} where id = $1`, [id]);
    return rowCount > 0;
  }

  async appendUsage(orgId, event) {
    const { rows } = await this.pool.query(
      `insert into usage (org_id, period, requests, bytes, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (org_id, period) do update
         set requests = usage.requests + excluded.requests,
             bytes = usage.bytes + excluded.bytes,
             updated_at = now()
       returning *`,
      [orgId, event.period, event.requests, event.bytes],
    );
    return rows[0];
  }

  async close() {
    await this.pool.end();
  }
}

export async function createStore() {
  if (config.databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
    const store = new PostgresStore(pool);
    await store.init();
    return store;
  }
  const store = new FileStore();
  await store.init();
  return store;
}
