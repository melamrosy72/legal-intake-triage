import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SafeExceptionFilter } from './common/safe-exception.filter.js';
import { EnvModule } from './config/env.module.js';
import { HealthController } from './health/health.controller.js';
import { InquiriesController } from './inquiries/inquiries.controller.js';
import { InquiriesService } from './inquiries/inquiries.service.js';
import { PrismaService } from './prisma/prisma.service.js';
import { TriageModule } from './triage/triage.module.js';
import { TriageProcessor } from './triage/triage.processor.js';
import { TriageQueue } from './triage/triage.queue.js';

@Module({
  imports: [EnvModule, TriageModule],
  controllers: [HealthController, InquiriesController],
  providers: [
    { provide: APP_FILTER, useClass: SafeExceptionFilter },
    PrismaService,
    InquiriesService,
    TriageQueue,
    TriageProcessor, // the worker runs in the API process (demo trade-off, see README)
  ],
})
export class AppModule {}
