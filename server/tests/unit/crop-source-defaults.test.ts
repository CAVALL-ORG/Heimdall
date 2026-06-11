import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { cropTools } from '../../src/mcp/tools/crop';
import { resolveRowState } from '../../src/mcp/tools/row-state';

describe('crop_source_image defaults', () => {
  let workDir: string;
  let sourcePath: string;

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'crop-defaults-'));
    sourcePath = join(workDir, 'source.png');
    await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png()
      .toFile(sourcePath);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('accepts a call with sourceImagePath + crop coords + rowId; server defaults outputDir', () => {
    const tool = cropTools[0];
    // rowId is REQUIRED now (solution #2 — canvas isolation per row); outputDir
    // is still omitted on purpose and defaulted server-side from the rowId.
    const result = tool.inputValidator.safeParse({
      sourceImagePath: sourcePath,
      rowId: 'mol-1',
      x: 100,
      y: 100,
      w: 200,
      h: 200,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a crop call that omits rowId (required for canvas isolation)', () => {
    const tool = cropTools[0];
    const result = tool.inputValidator.safeParse({
      sourceImagePath: sourcePath,
      x: 100,
      y: 100,
      w: 200,
      h: 200,
    });
    expect(result.success).toBe(false);
  });

  it('keeps sourceImagePath required (functional argument)', () => {
    const tool = cropTools[0];
    const result = tool.inputValidator.safeParse({
      x: 100,
      y: 100,
      w: 200,
      h: 200,
    });
    expect(result.success).toBe(false);
  });
});

describe('crop_source_image server-default integration', () => {
  let workDir: string;
  let sourcePath: string;

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'crop-integ-'));
    sourcePath = join(workDir, 'mol.png');
    await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png()
      .toFile(sourcePath);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('writes the crop into the resolveRowState-defaulted outputDir', async () => {
    // Simulate the server wrapper's write-back step:
    const args: Record<string, unknown> = {
      sourceImagePath: sourcePath,
      x: 100,
      y: 100,
      w: 200,
      h: 200,
    };
    const resolved = resolveRowState({
      rowId: args.rowId,
      outputDir: args.outputDir,
    });
    args.outputDir = resolved.outputDir;
    args.rowId = resolved.rowId;

    // T1 sidecar would block crop otherwise; disable the AFTER_VALIDATE
    // gate for this integration check.
    process.env.KETCHER_CROP_AFTER_VALIDATE = '0';
    try {
      const tool = cropTools[0];
      const parsed = tool.inputValidator.parse(args);
      const result = await tool.run({} as never, parsed);
      expect(result.ok).toBe(true);
      expect(existsSync(resolved.outputDir)).toBe(true);
    } finally {
      delete process.env.KETCHER_CROP_AFTER_VALIDATE;
      // Best-effort cleanup of the session-scoped default outputDir.
      try {
        rmSync(resolved.outputDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});
