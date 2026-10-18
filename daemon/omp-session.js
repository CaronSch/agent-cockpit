/**
 * One omp process in RPC mode: launch, protocol setup, command/response correlation and
 * lifecycle, with everything it does reported as session events.
 */
import { spawn } from 'node:child_process';
import { createFrameDecoder } from './frame-decoder.js';
/** @import { RpcResponse, SessionEvent, SessionMeta } from './wire.js' */

/** A SessionEvent before the hub stamps it. @typedef {SessionEvent extends infer E ? E extends any ? Omit<E, 'seq' | 'at' | 'session'> : never : never} SessionEventBody */

/**
 * Sent by the daemon before a session counts as ready, so every widget sees the same
 * protocol: lossless v2 framing, delta-only message updates, and `ask` dialogs enabled.
 */
export const SETUP_COMMANDS = Object.freeze([
  { type: 'negotiate_protocol', protocolVersion: 2 },
  { type: 'set_event_filter', events: null, messageUpdates: 'delta' },
  { type: 'set_ask_dialog', enabled: true },
]);

const CLOSE_GRACE_MS = 5000;
const MAX_GARBLED_CHARS = 64 * 1024;

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
  let meta = { id, cwd, resume, status: 'starting', pid: null, exitCode: null, error: null, startedAt: now() };
  /** @type {Map<string, { resolve: (r: RpcResponse) => void, reject: (e: Error) => void }>} */
  const pending = new Map();
  const decoder = createFrameDecoder();
  let counter = 0;
  let finished = false;
  /** @type {() => void} */
  let markClosed = () => {};
  const closed = new Promise((resolve) => (markClosed = () => resolve(undefined)));

  /** @param {Partial<SessionMeta>} patch */
  const update = (patch) => {
    meta = { ...meta, ...patch };
    emit({ kind: 'session', meta });
  };

  emit({ kind: 'session', meta });
  const args = ['--mode', 'rpc-ui', ...(resume ? ['--resume', resume] : [])];
  const child = spawn(ompPath, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  if (child.pid) update({ pid: child.pid });

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

  child.on('error', (err) => finish(null, `could not run ${ompPath}: ${err.message}`));
  child.on('close', (code, signal) => finish(code ?? null, signal && code === null && meta.status === 'starting' ? `omp was killed (${signal})` : null));
  child.stdin.on('error', () => {}); // EPIPE once omp is gone; `close` reports the exit

  /** @param {import('./frame-decoder.js').Decoded} decoded */
  function handle(decoded) {
    if (!decoded.ok) {
      emit({ kind: 'garbled', line: decoded.line.slice(0, MAX_GARBLED_CHARS), error: decoded.error });
      return;
    }
    const { frame } = decoded;
    emit({ kind: 'frame', frame });
    if (frame.type === 'ready' && meta.status === 'starting') void setup();
    if (frame.type === 'response' && typeof frame.id === 'string') {
      const waiter = pending.get(frame.id);
      pending.delete(frame.id);
      waiter?.resolve(/** @type {RpcResponse} */ (frame));
    }
  }

  child.stdout.on('data', (data) => decoder.push(data).forEach(handle));
  child.stdout.on('end', () => decoder.end().forEach(handle));

  let stderrRest = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (/** @type {string} */ text) => {
    const lines = (stderrRest + text).split('\n');
    stderrRest = /** @type {string} */ (lines.pop());
    for (const line of lines) emit({ kind: 'stderr', line: line.replace(/\r$/, '') });
  });
  child.stderr.on('end', () => stderrRest && emit({ kind: 'stderr', line: stderrRest }));

  /** @param {Record<string, unknown>} frame */
  function writeFrame(frame) {
    emit({ kind: 'sent', command: frame });
    child.stdin.write(`${JSON.stringify(frame)}\n`);
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
      if (finished) return;
      child.stdin.end(); // omp drains accepted work and exits on EOF
      const term = setTimeout(() => child.kill('SIGTERM'), CLOSE_GRACE_MS);
      const kill = setTimeout(() => child.kill('SIGKILL'), CLOSE_GRACE_MS * 2);
      await closed;
      clearTimeout(term);
      clearTimeout(kill);
    },
  };
}
