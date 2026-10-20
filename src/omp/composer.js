/**
 * The omp pane's message box: a draft that grows with its text up to half the pane, cards for
 * what goes with the next message (comments on quoted transcript text, pasted text, files),
 * and the Send button.
 *
 * A paste past omp's size limit becomes a text card (click to edit) instead of filling the
 * draft. Files pasted into it or dropped anywhere on the pane are stored by the daemon as they
 * arrive, and go with the message as omp file mentions.
 */
import { button, carriesFiles, el } from '../ui/dom.js';
import { errorMessage } from '../ui/format.js';
import { autosize } from '../ui/autosize.js';
import { composeMessage, isLargePaste } from './message.js';
/** @import { Attachment, QuoteComment } from './message.js' */

/**
 * A file card. `path` stays null until the daemon has stored the file; `stored` settles then
 * (a failed upload removes the card).
 * @typedef {{ kind: 'file', name: string, size: number, preview: string | null, path: string | null, stored: Promise<void> }} FileCard
 */
/** One card above the draft. @typedef {({ kind: 'comment' } & QuoteComment) | { kind: 'text', number: number, text: string } | FileCard} Card */

/** The draft never grows past this share of the pane, nor shrinks its cap below MIN_MAX_PX. */
const MAX_SHARE = 0.5;
const MIN_MAX_PX = 120;
const EXCERPT_CHARS = 80;

/** @param {string} text */
const excerpt = (text) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > EXCERPT_CHARS ? `${line.slice(0, EXCERPT_CHARS - 1)}…` : line;
};

/** @param {number} bytes */
const size = (bytes) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** @param {string} text */
const extent = (text) => {
  const lines = text.replace(/\n+$/, '').split('\n').length;
  return lines > 1 ? `+${lines} lines` : `${text.length} chars`;
};

/**
 * @param {{
 *   pane: HTMLElement,
 *   upload: (file: Blob, name: string) => Promise<string>,
 *   onError: (message: string) => void,
 * }} options `pane`: caps the draft's height and takes dropped files; `upload` stores a file
 * and answers with its path; `onError` hears about a file that could not be attached.
 */
