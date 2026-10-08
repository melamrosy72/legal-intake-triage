import { z } from 'zod';
import { LlmTransportError } from '../src/llm/llm.errors.js';
import { computeBackoffMs } from '../src/triage/backoff.js';
import { PRACTICE_AREAS } from '../src/triage/triage.schema.js';
import type {
  TriageCallRecord,
  TriageDecision,
} from '../src/triage/triage.service.js';

export const EvalCaseSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  expected: z.object({
    isLegalInquiry: z.boolean(),
    // A list when more than one answer is defensible (e.g. two issues in one message).
    practiceArea: z.union([
      z.enum(PRACTICE_AREAS),
      z.array(z.enum(PRACTICE_AREAS)).min(2),
    ]),
    urgency: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    expectReview: z.boolean().optional(),
  }),
  note: z.string().optional(),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

/** Every practice area that counts as correct for a case. */
export function acceptedAreas(expected: EvalCase['expected']): string[] {
  return Array.isArray(expected.practiceArea)
    ? expected.practiceArea
    : [expected.practiceArea];
}

const areaCorrect = (l: ScoredLine) =>
  l.actual.practiceArea !== null &&
  acceptedAreas(l.expected).includes(l.actual.practiceArea);

export function parseDataset(jsonl: string): EvalCase[] {
  const cases = jsonl
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => EvalCaseSchema.parse(JSON.parse(line)));
  const ids = new Set(cases.map((c) => c.id));
  if (ids.size !== cases.length) throw new Error('duplicate case ids');
  return cases;
}

/** Settings that must not change within one run, or its numbers would mix two setups. */
export interface RunMeta {
  type: 'meta';
  startedAt: string;
  provider: string;
  model: string;
  promptVersion: string;
  structuredMode: string;
  reasoningEffort: string | null;
  maxOutputTokens: number;
}

export interface ScoredLine {
  type: 'case';
  id: string;
  scored: true;
  expected: EvalCase['expected'];
  actual: {
    status: TriageDecision['status'];
    reviewReason: string | null;
    isLegalInquiry: boolean | null;
    practiceArea: string | null;
    urgency: string | null;
    confidence: number | null;
  };
  calls: Array<Omit<TriageCallRecord, 'promptVersion'>>;
  latencyMs: number;
  requests: number;
  retries: number;
  finishedAt: string;
}

export interface NotScoredLine {
  type: 'case';
  id: string;
  scored: false;
  error: {
    errorClass: string;
    kind?: string;
    httpStatus?: number;
    retryAfterMs?: number;
  };
  requests: number;
  retries: number;
  finishedAt: string;
}

export type RunLine = RunMeta | ScoredLine | NotScoredLine;

export function parseRunFile(jsonl: string): {
  meta: RunMeta | undefined;
  lines: Array<ScoredLine | NotScoredLine>;
} {
  const all = jsonl
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RunLine);
  return {
    meta: all.find((l): l is RunMeta => l.type === 'meta'),
    lines: all.filter(
      (l): l is ScoredLine | NotScoredLine => l.type === 'case',
    ),
  };
}

/** The latest scored line per case id (a resumed run may append a case again). */
export function scoredById(
  lines: Array<ScoredLine | NotScoredLine>,
): Map<string, ScoredLine> {
  const map = new Map<string, ScoredLine>();
  for (const line of lines) if (line.scored) map.set(line.id, line);
  return map;
}

export function toActual(decision: TriageDecision): ScoredLine['actual'] {
  const r = decision.result;
  return {
    status: decision.status,
    reviewReason:
      decision.status === 'NEEDS_HUMAN_REVIEW' ? decision.reviewReason : null,
    isLegalInquiry: r?.isLegalInquiry ?? null,
    practiceArea: r?.practiceArea ?? null,
    urgency: r?.urgency ?? null,
    confidence: r?.confidence ?? null,
  };
}

