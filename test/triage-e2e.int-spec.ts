import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeLlmClient, keywordTriage } from '../src/llm/fake-llm.client.js';
import { LlmTransportError } from '../src/llm/llm.errors.js';
import { PROMPT_VERSION } from '../src/triage/triage.prompt.js';
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
      llmCalls: [
        {
          jobAttempt: 1,
          kind: 'INITIAL',
          outcome: 'OK',
          promptVersion: PROMPT_VERSION,
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
      done.llmCalls.map((a: { jobAttempt: number; outcome: string }) => [
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

  it('a job BullMQ fails for stalling too often ends as NEEDS_HUMAN_REVIEW(INTERNAL_ERROR)', async () => {
    // Reproduce BullMQ's own stall-limit path: moveStalledJobsToWait sets the job's deferred
    // failure ("defa") and puts it back in the waiting list; the next worker to fetch it fails it
    // with UnrecoverableError without running our processor, and emits 'failed'.
    await t.worker.pause();
    const redis = new Redis(process.env.REDIS_URL!);
    let id: string;
    try {
      const { body } = await request(t.app.getHttpServer())
        .post('/inquiries')
        .set('Idempotency-Key', randomUUID())
        .send({ text: TEXT })
        .expect(202);
      id = body.id;
      await redis.hset(
        `bull:triage:${id}`,
        'defa',
        'job stalled more than allowable limit',
      );
    } finally {
      redis.disconnect();
      await t.worker.resume();
    }

    const done = await poll(id);

    expect(done).toMatchObject({
      status: 'NEEDS_HUMAN_REVIEW',
      reviewReason: 'INTERNAL_ERROR',
      llmCalls: [], // the processor never ran, so the model was never called
    });
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
    expect(done.llmCalls).toHaveLength(1); // processed once, not once per replay
  });
});
