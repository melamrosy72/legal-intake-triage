import { describe, expect, it } from 'vitest';
import { TRIAGE_JSON_SCHEMA } from '../triage/triage.schema.js';
import type { LlmRequest } from './llm-client.interface.js';
import { LlmTransportError } from './llm.errors.js';
import {
  extractJson,
  OpenAiCompatibleConfig,
  OpenAiCompatibleLlmClient,
  parseRetryAfter,
  toProviderSchema,
} from './openai-compatible-llm.client.js';

const CONFIG: OpenAiCompatibleConfig = {
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: 'test-key',
  model: 'vendor/requested-model:free',
  structuredMode: 'json_schema',
  reasoningEffort: 'low',
};

const REQUEST: LlmRequest = {
  system: 'SYSTEM PROMPT',
  user: '<inquiry>\nhello\n</inquiry>',
  schemaName: 'triage',
  jsonSchema: TRIAGE_JSON_SCHEMA,
  maxOutputTokens: 800,
  timeoutMs: 5_000,
};

function completion(
  content: string | null,
  extra: { finish_reason?: string; refusal?: string } = {},
) {
  return {
    id: 'gen-1',
    model: 'vendor/actual-model',
    provider: 'Nvidia',
    choices: [
      {
        index: 0,
        finish_reason: extra.finish_reason ?? 'stop',
        message: {
          role: 'assistant',
          content,
          refusal: extra.refusal ?? null,
          reasoning: 'SECRET REASONING TEXT',
        },
      },
    ],
    usage: { prompt_tokens: 321, completion_tokens: 123 },
  };
}

/** Drives the real OpenAI SDK with canned HTTP responses and records what it sent. */
function fakeFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const calls: Array<Record<string, unknown>> = [];
  const fetchImpl = (_url: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(init?.body as string) as Record<string, unknown>);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
    );
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

async function run(
  status: number,
  body: unknown,
  opts: {
    headers?: Record<string, string>;
    config?: Partial<OpenAiCompatibleConfig>;
    request?: Partial<LlmRequest>;
  } = {},
) {
  const { calls, fetchImpl } = fakeFetch(status, body, opts.headers);
  const client = new OpenAiCompatibleLlmClient(
    { ...CONFIG, ...opts.config },
    fetchImpl,
  );
  const result = await client
    .generateStructured({ ...REQUEST, ...opts.request })
    .catch((e: unknown) => e);
  return { result, calls };
}

describe('OpenAiCompatibleLlmClient request', () => {
  it('sends json_schema with a provider-safe schema, require_parameters and excluded low reasoning', async () => {
    const { calls } = await run(200, completion('{}'));
    const body = calls[0]!;
    expect(body).toMatchObject({
      model: CONFIG.model,
      max_tokens: 800,
      provider: { require_parameters: true },
      reasoning: { effort: 'low', exclude: true },
      messages: [
        { role: 'system', content: 'SYSTEM PROMPT' },
        { role: 'user', content: REQUEST.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'triage', strict: true },
      },
    });
    expect(body).not.toHaveProperty('temperature');
    const sentSchema = JSON.stringify(body.response_format);
    expect(sentSchema).not.toMatch(
      /minLength|maxLength|minimum|maximum|maxItems|\$schema/,
    );
    expect(sentSchema).toContain('"additionalProperties":false');
  });

  it('sends temperature when set, including 0, and appends the follow-up as a second user message', async () => {
    const { calls } = await run(200, completion('{}'), {
      request: { temperature: 0, followUp: 'FIX THESE' },
    });
    expect(calls[0]!.temperature).toBe(0);
    expect(calls[0]!.messages).toEqual([
      { role: 'system', content: 'SYSTEM PROMPT' },
      { role: 'user', content: REQUEST.user },
      { role: 'user', content: 'FIX THESE' },
    ]);
  });

  it('omits reasoning when no effort is configured', async () => {
    const { calls } = await run(200, completion('{}'), {
      config: { reasoningEffort: undefined },
    });
    expect(calls[0]).not.toHaveProperty('reasoning');
  });

  it('omits OpenRouter-only fields for other OpenAI-compatible endpoints', async () => {
    const { calls, result } = await run(200, completion('{}'), {
      config: { baseURL: 'https://api.openai.com/v1' },
    });
    expect(calls[0]).not.toHaveProperty('provider');
    expect(calls[0]).not.toHaveProperty('reasoning');
    expect(result).toMatchObject({ provider: 'openai-compatible' });
  });

  it('json_object mode describes the schema in the system prompt', async () => {
    const { calls } = await run(200, completion('{}'), {
      config: { structuredMode: 'json_object' },
    });
    expect(calls[0]!.response_format).toEqual({ type: 'json_object' });
    const system = (calls[0]!.messages as Array<{ content: string }>)[0]!
      .content;
    expect(system).toMatch(/^SYSTEM PROMPT\n\nRespond with only a JSON object/);
    expect(system).toContain('"practiceArea"');
  });
});

