import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createScratchpadStore } from '../src/scratchpad/store.js';
import { revOf } from '../daemon/scratchpad.js';
/** @import { Scratchpad } from '../daemon/wire.js' */
/** @import { DaemonClient, ConnectionStatus } from '../src/daemon/client.js' */

/**
 * The daemon's scratchpad as the store sees it: real version checks, a stream to push other
 * pages' saves through, and saves that can be held to land later.
 */
function fakeDaemon(initial = '') {
  const server = { text: initial, up: true, hold: false };
  /** @type {Set<(pad: Scratchpad) => void>} */
  const padListeners = new Set();
  /** @type {Set<(s: ConnectionStatus) => void>} */
  const statusListeners = new Set();
  /** @type {Array<() => void>} */
  const held = [];
  /** @type {Array<{ text: string, base: string }>} */
  const saves = [];
  const current = () => ({ text: server.text, rev: revOf(server.text) });
  /** Another page saves: the daemon writes, then tells every page. @param {string} text */
  const otherPageSaves = (text) => {
    server.text = text;
    for (const fn of padListeners) fn(current());
  };

  const daemon = /** @type {DaemonClient} */ (
    /** @type {unknown} */ ({
      status: () => 'open',
      onStatus: (/** @type {(s: ConnectionStatus) => void} */ fn) => (statusListeners.add(fn), () => statusListeners.delete(fn)),
      onScratchpad: (/** @type {(pad: Scratchpad) => void} */ fn) => (padListeners.add(fn), () => padListeners.delete(fn)),
      scratchpad: async () => {
        if (!server.up) throw new Error('daemon unreachable');
        return current();
      },
      saveScratchpad: (/** @type {string} */ text, /** @type {string} */ base) =>
        new Promise((resolve, reject) => {
          if (!server.up) return reject(new Error('daemon unreachable'));
          saves.push({ text, base });
          if (base !== current().rev) return resolve({ ok: false, current: current() });
          // Like the real daemon: write, tell every page (this one too), then answer. A held
          // save does all three later, so the page can keep typing before it hears anything.
          const land = () => {
            otherPageSaves(text);
            resolve({ ok: true, rev: revOf(text) });
          };
          if (server.hold) held.push(land);
          else land();
        }),
    })
  );
  const reconnect = () => {
    for (const fn of statusListeners) fn('open');
  };
  return { daemon, server, saves, held, otherPageSaves, reconnect };
}

function manualTimers() {
  /** @type {(() => void) | null} */
  let due = null;
  return {
    timers: /** @type {any} */ ({
      setTimeout: (/** @type {() => void} */ fn) => ((due = fn), 1),
      clearTimeout: () => {
        due = null;
      },
    }),
    /** Lets the save delay pass. */
    elapse() {
      const fn = due;
      due = null;
      fn?.();
    },
  };
}

const settle = () => new Promise((r) => setImmediate(r));

/** @param {string} [initial] */
async function setup(initial) {
  const fake = fakeDaemon(initial);
  const clock = manualTimers();
  const store = createScratchpadStore({ daemon: fake.daemon, timers: clock.timers });
  await settle();
  return { ...fake, ...clock, store };
}

describe('scratchpad store', () => {
  test('typing is saved once after a pause, from the version it was typed over', async () => {
    const { store, saves, server, elapse } = await setup('old');
    assert.equal(store.state().text, 'old');
    assert.equal(store.state().phase, 'saved');

    store.edit('old n');
    store.edit('old notes');
    assert.equal(store.state().phase, 'saving');
    assert.deepEqual(saves, [], 'nothing is sent while typing');
    elapse();
    await settle();
    assert.deepEqual(saves, [{ text: 'old notes', base: revOf('old') }]);
    assert.equal(server.text, 'old notes');
    assert.equal(store.state().phase, 'saved');
  });

  test('another page’s save shows up here when nothing is unsaved', async () => {
    const { store, otherPageSaves } = await setup('a');
    otherPageSaves('a, from the other tab');
    assert.equal(store.state().text, 'a, from the other tab');
    assert.equal(store.state().phase, 'saved');
  });

  test('our own save coming back on the stream, mid-typing, is not mistaken for someone else’s', async () => {
    const { store, server, saves, held, elapse } = await setup('');
    server.hold = true;
    store.edit('first');
    elapse();
    await settle();
    store.edit('first, second'); // typed while the save is on its way
    held.shift()?.(); // its echo arrives, then its answer: neither matches what is on screen now
    assert.equal(store.state().phase, 'saving', 'no conflict');
    await settle();
    elapse();
    await settle();
    held.shift()?.();
    await settle();
    assert.deepEqual(
      saves.map((s) => s.base),
      [revOf(''), revOf('first')],
      'the second save builds on the first',
    );
    assert.equal(server.text, 'first, second');
    assert.equal(store.state().phase, 'saved');
  });

  test('when both sides changed, neither is overwritten until the user picks', async () => {
    const { store, server, saves, otherPageSaves, elapse } = await setup('base');
    store.edit('base + mine');
    otherPageSaves('base + theirs');
    assert.equal(store.state().phase, 'conflict');
    assert.equal(store.state().text, 'base + mine', 'my text stays on screen');
    assert.equal(store.state().theirs?.text, 'base + theirs');
    elapse();
    await settle();
    assert.deepEqual(saves, [], 'no save while the conflict is open');

    store.keepMine();
    await settle();
    assert.equal(server.text, 'base + mine');
    assert.deepEqual(saves.at(-1), { text: 'base + mine', base: revOf('base + theirs') });
    assert.equal(store.state().phase, 'saved');
  });

  test('taking their version drops mine without saving anything', async () => {
    const { store, server, saves, otherPageSaves, elapse } = await setup('base');
    store.edit('mine');
    otherPageSaves('theirs');
    store.takeTheirs();
    elapse();
    await settle();
    assert.equal(store.state().text, 'theirs');
    assert.equal(store.state().phase, 'saved');
    assert.equal(server.text, 'theirs');
    assert.deepEqual(saves, []);
  });

  test('an outside edit nobody announced is caught when the save is refused', async () => {
    const { store, server, elapse } = await setup('notes');
    server.text = 'notes, edited in vim'; // the file changed; no page was told
    store.edit('notes, edited here');
    elapse();
    await settle();
    assert.equal(store.state().phase, 'conflict');
    assert.equal(store.state().theirs?.text, 'notes, edited in vim');
    assert.equal(server.text, 'notes, edited in vim');
  });

  test('typing while the daemon is away is kept, and saved when it is back', async () => {
    const { store, server, elapse, reconnect } = await setup('kept');
    server.up = false;
    store.edit('kept, and more');
    elapse();
    await settle();
    assert.equal(store.state().phase, 'error');
    assert.equal(store.state().text, 'kept, and more');

    server.up = true;
    reconnect();
    await settle();
    await settle();
    assert.equal(server.text, 'kept, and more');
    assert.equal(store.state().phase, 'saved');
  });
});
