/** Pricing ladder. Mirrors the webhook-monitoring market: cheap for solo devs,
 *  priced by volume for teams. Limits are soft on requests (never drop a webhook). */
export const PLANS = [
  {
    id: 'free',
    name: 'Free',
    price_monthly_cents: 0,
    request_limit: 1_000,
    endpoint_limit: 1,
    seat_limit: 1,
    retention_days: 1,
  },
  {
    id: 'pro',
    name: 'Pro',
    price_monthly_cents: 1200,
    request_limit: 25_000,
    endpoint_limit: 10,
    seat_limit: 1,
    retention_days: 14,
  },
  {
    id: 'production',
    name: 'Production',
    price_monthly_cents: 4900,
    request_limit: 250_000,
    endpoint_limit: 25,
    seat_limit: 5,
    retention_days: 30,
  },
  {
    id: 'scale',
    name: 'Scale',
    price_monthly_cents: 14_900,
    request_limit: 2_000_000,
    endpoint_limit: -1,
    seat_limit: 10,
    retention_days: 90,
  },
];

export const planById = (id) => PLANS.find((plan) => plan.id === id);

export function periodKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
