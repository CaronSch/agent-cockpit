import { test, describe, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHistory } from '../daemon/history.js';
import { createHub } from '../daemon/hub.js';
import { createAttachments } from '../daemon/attachments.js';
import { createScratchpads } from '../daemon/scratchpad.js';
import { createWorkspaces } from '../daemon/workspace.js';
import { createDaemonServer } from '../daemon/server.js';
import { listDirectory } from '../daemon/files.js';
import { loadToken } from '../daemon/token.js';
import { HISTORY_COMMAND, SETUP_COMMANDS } from '../daemon/omp-session.js';
/** @import { RpcResponse, StreamEvent, SessionEvent, SessionMeta } from '../daemon/wire.js' */

const ROOT = resolve(import.meta.dir, '..');
const FAKE_OMP = join(ROOT, 'tests/fixtures/fake-omp.js');
const TOKEN = 'a'.repeat(64);

/** @type {ReturnType<typeof createDaemonServer>} */
let server;
/** @type {ReturnType<typeof createHub>} */
let hub;
let port = 0;
let cwd = '';

/**
 * @param {{ method?: string, path: string, headers?: Record<string, string>, body?: unknown, raw?: string, auth?: boolean, origin?: boolean }} options
 * @returns {Promise<{ status: number, headers: Headers, text: string, json: any }>}
 */
async function call({ method = 'GET', path, headers = {}, body, raw, auth = true, origin = method !== 'GET' }) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      host: `127.0.0.1:${port}`,
      ...(auth ? { cookie: `ac_token=${TOKEN}` } : {}),
      ...(origin ? { origin: `http://127.0.0.1:${port}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, text, json };
}

/**
 * Connects to the event stream as a page does (resuming after `lastEventId`, if given). Once
 * it resolves, the daemon sends this connection everything new, so whatever happens next is
 * on it; `until` reads until `done` holds.
 * @param {{ lastEventId?: string }} [options]
 */
async function openStream({ lastEventId } = {}) {
  /** @type {StreamEvent[]} */
  const events = [];
  /** @type {string[]} */
  const ids = [];
  const headers = { cookie: `ac_token=${TOKEN}`, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) };
  const connection = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/stream`, { headers, signal: connection.signal });
  return {
    /** @param {(events: StreamEvent[], ids: string[]) => boolean} done @returns {Promise<{ events: StreamEvent[], ids: string[] }>} */
    async until(done) {
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for await (const bytes of /** @type {ReadableStream<Uint8Array>} */ (res.body)) {
          buffer += decoder.decode(bytes, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            for (const l of block.split('\n')) {
              if (l.startsWith('id: ')) ids.push(l.slice(4));
              if (l.startsWith('data: ')) events.push(JSON.parse(l.slice(6)));
            }
          }
          if (done(events, ids)) return { events, ids };
        }
      } finally {
        connection.abort();
      }
      throw new Error('the event stream ended');
    },
  };
}

/**
 * Reads the event stream until `done` holds.
 * @param {{ lastEventId?: string, done: (events: StreamEvent[], ids: string[]) => boolean }} options
 */
const readStream = async ({ lastEventId, done }) => (await openStream({ lastEventId })).until(done);

/** The session's meta once it has reached `status`. @param {string} id @param {SessionMeta['status']} status @returns {Promise<SessionMeta>} */
async function waitForStatus(id, status) {
  const event = await logged((e) => e.session === id && e.kind === 'session' && e.meta.status === status);
  return /** @type {SessionMeta} */ (event.kind === 'session' && event.meta);
}

/**
 * The first event in the daemon's log, already there or still to come, that `match` accepts.
 * @param {(event: SessionEvent) => boolean} match @returns {Promise<SessionEvent>}
 */
function logged(match) {
  const found = hub.since(0).find(match);
  if (found) return Promise.resolve(found);
  return new Promise((resolve) => {
    const stop = hub.subscribe((event) => {
      if (!match(event)) return;
      stop();
      resolve(event);
    });
  });
}

/**
 * Sends `command` to session `id`: the daemon accepts it at once (202, with the id it gave
 * the command), and omp's response arrives on the log.
 * @param {string} id @param {Record<string, unknown>} command @returns {Promise<RpcResponse>}
 */
async function rpc(id, command) {
  const res = await call({ method: 'POST', path: `/api/sessions/${id}/rpc`, body: command });
  assert.equal(res.status, 202);
  const answer = await logged((e) => e.session === id && e.kind === 'frame' && e.frame.type === 'response' && e.frame.id === res.json.id);
  return /** @type {RpcResponse} */ (answer.kind === 'frame' && answer.frame);
}

