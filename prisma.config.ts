import { defineConfig } from 'prisma/config';
import { loadDotEnv } from './src/config/env.js';

loadDotEnv();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL },
});
