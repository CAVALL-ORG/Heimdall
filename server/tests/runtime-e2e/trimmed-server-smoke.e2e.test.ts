import { describe, it, expect, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const RUN = process.env.RUN_KETCHER_E2E === '1';

describe.runIf(RUN)('trimmed server stdio smoke', () => {
  let transport: StdioClientTransport;
  let client: Client;

  afterAll(async () => {
    await client?.close();
  });

  it('lists exactly the kept tools and serves load_smiles -> export_smiles', async () => {
    transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'src/mcp/server.ts'],
      cwd: process.cwd(),
      env: { ...process.env, KETCHER_AGENT_MODE: 'standalone' },
    });
    client = new Client({ name: 'smoke', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain('build_from_graph');
    expect(names).toContain('export_smiles');
    expect(names).not.toContain('aromatize');
    expect(names).not.toContain('set_bond_order');

    await client.callTool({ name: 'load_smiles', arguments: { smiles: 'CCO' } });
    const res = await client.callTool({ name: 'export_smiles', arguments: {} });
    const text = (res.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? '')
      .join('');
    expect(text).toMatch(/C/); // a SMILES came back from Ketcher, not authored
  }, 120_000);
});