export function createComposer({ pane, upload, onError }) {
  const root = el('div', 'omp-composer');
  const cards = el('div', 'omp-cards');
  cards.hidden = true;
  const editor = el('div', 'omp-card-editor');
  editor.hidden = true;
  const row = el('div', 'omp-compose-row');
  const draft = el('textarea', 'omp-draft');
  draft.rows = 2;
  draft.setAttribute('aria-label', 'Message omp');
  const sendBtn = button('btn btn-accent', 'Send');
  row.append(draft, sendBtn);
  root.append(cards, editor, row);

  /** @type {Card[]} */
  let items = [];
  let pastes = 0;
  /** @type {Set<string>} */
  const previews = new Set();

  const maxHeight = () => Math.max(MIN_MAX_PX, pane.clientHeight * MAX_SHARE);
  const fit = () => autosize(draft, { max: maxHeight() });
  draft.addEventListener('input', fit);
  // The cap follows the pane, and the wrap follows the draft's width.
  const resizes = new ResizeObserver(fit);
  resizes.observe(pane);

  draft.addEventListener('paste', (e) => {
    const data = e.clipboardData;
    if (!data) return;
    if (data.files.length) {
      e.preventDefault();
      attachFiles([...data.files]);
      return;
    }
    const text = data.getData('text/plain');
    if (!isLargePaste(text)) return;
    e.preventDefault();
    items = [...items, { kind: 'text', number: ++pastes, text }];
    drawCards();
  });

  /** @param {DragEvent} e */
  const onDragOver = (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    pane.classList.add('is-dropping');
  };
  /** @param {DragEvent} e */
  const onDragLeave = (e) => {
    if (!(e.relatedTarget instanceof Node && pane.contains(e.relatedTarget))) pane.classList.remove('is-dropping');
  };
  /** @param {DragEvent} e */
  const onDrop = (e) => {
    pane.classList.remove('is-dropping');
    if (!carriesFiles(e)) return;
    e.preventDefault();
    attachFiles([...(e.dataTransfer?.files ?? [])]);
    draft.focus();
  };
  pane.addEventListener('dragover', onDragOver);
  pane.addEventListener('dragleave', onDragLeave);
  pane.addEventListener('drop', onDrop);

  /** @param {File[]} files */
  function attachFiles(files) {
    for (const file of files) {
      const name = file.name || 'pasted-file';
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      if (preview) previews.add(preview);
      /** @type {FileCard} */
      const card = { kind: 'file', name, size: file.size, preview, path: null, stored: Promise.resolve() };
      card.stored = upload(file, name).then(
        (path) => {
          card.path = path;
          drawCards();
        },
        (err) => {
          remove(card);
          onError(`Could not attach ${name}: ${errorMessage(err)}`);
        },
      );
      items = [...items, card];
    }
    drawCards();
  }

  /** @param {Card} card */
  function remove(card) {
    if (!items.includes(card)) return;
    items = items.filter((c) => c !== card);
    if (card.kind === 'file' && card.preview) {
      URL.revokeObjectURL(card.preview);
      previews.delete(card.preview);
    }
    closeEditor();
    drawCards();
  }

  /** @param {Card} card @param {Card} next */
  function replace(card, next) {
    items = items.map((c) => (c === card ? next : c));
    drawCards();
  }

  /** @param {Card} card */
  function cardView(card) {
    const view = el('div', `omp-card is-${card.kind}`);
    const main = el(card.kind === 'file' ? 'div' : 'button', 'omp-card-main');
    const removeBtn = button('omp-card-remove', '×', () => remove(card));
    if (card.kind === 'comment') {
      main.title = 'Edit this comment';
      main.append(el('span', 'omp-card-quote', `“${excerpt(card.quote)}”`), el('span', 'omp-card-text', excerpt(card.comment)));
      main.addEventListener('click', () =>
        openEditor({
          label: 'Edit comment',
          quote: card.quote,
          value: card.comment,
          onSave: (value) => (value.trim() ? replace(card, { ...card, comment: value.trim() }) : remove(card)),
        }),
      );
      removeBtn.setAttribute('aria-label', 'Remove comment');
    } else if (card.kind === 'text') {
      main.title = 'Edit this text';
      main.append(el('span', 'omp-card-quote', `Paste #${card.number} · ${extent(card.text)}`), el('span', 'omp-card-text', excerpt(card.text)));
      main.addEventListener('click', () =>
        openEditor({
          label: `Edit paste #${card.number}`,
          value: card.text,
          onSave: (value) => (value.trim() ? replace(card, { ...card, text: value }) : remove(card)),
        }),
      );
      removeBtn.setAttribute('aria-label', `Remove paste #${card.number}`);
    } else {
      view.classList.toggle('is-uploading', card.path === null);
      main.title = card.path ?? 'Uploading…';
      if (card.preview) {
        const thumb = el('img', 'omp-card-thumb');
        thumb.src = card.preview;
        thumb.alt = '';
        view.prepend(thumb);
      }
      main.append(el('span', 'omp-card-text', card.name), el('span', 'omp-card-quote', card.path ? size(card.size) : 'uploading…'));
      removeBtn.setAttribute('aria-label', `Remove ${card.name}`);
    }
    if (main instanceof HTMLButtonElement) main.type = 'button';
    view.append(main, removeBtn);
    return view;
  }

  function drawCards() {
    cards.replaceChildren(...items.map(cardView));
    cards.hidden = items.length === 0;
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
    const save = button('btn btn-accent', 'Save');
    const cancel = button('btn', 'Cancel');
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
    box.addEventListener('input', () => autosize(box, { max: maxHeight() }));
    autosize(box, { max: maxHeight() });
    box.focus();
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
      items = [...items, { kind: 'comment', quote, comment }];
      drawCards();
    },
    /** Settles once every file attached so far is stored (or has failed and been dropped). */
    async settled() {
      await Promise.all(items.map((c) => (c.kind === 'file' ? c.stored : null)));
    },
    /**
     * Empties the composer for sending: the draft alone (`withCards` false, for commands) or
     * with every card whose file is stored. `restore()` puts it back if the message was
     * refused, unless something new has been written meanwhile.
     * @param {{ withCards: boolean }} options
     */
    take({ withCards }) {
      const text = draft.value;
      const taken = withCards ? items.filter((c) => c.kind !== 'file' || c.path !== null) : [];
      /** @type {QuoteComment[]} */
      const comments = [];
      /** @type {Attachment[]} */
      const attachments = [];
      for (const card of taken) {
        if (card.kind === 'comment') comments.push({ quote: card.quote, comment: card.comment });
        else if (card.kind === 'text') attachments.push({ kind: 'text', text: card.text });
        else if (card.path) attachments.push({ kind: 'file', path: card.path });
      }
      const message = withCards ? composeMessage(text, comments, attachments) : text.trim();
      draft.value = '';
      fit();
      items = items.filter((c) => !taken.includes(c));
      closeEditor();
      drawCards();
      return {
        message,
        restore() {
          if (draft.value || (taken.length && items.length)) return;
          draft.value = text;
          items = [...taken, ...items];
          fit();
          drawCards();
        },
      };
    },
    destroy() {
      resizes.disconnect();
      pane.removeEventListener('dragover', onDragOver);
      pane.removeEventListener('dragleave', onDragLeave);
      pane.removeEventListener('drop', onDrop);
      for (const url of previews) URL.revokeObjectURL(url);
    },
  };
}

/** @typedef {ReturnType<typeof createComposer>} Composer */
