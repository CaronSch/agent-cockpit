import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OMP_ID, loadUnread, markRead, markUnread } from '../daemon/unread.js';

describe('unread marks', () => {
  test('a conversation is unread since the latest time its agent waited or the user marked it', () => {
    const once = markUnread({}, 'c', 10);
    assert.deepEqual(once, { c: 10 });
    assert.deepEqual(markUnread(once, 'c', 20), { c: 20 });
    assert.equal(markUnread(once, 'c', 5), once, 'an older wait changes nothing');
    assert.deepEqual(markUnread(once, 'd', 1), { c: 10, d: 1 });
  });

  test('reading clears a mark only if it is no newer than what was read', () => {
    const marks = { c: 10, d: 1 };
    assert.deepEqual(markRead(marks, 'c', 10), { d: 1 });
    assert.deepEqual(markRead(marks, 'c', 15), { d: 1 });
    assert.equal(markRead(marks, 'c', 9), marks, 'news after what the window had heard of stays unread');
    assert.equal(markRead(marks, 'x', 99), marks, 'reading what is read changes nothing');
  });

  test('ids are omp’s, never anything that could leave a file name', () => {
    assert.ok(OMP_ID.test('01a15fa0-cfa4-72ac-add5-c0ec10d6cdc3'));
    for (const bad of ['', '../x', 'a/b', 'a b', 'x'.repeat(129)]) assert.equal(OMP_ID.test(bad), false, bad);
  });
});

describe('the unread file', () => {
  const fresh = async () => join(await mkdtemp(join(tmpdir(), 'ac-unread-')), 'state', 'unread.json');

  test('keeps marks across a restart, owner-only, and says every change', async () => {
    const file = await fresh();
    let clock = 100;
    const store = await loadUnread({ file, now: () => clock });
    /** @type {Record<string, number>[]} */
    const heard = [];
    store.subscribe((marks) => heard.push({ ...marks }));
    void store.awaited('a', 50);
    void store.unread('b');
    await store.read('a', 49); // older than the news: stays
    assert.deepEqual(store.all(), { a: 50, b: 100 });
    assert.deepEqual(heard, [{ a: 50 }, { a: 50, b: 100 }], 'a read that changes nothing is not news');
    assert.equal((await stat(file)).mode & 0o777, 0o600);

    const restarted = await loadUnread({ file });
    assert.deepEqual(restarted.all(), { a: 50, b: 100 });
    clock = 200;
    await restarted.read('a', 50);
    assert.deepEqual((await loadUnread({ file })).all(), { b: 100 });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, unread: { b: 100 } });
  });

  test('a file that is not one is reported, not replaced', async () => {
    const file = await fresh();
    await (await loadUnread({ file })).unread('a');
    await writeFile(file, '{"version":1,"unread":{"../x":1}}');
    await assert.rejects(loadUnread({ file }), /is not an unread file/);
    assert.equal(await readFile(file, 'utf8'), '{"version":1,"unread":{"../x":1}}');
  });
});
