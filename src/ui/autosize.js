/** Grows a textarea to fit its text, up to a maximum height, after which it scrolls. */

/**
 * Call after every change to the textarea's value or width.
 * @param {HTMLTextAreaElement} textarea
 * @param {{ max?: number, scroller?: HTMLElement | null }} [options] `scroller`: a scrolling
 *   ancestor whose position must not jump while the textarea is briefly measured at its
 *   natural height.
 */
export function autosize(textarea, { max = Infinity, scroller = null } = {}) {
  const top = scroller?.scrollTop;
  textarea.style.height = 'auto';
  const border = textarea.offsetHeight - textarea.clientHeight;
  const natural = textarea.scrollHeight + border;
  textarea.style.height = `${Math.min(natural, max)}px`;
  textarea.style.overflowY = natural > max ? 'auto' : 'hidden';
  if (scroller && top !== undefined) scroller.scrollTop = top;
}