/** @param {StreamEvent[]} events @param {string} session @returns {SessionEvent[]} */
const forSession = (events, session) =>
  /** @type {SessionEvent[]} */ (events.filter((e) => e.kind !== 'hello' && e.kind !== 'scratchpad' && e.kind !== 'history' && e.session === session));

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'ac-daemon-test-'));
  hub = createHub({ ompPath: FAKE_OMP });
  server = createDaemonServer({
    hub,
    history: createHistory({ root: join(cwd, 'omp-sessions'), archive: join(cwd, 'state', 'archive', 'sessions') }),
    scratchpads: createScratchpads({ dir: join(cwd, 'state', 'scratchpads') }),
    attachments: createAttachments({ dir: join(cwd, 'state', 'attachments') }),
    workspaces: createWorkspaces({ dir: join(cwd, 'state', 'workspaces') }),
    token: TOKEN,
    root: ROOT,
    config: { defaultCwd: cwd, home: cwd, scratchpadDir: join(cwd, 'state', 'scratchpads') },
    port: 0,
  });
  port = /** @type {number} */ (server.port);
});

afterAll(async () => {
  await hub.closeAll();
  await server.stop(true);
});

describe('loopback guard', () => {
  test('API requests without the token cookie are refused', async () => {
    const res = await call({ path: '/api/config', auth: false });
    assert.equal(res.status, 401);
  });

  test('a page on another origin cannot act, even if the browser attached the cookie', async () => {
    const res = await call({ method: 'POST', path: '/api/sessions', body: { cwd }, headers: { origin: 'http://evil.example' } });
    assert.equal(res.status, 403);
    assert.equal(hub.list().length, 0);
  });

  test('state-changing requests must name their Origin', async () => {
    const res = await call({ method: 'POST', path: '/api/sessions', body: { cwd }, origin: false });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'missing Origin header');
  });

  test('a DNS-rebinding Host is refused for API and static files alike', async () => {
    for (const path of ['/api/config', '/']) {
      const res = await call({ path, headers: { host: `evil.example:${port}` } });
      assert.equal(res.status, 403, path);
    }
  });

  test('the workbench answers at cockpit.localhost, pages and API alike', async () => {
    const name = `cockpit.localhost:${port}`;
    const headers = { host: name, origin: `http://${name}` };
    assert.equal((await call({ path: '/', headers })).status, 200);
    assert.equal((await call({ path: '/api/config', headers })).status, 200);
    const created = await call({ method: 'POST', path: '/api/sessions', body: { cwd }, headers });
    assert.equal(created.status, 201);
    await call({ method: 'DELETE', path: `/api/sessions/${created.json.session.id}`, headers });
  });

  test('look-alikes of cockpit.localhost are refused as Host and as Origin', async () => {
    const sessionsBefore = hub.list().length;
    const lookAlikes = [`evil.localhost:${port}`, `cockpit.localhost.evil.com:${port}`, `cockpit.localhost:${port + 1}`];
    for (const name of lookAlikes) {
      for (const path of ['/api/config', '/']) {
        assert.equal((await call({ path, headers: { host: name } })).status, 403, `Host ${name} ${path}`);
      }
      const res = await call({ method: 'POST', path: '/api/sessions', body: { cwd }, headers: { origin: `http://${name}` } });
      assert.equal(res.status, 403, `Origin ${name}`);
    }
    assert.equal(hub.list().length, sessionsBefore);
  });

  test('the token link sets an HttpOnly, SameSite=Strict cookie and drops only the token from the URL', async () => {
    const res = await call({ path: `/?token=${TOKEN}&workspace=side`, auth: false });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/?workspace=side');
    const cookie = String(res.headers.get('set-cookie'));
    assert.match(cookie, new RegExp(`^ac_token=${TOKEN};`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.equal((await call({ path: '/?token=wrong', auth: false })).status, 403);
  });

  test('the token file ends up owner-only, even when an unusable one was readable by others', async () => {
    const stateDir = join(cwd, 'token-state');
    await mkdir(stateDir);
    const file = join(stateDir, 'token');
    await writeFile(file, 'not a token\n');
    await chmod(file, 0o644);
    const token = await loadToken(stateDir);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal((await Bun.file(file).text()).trim(), token);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await chmod(file, 0o644);
    assert.equal(await loadToken(stateDir), token, 'a valid token is kept');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  });

  test('static serving stays inside the UI directories', async () => {
    assert.equal((await call({ path: '/src/main.js', auth: false })).status, 200);
    const outside = ['/src/../daemon/token.js', '/src/%2e%2e/daemon/token.js', '/src/..%2fdaemon/token.js', '/src/..%2f..%2findex.html', '/daemon/token.js', '/package.json'];
    for (const path of outside) {
      assert.equal((await call({ path, auth: false })).status, 404, path);
    }
  });
});

describe('sessions', () => {
  test('a session becomes ready only after the daemon sent its setup commands', async () => {
    const created = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
    assert.equal(created.status, 201);
    const id = created.json.session.id;
    await waitForStatus(id, 'ready');

    const mine = forSession(hub.since(0), id);
    const readyAt = mine.findIndex((e) => e.kind === 'session' && e.meta.status === 'ready');
    const sent = mine.slice(0, readyAt).flatMap((e) => (e.kind === 'sent' ? [e.command.type] : []));
    assert.deepEqual(sent, SETUP_COMMANDS.map((c) => c.type));
  });

  test('a session started from a journal has its earlier history in the log before it is ready', async () => {
    const journal = join(cwd, 'history-first.jsonl');
    await Bun.write(journal, '');
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd, resume: journal } });
    const id = json.session.id;
    await waitForStatus(id, 'ready');

    const mine = forSession(hub.since(0), id);
    const readyAt = mine.findIndex((e) => e.kind === 'session' && e.meta.status === 'ready');
    const before = mine.slice(0, readyAt);
    assert.deepEqual(
      before.flatMap((e) => (e.kind === 'sent' ? [e.command.type] : [])),
      [...SETUP_COMMANDS, HISTORY_COMMAND].map((c) => c.type),
    );
    const history = before.find((e) => e.kind === 'frame' && e.frame.command === 'get_messages');
    assert.ok(history?.kind === 'frame' && history.frame.data.messages.length === 2, 'its answer too');
  });

  test('the daemon asks omp for its state again after anything that changes it, once for every window', async () => {
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
    const id = json.session.id;
    await waitForStatus(id, 'ready');
    const after = forSession(hub.since(0), id).at(-1)?.seq ?? 0;

    await rpc(id, { type: 'set_thinking_level', level: 'high' });
    const stated = await logged((e) => e.session === id && e.seq > after && e.kind === 'frame' && e.frame.command === 'get_state');
    assert.ok(stated.kind === 'frame' && stated.frame.data.thinkingLevel === 'high');
    const sent = forSession(hub.since(0), id).flatMap((e) => (e.kind === 'sent' && e.seq > after ? [e.command.type] : []));
    assert.deepEqual(sent.slice(0, 2), ['set_thinking_level', 'get_state']);
  });

  test('commands return omp’s response, and everything omp prints lands in the log in order', async () => {
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
    const id = json.session.id;
    await waitForStatus(id, 'ready');

    const state = await rpc(id, { type: 'get_state', id: 'mine' });
    assert.equal(state.command, 'get_state');
    assert.equal(state.data.model.id, 'fake-model');
    assert.notEqual(state.id, 'mine', 'the daemon owns request ids');

    await call({ method: 'POST', path: `/api/sessions/${id}/rpc`, body: { type: 'prompt', message: 'mystery garble' } });
    const { events } = await readStream({
      done: (all) => forSession(all, id).some((e) => e.kind === 'frame' && e.frame.type === 'session_settled'),
    });
    const mine = forSession(events, id);
    const frameTypes = mine.flatMap((e) => (e.kind === 'frame' ? [e.frame.type] : []));
    assert.ok(frameTypes.includes('mystery_frame'), 'unknown frame types are relayed, not filtered');
    const garbled = mine.find((e) => e.kind === 'garbled');
    assert.ok(garbled?.kind === 'garbled' && garbled.line === 'this line is not json');
    const seqs = mine.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  });

  test('every stream connection opens with the version of the UI files served, as /api/ui reports it', async () => {
    const { events } = await readStream({ done: (all) => all.length > 0 });
    const { json } = await call({ path: '/api/ui' });
    assert.match(json.version, /^[0-9a-f]{16}$/);
    assert.deepEqual(events[0]?.kind === 'hello' && events[0].ui, json.version);
  });

  test('a reconnect with the current boot id gets only what it missed; a stale boot id gets everything', async () => {
    const seen = hub.since(0).length;
    const first = await readStream({ done: (_, ids) => ids.length >= seen });
    const last = /** @type {string} */ (first.ids.at(-1));
    assert.equal(last, `${hub.bootId}:${seen}`);

    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd } }); // something to miss
    await waitForStatus(json.session.id, 'ready');
    const missed = hub.since(seen).length;
    const resumed = await readStream({ lastEventId: last, done: (_, ids) => ids.length >= missed });
    assert.equal(resumed.events[0].kind, 'hello');
    assert.equal(resumed.ids[0], `${hub.bootId}:${seen + 1}`, 'nothing it had seen');

    const stale = await readStream({ lastEventId: `other-boot:${seen}`, done: (_, ids) => ids.length > 0 });
    assert.equal(stale.ids[0], `${hub.bootId}:1`, 'everything');
  });

  test('a command is accepted at once, and omp’s answer, however slow, arrives on the stream', async () => {
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
    const id = json.session.id;
    await waitForStatus(id, 'ready');
    const res = await call({ method: 'POST', path: `/api/sessions/${id}/rpc`, body: { type: 'bash', command: 'sleep 1' } });
    assert.equal(res.status, 202);
    assert.deepEqual(Object.keys(res.json), ['id']);
    const answered = (/** @type {SessionEvent} */ e) => e.kind === 'frame' && e.frame.id === res.json.id;
    assert.ok(!forSession(hub.since(0), id).some(answered), 'the request was released before omp answered');
    const { events } = await readStream({
      done: (all) => forSession(all, id).some((e) => e.kind === 'frame' && e.frame.id === res.json.id),
    });
    const answer = forSession(events, id).find((e) => e.kind === 'frame' && e.frame.id === res.json.id);
    assert.ok(answer?.kind === 'frame');
    assert.equal(answer.frame.command, 'bash');
    assert.equal(answer.frame.data.output, 'hi\n');
  });

  test('dialog answers reach omp', async () => {
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
    const id = json.session.id;
    await waitForStatus(id, 'ready');
    await call({ method: 'POST', path: `/api/sessions/${id}/rpc`, body: { type: 'prompt', message: 'ask me' } });
    const asked = await readStream({
      done: (all) => forSession(all, id).some((e) => e.kind === 'frame' && e.frame.method === 'ask'),
    });
    const request = forSession(asked.events, id).find((e) => e.kind === 'frame' && e.frame.method === 'ask');
    assert.ok(request?.kind === 'frame');
    const answered = await call({
      method: 'POST',
      path: `/api/sessions/${id}/ui`,
      body: { id: request.frame.id, answers: [{ id: 'db', selectedOptions: ['SQLite'] }] },
    });
    assert.equal(answered.status, 204);
    const { events } = await readStream({
      done: (all) => forSession(all, id).some((e) => e.kind === 'frame' && e.frame.type === 'session_settled'),
    });
    const reply = forSession(events, id).findLast((e) => e.kind === 'frame' && e.frame.type === 'message_end');
    assert.ok(reply?.kind === 'frame');
    assert.match(JSON.stringify(reply.frame.message.content), /SQLite/);
  });

  test('closing a session stops omp and reports it exited', async () => {
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
    const id = json.session.id;
    await waitForStatus(id, 'ready');
    assert.equal((await call({ method: 'DELETE', path: `/api/sessions/${id}` })).status, 204);
    const meta = await waitForStatus(id, 'exited');
    assert.equal(meta.pid, null);
    assert.equal((await call({ method: 'POST', path: `/api/sessions/${id}/rpc`, body: { type: 'get_state' } })).status, 409);
  });

  test('each session reports the journal it writes, so a window can tell a past session is open', async () => {
    const journal = join(cwd, 'earlier.jsonl');
    await Bun.write(journal, '');
    const resumed = await call({ method: 'POST', path: '/api/sessions', body: { cwd, resume: journal } });
    assert.equal(resumed.json.session.sessionFile, journal, 'known from the start for a resumed session');

    const fresh = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
    assert.equal(fresh.json.session.sessionFile, null);
    const ready = await waitForStatus(fresh.json.session.id, 'ready');
    assert.match(String(ready.sessionFile), /\.jsonl$/, 'learned from omp’s get_state before ready');
  });

  test('a fork runs a new session on a copy of the journal and leaves the journal alone', async () => {
    const journal = join(cwd, 'to-fork.jsonl');
    const lines = [
      { type: 'title', v: 1, title: 'Login work' },
      { type: 'session', version: 3, id: 'source', timestamp: '2026-10-01T10:00:00.000Z', cwd },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'fix the login bug' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'fixed it' }] } },
    ];
    const original = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
    await Bun.write(journal, original);

    const { status, json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd, fork: journal } });
    assert.equal(status, 201);
    assert.equal(json.session.fork, journal);
    assert.equal(json.session.resume, null);
    const id = json.session.id;
    const ready = await waitForStatus(id, 'ready');
    assert.ok(ready.sessionFile && ready.sessionFile !== journal, 'the fork writes a journal of its own');
    const copied = await rpc(id, { type: 'get_messages' });
    const texts = copied.data.messages.map((/** @type {any} */ m) => m.content[0].text);
    assert.deepEqual(texts, ['fix the login bug', 'fixed it'], 'the conversation so far');

    await turn(id, 'now add tests');
    assert.equal(await Bun.file(journal).text(), original, 'the source journal is untouched');
    assert.match(await Bun.file(ready.sessionFile).text(), /now add tests/);
    await rm(ready.sessionFile);
  });

  test('a fork needs an existing journal, and cannot also resume one', async () => {
    const journal = join(cwd, 'fork-me.jsonl');
    await Bun.write(journal, '');
    const before = hub.list().length;
    /** @type {Array<[Record<string, unknown>, RegExp]>} */
    const refused = [
      [{ cwd, fork: join(cwd, 'missing.jsonl') }, /^fork is not an existing file/],
      [{ cwd, fork: cwd }, /^fork is not an existing file/],
      [{ cwd, fork: ' ' }, /^fork is required/],
      [{ cwd, fork: journal, resume: journal }, /^resume and fork cannot be combined/],
    ];
    for (const [body, error] of refused) {
      const res = await call({ method: 'POST', path: '/api/sessions', body });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.json.error, error);
    }
    assert.equal(hub.list().length, before, 'nothing was launched');
  });

  /**
   * Sends `message` in session `id` and waits until its turn has settled, then until omp has
   * answered a `get_state` sent after it: the daemon handles omp's frames in order, so
   * anything it sends in reply to the settled turn is in the log before that. Returns the
   * session's whole log so far.
   * @param {string} id @param {string} message
   */
  async function turn(id, message) {
    const from = hub.since(0).length;
    await rpc(id, { type: 'prompt', message });
    await logged((e) => e.seq > from && e.session === id && e.kind === 'frame' && e.frame.type === 'session_settled');
    await rpc(id, { type: 'get_state' });
    return forSession(hub.since(0), id);
  }

  test('the daemon never names a session by itself: after a turn it only asks for the state', async () => {
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
    const id = json.session.id;
    await waitForStatus(id, 'ready');
    const log = await turn(id, 'fix the login bug');
    const after = log.slice(log.findIndex((e) => e.kind === 'sent' && e.command.type === 'prompt'));
    assert.deepEqual(
      after.flatMap((e) => (e.kind === 'sent' ? [e.command.type] : [])),
      ['prompt', 'get_state', 'get_state'],
      'the daemon’s state refresh after the turn, then the test’s own',
    );
  });

  test('a missing omp binary fails the session with the reason instead of hanging', async () => {
    const missing = createHub({ ompPath: join(cwd, 'no-such-omp') });
    /** @type {Promise<void>} */
    const settled = new Promise((resolve) => missing.subscribe((e) => e.kind === 'session' && e.meta.status !== 'starting' && resolve()));
    const meta = missing.create({ cwd, resume: null, fork: null });
    await settled;
    const [after] = missing.list();
    assert.equal(after.id, meta.id);
    assert.equal(after.status, 'failed');
    assert.match(String(after.error), /ENOENT/);
  });

  test('a cwd that is not a directory is rejected before anything is launched', async () => {
    const before = hub.list().length;
    const res = await call({ method: 'POST', path: '/api/sessions', body: { cwd: join(cwd, 'missing') } });
    assert.equal(res.status, 400);
    assert.equal(hub.list().length, before);
  });
});

