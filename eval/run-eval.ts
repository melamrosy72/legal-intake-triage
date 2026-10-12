/**
 * Runs the evaluation set through TriageService against the configured provider (no queue).
 *
 *   npm run eval                      new run → eval/runs/<timestamp>.jsonl
 *   npm run eval -- --resume          continue the latest run, skipping cases already scored
 *   npm run eval -- --resume --run eval/runs/<file>.jsonl
 *   npm run eval -- --render [--run <file>]   rewrite eval/results.md from a run file, no model calls
 *
 * Each case is appended to the run file as soon as it finishes, so an interrupted or stopped
 * run loses nothing. eval/results.md is written once every case is scored, with
 * eval/analysis.md (hand-written) appended as its Notes section.
 * Prints ids and labels only, never inquiry text.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { loadDotEnv, parseEnv } from '../src/config/env.js';
import type { LlmClient, LlmRequest } from '../src/llm/llm-client.interface.js';
import { configuredModel, createLlmClient } from '../src/llm/llm.module.js';
import { PROMPT_VERSION } from '../src/triage/triage.prompt.js';
import {
  TriageService,
  triageConfigFromEnv,
} from '../src/triage/triage.service.js';
import {
  acceptedAreas,
  computeMetrics,
  parseDataset,
  parseRunFile,
  renderResults,
  runCase,
  scoredById,
  summarizeError,
  toActual,
  type EvalCase,
  type RunLine,
  type RunMeta,
} from './eval-lib.js';

const DATASET = 'eval/dataset.jsonl';
const RUNS_DIR = 'eval/runs';
const RESULTS = 'eval/results.md';
const ANALYSIS = 'eval/analysis.md';
const MAX_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 60_000;

const { values: args } = parseArgs({
  options: {
    resume: { type: 'boolean' },
    render: { type: 'boolean' },
    run: { type: 'string' },
  },
});

const cases = parseDataset(readFileSync(DATASET, 'utf8'));
mkdirSync(RUNS_DIR, { recursive: true });

function latestRunFile(): string {
  const latest = readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .at(-1);
  const chosen = args.run ?? (latest && `${RUNS_DIR}/${latest}`);
  if (!chosen) throw new Error(`no run file in ${RUNS_DIR}`);
  return chosen;
}

/** Writes results.md once every case is scored; otherwise says what is missing. */
function report(runPath: string, all: EvalCase[]): void {
  const { meta, lines } = parseRunFile(readFileSync(runPath, 'utf8'));
  if (!meta) throw new Error(`${runPath} has no meta line`);
  const scored = scoredById(lines);
  const metrics = computeMetrics(lines);
  console.log(`\nRequests used in this run: ${metrics.requests}.`);
  const scoredInOrder = all.flatMap((c) => scored.get(c.id) ?? []);
  const missing = all.filter((c) => !scored.has(c.id)).map((c) => c.id);
  if (missing.length > 0) {
    console.log(
      `${scored.size}/${all.length} scored. Not yet scored: ${missing.join(', ')}.\nContinue with: npm run eval -- --resume`,
    );
    return;
  }
  const analysis = existsSync(ANALYSIS)
    ? readFileSync(ANALYSIS, 'utf8')
    : undefined;
  const markdown = renderResults(meta, metrics, scoredInOrder, analysis);
  writeFileSync(RESULTS, markdown);
  console.log(`\n${markdown}\nWrote ${RESULTS}`);
}

if (args.render) {
  report(latestRunFile(), cases);
  process.exit(0);
}

loadDotEnv();
const env = parseEnv();

const meta: RunMeta = {
  type: 'meta',
  startedAt: new Date().toISOString(),
  provider: env.LLM_PROVIDER,
  model: configuredModel(env),
  promptVersion: PROMPT_VERSION,
  structuredMode: env.LLM_STRUCTURED_MODE,
  reasoningEffort: env.LLM_REASONING_EFFORT ?? null,
  maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
  timeoutMs: env.LLM_TIMEOUT_MS,
};
const SAME_SETUP: Array<keyof RunMeta> = [
  'provider',
  'model',
  'promptVersion',
  'structuredMode',
  'reasoningEffort',
  'maxOutputTokens',
  'timeoutMs',
];

let runPath: string;
let alreadyScored = new Set<string>();
if (args.resume) {
  runPath = latestRunFile();
  const previous = parseRunFile(readFileSync(runPath, 'utf8'));
  const previousMeta = previous.meta;
  if (!previousMeta) throw new Error(`${runPath} has no meta line`);
  const changed = SAME_SETUP.filter((k) => previousMeta[k] !== meta[k]);
  if (changed.length > 0) {
    throw new Error(
      `Refusing to resume ${runPath}: ${changed.join(', ')} changed since that run. Start a new run instead.`,
    );
  }
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
  `provider=${meta.provider} model=${meta.model} prompt=${meta.promptVersion} timeout=${meta.timeoutMs}ms delay=${env.EVAL_DELAY_MS}ms`,
);
console.log(
  `run file: ${runPath}\n${todo.length} case(s) to run, ${alreadyScored.size} already scored\n`,
);

let stopped = false;
for (const [i, c] of todo.entries()) {
  if (i > 0) await sleep(env.EVAL_DELAY_MS);
  const requestsBefore = llm.requests;
  const outcome = await runCase(
    (recordCall) => triage.run(c.text, recordCall),
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
    const actual = toActual(outcome.decision);
    append({
      type: 'case',
      id: c.id,
      scored: true,
      expected: c.expected,
      actual,
      calls: outcome.calls,
      failedAttempts: outcome.failedAttempts,
      latencyMs: outcome.latencyMs,
      requests,
      retries: outcome.retries,
      finishedAt,
    });
    console.log(
      `${c.id} ${actual.status}${actual.reviewReason ? `(${actual.reviewReason})` : ''} area=${actual.practiceArea ?? '-'}/${acceptedAreas(c.expected).join('|')} urgency=${actual.urgency ?? '-'}/${c.expected.urgency} calls=${outcome.calls.map((x) => x.outcome).join('+')} ${outcome.latencyMs}ms`,
    );
    continue;
  }

  // Not scored: record why, then stop so a daily cap or bad key can't burn the remaining cases.
  const error = summarizeError(outcome.error);
  append({
    type: 'case',
    id: c.id,
    scored: false,
    error,
    failedAttempts: outcome.failedAttempts,
    requests,
    retries: outcome.retries,
    finishedAt,
  });
  console.log(
    `${c.id} NOT SCORED ${JSON.stringify(error)} after ${outcome.retries} retr${outcome.retries === 1 ? 'y' : 'ies'}. Stopping.`,
  );
  stopped = true;
  break;
}

console.log(`\nRequests used this session: ${llm.requests}.`);
report(runPath, cases);
if (stopped) process.exitCode = 1;
