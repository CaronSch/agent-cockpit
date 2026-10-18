/** Geometric neighbour lookup for keyboard moves (Alt+Shift+Arrow). */

/** @import { Rect } from './compute-layout.js' */
/** @typedef {'left' | 'right' | 'up' | 'down'} Side */

/** Arrow key → move direction; any other key is absent. @type {Readonly<Partial<Record<string, Side>>>} */
export const DIRECTION_KEYS = Object.freeze({
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
});

const TOLERANCE = 1;

/** @param {Rect} from @param {Rect} r @param {Side} dir */
function isInDirection(from, r, dir) {
  switch (dir) {
    case 'left':
      return r.x + r.w <= from.x + TOLERANCE;
    case 'right':
      return r.x >= from.x + from.w - TOLERANCE;
    case 'up':
      return r.y + r.h <= from.y + TOLERANCE;
    case 'down':
      return r.y >= from.y + from.h - TOLERANCE;
    default:
      return false;
  }
}

/** @param {Rect} from @param {Rect} r @param {Side} dir */
function score(from, r, dir) {
  const horizontal = dir === 'left' || dir === 'right';
  const along = {
    left: from.x - (r.x + r.w),
    right: r.x - (from.x + from.w),
    up: from.y - (r.y + r.h),
    down: r.y - (from.y + from.h),
  }[dir];
  const fromCenter = horizontal ? from.y + from.h / 2 : from.x + from.w / 2;
  const candidateCenter = horizontal ? r.y + r.h / 2 : r.x + r.w / 2;
  return Math.max(0, along) + Math.abs(fromCenter - candidateCenter) * 0.5;
}

/**
 * Returns the id of the closest leaf in `dir`, or null. `rects` is Map<id, rect>.
 * @param {ReadonlyMap<string, Rect>} rects @param {string} id @param {Side} dir
 * @returns {string | null}
 */
export function findNeighbor(rects, id, dir) {
  const from = rects.get(id);
  if (!from) return null;

  const best = [...rects]
    .filter(([otherId, r]) => otherId !== id && isInDirection(from, r, dir))
    .map(([otherId, r]) => ({ otherId, s: score(from, r, dir) }))
    .reduce((/** @type {{ otherId: string, s: number } | null} */ acc, c) => (acc === null || c.s < acc.s ? c : acc), /** @type {{ otherId: string, s: number } | null} */ (null));

  return best?.otherId ?? null;
}
