import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from './config.js';
import { acquireLock } from './lock.js';

/**
 * Queue contract shared by every service:
 *   produce(stream, job)                    -> append a job
 *   consume(stream, handler, options)       -> long-running loop
 *
 * Two drivers behind one interface:
 *   - RedisQueue  (production: Redis Streams + consumer groups)
 *   - FileQueue   (local dev: append-only JSONL journal, no Redis needed)
 */

const safeName = (stream) => stream.replace(/[^a-zA-Z0-9._-]/g, '_');

export class FileQueue {
  constructor(dir = path.join(config.dataDir, 'queue')) {
    this.dir = dir;
  }

  driver = 'file';

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  #journal(stream) {
    return path.join(this.dir, `${safeName(stream)}.jsonl`);
  }

  #cursorFile(stream, consumer = 'default') {
    return path.join(this.dir, `${safeName(stream)}.${safeName(consumer)}.cursor`);
  }

  async #readAll(stream) {
    try {
      const text = await fs.readFile(this.#journal(stream), 'utf8');
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  async produce(stream, job) {
    const entry = { id: job.id || randomUUID(), job, enqueued_at: new Date().toISOString() };
    const line = `${JSON.stringify(entry)}\n`;
    // Lock held across processes so parallel producers never interleave lines.
    const lock = await acquireLock(path.join(this.dir, `${safeName(stream)}.lock`));
    try {
      await fs.appendFile(this.#journal(stream), line);
    } finally {
      await fs.rm(lock, { recursive: true, force: true });
    }
    return entry;
  }

  async consume(
    stream,
    handler,
    { pollIntervalMs = config.pollIntervalMs, consumer = config.serviceName || String(process.pid), signal } = {},
  ) {
    // Cursors are per consumer group, so two services reading the same data
    // directory on local dev never steal each other's messages.
    const cursorPath = this.#cursorFile(stream, consumer);
    let index = 0;
    try {
      index = Number(await fs.readFile(cursorPath, 'utf8')) || 0;
    } catch {
      index = 0;
    }

    while (!signal?.aborted) {
      const entries = await this.#readAll(stream);
      for (; index < entries.length; index += 1) {
        const entry = entries[index];
        try {
          await handler(entry.job, entry);
        } catch (error) {
          handler.onError?.(error, entry);
        }
        // Cursor advances only after the handler returns, so a crash mid-job
        // re-reads it: at-least-once, which is what webhook delivery needs.
        await fs.writeFile(cursorPath, String(index + 1));
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  async close() {}
}

export class RedisQueue {
  constructor(redis) {
    this.redis = redis;
  }

  driver = 'redis';

  async init() {}

  async produce(stream, job) {
    const id = job.id || randomUUID();
    await this.redis.xadd(stream, '*', 'id', id, 'payload', JSON.stringify(job));
    return { id, job };
  }

  async consume(
    stream,
    handler,
    { group = 'workers', consumer = randomUUID(), blockMs = 5000, count = 10, signal } = {},
  ) {
    try {
      await this.redis.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
    } catch (error) {
      if (!error.message?.includes('BUSYGROUP')) throw error;
    }

    while (!signal?.aborted) {
      const messages = await this.redis.xreadgroup(
        'GROUP', group, consumer,
        'COUNT', count,
        'BLOCK', blockMs,
        'STREAMS', stream, '>',
      );
      if (!messages) continue;

      for (const [, entries] of messages) {
        for (const [id, fields] of entries) {
          const flat = {};
          for (let i = 0; i < fields.length; i += 2) flat[fields[i]] = fields[i + 1];
          try {
            await handler(JSON.parse(flat.payload), { id });
            await this.redis.xack(stream, group, id);
          } catch (error) {
            handler.onError?.(error, { id });
          }
        }
      }
    }
  }

  async close() {
    await this.redis.quit();
  }
}

export async function createQueue() {
  if (config.redisUrl) {
    const { default: IORedis } = await import('ioredis');
    const redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: 3 });
    await redis.ping();
    return new RedisQueue(redis);
  }
  const queue = new FileQueue();
  await queue.init();
  return queue;
}

export const STREAMS = {
  deliver: 'hookwatch:deliver',
  alert: 'hookwatch:alert',
};
