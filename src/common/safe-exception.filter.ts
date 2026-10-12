import {
  ArgumentsHost,
  Catch,
  HttpException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

/**
 * Error class and code only. Error messages can carry inquiry text (Prisma can print query
 * values), so use this for every log of an unknown error, in the API and in the worker.
 */
export function describeError(err: unknown): {
  errorClass: string;
  code?: string;
} {
  const errorClass =
    err instanceof Error
      ? err.name !== 'Error'
        ? err.name
        : err.constructor.name
      : typeof err;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' || typeof code === 'number'
    ? { errorClass, code: String(code) }
    : { errorClass };
}

/**
 * Replaces Nest's default handling of non-HttpException errors, which logs the full error
 * (message and stack). HttpExceptions (our 400/404/409) keep the default behaviour.
 * Body-parser errors (malformed JSON, oversized body) arrive here already sanitized by
 * useSafeBodyParsers, as HttpExceptions with fixed messages.
 */
@Catch()
export class SafeExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('ExceptionsHandler');

  override catch(exception: unknown, host: ArgumentsHost): void {
    if (exception instanceof HttpException) {
      super.catch(exception, host);
      return;
    }
    const { errorClass, code } = describeError(exception);
    this.logger.error(`Unhandled ${errorClass}${code ? ` code=${code}` : ''}`);
    super.catch(
      new InternalServerErrorException('Internal server error'),
      host,
    );
  }
}
