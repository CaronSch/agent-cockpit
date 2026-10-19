/**
 * Free-form notes beside the agents. Every Scratchpad window shows the same text, saved by
 * the daemon to one plain file (`~/.agent-cockpit/scratchpad.md`), so closing a window loses
 * nothing and the notes outlive the browser.
 */
import { el } from '../ui/dom.js';
import { getDaemon } from '../daemon/client.js';
import { getScratchpad } from '../scratchpad/store.js';
/** @import { WidgetContext } from './registry.js' */
/** @import { ScratchpadStore } from '../scratchpad/store.js' */

export default {
  type: 'scratchpad',
  title: 'Scratchpad',
  glyph: '✎',
  description: 'Notes, shared by every Scratchpad window and saved as you type',

  /** @param {HTMLElement} body @param {WidgetContext} _ctx */
  mount(body, _ctx) {
    return createScratchpadWindow(body, getScratchpad());
  },
};

/** @param {HTMLElement} body @param {ScratchpadStore} store */
function createScratchpadWindow(body, store) {
  const root = el('div', 'scratchpad');
  const conflict = el('div', 'scratchpad-conflict');
  conflict.setAttribute('role', 'alert');
  const conflictText = el(
    'p',
    '',
    'The scratchpad was changed somewhere else (another tab, or the file itself) while you were typing.',
  );
  const keepMine = el('button', 'btn btn-accent', 'Keep mine');
  keepMine.type = 'button';
  keepMine.title = 'Save this text over the other version';
  const takeTheirs = el('button', 'btn', 'Use theirs');
  takeTheirs.type = 'button';
  takeTheirs.title = 'Replace this text with the other version';
  const conflictActions = el('div', 'scratchpad-row');
  conflictActions.append(keepMine, takeTheirs);
  const theirsView = el('details', 'scratchpad-theirs');
  const theirsText = el('pre', '');
  theirsView.append(el('summary', '', 'Show their version'), theirsText);
  conflict.append(conflictText, theirsView, conflictActions);

  const text = el('textarea', 'scratchpad-text');
  text.setAttribute('aria-label', 'Scratchpad');
  text.spellcheck = false;
  text.placeholder = 'Notes, links, commands, prompts to reuse… Saved as you type; every Scratchpad window shows the same text.';
  const footer = el('div', 'scratchpad-footer');
  const status = el('span', 'scratchpad-status');
  status.setAttribute('aria-live', 'polite');
  const where = el('span', 'scratchpad-file');
  footer.append(status, where);
  root.append(conflict, text, footer);
  body.append(root);

  getDaemon()
    .config()
    .then(({ scratchpadFile, home }) => {
      where.textContent = scratchpadFile.startsWith(`${home}/`) ? `~${scratchpadFile.slice(home.length)}` : scratchpadFile;
      where.title = scratchpadFile;
    })
    .catch(() => {});

  function draw() {
    const s = store.state();
    if (text.value !== s.text) {
      // Another window (or page) changed it: keep the caret where it was, as far as possible.
      const { selectionStart, selectionEnd } = text;
      text.value = s.text;
      text.setSelectionRange(Math.min(selectionStart, s.text.length), Math.min(selectionEnd, s.text.length));
    }
    text.readOnly = s.phase === 'loading';
    conflict.hidden = s.phase !== 'conflict';
    theirsText.textContent = s.theirs ? s.theirs.text || '(empty)' : '';
    status.classList.toggle('is-error', s.phase === 'error');
    status.textContent = {
      loading: s.error ? `Waiting for the daemon: ${s.error}` : 'Loading…',
      saved: 'Saved',
      saving: 'Saving…',
      error: `Not saved: ${s.error}. Retrying when the daemon is back.`,
      conflict: 'Not saved: choose a version above',
    }[s.phase];
  }

  text.addEventListener('input', () => store.edit(text.value));
  text.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 's') {
      event.preventDefault();
      void store.flush();
    }
  });
  keepMine.addEventListener('click', () => store.keepMine());
  takeTheirs.addEventListener('click', () => store.takeTheirs());

  const off = store.subscribe(draw);
  draw();

  return {
    destroy() {
      // The store is the page's, not this window's: it still saves anything typed here.
      off();
      root.remove();
    },
  };
}
