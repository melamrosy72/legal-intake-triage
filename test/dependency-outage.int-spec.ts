import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp } from './test-app.js';

const TEXT = 'My landlord changed the locks yesterday.';
// Nothing listens on port 1, so connecting fails straight away: a real outage, not a mock.
const DEAD_DATABASE_URL = 'postgresql://triage:triage@localhost:1/triage_test';
const DEAD_REDIS_URL = 'redis://localhost:1/1';

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

const OUTAGE_BODY = {
  statusCode: 503,
  error: 'Service Unavailable',
  message: 'A dependency is temporarily unavailable; retry the same request',
};

/** POSTs once and returns the response, how long it took, and every error-level log line. */
async function postLogged(t: TestApp, key: string) {
  const logged: unknown[] = [];
  const spy = vi
    .spyOn(Logger.prototype, 'error')
    .mockImplementation((...args) => void logged.push(...args));
  const started = Date.now();
  try {
    const res = await request(t.app.getHttpServer())
      .post('/inquiries')
      .set('Idempotency-Key', key)
      .send({ text: TEXT });
    return { res, ms: Date.now() - started, logged };
  } finally {
    spy.mockRestore();
  }
}

describe('while a dependency is unreachable', () => {
  let healthy: TestApp;

  beforeAll(async () => {
    healthy = await createTestApp();
    await healthy.reset();
  });
  afterAll(() => healthy.app.close());

  it('the app still shuts down promptly when Redis was never reachable', async () => {
    const t = await createTestApp({ REDIS_URL: DEAD_REDIS_URL });
    const started = Date.now();
    await t.app.close();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('POST with Postgres down → 503 with Retry-After, logged as a dependency outage (class and code only)', async () => {
    const t = await createTestApp({ DATABASE_URL: DEAD_DATABASE_URL });
    try {
      const { res, logged } = await postLogged(t, randomUUID());

      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.body).toEqual(OUTAGE_BODY);
      expect(logged).toEqual([
        'Dependency outage: database unreachable, PrismaClientKnownRequestError code=ECONNREFUSED',
      ]);
    } finally {
      await t.app.close();
    }
  });

  it('POST with Redis down → 503 within 2 s; the replay once Redis is back recovers the inquiry', async () => {
    const t = await createTestApp({ REDIS_URL: DEAD_REDIS_URL });
    const key = randomUUID();
    try {
      const { res, ms, logged } = await postLogged(t, key);

      expect(res.status).toBe(503);
      expect(ms).toBeLessThan(2_000);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.body).toEqual(OUTAGE_BODY);
      expect(logged).toContain(
        'Dependency outage: redis unreachable, EnqueueTimeoutError',
      );
      expect(JSON.stringify(logged)).not.toContain(TEXT);
    } finally {
      await t.app.close();
    }
    // The row was saved before the enqueue failed.
    const row = await healthy.prisma.inquiry.findUniqueOrThrow({
      where: { idempotencyKey: key },
    });
    expect(row.status).toBe('RECEIVED');

    // Redis is reachable again (the healthy app): the replay re-enqueues and the worker finishes.
    const server = healthy.app.getHttpServer();
    await request(server)
      .post('/inquiries')
      .set('Idempotency-Key', key)
      .send({ text: TEXT })
      .expect(200);
    await vi.waitFor(
      async () => {
        const { body } = await request(server).get(`/inquiries/${row.id}`);
        expect(body.status).toBe('COMPLETED');
      },
      { timeout: 10_000, interval: 100 },
    );
  });
});
