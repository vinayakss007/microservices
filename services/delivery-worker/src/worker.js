import { config, logger, retryDelay, STREAMS } from '@hookwatch/shared';

const log = logger({ service: 'delivery-worker' });

/** Only transient failures retry. A 400 means the payload is wrong, not the network. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryable(response) {
  if (!response) return false;
  if (response.error) return true; // DNS refused, connection reset, timeout
  return RETRYABLE_STATUS.has(response.status);
}

export function isTerminalStatus(status) {
  return status === 'delivered' || status === 'dead';
}

/** One HTTP attempt against the customer target with a hard timeout. */
export async function attemptDelivery(target, { body, headers = {}, signature, timeoutMs = config.deliveryTimeoutMs } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'HookWatch-Delivery/0.1',
        ...(signature ? { 'x-hookwatch-signature': signature } : {}),
        ...headers,
      },
      body,
      signal: controller.signal,
      redirect: 'manual',
    });
    const text = await res.text();
    return {
      status: res.status,
      latency_ms: Date.now() - started,
      body_preview: text.slice(0, 2000),
    };
  } catch (error) {
    return {
      status: 0,
      latency_ms: Date.now() - started,
      error: error.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export class DeliveryWorker {
  constructor({ store, queue }) {
    this.store = store;
    this.queue = queue;
    this.signal = { aborted: false };
    this.inFlight = new Set();
  }

  /** Attempt a single delivery record exactly once. */
  async attempt(job) {
    const delivery = await this.store.get('deliveries', job.delivery_id);
    if (!delivery || isTerminalStatus(delivery.status)) return;

    const endpoint = await this.store.get('endpoints', job.endpoint_id);
    if (!endpoint) {
      await this.store.update('deliveries', delivery.id, {
        status: 'dead',
        error: 'endpoint deleted',
        completed_at: new Date().toISOString(),
      });
      return;
    }

    const body = delivery.request?.raw ?? JSON.stringify(delivery.request?.body ?? {});
    const headers = {
      ...endpoint.headers,
      'x-hookwatch-delivery-id': delivery.id,
      'x-hookwatch-attempt': String(delivery.attempt),
    };

    await this.store.update('deliveries', delivery.id, { status: 'in_progress' });
    const response = await attemptDelivery(endpoint.target_url, {
      body,
      headers,
      signature: job.signature,
    });
    const ok = response.status >= 200 && response.status < 300;

    log.info('attempt', {
      delivery_id: delivery.id,
      endpoint: endpoint.name,
      attempt: delivery.attempt,
      http_status: response.status,
      latency_ms: response.latency_ms,
      ok,
    });

    if (ok) {
      await this.store.update('deliveries', delivery.id, {
        status: 'delivered',
        response,
        error: null,
        completed_at: new Date().toISOString(),
      });
      return;
    }

    await this.#fail(delivery, endpoint, response, job.signature);
  }

  async #fail(delivery, endpoint, response, signature) {
    const reason = response.error ? response.error : `target responded ${response.status}`;

    if (isRetryable(response) && delivery.attempt < config.maxAttempts) {
      const delayMs = retryDelay(delivery.attempt);
      const availableAt = new Date(Date.now() + delayMs).toISOString();
      await this.store.update('deliveries', delivery.id, {
        status: 'retrying',
        response,
        error: reason,
        available_at: availableAt,
      });
      log.warn('retry scheduled', {
        delivery_id: delivery.id,
        attempt: delivery.attempt,
        delay_ms: delayMs,
        reason,
      });
      // The scheduler ticker re-enters when available_at passes; nothing blocks here.
      this.#rememberRetry(delivery.id, endpoint.id, signature, availableAt);
      return;
    }

    await this.store.update('deliveries', delivery.id, {
      status: 'dead',
      response,
      error: isRetryable(response) ? `${reason} after ${delivery.attempt} attempts` : reason,
      completed_at: new Date().toISOString(),
    });

    log.error('dead letter', { delivery_id: delivery.id, endpoint: endpoint.name, reason });

    await this.queue.produce(STREAMS.alert, {
      org_id: delivery.org_id,
      endpoint_id: endpoint.id,
      delivery_id: delivery.id,
      kind: 'delivery_failed',
      detail: isRetryable(response) ? `${reason} after ${delivery.attempt} attempts` : reason,
      attempt: delivery.attempt,
    });
  }

  // In-process schedule of backoff timers, rebuilt from storage on boot.
  #pending = new Map();

  #rememberRetry(deliveryId, endpointId, signature, availableAt) {
    this.#pending.set(deliveryId, { endpointId, signature, availableAt });
  }

  /**
   * Scheduler: fires retries whose backoff has elapsed.
   * Sources are the in-process map plus storage, so a restart or a second
   * replica still drains rows that were parked as 'retrying'.
   */
  async #tick() {
    const now = Date.now();
    const due = new Map();

    for (const [deliveryId, entry] of this.#pending.entries()) {
      if (new Date(entry.availableAt).getTime() > now) continue;
      this.#pending.delete(deliveryId);
      due.set(deliveryId, entry);
    }

    // Catch anything storage knows about that this process is not already tracking.
    const rows = await this.store.list(
      'deliveries',
      (row) =>
        (row.status === 'retrying' || row.status === 'in_progress') &&
        new Date(row.available_at ?? row.created_at).getTime() <= now,
    );
    for (const row of rows) {
      if (due.has(row.id) || this.inFlight.has(row.id)) continue;
      due.set(row.id, { endpointId: row.endpoint_id, signature: undefined });
    }

    for (const [deliveryId, entry] of due) {
      if (this.inFlight.has(deliveryId)) continue;
      this.inFlight.add(deliveryId);
      try {
        const delivery = await this.store.get('deliveries', deliveryId);
        if (!delivery || isTerminalStatus(delivery.status)) continue;
        await this.store.update('deliveries', deliveryId, { attempt: delivery.attempt + 1 });
        await this.attempt({
          delivery_id: deliveryId,
          endpoint_id: entry.endpointId,
          signature: entry.signature,
        });
      } catch (error) {
        log.error('retry tick failed', { deliveryId, error: error.message });
      } finally {
        this.inFlight.delete(deliveryId);
      }
    }
  }

  async run() {
    const handler = (job) =>
      this.attempt(job).catch((error) =>
        log.error('handler crashed', { error: error.message, delivery_id: job?.delivery_id }));
    handler.onError = (error) => log.error('deliver stream error', { error: error.message });

    const ticker = setInterval(() => {
      this.#tick().catch((error) => log.error('ticker error', { error: error.message }));
    }, config.pollIntervalMs);

    try {
      await this.queue.consume(STREAMS.deliver, handler, {
        signal: this.signal,
        pollIntervalMs: config.pollIntervalMs,
      });
    } finally {
      clearInterval(ticker);
    }
  }

  stop() {
    this.signal.aborted = true;
  }
}

export function createDeliveryWorker({ store, queue }) {
  return new DeliveryWorker({ store, queue });
}
