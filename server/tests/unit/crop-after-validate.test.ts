import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { cropTools } from '../../src/mcp/tools/crop';
import {
  writeUnresolvedTargets,
  type UnresolvedTarget,
} from '../../src/mcp/tools/row-state';

const cropTool = cropTools[0];

async function createImage(path: string, n = 1000): Promise<void> {
  await sharp({
    create: {
      width: n,
      height: n,
      channels: 3,
      background: { r: 200, g: 200, b: 200 },
    },
  })
    .png()
    .toFile(path);
}

describe('T1 crop-after-validate enforcement (KETCHER_CROP_AFTER_VALIDATE=1)', () => {
  const cleanups: string[] = [];
  let dir: string;
  let src: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cav-'));
    cleanups.push(dir);
    src = join(dir, 'source.png');
    await createImage(src);
    process.env.KETCHER_CROP_AFTER_VALIDATE = '1';
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
    delete process.env.KETCHER_CROP_AFTER_VALIDATE;
  });

  it('rejects crop with crop_before_validate when sidecar absent', async () => {
    const result = await cropTool.run({} as never, {
      rowId: 'r',
      sourceImagePath: src,
      outputDir: dir,
      x: 500,
      y: 500,
      w: 200,
      h: 200,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('crop_before_validate');
  });

  it('rejects crop with no_pending_targets when validate ok with empty targets', async () => {
    writeUnresolvedTargets(dir, {
      ok: true,
      round: 1,
      rowId: 'r',
      targets: [],
    });
    const result = await cropTool.run({} as never, {
      rowId: 'r',
      sourceImagePath: src,
      outputDir: dir,
      x: 500,
      y: 500,
      w: 200,
      h: 200,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('no_pending_targets');
  });

  it('rejects crop with crop_target_not_named when (x,y) far from any target', async () => {
    const targets: UnresolvedTarget[] = [
      {
        record_id: 'worksheet_node:n1',
        field: 'segment_endpoint',
        x_center: 100,
        y_center: 100,
        bbox_radius: 0,
        round: 1,
      },
    ];
    writeUnresolvedTargets(dir, {
      ok: false,
      round: 1,
      rowId: 'r',
      targets,
    });
    const result = await cropTool.run({} as never, {
      rowId: 'r',
      sourceImagePath: src,
      outputDir: dir,
      x: 800,
      y: 800,
      w: 200,
      h: 200,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('crop_target_not_named');
  });

  it('accepts crop within proximity of a named target', async () => {
    writeUnresolvedTargets(dir, {
      ok: false,
      round: 1,
      rowId: 'r',
      targets: [
        {
          record_id: 'worksheet_node:n1',
          field: 'segment_endpoint',
          x_center: 500,
          y_center: 500,
          bbox_radius: 50,
          round: 1,
        },
      ],
    });
    const result = await cropTool.run({} as never, {
      rowId: 'r',
      sourceImagePath: src,
      outputDir: dir,
      x: 510,
      y: 490,
      w: 200,
      h: 200,
    });
    expect(result.ok).toBe(true);
  });

  it('gate is no-op when env flag explicitly disabled', async () => {
    process.env.KETCHER_CROP_AFTER_VALIDATE = '0';
    const result = await cropTool.run({} as never, {
      rowId: 'r',
      sourceImagePath: src,
      outputDir: dir,
      x: 500,
      y: 500,
      w: 200,
      h: 200,
    });
    expect(result.ok).toBe(true);
  });
});
