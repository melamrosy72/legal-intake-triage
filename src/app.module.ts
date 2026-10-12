import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SafeExceptionFilter } from './common/safe-exception.filter.js';
import { EnvModule } from './config/env.module.js';
import { HealthModule } from './health/health.module.js';
import { InquiriesModule } from './inquiries/inquiries.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { TriageModule } from './triage/triage.module.js';

@Module({
  imports: [
    EnvModule,
    PrismaModule,
    TriageModule,
    InquiriesModule,
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: SafeExceptionFilter }],
})
export class AppModule {}
