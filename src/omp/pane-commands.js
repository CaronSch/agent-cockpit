/**
 * Slash commands the omp pane answers itself, because omp's RPC mode has no form of them: they
 * are offered with omp's own in the suggestions but never sent to omp.
 *
 * `/resume [filter]` lists the past sessions of the pane's directory (omp's `/resume` picker
 * exists only in its TUI); the filter narrows them as the Sessions window's search does.
 */
/** @import { SlashCommand } from './transcript.js' */

/** @type {readonly SlashCommand[]} */
export const PANE_COMMANDS = Object.freeze([
  { name: 'resume', aliases: [], description: 'Resume another session from this directory in this pane', hint: '[filter]' },
]);

/** @typedef {{ name: 'resume', arg: string }} PaneCommand */

/**
 * The pane command `text` invokes, with what follows its name, or null for anything omp takes.
 * @param {string} text @returns {PaneCommand | null}
 */
export function paneCommand(text) {
  const match = /^\/resume(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: 'resume', arg: (match[1] ?? '').trim() } : null;
}

/**
 * Every command the pane suggests: its own first, then omp's, less any it answers itself.
 * @param {readonly SlashCommand[]} omp @returns {SlashCommand[]}
 */
export const withPaneCommands = (omp) => [...PANE_COMMANDS, ...omp.filter((c) => !PANE_COMMANDS.some((p) => p.name === c.name))];
