import type { Triage } from './triage.schema.js';

/** NFKC, lowercase, curly quotes to straight, whitespace runs to one space, trimmed. */
export function normalizeForGrounding(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns the grounding problems in a valid triage object; empty means grounded.
 * Known limit: this proves each quote exists in the inquiry, not that it supports the conclusion.
 */
export function checkGrounding(triage: Triage, rawText: string): string[] {
  const inquiry = normalizeForGrounding(rawText);
  const problems: string[] = [];

  triage.evidence.forEach(({ quote }, i) => {
    const normalized = normalizeForGrounding(quote);
    // A quote that normalizes to (almost) nothing would be a substring of any text.
    if (normalized.length < 3 || !inquiry.includes(normalized)) {
      problems.push(
        `evidence[${i}].quote is not copied exactly from the inquiry: ${JSON.stringify(quote)}`,
      );
    }
  });

  const has = (field: 'practiceArea' | 'urgency') =>
    triage.evidence.some((e) => e.field === field);
  if (
    triage.isLegalInquiry &&
    triage.practiceArea !== 'UNCLEAR' &&
    !has('practiceArea')
  ) {
    problems.push(
      `evidence has no item with field "practiceArea" supporting ${triage.practiceArea}`,
    );
  }
  if (triage.urgency !== 'LOW' && !has('urgency')) {
    problems.push(
      `evidence has no item with field "urgency" supporting ${triage.urgency}`,
    );
  }
  return problems;
}
