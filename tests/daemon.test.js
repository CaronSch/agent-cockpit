import { test, describe, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHistory } from '../daemon/history.js';
import { createHub } from '../daemon/hub.js';
import { createAttachments } from '../daemon/attachments.js';
import { createScratchpads } from '../daemon/scratchpad.js';
import { createDaemonServer } from '../daemon/server.js';
import { SETUP_COMMANDS } from '../daemon/omp-session.js';
/** @import { StreamEvent, SessionEvent, SessionMeta } from '../daemon/wire.js' */

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
 * Reads the event stream until `done` is satisfied or the timeout passes.
 * @param {{ lastEventId?: string, done?: (events: StreamEvent[]) => boolean, ms?: number }} options
 * @returns {Promise<{ events: StreamEvent[], ids: string[] }>}
 */
async function readStream({ lastEventId, done = () => false, ms = 3000 }) {
  /** @type {StreamEvent[]} */
  const events = [];
  /** @type {string[]} */
  const ids = [];
  const headers = { cookie: `ac_token=${TOKEN}`, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) };
  const res = await fetch(`http://127.0.0.1:${port}/api/stream`, { headers, signal: AbortSignal.timeout(ms) });
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
      if (done(events)) break;
    }
  } catch (err) {
    if (/** @type {Error} */ (err).name !== 'TimeoutError') throw err;
  }
  return { events, ids };
}

/** @param {string} id @param {SessionMeta['status']} status */
async function waitForStatus(id, status) {
  for (let i = 0; i < 100; i++) {
    const { json } = await call({ path: '/api/sessions' });
    const meta = json.sessions.find((/** @type {SessionMeta} */ s) => s.id === id);
    if (meta?.status === status) return meta;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`session ${id} never became ${status}`);
}

