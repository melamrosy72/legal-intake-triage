import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { InquiryStatus } from '../../generated/prisma/enums.js';

export const IdempotencyKeySchema = z
  .string({ error: 'Idempotency-Key header is required' })
  .min(8)
  .max(128);

export function createInquiryBodySchema(maxChars: number) {
  return z.object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(maxChars)
      // Postgres text columns cannot store NUL; reject it here instead of failing with a 500.
      .refine((s) => !s.includes('\0'), 'must not contain NUL characters'),
  });
}

export const InquiryIdSchema = z.uuid();

export const ListInquiriesQuerySchema = z.object({
  status: z.enum(InquiryStatus).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
});

/** Parses untrusted input or throws 400 listing each issue. Issues never echo the input value. */
export function parseOrBadRequest<T extends z.ZodType>(
  schema: T,
  value: unknown,
): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Validation failed',
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }
  return parsed.data;
}
