// server/scripts/run-tool.ts
// Generic CLI dispatcher for canvas-free MCP tools, for sessions whose running
// MCP server predates a tool. Usage:
//   npx tsx run-tool.ts crop_molecule '{"pdfPath":"/abs.pdf","page":3,"seeds":[{"x":.3,"y":.3}],"outputDir":"/abs/out"}'
import { pdfTools } from '../src/mcp/tools/pdf';
import type { KetcherRuntime } from '../src/mcp/runtime';

const ALL = [...pdfTools];
async function main() {
  const [name, json] = process.argv.slice(2);
  const tool = ALL.find(t => t.name === name);
  if (!tool) { console.error(`unknown tool: ${name}; have: ${ALL.map(t=>t.name).join(', ')}`); process.exit(2); }
  const parsed = JSON.parse(json);
  if (Array.isArray(parsed)) {
    // Batch mode: run tool sequentially for each item, collect results.
    const results: unknown[] = [];
    let allOk = true;
    for (const item of parsed) {
      const res = await tool.run({} as KetcherRuntime, item);
      results.push(res);
      if (!(res as { ok?: boolean }).ok) allOk = false;
    }
    console.log(JSON.stringify(results, null, 2));
    if (!allOk) process.exit(1);
  } else {
    // Single-object mode: unchanged behavior.
    const res = await tool.run({} as KetcherRuntime, parsed);
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exit(1);
  }
}
void main();
