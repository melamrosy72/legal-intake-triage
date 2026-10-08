import { z } from 'zod';

/** Treats `VAR=` (empty) as unset, so `z.coerce.number()` doesn't turn it into 0. */
const optionalNumber = (schema: z.ZodNumber) =>
  z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().pipe(schema).optional(),
  );

const EnvSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.url(),
    REDIS_URL: z.url(),
    MAX_INQUIRY_CHARS: z.coerce.number().int().positive().default(4000),
    TRIAGE_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
    QUEUE_ATTEMPTS: z.coerce.number().int().min(1).default(4),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(2),
    // Jobs started per window. A job makes 1 model call, or 2 when it needs a repair.
    WORKER_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(15),
    WORKER_RATE_LIMIT_DURATION_MS: z.coerce
      .number()
      .int()
      .min(1)
      .default(60_000),

    LLM_PROVIDER: z.enum(['fake', 'openrouter']).default('fake'),
    LLM_BASE_URL: z.url().default('https://openrouter.ai/api/v1'),
    LLM_API_KEY: z.string().optional(),
    LLM_MODEL: z.string().optional(),
    LLM_STRUCTURED_MODE: z
      .enum(['json_schema', 'json_object'])
      .default('json_schema'),
    LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
    LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(800),
    LLM_TEMPERATURE: optionalNumber(z.number().min(0).max(2)),
    // Only sent to OpenRouter, and only when set. Unset = no `reasoning` field at all.
    LLM_REASONING_EFFORT: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.enum(['none', 'minimal', 'low', 'medium', 'high']).optional(),
    ),
  })
  .superRefine((env, ctx) => {
    if (env.LLM_PROVIDER === 'fake') return;
    for (const key of ['LLM_API_KEY', 'LLM_MODEL'] as const) {
      if (!env[key]) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `required when LLM_PROVIDER=${env.LLM_PROVIDER}`,
        });
      }
    }
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
