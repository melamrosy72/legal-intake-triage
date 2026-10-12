import {
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

/** Express's default, made explicit. MAX_INQUIRY_CHARS of fully escaped JSON is ~24 kB. */
const BODY_LIMIT = '100kb';

/** The fields body-parser puts on its errors (http-errors). */
const BodyParserErrorSchema = z.object({
  type: z.string(),
  status: z.number().int().min(400).max(499),
});

/**
 * Body-parser errors carry parts of the raw body in their message (a JSON SyntaxError quotes the
 * text around the bad token), and Nest would send that message back. This answers them with fixed
 * text instead: 413 for an oversized body, 400 for one that does not parse.
 */
function toSafeBodyParserError(err: unknown): unknown {
  const parsed = BodyParserErrorSchema.safeParse(err);
  if (!parsed.success) return err;
  switch (parsed.data.status) {
    case 413:
      return new PayloadTooLargeException('Request body too large');
    case 415:
      return new UnsupportedMediaTypeException(
        'Unsupported request body encoding',
      );
    default:
      return new BadRequestException('Malformed request body');
  }
}

/**
 * Registers the JSON and form parsers Nest would add itself, followed by an error handler that
 * sanitizes their errors. Create the app with `{ bodyParser: false }` and call this before init.
 */
export function useSafeBodyParsers(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: true });
  app.use((err: unknown, _req: Request, _res: Response, next: NextFunction) =>
    next(toSafeBodyParserError(err)),
  );
}
