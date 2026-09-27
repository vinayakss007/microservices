import { config, logger, STREAMS } from '@hookwatch/shared';

const log = logger({ service: 'notifier-service' });

function format(job, endpoint) {
  const name = endpoint?.name ?? job.endpoint_id;
  if (job.kind === 'delivery_failed') {
    return `HookWatch alert: delivery to "${name}" failed. ${job.detail} (attempt ${job.attempt}). Replay from the dashboard or API.`;
  }
  if (job.kind === 'quota_warning') {
    return `HookWatch: org ${job.org_id} used ${job.used} of ${job.limit} requests this month on the ${job.plan} plan.`;
  }
  return `HookWatch: ${job.kind} on "${name}"`;
}

/**
 * Channels are pluggable. Slack/Discord/Telegram/generic-webhook need only a
 * URL, so they work out of the box; the `log` channel keeps local dev honest.
 */
export const channels = {
  log: async ({ job, endpoint }) => {
    log.info('ALERT', { channel: 'log', endpoint: endpoint?.name, kind: job.kind, detail: job.detail });
    return { delivered: true, via: 'log' };
  },

  slack: async ({ job, endpoint, target }) => {
    if (!target) return { delivered: false, via: 'slack', reason: 'missing webhook url' };
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: format(job, endpoint) }),
      signal: AbortSignal.timeout(5000),
    });
    return { delivered: res.ok, via: 'slack', status: res.status };
  },

  discord: async ({ job, endpoint, target }) => {
    if (!target) return { delivered: false, via: 'discord', reason: 'missing webhook url' };
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: format(job, endpoint) }),
      signal: AbortSignal.timeout(5000),
    });
    return { delivered: res.ok, via: 'discord', status: res.status };
  },

  telegram: async ({ job, endpoint, target, extra }) => {
    if (!target || !extra?.bot_token) return { delivered: false, via: 'telegram', reason: 'missing bot token/chat' };
    const res = await fetch(`https://api.telegram.org/bot${extra.bot_token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: target, text: format(job, endpoint) }),
      signal: AbortSignal.timeout(5000),
    });
    return { delivered: res.ok, via: 'telegram', status: res.status };
  },

  webhook: async ({ job, endpoint, target }) => {
    if (!target) return { delivered: false, via: 'webhook', reason: 'missing target url' };
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'HookWatch-Alerts/0.1' },
      body: JSON.stringify({ kind: job.kind, endpoint: endpoint?.name, detail: job.detail, delivery_id: job.delivery_id }),
      signal: AbortSignal.timeout(5000),
    });
    return { delivered: res.ok, via: 'webhook', status: res.status };
  },
};

export class Notifier {
  constructor({ store, queue }) {
    this.store = store;
    this.queue = queue;
    this.signal = { aborted: false };
    this.lastAlertAt = new Map();
  }

  async handle(job) {
    const endpoint = await this.store.get('endpoints', job.endpoint_id);

    // Cooldown per endpoint+kind so an outage page once, not sixty times.
    const key = `${job.endpoint_id}:${job.kind}`;
    const last = this.lastAlertAt.get(key) ?? 0;
    if (Date.now() - last < config.alertCooldownMs) {
      log.debug('alert suppressed by cooldown', { key, endpoint: endpoint?.name });
      return;
    }
    this.lastAlertAt.set(key, Date.now());

    const configured = endpoint?.alert_channels?.length ? endpoint.alert_channels : ['log'];
    for (const entry of configured) {
      const [name, target, extra] = typeof entry === 'string' ? [entry, undefined, undefined] : [entry.channel, entry.target, entry];
      const send = channels[name] ?? channels.log;
      try {
        const result = await send({ job, endpoint, target, extra });
        await this.store.insert('alerts', {
          org_id: job.org_id,
          endpoint_id: job.endpoint_id,
          kind: job.kind,
          channel: result.via,
          payload: job,
          status: result.delivered ? 'sent' : 'failed',
          detail: result.reason ?? null,
          created_at: new Date().toISOString(),
        });
        log.info('alert dispatched', { channel: result.via, delivered: result.delivered, kind: job.kind });
      } catch (error) {
        await this.store.insert('alerts', {
          org_id: job.org_id,
          endpoint_id: job.endpoint_id,
          kind: job.kind,
          channel: name,
          payload: job,
          status: 'error',
          detail: error.message,
          created_at: new Date().toISOString(),
        });
        log.error('alert channel failed', { channel: name, error: error.message });
      }
    }
  }

  async run() {
    const handler = (job) =>
      this.handle(job).catch((error) => log.error('alert handler crashed', { error: error.message }));
    handler.onError = (error) => log.error('alert stream error', { error: error.message });
    await this.queue.consume(STREAMS.alert, handler, {
      signal: this.signal,
      pollIntervalMs: config.pollIntervalMs,
    });
  }

  stop() {
    this.signal.aborted = true;
  }
}

export function createNotifier({ store, queue }) {
  return new Notifier({ store, queue });
}
