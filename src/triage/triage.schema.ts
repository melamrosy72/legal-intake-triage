import { z } from 'zod';

export const PRACTICE_AREAS = [
  'PERSONAL_INJURY',
  'FAMILY',
  'IMMIGRATION',
  'EMPLOYMENT',
  'CRIMINAL_DEFENSE',
  'REAL_ESTATE',
  'ESTATE_PLANNING',
  'BUSINESS',
  'OTHER',
  'UNCLEAR',
] as const;

/** Single source of truth: validates model output and generates the JSON Schema sent to the provider. */
export const TriageSchema = z
  .object({
    isLegalInquiry: z.boolean(),
    containsInstructionsToAi: z.boolean(),
    practiceArea: z.enum(PRACTICE_AREAS),
    urgency: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    summary: z.string().min(1).max(400),
    evidence: z
      .array(
        z.object({
          field: z.enum(['practiceArea', 'urgency']),
          quote: z.string().min(3).max(300),
        }),
      )
      .max(6),
    missingInfo: z.array(z.string().min(1).max(120)).max(5),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type Triage = z.infer<typeof TriageSchema>;

export const TRIAGE_SCHEMA_NAME = 'triage';
export const TRIAGE_JSON_SCHEMA = z.toJSONSchema(TriageSchema) as Record<
  string,
  unknown
>;
