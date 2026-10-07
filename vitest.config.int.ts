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
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379',
      LLM_PROVIDER: 'fake', // tests never call a real provider
    },
    fileParallelism: false, // test files share one database
    hookTimeout: 30_000,
  },
});
