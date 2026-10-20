/**
 * Actions on highlighted transcript text: select part of a reply and Comment and Ask buttons
 * appear at the end of the selection. Comment opens a box for a comment, handed to the
 * composer with the selected text as its quote. Ask opens a box for a side question about it,
 * whose short answer streams into the popup and never enters the chat (omp's `btw`).
 */
import { button, el } from '../ui/dom.js';
import { autosize } from '../ui/autosize.js';
import { renderMarkdown } from './markdown-dom.js';
/** @import { SideAnswer } from './transcript.js' */

const GAP_PX = 6;
const EDGE_PX = 8;
const INPUT_MAX_PX = 160;

/**
 * How Ask reaches omp: `send` starts a side question about `quote` and answers with omp's id
 * for it (or why it could not); `answer` reads the answer so far; `cancel` stops one running.
 * @typedef {{
 *   send(quote: string, question: string): Promise<{ id: string } | { error: string }>,
 *   answer(id: string): SideAnswer | undefined,
 *   cancel(id: string): void,
 * }} SideQuestions
 */

/** What each action's box says. */
const ACTIONS = {
  comment: { placeholder: 'Your comment on this…', label: 'Comment on the selected text', submit: 'Add comment' },
  ask: { placeholder: 'Ask about this; the answer stays out of the chat…', label: 'Ask about the selected text', submit: 'Ask' },
};

/**
 * @param {{
 *   host: HTMLElement,
 *   transcript: HTMLElement,
 *   onComment: (quote: string, comment: string) => void,
 *   ask: SideQuestions,
 * }} options `host`: the positioned element the popup lives in; `transcript`: where selections count.
 * Call `refresh()` whenever the session's state changes, so a shown answer keeps up.
 */
