import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { createDaemonClient } from '../src/daemon/client.js';
/** @import { SessionEvent, SessionMeta, StreamEvent } from '../daemon/wire.js' */

/** A controllable stand-in for the browser's EventSource. */
class FakeSource {
  static CLOSED = 2;
  /** @type {FakeSource[]} */
  static opened = [];
  readyState = 0;
  /** @type {((message: { data: string }) => void) | null} */
  onmessage = null;
  /** @type {(() => void) | null} */
  onerror = null;
  /** @param {string} url */
  constructor(url) {
    this.url = url;
    FakeSource.opened.push(this);
  }
  /** @param {StreamEvent} event */
  deliver(event) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

/** @param {string} id @param {SessionMeta['status']} [status] @returns {SessionMeta} */
const meta = (id, status = 'ready') => ({ id, cwd: '/p', resume: null, sessionFile: null, status, pid: 1, exitCode: null, error: null, startedAt: 0 });

/** @param {string} session @param {number} seq @returns {SessionEvent} */
const frame = (session, seq) => ({ kind: 'frame', frame: { type: 'agent_start' }, seq, at: 0, session });

/** @param {string} bootId @param {SessionMeta[]} [sessions] @param {string} [ui] @returns {StreamEvent} */
const hello = (bootId, sessions = [], ui = 'v1') => ({ kind: 'hello', bootId, sessions, ui });

/** @param {number} [status] @param {(url: string) => Response | null} [route] */
async function connectedClient(status = 200, route = () => null) {
  FakeSource.opened = [];
  const client = createDaemonClient({
    fetch: /** @type {typeof fetch} */ (async (/** @type {string} */ url) => route(url) ?? new Response('{}', { status })),
    EventSource: /** @type {typeof EventSource} */ (/** @type {unknown} */ (FakeSource)),
    setTimeout: /** @type {typeof setTimeout} */ (/** @type {unknown} */ (() => 0)),
  });
  await new Promise((r) => setImmediate(r));
  return { client, source: FakeSource.opened[0] };
}

describe('daemon client', () => {
  test('a window that subscribes late first receives everything already seen for its session', async () => {
    const { client, source } = await connectedClient();
    source.deliver(hello('b1', [meta('s1')]));
    source.deliver(frame('s1', 1));
    source.deliver(frame('s2', 2));
    source.deliver(frame('s1', 3));

    /** @type {number[]} */
    const seen = [];
    client.subscribe('s1', (e) => seen.push(e.seq));
    source.deliver(frame('s1', 4));
    assert.deepEqual(seen, [1, 3, 4]);
  });

  test('a daemon restart clears old history and tells listeners before the new daemon’s events arrive', async () => {
    const { client, source } = await connectedClient();
    source.deliver(hello('b1', [meta('s1')]));
    source.deliver(frame('s1', 1));

    /** @type {string[]} */
    const order = [];
    client.onReset(() => order.push(`reset, s1 known: ${client.meta('s1') !== null}`));
    client.subscribe('s1', (e) => order.push(`event ${e.seq}`));
    order.length = 0; // drop the replayed backlog

    source.deliver(hello('b2'));
    assert.deepEqual(order, ['reset, s1 known: false']);
    /** @type {number[]} */
    const late = [];
    client.subscribe('s1', (e) => late.push(e.seq));
    assert.deepEqual(late, [], 'old events are not replayed into the new boot');
  });

  test('a reconnect to the same daemon keeps history', async () => {
    const { client, source } = await connectedClient();
    let resets = 0;
    client.onReset(() => resets++);
    source.deliver(hello('b1', [meta('s1')]));
    source.deliver(frame('s1', 1));
    source.deliver(hello('b1', [meta('s1')]));
    /** @type {number[]} */
    const seen = [];
    client.subscribe('s1', (e) => seen.push(e.seq));
    assert.equal(resets, 0);
    assert.deepEqual(seen, [1]);
  });

  test('a page hears when the UI files it loaded stop being the ones served, and when they are again', async () => {
    let served = 'v1';
    const { client, source } = await connectedClient(200, (url) => (url === '/api/ui' ? Response.json({ version: served }) : null));
    /** @type {boolean[]} */
    const heard = [];
    client.onUiChange((outdated) => heard.push(outdated));
    source.deliver(hello('b1', [], 'v1')); // the files this page loaded
    source.deliver(hello('b1', [], 'v1')); // a reconnect: nothing changed
    served = 'v2';
    await client.checkUi(); // the files changed under the running daemon (a git pull)
    await client.checkUi(); // asked again: said once
    source.deliver(hello('b2', [], 'v3')); // a restart on newer files still
    source.deliver(hello('b3', [], 'v1')); // back on the files this page loaded
    assert.deepEqual(heard, [true, true, false]);
  });

  test('session metadata follows the stream', async () => {
    const { client, source } = await connectedClient();
    source.deliver(hello('b1', [meta('s1', 'starting')]));
    assert.equal(client.meta('s1')?.status, 'starting');
    source.deliver({ kind: 'session', meta: meta('s1', 'exited'), seq: 1, at: 0, session: 's1' });
    assert.equal(client.meta('s1')?.status, 'exited');
  });

  test('without the token cookie the client reports unauthorized and opens no stream', async () => {
    const { client, source } = await connectedClient(401);
    assert.equal(client.status(), 'unauthorized');
    assert.equal(source, undefined);
  });

  test('a request the daemon released resolves with omp’s answer from the stream', async () => {
    const pending = () => new Response(JSON.stringify({ pending: true, id: 'ac_7' }), { status: 202 });
    const { client, source } = await connectedClient(200, (url) => (url.endsWith('/rpc') ? pending() : null));
    source.deliver(hello('b1', [meta('s1')]));
    const answer = client.rpc('s1', { type: 'bash', command: 'sleep 9' });
    await new Promise((r) => setImmediate(r));
    source.deliver({ kind: 'frame', frame: { type: 'response', id: 'ac_6', command: 'get_state', success: true }, seq: 1, at: 0, session: 's1' });
    source.deliver({ kind: 'frame', frame: { type: 'response', id: 'ac_7', command: 'bash', success: true }, seq: 2, at: 0, session: 's1' });
    assert.equal((await answer).id, 'ac_7');
  });

  test('a released request fails instead of hanging when omp exits first', async () => {
    const pending = () => new Response(JSON.stringify({ pending: true, id: 'ac_7' }), { status: 202 });
    const { client, source } = await connectedClient(200, (url) => (url.endsWith('/rpc') ? pending() : null));
    source.deliver(hello('b1', [meta('s1')]));
    const answer = client.rpc('s1', { type: 'login', providerId: 'x' });
    await new Promise((r) => setImmediate(r));
    source.deliver({ kind: 'session', meta: meta('s1', 'exited'), seq: 1, at: 0, session: 's1' });
    await assert.rejects(answer, /omp exited before answering/);
  });
});
