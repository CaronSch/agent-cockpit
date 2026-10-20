/**
 * One omp process in RPC mode: launch, protocol setup, command/response correlation and
 * lifecycle, with everything it does reported as session events.
 *
 * It also gets the session a title. omp names sessions by itself only in its TUI (RPC mode
 * sets PI_NO_TITLE), so once a turn has settled in a session that has no name, the daemon
 * asks the way a user would, with `/rename`: omp's title model summarises the conversation
 * and the title lands in the journal, where the Sessions window reads it.
 */
import { dirname } from 'node:path';
import { createFrameDecoder } from './frame-decoder.js';
/** @import { RpcResponse, SessionEvent, SessionMeta } from './wire.js' */

/** A SessionEvent before the hub stamps it. @typedef {SessionEvent extends infer E ? E extends any ? Omit<E, 'seq' | 'at' | 'session'> : never : never} SessionEventBody */

/**
 * Sent by the daemon before a session counts as ready, so every widget sees the same
 * protocol (lossless v2 framing, delta-only message updates, `ask` dialogs enabled) and the
 * daemon knows which journal the session writes before anything else asks.
 */
export const SETUP_COMMANDS = Object.freeze([
  { type: 'negotiate_protocol', protocolVersion: 2 },
  { type: 'set_event_filter', events: null, messageUpdates: 'delta' },
  { type: 'set_ask_dialog', enabled: true },
  { type: 'get_state' },
]);

