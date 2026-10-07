/** Injection token for the configured LlmClient. */
export const LLM_CLIENT = Symbol('LLM_CLIENT');

export interface LlmClient {
  generateStructured(req: LlmRequest): Promise<LlmResponse>;
}

export interface LlmRequest {
  system: string;
  user: string;
  /** Extra user turns after `user`, e.g. the repair message listing what was rejected. */
  followUp?: string;
  schemaName: string;
  jsonSchema: Record<string, unknown>; // generated from the Zod schema
  maxOutputTokens: number;
  temperature?: number;
  timeoutMs: number;
}

export type StopReason = 'complete' | 'truncated' | 'refused' | 'other';

export interface LlmResponse {
  json: unknown; // parsed structured output, null if it could not be parsed
  stopReason: StopReason;
  usage: { inputTokens?: number; outputTokens?: number };
  provider: string;
  model: string;
  latencyMs: number;
}
