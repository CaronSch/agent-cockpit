/**
 * Browser side of the daemon connection: one event stream per page, shared by every widget.
 *
 * Widgets subscribe per session and first receive everything already seen for it, so a
 * window mounted late (or after a reload) renders the same history as one that was open
 * all along. When the daemon restarts, its sessions are gone: buffers are cleared and
 * `onReset` listeners fire before any event from the new daemon is delivered.
 *
 * It also tracks the UI files' version (see daemon/ui-files.js): the first one the daemon
 * reports is the code this page loaded, and `onUiChange` hears when the files served stop
 * being, or become again, those.
 */
/** @import { DaemonConfig, HelloEvent, PastSession, RpcResponse, Scratchpad, ScratchpadSummary, SessionEvent, SessionMeta, StreamEvent } from '../../daemon/wire.js' */
/** @typedef {{ ok: true, rev: string } | { ok: false, current: Scratchpad }} ScratchpadSave */

/** @typedef {'connecting' | 'open' | 'down' | 'unauthorized'} ConnectionStatus */

const RECONNECT_MS = 1500;
const KEEPALIVE_MAX_BYTES = 60_000;

export class DaemonError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @typedef {{
 *   status(): ConnectionStatus,
 *   onStatus(fn: (status: ConnectionStatus) => void): () => void,
 *   onReset(fn: () => void): () => void,
 *   subscribe(session: string, fn: (event: SessionEvent) => void): () => void,
 *   meta(session: string): SessionMeta | null,
 *   sessions(): SessionMeta[],
 *   onSessions(fn: () => void): () => void,
 *   history(query?: string): Promise<PastSession[]>,
 *   scratchpads(): Promise<ScratchpadSummary[]>,
 *   scratchpad(id: string): Promise<Scratchpad>,
 *   saveScratchpad(id: string, text: string, base: string, options?: { keepalive?: boolean }): Promise<ScratchpadSave>,
 *   deleteScratchpad(id: string): Promise<void>,
 *   uploadScratchpadFile(id: string, file: Blob, name: string): Promise<string>,
 *   uploadAttachment(file: Blob, name: string): Promise<string>,
 *   onScratchpad(fn: (id: string, pad: Scratchpad) => void): () => void,
 *   config(): Promise<DaemonConfig>,
 *   createSession(options: { cwd: string, resume?: string }): Promise<SessionMeta>,
 *   closeSession(session: string): Promise<void>,
 *   rpc(session: string, command: Record<string, unknown>): Promise<RpcResponse>,
 *   respondUi(session: string, response: Record<string, unknown>): Promise<void>,
 *   onUiChange(fn: (outdated: boolean) => void): () => void,
 *   checkUi(): Promise<void>,
 * }} DaemonClient
 */

/** The browser globals the client uses, injectable for tests. @typedef {{ fetch: typeof fetch, EventSource: typeof EventSource, setTimeout: typeof setTimeout }} ClientEnv */

/**
 * @param {Partial<ClientEnv>} [env]
 * @returns {DaemonClient}
 */
