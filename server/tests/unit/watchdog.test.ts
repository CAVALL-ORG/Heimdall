import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateWatchdog,
  WATCHDOG_DEFAULT_CAP,
} from '../../src/mcp/tools/row-state';

describe('T4 silent watchdog (KETCHER_WATCHDOG=1)', () => {
  const cleanups: string[] = [];
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'watchdog-'));
    cleanups.push(dir);
  });

  afterEach(() => {
    for (const d of cleanups) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    cleanups.length = 0;
    delete process.env.KETCHER_WATCHDOG;
    delete process.env.KETCHER_AGENT_TURN_CAP;
  });

  it('returns null when flag explicitly disabled', () => {
    process.env.KETCHER_WATCHDOG = '0';
    const r = evaluateWatchdog('validate_graph', {
      rowId: 'r',
      outputDir: dir,
    });
    expect(r).toBeNull();
  });

  it('returns null for tools outside WATCHDOG_COUNTED_TOOLS', () => {
    process.env.KETCHER_WATCHDOG = '1';
    const r = evaluateWatchdog('get_state', {
      rowId: 'r',
      outputDir: dir,
    });
    expect(r).toBeNull();
  });

  it('returns terminated response after exceeding env-driven cap', () => {
    process.env.KETCHER_WATCHDOG = '1';
    process.env.KETCHER_AGENT_TURN_CAP = '3';
    for (let i = 0; i < 3; i++) {
      expect(
        evaluateWatchdog('validate_graph', { rowId: 'r', outputDir: dir }),
      ).toBeNull();
    }
    const terminated = evaluateWatchdog('validate_graph', {
      rowId: 'r',
      outputDir: dir,
    });
    expect(terminated).not.toBeNull();
    expect(terminated?.error.code).toBe('session_terminated');
  });

  it('terminated message contains no integers, no "budget"/"cap"/"turn"/"LOCK" tokens', () => {
    process.env.KETCHER_WATCHDOG = '1';
    process.env.KETCHER_AGENT_TURN_CAP = '1';
    evaluateWatchdog('validate_graph', { rowId: 'r', outputDir: dir });
    const terminated = evaluateWatchdog('validate_graph', {
      rowId: 'r',
      outputDir: dir,
    });
    expect(terminated).not.toBeNull();
    const msg = terminated!.error.message;
    expect(msg).not.toMatch(/\d/);
    expect(msg).not.toMatch(/budget/i);
    expect(msg).not.toMatch(/\bcap\b/i);
    expect(msg).not.toMatch(/\bturn\b/i);
    expect(msg).not.toMatch(/LOCK/);
  });

  it('telemetry fields live in error.details (not in message)', () => {
    process.env.KETCHER_WATCHDOG = '1';
    process.env.KETCHER_AGENT_TURN_CAP = '1';
    evaluateWatchdog('validate_graph', { rowId: 'r', outputDir: dir });
    const terminated = evaluateWatchdog('validate_graph', {
      rowId: 'r',
      outputDir: dir,
    });
    expect(terminated?.error.details.cap).toBe(1);
    expect(terminated?.error.details.used).toBeGreaterThan(1);
  });

  it('default cap is 50 when env var unset', () => {
    process.env.KETCHER_WATCHDOG = '1';
    for (let i = 0; i < WATCHDOG_DEFAULT_CAP; i++) {
      const r = evaluateWatchdog('validate_graph', {
        rowId: 'r',
        outputDir: dir,
      });
      expect(r).toBeNull();
    }
    const terminated = evaluateWatchdog('validate_graph', {
      rowId: 'r',
      outputDir: dir,
    });
    expect(terminated?.error.code).toBe('session_terminated');
  });
});
