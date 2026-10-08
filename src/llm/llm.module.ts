import { Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { FAKE_MODEL, FakeLlmClient, keywordTriage } from './fake-llm.client.js';
import { LLM_CLIENT, type LlmClient } from './llm-client.interface.js';
import { OpenAiCompatibleLlmClient } from './openai-compatible-llm.client.js';

/** The model the configured client will use (LLM_MODEL is ignored by the fake). */
export function configuredModel(env: Env): string {
  return env.LLM_PROVIDER === 'fake' ? FAKE_MODEL : env.LLM_MODEL!;
}

export function createLlmClient(env: Env): LlmClient {
  if (env.LLM_PROVIDER === 'fake') return new FakeLlmClient(keywordTriage);
  return new OpenAiCompatibleLlmClient({
    baseURL: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY!, // presence enforced by the env schema
    model: env.LLM_MODEL!,
    structuredMode: env.LLM_STRUCTURED_MODE,
    reasoningEffort: env.LLM_REASONING_EFFORT,
  });
}

@Module({
  providers: [
    { provide: LLM_CLIENT, inject: [ENV], useFactory: createLlmClient },
  ],
  exports: [LLM_CLIENT],
})
export class LlmModule {}
