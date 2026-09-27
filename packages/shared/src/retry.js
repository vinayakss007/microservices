import { config } from './config.js';

/** Exponential backoff with jitter: 2s, 8s, 32s, 2m, 3m30s (capped). */
export function retryDelay(attempt, { baseMs = config.backoffBaseMs, capMs = config.backoffCapMs } = {}) {
  const exponential = Math.min(capMs, baseMs * 4 ** (attempt - 1));
  const jitter = Math.random() * exponential * 0.2;
  return Math.round(Math.min(capMs, exponential + jitter));
}
