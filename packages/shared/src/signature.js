import { createHmac, timingSafeEqual } from 'node:crypto';

/** Stripe-style signed payloads so receivers can trust the event really came from us. */
export function sign(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `v1,ts=${timestamp},sig=${digest}`;
}

export function verifySignature(secret, header, body, toleranceSeconds = 300) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(
    String(header)
      .split(',')
      .map((piece) => piece.trim().split('='))
      .filter(([, value]) => value !== undefined),
  );
  if (!parts.ts || !parts.sig) return false;

  const timestamp = Number(parts.ts);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest();
  const received = Buffer.from(parts.sig, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}
