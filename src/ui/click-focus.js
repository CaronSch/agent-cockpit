/**
 * Click-to-focus, as in a terminal: a plain click on a window's own surface puts the caret at
 * the end of its main text box, while clicks on controls, in boxes of their own, and those
 * that end a text selection do what they did before.
 *
 * That text box is marked as its window's main field (`data-main-field`), so a window can
 * also be focused from elsewhere the same way (`focusMainField`): the Sessions window jumps
 * to the omp window showing a session.
 */

/**
 * What a click is meant for already: controls, form fields, menus and anything focusable.
 * `summary` toggles its `details`; `label` toggles its field; `[popover]` is an open menu.
 */
const INTERACTIVE = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  'summary',
  'label',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]',
  '[popover]',
  '[role="button"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="tab"]',
].join(', ');

/**
 * Focuses `field` on a plain click anywhere in `surface`, without scrolling, unless the click
 * lands on (or in) a control, in an element matching `ignore`, or ends a text selection. It
 * acts on `click`, never on press, so dragging to select text keeps working.
 * @param {HTMLElement} surface @param {HTMLTextAreaElement} field
 * @param {string} ignore selector for regions whose clicks are their own (dialogs, popups)
 */
export function focusOnClick(surface, field, ignore) {
  field.dataset.mainField = '';
  surface.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    if (field.disabled) return;
    // The path as dispatched, not the target's ancestors now: a control's own handler may
    // already have replaced it (Comment swaps itself for its box), detaching it from the pane.
    const path = e.composedPath();
    const inside = path.slice(0, path.indexOf(surface));
    if (inside.some((node) => node instanceof Element && node.matches(`${INTERACTIVE}, ${ignore}`))) return;
    if (!(document.getSelection()?.isCollapsed ?? true)) return;
    focusField(field);
  });
}

/** Focuses `field` without scrolling, with the caret at the end of its text. @param {HTMLTextAreaElement} field */
function focusField(field) {
  field.focus({ preventScroll: true });
  const end = field.value.length;
  field.setSelectionRange(end, end);
}

/** Focuses the main field of the window `frame`, as a click on it does; false when it has none. @param {Element} frame */
export function focusMainField(frame) {
  const field = frame.querySelector('[data-main-field]');
  if (!(field instanceof HTMLTextAreaElement) || field.disabled) return false;
  focusField(field);
  return true;
}
