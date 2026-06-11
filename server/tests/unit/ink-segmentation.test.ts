import { describe, it, expect } from 'vitest';
import {
  binarize, dilate, labelComponents, seedComponents, maskFromComponents,
  bboxOfMask, resampleMaskRegion, compositeWhiteWhereZero, segmentToKeep,
} from '../../src/adapter/ink-segmentation';

// '#' = ink(1), '.' = background(0)
function grid(rows: string[]): { bin: Uint8Array; w: number; h: number } {
  const h = rows.length, w = rows[0].length;
  const bin = new Uint8Array(w * h);
  rows.forEach((r, y) => [...r].forEach((c, x) => { if (c === '#') bin[y * w + x] = 1; }));
  return { bin, w, h };
}
// build an RGB buffer (channels=3) from a binary: ink -> black, bg -> white
function rgb(bin: Uint8Array): Uint8Array {
  const out = new Uint8Array(bin.length * 3);
  for (let p = 0; p < bin.length; p++) { const v = bin[p] ? 0 : 255; out[p*3] = out[p*3+1] = out[p*3+2] = v; }
  return out;
}

describe('binarize', () => {
  it('all-white -> all 0, all-black -> all 1', () => {
    const white = new Uint8Array([255,255,255, 255,255,255]);
    const black = new Uint8Array([0,0,0, 0,0,0]);
    expect(Array.from(binarize(white,2,1,3,180))).toEqual([0,0]);
    expect(Array.from(binarize(black,2,1,3,180))).toEqual([1,1]);
  });
  it('threshold is strict less-than: 179 ink, 180 not', () => {
    const d = new Uint8Array([179,179,179, 180,180,180, 181,181,181]);
    expect(Array.from(binarize(d,3,1,3,180))).toEqual([1,0,0]);
  });
  it('any channel below threshold => ink', () => {
    const d = new Uint8Array([250,250,10, 250,250,250]); // dark-blue, white
    expect(Array.from(binarize(d,2,1,3,180))).toEqual([1,0]);
  });
  it('handles 1-channel and 4-channel (alpha ignored)', () => {
    expect(Array.from(binarize(new Uint8Array([100,200]),2,1,1,180))).toEqual([1,0]);
    // RGBA: dark pixel with full alpha, white pixel with zero alpha -> alpha must not count
    const rgba = new Uint8Array([10,10,10,255, 255,255,255,0]);
    expect(Array.from(binarize(rgba,2,1,4,180))).toEqual([1,0]);
  });
});

describe('dilate', () => {
  it('radius 0 is identity (fresh copy)', () => {
    const { bin, w, h } = grid(['#.', '..']);
    const out = dilate(bin, w, h, 0);
    expect(Array.from(out)).toEqual(Array.from(bin));
    expect(out).not.toBe(bin);
  });
  it('single pixel grows to a (2r+1)^2 block, clamped at edges', () => {
    const { bin, w, h } = grid(['.....','.....','..#..','.....','.....']);
    const out = dilate(bin, w, h, 1); // 3x3 around center
    expect(Array.from(out)).toEqual(Array.from(grid([
      '.....','.###.','.###.','.###.','.....',
    ]).bin));
  });
  it('two pixels at gap == 2r MERGE after dilation; gap == 2r+1 stay separate', () => {
    // r=1, gap of 2 empty cells between them (centers 3 apart) -> touch
    const merge = grid(['#..#']); // centers x=0 and x=3, gap=2  (2r=2)
    const md = dilate(merge.bin, merge.w, merge.h, 1);
    // after r=1 each spans its neighbors: x0->{0,1}, x3->{2,3}; 1 and 2 adjacent => one run
    expect(Array.from(md)).toEqual([1,1,1,1]);
    const sep = grid(['#...#']); // centers 4 apart, gap=3 (2r+1=3)
    const sd = dilate(sep.bin, sep.w, sep.h, 1);
    expect(Array.from(sd)).toEqual([1,1,0,1,1]); // middle stays 0 -> separate
  });
  it('does not wrap around edges', () => {
    const { bin, w, h } = grid(['#....']); // left edge
    const out = dilate(bin, w, h, 1);
    expect(Array.from(out)).toEqual([1,1,0,0,0]); // grows right only, no wrap to col 4
  });
  it('matches a naive 2-D dilation on a random small grid (separability)', () => {
    const w=7,h=6, bin=new Uint8Array(w*h);
    [3,10,11,25,30,41].forEach(i=>bin[i]=1);
    const r=2;
    const naive=new Uint8Array(w*h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){let v=0;
      for(let dy=-r;dy<=r&&!v;dy++)for(let dx=-r;dx<=r&&!v;dx++){
        const nx=x+dx,ny=y+dy; if(nx>=0&&ny>=0&&nx<w&&ny<h&&bin[ny*w+nx])v=1;}
      naive[y*w+x]=v;}
    expect(Array.from(dilate(bin,w,h,r))).toEqual(Array.from(naive));
  });
});