export function createDaemonClient(env = {}) {
  const { fetch: doFetch, EventSource: Source, setTimeout: later } = {
    fetch: globalThis.fetch.bind(globalThis),
    EventSource: globalThis.EventSource,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    ...env,
  };

  /** @type {ConnectionStatus} */
  let status = 'connecting';
  /** @type {string | null} */
  let bootId = null;
  /** @type {Map<string, SessionEvent[]>} */
  const buffers = new Map();
  /** @type {Map<string, SessionMeta>} */
  const metas = new Map();
  /** @type {Map<string, Set<(event: SessionEvent) => void>>} */
  const subscribers = new Map();
  /** @type {Set<(status: ConnectionStatus) => void>} */
  const statusListeners = new Set();
  /** @type {Set<() => void>} */
  const resetListeners = new Set();
  /** @type {Set<() => void>} */
  const sessionListeners = new Set();
  /** @type {Set<(id: string, pad: Scratchpad) => void>} */
  const scratchpadListeners = new Set();
  /** @type {Set<(outdated: boolean) => void>} */
  const uiListeners = new Set();
  /** The UI version this page loaded: the first one heard. @type {string | null} */
  let loadedUi = null;
  /** The UI version served, as last heard. @type {string | null} */
  let servedUi = null;
  const sessionsChanged = () => {
    for (const fn of sessionListeners) fn();
  };

  /** @param {unknown} version */
  function noteUi(version) {
    if (typeof version !== 'string' || version === servedUi) return;
    servedUi = version;
    if (loadedUi === null) loadedUi = version;
    else for (const fn of uiListeners) fn(version !== loadedUi);
  }

  /** @param {ConnectionStatus} next */
  function setStatus(next) {
    if (next === status) return;
    status = next;
    for (const fn of statusListeners) fn(next);
  }

  /** @param {HelloEvent} hello */
  function onHello(hello) {
    if (bootId !== null && hello.bootId !== bootId) {
      buffers.clear();
      metas.clear();
      for (const fn of resetListeners) fn();
    }
    bootId = hello.bootId;
    for (const meta of hello.sessions) metas.set(meta.id, meta);
    noteUi(hello.ui);
    setStatus('open');
    sessionsChanged();
  }

  /** @param {StreamEvent} event */
  function onEvent(event) {
    if (event.kind === 'hello') return onHello(event);
    if (event.kind === 'scratchpad') {
      for (const fn of scratchpadListeners) fn(event.id, { text: event.text, rev: event.rev });
      return;
    }
    if (event.kind === 'session') {
      metas.set(event.session, event.meta);
      sessionsChanged();
    }
    let buffer = buffers.get(event.session);
    if (!buffer) buffers.set(event.session, (buffer = []));
    buffer.push(event);
    for (const fn of subscribers.get(event.session) ?? []) fn(event);
  }

  async function connect() {
    // EventSource cannot report an HTTP status, so probe authentication first.
    try {
      const res = await doFetch('/api/config');
      if (res.status === 401 || res.status === 403) return setStatus('unauthorized');
    } catch {
      setStatus('down');
      later(connect, RECONNECT_MS);
      return;
    }
    const source = new Source('/api/stream');
    source.onmessage = (message) => onEvent(JSON.parse(message.data));
    source.onerror = () => {
      if (source.readyState === Source.CLOSED) {
        setStatus('down');
        later(connect, RECONNECT_MS);
      } else {
        setStatus('down'); // the browser reconnects by itself, resuming after the last event id
      }
    };
  }

  /** @param {string} path @param {RequestInit} [init] */
  async function request(path, init) {
    const res = await doFetch(path, {
      ...init,
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    });
    if (res.status === 204) return null;
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new DaemonError(res.status, body?.error ?? `daemon answered ${res.status}`);
    return body;
  }

  /** Posts a file as the raw body; the daemon answers with where it stored it. @param {string} path @param {Blob} file @param {string} name @returns {Promise<string>} */
  async function upload(path, file, name) {
    const res = await doFetch(path, {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(name) },
      body: file,
    });
    const answer = await res.json().catch(() => null);
    if (!res.ok) throw new DaemonError(res.status, answer?.error ?? `daemon answered ${res.status}`);
    return answer.path;
  }

  const sessionPath = (/** @type {string} */ session) => `/api/sessions/${encodeURIComponent(session)}`;
  const padPath = (/** @type {string} */ id) => `/api/scratchpads/${encodeURIComponent(id)}`;

  /** @param {string} session @param {(event: SessionEvent) => void} fn @returns {() => void} */
  function subscribe(session, fn) {
    for (const event of buffers.get(session) ?? []) fn(event);
    let set = subscribers.get(session);
    if (!set) subscribers.set(session, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  /**
   * omp's answer to a request the daemon stopped holding open (202 pending). It arrives on
   * the stream like every frame, possibly already; the request fails if omp or the daemon
   * goes away first.
   * @param {string} session @param {string} id @returns {Promise<RpcResponse>}
   */
  function streamedResponse(session, id) {
    return new Promise((resolve, reject) => {
      let done = false;
      let stop = () => {};
      /** @param {() => void} settle */
      const finish = (settle) => {
        if (done) return;
        done = true;
        stop();
        resetListeners.delete(onReset);
        settle();
      };
      const onReset = () => finish(() => reject(new DaemonError(409, 'the daemon restarted before omp answered')));
      resetListeners.add(onReset);
      stop = subscribe(session, (event) => {
        if (event.kind === 'frame' && event.frame.type === 'response' && event.frame.id === id) {
          finish(() => resolve(/** @type {RpcResponse} */ (event.frame)));
        } else if (event.kind === 'session' && (event.meta.status === 'exited' || event.meta.status === 'failed')) {
          finish(() => reject(new DaemonError(409, 'omp exited before answering')));
        }
      });
      if (done) stop(); // settled during the synchronous replay, before `stop` was assigned
    });
  }

  void connect();

  return {
    status: () => status,
    onStatus(fn) {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    onReset(fn) {
      resetListeners.add(fn);
      return () => resetListeners.delete(fn);
    },
    subscribe,
    meta: (session) => metas.get(session) ?? null,
    sessions: () => [...metas.values()],
    onSessions(fn) {
      sessionListeners.add(fn);
      return () => sessionListeners.delete(fn);
    },
    async history(query = '') {
      const body = await request(`/api/history${query ? `?q=${encodeURIComponent(query)}` : ''}`);
      return body.sessions;
    },
    async scratchpads() {
      return (await request('/api/scratchpads')).pads;
    },
    scratchpad: (id) => request(padPath(id)),
    async saveScratchpad(id, text, base, { keepalive = false } = {}) {
      const body = JSON.stringify({ text, base });
      const res = await doFetch(padPath(id), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body,
        // Browsers refuse keepalive bodies over 64 KiB outright; a plain request may still land.
        keepalive: keepalive && new TextEncoder().encode(body).length <= KEEPALIVE_MAX_BYTES,
      });
      const answer = await res.json().catch(() => null);
      if (res.status === 409 && answer?.current) return { ok: false, current: answer.current };
      if (!res.ok) throw new DaemonError(res.status, answer?.error ?? `daemon answered ${res.status}`);
      return { ok: true, rev: answer.rev };
    },
    async deleteScratchpad(id) {
      await request(padPath(id), { method: 'DELETE' });
    },
    uploadScratchpadFile(id, file, name) {
      return upload(`${padPath(id)}/assets`, file, name);
    },
    uploadAttachment(file, name) {
      return upload('/api/attachments', file, name);
    },
    onScratchpad(fn) {
      scratchpadListeners.add(fn);
      return () => scratchpadListeners.delete(fn);
    },
    onUiChange(fn) {
      uiListeners.add(fn);
      return () => uiListeners.delete(fn);
    },
    /** Asks which UI version is served now: files can change under a running daemon. */
    async checkUi() {
      const body = await request('/api/ui').catch(() => null);
      noteUi(body?.version);
    },
    config: () => request('/api/config'),
    async createSession({ cwd, resume }) {
      const body = await request('/api/sessions', { method: 'POST', body: JSON.stringify({ cwd, resume }) });
      metas.set(body.session.id, body.session);
      return body.session;
    },
    async closeSession(session) {
      await request(sessionPath(session), { method: 'DELETE' });
    },
    async rpc(session, command) {
      const body = await request(`${sessionPath(session)}/rpc`, { method: 'POST', body: JSON.stringify(command) });
      return body?.pending === true ? streamedResponse(session, body.id) : body;
    },
    async respondUi(session, response) {
      await request(`${sessionPath(session)}/ui`, { method: 'POST', body: JSON.stringify(response) });
    },
  };
}

/** @type {DaemonClient | null} */
let shared = null;

/** The page's one connection, opened on first use. */
export const getDaemon = () => (shared ??= createDaemonClient());
