import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/**
 * Global, so every module shares one connection pool. Nest destroys global modules last,
 * so the worker finishes its job before Prisma disconnects.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
