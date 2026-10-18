import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHub } from '../daemon/hub.js';
import { createDaemonServer } from '../daemon/server.js';
import { SETUP_COMMANDS } from '../daemon/omp-session.js';
/** @import { AddressInfo } from 'node:net' */
/** @import { Server } from 'node:http' */
/** @import { StreamEvent, SessionEvent, SessionMeta } from '../daemon/wire.js' */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FAKE_OMP = join(ROOT, 'tests/fixtures/fake-omp.js');
const TOKEN = 'a'.repeat(64);

/** @type {Server} */
let server;
/** @type {ReturnType<typeof createHub>} */
let hub;
let port = 0;
let cwd = '';

/**
 * @param {{ method?: string, path: string, headers?: Record<string, string>, body?: unknown, auth?: boolean, origin?: boolean }} options
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, text: string, json: any }>}
 */
function call({ method = 'GET', path, headers = {}, body, auth = true, origin = method !== 'GET' }) {
  const all = {
    host: `127.0.0.1:${port}`,
    ...(auth ? { cookie: `ac_token=${TOKEN}` } : {}),
    ...(origin ? { origin: `http://127.0.0.1:${port}` } : {}),
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...headers,
  };
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: all }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (text += d));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/**
 * Reads the event stream until `done` is satisfied or the timeout passes.
 * @param {{ lastEventId?: string, done?: (events: StreamEvent[]) => boolean, ms?: number }} options
 * @returns {Promise<{ events: StreamEvent[], ids: string[] }>}
 */
function readStream({ lastEventId, done = () => false, ms = 3000 }) {
  return new Promise((resolve, reject) => {
    /** @type {StreamEvent[]} */
    const events = [];
    /** @type {string[]} */
    const ids = [];
    let buffer = '';
    const headers = { host: `127.0.0.1:${port}`, cookie: `ac_token=${TOKEN}`, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) };
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/stream', headers }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          for (const l of block.split('\n')) {
            if (l.startsWith('id: ')) ids.push(l.slice(4));
            if (l.startsWith('data: ')) events.push(JSON.parse(l.slice(6)));
          }
        }
        if (done(events)) finish();
      });
    });
    const finish = () => {
      clearTimeout(timer);
      req.destroy();
      resolve({ events, ids });
    };
    const timer = setTimeout(finish, ms);
    req.on('error', (err) => (/** @type {any} */ (err).code === 'ECONNRESET' ? undefined : reject(err)));
    req.end();
  });
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
  /** @type {SessionEvent[]} */ (events.filter((e) => e.kind !== 'hello' && e.session === session));

before(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'ac-daemon-test-'));
  hub = createHub({ ompPath: FAKE_OMP });
  server = createDaemonServer({
    hub,
    token: TOKEN,
    root: ROOT,
    config: { defaultCwd: cwd, home: cwd, ompVersion: 'omp/fake' },
    rpcHoldMs: 200,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  port = /** @type {AddressInfo} */ (server.address()).port;
});

after(async () => {
  await hub.closeAll();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve(undefined)));
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
    assert.equal(res.headers.location, '/?x=1');
    const cookie = String(res.headers['set-cookie']);
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