describe('scratchpads', () => {
  test('a save from the current version lands, and every open page hears which pad changed', async () => {
    const before = await call({ path: '/api/scratchpads/notes' });
    assert.equal(before.status, 200);
    const stream = await openStream();
    const saved = await call({ method: 'PUT', path: '/api/scratchpads/notes', body: { text: 'remember the milk', base: before.json.rev } });
    assert.equal(saved.status, 200);

    const { events, ids } = await stream.until((all) => all.some((e) => e.kind === 'scratchpad'));
    const heard = events.find((e) => e.kind === 'scratchpad');
    assert.deepEqual(heard, { kind: 'scratchpad', id: 'notes', text: 'remember the milk', rev: saved.json.rev });
    assert.equal(ids.length, events.filter((e) => e.kind !== 'hello' && e.kind !== 'scratchpad').length, 'not part of the replayable log');
    assert.deepEqual((await call({ path: '/api/scratchpads/notes' })).json, { text: 'remember the milk', rev: saved.json.rev });
    assert.deepEqual(
      (await call({ path: '/api/scratchpads' })).json.pads.map((/** @type {any} */ p) => [p.id, p.title]),
      [['notes', 'remember the milk']],
    );
  });

  test('a save from an older version is refused with what is there now', async () => {
    const { json: current } = await call({ path: '/api/scratchpads/race' });
    await call({ method: 'PUT', path: '/api/scratchpads/race', body: { text: 'first', base: current.rev } });
    const stale = await call({ method: 'PUT', path: '/api/scratchpads/race', body: { text: 'second', base: current.rev } });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.current.text, 'first');
    assert.equal((await call({ path: '/api/scratchpads/race' })).json.text, 'first');
  });

  test('a malformed save is a 400, and a pad id that is not one is a 404', async () => {
    assert.equal((await call({ method: 'PUT', path: '/api/scratchpads/notes', body: { text: 42 } })).status, 400);
    assert.equal((await call({ path: '/api/scratchpads/..%2Ftoken' })).status, 404);
    assert.equal((await call({ path: '/api/scratchpads/Notes' })).status, 404);
  });

  test('a stored screenshot is served as an image; anything else downloads and can never run', async () => {
    const up = await call({ method: 'POST', path: '/api/scratchpads/shots/assets', headers: { 'x-file-name': encodeURIComponent('my shot.png') }, raw: 'PNGDATA' });
    assert.equal(up.status, 201);
    assert.match(up.json.path, /^shots\.assets\/[a-z0-9]+-my-shot\.png$/);
    const image = await call({ path: `/api/scratchpads/shots/assets/${up.json.path.split('/')[1]}` });
    assert.equal(image.status, 200);
    assert.equal(image.text, 'PNGDATA');
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.match(String(image.headers.get('content-security-policy')), /sandbox/);
    assert.equal(image.headers.get('content-disposition'), null);

    const page = await call({ method: 'POST', path: '/api/scratchpads/shots/assets', headers: { 'x-file-name': 'evil.html' }, raw: '<script>alert(1)</script>' });
    const served = await call({ path: `/api/scratchpads/shots/assets/${page.json.path.split('/')[1]}` });
    assert.equal(served.headers.get('content-type'), 'application/octet-stream');
    assert.equal(served.headers.get('content-disposition'), 'attachment');
    assert.match(String(served.headers.get('content-security-policy')), /sandbox/);
    assert.equal((await call({ path: '/api/scratchpads/shots/assets/nope.png' })).status, 404);
  });

  test('deleting a pad removes it and its files', async () => {
    const { json } = await call({ path: '/api/scratchpads/doomed' });
    await call({ method: 'PUT', path: '/api/scratchpads/doomed', body: { text: 'bye', base: json.rev } });
    const up = await call({ method: 'POST', path: '/api/scratchpads/doomed/assets', headers: { 'x-file-name': 'a.png' }, raw: 'x' });
    assert.equal((await call({ method: 'DELETE', path: '/api/scratchpads/doomed' })).status, 204);
    assert.equal((await call({ path: '/api/scratchpads/doomed' })).json.text, '');
    assert.equal((await call({ path: `/api/scratchpads/doomed/assets/${up.json.path.split('/')[1]}` })).status, 404);
    assert.ok(!(await call({ path: '/api/scratchpads' })).json.pads.some((/** @type {any} */ p) => p.id === 'doomed'));
  });
});

