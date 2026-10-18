/**
 * Magnetic sash behaviour: detents pull the sash onto aligned positions,
 * then minimum sizes clamp the result.
 */

/** @import { Sash } from './compute-layout.js' */
/** @typedef {{ value: number, snapped: number | null }} SnapResult */
/** @typedef {{ pos: number, snapped: number | null }} SashResolution */
/** Sash fields `sashCandidates` reads. @typedef {Pick<Sash, 'axis' | 'start' | 'end' | 'w' | 'h' | 'pos'>} SashGeometry */

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** @param {number} value @param {readonly number[]} candidates @param {number} threshold @returns {SnapResult} */
export function snapToCandidates(value, candidates, threshold) {
  const best = candidates.reduce(
    (acc, c) => {
      const dist = Math.abs(c - value);
      return dist <= threshold && dist < acc.dist ? { c, dist } : acc;
    },
    /** @type {{ c: number | null, dist: number }} */ ({ c: null, dist: Infinity }),
  );
  return best.c === null ? { value, snapped: null } : { value: best.c, snapped: best.c };
}

/**
 * `pos` is the pixel where the sash gap begins (end of the "before" child).
 * Candidates that would break a minimum size are ignored, not clamped onto.
 * @param {{ proposed: number, start: number, end: number, gap: number, minBefore: number,
 *   minAfter: number, candidates: readonly number[], threshold: number }} args
 * @returns {SashResolution}
 */
export function resolveSashPosition({ proposed, start, end, gap, minBefore, minAfter, candidates, threshold }) {
  const lo = start + minBefore;
  const hi = Math.max(lo, end - gap - minAfter);
  const reachable = candidates.filter((c) => c >= lo && c <= hi);
  const { value, snapped } = snapToCandidates(proposed, reachable, threshold);
  return { pos: Math.round(clamp(value, lo, hi)), snapped };
}

/**
 * Convert a sash pixel position back into fractions for the two adjacent children.
 * @param {{ sizes: number[], index: number, pos: number, pairStart: number, pairEnd: number, gap: number }} args
 * @returns {number[]}
 */
export function sizesFromSash({ sizes, index, pos, pairStart, pairEnd, gap }) {
  const pairPx = pairEnd - pairStart - gap;
  if (pairPx <= 0) return sizes;
  const pairTotal = sizes[index] + sizes[index + 1];
  const ratio = clamp((pos - pairStart) / pairPx, 0, 1);
  return sizes.map((s, i) => {
    if (i === index) return pairTotal * ratio;
    if (i === index + 1) return pairTotal * (1 - ratio);
    return s;
  });
}

/**
 * Detents for a sash: other sashes on the same axis plus 1/3, 1/2, 2/3 of its pair.
 * @param {SashGeometry} sash @param {readonly Pick<Sash, 'axis' | 'pos'>[]} allSashes @returns {number[]}
 */
export function sashCandidates(sash, allSashes) {
  const pairPx = sash.end - sash.start - (sash.axis === 'row' ? sash.w : sash.h);
  const fractions = [1 / 3, 1 / 2, 2 / 3].map((f) => Math.round(sash.start + pairPx * f));
  const aligned = allSashes.filter((s) => s !== sash && s.axis === sash.axis).map((s) => s.pos);
  return [...aligned, ...fractions];
}
