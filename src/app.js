/**
 * Cockpit controller: owns the layout atom and wires rendering, interaction and widgets together.
 *
 * The layout is this window's screen of its workspace (workspace/screen.js), which the daemon
 * keeps; the app starts once the screen is claimed and loaded.
 */
import { applyDrop, branch, findLeaf, insertBeside, listLeaves, moveLeaf, removeLeaf, setLeafParams } from './layout/grid-model.js';
import { computeLayout } from './layout/compute-layout.js';
import { findNeighbor, DIRECTION_KEYS } from './layout/neighbors.js';
import { createAtom } from './state/atom.js';
import { createGridRenderer } from './render/grid-renderer.js';
import { createDropIndicator } from './render/drop-indicator.js';
import { attachSashController } from './interaction/sash-controller.js';
import { createDragController } from './interaction/drag-controller.js';
import { createPalette } from './ui/palette.js';
import { createScreenSwitcher } from './ui/screen-switcher.js';
import { createUpdateNotice } from './ui/update-notice.js';
import { button, el } from './ui/dom.js';
import { getDaemon } from './daemon/client.js';
import { openScreen } from './workspace/screen.js';
import { describeWindows } from './workspace/model.js';
import { WIDGETS, newWidgetLeaf } from './widgets/registry.js';
/** @import { Leaf, LeafParams, Tree } from './layout/grid-model.js' */
/** @import { WidgetContext } from './widgets/registry.js' */
/** @import { Rect } from './layout/compute-layout.js' */
/** @import { Palette } from './ui/palette.js' */
/** @import { GridApi } from './interaction/drag-controller.js' */

export const LAYOUT_OPTIONS = Object.freeze({ gap: 6, minWidth: 180, minHeight: 120 });
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

/** @param {string} widget */
const titleOf = (widget) => WIDGETS[widget]?.title ?? widget;

/** @param {ParentNode} root */
export async function createApp(root) {
  const gridEl = query(root, '#grid');
  const deckEl = query(root, '.deck');
  const emptyEl = query(root, '.grid-empty');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const daemon = getDaemon();
  const opened = await openScreen({ daemon });
  const layoutAtom = createAtom(opened.ok ? opened.screen.tree() : null);
  const indicator = createDropIndicator(gridEl);

  let bounds = { x: 0, y: 0, w: 0, h: 0 };
  let layout = computeLayout(null, bounds, LAYOUT_OPTIONS);
  let frame = 0;
  let pendingAnimate = false;
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
    const grip = button('widget-grip', '⠿');
    grip.setAttribute('aria-label', `Move ${title}: drag, or Alt+Shift+Arrow keys`);
    const glyph = el('span', 'widget-glyph', def?.glyph ?? '?');
    glyph.setAttribute('aria-hidden', 'true');
    const heading = el('h2', 'widget-title', title);
    heading.id = `title-${leaf.id}`;
    // What the window shows, beside its type: part of the heading, so it names the window too.
    const label = el('span', 'widget-label');
    label.hidden = true;
    heading.append(' ', label); // a space, so the heading reads "omp <name>", not "omp<name>"
    const close = button('widget-close', '×');
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
      addWidget: (/** @type {string} */ type, /** @type {LeafParams} */ params) => addWidget(type, params),
      showWidget: (/** @type {string} */ type, /** @type {LeafParams} */ params) => showWidget(type, params),
      dragWidget(/** @type {string} */ type, /** @type {LeafParams} */ params, /** @type {PointerEvent} */ event, options = {}) {
        drag.start({ kind: 'new', leaf: newWidgetLeaf(type, params), into: options.into }, event, {
          label: options.label ?? WIDGETS[type]?.title ?? type,
          onEnd: options.onEnd,
        });
      },
      setUnread(/** @type {boolean} */ unread) {
        frameEl.classList.toggle('is-unread', unread);
        frameEl.dataset.unread = String(unread);
      },
      setLabel(/** @type {string | null} */ text) {
        if (label.textContent === (text ?? '')) return;
        label.textContent = text ?? '';
        label.hidden = !text;
        heading.title = text ?? '';
      },
    };

    /** @type {{ destroy(): void, paramsChanged?(): void }} */
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
    // Settings also change from outside the window: another window shows something in it.
    let params = leaf.params;
    const offParams = layoutAtom.subscribe((tree) => {
      const next = findLeaf(tree, leaf.id)?.params;
      if (next === params) return;
      params = next;
      instance.paramsChanged?.();
    });
    return {
      el: frameEl,
      destroy() {
        offParams();
        instance.destroy?.();
      },
    };
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

  if (opened.ok) layoutAtom.subscribe((/** @type {Tree} */ tree) => opened.screen.update(tree));

  new ResizeObserver(([entry]) => {
    bounds = { x: 0, y: 0, w: Math.floor(entry.contentRect.width), h: Math.floor(entry.contentRect.height) };
    draw(layoutAtom.get(), false);
  }).observe(deckEl);

  /** @param {string} type @param {LeafParams} [params] */
  function addWidget(type, params) {
    const leaf = newWidgetLeaf(type, params);
    const tree = layoutAtom.get();
    const target = largestLeaf(layout.leaves);
    const next =
      tree && target ? insertBeside(tree, target[0], target[1].w >= target[1].h ? 'right' : 'down', leaf) : leaf;
    api.commitTree(next, { animate: true });
  }

  /** When each window was last used (pressed or focused), in order of use. @type {Map<string, number>} */
  const usedAt = new Map();
  let uses = 0;
  for (const type of ['pointerdown', 'focusin']) {
    gridEl.addEventListener(
      type,
      (event) => {
        const id = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest?.('.widget'))?.dataset.id;
        if (id) usedAt.set(id, ++uses);
      },
      { capture: true },
    );
  }

  /**
   * Shows `params` in the window of `type` used last in this screen, else the first one; opens
   * a new window when there is none.
   * @param {string} type @param {LeafParams} params
   */
  function showWidget(type, params) {
    const tree = layoutAtom.get();
    const windows = listLeaves(tree).filter((l) => l.widget === type);
    const target = windows.reduce((best, l) => ((usedAt.get(l.id) ?? 0) > (usedAt.get(best.id) ?? 0) ? l : best), windows[0]);
    if (!target) return addWidget(type, params);
    api.commitTree(setLeafParams(tree, target.id, params));
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
    panel: query(root, '#palette'),
    widgets: WIDGETS,
    drag,
    onAdd: addWidget,
  });

  query(root, '.brand').after(createUpdateNotice({ daemon }).root);
  query(root, '.topbar-actions').prepend(
    createScreenSwitcher({ opened, describe: (tree) => describeWindows(tree, titleOf) }).root,
  );

  schedule();
  return { api };
}
