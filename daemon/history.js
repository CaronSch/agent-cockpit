/**
 * Past omp sessions, read from omp's session files: one summary per conversation, searchable
 * by title, directory and what the user asked.
 *
 * omp keeps one journal per session at `<sessions>/<project>/<timestamp>_<id>.jsonl`; folders
 * beside them hold subagent sessions and artifacts, which are not conversations of their own.
 * A journal starts with a `title` line omp rewrites in place, then a `session` header
 * (`id`, `timestamp`, `cwd`); user prompts are `message` lines with role `user`. Summaries are
 * cached by path, size and mtime, so a refresh only re-reads journals that changed.
 */
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
/** @import { PastSession } from './wire.js' */

const SEARCH_CHARS = 17 * 1024; // per session; enough for every prompt of a long session
const PREVIEW_CHARS = 280;

/** @typedef {PastSession & { search: string }} Summary */

/** @param {unknown} content @returns {string} */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** @param {string} text */
const oneLine = (text) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
};

/**
 * Reads one journal. Lines that are not JSON (a torn last write) are skipped, not fatal.
 * @param {string} file @param {{ size: number, mtimeMs: number }} info
 * @returns {Promise<Summary | null>} null when the journal has no session header
 */
async function summarise(file, info) {
  /** @type {string | null} */
  let title = null;
  /** @type {Record<string, any> | null} */
  let header = null;
  /** @type {string[]} */
  const prompts = [];

  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    // Most lines are tool output; only parse the ones that can matter.
    const maybeHeader = header === null && (line.includes('"type":"session"') || line.includes('"type":"title"'));
    if (!maybeHeader && !line.includes('"role":"user"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // omp's auto-titles start with a nerd-font icon (a private-use character); browsers show a box.
    if (entry?.type === 'title' && typeof entry.title === 'string') title = entry.title.replace(/\p{Co}/gu, '').trim() || null;
    else if (entry?.type === 'session' && header === null) header = entry;
    else if (entry?.type === 'message' && entry.message?.role === 'user' && entry.message.attribution !== 'agent') {
      const text = textOf(entry.message.content).trim();
      if (!text) continue;
      prompts.push(text);
    }
  }
  if (!header || typeof header.id !== 'string') return null;

  const created = Date.parse(header.timestamp);
  const search = [title ?? '', typeof header.cwd === 'string' ? header.cwd : '', header.id, ...prompts]
    .join('\n')
    .slice(0, SEARCH_CHARS)
    .toLowerCase();
  return {
    file,
    id: header.id,
    title,
    cwd: typeof header.cwd === 'string' ? header.cwd : null,
    createdAt: Number.isFinite(created) ? created : null,
    modifiedAt: info.mtimeMs,
    prompts: prompts.length,
    firstPrompt: prompts.length ? oneLine(prompts[0]) : null,
    search,
  };
}

/**
 * @param {{ root: string }} options `root` is omp's sessions directory
 */
export function createHistory({ root }) {
  /** @type {Map<string, { size: number, mtimeMs: number, summary: Summary | null }>} */
  const cache = new Map();

  /** @returns {Promise<string[]>} */
  async function journals() {
    const projects = await readdir(root, { withFileTypes: true }).catch(() => []);
    const nested = await Promise.all(
      projects
        .filter((p) => p.isDirectory())
        .map(async (p) => {
          const dir = join(root, p.name);
          const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
          return entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl') && !e.name.startsWith('.')).map((e) => join(dir, e.name));
        }),
    );
    return nested.flat();
  }

  return {
    /**
     * Every past conversation with at least one prompt, matching all words of `query`
     * (case-insensitive) when one is given. Unordered: the widget sorts.
     * @param {string} [query]
     * @returns {Promise<PastSession[]>}
     */
    async list(query = '') {
      const files = await journals();
      const seen = new Set(files);
      for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file);

      const summaries = await Promise.all(
        files.map(async (file) => {
          const info = await stat(file).catch(() => null);
          if (!info) return null;
          const hit = cache.get(file);
          if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) return hit.summary;
          const summary = await summarise(file, info).catch(() => null);
          cache.set(file, { size: info.size, mtimeMs: info.mtimeMs, summary });
          return summary;
        }),
      );

      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      return summaries
        .filter((s) => s !== null && s.prompts > 0 && words.every((w) => s.search.includes(w)))
        .map((s) => {
          const { search: _search, ...past } = /** @type {Summary} */ (s);
          return past;
        });
    },
  };
}
