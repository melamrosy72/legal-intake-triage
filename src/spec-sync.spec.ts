import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROMPT_VERSION, SYSTEM_PROMPT } from './triage/triage.prompt.js';

/** SPEC.md is the document a reader trusts; these checks fail when it drifts from the code. */
describe('SPEC.md matches the code', () => {
  const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), 'utf8');
  const spec = read('../SPEC.md');

  it('§9: system prompt and version', () => {
    expect(spec).toContain(`## 9. Prompt (version \`${PROMPT_VERSION}\`)`);
    expect(spec).toContain(`**System**\n\n\`\`\`\n${SYSTEM_PROMPT}\n\`\`\``);
  });

  it('§5: data model', () => {
    const schema = read('../prisma/schema.prisma');
    const models = schema.slice(schema.indexOf('enum InquiryStatus')).trimEnd();
    expect(spec).toContain(`\`\`\`prisma\n${models}\n\`\`\``);
  });
});
