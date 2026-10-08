/**
 * Runs the evaluation set through TriageService against the configured provider (no queue).
 *
 *   npm run eval                      new run → eval/runs/<timestamp>.jsonl
 *   npm run eval -- --resume          continue the latest run, skipping cases already scored
 *   npm run eval -- --resume --run eval/runs/<file>.jsonl
 *
 * Each case is appended to the run file as soon as it finishes, so an interrupted or stopped
 * run loses nothing. eval/results.md is written once every case is scored.
 * Prints ids and labels only, never inquiry text.
 */
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { describeError } from '../src/common/safe-exception.filter.js';
import { loadDotEnv, parseEnv } from '../src/config/env.js';
import type { LlmClient, LlmRequest } from '../src/llm/llm-client.interface.js';
import { LlmTransportError } from '../src/llm/llm.errors.js';
import { configuredModel, createLlmClient } from '../src/llm/llm.module.js';
import { PROMPT_VERSION } from '../src/triage/triage.prompt.js';
import {
  TriageService,
  triageConfigFromEnv,
  type TriageCallRecord,
} from '../src/triage/triage.service.js';
import {
  acceptedAreas,
  computeMetrics,
  parseDataset,
  parseRunFile,
  renderResults,
  scoredById,
  toActual,
  withTransportRetry,
  type NotScoredLine,
  type RunLine,
  type RunMeta,
  type ScoredLine,
} from './eval-lib.js';

const DATASET = 'eval/dataset.jsonl';
const RUNS_DIR = 'eval/runs';
const RESULTS = 'eval/results.md';
const MAX_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 60_000;

const { values: args } = parseArgs({
  options: { resume: { type: 'boolean' }, run: { type: 'string' } },
});

loadDotEnv();
const env = parseEnv();
const cases = parseDataset(readFileSync(DATASET, 'utf8'));
mkdirSync(RUNS_DIR, { recursive: true });

const meta: RunMeta = {
  type: 'meta',
  startedAt: new Date().toISOString(),
  provider: env.LLM_PROVIDER,
  model: configuredModel(env),
  promptVersion: PROMPT_VERSION,
  structuredMode: env.LLM_STRUCTURED_MODE,
  reasoningEffort: env.LLM_REASONING_EFFORT ?? null,
  maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
};
const SAME_SETUP: Array<keyof RunMeta> = [
  'provider',
  'model',
  'promptVersion',
  'structuredMode',
  'reasoningEffort',
  'maxOutputTokens',
];

let runPath: string;
let runMeta = meta;
let alreadyScored = new Set<string>();
if (args.resume) {
  const latest = readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .at(-1);
  const chosen = args.run ?? (latest && `${RUNS_DIR}/${latest}`);
  if (!chosen) throw new Error(`--resume: no run file in ${RUNS_DIR}`);
  runPath = chosen;
  const previous = parseRunFile(readFileSync(runPath, 'utf8'));
  if (!previous.meta) throw new Error(`${runPath} has no meta line`);
  const changed = SAME_SETUP.filter((k) => previous.meta![k] !== meta[k]);
  if (changed.length > 0) {
    throw new Error(
      `Refusing to resume ${runPath}: ${changed.join(', ')} changed since that run. Start a new run instead.`,
    );
  }
  runMeta = previous.meta;
  alreadyScored = new Set(scoredById(previous.lines).keys());
} else {
  runPath = `${RUNS_DIR}/${meta.startedAt.replace(/[:.]/g, '-')}.jsonl`;
  writeFileSync(runPath, `${JSON.stringify(meta)}\n`);
}
const append = (line: RunLine) =>
  appendFileSync(runPath, `${JSON.stringify(line)}\n`);

/** Counts every request that actually goes to the provider, retries included. */
class CountingLlm implements LlmClient {
  requests = 0;
  constructor(private readonly inner: LlmClient) {}
  generateStructured(req: LlmRequest) {
    this.requests++;
    return this.inner.generateStructured(req);
  }
}
const llm = new CountingLlm(createLlmClient(env));
const triage = new TriageService(llm, triageConfigFromEnv(env));

