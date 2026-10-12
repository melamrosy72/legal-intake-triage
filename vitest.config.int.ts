import { defineConfig } from 'vitest/config';

// Integration tests run against the real Postgres and Redis from docker-compose,
// using a separate database so they never touch dev data.
export default defineConfig({
  test: {
    include: ['test/**/*.int-spec.ts'],
    globalSetup: ['test/global-setup.ts'],
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        'postgresql://triage:triage@localhost:5432/triage_test',
      // Redis db 1: a dev worker on db 0 can never pick up test jobs.
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1',
      LLM_PROVIDER: 'fake', // tests never call a real provider
      // The limiter's counter lives in Redis and outlasts a queue reset, so back-to-back runs
      // would hit the production default (8/min). Tests never reach a provider.
      WORKER_RATE_LIMIT_MAX: '1000',
    },
    testTimeout: 15_000, // end-to-end tests poll the worker for up to 10s
    fileParallelism: false, // test files share one database
    hookTimeout: 30_000,
  },
});
