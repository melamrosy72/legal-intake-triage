import { Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { LLM_CLIENT, type LlmClient } from '../llm/llm-client.interface.js';
import { LlmModule } from '../llm/llm.module.js';
import { TriageProcessor } from './triage.processor.js';
import { TriageQueue } from './triage.queue.js';
import { TriageService, triageConfigFromEnv } from './triage.service.js';

@Module({
  imports: [LlmModule],
  providers: [
    {
      // A plain class built by a factory, so the eval script can construct it without Nest.
      provide: TriageService,
      inject: [LLM_CLIENT, ENV],
      useFactory: (llm: LlmClient, env: Env) =>
        new TriageService(llm, triageConfigFromEnv(env)),
    },
    TriageQueue,
    TriageProcessor, // the worker runs in the API process (demo trade-off, see README)
  ],
  exports: [TriageQueue],
})
export class TriageModule {}
