import { describe, expect, it } from 'vitest';
import { LlmTransportError } from '../llm/llm.errors.js';
import { computeBackoffMs } from './backoff.js';

const noJitter = () => 0;
const maxJitter = () => 0.999_999;

describe('computeBackoffMs (test 17)', () => {
  it('grows exponentially with the attempt number', () => {
    expect(
      [1, 2, 3, 4].map((a) => computeBackoffMs(a, new Error(), noJitter)),
    ).toEqual([2_000, 4_000, 8_000, 16_000]);
  });

  it('never exceeds the 30s cap plus 25% jitter', () => {
    for (let attempt = 1; attempt <= 20; attempt++) {
      expect(
        computeBackoffMs(attempt, new Error(), maxJitter),
      ).toBeLessThanOrEqual(37_500);
    }
    expect(computeBackoffMs(10, new Error(), noJitter)).toBe(30_000);
  });

  it('adds at most 25% jitter on top of the base delay', () => {
    expect(computeBackoffMs(1, new Error(), () => 0.5)).toBe(2_250);
    expect(computeBackoffMs(1, new Error(), maxJitter)).toBe(2_500);
  });

  it('uses retryAfterMs when the provider sent one, capped at 60s', () => {
    const rateLimited = (ms: number) =>
      new LlmTransportError('RATE_LIMITED', true, 429, ms);
    expect(computeBackoffMs(1, rateLimited(7_000), maxJitter)).toBe(7_000);
    expect(computeBackoffMs(1, rateLimited(3_600_000), maxJitter)).toBe(60_000);
  });

  it('falls back to exponential backoff for a transport error without retryAfterMs', () => {
    expect(
      computeBackoffMs(2, new LlmTransportError('TIMEOUT', true), noJitter),
    ).toBe(4_000);
  });
});
