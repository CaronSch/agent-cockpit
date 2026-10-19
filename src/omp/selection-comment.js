/**
 * Comments on highlighted transcript text: select part of a reply and a small Comment button
 * appears at the end of the selection; it opens a box for the comment, which is handed to
 * the composer with the selected text as its quote.
 */
import { el } from '../ui/dom.js';
import { autosize } from '../ui/autosize.js';

const GAP_PX = 6;
const EDGE_PX = 8;
const COMMENT_MAX_PX = 160;

/**
 * @param {{ host: HTMLElement, transcript: HTMLElement, onComment: (quote: string, comment: string) => void }} options
 *   `host`: the positioned element the popup lives in; `transcript`: where selections count.
 */
export function attachSelectionComments({ host, transcript, onComment }) {
  const pop = el('div', 'omp-quote-pop');
  pop.hidden = true;
  host.append(pop);
  /** @type {'closed' | 'button' | 'editing'} */
  let mode = 'closed';
  let quote = '';

  function close() {
    mode = 'closed';
    pop.hidden = true;
    pop.replaceChildren();
  }

  /** Places the popup under (or, without room, over) `rect`, inside the host. @param {DOMRect} rect */
  function place(rect) {
    pop.hidden = false;
    const box = host.getBoundingClientRect();
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;
    const left = Math.min(Math.max(EDGE_PX, rect.right - box.left - width / 2), box.width - width - EDGE_PX);
    let top = rect.bottom - box.top + GAP_PX;
    if (top + height > box.height - EDGE_PX) top = Math.max(EDGE_PX, rect.top - box.top - height - GAP_PX);
    pop.style.left = `${Math.max(EDGE_PX, left)}px`;
    pop.style.top = `${top}px`;
  }

  /** The selected transcript text and where its last line ends, if there is one. */
  function selection() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!transcript.contains(range.commonAncestorContainer)) return null;
    const text = sel.toString().trim();
    const rects = range.getClientRects();
    const end = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    return text ? { text, end } : null;
  }

  function offerButton() {
    if (mode === 'editing') return;
    const found = selection();
    if (!found) return close();
    quote = found.text;
    const button = el('button', 'btn omp-quote-btn', 'Comment');
    button.type = 'button';
    button.title = 'Comment on the selected text; the comment goes with your next message';
    // Keep the selection (and its highlight) while the button is pressed.
    button.addEventListener('pointerdown', (e) => e.preventDefault());
    button.addEventListener('click', () => openEditor(found.end));
    pop.replaceChildren(button);
    mode = 'button';
    place(found.end);
  }

  /** @param {DOMRect} anchor */
  function openEditor(anchor) {
    mode = 'editing';
    const preview = el('blockquote', 'omp-quote-preview', quote);
    const box = el('textarea', 'omp-quote-input');
    box.rows = 2;
    box.placeholder = 'Your comment on this…';
    box.setAttribute('aria-label', 'Comment on the selected text');
    const add = el('button', 'btn btn-accent', 'Add comment');
    add.type = 'button';
    add.disabled = true;
    const cancel = el('button', 'btn', 'Cancel');
    cancel.type = 'button';
    const actions = el('div', 'omp-row');
    actions.append(add, cancel);
    pop.replaceChildren(preview, box, actions);
    place(anchor);
    box.focus();

    const submit = () => {
      const comment = box.value.trim();
      if (!comment) return;
      onComment(quote, comment);
      document.getSelection()?.removeAllRanges();
      close();
    };
    box.addEventListener('input', () => {
      add.disabled = !box.value.trim();
      autosize(box, { max: COMMENT_MAX_PX });
    });
    box.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        e.stopPropagation(); // not the pane's Esc-to-stop
        close();
      }
    });
    add.addEventListener('click', submit);
    cancel.addEventListener('click', close);
  }

  // A selection is finished when the mouse or a Shift+arrow key lets go.
  const onMouseUp = () => setTimeout(offerButton);
  /** @param {KeyboardEvent} e */
  const onKeyUp = (e) => {
    if (e.shiftKey) offerButton();
  };
  const onSelectionChange = () => {
    if (mode === 'button' && !selection()) close();
  };
  const onScroll = () => {
    if (mode === 'button') close();
  };
  /** @param {PointerEvent} e */
  const onOutside = (e) => {
    // A half-written comment is not thrown away by a stray click.
    if (mode !== 'editing' || pop.contains(/** @type {Node} */ (e.target))) return;
    const box = /** @type {HTMLTextAreaElement | null} */ (pop.querySelector('textarea'));
    if (!box?.value.trim()) close();
  };
  document.addEventListener('mouseup', onMouseUp);
  transcript.addEventListener('keyup', onKeyUp);
  transcript.addEventListener('scroll', onScroll);
  document.addEventListener('selectionchange', onSelectionChange);
  document.addEventListener('pointerdown', onOutside, true);

  return {
    destroy() {
      document.removeEventListener('mouseup', onMouseUp);
      transcript.removeEventListener('keyup', onKeyUp);
      transcript.removeEventListener('scroll', onScroll);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('pointerdown', onOutside, true);
      pop.remove();
    },
  };
}
