/**
 * Which transcript items an omp pane shows when it is set to only prompts and responses:
 * what the user said and ran, and what the agent finally answered, without the work in
 * between. A view over `transcript.js` items, computed at render time: switching back
 * shows everything again, because nothing is ever removed from the transcript.
 *
 * Shown:
 * - the user's prompts (`user` items the agent did not write); comments travel inside the
 *   prompt, attached files as the `files` note omp's `fileMention` message becomes
 * - the user's `!` shell runs (`bash` items: omp records bash and python executions only
 *   for commands the user runs; the agent's shell runs are tool calls)
 * - each turn's final response (below), without its thinking
 * - errors (every `error` note: a failed prompt, command, attachment, exhausted retries)
 *   and how a prompt ended (`prompt` notes: failed or aborted)
 * - slash-command output (`command` notes): the answer to what the user typed
 * - unrecognised items: the pane cannot tell work from answer in what it does not know,
 *   and never hides it (CLAUDE.md, Invariants)
 * Dialogs waiting for an answer are not transcript items: the pane always shows them.
 *
 * Hidden: thinking, tool calls and their output, intermediate assistant messages, messages
 * the agent injects (`byAgent` user items), and every other note.
 *
 * The final response. The user's prompts and the messages the agent injects cut the
 * transcript into turns. A turn's final response is its last assistant message, if that
 * message ended (`message_end`) without asking for tools: its `stopReason` is `stop`,
 * `length`, `error` or `aborted`, not `toolUse`. Any assistant message followed by another
 * in the same turn is intermediate, whatever its `stopReason`: omp may carry on after a
 * `stop` (an `agent_end` with `yielded: false`). So the newest turn's last message is only
 * known to be final once the agent hands the turn back (`agent_end`, transcript.js
 * `handsTurnBack`), which is when the transcript stops streaming; until then the newest
 * turn is work in progress, summarised as `working`.
 */
/** @import { AssistantItem, Item } from './transcript.js' */

/**
 * `working` is set while a turn runs: its work so far, counted in steps (assistant
 * messages, each one model call with the tool calls it made).
 * @typedef {{ items: Item[], working: { steps: number } | null }} PromptsAndResponses
 */

/**
 * @param {readonly Item[]} items a transcript's items, in order
 * @param {boolean} streaming whether the agent is still running its turn (transcript `streaming`)
 * @returns {PromptsAndResponses}
 */
export function promptsAndResponses(items, streaming) {
  /** @type {Item[]} */
  const shown = [];
  /** Where the current turn's last assistant message is (or would go) in `shown`. */
  let slot = -1;
  /** @type {AssistantItem | null} */
  let last = null;
  let steps = 0;

  const closeTurn = () => {
    if (last && isFinal(last)) shown.splice(slot, 0, withoutWork(last));
    last = null;
    slot = -1;
    steps = 0;
  };

  for (const item of items) {
    switch (item.kind) {
      case 'user':
        closeTurn();
        if (!item.byAgent) shown.push(item);
        break;
      case 'assistant':
        last = item;
        slot = shown.length;
        steps++;
        break;
      case 'bash':
      case 'unrecognised':
        shown.push(item);
        break;
      case 'note':
        if (item.level === 'error' || NOTE_SOURCES.has(item.source)) shown.push(item);
        break;
      case 'tool':
        break;
    }
  }
  if (streaming) return { items: shown, working: { steps } };
  closeTurn();
  return { items: shown, working: null };
}

/** Notes that belong to the conversation, not to the work: see the module comment. */
const NOTE_SOURCES = new Set(['files', 'prompt', 'command']);

/** @param {AssistantItem} item */
const isFinal = (item) => item.ended && item.stopReason !== 'toolUse';

/**
 * The response as the user reads it: its text (and images or blocks the pane does not
 * know), without the thinking and tool calls that led to it.
 * @param {AssistantItem} item @returns {AssistantItem}
 */
function withoutWork(item) {
  const blocks = item.blocks.filter((b) => b.kind === 'text' || b.kind === 'other');
  return blocks.length === item.blocks.length ? item : { ...item, blocks };
}
