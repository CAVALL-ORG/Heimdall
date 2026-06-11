import { describe, it, expect } from 'vitest';
import { resolveIndigoMode } from '../../src/mcp/indigo-bootstrap';

describe('resolveIndigoMode', () => {
  it('honors an explicit standalone request without probing', async () => {
    const r = await resolveIndigoMode('standalone', async () => true);
    expect(r).toEqual({ mode: 'standalone', degraded: true, probed: false });
  });

  it('honors an explicit remote request without probing', async () => {
    const r = await resolveIndigoMode('remote', async () => false);
    expect(r).toEqual({ mode: 'remote', degraded: false, probed: false });
  });

  it('auto -> remote when indigo is importable', async () => {
    const r = await resolveIndigoMode('auto', async () => true);
    expect(r).toEqual({ mode: 'remote', degraded: false, probed: true });
  });

  it('auto -> standalone + degraded when indigo is absent', async () => {
    const r = await resolveIndigoMode('auto', async () => false);
    expect(r).toEqual({ mode: 'standalone', degraded: true, probed: true });
  });
});
