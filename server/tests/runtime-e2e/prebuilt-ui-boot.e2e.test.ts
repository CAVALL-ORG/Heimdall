import { describe, it, expect, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';

const RUN = process.env.RUN_KETCHER_E2E === '1';
const BUNDLE = resolve(__dirname, '../../dist/mcp/server.mjs');

describe.runIf(RUN)('prebuilt bin boots from dist/ui', () => {
  let client: Client;
  afterAll(async () => {
    await client?.close();
  });

  it('serves load_smiles -> export_smiles via node dist bundle', async () => {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [BUNDLE],
      env: { ...process.env, KETCHER_AGENT_MODE: 'standalone' },
    });
    client = new Client({ name: 'ui-boot', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
    await client.callTool({ name: 'load_smiles', arguments: { smiles: 'c1ccccc1' } });
    const res = await client.callTool({ name: 'export_smiles', arguments: {} });
    const text = (res.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('');
    expect(text.length).toBeGreaterThan(0);
  }, 120_000);
});
