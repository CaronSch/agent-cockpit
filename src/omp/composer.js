/**
 * The omp pane's message box: a draft that grows with its text up to half the pane, and the
 * Send button.
 */
import { el } from '../ui/dom.js';
import { autosize } from '../ui/autosize.js';

/** The draft never grows past this share of the pane, nor shrinks its cap below MIN_MAX_PX. */
const MAX_SHARE = 0.5;
const MIN_MAX_PX = 120;

/** @param {{ pane: HTMLElement }} options `pane`: the element whose height caps the draft */
export function createComposer({ pane }) {
  const root = el('div', 'omp-composer');
  const row = el('div', 'omp-compose-row');
  const draft = el('textarea', 'omp-draft');
  draft.rows = 2;
  draft.setAttribute('aria-label', 'Message omp');
  const sendBtn = el('button', 'btn btn-accent', 'Send');
  sendBtn.type = 'button';
  row.append(draft, sendBtn);
  root.append(row);

  const fit = () => autosize(draft, { max: Math.max(MIN_MAX_PX, pane.clientHeight * MAX_SHARE) });
  draft.addEventListener('input', fit);
  // The cap follows the pane, and the wrap follows the draft's width.
  const resizes = new ResizeObserver(fit);
  resizes.observe(pane);

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
    destroy() {
      resizes.disconnect();
    },
  };
}

/** @typedef {ReturnType<typeof createComposer>} Composer */