describe('workspaces', () => {
  const tree = { kind: 'leaf', id: 'w_1', widget: 'pane' };
  const screen = '/api/workspaces/desk/screens/s_0000000a';

  test('like every API route, workspaces need the token, and saving one needs the page’s Origin', async () => {
    assert.equal((await call({ path: '/api/workspaces/desk', auth: false })).status, 401);
    assert.equal((await call({ method: 'PUT', path: screen, body: { tree, base: null }, auth: false })).status, 401);
    assert.equal((await call({ method: 'PUT', path: screen, body: { tree, base: null }, origin: false })).status, 403);
    assert.deepEqual((await call({ path: '/api/workspaces/desk' })).json, { screens: [] }, 'nothing was saved');
  });

  test('a screen is stored by its first save, refused from an older rev, and deleted when emptied', async () => {
    assert.deepEqual((await call({ method: 'PUT', path: screen, body: { tree, base: null } })).json, { rev: 1 });
    assert.deepEqual((await call({ path: '/api/workspaces/desk' })).json, { screens: [{ id: 's_0000000a', rev: 1, tree }] });
    const stale = await call({ method: 'PUT', path: screen, body: { tree: null, base: null } });
    assert.equal(stale.status, 409);
    assert.deepEqual(stale.json.current, { id: 's_0000000a', rev: 1, tree });
    assert.deepEqual((await call({ method: 'PUT', path: screen, body: { tree: null, base: 1 } })).json, { rev: null });
    assert.deepEqual((await call({ path: '/api/workspaces/desk' })).json, { screens: [] });
  });

  test('a layout that is not one is a 400; a name or screen id that is not one is a 404', async () => {
    for (const body of [{ tree: { kind: 'leaf', id: 7 }, base: null }, { tree, base: 0 }, { tree, base: '1' }, { tree }, []]) {
      assert.equal((await call({ method: 'PUT', path: screen, body })).status, 400, JSON.stringify(body));
    }
    assert.equal((await call({ path: '/api/workspaces/..%2Ftoken' })).status, 404);
    assert.equal((await call({ path: '/api/workspaces/Desk' })).status, 404);
    assert.equal((await call({ method: 'PUT', path: '/api/workspaces/desk/screens/..%2Fx', body: { tree, base: null } })).status, 404);
    assert.deepEqual((await call({ path: '/api/workspaces/desk' })).json, { screens: [] });
  });

  test('a corrupt workspace file is reported, not replaced', async () => {
    const file = join(cwd, 'state', 'workspaces', 'broken.json');
    await Bun.write(file, '{not json');
    const read = await call({ path: '/api/workspaces/broken' });
    assert.equal(read.status, 500);
    assert.match(read.json.error, /broken\.json is not a workspace file/);
    assert.equal((await call({ method: 'PUT', path: '/api/workspaces/broken/screens/s_0000000a', body: { tree, base: null } })).status, 500);
    assert.equal(await Bun.file(file).text(), '{not json');
  });
});

