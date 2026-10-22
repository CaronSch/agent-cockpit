/**
 * Up and Down in the agent pane's message box step through what was sent in its conversation,
 * as omp's own editor and a shell do: the user's prompts and `!` commands, newest first.
 *
 * Browsing starts only from an empty box, so Up never replaces a draft. Up steps back while
 * the caret is on the box's first line, Down forward while it is on the last, and Down past the
 * newest empties the box again. Any other change to the text ends browsing and keeps the text.
 */
/** @import { Item } from './transcript.js' */

/**
 * What the user sent, newest first, a repeat in a row once: their prompts (not messages omp
 * injected) and their `!` commands.
 * @param {readonly Item[]} items @returns {string[]}
 */
export function sentPrompts(items) {
  /** @type {string[]} */
  const sent = [];
  for (const item of items) {
    const text = item.kind === 'user' && !item.byAgent ? item.text : item.kind === 'bash' && item.language === 'bash' ? `!${item.command}` : null;
    if (text?.trim() && text !== sent.at(-1)) sent.push(text);
  }
  return sent.reverse();
}

/**
 * Browsing state for one message box.
 * @param {() => string[]} entries what was sent, newest first; read when browsing starts
 */
export function createPromptHistory(entries) {
  /** @type {string[]} */
  let list = [];
  /** The entry shown, newest 0; -1 while not browsing. */
  let index = -1;
  let shown = '';
  return {
    /**
     * The text the box shows after Up (`older`) or Down (`newer`), or null when the key should
     * move the caret instead.
     * @param {'older' | 'newer'} direction @param {string} draft @param {number} caret
     * @returns {string | null}
     */
    step(direction, draft, caret) {
      if (draft !== shown) index = -1; // edited, sent or replaced since: the box is the user's
      if (direction === 'older') {
        if (index === -1) {
          if (draft !== '') return null;
          list = entries();
        } else if (draft.slice(0, caret).includes('\n')) return null;
        if (index + 1 >= list.length) return null;
        index++;
      } else {
        if (index === -1 || draft.slice(caret).includes('\n')) return null;
        index--;
      }
      shown = index === -1 ? '' : list[index];
      return shown;
    },
  };
}
