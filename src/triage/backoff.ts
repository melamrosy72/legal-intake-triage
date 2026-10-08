import { LlmTransportError } from '../llm/llm.errors.js';

const BASE_MS = 2_000;
const CAP_MS = 30_000;
const RETRY_AFTER_CAP_MS = 60_000;
const JITTER = 0.25;

/**
 * Delay before the next attempt. `attempt` is the 1-based attempt that just failed (what BullMQ
 * passes to a custom backoff strategy). A provider's Retry-After wins, capped at 60s; otherwise
 * min(30s, 2s × 2^(attempt−1)) plus up to 25% random jitter so retries don't arrive in lockstep.
 */
export function computeBackoffMs(
  attempt: number,
  err: unknown,
  random: () => number = Math.random,
): number {
  if (err instanceof LlmTransportError && err.retryAfterMs !== undefined) {
    return Math.min(err.retryAfterMs, RETRY_AFTER_CAP_MS);
  }
  const base = Math.min(CAP_MS, BASE_MS * 2 ** (attempt - 1));
  return Math.round(base + random() * JITTER * base);
}
