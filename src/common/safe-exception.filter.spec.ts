import { ArgumentsHost, ConflictException, Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import { SafeExceptionFilter } from './safe-exception.filter.js';

const SECRET = 'SECRET-CLIENT-TEXT';

function setup() {
  const reply = vi.fn();
  const adapter = { reply, isHeadersSent: () => false, end: vi.fn() };
  // BaseExceptionFilter accepts the HTTP adapter directly as `applicationRef`.
  const filter = new SafeExceptionFilter(adapter as never);
  const host = { getArgByIndex: () => ({}) } as unknown as ArgumentsHost;
  const logged: unknown[] = [];
  vi.spyOn(Logger.prototype, 'error').mockImplementation((...args) => {
    logged.push(...args);
  });
  return { filter, host, reply, logged };
}

describe('SafeExceptionFilter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs only the class and code of a Prisma error and answers a generic 500', () => {
    const { filter, host, reply, logged } = setup();
    const err = new Prisma.PrismaClientKnownRequestError(
      `Invalid value "${SECRET}"`,
      { code: 'P2000', clientVersion: '7.10.0' },
    );

    filter.catch(err, host);

    expect(reply).toHaveBeenCalledWith(
      {},
      {
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Internal server error',
      },
      500,
    );
    expect(logged).toEqual([
      'Unhandled PrismaClientKnownRequestError code=P2000',
    ]);
  });

  it('passes HttpExceptions through unchanged and does not log them', () => {
    const { filter, host, reply, logged } = setup();

    filter.catch(new ConflictException('key reused'), host);

    expect(reply).toHaveBeenCalledWith(
      {},
      { statusCode: 409, message: 'key reused', error: 'Conflict' },
      409,
    );
    expect(logged).toEqual([]);
  });
});