/** The test fake (and omp installed through bun) start with `#!/usr/bin/env bun`: let them find the bun running the daemon. */
export const OMP_ENV = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` };

const CLOSE_GRACE_MS = 5000;
const MAX_GARBLED_CHARS = 64 * 1024;
/** A conversation too thin to name ("hi") gets another try after later turns, this many in all. */
const TITLE_ATTEMPTS = 3;
const RENAME = Object.freeze({ type: 'prompt', message: '/rename' });

export class SessionNotRunning extends Error {}

/**
 * `command` throws SessionNotRunning unless the session is ready; otherwise it returns the
 * id the daemon gave the request (omp echoes it on its response frame) and the response.
 * @typedef {{
 *   meta(): SessionMeta,
 *   command(command: Record<string, unknown>): { id: string, response: Promise<RpcResponse> },
 *   respondUi(response: Record<string, unknown>): void,
 *   close(): Promise<void>,
 * }} OmpSession
 */

/**
 * @param {{
 *   id: string, cwd: string, resume: string | null, ompPath: string,
 *   emit: (body: SessionEventBody) => void, now?: () => number,
 * }} options
 * @returns {OmpSession}
 */
export function launchOmp({ id, cwd, resume, ompPath, emit, now = Date.now }) {
  /** @type {SessionMeta} */
  let meta = { id, cwd, resume, sessionFile: resume, status: 'starting', pid: null, exitCode: null, error: null, startedAt: now() };
  /** @type {Map<string, { resolve: (r: RpcResponse) => void, reject: (e: Error) => void }>} */
  const pending = new Map();
  const decoder = createFrameDecoder();
  let counter = 0;
  let finished = false;
  /** @type {() => void} */
  let markClosed = () => {};
  const closed = new Promise((resolve) => (markClosed = () => resolve(undefined)));
  let named = false;
  let titleAttempts = 0;

  /** @param {Partial<SessionMeta>} patch */
  const update = (patch) => {
    meta = { ...meta, ...patch };
    emit({ kind: 'session', meta });
  };

  emit({ kind: 'session', meta });
  /** @type {import('bun').Subprocess<'pipe', 'pipe', 'pipe'> | null} */
  let child = null;
  try {
    child = Bun.spawn([ompPath, '--mode', 'rpc-ui', ...(resume ? ['--resume', resume] : [])], {
      cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: OMP_ENV,
    });
    update({ pid: child.pid });
  } catch (err) {
    finish(null, `could not run ${ompPath}: ${err instanceof Error ? err.message : err}`);
  }

  /** @param {number | null} exitCode @param {string | null} error */
  function finish(exitCode, error) {
    if (finished) return;
    finished = true;
    for (const p of pending.values()) p.reject(new SessionNotRunning('omp exited before answering'));
    pending.clear();
    const failed = error !== null || (meta.status === 'starting' && exitCode !== 0);
    update({
      status: failed ? 'failed' : 'exited',
      pid: null,
      exitCode,
      error: error ?? (failed ? `omp exited with code ${exitCode} before it was ready` : null),
    });
    markClosed();
  }

  /** @param {import('./frame-decoder.js').Decoded} decoded */
  function handle(decoded) {
    if (!decoded.ok) {
      emit({ kind: 'garbled', line: decoded.line.slice(0, MAX_GARBLED_CHARS), error: decoded.error });
      return;
    }
    const { frame } = decoded;
    emit({ kind: 'frame', frame });
    if (frame.type === 'ready' && meta.status === 'starting') void setup();
    if (frame.type === 'response' && frame.command === 'get_state' && frame.success) {
      const file = frame.data?.sessionFile;
      if (typeof file === 'string' && file !== meta.sessionFile) update({ sessionFile: file });
      if (frame.data?.sessionName) named = true;
    }
    if (frame.type === 'session_info_update' && frame.title) named = true;
    // omp settles once per stretch of agent activity, so this follows a turn, never a command.
    if (frame.type === 'session_settled') askForTitle();
    if (frame.type === 'response' && typeof frame.id === 'string') {
      const waiter = pending.get(frame.id);
      pending.delete(frame.id);
      waiter?.resolve(/** @type {RpcResponse} */ (frame));
    }
  }

  /**
   * Reads omp's stdout as frames and its stderr as lines; reports the exit once both ended.
   * @param {import('bun').Subprocess<'pipe', 'pipe', 'pipe'>} proc
   */
  async function pump(proc) {
    const stdout = (async () => {
      for await (const data of proc.stdout) decoder.push(data).forEach(handle);
      decoder.end().forEach(handle);
    })();
    let rest = '';
    for await (const text of proc.stderr.pipeThrough(new TextDecoderStream())) {
      const lines = (rest + text).split('\n');
      rest = /** @type {string} */ (lines.pop());
      for (const line of lines) emit({ kind: 'stderr', line: line.replace(/\r$/, '') });
    }
    if (rest) emit({ kind: 'stderr', line: rest });
    await Promise.all([proc.exited, stdout]);
    const killed = proc.signalCode && proc.exitCode === null && meta.status === 'starting';
    finish(proc.exitCode, killed ? `omp was killed (${proc.signalCode})` : null);
  }
  if (child) void pump(child);

  /** @param {Record<string, unknown>} frame */
  function writeFrame(frame) {
    emit({ kind: 'sent', command: frame });
    child?.stdin.write(`${JSON.stringify(frame)}\n`);
    child?.stdin.flush();
  }

  /** @param {Record<string, unknown>} command @returns {{ id: string, response: Promise<RpcResponse> }} */
  function send(command) {
    const frame = { ...command, id: `ac_${++counter}` };
    if (finished) return { id: frame.id, response: Promise.reject(new SessionNotRunning(`session is ${meta.status}`)) };
    const response = new Promise((resolve, reject) => {
      pending.set(frame.id, { resolve, reject });
      writeFrame(frame);
    });
    return { id: frame.id, response: /** @type {Promise<RpcResponse>} */ (response) };
  }

  async function setup() {
    // A refused setup command leaves its failure in the log; the session still works on
    // the protocol omp does support, so it becomes ready either way.
    for (const command of SETUP_COMMANDS) await send(command).response.catch(() => {});
    if (!finished) update({ status: 'ready' });
  }

  function askForTitle() {
    if (named || titleAttempts >= TITLE_ATTEMPTS || meta.status !== 'ready') return;
    titleAttempts++;
    send(RENAME).response.catch(() => {});
  }

  return {
    meta: () => meta,
    command(command) {
      if (meta.status !== 'ready') throw new SessionNotRunning(`session is ${meta.status}`);
      return send(command);
    },
    respondUi(response) {
      if (meta.status !== 'ready') throw new SessionNotRunning(`session is ${meta.status}`);
      writeFrame({ ...response, type: 'extension_ui_response' });
    },
    async close() {
      if (finished || !child) return;
      const proc = child;
      proc.stdin.end(); // omp drains accepted work and exits on EOF
      const term = setTimeout(() => proc.kill('SIGTERM'), CLOSE_GRACE_MS);
      const kill = setTimeout(() => proc.kill('SIGKILL'), CLOSE_GRACE_MS * 2);
      await closed;
      clearTimeout(term);
      clearTimeout(kill);
    },
  };
}
