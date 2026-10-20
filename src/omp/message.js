/**
 * Builds the prompt the omp pane sends from what the composer holds: comments on quoted
 * parts of earlier replies, the draft, then attachments.
 *
 * A comment goes first as a Markdown quote of the text it is about, followed by the comment,
 * the way a reply quotes an email; the model and the transcript both read it naturally.
 * Pasted text goes after the draft wrapped in `<attachment>` tags, as omp's own "wrapped
 * block" paste does. A file goes as an `@"<path>"` mention: omp reads it when the prompt
 * starts a turn (images to the model, text inline); a steer keeps the path, which the model
 * can open itself.
 */

/** A comment on a quoted part of the transcript. @typedef {{ quote: string, comment: string }} QuoteComment */
/**
 * Something sent along with the prompt: pasted text, or a file stored where omp can read it.
 * @typedef {{ kind: 'text', text: string } | { kind: 'file', path: string }} Attachment
 */

/** Pastes bigger than this become an attachment card, as omp's editor collapses them. */
const PASTE_MAX_LINES = 10;
const PASTE_MAX_CHARS = 1000;

/** Every line of `text` as a Markdown quote. @param {string} text */
export const asQuote = (text) =>
  text
    .trim()
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');

/** Whether pasted `text` is big enough to go as an attachment rather than into the draft. @param {string} text */
export const isLargePaste = (text) => text.length > PASTE_MAX_CHARS || text.split('\n').length > PASTE_MAX_LINES;

/** omp's file mention for `path`, quoted so spaces survive. @param {string} path */
export const mention = (path) => (path.includes('"') ? `@'${path}'` : `@"${path}"`);

/** @param {Attachment} attachment */
const attachmentText = (attachment) =>
  attachment.kind === 'text' ? `<attachment>\n${attachment.text.replace(/\n+$/, '')}\n</attachment>` : mention(attachment.path);

/**
 * The text to send, or '' when there is nothing to send.
 * @param {string} draft @param {readonly QuoteComment[]} comments @param {readonly Attachment[]} [attachments]
 */
export function composeMessage(draft, comments, attachments = []) {
  const parts = comments.map(({ quote, comment }) => `${asQuote(quote)}\n\n${comment.trim()}`);
  if (draft.trim()) parts.push(draft.trim());
  parts.push(...attachments.map(attachmentText));
  return parts.join('\n\n');
}

/** Commands (`/model`, `!ls`) go to omp as typed; comments and attachments wait for the next prompt. @param {string} draft */
export const isCommand = (draft) => /^[/!]/.test(draft.trim());
