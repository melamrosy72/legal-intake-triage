import { Module } from '@nestjs/common';
import { ENV, parseEnv } from './config/env.js';
import { HealthController } from './health/health.controller.js';
import { InquiriesController } from './inquiries/inquiries.controller.js';
import { InquiriesService } from './inquiries/inquiries.service.js';
import { PrismaService } from './prisma/prisma.service.js';

@Module({
  controllers: [HealthController, InquiriesController],
  providers: [
    { provide: ENV, useFactory: () => parseEnv() },
    PrismaService,
    InquiriesService,
  ],
})
export class AppModule {}
