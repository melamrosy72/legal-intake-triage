import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { z } from 'zod';
import {
  DependencyUnavailableException,
  toDatabaseOutage,
} from '../common/dependency-unavailable.js';
import { Prisma } from '../generated/prisma/client.js';
import type { InquiryStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TriageQueue } from '../triage/triage.queue.js';
import { InquiryIdSchema } from './dto/create-inquiry.dto.js';

const inquiryDetail = {
  id: true,
  rawText: true,
  status: true,
  reviewReason: true,
  result: true,
  createdAt: true,
  processedAt: true,
  llmCalls: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      jobAttempt: true,
      kind: true,
      outcome: true,
      latencyMs: true,
      inputTokens: true,
      outputTokens: true,
      model: true,
      promptVersion: true,
    },
  },
} satisfies Prisma.InquirySelect;

/** The list endpoint never returns rawText. */
const inquirySummary = {
  id: true,
  status: true,
  reviewReason: true,
  result: true,
  createdAt: true,
  processedAt: true,
} satisfies Prisma.InquirySelect;

type InquiryDetailRow = Prisma.InquiryGetPayload<{
  select: typeof inquiryDetail;
}>;

export type CreateInquiryOutcome =
  | { created: true; inquiry: { id: string; status: InquiryStatus } }
  | { created: false; inquiry: InquiryDetailRow };

@Injectable()
export class InquiriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: TriageQueue,
  ) {}

  /**
   * Insert-first idempotency: the unique index on idempotencyKey decides who wins a race.
   * A "select, then insert" check would let two concurrent requests both see "not found".
   * Postgres or Redis being unreachable becomes a 503: replaying the request recovers it.
   */
  async create(
    idempotencyKey: string,
    text: string,
  ): Promise<CreateInquiryOutcome> {
    const requestHash = createHash('sha256').update(text).digest('hex');
    let inquiry: { id: string; status: InquiryStatus };
    try {
      inquiry = await this.prisma.inquiry.create({
        data: { idempotencyKey, requestHash, rawText: text },
        select: { id: true, status: true },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw toDatabaseOutage(err);
      return this.replay(idempotencyKey, requestHash, err);
    }
    // Known gap (README): if the process dies between the insert and this line, the inquiry
    // stays RECEIVED with no job until the client replays the request (see replay()).
    await this.enqueue(inquiry.id);
    return { created: true, inquiry };
  }

  private async replay(
    idempotencyKey: string,
    requestHash: string,
    uniqueViolation: unknown,
  ): Promise<CreateInquiryOutcome> {
    const existing = await this.prisma.inquiry
      .findUnique({
        where: { idempotencyKey },
        select: { ...inquiryDetail, requestHash: true },
      })
      .catch((err: unknown) => {
        throw toDatabaseOutage(err);
      });
    // Only the idempotency key is unique besides the uuid id, so this is unreachable in practice.
    if (!existing) throw uniqueViolation;
    const { requestHash: existingHash, ...detail } = existing;
    if (existingHash !== requestHash) {
      throw new ConflictException(
        'Idempotency-Key was already used with a different request body',
      );
    }
    // Still RECEIVED: the first request may have failed after its insert, before enqueueing.
    // jobId = inquiry id makes this a no-op when the job already exists.
    if (detail.status === 'RECEIVED') await this.enqueue(detail.id);
    return { created: false, inquiry: detail };
  }

  /**
   * Any enqueue failure is treated as Redis being unavailable: the row is already saved as
   * RECEIVED, so a 503 asks for exactly what recovers it, a replay that re-enqueues.
   */
  private async enqueue(inquiryId: string): Promise<void> {
    try {
      await this.queue.enqueue(inquiryId);
    } catch (err) {
      throw new DependencyUnavailableException('redis', err);
    }
  }

  async findOne(id: string) {
    return this.prisma.inquiry.findUnique({
      where: { id },
      select: inquiryDetail,
    });
  }

  /** Keyset pagination on (createdAt, id), oldest first so the review queue is worked FIFO. */
  async list(params: {
    status?: InquiryStatus;
    limit: number;
    cursor?: string;
  }) {
    const after = params.cursor ? decodeCursor(params.cursor) : undefined;
    const rows = await this.prisma.inquiry.findMany({
      where: {
        status: params.status,
        ...(after && {
          OR: [
            { createdAt: { gt: after.createdAt } },
            { createdAt: after.createdAt, id: { gt: after.id } },
          ],
        }),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: params.limit + 1, // one extra row tells us whether another page exists
      select: inquirySummary,
    });
    const items = rows.slice(0, params.limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > params.limit && last ? encodeCursor(last) : null,
    };
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify([row.createdAt.toISOString(), row.id]),
  ).toString('base64url');
}

const CursorSchema = z.tuple([z.iso.datetime(), InquiryIdSchema]);

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
  const parsed = CursorSchema.safeParse(decoded);
  if (!parsed.success) throw new BadRequestException('Invalid cursor');
  const [iso, id] = parsed.data;
  return { createdAt: new Date(iso), id };
}
