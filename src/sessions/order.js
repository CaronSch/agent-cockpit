/** Sorting and labels for the Sessions window, kept free of the DOM so they can be tested. */
/** @import { PastSession } from '../../daemon/wire.js' */

/** @typedef {'active' | 'created' | 'title' | 'directory' | 'prompts'} SortKey */
/** @typedef {'asc' | 'desc'} SortDir */

/** @type {ReadonlyArray<{ key: SortKey, label: string }>} */
export const SORT_KEYS = Object.freeze([
  { key: 'active', label: 'Last active' },
  { key: 'created', label: 'Created' },
  { key: 'title', label: 'Title' },
  { key: 'directory', label: 'Directory' },
  { key: 'prompts', label: 'Prompts' },
]);

/** @param {unknown} value @returns {value is SortKey} */
export const isSortKey = (value) => SORT_KEYS.some((s) => s.key === value);

/** Newest and busiest first; names A→Z. @param {SortKey} key @returns {SortDir} */
export const naturalDir = (key) => (key === 'title' || key === 'directory' ? 'asc' : 'desc');

/** What a session is called in the list: its title, else what it was asked first. @param {PastSession} s */
export const displayTitle = (s) => s.title ?? s.firstPrompt ?? s.id;

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** @type {Record<SortKey, (a: PastSession, b: PastSession) => number>} */
const ASCENDING = {
  active: (a, b) => a.modifiedAt - b.modifiedAt,
  created: (a, b) => (a.createdAt ?? a.modifiedAt) - (b.createdAt ?? b.modifiedAt),
  title: (a, b) => collator.compare(displayTitle(a), displayTitle(b)),
  directory: (a, b) => collator.compare(a.cwd ?? '', b.cwd ?? ''),
  prompts: (a, b) => a.prompts - b.prompts,
};

/**
 * A sorted copy. Ties (same directory, same prompt count) fall back to most recently active
 * first, so a group's order is stable and useful whichever way the main key runs.
 * @param {readonly PastSession[]} sessions @param {SortKey} key @param {SortDir} dir
 * @returns {PastSession[]}
 */
export function sortSessions(sessions, key, dir) {
  const sign = dir === 'asc' ? 1 : -1;
  return [...sessions].sort((a, b) => sign * ASCENDING[key](a, b) || b.modifiedAt - a.modifiedAt);
}

/**
 * The directories the Sessions window can narrow to: each one sessions ran in, A→Z, with how
 * many it holds. `selected` stays listed (with 0) when nothing in `sessions` is there, so
 * the window can still show and undo that choice.
 * @param {readonly PastSession[]} sessions @param {string | null} selected
 * @returns {Array<{ cwd: string, count: number }>}
 */
export function directoryCounts(sessions, selected) {
  /** @type {Map<string, number>} */
  const counts = new Map(selected ? [[selected, 0]] : []);
  for (const s of sessions) if (s.cwd) counts.set(s.cwd, (counts.get(s.cwd) ?? 0) + 1);
  return [...counts].map(([cwd, count]) => ({ cwd, count })).sort((a, b) => collator.compare(a.cwd, b.cwd));
}

/** @param {number} then @param {number} now */
export function relativeTime(then, now) {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