const todo = cases.filter((c) => !alreadyScored.has(c.id));
console.log(
  `provider=${meta.provider} model=${meta.model} prompt=${meta.promptVersion} delay=${env.EVAL_DELAY_MS}ms`,
);
console.log(
  `run file: ${runPath}\n${todo.length} case(s) to run, ${alreadyScored.size} already scored\n`,
);

let stopped = false;
for (const [i, c] of todo.entries()) {
  if (i > 0) await sleep(env.EVAL_DELAY_MS);
  const requestsBefore = llm.requests;
  let calls: TriageCallRecord[] = [];
  let latencyMs = 0;
  const outcome = await withTransportRetry(
    async () => {
      calls = [];
      const started = performance.now();
      const decision = await triage.run(c.text, (call) => {
        calls.push(call);
        return Promise.resolve();
      });
      latencyMs = Math.round(performance.now() - started);
      return decision;
    },
    {
      maxRetries: MAX_RETRIES,
      maxWaitMs: MAX_RETRY_WAIT_MS,
      sleep: (ms) => sleep(ms),
      onRetry: (retry, delayMs, err) =>
        console.log(
          `  ${c.id} ${err.kind}${err.httpStatus ? ` ${err.httpStatus}` : ''}, retry ${retry}/${MAX_RETRIES} in ${Math.round(delayMs / 1000)}s`,
        ),
    },
  );
  const requests = llm.requests - requestsBefore;
  const finishedAt = new Date().toISOString();

  if (outcome.ok) {
    const line: ScoredLine = {
      type: 'case',
      id: c.id,
      scored: true,
      expected: c.expected,
      actual: toActual(outcome.value),
      calls: calls.map(({ promptVersion: _, ...rest }) => rest),
      latencyMs,
      requests,
      retries: outcome.retries,
      finishedAt,
    };
    append(line);
    const a = line.actual;
    console.log(
      `${c.id} ${a.status}${a.reviewReason ? `(${a.reviewReason})` : ''} area=${a.practiceArea ?? '-'}/${acceptedAreas(c.expected).join('|')} urgency=${a.urgency ?? '-'}/${c.expected.urgency} calls=${line.calls.map((x) => x.outcome).join('+')} ${latencyMs}ms`,
    );
    continue;
  }

  // Not scored: record why, then stop so a daily cap or bad key can't burn the remaining cases.
  const err = outcome.error;
  const line: NotScoredLine = {
    type: 'case',
    id: c.id,
    scored: false,
    error:
      err instanceof LlmTransportError
        ? {
            errorClass: 'LlmTransportError',
            kind: err.kind,
            httpStatus: err.httpStatus,
            retryAfterMs: err.retryAfterMs,
          }
        : { errorClass: describeError(err).errorClass },
    requests,
    retries: outcome.retries,
    finishedAt,
  };
  append(line);
  console.log(
    `${c.id} NOT SCORED ${JSON.stringify(line.error)} after ${outcome.retries} retr${outcome.retries === 1 ? 'y' : 'ies'}. Stopping.`,
  );
  stopped = true;
  break;
}

const { lines } = parseRunFile(readFileSync(runPath, 'utf8'));
const scored = scoredById(lines);
const metrics = computeMetrics(lines);
console.log(
  `\nRequests used: ${llm.requests} this session, ${metrics.requests} in this run so far.`,
);
const missing = cases.filter((c) => !scored.has(c.id)).map((c) => c.id);
if (missing.length === 0) {
  const ordered = cases.map((c) => scored.get(c.id)!);
  const markdown = renderResults(runMeta, metrics, ordered);
  writeFileSync(RESULTS, markdown);
  console.log(`\n${markdown}\nWrote ${RESULTS}`);
} else {
  console.log(
    `${scored.size}/${cases.length} scored. Not yet scored: ${missing.join(', ')}.\nContinue with: npm run eval -- --resume`,
  );
}
if (stopped) process.exitCode = 1;