describe('session archive', () => {
  const sessionsDir = () => join(cwd, 'omp-sessions', '-p');
  const archiveDir = () => join(cwd, 'state', 'archive', 'sessions', '-p');
  /** A journal the Sessions window lists, with a subagent folder beside it. @param {string} name */
  async function pastSession(name) {
    const file = join(sessionsDir(), `${name}.jsonl`);
    const lines = [
      { type: 'session', version: 3, id: name, timestamp: '2026-10-01T10:00:00.000Z', cwd },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: `work on ${name}` }] } },
    ];
    await Bun.write(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    await Bun.write(join(sessionsDir(), name, 'Explorer.jsonl'), '');
    return file;
  }
  /** @param {boolean} [archived] */
  const ids = async (archived = false) =>
    (await call({ path: `/api/history${archived ? '?archived=1' : ''}` })).json.sessions.map((/** @type {any} */ s) => s.id).sort();

  test('like every API route, archive and restore need the token and the page’s Origin', async () => {
    const file = await pastSession('guarded');
    for (const path of ['/api/history/archive', '/api/history/restore']) {
      assert.equal((await call({ method: 'POST', path, body: { file }, auth: false })).status, 401);
      assert.equal((await call({ method: 'POST', path, body: { file }, origin: false })).status, 403);
      assert.equal((await call({ method: 'POST', path, body: { file }, headers: { origin: 'http://evil.example' } })).status, 403);
    }
    assert.ok(await Bun.file(file).exists(), 'nothing moved');
    await rm(file);
    await rm(join(sessionsDir(), 'guarded'), { recursive: true });
  });

  test('an archived session leaves the list for the archived list, and restore brings it back', async () => {
    const file = await pastSession('shelved');
    const archived = await call({ method: 'POST', path: '/api/history/archive', body: { file } });
    assert.equal(archived.status, 200);
    assert.equal(archived.json.file, join(archiveDir(), 'shelved.jsonl'));
    assert.ok(await Bun.file(join(archiveDir(), 'shelved', 'Explorer.jsonl')).exists(), 'its folder went with it');
    assert.ok(!(await Bun.file(file).exists()));
    assert.ok(!(await ids()).includes('shelved'));
    assert.ok((await ids(true)).includes('shelved'));

    const restored = await call({ method: 'POST', path: '/api/history/restore', body: { file: archived.json.file } });
    assert.deepEqual(restored.json, { file });
    assert.ok((await ids()).includes('shelved'));
    assert.ok(!(await ids(true)).includes('shelved'));
  });

  test('restore refuses to replace a journal that is back at the same place', async () => {
    const file = await pastSession('twice');
    const { json } = await call({ method: 'POST', path: '/api/history/archive', body: { file } });
    await Bun.write(file, 'newer');
    const res = await call({ method: 'POST', path: '/api/history/restore', body: { file: json.file } });
    assert.equal(res.status, 409);
    assert.match(res.json.error, /already there, not replaced/);
    assert.equal(await Bun.file(file).text(), 'newer');
    assert.ok(await Bun.file(json.file).exists());
  });

  test('a session open in a window cannot be archived until it is closed', async () => {
    const file = await pastSession('busy');
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd, resume: file } });
    await waitForStatus(json.session.id, 'ready');
    const refused = await call({ method: 'POST', path: '/api/history/archive', body: { file } });
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /open in a window/);
    assert.ok(await Bun.file(file).exists());

    await call({ method: 'DELETE', path: `/api/sessions/${json.session.id}` });
    await waitForStatus(json.session.id, 'exited');
    assert.equal((await call({ method: 'POST', path: '/api/history/archive', body: { file } })).status, 200);
  });

  test('only journals the Sessions window lists can move: traversal and other paths are refused', async () => {
    const file = await pastSession('kept');
    const token = join(cwd, 'state', 'token-like.jsonl');
    await Bun.write(token, 'secret');
    /** @type {Array<[string, unknown]>} */
    const refused = [
      ['/api/history/archive', join(sessionsDir(), '..', '..', 'state', 'token-like.jsonl')],
      ['/api/history/archive', `${sessionsDir()}/../../state/token-like.jsonl`],
      ['/api/history/archive', join(sessionsDir(), 'kept', 'Explorer.jsonl')],
      ['/api/history/archive', join(archiveDir(), 'shelved.jsonl')],
      ['/api/history/archive', 'kept.jsonl'],
      ['/api/history/archive', { path: file }],
      ['/api/history/restore', file],
      ['/api/history/restore', join(archiveDir(), '..', '..', '..', 'token-like.jsonl')],
    ];
    for (const [path, target] of refused) {
      const res = await call({ method: 'POST', path, body: { file: target } });
      assert.equal(res.status, 400, `${path} ${JSON.stringify(target)}`);
    }
    assert.equal((await call({ method: 'POST', path: '/api/history/archive', raw: 'nope', headers: { 'content-type': 'application/json' } })).status, 400);
    assert.equal((await call({ method: 'POST', path: '/api/history/archive', body: { file: join(sessionsDir(), 'gone.jsonl') } })).status, 404);
    assert.equal(await Bun.file(token).text(), 'secret');
    assert.ok(await Bun.file(file).exists());
  });
});