describe('labelComponents', () => {
  const labelsOf = (rows:string[], conn:4|8) => {
    const {bin,w,h}=grid(rows); return labelComponents(bin,w,h,conn);
  };
  it('empty -> 0 components', () => {
    expect(labelsOf(['..','..'],8).count).toBe(0);
  });
  it('one block -> 1 component, shared label', () => {
    const {labels,count}=labelsOf(['##','##'],8);
    expect(count).toBe(1);
    expect(new Set(Array.from(labels).filter(l=>l!==0)).size).toBe(1);
  });
  it('two separated blocks -> 2 components', () => {
    expect(labelsOf(['#.#','#.#'],8).count).toBe(2);
  });
  it('diagonal touch: 4-conn -> 2, 8-conn -> 1', () => {
    const rows=['#.','.#'];
    expect(labelsOf(rows,4).count).toBe(2);
    expect(labelsOf(rows,8).count).toBe(1);
  });
  it('concave (U) shape is one component', () => {
    expect(labelsOf(['#.#','#.#','###'],8).count).toBe(1);
  });
  it('ring with hole is one component; a block inside the hole is a second', () => {
    expect(labelsOf(['###','#.#','###'],8).count).toBe(1);
    expect(labelsOf(['#####','#...#','#.#.#','#...#','#####'],8).count).toBe(2);
  });
  it('labels are deterministic in scan order (top-left block = label 1)', () => {
    const {labels}=labelsOf(['#.#','...'],8);
    expect(labels[0]).toBe(1); // first ink in scan order
  });
});

describe('seedComponents', () => {
  const setup = (rows:string[]) => { const {bin,w,h}=grid(rows); return {...labelComponents(bin,w,h,8), w, h}; };
  it('seed on ink returns its component label', () => {
    const {labels,w,h}=setup(['#.#']);
    expect(seedComponents(labels,w,h,[{x:0,y:0}])).toEqual(new Set([labels[0]]));
  });
  it('seed on background returns empty set', () => {
    const {labels,w,h}=setup(['#.#']);
    expect(seedComponents(labels,w,h,[{x:1,y:0}]).size).toBe(0);
  });
  it('two seeds in same component -> one label', () => {
    const {labels,w,h}=setup(['###']);
    expect(seedComponents(labels,w,h,[{x:0,y:0},{x:2,y:0}]).size).toBe(1);
  });
  it('two seeds in different components -> union of two labels', () => {
    const {labels,w,h}=setup(['#.#']);
    expect(seedComponents(labels,w,h,[{x:0,y:0},{x:2,y:0}]).size).toBe(2);
  });
  it('out-of-bounds seed is ignored', () => {
    const {labels,w,h}=setup(['#']);
    expect(seedComponents(labels,w,h,[{x:9,y:9}]).size).toBe(0);
  });
  it('tolerance snaps a near-miss seed to nearby ink', () => {
    // '#..' — ink block at x=0; seed at x=1 is 1px off, within tolerance 2
    const {labels,w,h}=setup(['#..']);
    const result = seedComponents(labels,w,h,[{x:1,y:0}], 2);
    expect(result.size).toBe(1);
    expect(result.has(labels[0])).toBe(true);
  });
  it('tolerance does not reach ink beyond the radius', () => {
    // '#....' — ink at x=0; seed at x=4 is 4px away, beyond tolerance 2
    const {labels,w,h}=setup(['#....']);
    const result = seedComponents(labels,w,h,[{x:4,y:0}], 2);
    expect(result.size).toBe(0);
  });
  it('default tolerance 0 leaves a background seed unmatched', () => {
    // '#..' — ink at x=0; seed at x=2 with no tolerance arg -> empty set
    const {labels,w,h}=setup(['#..']);
    const result = seedComponents(labels,w,h,[{x:2,y:0}]);
    expect(result.size).toBe(0);
  });
});

