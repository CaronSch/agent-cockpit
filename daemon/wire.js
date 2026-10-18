/**
 * Wire contract between the daemon and the browser: session metadata, stream events and
 * HTTP payloads.
 *
 * Routes (all same-origin, authenticated by the `ac_token` cookie; see `guard.js`):
 *
 *   GET    /api/config                 → DaemonConfig
 *   GET    /api/sessions               → { sessions: SessionMeta[] }
 *   POST   /api/sessions               { cwd, resume? } → 201 { session: SessionMeta }
 *   DELETE /api/sessions/:id           → 204 (closes omp's stdin, kills it if it lingers)
 *   POST   /api/sessions/:id/rpc       omp command without `id` → the omp response frame
 *   POST   /api/sessions/:id/ui        omp `extension_ui_response` → 204
 *   GET    /api/stream                 Server-Sent Events, one StreamEvent per message
 *
 * Errors are `{ error: string }` with a 4xx/5xx status. The stream's SSE ids are
 * `<bootId>:<seq>`, so a reconnect resumes after the last event it saw; the first message
 * on every connection is a `hello` carrying the current boot id and session list.
 */

/** @typedef {'starting' | 'ready' | 'exited' | 'failed'} SessionStatus */

/**
 * One omp process the daemon launched.
 * @typedef {{
 *   id: string,
 *   cwd: string,
 *   resume: string | null,
 *   status: SessionStatus,
 *   pid: number | null,
 *   exitCode: number | null,
 *   error: string | null,
 *   startedAt: number,
 * }} SessionMeta
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

/** @typedef {{ kind: 'hello', bootId: string, sessions: SessionMeta[] }} HelloEvent */
/** @typedef {HelloEvent | SessionEvent} StreamEvent */

/** @typedef {{ defaultCwd: string, home: string, ompVersion: string | null }} DaemonConfig */

/**
 * omp's reply to one command (see omp's rpc docs). `success: false` is a normal answer,
 * not a transport failure.
 * @typedef {{ type: 'response', command: string, success: boolean, data?: any, error?: string, code?: string, id?: string }} RpcResponse
 */

export {};
