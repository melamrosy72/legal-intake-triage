import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { InquiryStatus } from '../src/generated/prisma/enums.js';
import { FakeLlmClient, keywordTriage } from '../src/llm/fake-llm.client.js';
import { LlmTransportError } from '../src/llm/llm.errors.js';
import {
  TriageJobError,
  TriageProcessor,
} from '../src/triage/triage.processor.js';
import type { TriageJobData } from '../src/triage/triage.queue.js';
import { createTestApp } from './test-app.js';

const TEXT =
  'My landlord changed the locks yesterday. The hearing is on Friday.';
const SECRET = 'SECRET-CLIENT-TEXT';

/** One BullMQ attempt: attemptsMade counts previous failures, so attempt N has attemptsMade N-1. */
const jobFor = (inquiryId: string, attempt: number, attempts = 4) =>
  ({
    data: { inquiryId },
    attemptsMade: attempt - 1,
    opts: { attempts },
  }) as unknown as Job<TriageJobData>;

describe('TriageProcessor', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let processor: TriageProcessor;

  beforeAll(async () => {
    t = await createTestApp();
    processor = t.app.get(TriageProcessor);
  });
  beforeEach(() => t.reset());
  afterAll(() => t.app.close());

  /** Inserted directly (no enqueue), so the running worker never sees it. */
  const insert = async (status: InquiryStatus = 'RECEIVED', rawText = TEXT) =>
    (
      await t.prisma.inquiry.create({
        data: {
          idempotencyKey: randomUUID(),
          requestHash: 'h',
          rawText,
          status,
        },
      })
    ).id;
  const load = (id: string) =>
    t.prisma.inquiry.findUniqueOrThrow({
      where: { id },
      include: { llmCalls: true },
    });
  const script = (...items: Parameters<FakeLlmClient['respondWith']>) => {
    const fake = new FakeLlmClient().respondWith(...items);
    t.llm.impl = fake;
    return fake;
  };

  it('completes an inquiry and records the call with its job attempt', async () => {
    t.llm.impl = new FakeLlmClient(keywordTriage);
    const id = await insert();

    await processor.process(jobFor(id, 1));

    const row = await load(id);
    expect(row).toMatchObject({ status: 'COMPLETED', reviewReason: null });
    expect(row.processedAt).toBeInstanceOf(Date);
    expect(row.result).toMatchObject({
      practiceArea: 'REAL_ESTATE',
      urgency: 'HIGH',
    });
    expect(row.llmCalls).toMatchObject([
      { jobAttempt: 1, kind: 'INITIAL', outcome: 'OK' },
    ]);
  });

  it('13. retryable error with attempts left → rethrows, stays PROCESSING, one llm_calls row', async () => {
    const error = new LlmTransportError('TIMEOUT', true);
    script(error);
    const id = await insert();

    await expect(processor.process(jobFor(id, 1))).rejects.toBe(error);

    const row = await load(id);
    expect(row.status).toBe('PROCESSING');
    expect(row.llmCalls).toMatchObject([
      { jobAttempt: 1, outcome: 'TIMEOUT', errorCode: 'TIMEOUT' },
    ]);
  });

  it('13b. a RATE_LIMITED error is rethrown with retryAfterMs intact for the backoff', async () => {
    script(new LlmTransportError('RATE_LIMITED', true, 429, 9_000));
    const id = await insert();

    await expect(processor.process(jobFor(id, 2))).rejects.toMatchObject({
      retryAfterMs: 9_000,
    });
    expect((await load(id)).llmCalls).toMatchObject([
      { jobAttempt: 2, outcome: 'RATE_LIMITED', httpStatus: 429 },
    ]);
  });

  it('14. retryable error on the last attempt → NEEDS_HUMAN_REVIEW(PROVIDER_FAILURE), does not throw', async () => {
    script(new LlmTransportError('SERVER_ERROR', true, 503));
    const id = await insert('PROCESSING'); // earlier attempts already claimed it

    await expect(processor.process(jobFor(id, 4))).resolves.toBeUndefined();

    const row = await load(id);
    expect(row).toMatchObject({
      status: 'NEEDS_HUMAN_REVIEW',
      reviewReason: 'PROVIDER_FAILURE',
      result: null,
    });
    expect(row.llmCalls).toMatchObject([
      { jobAttempt: 4, outcome: 'PROVIDER_ERROR', httpStatus: 503 },
    ]);
  });

  it('15. non-retryable error (AUTH) on the first attempt → PROVIDER_FAILURE immediately', async () => {
    script(new LlmTransportError('AUTH', false, 401));
    const id = await insert();

    await expect(processor.process(jobFor(id, 1))).resolves.toBeUndefined();

    const row = await load(id);
    expect(row).toMatchObject({
      status: 'NEEDS_HUMAN_REVIEW',
      reviewReason: 'PROVIDER_FAILURE',
    });
    expect(row.llmCalls).toMatchObject([
      { jobAttempt: 1, outcome: 'NON_RETRYABLE_ERROR' },
    ]);
  });

  it.each(['COMPLETED', 'NEEDS_HUMAN_REVIEW'] as const)(
    '16. inquiry already %s → the LLM client is never called',
    async (status) => {
      const fake = script();
      const id = await insert(status);

      await processor.process(jobFor(id, 1));

      expect(fake.requests).toHaveLength(0);
      expect((await load(id)).status).toBe(status);
    },
  );

  it('a missing inquiry is skipped without calling the LLM', async () => {
    const fake = script();
    await expect(
      processor.process(jobFor(randomUUID(), 1)),
    ).resolves.toBeUndefined();
    expect(fake.requests).toHaveLength(0);
  });

  describe('non-transport errors (INTERNAL_ERROR)', () => {
    it('retries with a sanitized error that carries neither the message nor the inquiry text', async () => {
      script(new Error(`database said: invalid value "${SECRET}"`));
      const id = await insert();

      const err = await processor
        .process(jobFor(id, 1))
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(TriageJobError);
      expect((err as Error).message).toBe('Error');
      expect(JSON.stringify(err)).not.toContain(SECRET);
      expect((err as Error).stack).not.toContain(SECRET);
      expect((await load(id)).status).toBe('PROCESSING');
    });

    it('ends as NEEDS_HUMAN_REVIEW(INTERNAL_ERROR) on the last attempt, never PROVIDER_FAILURE', async () => {
      script(new TypeError('cannot read properties of undefined'));
      const id = await insert('PROCESSING');

      await expect(processor.process(jobFor(id, 4))).resolves.toBeUndefined();

      expect(await load(id)).toMatchObject({
        status: 'NEEDS_HUMAN_REVIEW',
        reviewReason: 'INTERNAL_ERROR',
        result: null,
      });
    });

    it('logs only ids, the error class and code, never the message', async () => {
      const lines: unknown[] = [];
      const spies = (['log', 'warn', 'error'] as const).map((m) =>
        vi
          .spyOn(Logger.prototype, m)
          .mockImplementation((...args) => void lines.push(...args)),
      );
      try {
        script(new Error(`boom ${SECRET}`));
        const id = await insert('RECEIVED', `${SECRET} ${TEXT}`);
        await processor.process(jobFor(id, 4));
        expect(lines).toEqual([
          `inquiry=${id} attempt=4/4 failed Error retry=false`,
          expect.stringMatching(
            new RegExp(
              `^inquiry=${id} attempt=4/4 NEEDS_HUMAN_REVIEW\\(INTERNAL_ERROR\\) in \\d+ms$`,
            ),
          ),
        ]);
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
    });
  });

  it('a late duplicate never overwrites a terminal state (conditional final write)', async () => {
    const id = await insert();
    // While this run waits on the model, another run finishes the inquiry first.
    t.llm.impl = {
      generateStructured: async (req) => {
        await t.prisma.inquiry.update({
          where: { id },
          data: {
            status: 'NEEDS_HUMAN_REVIEW',
            reviewReason: 'LOW_CONFIDENCE',
          },
        });
        return keywordTriage(req);
      },
    };

    await processor.process(jobFor(id, 1));

    expect(await load(id)).toMatchObject({
      status: 'NEEDS_HUMAN_REVIEW',
      reviewReason: 'LOW_CONFIDENCE',
    });
  });

  it('uses worker concurrency and rate limiter from env', () => {
    const worker = (
      processor as unknown as { worker: { opts: Record<string, unknown> } }
    ).worker;
    expect(worker.opts).toMatchObject({
      concurrency: 2, // WORKER_CONCURRENCY default
      limiter: { max: 1000, duration: 60_000 }, // vitest.config.int.ts + default duration
    });
  });
});
