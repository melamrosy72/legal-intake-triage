import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Worker } from 'bullmq';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { useSafeBodyParsers } from '../src/common/body-parser.js';
import { ENV, parseEnv } from '../src/config/env.js';
import { FakeLlmClient, keywordTriage } from '../src/llm/fake-llm.client.js';
import {
  LLM_CLIENT,
  type LlmClient,
  type LlmRequest,
} from '../src/llm/llm-client.interface.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TriageProcessor } from '../src/triage/triage.processor.js';
import { TriageQueue } from '../src/triage/triage.queue.js';

/** Lets each test swap the LLM behind the running app. Defaults to the keyword fake. */
export class SwitchableLlm implements LlmClient {
  impl: LlmClient = new FakeLlmClient(keywordTriage);
  generateStructured(req: LlmRequest) {
    return this.impl.generateStructured(req);
  }
}

/**
 * The full app (API + worker), set up like main.ts, with the LLM replaced. No network calls.
 * `env` overrides single variables, e.g. to point the app at a database that is down.
 */
export async function createTestApp(env: Record<string, string> = {}) {
  const llm = new SwitchableLlm();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LLM_CLIENT)
    .useValue(llm)
    .overrideProvider(ENV)
    .useValue(parseEnv({ ...process.env, ...env }))
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });
  useSafeBodyParsers(app);
  await app.init();
  const prisma = app.get(PrismaService);
  const queue = app.get(TriageQueue).queue;
  // The worker is private to the processor; tests need it to pause it.
  const processor: unknown = app.get(TriageProcessor);
  const { worker } = processor as { worker: Worker };
  return {
    app,
    worker,
    llm,
    prisma,
    queue,
    /** Empties the tables and the queue so each test starts clean. */
    async reset() {
      llm.impl = new FakeLlmClient(keywordTriage);
      await queue.obliterate({ force: true });
      await prisma.$executeRawUnsafe('TRUNCATE llm_calls, inquiries');
    },
  };
}
