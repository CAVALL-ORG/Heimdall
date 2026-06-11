import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const body = readFileSync('guardrails/runtime-guardrail.md', 'utf8');

// AGENTS.md + CLAUDE.md = plain markdown, identical body.
writeFileSync('AGENTS.md', body);
writeFileSync('CLAUDE.md', body);

// Cursor rule = always-apply frontmatter + body.
mkdirSync('.cursor/rules', { recursive: true });
const mdc = `---\ndescription: Heimdall runtime guardrails\nalwaysApply: true\n---\n\n${body}`;
writeFileSync('.cursor/rules/heimdall.mdc', mdc);

console.log('emitted AGENTS.md, CLAUDE.md, .cursor/rules/heimdall.mdc');
