import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeLlmClient, keywordTriage } from '../src/llm/fake-llm.client.js';
import { LlmTransportError } from '../src/llm/llm.errors.js';
import { createTestApp } from './test-app.js';

const TEXT =
  'My landlord changed the locks yesterday and the eviction hearing is on Friday.';

describe('end to end: POST → queue → worker → GET (fake LLM)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;

  beforeAll(async () => {
    t = await createTestApp();
  });
  beforeEach(() => t.reset());
  afterAll(() => t.app.close());

  const poll = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const { body } = await request(t.app.getHttpServer())
        .get(`/inquiries/${id}`)
        .expect(200);
      if (body.status === 'COMPLETED' || body.status === 'NEEDS_HUMAN_REVIEW') {
        return body;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('inquiry did not reach a terminal state within 10s');
  };

  it('18. POST, then poll GET until COMPLETED', async () => {
    const { body: created } = await request(t.app.getHttpServer())
      .post('/inquiries')
      .set('Idempotency-Key', randomUUID())
      .send({ text: TEXT })
      .expect(202);

    const done = await poll(created.id);

    expect(done).toMatchObject({
      status: 'COMPLETED',
      reviewReason: null,
      result: { practiceArea: 'REAL_ESTATE', urgency: 'HIGH' },
      processedAt: expect.any(String),
      attempts: [
        {
          jobAttempt: 1,
          kind: 'INITIAL',
          outcome: 'OK',
          promptVersion: 'triage-v1',
        },
      ],
    });
  });

  it('a retryable failure goes back through BullMQ with our backoff, then completes on attempt 2', async () => {
    t.llm.impl = new FakeLlmClient(keywordTriage).respondWith(
      new LlmTransportError('TIMEOUT', true),
    );
    const started = Date.now();
    const { body } = await request(t.app.getHttpServer())
      .post('/inquiries')
      .set('Idempotency-Key', randomUUID())
      .send({ text: TEXT })
      .expect(202);

    const done = await poll(body.id);

    expect(done.status).toBe('COMPLETED');
    // jobAttempt comes from BullMQ's attemptsMade: 1 for the failure, 2 for the retry.
    expect(
      done.attempts.map((a: { jobAttempt: number; outcome: string }) => [
        a.jobAttempt,
        a.outcome,
      ]),
    ).toEqual([
      [1, 'TIMEOUT'],
      [2, 'OK'],
    ]);
    // First backoff is 2s plus up to 25% jitter.
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
  });

  it('the job carries only the inquiry id, never the text', async () => {
    const { body } = await request(t.app.getHttpServer())
      .post('/inquiries')
      .set('Idempotency-Key', randomUUID())
      .send({ text: TEXT })
      .expect(202);

    const job = await t.queue.getJob(body.id);
    expect(job?.data).toEqual({ inquiryId: body.id });
    await poll(body.id);
  });

  it('a replay of a RECEIVED inquiry whose job was lost re-enqueues it; jobId dedupe prevents doubles', async () => {
    const key = randomUUID();
    const { body } = await request(t.app.getHttpServer())
      .post('/inquiries')
      .set('Idempotency-Key', key)
      .send({ text: TEXT })
      .expect(202);
    await poll(body.id);
    // Simulate the dual-write gap: a RECEIVED row with no job.
    await t.queue.obliterate({ force: true });
    await t.prisma.inquiry.update({
      where: { id: body.id },
      data: { status: 'RECEIVED' },
    });
    await t.prisma.llmCall.deleteMany({ where: { inquiryId: body.id } });

    await request(t.app.getHttpServer())
      .post('/inquiries')
      .set('Idempotency-Key', key)
      .send({ text: TEXT })
      .expect(200);
    await request(t.app.getHttpServer())
      .post('/inquiries')
      .set('Idempotency-Key', key)
      .send({ text: TEXT });

    const done = await poll(body.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.attempts).toHaveLength(1); // processed once, not once per replay
  });
});
