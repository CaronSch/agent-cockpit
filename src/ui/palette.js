/**
 * "Add widget" palette. Items can be dragged onto the grid (pointer drag) or
 * activated with click / Enter. Like TapeSurf's popup, the palette fades out
 * while a drag is active so it never hides a drop target.
 */
import { newWidgetLeaf } from '../widgets/registry.js';
import { button, el } from './dom.js';
/** @import { WidgetDef } from '../widgets/registry.js' */
/** @import { DragController } from '../interaction/drag-controller.js' */
/** @typedef {{ setDragging(dragging: boolean): void }} Palette */

/** @param {WidgetDef} def */
function createItem(def) {
  const li = el('li');
  const item = button('palette-item');
  item.dataset.type = def.type;
  const glyph = el('span', 'palette-glyph', def.glyph);
  glyph.setAttribute('aria-hidden', 'true');
  item.append(glyph, el('span', 'palette-name', def.title), el('span', 'palette-desc', def.description));
  li.append(item);
  return li;
}

/**
 * `panel` is a popover with a `popovertarget` button: the platform opens and closes it, on
 * Esc or a click outside too, and hands focus back.
 * @param {{ panel: HTMLElement, widgets: Readonly<Record<string, WidgetDef>>,
 *   drag: DragController, onAdd: (type: string) => void }} options
 * @returns {Palette}
 */
export function createPalette({ panel, widgets, drag, onAdd }) {
  const list = /** @type {HTMLElement} */ (panel.querySelector('.palette-list'));
  list.replaceChildren(...Object.values(widgets).map(createItem));

  let suppressClick = false;

  panel.addEventListener('toggle', (event) => {
    if (/** @type {ToggleEvent} */ (event).newState !== 'open') return;
    /** @type {HTMLElement | null} */ (list.querySelector('.palette-item'))?.focus();
  });
  list.addEventListener('pointerdown', (event) => {
    const button = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('.palette-item'));
    suppressClick = false;
    if (!button) return;
    const def = widgets[/** @type {string} */ (button.dataset.type)];
    if (!def) return;
    drag.start({ kind: 'new', leaf: newWidgetLeaf(def.type) }, event, {
      label: def.title,
      onEnd: ({ activated }) => {
        suppressClick = activated;
      },
    });
  });

  list.addEventListener('click', (event) => {
    const button = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('.palette-item'));
    if (!button) return;
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    onAdd(/** @type {string} */ (button.dataset.type));
  });

  return {
    setDragging: (dragging) => panel.classList.toggle('is-dragged', dragging),
  };
}
