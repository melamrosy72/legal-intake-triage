import { execSync } from 'node:child_process';
import type { TestProject } from 'vitest/node';

/** Creates the test database if needed and applies all migrations before any integration test runs. */
export default function setup(project: TestProject): void {
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: project.config.env.DATABASE_URL },
    stdio: 'inherit',
  });
}
