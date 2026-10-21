/**
 * `@` file mentions in the omp pane's message box: while the caret ends an `@path`, the
 * suggestion list shows the matching entries of the folder it names, and Tab, Enter or a
 * click completes the path (see `file-mention.js`).
 *
 * Folders are listed by the daemon, relative to the session's directory; one listing serves
 * every keystroke in that folder until the mention is finished or abandoned.
 */
import { el } from '../ui/dom.js';
import { commonPrefix, completeEntry, extendSegment, matchEntries, mentionAt } from './file-mention.js';
/** @import { DirEntry, MentionQuery } from './file-mention.js' */
/** @import { DirListing } from '../../daemon/wire.js' */
/** @import { Suggestions } from './suggestions.js' */

/** Rows shown at most; typing more of the name narrows the rest down. */
const MAX_ROWS = 50;

/**
 * @param {{
 *   draft: HTMLTextAreaElement,
 *   list: Suggestions,
 *   listDir: (dir: string) => Promise<DirListing>,
 *   replace: (start: number, end: number, text: string) => void,
 * }} options `listDir` lists a folder as typed in a mention; `replace` puts `text` in the
 * draft in place of `start`…`end`, leaving the caret after it.
 */
export function createFileSuggest({ draft, list, listDir, replace }) {
  /** @type {Map<string, Promise<DirListing>>} */
  const listings = new Map();
  /** The mention the list is for (where its `@` is, its folder and segment), while one is being typed. */
  let showing = '';

  /** The mention the caret ends now, if the caret is not a selection. */
  const current = () => (draft.selectionStart === draft.selectionEnd ? mentionAt(draft.value, draft.selectionStart) : null);
  /** @param {MentionQuery} q */
  const key = (q) => `${q.start}:${q.quote}${q.dir}`;

  /** @param {string} dir */
  function listing(dir) {
    let pending = listings.get(dir);
    if (!pending) {
      pending = listDir(dir);
      listings.set(dir, pending);
      pending.catch(() => listings.delete(dir));
    }
    return pending;
  }

  /**
   * Replaces the mention, if the caret still ends the one the rows were made for, then
   * follows the draft (a folder's own entries next, or nothing once a file is in).
   * @param {MentionQuery} shown @param {(q: MentionQuery) => string} text
   */
  function complete(shown, text) {
    const q = current();
    if (q && key(q) === key(shown)) replace(q.start, q.end, text(q));
    update();
  }

  /** @param {MentionQuery} q @param {DirListing} found */
  function draw(q, found) {
    const matches = matchEntries(found.entries, q.segment);
    const shown = matches.slice(0, MAX_ROWS);
    const more = matches.length - shown.length;
    const note = found.truncated
      ? `Only the first ${found.entries.length} entries of this folder are listed`
      : more > 0
        ? `${more} more: type to narrow`
        : undefined;
    /** @param {DirEntry} entry */
    const pick = (entry) => () => complete(q, (now) => completeEntry(now, entry));
    list.show(
      shown.map((entry) => ({
        cells: [entry.isDir ? el('span', 'omp-suggestion-name', `${entry.name}/`) : el('span', 'omp-suggestion-file', entry.name)],
        pick: pick(entry),
      })),
      {
        enter: true,
        note,
        tab(moved, selected) {
          const prefix = moved ? null : commonPrefix(matches, q.segment);
          if (prefix) complete(q, (now) => extendSegment(now, prefix));
          else selected.pick();
        },
      },
    );
  }

  /** Stops following a mention: the list closes and its listings are forgotten. */
  function close() {
    showing = '';
    listings.clear();
    list.hide();
  }

  /**
   * Follows the draft as it now stands: lists the folder of the mention the caret ends, if
   * any. Returns false when it ends none, having closed the list if it showed one.
   */
  function update() {
    const q = current();
    if (!q) {
      if (showing) close();
      return false;
    }
    const at = `${key(q)}/${q.segment}`;
    showing = at;
    listing(q.dir).then(
      (found) => {
        if (showing === at) draw(q, found);
      },
      () => {
        if (showing === at) list.hide();
      },
    );
    return true;
  }

  return { update, close };
}
