import { describe, it, expect } from 'vitest';
import { ingestTools } from '../../src/mcp/tools/ingest';
import { buildTools } from '../../src/mcp/tools/build';
import { canonicalTools } from '../../src/mcp/tools/canonical';
import { exportTools } from '../../src/mcp/tools/export';
import { verifyTools } from '../../src/mcp/tools/verify';
import { renderTools } from '../../src/mcp/tools/render';

const ALL = [
  ...ingestTools, ...buildTools, ...canonicalTools,
  ...exportTools, ...verifyTools,
  ...renderTools,
];

const EXAMPLE_RE = /Example:\s*(\{[\s\S]*?\})\s*$/;

describe('every MCP tool description embeds a parseable Example: {...} block', () => {
  for (const tool of ALL) {
    it(`${tool.name}: has an Example block`, () => {
      const match = tool.description.match(EXAMPLE_RE);
      expect(match, `tool ${tool.name} description missing trailing Example: {...}`).not.toBeNull();
    });
    it(`${tool.name}: Example parses against the tool's inputValidator`, () => {
      const match = tool.description.match(EXAMPLE_RE);
      if (!match) return;   // failure already reported above
      const example = JSON.parse(match[1]);
      expect(() => tool.inputValidator.parse(example)).not.toThrow();
    });
  }
});
