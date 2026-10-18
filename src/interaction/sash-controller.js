/**
 * Sash (divider) resizing with magnetic detents.
 *
 * pointermove only records coordinates; one rAF per frame resolves the snapped
 * position and previews the tree. The store is committed once, on release.
 * Hold Alt to resize freely without snapping.
 */
import { nodeAt, setSizes } from '../layout/grid-model.js';
import { resolveSashPosition, sizesFromSash, sashCandidates } from '../layout/snap.js';
import { sashKey } from '../render/grid-renderer.js';

/** @import { Axis, Tree } from '../layout/grid-model.js' */
/** @import { Sash } from '../layout/compute-layout.js' */
/** @import { GridApi } from './drag-controller.js' */
/** @typedef {{ sash: Sash, tree: Tree, sizes: number[], gap: number, candidates: number[] }} SashSnapshot */
/** @typedef {{ clientX: number, clientY: number, altKey?: boolean }} PointerSample */
/**
 * @typedef {SashSnapshot & { el: HTMLElement, pointerId: number, origin: number, latest: PointerSample,
 *   frame: number, nextTree: Tree }} SashSession
 */

const SNAP_THRESHOLD = 8;
const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

/** @type {Readonly<Record<Axis, Readonly<Record<string, number>>>>} */
const KEY_DELTAS = {
  row: { ArrowLeft: -1, ArrowRight: 1 },
  col: { ArrowUp: -1, ArrowDown: 1 },
};

/** @param {GridApi} app */
export function attachSashController(app) {
  const { gridEl, indicator } = app;
  /** @type {SashSession | null} */
  let session = null;

  /** @param {string | undefined} key */
  const findSash = (key) => app.getLayout().sashes.find((s) => sashKey(s) === key) ?? null;
  /** @param {Axis} axis @param {PointerSample} point */
  const coord = (axis, point) => (axis === 'row' ? point.clientX : point.clientY);

  /** @param {Sash} sash @returns {SashSnapshot} */
  function snapshot(sash) {
    const tree = app.getTree();
    const node = nodeAt(tree, sash.path);
    return {
      sash,
      tree,
      sizes: node?.kind === 'branch' ? node.sizes : [],
      gap: sash.axis === 'row' ? sash.w : sash.h,
      candidates: sashCandidates(sash, app.getLayout().sashes),
    };
  }

  /** @param {SashSnapshot} snap @param {number} proposed @param {boolean} useSnapping */
  function resolve(snap, proposed, useSnapping) {
    const { sash, gap } = snap;
    const { pos, snapped } = resolveSashPosition({
      proposed,
      start: sash.start,
      end: sash.end,
      gap,
      minBefore: sash.minBefore,
      minAfter: sash.minAfter,
      candidates: useSnapping ? snap.candidates : [],
      threshold: SNAP_THRESHOLD,
    });
    const sizes = sizesFromSash({ sizes: snap.sizes, index: sash.index, pos, pairStart: sash.start, pairEnd: sash.end, gap });
    return { tree: setSizes(snap.tree, sash.path, sizes), pos, snapped };
  }

  function frame() {
    if (!session) return;
    session.frame = 0;
    const { sash, gap, origin, latest } = session;
    const result = resolve(session, sash.pos + coord(sash.axis, latest) - origin, !latest.altKey);
    session.nextTree = result.tree;
    app.previewTree(result.tree);
    if (result.snapped === null) indicator.hideGuide();
    else indicator.showGuide(sash.axis, result.pos + gap / 2);
  }

  /** @param {PointerEvent} event */
  function onPointerDown(event) {
    const el = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('.sash'));
    if (!el || event.button !== 0 || session) return;
    const sash = findSash(el.dataset.key);
    if (!sash) return;

    event.preventDefault();
    el.setPointerCapture(event.pointerId);
    const snap = snapshot(sash);
    session = { ...snap, el, pointerId: event.pointerId, origin: coord(sash.axis, event), latest: event, frame: 0, nextTree: snap.tree };
    gridEl.classList.add('is-resizing');
    el.classList.add('is-active');
  }

  /** @param {PointerEvent} event */
  function onPointerMove(event) {
    if (!session || event.pointerId !== session.pointerId) return;
    session.latest = { clientX: event.clientX, clientY: event.clientY, altKey: event.altKey };
    if (!session.frame) session.frame = requestAnimationFrame(frame);
  }

  /** @param {PointerEvent} event */
  function onPointerEnd(event) {
    if (!session || event.pointerId !== session.pointerId) return;
    const { el, frame: pending, tree, nextTree } = session;
    if (pending) cancelAnimationFrame(pending);
    if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
    el.classList.remove('is-active');
    gridEl.classList.remove('is-resizing');
    indicator.hideGuide();
    session = null;
    if (nextTree !== tree) app.commitTree(nextTree);
  }

  /** @param {MouseEvent} event */
  function onDoubleClick(event) {
    const el = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('.sash'));
    const sash = el && findSash(el.dataset.key);
    if (!sash) return;
    const snap = snapshot(sash);
    const gap = snap.gap;
    const midpoint = Math.round(sash.start + (sash.end - sash.start - gap) / 2);
    app.commitTree(resolve(snap, midpoint, false).tree, { animate: true });
  }

  /** @param {KeyboardEvent} event */
  function onKeyDown(event) {
    const target = event.target;
    const el = target instanceof Element ? /** @type {HTMLElement | null} */ (target.closest('.sash')) : null;
    const sash = el && findSash(el.dataset.key);
    if (!sash) return;
    const direction = KEY_DELTAS[sash.axis][event.key];
    if (!direction) return;
    event.preventDefault();
    const step = (event.shiftKey ? KEY_STEP_LARGE : KEY_STEP) * direction;
    app.commitTree(resolve(snapshot(sash), sash.pos + step, false).tree);
  }

  gridEl.addEventListener('pointerdown', onPointerDown);
  gridEl.addEventListener('pointermove', onPointerMove);
  gridEl.addEventListener('pointerup', onPointerEnd);
  gridEl.addEventListener('pointercancel', onPointerEnd);
  gridEl.addEventListener('dblclick', onDoubleClick);
  gridEl.addEventListener('keydown', onKeyDown);

  return () => {
    gridEl.removeEventListener('pointerdown', onPointerDown);
    gridEl.removeEventListener('pointermove', onPointerMove);
    gridEl.removeEventListener('pointerup', onPointerEnd);
    gridEl.removeEventListener('pointercancel', onPointerEnd);
    gridEl.removeEventListener('dblclick', onDoubleClick);
    gridEl.removeEventListener('keydown', onKeyDown);
  };
}
