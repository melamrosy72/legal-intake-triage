import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

describe('GET /health', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports database and redis as ok', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual({
      status: 'ok',
      checks: { database: 'ok', redis: 'ok' },
    });
  });

  it("the app's database connections carry a 10 s statement timeout", async () => {
    const rows = await app.get(PrismaService).$queryRaw<
      { statement_timeout: string }[]
    >`SHOW statement_timeout`;
    expect(rows).toEqual([{ statement_timeout: '10s' }]);
  });
});
