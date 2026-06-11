/**
 * A genuine drawn-stereo obligation is a tetrahedral CARBON. Indigo's
 * `check('stereo')` (see indigo-stereo.ts) does graph-distinctness, not
 * resonance-aware chemical distinctness, so it over-flags non-carbon centers as
 * undefined stereocenters: sp2 planar amide/aromatic N; resonance-symmetric
 * phosphate P (its =O/O- are chemically equivalent but graph-distinct); sulfone
 * S; etc. Tetrahedral carbon has neither failure mode, so an Indigo-flagged
 * carbon IS a genuine obligation and any non-carbon flag is an over-perception.
 *
 * This gate governs ONLY the post-build demand/throw. Drawn wedges on ANY element
 * are applied upstream regardless, so a genuinely chiral non-carbon center
 * (e.g. a sulfoxide) is still encoded if drawn — carbon-only merely won't *demand*
 * one. The resonance-aware distinctness extension (Approach B in the design doc)
 * is the deliberate path if a future row needs a non-carbon center demanded.
 */
export function isCarbonStereoObligation(element: string): boolean {
  return element === 'C';
}