describe('attachments', () => {
  test('an attached file is stored, owner-only and intact, at a path omp can read', async () => {
    const headers = { 'x-file-name': encodeURIComponent('Screen Shot 1.png') };
    const first = await call({ method: 'POST', path: '/api/attachments', headers, raw: 'PNG one' });
    const second = await call({ method: 'POST', path: '/api/attachments', headers, raw: 'PNG two' });
    assert.equal(first.status, 201);
    const dir = join(cwd, 'state', 'attachments');
    assert.match(first.json.path, new RegExp(`^${dir}/\\d{4}-\\d\\d-\\d\\d/[a-z0-9]+-Screen-Shot-1\\.png$`));
    assert.notEqual(first.json.path, second.json.path, 'the same name twice is two files');
    assert.equal(await Bun.file(first.json.path).text(), 'PNG one');
    assert.equal(await Bun.file(second.json.path).text(), 'PNG two');
    assert.equal((await stat(first.json.path)).mode & 0o777, 0o600);
    assert.equal((await call({ path: '/api/attachments' })).status, 405);
  });
});

describe('file listings for @ mentions', () => {
  /** @type {string} */
  let project;
  /** @type {string} */
  let files;

  beforeAll(async () => {
    project = join(cwd, 'listing', 'project');
    await mkdir(join(project, 'src'), { recursive: true });
    await Bun.write(join(project, 'notes with space.md'), 'notes');
    await Bun.write(join(project, '.env'), 'X=1');
    await Bun.write(join(cwd, 'listing', 'sibling.txt'), 'hi');
    await symlink(join(project, 'src'), join(project, 'linked'));
    const created = await call({ method: 'POST', path: '/api/sessions', body: { cwd: project } });
    files = `/api/sessions/${created.json.session.id}/files`;
  });

  /** @param {string} dir */
  const list = (dir) => call({ path: `${files}?dir=${encodeURIComponent(dir)}` });

  test('like every API route, listings need the token and refuse a foreign page', async () => {
    assert.equal((await call({ path: files, auth: false })).status, 401);
    assert.equal((await call({ path: files, headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await call({ path: files, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  });

  test('a folder is listed relative to the session’s directory, dotfiles and links to folders included', async () => {
    const res = await list('');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, {
      dir: project,
      entries: [
        { name: '.env', isDir: false },
        { name: 'linked', isDir: true },
        { name: 'notes with space.md', isDir: false },
        { name: 'src', isDir: true },
      ],
      truncated: false,
    });
    assert.deepEqual((await list('src/')).json, { dir: join(project, 'src'), entries: [], truncated: false });
  });

  test('a path may leave the session’s directory: up, from home, or absolute', async () => {
    const up = await list('../');
    assert.equal(up.json.dir, join(cwd, 'listing'));
    assert.deepEqual(up.json.entries, [
      { name: 'project', isDir: true },
      { name: 'sibling.txt', isDir: false },
    ]);
    assert.equal((await list('~/')).json.dir, homedir());
    assert.equal((await list(`${project}/src`)).json.dir, join(project, 'src'));
  });

  test('what is not a folder is a 404, and so is a session that does not exist', async () => {
    assert.equal((await list('notes with space.md')).status, 404);
    assert.equal((await list('missing/')).status, 404);
    assert.equal((await call({ path: '/api/sessions/nope/files' })).status, 404);
  });

  test('a huge folder is cut short by name, and says so', async () => {
    assert.deepEqual(await listDirectory(project, 2), {
      entries: [
        { name: '.env', isDir: false },
        { name: 'linked', isDir: true },
      ],
      truncated: true,
    });
  });
});
