import type { Triage } from '../triage/triage.schema.js';
import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
} from './llm-client.interface.js';

/**
 * Two modes:
 * - Tests: queue responses or errors with `respondWith`; they are returned in order and every
 *   request is recorded in `requests`. Running out of script throws, so a test can't silently
 *   make an extra call.
 * - Runtime (LLM_PROVIDER=fake): pass `keywordTriage` as the fallback for a deterministic,
 *   valid, grounded classifier that needs no API key.
 */
export class FakeLlmClient implements LlmClient {
  readonly requests: LlmRequest[] = [];
  private readonly script: Array<LlmResponse | Error> = [];

  constructor(private readonly fallback?: (req: LlmRequest) => LlmResponse) {}

  respondWith(...items: Array<LlmResponse | Error>): this {
    this.script.push(...items);
    return this;
  }

  generateStructured(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    const next = this.script.shift();
    if (next instanceof Error) return Promise.reject(next);
    if (next) return Promise.resolve(next);
    if (this.fallback) return Promise.resolve(this.fallback(req));
    return Promise.reject(
      new Error('FakeLlmClient: no scripted response left'),
    );
  }
}

/** Builds a scripted response; tests override only what they care about. */
export function fakeResponse(
  json: unknown,
  overrides: Partial<LlmResponse> = {},
): LlmResponse {
  return {
    json,
    stopReason: 'complete',
    usage: { inputTokens: 100, outputTokens: 50 },
    provider: 'fake',
    model: 'fake-scripted',
    latencyMs: 1,
    ...overrides,
  };
}

const AREA_KEYWORDS: Array<[Triage['practiceArea'], string[]]> = [
  [
    'PERSONAL_INJURY',
    ['accident', 'injur', 'crash', 'slipped', 'medical bills'],
  ],
  ['FAMILY', ['divorce', 'custody', 'child support', 'alimony', 'separation']],
  ['IMMIGRATION', ['visa', 'green card', 'deport', 'asylum', 'immigration']],
  [
    'EMPLOYMENT',
    ['fired', 'employer', 'wages', 'overtime', 'harass', 'terminated'],
  ],
  ['CRIMINAL_DEFENSE', ['arrest', 'charged with', 'police', 'dui', 'criminal']],
  ['REAL_ESTATE', ['landlord', 'evict', 'lease', 'tenant', 'mortgage']],
  [
    'ESTATE_PLANNING',
    ['estate plan', 'probate', 'inherit', 'power of attorney', 'my will'],
  ],
  [
    'BUSINESS',
    ['contract', 'my business', 'business partner', 'llc', 'shareholder'],
  ],
];
const HIGH_URGENCY = [
  'arrested',
  'detained',
  'tomorrow',
  'this week',
  'within days',
  'immediately',
  'emergency',
  'hearing is on',
];
const MEDIUM_URGENCY = [
  'next month',
  'within weeks',
  'deadline',
  'ongoing',
  'weeks',
];
const SPAM = [
  'buy now',
  'discount',
  'unsubscribe',
  'seo services',
  'crypto',
  'promo code',
];
const INJECTION =
  /ignore (?:all |any |your |previous |prior )*instructions|disregard (?:the|your) (?:rules|instructions)|system prompt/i;

export const FAKE_MODEL = 'fake-keyword-v1';

/** Deterministic keyword classifier used when LLM_PROVIDER=fake. Quotes are always copied from the text. */
export function keywordTriage(req: LlmRequest): LlmResponse {
  const text =
    /<inquiry>\s*([\s\S]*?)\s*<\/inquiry>/.exec(req.user)?.[1] ?? req.user;
  const lower = text.toLowerCase();

  const area = earliestMatch(lower, AREA_KEYWORDS);
  const high = earliestMatch<Triage['urgency']>(lower, [
    ['HIGH', HIGH_URGENCY],
  ]);
  const medium = earliestMatch<Triage['urgency']>(lower, [
    ['MEDIUM', MEDIUM_URGENCY],
  ]);
  const urgency = high ?? medium;
  const isSpam = !area && SPAM.some((k) => lower.includes(k));

  const evidence: Triage['evidence'] = [];
  if (area && !isSpam)
    evidence.push({
      field: 'practiceArea',
      quote: sentenceAt(text, area.index),
    });
  if (urgency)
    evidence.push({ field: 'urgency', quote: sentenceAt(text, urgency.index) });

  const practiceArea = isSpam ? 'OTHER' : (area?.value ?? 'UNCLEAR');
  const triage: Triage = {
    isLegalInquiry: !isSpam,
    containsInstructionsToAi: INJECTION.test(text),
    practiceArea,
    urgency: urgency?.value ?? 'LOW',
    summary: isSpam
      ? 'Not a legal inquiry (keyword fake).'
      : `Keyword fake: ${practiceArea} matter, ${urgency?.value ?? 'LOW'} urgency.`,
    evidence,
    missingInfo: ['Full name and contact details', 'Key dates'],
    confidence: area || isSpam ? 0.9 : 0.4,
  };
  return fakeResponse(triage, {
    model: FAKE_MODEL,
    latencyMs: 0,
    usage: {
      inputTokens: Math.ceil((req.system.length + req.user.length) / 4),
      outputTokens: Math.ceil(JSON.stringify(triage).length / 4),
    },
  });
}

function earliestMatch<T>(
  lower: string,
  groups: Array<[T, string[]]>,
): { value: T; index: number } | undefined {
  let best: { value: T; index: number } | undefined;
  for (const [value, keywords] of groups) {
    for (const k of keywords) {
      const index = lower.indexOf(k);
      if (index !== -1 && (!best || index < best.index))
        best = { value, index };
    }
  }
  return best;
}

/** The sentence containing `index`, copied verbatim from the text so it always passes grounding. */
function sentenceAt(text: string, index: number): string {
  const boundary = /[.!?\n]/;
  let start = index;
  while (start > 0 && !boundary.test(text[start - 1] ?? '')) start--;
  let end = index;
  while (end < text.length && !boundary.test(text[end] ?? '')) end++;
  return text.slice(start, Math.min(end + 1, start + 300)).trim();
}
