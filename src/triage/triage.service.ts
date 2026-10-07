import type { Env } from '../config/env.js';
import type {
  LlmCallKind,
  LlmCallOutcome,
  ReviewReason,
} from '../generated/prisma/enums.js';
import type { LlmClient, LlmResponse } from '../llm/llm-client.interface.js';
import { LlmTransportError } from '../llm/llm.errors.js';
import { checkGrounding } from './grounding.js';
import {
  buildRepairMessage,
  buildUserMessage,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
} from './triage.prompt.js';
import {
  TRIAGE_JSON_SCHEMA,
  TRIAGE_SCHEMA_NAME,
  TriageSchema,
  type Triage,
} from './triage.schema.js';

export type TriageDecision =
  | { status: 'COMPLETED'; result: Triage }
  | {
      status: 'NEEDS_HUMAN_REVIEW';
      reviewReason: ReviewReason;
      result: Triage | null;
    };

/** One LLM call, in llm_calls terms. The caller adds inquiryId and jobAttempt. Never holds inquiry text. */
export interface TriageCallRecord {
  kind: LlmCallKind;
  outcome: LlmCallOutcome;
  provider: string;
  model: string;
  promptVersion: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  httpStatus?: number;
  errorCode?: string;
}

export type RecordCall = (call: TriageCallRecord) => Promise<void>;

export interface TriageConfig {
  confidenceThreshold: number;
  maxOutputTokens: number;
  timeoutMs: number;
  temperature?: number;
  /** Used on rows for calls that failed before a response named the provider/model. */
  provider: string;
  model: string;
}

export function triageConfigFromEnv(env: Env): TriageConfig {
  return {
    confidenceThreshold: env.TRIAGE_CONFIDENCE_THRESHOLD,
    maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
    timeoutMs: env.LLM_TIMEOUT_MS,
    temperature: env.LLM_TEMPERATURE,
    provider: env.LLM_PROVIDER,
    model: env.LLM_MODEL ?? 'fake-keyword-v1',
  };
}

/** What a single response turned out to be, after stop-reason, schema and grounding checks. */
type Evaluation =
  | { kind: 'refused' }
  | { kind: 'invalid'; truncated: boolean; problems: string[] }
  | { kind: 'ungrounded'; problems: string[] }
  | { kind: 'ok'; triage: Triage };

const MAX_LISTED_PROBLEMS = 10;

/**
 * Takes inquiry text, returns a decision. Knows nothing about queues or HTTP, so it can be
 * driven by the worker, the eval script and unit tests alike. Throws only LlmTransportError
 * (after recording the failed call) or whatever `recordCall` throws.
 */
export class TriageService {
  constructor(
    private readonly llm: LlmClient,
    private readonly config: TriageConfig,
  ) {}

  async run(rawText: string, recordCall: RecordCall): Promise<TriageDecision> {
    const first = await this.call('INITIAL', rawText, recordCall);
    if (first.kind === 'refused') return review('MODEL_REFUSED', null);
    if (first.kind === 'ok') return this.decide(first.triage);

    // At most one repair, shared by schema and grounding failures: bounded cost and latency.
    const second = await this.call(
      'REPAIR',
      rawText,
      recordCall,
      buildRepairMessage(first.problems.slice(0, MAX_LISTED_PROBLEMS)),
    );
    switch (second.kind) {
      case 'refused':
        return review('MODEL_REFUSED', null);
      case 'invalid':
        return review('INVALID_OUTPUT', null);
      case 'ungrounded':
        return review('UNGROUNDED_EVIDENCE', null);
      case 'ok':
        return this.decide(second.triage);
    }
  }

  private async call(
    kind: LlmCallKind,
    rawText: string,
    recordCall: RecordCall,
    followUp?: string,
  ): Promise<Evaluation> {
    const started = performance.now();
    let response: LlmResponse;
    try {
      response = await this.llm.generateStructured({
        system: SYSTEM_PROMPT,
        user: buildUserMessage(rawText),
        followUp,
        schemaName: TRIAGE_SCHEMA_NAME,
        jsonSchema: TRIAGE_JSON_SCHEMA,
        maxOutputTokens: this.config.maxOutputTokens,
        temperature: this.config.temperature,
        timeoutMs: this.config.timeoutMs,
      });
    } catch (err) {
      if (err instanceof LlmTransportError) {
        await recordCall({
          kind,
          outcome: transportOutcome(err),
          provider: this.config.provider,
          model: this.config.model,
          promptVersion: PROMPT_VERSION,
          latencyMs: Math.round(performance.now() - started),
          httpStatus: err.httpStatus,
          errorCode: err.kind,
        });
      }
      throw err;
    }

    const evaluation = evaluate(response, rawText);
    await recordCall({
      kind,
      outcome: callOutcome(evaluation),
      provider: response.provider,
      model: response.model,
      promptVersion: PROMPT_VERSION,
      latencyMs: response.latencyMs,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    });
    return evaluation;
  }

  /** §10.3, in order. The validated object is kept in every case. */
  private decide(triage: Triage): TriageDecision {
    if (triage.containsInstructionsToAi) {
      return review('SUSPECTED_INJECTION', triage);
    }
    if (!triage.isLegalInquiry) return { status: 'COMPLETED', result: triage };
    if (
      triage.practiceArea === 'UNCLEAR' ||
      triage.confidence < this.config.confidenceThreshold
    ) {
      return review('LOW_CONFIDENCE', triage);
    }
    return { status: 'COMPLETED', result: triage };
  }
}

function evaluate(response: LlmResponse, rawText: string): Evaluation {
  if (response.stopReason === 'refused') return { kind: 'refused' };
  if (response.stopReason === 'truncated') {
    return {
      kind: 'invalid',
      truncated: true,
      problems: [
        'The response was cut off by the output token limit. Return a complete, shorter object.',
      ],
    };
  }
  // 'complete' and 'other' both go through the normal checks.
  if (response.json === null) {
    return {
      kind: 'invalid',
      truncated: false,
      problems: ['The response was not a valid JSON object.'],
    };
  }
  const parsed = TriageSchema.safeParse(response.json);
  if (!parsed.success) {
    return {
      kind: 'invalid',
      truncated: false,
      problems: parsed.error.issues.map(
        (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
      ),
    };
  }
  const problems = checkGrounding(parsed.data, rawText);
  return problems.length > 0
    ? { kind: 'ungrounded', problems }
    : { kind: 'ok', triage: parsed.data };
}

function callOutcome(evaluation: Evaluation): LlmCallOutcome {
  switch (evaluation.kind) {
    case 'refused':
      return 'REFUSED';
    case 'invalid':
      return evaluation.truncated ? 'TRUNCATED' : 'SCHEMA_INVALID';
    case 'ungrounded':
      return 'UNGROUNDED';
    case 'ok':
      return 'OK';
  }
}

function transportOutcome(err: LlmTransportError): LlmCallOutcome {
  switch (err.kind) {
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'RATE_LIMITED':
      return 'RATE_LIMITED';
    case 'SERVER_ERROR':
    case 'NETWORK':
      return 'PROVIDER_ERROR';
    case 'AUTH':
    case 'BAD_REQUEST':
      return 'NON_RETRYABLE_ERROR';
  }
}

function review(
  reviewReason: ReviewReason,
  result: Triage | null,
): TriageDecision {
  return { status: 'NEEDS_HUMAN_REVIEW', reviewReason, result };
}
