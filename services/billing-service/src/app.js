import {
  HttpError,
  logger,
  periodKey,
  PLANS,
  planById,
  readBody,
  requireInternalToken,
  requireOrg,
  router,
  STREAMS,
} from '@hookwatch/shared';

const log = logger({ service: 'billing-service' });

const WARN_AT = [0.8, 1.0];

/**
 * Billing owns three things the other services must not decide for themselves:
 * what plan an org is on, whether it may create another endpoint, and whether
 * it is close enough to its request cap to be paged.
 */
export function createBillingApp({ store, queue, sweeper }) {
  // Per-process, per-period dedupe so a warning pages once, not on every request.
  const warned = new Set();

  async function subscriptionFor(orgId) {
    const existing = await store.find('subscriptions', (row) => row.org_id === orgId);
    if (existing) return existing;
    try {
      return await store.insert('subscriptions', {
        // id === org_id keeps the row shape valid for both drivers: Postgres
        // has an id primary key, the file store keys mutations off id.
        id: orgId,
        org_id: orgId,
        plan_id: 'free',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    } catch (error) {
      // Two concurrent ingests can both miss the row and race to insert it;
      // the loser just reads back what the winner wrote.
      const row = await store.find('subscriptions', (r) => r.org_id === orgId);
      if (row) return row;
      throw error;
    }
  }

  async function usageFor(orgId) {
    const period = periodKey();
    const row = await store.find('usage', (r) => r.org_id === orgId && r.period === period);
    return {
      period,
      requests: Number(row?.requests ?? 0),
      bytes: Number(row?.bytes ?? 0),
    };
  }

  async function warnIfClose(orgId, plan, usage) {
    if (plan.request_limit <= 0) return;
    const ratio = usage.requests / plan.request_limit;
    for (const threshold of WARN_AT) {
      const key = `${orgId}:${usage.period}:${threshold}`;
      if (ratio < threshold || warned.has(key)) continue;
      warned.add(key);
      await queue.produce(STREAMS.alert, {
        org_id: orgId,
        endpoint_id: 'billing',
        kind: 'quota_warning',
        detail: `${Math.round(ratio * 100)}% of ${plan.request_limit} requests used`,
        used: usage.requests,
        limit: plan.request_limit,
        plan: plan.name,
      });
      log.info('quota warning emitted', { org_id: orgId, threshold });
    }
  }

  return router({
    'GET /health': async () => ({ ok: true, service: 'billing-service', store: store.driver }),

    'GET /v1/plans': async () => PLANS,

    'POST /v1/usage': async ({ req }) => {
      requireInternalToken(req);
      const { data } = await readBody(req);
      const orgId = requireOrg(req, data);
      const row = await store.appendUsage(orgId, {
        period: periodKey(),
        requests: Number(data?.requests ?? 1),
        bytes: Number(data?.bytes ?? 0),
      });
      const subscription = await subscriptionFor(orgId);
      const plan = planById(subscription.plan_id) ?? PLANS[0];
      const usage = await usageFor(orgId);
      await warnIfClose(orgId, plan, usage);

      return {
        plan: plan.id,
        requests: Number(row?.requests ?? usage.requests),
        limit: plan.request_limit,
        // Soft cap: over quota never drops a webhook, it only flags an upgrade.
        over_limit: plan.request_limit >= 0 && usage.requests > plan.request_limit,
        period: usage.period,
      };
    },

    'GET /v1/usage': async ({ req }) => {
      const orgId = requireOrg(req);
      const subscription = await subscriptionFor(orgId);
      const plan = planById(subscription.plan_id) ?? PLANS[0];
      const usage = await usageFor(orgId);
      return {
        org_id: orgId,
        period: usage.period,
        plan: plan.id,
        used: usage.requests,
        limit: plan.request_limit,
        bytes: usage.bytes,
        over_limit: plan.request_limit >= 0 && usage.requests > plan.request_limit,
      };
    },

    /** Called synchronously by the ingest gateway before creating an endpoint. */
    'POST /v1/quota/endpoints': async ({ req }) => {
      requireInternalToken(req);
      const { data } = await readBody(req);
      const orgId = requireOrg(req, data);
      const subscription = await subscriptionFor(orgId);
      const plan = planById(subscription.plan_id) ?? PLANS[0];
      const current = Number(data?.current ?? 0);
      if (plan.endpoint_limit >= 0 && current >= plan.endpoint_limit) {
        throw new HttpError(
          402,
          `plan '${plan.name}' allows ${plan.endpoint_limit} endpoint(s); upgrade to add more`,
        );
      }
      return { allowed: true, limit: plan.endpoint_limit, current };
    },

    'POST /v1/subscriptions': async ({ req }) => {
      requireInternalToken(req);
      const { data } = await readBody(req);
      const orgId = requireOrg(req, data);
      const plan = planById(data?.plan_id);
      if (!plan) throw new HttpError(400, `unknown plan: ${data?.plan_id}`);

      const existing = await store.find('subscriptions', (row) => row.org_id === orgId);
      const patch = {
        plan_id: plan.id,
        status: 'active',
        updated_at: new Date().toISOString(),
      };
      const record = existing
        ? await store.update('subscriptions', orgId, patch)
        : await store.insert('subscriptions', { id: orgId, org_id: orgId, ...patch, created_at: new Date().toISOString() });

      log.info('subscription changed', { org_id: orgId, plan: plan.id });
      return record ?? { org_id: orgId, ...patch };
    },

    'GET /v1/subscriptions': async ({ req }) => {
      const orgId = requireOrg(req);
      const subscription = await subscriptionFor(orgId);
      const plan = planById(subscription.plan_id) ?? PLANS[0];
      const usage = await usageFor(orgId);
      return {
        org_id: orgId,
        plan: {
          id: plan.id,
          name: plan.name,
          price_monthly_cents: plan.price_monthly_cents,
          // Show the customer the window the sweep actually enforces, so the
          // number on the pricing page is the number they get.
          retention_days: plan.retention_days,
        },
        status: subscription.status,
        invoice: {
          period: usage.period,
          subtotal_cents: plan.price_monthly_cents,
          included: plan.request_limit,
          used: usage.requests,
          // Overage stays $0 by design: "never drop a webhook" is the product
          // promise here, so going over is an upgrade nudge, not a surcharge.
          overage_cents: 0,
          total_cents: plan.price_monthly_cents,
        },
      };
    },

    /**
     * Run the retention sweep now instead of waiting for the interval. Ops
     * only: a customer-triggered delete would be a denial-of-service against
     * their own log.
     */
    'POST /v1/retention/sweep': async ({ req }) => {
      requireInternalToken(req);
      if (!sweeper) throw new HttpError(503, 'retention sweeper not running');
      return sweeper.runNow();
    },

    'GET /v1/revenue': async ({ req }) => {
      requireInternalToken(req);
      const subs = await store.list('subscriptions');
      const byPlan = {};
      let mrrCents = 0;
      for (const sub of subs) {
        const plan = planById(sub.plan_id) ?? PLANS[0];
        byPlan[plan.id] = (byPlan[plan.id] ?? 0) + 1;
        mrrCents += plan.price_monthly_cents;
      }
      return {
        mrr_cents: mrrCents,
        mrr_usd: Number((mrrCents / 100).toFixed(2)),
        subscriptions: byPlan,
        orgs: subs.length,
      };
    },
  });
}
