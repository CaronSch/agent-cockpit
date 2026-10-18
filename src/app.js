/**
 * Cockpit controller: owns the layout atom and wires rendering, interaction
 * and widgets together.
 */
import { applyDrop, branch, findLeaf, insertBeside, listLeaves, moveLeaf, removeLeaf, setLeafParams } from './layout/grid-model.js';
import { computeLayout } from './layout/compute-layout.js';
import { findNeighbor, DIRECTION_KEYS } from './layout/neighbors.js';
import { newLeaf } from './layout/new-leaf.js';
import { createAtom } from './state/atom.js';
import { loadLayout, saveLayout } from './state/persistence.js';
import { createGridRenderer } from './render/grid-renderer.js';
import { createDropIndicator } from './render/drop-indicator.js';
import { attachSashController } from './interaction/sash-controller.js';
import { createDragController } from './interaction/drag-controller.js';
import { createPalette } from './ui/palette.js';
import { el } from './ui/dom.js';
import { WIDGETS } from './widgets/registry.js';
/** @import { Leaf, LeafParams, Tree } from './layout/grid-model.js' */
/** @import { WidgetContext } from './widgets/registry.js' */
/** @import { Rect } from './layout/compute-layout.js' */
/** @import { Palette } from './ui/palette.js' */
/** @import { GridApi } from './interaction/drag-controller.js' */

export const LAYOUT_OPTIONS = Object.freeze({ gap: 6, minWidth: 180, minHeight: 120 });
const SAVE_DELAY_MS = 250;
const STACK_BREAKPOINT = 640;
const STACK_ROW_HEIGHT = 260;

/**
 * @template {Element} [T=HTMLElement]
 * @param {ParentNode} root @param {string} selector
 * @returns {T}
 */
function query(root, selector) {
  const node = /** @type {T | null} */ (root.querySelector(selector));
  if (!node) throw new Error(`[app] missing required element ${selector}`);
  return node;
}

/** @param {Map<string, Rect>} leaves @returns {[string, Rect] | null} */
const largestLeaf = (leaves) =>
  [...leaves].reduce(
    (/** @type {[string, Rect] | null} */ best, entry) =>
      !best || entry[1].w * entry[1].h > best[1].w * best[1].h ? entry : best,
    null,
  );

/**
 * Narrow screens show the same widgets as a scrolling column; the saved tree is untouched.
 * @param {Tree} tree @returns {Tree}
 */
function stackProjection(tree) {
  const leaves = listLeaves(tree);
  return leaves.length > 1 ? branch('col', leaves) : (leaves[0] ?? null);
}

