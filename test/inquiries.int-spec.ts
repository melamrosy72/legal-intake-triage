import { randomUUID } from 'node:crypto';
import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const TEXT =
  'My landlord gave me an eviction notice and the hearing is on Friday.';

describe('Inquiries API', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const post = (key: string | undefined, body: unknown) => {
    const req = request(app.getHttpServer()).post('/inquiries');
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send(body as object);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE llm_calls, inquiries');
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates an inquiry and returns 202 RECEIVED', async () => {
    const res = await post(randomUUID(), { text: `  ${TEXT}  ` }).expect(202);
    expect(res.body).toEqual({ id: expect.any(String), status: 'RECEIVED' });

    const row = await prisma.inquiry.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    expect(row.rawText).toBe(TEXT); // stored trimmed
  });

  // Test 19
  it('same key and same body twice: one row, second response is 200 with current state', async () => {
    const key = randomUUID();
    const first = await post(key, { text: TEXT }).expect(202);
    const second = await post(key, { text: TEXT }).expect(200);

    expect(second.body).toMatchObject({
      id: first.body.id,
      status: 'RECEIVED',
      attempts: [],
    });
    expect(await prisma.inquiry.count()).toBe(1);
  });

  // Test 20
  it('same key with a different body returns 409', async () => {
    const key = randomUUID();
    await post(key, { text: TEXT }).expect(202);
    await post(key, { text: 'A completely different inquiry.' }).expect(409);
    expect(await prisma.inquiry.count()).toBe(1);
  });

  // Test 21
  it('two concurrent POSTs with the same key: one row, no 500', async () => {
    const key = randomUUID();
    const responses = await Promise.all([
      post(key, { text: TEXT }),
      post(key, { text: TEXT }),
    ]);

    expect(responses.map((r) => r.status).sort()).toEqual([200, 202]);
    expect(await prisma.inquiry.count()).toBe(1);
  });

  // Test 22
  it.each([
    ['missing Idempotency-Key', undefined, { text: TEXT }],
    ['Idempotency-Key shorter than 8 chars', 'short', { text: TEXT }],
    ['Idempotency-Key longer than 128 chars', 'k'.repeat(129), { text: TEXT }],
    ['missing text', randomUUID(), {}],
    ['empty text', randomUUID(), { text: '' }],
    ['whitespace-only text', randomUUID(), { text: '   \n\t ' }],
    ['non-string text', randomUUID(), { text: 42 }],
    ['oversized text', randomUUID(), { text: 'a'.repeat(4001) }],
    ['text containing a NUL byte', randomUUID(), { text: 'hello\u0000world' }],
  ])('returns 400 for %s', async (_case, key, body) => {
    await post(key, body).expect(400);
    expect(await prisma.inquiry.count()).toBe(0);
  });

  it('answers malformed JSON with 400 and never logs the body', async () => {
    const logged: unknown[] = [];
    const spy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((...args) => void logged.push(...args));
    try {
      await request(app.getHttpServer())
        .post('/inquiries')
        .set('Idempotency-Key', randomUUID())
        .set('Content-Type', 'application/json')
        .send('{"text": "SECRET-CLIENT-TEXT')
        .expect(400);
    } finally {
      spy.mockRestore();
    }
    // Nest's Express adapter turns the parse error into a 400 itself and logs nothing.
    expect(JSON.stringify(logged)).not.toContain('SECRET-CLIENT-TEXT');
  });

  it('accepts text exactly at MAX_INQUIRY_CHARS', async () => {
    await post(randomUUID(), { text: 'a'.repeat(4000) }).expect(202);
  });

  it('GET /inquiries/:id returns the inquiry with its attempts, 404 when unknown', async () => {
    const { body } = await post(randomUUID(), { text: TEXT }).expect(202);
    await prisma.llmCall.create({
      data: {
        inquiryId: body.id,
        jobAttempt: 1,
        kind: 'INITIAL',
        provider: 'fake',
        model: 'fake-model',
        promptVersion: 'triage-v1',
        latencyMs: 12,
        inputTokens: 100,
        outputTokens: 50,
        outcome: 'OK',
      },
    });

    const res = await request(app.getHttpServer())
      .get(`/inquiries/${body.id}`)
      .expect(200);
    expect(res.body).toEqual({
      id: body.id,
      rawText: TEXT,
      status: 'RECEIVED',
      reviewReason: null,
      result: null,
      createdAt: expect.any(String),
      processedAt: null,
      attempts: [
        {
          jobAttempt: 1,
          kind: 'INITIAL',
          outcome: 'OK',
          latencyMs: 12,
          inputTokens: 100,
          outputTokens: 50,
          model: 'fake-model',
          promptVersion: 'triage-v1',
        },
      ],
    });

    await request(app.getHttpServer())
      .get(`/inquiries/${randomUUID()}`)
      .expect(404);
    await request(app.getHttpServer()).get('/inquiries/not-a-uuid').expect(404);
    await request(app.getHttpServer()).get('/inquiries/%00').expect(404);
  });

  describe('GET /inquiries (review queue)', () => {
    const list = (query: Record<string, string | number>) =>
      request(app.getHttpServer()).get('/inquiries').query(query);

    it('filters by status and pages through every row exactly once, without rawText', async () => {
      // Same createdAt for several rows exercises the id tie-breaker in the cursor.
      const sameTime = new Date('2026-01-01T00:00:00.000Z');
      await prisma.inquiry.createMany({
        data: Array.from({ length: 7 }, (_, i) => ({
          idempotencyKey: `review-key-${i}`,
          requestHash: `hash-${i}`,
          rawText: `inquiry ${i}`,
          status: i < 5 ? 'NEEDS_HUMAN_REVIEW' : 'COMPLETED',
          createdAt: i < 3 ? sameTime : new Date(sameTime.getTime() + i * 1000),
        })),
      });

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await list({
          status: 'NEEDS_HUMAN_REVIEW',
          limit: 2,
          ...(cursor ? { cursor } : {}),
        }).expect(200);
        const page = res.body as {
          items: { id: string; status: string }[];
          nextCursor: string | null;
        };
        for (const item of page.items) {
          expect(item.status).toBe('NEEDS_HUMAN_REVIEW');
          expect(item).not.toHaveProperty('rawText');
          seen.push(item.id);
        }
        cursor = page.nextCursor;
      } while (cursor);

      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });

    it.each([
      ['unknown status', { status: 'DONE' }],
      ['limit above 100', { limit: 101 }],
      ['limit below 1', { limit: 0 }],
      ['malformed cursor', { cursor: 'not-a-cursor' }],
      [
        'cursor with a non-uuid id',
        {
          cursor: Buffer.from(
            JSON.stringify(['2026-01-01T00:00:00.000Z', 'x\u0000']),
          ).toString('base64url'),
        },
      ],
    ])('returns 400 for %s', async (_case, query) => {
      await list(query).expect(400);
    });
  });
});
