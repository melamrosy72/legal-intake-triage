import { Module } from '@nestjs/common';
import { ENV, parseEnv } from './config/env.js';
import { HealthController } from './health/health.controller.js';
import { PrismaService } from './prisma/prisma.service.js';

@Module({
  controllers: [HealthController],
  providers: [{ provide: ENV, useFactory: () => parseEnv() }, PrismaService],
})
export class AppModule {}
