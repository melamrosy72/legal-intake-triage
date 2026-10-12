import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import {
  DependencyUnavailableException,
  toDatabaseOutage,
} from './dependency-unavailable.js';

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('x', {
    code,
    clientVersion: '7.10.0',
  });

describe('toDatabaseOutage', () => {
  it.each([
    ['an unknown host (P1001)', prismaError('P1001')],
    ['a refused connection (ECONNREFUSED)', prismaError('ECONNREFUSED')],
    [
      'a connect timeout (pg message)',
      new Error('Connection terminated due to connection timeout'),
    ],
  ])('wraps %s as a database outage', (_case, err) => {
    const wrapped = toDatabaseOutage(err);
    expect(wrapped).toBeInstanceOf(DependencyUnavailableException);
    expect(wrapped).toMatchObject({ dependency: 'database', cause: err });
  });

  it.each([
    ['a unique violation', prismaError('P2002')],
    ['a bug', new TypeError('x is undefined')],
  ])('returns %s unchanged', (_case, err) => {
    expect(toDatabaseOutage(err)).toBe(err);
  });
});
