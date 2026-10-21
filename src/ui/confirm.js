/**
 * Asking before an action that cannot be undone: a small popover beside the button that asked
 * for it, saying what will happen, with the action and Cancel (Esc or a click elsewhere cancel too).
 */
import { button, el } from './dom.js';

/**
 * @param {HTMLElement} anchor the button the user pressed
 * @param {{ message: string, action: string, run: () => void }} options
 */
export function confirmBeside(anchor, { message, action, run }) {
  const box = el('div', 'confirm');
  box.popover = 'auto';
  box.setAttribute('role', 'alertdialog');
  box.setAttribute('aria-label', message);
  const yes = button('btn btn-danger', action, () => {
    box.hidePopover();
    run();
  });
  const no = button('btn', 'Cancel', () => box.hidePopover());
  const actions = el('div', 'confirm-actions');
  actions.append(yes, no);
  box.append(el('p', 'confirm-text', message), actions);
  box.addEventListener('toggle', (event) => {
    if (/** @type {ToggleEvent} */ (event).newState === 'closed') box.remove();
  });
  document.body.append(box);
  box.showPopover({ source: anchor });
  yes.focus();
}