/** @param {StreamEvent[]} events @param {string} session @returns {SessionEvent[]} */
const forSession = (events, session) =>
  /** @type {SessionEvent[]} */ (events.filter((e) => e.kind !== 'hello' && e.kind !== 'scratchpad' && e.session === session));

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'ac-daemon-test-'));
  hub = createHub({ ompPath: FAKE_OMP });
  server = createDaemonServer({
    hub,
    history: createHistory({ root: join(cwd, 'no-sessions-yet') }),
    scratchpads: createScratchpads({ dir: join(cwd, 'state', 'scratchpads') }),
    attachments: createAttachments({ dir: join(cwd, 'state', 'attachments') }),
    token: TOKEN,
    root: ROOT,
    config: { defaultCwd: cwd, home: cwd, scratchpadDir: join(cwd, 'state', 'scratchpads') },
    port: 0,
    rpcHoldMs: 200,
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

  test('the token link sets an HttpOnly, SameSite=Strict cookie and drops the token from the URL', async () => {
    const res = await call({ path: `/?token=${TOKEN}&x=1`, auth: false });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/?x=1');
    const cookie = String(res.headers.get('set-cookie'));
    assert.match(cookie, new RegExp(`^ac_token=${TOKEN};`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.equal((await call({ path: '/?token=wrong', auth: false })).status, 403);
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

    const { events } = await readStream({ ms: 300 });
    const mine = forSession(events, id);
    const readyAt = mine.findIndex((e) => e.kind === 'session' && e.meta.status === 'ready');
    const sent = mine.slice(0, readyAt).flatMap((e) => (e.kind === 'sent' ? [e.command.type] : []));
    assert.deepEqual(sent, SETUP_COMMANDS.map((c) => c.type));
  });

  test('commands return omp’s response, and everything omp prints lands in the log in order', async () => {
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
    const id = json.session.id;
    await waitForStatus(id, 'ready');

    const state = await call({ method: 'POST', path: `/api/sessions/${id}/rpc`, body: { type: 'get_state', id: 'mine' } });
    assert.equal(state.json.command, 'get_state');
    assert.equal(state.json.data.model.id, 'fake-model');
    assert.notEqual(state.json.id, 'mine', 'the daemon owns request ids');

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
    const first = await readStream({ ms: 200 });
    const last = /** @type {string} */ (first.ids.at(-1));
    assert.ok(last.startsWith(`${hub.bootId}:`));

    const resumed = await readStream({ lastEventId: last, ms: 200 });
    assert.equal(resumed.events.filter((e) => e.kind !== 'hello').length, 0);
    assert.equal(resumed.events[0].kind, 'hello');

    const stale = await readStream({ lastEventId: `other-boot:${last.split(':')[1]}`, ms: 200 });
    assert.equal(stale.ids.length, first.ids.length);
  });

  test('a command omp answers slowly frees the request and delivers the answer on the stream', async () => {
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
    const id = json.session.id;
    await waitForStatus(id, 'ready');
    const started = Date.now();
    const res = await call({ method: 'POST', path: `/api/sessions/${id}/rpc`, body: { type: 'bash', command: 'sleep 1' } });
    assert.equal(res.status, 202);
    assert.equal(res.json.pending, true);
    assert.ok(Date.now() - started < 550, 'the request was released before omp answered');
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
    assert.equal(ready.sessionFile, '/tmp/fake-omp-session.jsonl', 'learned from omp’s get_state before ready');
  });

  /**
   * Sends `message` in session `id` and waits until its turn has settled and anything the
   * daemon sent in reply has been answered; returns the session's whole log so far.
   * @param {string} id @param {string} message
   */
  async function turn(id, message) {
    const before = forSession((await readStream({ ms: 100 })).events, id);
    const settled = (/** @type {SessionEvent[]} */ log) => log.filter((e) => e.kind === 'frame' && e.frame.type === 'session_settled').length;
    await call({ method: 'POST', path: `/api/sessions/${id}/rpc`, body: { type: 'prompt', message } });
    await readStream({ done: (all) => settled(forSession(all, id)) > settled(before) });
    await new Promise((r) => setTimeout(r, 150)); // a /rename, if the daemon sends one, and omp's answer
    return forSession((await readStream({ ms: 100 })).events, id);
  }
  /** @param {SessionEvent[]} log */
  const renames = (log) => log.filter((e) => e.kind === 'sent' && e.command.message === '/rename').length;

  test('a session with no name asks omp for one after a turn, again after a turn too thin to name, then stops', async () => {
    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
    const id = json.session.id;
    await waitForStatus(id, 'ready');

    assert.equal(renames(await turn(id, 'hi')), 1);
    let log = await turn(id, 'fix the login bug');
    assert.equal(renames(log), 2, 'omp could not name it from "hi": ask again');
    assert.ok(log.some((e) => e.kind === 'frame' && e.frame.type === 'session_info_update' && e.frame.title === 'About fix the login bug'));
    log = await turn(id, 'now add tests');
    assert.equal(renames(log), 2, 'named: never asked again');
  });

  test('a session that already has a name is not renamed, and one that cannot be named is asked only 3 times', async () => {
    const journal = join(cwd, 'titled.jsonl');
    await Bun.write(journal, '');
    const titled = (await call({ method: 'POST', path: '/api/sessions', body: { cwd, resume: journal } })).json.session.id;
    await waitForStatus(titled, 'ready');
    assert.equal(renames(await turn(titled, 'fix the login bug')), 0);

    const { json } = await call({ method: 'POST', path: '/api/sessions', body: { cwd } });
    await waitForStatus(json.session.id, 'ready');
    /** @type {SessionEvent[]} */
    let log = [];
    for (let i = 0; i < 4; i++) log = await turn(json.session.id, 'hi');
    assert.equal(renames(log), 3);
  });

  test('a missing omp binary fails the session with the reason instead of hanging', async () => {
    const missing = createHub({ ompPath: join(cwd, 'no-such-omp') });
    const meta = missing.create({ cwd, resume: null });
    for (let i = 0; i < 100 && missing.list()[0].status === 'starting'; i++) await new Promise((r) => setTimeout(r, 20));
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
    const reading = readStream({ done: (events) => events.some((e) => e.kind === 'scratchpad') });
    await new Promise((r) => setTimeout(r, 150)); // let the stream connect before the write
    const saved = await call({ method: 'PUT', path: '/api/scratchpads/notes', body: { text: 'remember the milk', base: before.json.rev } });
    assert.equal(saved.status, 200);

    const { events, ids } = await reading;
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
