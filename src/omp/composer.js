/**
 * The omp pane's message box: a draft that grows with its text up to half the pane, cards for
 * what goes with the next message (comments on quoted transcript text), and the Send button.
 */
import { el } from '../ui/dom.js';
import { autosize } from '../ui/autosize.js';
import { composeMessage } from './message.js';
/** @import { QuoteComment } from './message.js' */

/** The draft never grows past this share of the pane, nor shrinks its cap below MIN_MAX_PX. */
const MAX_SHARE = 0.5;
const MIN_MAX_PX = 120;
const EXCERPT_CHARS = 80;

/** @param {string} text */
const excerpt = (text) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > EXCERPT_CHARS ? `${line.slice(0, EXCERPT_CHARS - 1)}…` : line;
};

/** @param {{ pane: HTMLElement }} options `pane`: the element whose height caps the draft */
export function createComposer({ pane }) {
  const root = el('div', 'omp-composer');
  const cards = el('div', 'omp-cards');
  cards.hidden = true;
  const editor = el('div', 'omp-card-editor');
  editor.hidden = true;
  const row = el('div', 'omp-compose-row');
  const draft = el('textarea', 'omp-draft');
  draft.rows = 2;
  draft.setAttribute('aria-label', 'Message omp');
  const sendBtn = el('button', 'btn btn-accent', 'Send');
  sendBtn.type = 'button';
  row.append(draft, sendBtn);
  root.append(cards, editor, row);

  /** @type {QuoteComment[]} */
  let comments = [];

  const fit = () => autosize(draft, { max: Math.max(MIN_MAX_PX, pane.clientHeight * MAX_SHARE) });
  draft.addEventListener('input', fit);
  // The cap follows the pane, and the wrap follows the draft's width.
  const resizes = new ResizeObserver(fit);
  resizes.observe(pane);

  function drawCards() {
    cards.replaceChildren(
      ...comments.map((item, index) => {
        const card = el('div', 'omp-card is-comment');
        const main = el('button', 'omp-card-main');
        main.type = 'button';
        main.title = 'Edit this comment';
        main.append(el('span', 'omp-card-quote', `“${excerpt(item.quote)}”`), el('span', 'omp-card-text', excerpt(item.comment)));
        main.addEventListener('click', () => editComment(index));
        const remove = el('button', 'omp-card-remove', '×');
        remove.type = 'button';
        remove.setAttribute('aria-label', 'Remove comment');
        remove.addEventListener('click', () => {
          comments = comments.filter((_, i) => i !== index);
          closeEditor();
          drawCards();
        });
        card.append(main, remove);
        return card;
      }),
    );
    cards.hidden = comments.length === 0;
  }

  function closeEditor() {
    editor.hidden = true;
    editor.replaceChildren();
  }

  /**
   * Opens the editor above the draft for one card's text.
   * @param {{ label: string, quote?: string, value: string, onSave: (value: string) => void }} options
   */
  function openEditor({ label, quote, value, onSave }) {
    const box = el('textarea', 'omp-card-input');
    box.value = value;
    box.setAttribute('aria-label', label);
    const save = el('button', 'btn btn-accent', 'Save');
    save.type = 'button';
    const cancel = el('button', 'btn', 'Cancel');
    cancel.type = 'button';
    const actions = el('div', 'omp-row');
    actions.append(save, cancel);
    editor.replaceChildren(...(quote ? [el('blockquote', 'omp-quote-preview', quote)] : []), box, actions);
    editor.hidden = false;
    const done = () => {
      closeEditor();
      draft.focus();
    };
    save.addEventListener('click', () => {
      onSave(box.value);
      done();
    });
    cancel.addEventListener('click', done);
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done();
      }
    });
    box.addEventListener('input', () => autosize(box, { max: Math.max(MIN_MAX_PX, pane.clientHeight * MAX_SHARE) }));
    autosize(box, { max: Math.max(MIN_MAX_PX, pane.clientHeight * MAX_SHARE) });
    box.focus();
  }

  /** @param {number} index */
  function editComment(index) {
    const item = comments[index];
    openEditor({
      label: 'Edit comment',
      quote: item.quote,
      value: item.comment,
      onSave: (value) => {
        comments = value.trim() ? comments.map((c, i) => (i === index ? { ...c, comment: value.trim() } : c)) : comments.filter((_, i) => i !== index);
        drawCards();
      },
    });
  }

  return {
    root,
    draft,
    sendBtn,
    get text() {
      return draft.value;
    },
    /** Replaces the draft (a restored or prefilled message) and fits it. @param {string} text */
    setText(text) {
      draft.value = text;
      fit();
    },
    /** Adds a comment on `quote` to go with the next message. @param {string} quote @param {string} comment */
    addComment(quote, comment) {
      comments = [...comments, { quote, comment }];
      drawCards();
    },
    /** The comments waiting for the next message. */
    get comments() {
      return /** @type {readonly QuoteComment[]} */ (comments);
    },
    /**
     * Empties the composer for sending: the draft alone (`withComments` false, for commands)
     * or everything. `restore()` puts it back if the message was refused, unless something new
     * has been written meanwhile.
     * @param {{ withComments: boolean }} options
     */
    take({ withComments }) {
      const text = draft.value;
      const taken = withComments ? comments : [];
      const message = withComments ? composeMessage(text, taken) : text.trim();
      draft.value = '';
      fit();
      if (withComments) comments = [];
      closeEditor();
      drawCards();
      return {
        message,
        restore() {
          if (draft.value || (taken.length && comments.length)) return;
          draft.value = text;
          comments = [...taken, ...comments];
          fit();
          drawCards();
        },
      };
    },
    destroy() {
      resizes.disconnect();
    },
  };
}

/** @typedef {ReturnType<typeof createComposer>} Composer */
