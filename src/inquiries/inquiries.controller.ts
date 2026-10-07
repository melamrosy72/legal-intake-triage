import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ENV, type Env } from '../config/env.js';
import {
  createInquiryBodySchema,
  IdempotencyKeySchema,
  InquiryIdSchema,
  ListInquiriesQuerySchema,
  parseOrBadRequest,
} from './dto/create-inquiry.dto.js';
import { InquiriesService } from './inquiries.service.js';

@Controller('inquiries')
export class InquiriesController {
  private readonly bodySchema: ReturnType<typeof createInquiryBodySchema>;

  constructor(
    private readonly inquiries: InquiriesService,
    @Inject(ENV) env: Env,
  ) {
    this.bodySchema = createInquiryBodySchema(env.MAX_INQUIRY_CHARS);
  }

  /** 202 for a new inquiry, 200 with the current state when the same key and body are replayed. */
  @Post()
  async create(
    @Headers('idempotency-key') rawKey: unknown,
    @Body() rawBody: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = parseOrBadRequest(IdempotencyKeySchema, rawKey);
    const { text } = parseOrBadRequest(this.bodySchema, rawBody);
    const outcome = await this.inquiries.create(key, text);
    res.status(outcome.created ? HttpStatus.ACCEPTED : HttpStatus.OK);
    return outcome.inquiry;
  }

  @Get()
  list(@Query() rawQuery: unknown) {
    return this.inquiries.list(
      parseOrBadRequest(ListInquiriesQuerySchema, rawQuery),
    );
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    // A non-uuid can never match a row; answering 404 keeps arbitrary path bytes away from the DB.
    if (!InquiryIdSchema.safeParse(id).success) throw new NotFoundException();
    const inquiry = await this.inquiries.findOne(id);
    if (!inquiry) throw new NotFoundException();
    return inquiry;
  }
}
