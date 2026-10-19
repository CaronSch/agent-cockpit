/**
 * Builds the prompt the omp pane sends from what the composer holds: comments on quoted
 * parts of earlier replies, then the draft.
 *
 * A comment goes first as a Markdown quote of the text it is about, followed by the comment,
 * the way a reply quotes an email; the model and the transcript both read it naturally.
 */

/** A comment on a quoted part of the transcript. @typedef {{ quote: string, comment: string }} QuoteComment */

/** Every line of `text` as a Markdown quote. @param {string} text */
export const asQuote = (text) =>
  text
    .trim()
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');

/**
 * The text to send, or '' when there is nothing to send.
 * @param {string} draft @param {readonly QuoteComment[]} comments
 */
export function composeMessage(draft, comments) {
  const parts = comments.map(({ quote, comment }) => `${asQuote(quote)}\n\n${comment.trim()}`);
  if (draft.trim()) parts.push(draft.trim());
  return parts.join('\n\n');
}

/** Commands (`/model`, `!ls`) go to omp as typed; comments wait for the next prompt. @param {string} draft */
export const isCommand = (draft) => /^[/!]/.test(draft.trim());
