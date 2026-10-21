/**
 * Wire contract between the daemon and the browser: session metadata, stream events and
 * HTTP payloads.
 *
 * Routes (all same-origin, authenticated by the `ac_token` cookie; see `guard.js`):
 *
 *   GET    /api/config                 → DaemonConfig
 *   GET    /api/ui                     → { version }: the UI files' version now (see `ui-files.js`)
 *   GET    /api/history?q=words&archived=1 → { sessions: PastSession[] } (unordered; every word must
 *                                      match; `archived=1` lists the archived sessions instead)
 *   POST   /api/history/archive        { file } → { file }: the journal (with its folder) moved from omp's
 *                                      sessions into the archive, 409 while a session writes it
 *   POST   /api/history/restore        { file } → { file }: an archived journal moved back where it was,
 *                                      409 if something is there now; both are 400 for a path that is
 *                                      not a journal they list, 404 for one that is gone
 *   GET    /api/sessions               → { sessions: SessionMeta[] }
 *   POST   /api/sessions               { cwd, resume? | fork? } → 201 { session: SessionMeta }
 *                                      (`resume` continues a journal, `fork` starts a new session
 *                                      from a copy of one; either must be an existing file)
 *   DELETE /api/sessions/:id           → 204 (closes omp's stdin, kills it if it lingers)
 *   POST   /api/sessions/:id/rpc       omp command without `id` → 202 { id }: the id the daemon gave
 *                                      the command; omp's response frame, carrying it, arrives on
 *                                      the stream
 *   POST   /api/sessions/:id/ui        omp `extension_ui_response` → 204
 *   GET    /api/sessions/:id/files?dir=path → DirListing: the folder `dir` names (relative to
 *                                      the session's directory, `~/…` or absolute), or 404
 *   GET    /api/scratchpads            → { pads: ScratchpadSummary[] } (most recently changed first)
 *   GET    /api/scratchpads/:id        → Scratchpad (empty text for a pad never written)
 *   PUT    /api/scratchpads/:id        { text, base } → { rev }, or 409 { error, current: Scratchpad }
 *                                      when the pad is no longer at version `base`
 *   DELETE /api/scratchpads/:id        → 204 (the pad and its files)
 *   POST   /api/scratchpads/:id/assets raw file body, `x-file-name` header (URI-encoded)
 *                                      → 201 { path } for the pad's Markdown, e.g. `<id>.assets/<name>`
 *   GET    /api/scratchpads/:id/assets/:name → the file (images inline, anything else as a download)
 *   POST   /api/attachments            raw file body, `x-file-name` header (URI-encoded)
 *                                      → 201 { path }: where omp can read it, for an `@"<path>"` mention
 *   GET    /api/workspaces/:name       → Workspace (no screens for a workspace never saved)
 *   PUT    /api/workspaces/:name/screens/:id { tree, base } → { rev }, or 409 { error, current: Screen | null }
 *                                      when the screen is no longer at rev `base` (null: not stored);
 *                                      a null `tree` deletes the screen (`rev` comes back null)
 *   GET    /api/stream                 Server-Sent Events, one StreamEvent per message
 *
 * Errors are `{ error: string }` with a 4xx/5xx status. The stream's SSE ids are
 * `<bootId>:<seq>`, so a reconnect resumes after the last event it saw; the first message
 * on every connection is a `hello` carrying the current boot id, session list and UI version.
 * `scratchpad` and `history` events carry no id and are not replayed: a reconnecting page reads
 * GET /api/scratchpads/:id and GET /api/history instead.
 */
/** @import { GridNode } from '../src/layout/grid-model.js' */

/** @typedef {'starting' | 'ready' | 'exited' | 'failed'} SessionStatus */

/**
 * One omp process the daemon launched, started from the journal `resume` (continuing it) or
 * `fork` (a new session copied from it), or from nothing. `sessionFile` is the journal it
 * writes, learned from omp's `get_state` answers (the resumed file until then); it changes
 * on /new or /fork.
 * @typedef {{
 *   id: string,
 *   cwd: string,
 *   resume: string | null,
 *   fork: string | null,
 *   sessionFile: string | null,
 *   status: SessionStatus,
 *   pid: number | null,
 *   exitCode: number | null,
 *   error: string | null,
 *   startedAt: number,
 * }} SessionMeta
 */

/**
 * A past omp conversation, summarised from its journal. `firstPrompt` is a one-line
 * preview; times are epoch milliseconds.
 * @typedef {{
 *   file: string,
 *   id: string,
 *   title: string | null,
 *   cwd: string | null,
 *   createdAt: number | null,
 *   modifiedAt: number,
 *   prompts: number,
 *   firstPrompt: string | null,
 * }} PastSession
 */

/**
 * Everything the daemon observed or did for a session, in order. `frame` is an omp stdout
 * frame exactly as omp sent it (after protocol-v2 chunk reassembly), responses included;
 * `sent` is a frame the daemon wrote to omp's stdin, its own setup commands included;
 * `garbled` is stdout the daemon could not decode (not JSON, or a broken chunk sequence),
 * kept verbatim (truncated to 64 KiB) rather than dropped.
 * @typedef {(
 *   | { kind: 'session', meta: SessionMeta }
 *   | { kind: 'frame', frame: Record<string, any> }
 *   | { kind: 'sent', command: Record<string, any> }
 *   | { kind: 'stderr', line: string }
 *   | { kind: 'garbled', line: string, error: string }
 * ) & { seq: number, at: number, session: string }} SessionEvent
 */

/**
 * `ui` is the version of the UI files being served (see `ui-files.js`): a page that loaded
 * other files is running older code than the daemon now serves.
 * @typedef {{ kind: 'hello', bootId: string, sessions: SessionMeta[], ui: string }} HelloEvent
 */

/** A scratchpad's text; `rev` names this exact text (a hash of it). @typedef {{ text: string, rev: string }} Scratchpad */
/** @typedef {{ id: string, title: string, modifiedAt: number, size: number }} ScratchpadSummary */
/** Sent to every page after a pad changes (a deleted pad arrives empty). @typedef {{ kind: 'scratchpad', id: string } & Scratchpad} ScratchpadEvent */

/** Sent to every page after past sessions changed (see `history.js` `watch`). @typedef {{ kind: 'history' }} HistoryEvent */

/** @typedef {HelloEvent | ScratchpadEvent | HistoryEvent | SessionEvent} StreamEvent */

/** @typedef {{ defaultCwd: string, home: string, scratchpadDir: string }} DaemonConfig */

/**
 * A folder's entries for `@` file mentions, by name; `dir` is the folder,
 * resolved; `truncated` when it holds more than were listed (see `files.js`).
 * @typedef {{ dir: string, entries: Array<{ name: string, isDir: boolean }>, truncated: boolean }} DirListing
 */

/**
 * One browser window's share of a workspace: its layout, and `rev`, which counts its saves
 * (see `workspace.js`).
 * @typedef {{ id: string, rev: number, tree: GridNode }} Screen
 */
/** Screens in the order they were created. @typedef {{ screens: Screen[] }} Workspace */

/**
 * omp's reply to one command (see omp's rpc docs). `success: false` is a normal answer,
 * not a transport failure.
 * @typedef {{ type: 'response', command: string, success: boolean, data?: any, error?: string, code?: string, id?: string }} RpcResponse
 */

export {};
