import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  MAX_INQUIRY_CHARS: z.coerce.number().int().positive().default(4000),
});

export type Env = z.infer<typeof EnvSchema>;

/** Injection token for the validated environment. */
export const ENV = Symbol('ENV');

/** Parses and validates the environment. Throws with every problem listed so boot fails fast. */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** Loads `.env` into process.env if it exists. Real env vars win; a missing file is fine (Docker, CI). */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