export function attachSelectionPopup({ host, transcript, onComment, ask }) {
  const pop = el('div', 'omp-quote-pop');
  pop.hidden = true;
  host.append(pop);
  /** @type {'closed' | 'buttons' | 'editing' | 'answer'} */
  let mode = 'closed';
  let quote = '';
  /** omp's id for the side question shown, once it has taken it. @type {string | null} */
  let askId = null;
  /** Bumped on close, so a question still on its way is cancelled once omp names it. */
  let generation = 0;
  /** Redraws the shown answer; null unless one is shown. @type {(() => void) | null} */
  let drawAnswer = null;

  const running = () => mode === 'answer' && (askId === null || ask.answer(askId)?.status === 'running');

  function close() {
    if (askId !== null && ask.answer(askId)?.status === 'running') ask.cancel(askId);
    generation++;
    askId = null;
    drawAnswer = null;
    mode = 'closed';
    pop.hidden = true;
    pop.classList.remove('is-answer');
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

  /** @param {string} label @param {string} title @param {() => void} onClick */
  function actionButton(label, title, onClick) {
    const action = button('btn omp-quote-btn', label, onClick);
    action.title = title;
    // Keep the selection (and its highlight) while the button is pressed.
    action.addEventListener('pointerdown', (e) => e.preventDefault());
    return action;
  }

  function offerButtons() {
    if (mode === 'editing') return;
    const found = selection();
    // A shown answer stays until it is closed, or replaced by a new selection once complete.
    if (mode === 'answer' && (!found || running())) return;
    if (!found) return close();
    close();
    quote = found.text;
    pop.replaceChildren(
      actionButton('Comment', 'Comment on the selected text; the comment goes with your next message', () => openEditor(found.end, 'comment')),
      actionButton('Ask', 'Ask a quick question about the selected text; the answer is not added to the chat', () => openEditor(found.end, 'ask')),
    );
    mode = 'buttons';
    place(found.end);
  }

  /** @param {DOMRect} anchor @param {keyof typeof ACTIONS} action */
  function openEditor(anchor, action) {
    const words = ACTIONS[action];
    mode = 'editing';
    const preview = el('blockquote', 'omp-quote-preview', quote);
    const box = el('textarea', 'omp-quote-input');
    box.rows = 2;
    box.placeholder = words.placeholder;
    box.setAttribute('aria-label', words.label);
    const submitBtn = button('btn btn-accent', words.submit);
    submitBtn.disabled = true;
    const cancel = button('btn', 'Cancel');
    const actions = el('div', 'omp-row');
    actions.append(submitBtn, cancel);
    pop.replaceChildren(preview, box, actions);
    place(anchor);
    box.focus();

    const submit = () => {
      const text = box.value.trim();
      if (!text) return;
      document.getSelection()?.removeAllRanges();
      if (action === 'comment') {
        onComment(quote, text);
        close();
      } else {
        showAnswer(anchor, text);
      }
    };
    box.addEventListener('input', () => {
      submitBtn.disabled = !box.value.trim();
      autosize(box, { max: INPUT_MAX_PX });
    });
    box.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });
    submitBtn.addEventListener('click', submit);
    cancel.addEventListener('click', close);
  }

  /** Asks omp the side question and shows its answer as it streams in. @param {DOMRect} anchor @param {string} question */
  function showAnswer(anchor, question) {
    mode = 'answer';
    pop.classList.add('is-answer');
    const body = el('div', 'omp-ask-answer');
    body.setAttribute('aria-live', 'polite');
    const closeBtn = button('btn', 'Close', close);
    const actions = el('div', 'omp-row');
    actions.append(closeBtn);
    pop.replaceChildren(el('blockquote', 'omp-quote-preview', quote), el('p', 'omp-ask-question', question), body, actions);
    closeBtn.focus(); // Esc closes from here

    let drawn = '';
    /** @param {string} key @param {() => Node} build */
    const show = (key, build) => {
      if (key === drawn) return;
      drawn = key;
      body.replaceChildren(build());
      place(anchor);
    };
    const status = (/** @type {string} */ text, cls = 'omp-ask-status') => () => el('p', cls, text);
    drawAnswer = () => {
      const answer = askId === null ? undefined : ask.answer(askId);
      if (!answer || (answer.status === 'running' && !answer.answer)) return show('waiting', status('Thinking…'));
      if (answer.status === 'error') return show(`error:${answer.error}`, status(answer.error ?? 'The question failed.', 'omp-ask-error'));
      if (!answer.answer) return show('stopped', status('Stopped before it answered.'));
      show(`${answer.status}:${answer.answer}`, () => renderMarkdown(answer.answer));
    };
    drawAnswer();

    const asked = generation;
    void ask.send(quote, question).then((result) => {
      if ('error' in result) {
        if (asked === generation) show(`failed:${result.error}`, status(result.error, 'omp-ask-error'));
        return;
      }
      if (asked !== generation) return ask.cancel(result.id); // closed before omp took it
      askId = result.id;
      drawAnswer?.();
    });
  }

  // A selection is finished when the mouse or a Shift+arrow key lets go.
  const onMouseUp = () => setTimeout(offerButtons);
  /** @param {KeyboardEvent} e */
  const onKeyUp = (e) => {
    if (e.shiftKey) offerButtons();
  };
  const onSelectionChange = () => {
    if (mode === 'buttons' && !selection()) close();
  };
  const onScroll = () => {
    if (mode === 'buttons') close();
  };
  /** @param {KeyboardEvent} e */
  const onKeyDown = (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation(); // not the pane's Esc-to-stop
    close();
  };
  /** @param {PointerEvent} e */
  const onOutside = (e) => {
    if (pop.contains(/** @type {Node} */ (e.target))) return;
    // A half-written box and an answer still coming are not thrown away by a stray click.
    if (mode === 'editing' && /** @type {HTMLTextAreaElement | null} */ (pop.querySelector('textarea'))?.value.trim()) return;
    if ((mode === 'editing' || mode === 'answer') && !running()) close();
  };
  document.addEventListener('mouseup', onMouseUp);
  transcript.addEventListener('keyup', onKeyUp);
  transcript.addEventListener('scroll', onScroll);
  pop.addEventListener('keydown', onKeyDown);
  document.addEventListener('selectionchange', onSelectionChange);
  document.addEventListener('pointerdown', onOutside, true);

  return {
    /** Redraws a shown answer from the latest session state. */
    refresh() {
      drawAnswer?.();
    },
    destroy() {
      close();
      document.removeEventListener('mouseup', onMouseUp);
      transcript.removeEventListener('keyup', onKeyUp);
      transcript.removeEventListener('scroll', onScroll);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('pointerdown', onOutside, true);
      pop.remove();
    },
  };
}
