/**
 * What an agent has running now, for the agent window's Running line and the Sessions list:
 * the shells and subagents its turn is waiting on, and its background jobs (omp/transcript.js
 * `jobs`), which go on after their tool call has returned, even once the turn has ended.
 */
/** @import { Transcript } from './transcript.js' */

/** @typedef {{ key: string, kind: string, label: string, startedAt: number | null, background: boolean }} Work */

/** What each tool runs, by its name or its job's type: tools not listed are not shown. @type {Readonly<Record<string, string>>} */
const KINDS = Object.freeze({ bash: 'shell', eval: 'shell', task: 'subagent' });

/**
 * The work running now, oldest first.
 * @param {Transcript} state @returns {Work[]}
 */
export function runningWork(state) {
  /** @type {Work[]} */
  const work = [];
  // A call still running once the turn is over was cut short with it.
  if (state.streaming) {
    for (const run of state.tools.values()) {
      const kind = KINDS[run.name];
      if (run.status !== 'running' || !kind) continue;
      const command = /** @type {any} */ (run.args)?.command;
      work.push({ key: run.id, kind, label: run.intent ?? (typeof command === 'string' ? command : run.name), startedAt: run.startedAt, background: false });
    }
  }
  for (const job of state.jobs.values()) {
    work.push({ key: job.id, kind: KINDS[job.type] ?? job.type, label: job.label, startedAt: job.startedAt, background: true });
  }
  return work.sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity));
}

/** How long something has run, short: `45s`, `3m`, `1h 5m`. @param {number} ms */
export function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