describe('maskFromComponents', () => {
  it('marks 1 where label in target, 0 elsewhere', () => {
    const {bin,w,h}=grid(['#.#']);
    const {labels}=labelComponents(bin,w,h,8);
    const target=new Set([labels[0]]); // left block only
    expect(Array.from(maskFromComponents(labels,w,h,target))).toEqual([1,0,0]);
  });
});
describe('bboxOfMask', () => {
  it('tight inclusive bbox of the set pixels', () => {
    const {bin,w,h}=grid(['....','.##.','.##.','....']);
    expect(bboxOfMask(bin,w,h)).toEqual({x0:1,y0:1,x1:2,y1:2});
  });
  it('includes edge pixels', () => {
    const {bin,w,h}=grid(['#..','...','..#']);
    expect(bboxOfMask(bin,w,h)).toEqual({x0:0,y0:0,x1:2,y1:2});
  });
  it('empty mask -> null', () => {
    expect(bboxOfMask(new Uint8Array(9),3,3)).toBeNull();
  });
});

describe('resampleMaskRegion', () => {
  it('full-frame 2x upscale = nearest blocks', () => {
    const m = new Uint8Array([1,0, 0,1]); // 2x2
    const out = resampleMaskRegion(m,2,2,{x0:0,y0:0,x1:1,y1:1},4,4);
    expect(Array.from(out)).toEqual([
      1,1,0,0,
      1,1,0,0,
      0,0,1,1,
      0,0,1,1,
    ]);
  });
  it('samples only the requested sub-region', () => {
    const {bin}=grid(['#...','....','....','...#']); // 4x4, ink at TL and BR
    // sample just the top-left quadrant -> output should be all-ink-ish at its TL
    const out = resampleMaskRegion(bin,4,4,{x0:0,y0:0,x1:0.5,y1:0.5},2,2);
    expect(out[0]).toBe(1);          // maps to src (0,0)
    expect(Array.from(out).slice(1)).toEqual([0,0,0]);
  });
});

describe('compositeWhiteWhereZero', () => {
  it('whites out pixels where keep==0, preserves keep==1', () => {
    const data = new Uint8Array([10,20,30, 40,50,60]); // 2 px RGB
    const keep = new Uint8Array([1,0]);
    expect(Array.from(compositeWhiteWhereZero(data,2,1,3,keep)))
      .toEqual([10,20,30, 255,255,255]);
  });
  it('returns a copy, does not mutate input', () => {
    const data = new Uint8Array([0,0,0]); const keep = new Uint8Array([0]);
    const out = compositeWhiteWhereZero(data,1,1,3,keep);
    expect(Array.from(data)).toEqual([0,0,0]);
    expect(Array.from(out)).toEqual([255,255,255]);
  });
});

