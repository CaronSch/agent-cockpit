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
 * @param {{ toggleButton: HTMLElement, panel: HTMLElement, widgets: Readonly<Record<string, WidgetDef>>,
 *   drag: DragController, onAdd: (type: string) => void }} options
 * @returns {Palette}
 */
export function createPalette({ toggleButton, panel, widgets, drag, onAdd }) {
  const list = /** @type {HTMLElement} */ (panel.querySelector('.palette-list'));
  list.replaceChildren(...Object.values(widgets).map(createItem));

  let suppressClick = false;

  const isOpen = () => !panel.hidden;

  /** @param {boolean} open */
  function setOpen(open) {
    panel.hidden = !open;
    toggleButton.setAttribute('aria-expanded', String(open));
    if (open) /** @type {HTMLElement | null} */ (list.querySelector('.palette-item'))?.focus();
  }

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

  toggleButton.addEventListener('click', () => setOpen(!isOpen()));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen() && !drag.isDragging()) {
      setOpen(false);
      toggleButton.focus();
    }
  });

  document.addEventListener('pointerdown', (event) => {
    if (!isOpen() || drag.isDragging()) return;
    const target = /** @type {Node | null} */ (event.target);
    if (panel.contains(target) || toggleButton.contains(target)) return;
    setOpen(false);
  });

  return {
    setDragging: (dragging) => panel.classList.toggle('is-dragged', dragging),
  };
}
