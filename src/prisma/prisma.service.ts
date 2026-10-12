import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { ENV, type Env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    // pg waits forever for a connection by default; a bounded wait lets /health report a dead DB.
    super({
      adapter: new PrismaPg({
        connectionString: env.DATABASE_URL,
        connectionTimeoutMillis: 5_000,
        // Postgres cancels any app query running longer than this. It is set on this pool only:
        // the Prisma CLI (migrations) connects with DATABASE_URL alone, so a migration is not cut off.
        statement_timeout: 10_000,
      }),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
