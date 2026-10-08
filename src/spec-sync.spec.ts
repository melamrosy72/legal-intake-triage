import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROMPT_VERSION, SYSTEM_PROMPT } from './triage.prompt.js';

describe('triage prompt', () => {
  it('matches the system prompt and version documented in SPEC.md §9', () => {
    const spec = readFileSync(
      new URL('../../SPEC.md', import.meta.url),
      'utf8',
    );
    expect(spec).toContain(`## 9. Prompt (version \`${PROMPT_VERSION}\`)`);
    expect(spec).toContain(`**System**\n\n\`\`\`\n${SYSTEM_PROMPT}\n\`\`\``);
  });
});
