import { describe, expect, it } from 'vitest';
import { createTestApp } from './test-app.js';

// Nothing listens on port 1, so connecting fails straight away: a real outage, not a mock.
const DEAD_REDIS_URL = 'redis://localhost:1/1';

describe('while a dependency is unreachable', () => {
  it('the app still shuts down promptly when Redis was never reachable', async () => {
    const t = await createTestApp({ REDIS_URL: DEAD_REDIS_URL });
    const started = Date.now();
    await t.app.close();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