describe('OpenAiCompatibleLlmClient response mapping', () => {
  it('parses the content and records the model and provider actually used', async () => {
    const { result } = await run(200, completion('{"a":1}'));
    expect(result).toEqual({
      json: { a: 1 },
      stopReason: 'complete',
      usage: { inputTokens: 321, outputTokens: 123 },
      provider: 'openrouter/Nvidia',
      model: 'vendor/actual-model',
      latencyMs: expect.any(Number),
    });
    expect(JSON.stringify(result)).not.toContain('SECRET REASONING');
  });

  it.each([
    ['length', 'truncated'],
    ['content_filter', 'refused'],
    ['tool_calls', 'other'],
  ])('maps finish_reason %s to %s', async (finish, expected) => {
    const { result } = await run(
      200,
      completion('{"a":1}', { finish_reason: finish }),
    );
    expect(result).toMatchObject({ stopReason: expected });
  });

  it('maps a refusal to refused with json null', async () => {
    const { result } = await run(
      200,
      completion(null, { refusal: 'I cannot help with that.' }),
    );
    expect(result).toMatchObject({ stopReason: 'refused', json: null });
  });

  it('returns json null when the content is not JSON', async () => {
    const { result } = await run(
      200,
      completion('Sorry, here is my answer in prose.'),
    );
    expect(result).toMatchObject({ stopReason: 'complete', json: null });
  });

  it('returns json null for empty content (reasoning used the whole token budget)', async () => {
    const { result } = await run(
      200,
      completion('', { finish_reason: 'length' }),
    );
    expect(result).toMatchObject({ stopReason: 'truncated', json: null });
  });
});