describe('segmentToKeep', () => {
  // page: two molecules (left/right) + a caption blob bottom-center, all gap-separated
  const page = grid([
    '##...##',
    '##...##',
    '.......',
    '..###..',  // "caption"
  ]);
  // maskedOut is PER-CROP: only foreign blobs with ≥1 pixel inside the kept bbox are counted.
  // (a) foreign blob INSIDE the target bbox IS counted
  it('maskedOut counts foreign blob inside the crop bbox (ring with inner dot, dilationPx:0)', () => {
    // Ring border component seeded at {x:0,y:0}; the inner dot is a separate component
    // inside the ring's bounding box — it must be counted as maskedOut.
    const ring = grid([
      '#######',
      '#.....#',
      '#..#..#',
      '#.....#',
      '#######',
    ]);
    const data = rgb(ring.bin);
    const r = segmentToKeep(data, ring.w, ring.h, 3, [{x:0, y:0}], {dilationPx:0});
    expect(r.error).toBeUndefined();
    expect(r.targetCount).toBe(1);
    expect(r.maskedOut).toBe(1); // inner dot is inside the ring's bbox → counted
  });
  // (b) foreign blob OUTSIDE the target bbox is NOT counted
  it('maskedOut is 0 when foreign blobs are entirely outside the crop bbox', () => {
    // Seed the left block; right block + caption are outside the left block's bbox → not counted
    const data = rgb(page.bin);
    const r = segmentToKeep(data, page.w, page.h, 3, [{x:0, y:0}], {dilationPx:0});
    expect(r.error).toBeUndefined();
    expect(r.bbox).toEqual({x0:0, y0:0, x1:1, y1:1});
    expect(r.targetCount).toBe(1);
    expect(r.maskedOut).toBe(0); // right block + caption are outside the left block's bbox
    // every kept pixel is inside the left block
    for (let p=0;p<r.keep.length;p++) if (r.keep[p]) {
      const x=p%page.w, y=(p/page.w)|0; expect(x<=1 && y<=1).toBe(true);
    }
  });
  it('seed on whitespace -> NO_INK_AT_SEED', () => {
    const data = rgb(page.bin);
    const r = segmentToKeep(data,page.w,page.h,3,[{x:3,y:0}],{dilationPx:0});
    expect(r.error).toBe('NO_INK_AT_SEED');
    expect(r.bbox).toBeNull();
  });
  it('multi-seed unions two blobs (left molecule + caption)', () => {
    const data = rgb(page.bin);
    const r = segmentToKeep(data,page.w,page.h,3,[{x:0,y:0},{x:3,y:3}],{dilationPx:0});
    expect(r.targetCount).toBe(2);
    expect(r.bbox).toEqual({x0:0,y0:0,x1:4,y1:3}); // spans left block + caption
  });
  it('`within` cuts a bridge: two blocks joined by a thin line, within excludes the right', () => {
    const bridged = grid(['#######']); // one component spanning full width
    const data = rgb(bridged.bin);
    const r = segmentToKeep(data,bridged.w,bridged.h,3,[{x:0,y:0}],
      {dilationPx:0, withinPx:{x0:0,y0:0,x1:2,y1:0}});
    expect(r.bbox).toEqual({x0:0,y0:0,x1:2,y1:0}); // clipped to within
    for (let p=0;p<r.keep.length;p++) if (r.keep[p]) expect(p%bridged.w).toBeLessThanOrEqual(2);
  });
  it('within box entirely outside the seeded molecule -> WITHIN_CLIPS_ALL, bbox null', () => {
    const data = rgb(page.bin);
    // seed the left molecule at (0,0); withinPx rect is far from the left 2x2 block
    const r = segmentToKeep(data,page.w,page.h,3,[{x:0,y:0}],
      {dilationPx:0, withinPx:{x0:5,y0:3,x1:6,y1:3}});
    expect(r.error).toBe('WITHIN_CLIPS_ALL');
    expect(r.bbox).toBeNull();
    expect(r.targetCount).toBe(1);
  });
  it('seedTolerancePx rescues a near-miss seed', () => {
    // Use the page grid: left block at x=0..1, y=0..1
    // seed 1 pixel off the block's right edge (x=2) — normally NO_INK_AT_SEED
    const data = rgb(page.bin);
    const seedOffByOne = { x: 2, y: 0 }; // x=2 is background in page grid
    const withoutTol = segmentToKeep(data, page.w, page.h, 3, [seedOffByOne],
      { dilationPx: 0 });
    expect(withoutTol.error).toBe('NO_INK_AT_SEED');
    const withTol = segmentToKeep(data, page.w, page.h, 3, [seedOffByOne],
      { dilationPx: 0, seedTolerancePx: 2 });
    expect(withTol.error).toBeUndefined();
    expect(withTol.targetCount).toBe(1);
    expect(withTol.bbox).not.toBeNull();
  });
});

