/**
 * Grows a selection that starts or ends partway through a word to take the whole word, as
 * word processors do, so a rough drag still quotes clean text. A word is everything between
 * spaces, punctuation included: `fox.`, `foo.bar()`, `(see`.
 *
 * The boundaries (`wordStart`, `wordEnd`) are plain text in, offset out, so they can be tested
 * without a DOM. `snappedRange` applies them to a range's two ends where they sit in text,
 * across bold, code and links within a line; `snapToWords` sets a selection to that, keeping
 * which end the user dragged from.
 */

const WORD = /\S/;

/** @param {string} text @param {number} at */
const midWord = (text, at) => at > 0 && at < text.length && WORD.test(text[at - 1]) && WORD.test(text[at]);

/** Where a selection starting at `offset` in `text` starts once snapped. @param {string} text @param {number} offset */
export function wordStart(text, offset) {
  let at = offset;
  while (midWord(text, at)) at--;
  return at;
}

/** Where a selection ending at `offset` in `text` ends once snapped. @param {string} text @param {number} offset */
export function wordEnd(text, offset) {
  let at = offset;
  while (midWord(text, at)) at++;
  return at;
}

/** Where a line of text breaks: a word never runs from one of these into another. */
const BLOCK = 'p, li, td, th, pre, h1, h2, h3, h4, h5, h6, blockquote, div';

/**
 * The text node beside `node` in the same block, after it (`step` 1) or before it (-1): bold,
 * code and links split a word's text without ending it.
 * @param {Text} node @param {1 | -1} step @returns {Text | null}
 */
function beside(node, step) {
  const block = node.parentElement?.closest(BLOCK);
  if (!block) return null;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  walker.currentNode = node;
  const next = /** @type {Text | null} */ (step > 0 ? walker.nextNode() : walker.previousNode());
  return next?.parentElement?.closest(BLOCK) === block ? next : null;
}

/** @param {string | undefined} char */
const isWord = (char) => char !== undefined && WORD.test(char);

/** @param {Text} node @param {number} offset @returns {[Text, number]} */
function snapStart(node, offset) {
  for (;;) {
    offset = wordStart(node.data, offset);
    const prev = offset === 0 && isWord(node.data[0]) ? beside(node, -1) : null;
    if (!prev || !isWord(prev.data.at(-1))) return [node, offset];
    [node, offset] = [prev, prev.data.length - 1];
  }
}

/** @param {Text} node @param {number} offset @returns {[Text, number]} */
function snapEnd(node, offset) {
  for (;;) {
    offset = wordEnd(node.data, offset);
    const next = offset === node.data.length && isWord(node.data.at(-1)) ? beside(node, 1) : null;
    if (!next || !isWord(next.data[0])) return [node, offset];
    [node, offset] = [next, 1];
  }
}

/** `range` grown out to whole words, as a new range; `range` itself is left alone. @param {Range} range */
export function snappedRange(range) {
  const { startContainer, startOffset, endContainer, endOffset } = range;
  const [startNode, start] = startContainer instanceof Text ? snapStart(startContainer, startOffset) : [startContainer, startOffset];
  const [endNode, end] = endContainer instanceof Text ? snapEnd(endContainer, endOffset) : [endContainer, endOffset];
  const snapped = document.createRange();
  snapped.setStart(startNode, start);
  snapped.setEnd(endNode, end);
  return snapped;
}

/** Snaps `sel`'s ends out to whole words; leaves it alone when they already sit on word edges. @param {Selection} sel */
export function snapToWords(sel) {
  if (sel.rangeCount === 0 || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const snapped = snappedRange(range);
  if (snapped.compareBoundaryPoints(Range.START_TO_START, range) === 0 && snapped.compareBoundaryPoints(Range.END_TO_END, range) === 0) return;
  const backward = sel.anchorNode !== range.startContainer || sel.anchorOffset !== range.startOffset;
  if (backward) sel.setBaseAndExtent(snapped.endContainer, snapped.endOffset, snapped.startContainer, snapped.startOffset);
  else sel.setBaseAndExtent(snapped.startContainer, snapped.startOffset, snapped.endContainer, snapped.endOffset);
}
