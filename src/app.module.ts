import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SafeExceptionFilter } from './common/safe-exception.filter.js';
import { EnvModule } from './config/env.module.js';
import { HealthController } from './health/health.controller.js';
import { InquiriesController } from './inquiries/inquiries.controller.js';
import { InquiriesService } from './inquiries/inquiries.service.js';
import { LlmModule } from './llm/llm.module.js';
import { PrismaService } from './prisma/prisma.service.js';

@Module({
  imports: [EnvModule, LlmModule],
  controllers: [HealthController, InquiriesController],
  providers: [
    { provide: APP_FILTER, useClass: SafeExceptionFilter },
    PrismaService,
    InquiriesService,
  ],
})
export class AppModule {}
