import { config, logger, PLANS, planById } from '@hookwatch/shared';

const log = logger({ service: 'billing-service' });

/**
 * Retention. Each plan prices a retention window, so the log a customer is
 * told they keep is the log they actually keep — and the rows past it really
 * do go, because storing every payload forever is the cost that kills a cheap
 * tier.
 *
 * Only settled rows are eligible. A delivery that is still queued/retrying/
 * in_progress is mid-flight: pruning it would drop an event the customer was
 * promised and leave the worker holding a row that is no longer in the log.
 * That is why the status allowlist is required rather than defaulted.
 */

const SETTLED_DELIVERIES = ['delivered', 'dead'];
const SETTLED_ALERTS = ['sent', 'failed', 'error'];

function cutoffFor(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/**
 * `retention_days` follows the same convention as `endpoint_limit`, where a
 * negative value means unlimited. Anything that is not a positive number — a
 * stray -1, a typo, a missing field — is treated as unlimited as well, because
 * guessing wrong in the other direction deletes customer history.
 */
function windowFor(plan) {
  const days = Number(plan?.retention_days);
  if (!Number.isFinite(days) || days <= 0) return null;
  return days;
}

/**
 * Sweep every org's settled history past its own plan window.
 *
 * Orgs are grouped by window so the file driver rewrites each table once per
 * distinct retention period instead of once per org.
 */
export async function sweepExpired({ store }) {
  // Read the plan mapping without writing it: a sweep that lazily created
  // subscription rows would be changing billing state as a side effect.
  const subs = await store.list('subscriptions');
  const planByOrg = new Map(subs.map((row) => [row.org_id, planById(row.plan_id) ?? PLANS[0]]));

  const orgIds = new Set(planByOrg.keys());
  for (const row of await store.list('deliveries')) orgIds.add(row.org_id);
  for (const row of await store.list('alerts')) orgIds.add(row.org_id);

  const groups = new Map();
  const skipped = [];
  for (const orgId of orgIds) {
    // An org with rows but no subscription row has no priced window. Purging it
    // on the Free tier's 1-day default would delete history nobody agreed to
    // prune, so it is left alone and reported instead.
    const plan = planByOrg.get(orgId);
    if (!plan) {
      skipped.push(orgId);
      continue;
    }
    const days = windowFor(plan);
    if (days === null) continue;
    if (!groups.has(days)) groups.set(days, []);
    groups.get(days).push(orgId);
  }

  const removed = { deliveries: 0, alerts: 0 };
  const byWindow = {};

  for (const [days, orgs] of groups) {
    const beforeIso = cutoffFor(days);
    const deliveries = await store.purgeOlderThan('deliveries', {
      beforeIso,
      statuses: SETTLED_DELIVERIES,
      orgIds: orgs,
    });
    const alerts = await store.purgeOlderThan('alerts', {
      beforeIso,
      statuses: SETTLED_ALERTS,
      orgIds: orgs,
    });
    if (!deliveries.length && !alerts.length) continue;
    removed.deliveries += deliveries.length;
    removed.alerts += alerts.length;
    byWindow[days] = { orgs, deliveries: deliveries.length, alerts: alerts.length };
  }

  if (removed.deliveries || removed.alerts) {
    log.info('retention sweep', {
      ...removed,
      windows: Object.keys(byWindow).join(','),
      skipped: skipped.length,
    });
  }
  return { removed, by_window: byWindow, skipped_no_plan: skipped, swept_at: new Date().toISOString() };
}

/** Hourly by default; timers are unref'd so they never hold the process open. */
export function startRetentionSweeper({ store, sweepMs = config.retentionSweepMs, kickoffMs = 2_000 }) {
  let running = false;
  const runNow = async () => {
    if (running) return { skipped: true };
    running = true;
    try {
      return await sweepExpired({ store });
    } catch (error) {
      log.error('retention sweep failed', { error: error.message });
      return { error: error.message };
    } finally {
      running = false;
    }
  };

  const timer = setInterval(runNow, sweepMs);
  timer.unref?.();
  // Sweep shortly after boot too, so a restart does not sit on a full interval
  // of overdue rows. Pass kickoffMs: null to opt out (tests drive runNow).
  let kickoff;
  if (kickoffMs !== null) {
    kickoff = setTimeout(runNow, kickoffMs);
    kickoff.unref?.();
  }

  return {
    runNow,
    stop: () => {
      clearInterval(timer);
      if (kickoff) clearTimeout(kickoff);
    },
  };
}