/**
 * Retries a whole case on retryable transport errors, honouring Retry-After through
 * computeBackoffMs. A Retry-After beyond what we would wait (e.g. a daily cap) is not retried:
 * it won't clear within this run, and retrying would only spend more of the quota.
 */
export async function withTransportRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxRetries: number;
    maxWaitMs: number;
    sleep: (ms: number) => Promise<void>;
    onRetry?: (retry: number, delayMs: number, err: LlmTransportError) => void;
  },
): Promise<
  | { ok: true; value: T; retries: number }
  | { ok: false; error: unknown; retries: number }
> {
  for (let retries = 0; ; retries++) {
    try {
      return { ok: true, value: await fn(), retries };
    } catch (error) {
      const canRetry =
        error instanceof LlmTransportError &&
        error.retryable &&
        retries < opts.maxRetries &&
        (error.retryAfterMs === undefined ||
          error.retryAfterMs <= opts.maxWaitMs);
      if (!canRetry) return { ok: false, error, retries };
      const err = error;
      const delay = computeBackoffMs(retries + 1, err);
      opts.onRetry?.(retries + 1, delay, err);
      await opts.sleep(delay);
    }
  }
}

export interface Metrics {
  cases: number;
  practiceArea: { correct: number; total: number };
  urgency: { correct: number; total: number };
  isLegalInquiry: { correct: number; total: number };
  reviewMatch: { correct: number; total: number };
  routedToReview: number;
  neededRepair: number;
  failedAfterRepair: number;
  reviewReasons: Record<string, number>;
  latencyMs: { avg: number; p95: number };
  tokens: { input: number; output: number };
  requests: number;
  models: string[];
}

const pct = (part: number, whole: number) =>
  whole === 0 ? 'n/a' : `${((100 * part) / whole).toFixed(0)}%`;

/** Nearest-rank p95. */
function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1] ?? 0;
}

/**
 * Scores the latest scored line per case. Area and urgency are scored only for cases expected
 * to be legal inquiries (spam has no meaningful area). Output that never validated counts as
 * wrong on both.
 */
export function computeMetrics(
  caseLines: Array<ScoredLine | NotScoredLine>,
): Metrics {
  const lines = [...scoredById(caseLines).values()];
  const legal = lines.filter((l) => l.expected.isLegalInquiry);
  const count = (xs: ScoredLine[], ok: (l: ScoredLine) => boolean) =>
    xs.filter(ok).length;
  const reviewReasons: Record<string, number> = {};
  for (const l of lines) {
    if (l.actual.reviewReason) {
      reviewReasons[l.actual.reviewReason] =
        (reviewReasons[l.actual.reviewReason] ?? 0) + 1;
    }
  }
  const allCalls = lines.flatMap((l) => l.calls);
  const latencies = lines.map((l) => l.latencyMs);
  return {
    cases: lines.length,
    practiceArea: {
      correct: count(legal, areaCorrect),
      total: legal.length,
    },
    urgency: {
      correct: count(legal, (l) => l.actual.urgency === l.expected.urgency),
      total: legal.length,
    },
    isLegalInquiry: {
      correct: count(
        lines,
        (l) => l.actual.isLegalInquiry === l.expected.isLegalInquiry,
      ),
      total: lines.length,
    },
    reviewMatch: {
      correct: count(
        lines,
        (l) =>
          (l.actual.status === 'NEEDS_HUMAN_REVIEW') ===
          (l.expected.expectReview ?? false),
      ),
      total: lines.length,
    },
    routedToReview: count(
      lines,
      (l) => l.actual.status === 'NEEDS_HUMAN_REVIEW',
    ),
    neededRepair: count(lines, (l) => l.calls.some((c) => c.kind === 'REPAIR')),
    failedAfterRepair: count(lines, (l) =>
      ['INVALID_OUTPUT', 'UNGROUNDED_EVIDENCE'].includes(
        l.actual.reviewReason ?? '',
      ),
    ),
    reviewReasons,
    latencyMs: {
      avg: latencies.length
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : 0,
      p95: p95(latencies),
    },
    tokens: {
      input: allCalls.reduce((a, c) => a + (c.inputTokens ?? 0), 0),
      output: allCalls.reduce((a, c) => a + (c.outputTokens ?? 0), 0),
    },
    // Every request spent, including retries and cases that ended "not scored".
    requests: caseLines.reduce((a, l) => a + l.requests, 0),
    models: [...new Set(allCalls.map((c) => c.model))].sort(),
  };
}

