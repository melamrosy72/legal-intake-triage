# Evaluation results

Model: `nvidia/nemotron-3-super-120b-a12b:free` via openrouter · prompt `triage-v2` · structured mode `json_schema` · reasoning effort `low` · max output tokens 2000 · run started 2026-10-08T14:10:35.587Z

> 20 synthetic cases. This is a smoke test, not a statistically meaningful benchmark: one case is 5% of any rate below.

Practice area is scored correct for c14 if it is PERSONAL_INJURY or EMPLOYMENT (more than one issue in the message, so more than one answer is defensible).

| Metric | Value |
|---|---|
| Practice-area accuracy (legal inquiries) | 95% (18/19) |
| Urgency accuracy (legal inquiries) | 100% (19/19) |
| isLegalInquiry accuracy | 100% (20/20) |
| Review routing matched expectation | 95% (19/20) |
| Routed to human review | 25% (5/20): LOW_CONFIDENCE 4, SUSPECTED_INJECTION 1 |
| Needed a repair call | 10% (2/20) |
| Schema or grounding failure after repair | 0 |
| Latency per case, avg / p95 | 11539 ms / 18890 ms |
| Tokens, input / output (output includes reasoning) | 16545 / 18299 |
| Real requests used | 25 |

## Per case (expected / actual)

| Case | Practice area | Urgency | Final status | Calls | Latency ms |
|---|---|---|---|---|---|
| c01 | PERSONAL_INJURY / PERSONAL_INJURY ok | LOW / LOW ok | COMPLETED | INITIAL:OK | 11571 |
| c02 | FAMILY / FAMILY ok | LOW / LOW ok | COMPLETED | INITIAL:OK | 7095 |
| c03 | IMMIGRATION / IMMIGRATION ok | LOW / LOW ok | COMPLETED | INITIAL:OK | 5424 |
| c04 | EMPLOYMENT / EMPLOYMENT ok | MEDIUM / MEDIUM ok | COMPLETED | INITIAL:OK | 16744 |
| c05 | CRIMINAL_DEFENSE / CRIMINAL_DEFENSE ok | HIGH / HIGH ok | COMPLETED | INITIAL:OK | 17013 |
| c06 | REAL_ESTATE / REAL_ESTATE ok | MEDIUM / MEDIUM ok | COMPLETED | INITIAL:OK | 9199 |
| c07 | ESTATE_PLANNING / ESTATE_PLANNING ok | LOW / LOW ok | COMPLETED | INITIAL:OK | 12111 |
| c08 | BUSINESS / BUSINESS ok | LOW / LOW ok | COMPLETED | INITIAL:OK | 12241 |
| c09 | OTHER / OTHER ok | LOW / LOW ok | COMPLETED | INITIAL:OK | 4705 |
| c10 | UNCLEAR / UNCLEAR ok | MEDIUM / MEDIUM ok | NEEDS_HUMAN_REVIEW (LOW_CONFIDENCE) | INITIAL:UNGROUNDED, REPAIR:OK | 20456 |
| c11 | UNCLEAR / UNCLEAR ok | LOW / LOW ok | NEEDS_HUMAN_REVIEW (LOW_CONFIDENCE) | INITIAL:OK | 8831 |
| c12 | not scored | not scored | COMPLETED | INITIAL:OK | 18890 |
| c13 | UNCLEAR / UNCLEAR ok | LOW / LOW ok | NEEDS_HUMAN_REVIEW (LOW_CONFIDENCE) | INITIAL:OK | 8982 |
| c14 | PERSONAL_INJURY or EMPLOYMENT / UNCLEAR **x** | LOW / LOW ok | NEEDS_HUMAN_REVIEW (LOW_CONFIDENCE) | INITIAL:OK | 13667 |
| c15 | IMMIGRATION / IMMIGRATION ok | HIGH / HIGH ok | COMPLETED | INITIAL:OK | 5149 |
| c16 | FAMILY / FAMILY ok | HIGH / HIGH ok | COMPLETED | INITIAL:OK | 7439 |
| c17 | EMPLOYMENT / EMPLOYMENT ok | LOW / LOW ok | COMPLETED | INITIAL:OK | 17803 |
| c18 | REAL_ESTATE / REAL_ESTATE ok | HIGH / HIGH ok | COMPLETED | INITIAL:OK | 8558 |
| c19 | REAL_ESTATE / REAL_ESTATE ok | LOW / LOW ok | NEEDS_HUMAN_REVIEW (SUSPECTED_INJECTION) | INITIAL:OK | 6232 |
| c20 | ESTATE_PLANNING / ESTATE_PLANNING ok | MEDIUM / MEDIUM ok | COMPLETED | INITIAL:UNGROUNDED, REPAIR:OK | 18660 |
