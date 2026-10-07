import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from 'openai';
import type { Env } from '../config/env.js';
import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  StopReason,
} from './llm-client.interface.js';
import { LlmTransportError } from './llm.errors.js';

export interface OpenAiCompatibleConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  structuredMode: Env['LLM_STRUCTURED_MODE'];
  reasoningEffort?: Env['LLM_REASONING_EFFORT'];
}

/** The parts of an OpenRouter chat completion we read. OpenRouter adds `provider` and `error`. */
interface CompletionBody {
  model?: string;
  provider?: string;
  error?: { code?: unknown };
  choices?: Array<{
    finish_reason?: string | null;
    error?: { code?: unknown };
    message?: { content?: string | null; refusal?: string | null };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Chat Completions adapter for OpenRouter (or any OpenAI-compatible endpoint via LLM_BASE_URL).
 * Never reads `message.reasoning`: reasoning text must not reach the parsed JSON or the logs.
 */
export class OpenAiCompatibleLlmClient implements LlmClient {
  private readonly client: OpenAI;
  private readonly isOpenRouter: boolean;

  /** `fetch` is injectable so tests can drive the real SDK with fake HTTP responses. */
  constructor(
    private readonly config: OpenAiCompatibleConfig,
    fetchImpl?: typeof fetch,
  ) {
    // Retries are owned by the queue (one policy, one place to observe it), so the SDK never retries.
    this.client = new OpenAI({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      maxRetries: 0,
      fetch: fetchImpl,
    });
    this.isOpenRouter = new URL(config.baseURL).hostname.endsWith(
      'openrouter.ai',
    );
  }

  async generateStructured(req: LlmRequest): Promise<LlmResponse> {
    const started = performance.now();
    let body: CompletionBody;
    try {
      body = await this.client.chat.completions.create(
        this.buildBody(
          req,
        ) as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
        { timeout: req.timeoutMs, maxRetries: 0 },
      );
    } catch (err) {
      throw toTransportError(err);
    }
    const latencyMs = Math.round(performance.now() - started);

    // OpenRouter can report an upstream failure inside a 200 response.
    if (body.error)
      throw LlmTransportError.fromStatus(toStatus(body.error.code));
    const choice = body.choices?.[0];
    if (!choice) throw LlmTransportError.fromStatus(502);
    if (choice.error || choice.finish_reason === 'error') {
      throw LlmTransportError.fromStatus(toStatus(choice.error?.code));
    }

    const stopReason: StopReason = choice.message?.refusal
      ? 'refused'
      : mapFinishReason(choice.finish_reason);
    return {
      json:
        stopReason === 'refused'
          ? null
          : extractJson(choice.message?.content ?? ''),
      stopReason,
      usage: {
        inputTokens: body.usage?.prompt_tokens,
        // Includes reasoning tokens: they are billed and count against max_tokens.
        outputTokens: body.usage?.completion_tokens,
      },
      provider: this.isOpenRouter
        ? `openrouter${body.provider ? `/${body.provider}` : ''}`
        : 'openai-compatible',
      model: body.model ?? this.config.model, // the model actually used, not only the one requested
      latencyMs,
    };
  }

  private buildBody(req: LlmRequest): Record<string, unknown> {
    const jsonObjectMode = this.config.structuredMode === 'json_object';
    const system = jsonObjectMode
      ? `${req.system}\n\nRespond with only a JSON object that matches this JSON Schema:\n${JSON.stringify(req.jsonSchema)}`
      : req.system;
    return {
      model: this.config.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: req.user },
        ...(req.followUp ? [{ role: 'user', content: req.followUp }] : []),
      ],
      max_tokens: req.maxOutputTokens,
      ...(req.temperature !== undefined && { temperature: req.temperature }),
      response_format: jsonObjectMode
        ? { type: 'json_object' }
        : {
            type: 'json_schema',
            json_schema: {
              name: req.schemaName,
              strict: true,
              schema: toProviderSchema(req.jsonSchema),
            },
          },
      ...(this.isOpenRouter && {
        // Route only to endpoints that support every parameter we send (incl. response_format).
        provider: { require_parameters: true },
        ...(this.config.reasoningEffort && {
          // exclude: reasoning still happens (and is billed) but its text is not returned.
          reasoning: { effort: this.config.reasoningEffort, exclude: true },
        }),
      }),
    };
  }
}

function mapFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'stop':
      return 'complete';
    case 'length':
      return 'truncated';
    case 'content_filter':
      return 'refused';
    default:
      return 'other';
  }
}

function toTransportError(err: unknown): unknown {
  if (err instanceof APIConnectionTimeoutError) {
    return new LlmTransportError('TIMEOUT', true);
  }
  if (err instanceof APIConnectionError) {
    return new LlmTransportError('NETWORK', true);
  }
  if (err instanceof APIError && typeof err.status === 'number') {
    return LlmTransportError.fromStatus(
      err.status,
      parseRetryAfter(err.headers as Headers | undefined),
    );
  }
  return err; // not a transport failure (a bug); let it surface unchanged
}

/** Embedded error codes are usually HTTP statuses; anything unrecognised is treated as a 502. */
function toStatus(code: unknown): number {
  const n = typeof code === 'string' ? Number(code) : code;
  return typeof n === 'number' && Number.isInteger(n) && n >= 400 && n < 600
    ? n
    : 502;
}

export function parseRetryAfter(
  headers: Headers | undefined,
): number | undefined {
  const ms = Number(headers?.get('retry-after-ms') ?? NaN);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const value = headers?.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  const result = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - Date.now(); // HTTP-date form
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

/**
 * Parses model text into JSON. Handles prose or ```json fences around the object and drops any
 * inline <think> block, so reasoning text can never become part of the result. Null if nothing parses.
 */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').trim();
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through to scanning for an embedded object
  }
  for (
    let start = cleaned.indexOf('{');
    start !== -1;
    start = cleaned.indexOf('{', start + 1)
  ) {
    const end = matchingBrace(cleaned, start);
    if (end === -1) continue;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      // try the next '{'
    }
  }
  return null;
}

/** Index of the `}` closing the `{` at `start`, ignoring braces inside strings; -1 if unbalanced. */
function matchingBrace(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

const UNSUPPORTED_KEYWORDS = new Set([
  '$schema',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
  'pattern',
  'format',
]);

/**
 * Removes keywords that some strict-mode providers reject with a 400 (which would turn every
 * inquiry into PROVIDER_FAILURE). The local Zod parse still enforces all of them.
 */
export function toProviderSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toProviderSchema);
  if (typeof schema !== 'object' || schema === null) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    // Under `properties`/`$defs` the keys are names, not keywords: keep every name.
    out[key] =
      (key === 'properties' || key === '$defs') &&
      typeof value === 'object' &&
      value !== null
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(
              ([name, sub]) => [name, toProviderSchema(sub)],
            ),
          )
        : toProviderSchema(value);
  }
  return out;
}
