import {
  Controller,
  Get,
  Inject,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { ENV, type Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';

type CheckResult = 'ok' | 'down';

@Controller('health')
export class HealthController implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) env: Env,
  ) {
    // No offline queue: when Redis is down, PING fails immediately instead of waiting for a reconnect.
    this.redis = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
    });
    // Without a listener ioredis prints every reconnect error; /health reports the state instead.
    this.redis.on('error', () => undefined);
  }

  @Get()
  async check() {
    const [database, redis] = await Promise.all([
      this.probe(() => this.prisma.$queryRaw`SELECT 1`),
      this.probe(async () => {
        if (this.redis.status === 'wait') await this.redis.connect();
        return this.redis.ping();
      }),
    ]);
    const body = {
      status: database === 'ok' && redis === 'ok' ? 'ok' : 'error',
      checks: { database, redis },
    };
    if (body.status !== 'ok') throw new ServiceUnavailableException(body);
    return body;
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }

  private async probe(fn: () => Promise<unknown>): Promise<CheckResult> {
    try {
      await fn();
      return 'ok';
    } catch {
      return 'down';
    }
  }
}