/** @param {ParentNode} root */
export function createApp(root) {
  const gridEl = query(root, '#grid');
  const deckEl = query(root, '.deck');
  const emptyEl = query(root, '.grid-empty');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const saved = loadLayout();
  const layoutAtom = createAtom(saved ?? null);
  const indicator = createDropIndicator(gridEl);

  let bounds = { x: 0, y: 0, w: 0, h: 0 };
  let layout = computeLayout(null, bounds, LAYOUT_OPTIONS);
  let frame = 0;
  let pendingAnimate = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let saveTimer;
  /** @type {Palette | null} */
  let palette = null;

  /** @param {Leaf} leaf */
  function mountWidget(leaf) {
    const def = WIDGETS[leaf.widget];
    const title = def?.title ?? `Unknown widget (${leaf.widget})`;
    const frameEl = el('article', 'widget');
    frameEl.dataset.id = leaf.id;
    frameEl.dataset.widget = leaf.widget;
    frameEl.setAttribute('aria-labelledby', `title-${leaf.id}`);

    const head = el('header', 'widget-head');
    const grip = el('button', 'widget-grip', '⠿');
    grip.type = 'button';
    grip.setAttribute('aria-label', `Move ${title}: drag, or Alt+Shift+Arrow keys`);
    const glyph = el('span', 'widget-glyph', def?.glyph ?? '?');
    glyph.setAttribute('aria-hidden', 'true');
    const heading = el('h2', 'widget-title', title);
    heading.id = `title-${leaf.id}`;
    const close = el('button', 'widget-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', `Close ${title}`);
    head.append(grip, glyph, heading, close);

    const body = el('div', 'widget-body');
    frameEl.append(head, body);

    /** @type {WidgetContext} */
    const ctx = {
      // Read through the atom, not the mount-time leaf: params change after mount.
      get params() {
        return findLeaf(layoutAtom.get(), leaf.id)?.params ?? {};
      },
      setParams: (/** @type {LeafParams} */ patch) => api.commitTree(setLeafParams(layoutAtom.get(), leaf.id, patch)),
    };

    let instance = { destroy() {} };
    if (!def) {
      body.append(el('p', 'widget-empty', 'This widget type is not installed.'));
    } else {
      try {
        instance = def.mount(body, ctx) ?? instance;
      } catch (err) {
        console.error(`[app] widget "${leaf.widget}" failed to mount`, err);
        body.replaceChildren(el('p', 'widget-empty widget-error', 'This widget failed to load.'));
      }
    }
    return { el: frameEl, destroy: () => instance.destroy?.() };
  }

  const renderer = createGridRenderer(gridEl, { mountWidget, prefersReducedMotion: () => reducedMotion.matches });

  const isStacked = () => bounds.w > 0 && bounds.w < STACK_BREAKPOINT;

  /** @param {Tree} tree @param {boolean} animate */
  function draw(tree, animate) {
    const stacked = isStacked();
    const shown = stacked ? stackProjection(tree) : tree;
    const count = listLeaves(shown).length;
    const frameBounds = stacked
      ? { ...bounds, h: Math.max(bounds.h, count * STACK_ROW_HEIGHT + LAYOUT_OPTIONS.gap * (count - 1)) }
      : bounds;
    const height = stacked ? `${frameBounds.h}px` : '';
    if (gridEl.style.height !== height) gridEl.style.height = height;
    gridEl.classList.toggle('is-stacked', stacked);

    layout = computeLayout(shown, frameBounds, LAYOUT_OPTIONS);
    renderer.render(shown, layout, { animate });
    emptyEl.hidden = Boolean(tree);
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const animate = pendingAnimate;
      pendingAnimate = false;
      draw(layoutAtom.get(), animate);
    });
  }

  /** @type {GridApi} */
  const api = {
    gridEl,
    indicator,
    layoutOptions: LAYOUT_OPTIONS,
    getTree: () => layoutAtom.get(),
    getLayout: () => layout,
    getBounds: () => bounds,
    isStacked,
    frameElement: (/** @type {string} */ id) => renderer.frameElement(id),
    previewTree: (/** @type {Tree} */ tree) => draw(tree, false),
    /** @param {Tree} tree @param {{ animate?: boolean }} [options] */
    commitTree(tree, { animate = false } = {}) {
      pendingAnimate = pendingAnimate || animate;
      layoutAtom.set(tree);
      schedule();
    },
    onDragStateChange: (/** @type {boolean} */ dragging) => palette?.setDragging(dragging),
  };

  layoutAtom.subscribe((/** @type {Tree} */ tree) => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      saveLayout(tree);
    }, SAVE_DELAY_MS);
  });
  // A reload or close inside the debounce window would otherwise lose the last change.
  window.addEventListener('pagehide', () => {
    if (saveTimer === undefined) return;
    clearTimeout(saveTimer);
    saveTimer = undefined;
    saveLayout(layoutAtom.get());
  });

  new ResizeObserver(([entry]) => {
    bounds = { x: 0, y: 0, w: Math.floor(entry.contentRect.width), h: Math.floor(entry.contentRect.height) };
    draw(layoutAtom.get(), false);
  }).observe(deckEl);

  /** @param {string} type */
  function addWidget(type) {
    const leaf = newLeaf(type);
    const tree = layoutAtom.get();
    const target = largestLeaf(layout.leaves);
    const next =
      tree && target ? insertBeside(tree, target[0], target[1].w >= target[1].h ? 'right' : 'down', leaf) : leaf;
    api.commitTree(next, { animate: true });
  }

  attachSashController(api);
  const drag = createDragController(api);

  gridEl.addEventListener('pointerdown', (event) => {
    const target = /** @type {Element} */ (event.target);
    const head = target.closest('.widget-head');
    if (!head || isStacked() || target.closest('.widget-close')) return;
    const frameEl = /** @type {HTMLElement} */ (head.closest('.widget'));
    drag.start({ kind: 'move', id: /** @type {string} */ (frameEl.dataset.id) }, event, {
      label: /** @type {Element} */ (head.querySelector('.widget-title')).textContent,
    });
  });

  gridEl.addEventListener('click', (event) => {
    const close = /** @type {Element} */ (event.target).closest('.widget-close');
    if (!close) return;
    const id = /** @type {string} */ (/** @type {HTMLElement} */ (close.closest('.widget')).dataset.id);
    api.commitTree(removeLeaf(layoutAtom.get(), id), { animate: true });
  });

  gridEl.addEventListener('keydown', (event) => {
    const grip = /** @type {Element} */ (event.target).closest?.('.widget-grip');
    if (!grip) return;
    const id = /** @type {string} */ (/** @type {HTMLElement} */ (grip.closest('.widget')).dataset.id);
    const tree = layoutAtom.get();
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      api.commitTree(removeLeaf(tree, id), { animate: true });
      return;
    }
    const dir = DIRECTION_KEYS[event.key];
    if (!dir || !event.altKey || !event.shiftKey) return;
    event.preventDefault();
    const neighbor = findNeighbor(layout.leaves, id, dir);
    const next = neighbor
      ? moveLeaf(tree, id, neighbor, dir)
      : applyDrop(tree, { source: { kind: 'move', id }, target: { kind: 'edge' }, dir });
    api.commitTree(next, { animate: true });
  });

  palette = createPalette({
    toggleButton: query(root, '#palette-toggle'),
    panel: query(root, '#palette'),
    widgets: WIDGETS,
    drag,
    onAdd: addWidget,
  });

  schedule();
  return { api };
}
