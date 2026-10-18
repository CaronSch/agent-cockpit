/**
 * "Add widget" palette. Items can be dragged onto the grid (pointer drag) or
 * activated with click / Enter. Like TapeSurf's popup, the palette fades out
 * while a drag is active so it never hides a drop target.
 */
import { newLeaf } from '../layout/new-leaf.js';
/** @import { WidgetDef } from '../widgets/registry.js' */
/** @import { DragController } from '../interaction/drag-controller.js' */
/** @typedef {{ open(): void, close(): void, setDragging(dragging: boolean): void }} Palette */

/** @param {WidgetDef} def */
function createItem(def) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'palette-item';
  button.dataset.type = def.type;

  const glyph = document.createElement('span');
  glyph.className = 'palette-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = def.glyph;

  const name = document.createElement('span');
  name.className = 'palette-name';
  name.textContent = def.title;

  const desc = document.createElement('span');
  desc.className = 'palette-desc';
  desc.textContent = def.description;

  button.append(glyph, name, desc);
  li.append(button);
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
    drag.start({ kind: 'new', leaf: newLeaf(def.type) }, event, {
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
    open: () => setOpen(true),
    close: () => setOpen(false),
    setDragging: (dragging) => panel.classList.toggle('is-dragged', dragging),
  };
}
