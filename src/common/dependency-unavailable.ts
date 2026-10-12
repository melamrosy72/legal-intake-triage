import { ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';

/** Sent as Retry-After: how long a client should wait before replaying the request. */
export const RETRY_AFTER_SECONDS = 5;

/**
 * How "cannot reach the database" surfaces through Prisma 7 and the pg driver adapter (checked
 * against the installed versions): Prisma's P1xxx codes (P1001 for an unknown host), the raw
 * socket code for a refused or reset connection, and pg's own message when connecting times out.
 */
const UNREACHABLE_CODES = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);
const PG_CONNECT_TIMEOUT = 'Connection terminated due to connection timeout';

/**
 * Postgres or Redis could not be reached while handling a request. Answered 503 with
 * Retry-After, because replaying the same request (same Idempotency-Key) recovers it.
 * The original error is kept as `cause` for logging (class and code only), never sent.
 */
export class DependencyUnavailableException extends ServiceUnavailableException {
  constructor(
    readonly dependency: 'database' | 'redis',
    cause: unknown,
  ) {
    super('A dependency is temporarily unavailable; retry the same request', {
      cause,
    });
  }
}

/** Wraps a Prisma "cannot reach the database" error; returns any other error unchanged. */
export function toDatabaseOutage(err: unknown): unknown {
  const unreachable =
    err instanceof Prisma.PrismaClientInitializationError ||
    (err instanceof Prisma.PrismaClientKnownRequestError &&
      UNREACHABLE_CODES.has(err.code)) ||
    (err instanceof Error && err.message === PG_CONNECT_TIMEOUT);
  return unreachable
    ? new DependencyUnavailableException('database', err)
    : err;
}