describe('invariants', () => {
  // a deterministic pseudo-random generator (Math.random is unavailable in some
  // harnesses and we want reproducibility): linear congruential
  const rng = (seed:number) => () => (seed = (seed*1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  function randomShapes() {
    // 40x30 page, 2-3 separated solid blocks (each a "molecule")
    const w=40,h=30,bin=new Uint8Array(w*h);
    const blocks=[{x:2,y:2,bw:8,bh:8},{x:20,y:2,bw:8,bh:8},{x:11,y:20,bw:6,bh:6}];
    for(const b of blocks)for(let y=b.y;y<b.y+b.bh;y++)for(let x=b.x;x<b.x+b.bw;x++)bin[y*w+x]=1;
    return {w,h,bin,blocks};
  }

  it('NO-CLIP: every ink pixel of the seeded component survives, for many seeds', () => {
    const rand=rng(7);
    for (let t=0;t<50;t++){
      const {w,h,bin,blocks}=randomShapes();
      const b=blocks[Math.floor(rand()*blocks.length)];
      const seed={x:b.x+Math.floor(rand()*b.bw), y:b.y+Math.floor(rand()*b.bh)};
      const r=segmentToKeep(rgb(bin),w,h,3,[seed],{dilationPx:0});
      // every pixel of THAT block must be kept
      for(let y=b.y;y<b.y+b.bh;y++)for(let x=b.x;x<b.x+b.bw;x++)
        expect(r.keep[y*w+x]).toBe(1);
    }
  });

  it('NO-FOREIGN: every non-target ink pixel is masked out (keep==0)', () => {
    const {w,h,bin,blocks}=randomShapes();
    const target=blocks[0];
    const r=segmentToKeep(rgb(bin),w,h,3,[{x:target.x,y:target.y}],{dilationPx:0});
    for(let i=1;i<blocks.length;i++){const b=blocks[i];
      for(let y=b.y;y<b.y+b.bh;y++)for(let x=b.x;x<b.x+b.bw;x++)
        expect(r.keep[y*w+x]).toBe(0);}
  });

  it('DETERMINISM: identical inputs -> identical keep + bbox', () => {
    const {w,h,bin}=randomShapes();
    const a=segmentToKeep(rgb(bin),w,h,3,[{x:3,y:3}],{});
    const b=segmentToKeep(rgb(bin),w,h,3,[{x:3,y:3}],{});
    expect(Array.from(a.keep)).toEqual(Array.from(b.keep));
    expect(a.bbox).toEqual(b.bbox);
  });

  it('MARGIN/RESAMPLE round-trip: resampling the keep over its bbox keeps all ink', () => {
    const {w,h,bin,blocks}=randomShapes();
    const b=blocks[0];
    const r=segmentToKeep(rgb(bin),w,h,3,[{x:b.x,y:b.y}],{dilationPx:0});
    const rect={x0:r.bbox!.x0/w,y0:r.bbox!.y0/h,x1:(r.bbox!.x1+1)/w,y1:(r.bbox!.y1+1)/h};
    const out=resampleMaskRegion(r.keep,w,h,rect,(b.bw)*2,(b.bh)*2); // 2x
    expect(out.every(v=>v===1)).toBe(true); // whole bbox is the solid block
  });
});
