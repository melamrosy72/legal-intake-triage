import { describe, expect, it } from 'vitest';
import { checkGrounding, normalizeForGrounding } from './grounding.js';
import type { Triage } from './triage.schema.js';

const TEXT =
  'My landlord said \u201Cyou\u2019re out\u201D   by Friday.\nThe   hearing is on Monday.';

const triage = (overrides: Partial<Triage> = {}): Triage => ({
  isLegalInquiry: true,
  containsInstructionsToAi: false,
  practiceArea: 'REAL_ESTATE',
  urgency: 'LOW',
  summary: 's',
  evidence: [{ field: 'practiceArea', quote: 'My landlord said' }],
  missingInfo: [],
  confidence: 0.9,
  ...overrides,
});

describe('normalizeForGrounding', () => {
  it('applies NFKC, lowercases, straightens curly quotes and collapses whitespace', () => {
    expect(
      normalizeForGrounding(
        '  Ｆｕｌｌ\u00A0WIDTH \u201CHi\u201D \u2018there\u2019\n\t ok ',
      ),
    ).toBe('full width "hi" \'there\' ok');
  });
});

describe('checkGrounding', () => {
  it('accepts exact quotes', () => {
    expect(checkGrounding(triage(), TEXT)).toEqual([]);
  });

  it('accepts quotes differing only in case, whitespace or curly quotes (test 5)', () => {
    const result = checkGrounding(
      triage({
        urgency: 'HIGH',
        evidence: [
          {
            field: 'practiceArea',
            quote: 'MY LANDLORD said "you\'re out" by friday.',
          },
          { field: 'urgency', quote: 'the hearing\n is on monday' },
        ],
      }),
      TEXT,
    );
    expect(result).toEqual([]);
  });

  it('rejects a paraphrased quote', () => {
    const result = checkGrounding(
      triage({
        evidence: [{ field: 'practiceArea', quote: 'My landlord told me' }],
      }),
      TEXT,
    );
    expect(result).toEqual([
      'evidence[0].quote is not copied exactly from the inquiry: "My landlord told me"',
    ]);
  });

  it('rejects a whitespace-only quote, which would match any text', () => {
    const result = checkGrounding(
      triage({
        evidence: [
          { field: 'practiceArea', quote: 'My landlord said' },
          { field: 'practiceArea', quote: '   ' },
        ],
      }),
      TEXT,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/^evidence\[1\]/);
  });

  it('requires practiceArea evidence for a legal inquiry with a known area (test 6)', () => {
    expect(checkGrounding(triage({ evidence: [] }), TEXT)).toEqual([
      'evidence has no item with field "practiceArea" supporting REAL_ESTATE',
    ]);
  });

  it('does not require practiceArea evidence for UNCLEAR or a non-legal message', () => {
    expect(
      checkGrounding(triage({ practiceArea: 'UNCLEAR', evidence: [] }), TEXT),
    ).toEqual([]);
    expect(
      checkGrounding(
        triage({ isLegalInquiry: false, practiceArea: 'OTHER', evidence: [] }),
        TEXT,
      ),
    ).toEqual([]);
  });

  it('requires urgency evidence for MEDIUM and HIGH', () => {
    for (const urgency of ['MEDIUM', 'HIGH'] as const) {
      expect(checkGrounding(triage({ urgency }), TEXT)).toEqual([
        `evidence has no item with field "urgency" supporting ${urgency}`,
      ]);
    }
  });
});
