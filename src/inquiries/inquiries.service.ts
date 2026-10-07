import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import type { InquiryStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
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
  | { created: false; inquiry: ReturnType<typeof toDetailView> };

@Injectable()
export class InquiriesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Insert-first idempotency: the unique index on idempotencyKey decides who wins a race.
   * A "select, then insert" check would let two concurrent requests both see "not found".
   */
  async create(
    idempotencyKey: string,
    text: string,
  ): Promise<CreateInquiryOutcome> {
    const requestHash = createHash('sha256').update(text).digest('hex');
    try {
      const inquiry = await this.prisma.inquiry.create({
        data: { idempotencyKey, requestHash, rawText: text },
        select: { id: true, status: true },
      });
      await this.enqueue(inquiry.id);
      return { created: true, inquiry };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await this.prisma.inquiry.findUnique({
        where: { idempotencyKey },
        select: { ...inquiryDetail, requestHash: true },
      });
      // Only the idempotency key is unique besides the uuid id, so this is unreachable in practice.
      if (!existing) throw err;
      const { requestHash: existingHash, ...detail } = existing;
      if (existingHash !== requestHash) {
        throw new ConflictException(
          'Idempotency-Key was already used with a different request body',
        );
      }
      return { created: false, inquiry: toDetailView(detail) };
    }
  }

  async findOne(id: string) {
    const row = await this.prisma.inquiry.findUnique({
      where: { id },
      select: inquiryDetail,
    });
    return row && toDetailView(row);
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

  // ponytail: no-op until M4 adds the BullMQ queue (jobId = inquiry id).
  private async enqueue(_inquiryId: string): Promise<void> {}
}

function toDetailView({ llmCalls, ...rest }: InquiryDetailRow) {
  return { ...rest, attempts: llmCalls };
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