export function renderResults(
  meta: RunMeta,
  m: Metrics,
  lines: ScoredLine[],
): string {
  const rate = (x: { correct: number; total: number }) =>
    `${pct(x.correct, x.total)} (${x.correct}/${x.total})`;
  const reasons =
    Object.entries(m.reviewReasons)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ') || 'none';
  const rows = lines.map((l) => {
    const mark = (ok: boolean) => (ok ? 'ok' : '**x**');
    const area = l.expected.isLegalInquiry
      ? `${acceptedAreas(l.expected).join(' or ')} / ${l.actual.practiceArea ?? '-'} ${mark(areaCorrect(l))}`
      : 'not scored';
    const urgency = l.expected.isLegalInquiry
      ? `${l.expected.urgency} / ${l.actual.urgency ?? '-'} ${mark(l.actual.urgency === l.expected.urgency)}`
      : 'not scored';
    const status = `${l.actual.status}${l.actual.reviewReason ? ` (${l.actual.reviewReason})` : ''}`;
    const calls = l.calls.map((c) => `${c.kind}:${c.outcome}`).join(', ');
    return `| ${l.id} | ${area} | ${urgency} | ${status} | ${calls} | ${l.latencyMs} |`;
  });
  return [
    '# Evaluation results',
    '',
    `Model: \`${m.models.join(', ') || meta.model}\` via ${meta.provider} · prompt \`${meta.promptVersion}\` · structured mode \`${meta.structuredMode}\` · reasoning effort \`${meta.reasoningEffort ?? 'unset'}\` · max output tokens ${meta.maxOutputTokens} · run started ${meta.startedAt}`,
    '',
    `> ${m.cases} synthetic cases. This is a smoke test, not a statistically meaningful benchmark: one case is ${pct(1, m.cases)} of any rate below.`,
    '',
    ...multiAreaNote(lines),
    '| Metric | Value |',
    '|---|---|',
    `| Practice-area accuracy (legal inquiries) | ${rate(m.practiceArea)} |`,
    `| Urgency accuracy (legal inquiries) | ${rate(m.urgency)} |`,
    `| isLegalInquiry accuracy | ${rate(m.isLegalInquiry)} |`,
    `| Review routing matched expectation | ${rate(m.reviewMatch)} |`,
    `| Routed to human review | ${pct(m.routedToReview, m.cases)} (${m.routedToReview}/${m.cases}): ${reasons} |`,
    `| Needed a repair call | ${pct(m.neededRepair, m.cases)} (${m.neededRepair}/${m.cases}) |`,
    `| Schema or grounding failure after repair | ${m.failedAfterRepair} |`,
    `| Latency per case, avg / p95 | ${m.latencyMs.avg} ms / ${m.latencyMs.p95} ms |`,
    `| Tokens, input / output (output includes reasoning) | ${m.tokens.input} / ${m.tokens.output} |`,
    `| Real requests used | ${m.requests} |`,
    '',
    '## Per case (expected / actual)',
    '',
    '| Case | Practice area | Urgency | Final status | Calls | Latency ms |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

/** Discloses cases scored against more than one acceptable practice area. */
function multiAreaNote(lines: ScoredLine[]): string[] {
  const multi = lines.filter((l) => acceptedAreas(l.expected).length > 1);
  if (multi.length === 0) return [];
  return [
    `Practice area is scored correct for ${multi
      .map((l) => `${l.id} if it is ${acceptedAreas(l.expected).join(' or ')}`)
      .join(
        '; ',
      )} (more than one issue in the message, so more than one answer is defensible).`,
    '',
  ];
}