describe('OpenAiCompatibleLlmClient error normalization', () => {
  const kindOf = (r: unknown) => {
    expect(r).toBeInstanceOf(LlmTransportError);
    const e = r as LlmTransportError;
    return {
      kind: e.kind,
      retryable: e.retryable,
      httpStatus: e.httpStatus,
      retryAfterMs: e.retryAfterMs,
    };
  };
  const errorBody = (code: number) => ({
    error: { code, message: 'upstream said no' },
  });

  it.each([
    [429, 'RATE_LIMITED', true],
    [408, 'SERVER_ERROR', true],
    [500, 'SERVER_ERROR', true],
    [502, 'SERVER_ERROR', true],
    [503, 'SERVER_ERROR', true],
    [401, 'AUTH', false],
    [403, 'AUTH', false],
    [400, 'BAD_REQUEST', false],
    [402, 'BAD_REQUEST', false],
    [404, 'BAD_REQUEST', false],
  ])('HTTP %i becomes %s (retryable=%s)', async (status, kind, retryable) => {
    const { result } = await run(status, errorBody(status));
    expect(kindOf(result)).toMatchObject({
      kind,
      retryable,
      httpStatus: status,
    });
  });

  describe('403 variants', () => {
    const forbidden = (metadata?: Record<string, unknown>) => ({
      error: { code: 403, message: 'blocked', ...(metadata && { metadata }) },
    });

    it.each([
      [
        'moderation (reasons + flagged_input)',
        {
          reasons: ['violence'],
          flagged_input: 'SECRET...',
          provider_name: 'X',
          model_slug: 'y',
        },
      ],
      ['content_policy_violation', { error_type: 'content_policy_violation' }],
      ['provider refusal', { error_type: 'refusal' }],
    ])('maps a %s 403 to a refused response', async (_name, metadata) => {
      const { result } = await run(403, forbidden(metadata));
      expect(result).toMatchObject({
        stopReason: 'refused',
        json: null,
        model: CONFIG.model,
      });
      expect(JSON.stringify(result)).not.toContain('SECRET');
    });

    it('maps a content refusal embedded in a 200 body to refused', async () => {
      const { result } = await run(200, forbidden({ error_type: 'refusal' }));
      expect(result).toMatchObject({ stopReason: 'refused', json: null });
    });

    it.each([
      ['permission_denied', { error_type: 'permission_denied' }],
      ['guardrail block', { patterns: ['ignore all previous instructions'] }],
      ['no metadata', undefined],
    ])('keeps a %s 403 as AUTH', async (_name, metadata) => {
      const { result } = await run(403, forbidden(metadata));
      expect(kindOf(result)).toMatchObject({
        kind: 'AUTH',
        retryable: false,
        httpStatus: 403,
      });
    });
  });

  it('reads retry-after on a 429', async () => {
    const { result } = await run(429, errorBody(429), {
      headers: { 'retry-after': '7' },
    });
    expect(kindOf(result).retryAfterMs).toBe(7000);
  });

  it('never retries inside the SDK', async () => {
    const { calls } = await run(500, errorBody(500));
    expect(calls).toHaveLength(1);
  });

  it('maps an error object inside a 200 response like an HTTP status', async () => {
    const { result } = await run(200, errorBody(429));
    expect(kindOf(result)).toMatchObject({
      kind: 'RATE_LIMITED',
      retryable: true,
      httpStatus: 429,
    });
  });

  it('maps a choice with finish_reason "error" using its embedded code', async () => {
    const body = completion(null, { finish_reason: 'error' });
    (body.choices[0] as Record<string, unknown>).error = {
      code: 503,
      message: 'x',
    };
    const { result } = await run(200, body);
    expect(kindOf(result)).toMatchObject({
      kind: 'SERVER_ERROR',
      httpStatus: 503,
    });
  });

  it('treats empty choices as a retryable server error', async () => {
    const { result } = await run(200, { id: 'gen-1', choices: [] });
    expect(kindOf(result)).toMatchObject({
      kind: 'SERVER_ERROR',
      retryable: true,
      httpStatus: 502,
    });
  });

  it('maps a connection failure to NETWORK', async () => {
    const client = new OpenAiCompatibleLlmClient(CONFIG, () =>
      Promise.reject(new TypeError('fetch failed')),
    );
    const result = await client
      .generateStructured(REQUEST)
      .catch((e: unknown) => e);
    expect(kindOf(result)).toMatchObject({ kind: 'NETWORK', retryable: true });
  });

  it('enforces timeoutMs and maps it to TIMEOUT', async () => {
    const hang = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      })) as typeof fetch;
    const client = new OpenAiCompatibleLlmClient(CONFIG, hang);
    const started = Date.now();
    const result = await client
      .generateStructured({ ...REQUEST, timeoutMs: 50 })
      .catch((e: unknown) => e);
    expect(kindOf(result)).toMatchObject({ kind: 'TIMEOUT', retryable: true });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('extractJson', () => {
  it.each([
    ['plain JSON', '{"a":1}', { a: 1 }],
    ['fenced JSON', 'Here you go:\n```json\n{"a":1}\n```', { a: 1 }],
    [
      'prose around the object',
      'Result: {"a":{"b":"}"}} done',
      { a: { b: '}' } },
    ],
    [
      'a brace in prose before the object',
      'Use {braces} carefully. {"a":1}',
      { a: 1 },
    ],
    [
      'an inline think block containing braces',
      '<think>maybe {"a":2}?</think>{"a":1}',
      { a: 1 },
    ],
    ['an unclosed think block', '<think>still thinking {"a":2}', null],
    ['prose only', 'I cannot classify this.', null],
    ['empty', '', null],
    ['an unbalanced object', '{"a":1', null],
  ])('handles %s', (_name, input, expected) => {
    expect(extractJson(input)).toEqual(expected);
  });
});

describe('toProviderSchema', () => {
  it('drops unsupported keywords but keeps properties that share a keyword name', () => {
    const schema = {
      $schema: 'x',
      type: 'object',
      properties: {
        format: { type: 'string', minLength: 1, format: 'email' },
        items: {
          type: 'array',
          maxItems: 3,
          items: { type: 'number', minimum: 0 },
        },
      },
      required: ['format', 'items'],
      additionalProperties: false,
    };
    expect(toProviderSchema(schema)).toEqual({
      type: 'object',
      properties: {
        format: { type: 'string' },
        items: { type: 'array', items: { type: 'number' } },
      },
      required: ['format', 'items'],
      additionalProperties: false,
    });
  });
});

describe('parseRetryAfter', () => {
  it.each([
    [{ 'retry-after-ms': '1500' }, 1500],
    [{ 'retry-after': '3' }, 3000],
    [{ 'retry-after': 'garbage' }, undefined],
    [{}, undefined],
  ])('parses %j', (headers, expected) => {
    expect(parseRetryAfter(new Headers(headers))).toBe(expected);
  });

  it('parses an HTTP-date in the future', () => {
    const date = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfter(new Headers({ 'retry-after': date }));
    expect(ms).toBeGreaterThan(8_000);
    expect(ms).toBeLessThanOrEqual(10_000);
  });
});
