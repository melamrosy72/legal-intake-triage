import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';

const BASE = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
};

describe('parseEnv', () => {
  it('defaults to the fake provider, which needs no key or model', () => {
    const env = parseEnv(BASE);
    expect(env).toMatchObject({
      LLM_PROVIDER: 'fake',
      LLM_TIMEOUT_MS: 20_000,
      LLM_MAX_OUTPUT_TOKENS: 800,
    });
    expect(env.LLM_TEMPERATURE).toBeUndefined();
  });

  it('requires LLM_API_KEY and LLM_MODEL for openrouter', () => {
    expect(() => parseEnv({ ...BASE, LLM_PROVIDER: 'openrouter' })).toThrow(
      /LLM_API_KEY[\s\S]*LLM_MODEL/,
    );
  });

  it('treats an empty LLM_TEMPERATURE as unset but keeps an explicit 0', () => {
    expect(
      parseEnv({ ...BASE, LLM_TEMPERATURE: '' }).LLM_TEMPERATURE,
    ).toBeUndefined();
    expect(parseEnv({ ...BASE, LLM_TEMPERATURE: '0' }).LLM_TEMPERATURE).toBe(0);
  });

  it('rejects malformed values', () => {
    expect(() => parseEnv({ ...BASE, LLM_TEMPERATURE: 'warm' })).toThrow();
    expect(() => parseEnv({ ...BASE, LLM_STRUCTURED_MODE: 'xml' })).toThrow();
  });
});
