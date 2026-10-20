import { test, describe, beforeEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptLegacyScratchpad, createScratchpads, revOf } from '../daemon/scratchpad.js';
import { LEGACY_PAD } from '../src/scratchpad/blocks.js';
/** @import { Scratchpad } from '../daemon/wire.js' */

let state = '';
let dir = '';

beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), 'ac-scratchpad-'));
  dir = join(state, 'scratchpads');
});

/** @param {ReturnType<typeof createScratchpads>} pads @param {string} id @param {string} text */
async function save(pads, id, text) {
  const result = await pads.write(id, text, (await pads.read(id)).rev);
  assert.equal(result.ok, true);
}

describe('scratchpad files', () => {
  test('each pad is its own plain owner-only file', async () => {
    const pads = createScratchpads({ dir });
    assert.deepEqual(await pads.read('a1'), { text: '', rev: revOf('') });
    await save(pads, 'a1', '# Deploy notes\n- staging first\n');
    await save(pads, 'b2', 'groceries');
    assert.equal(await readFile(join(dir, 'a1.md'), 'utf8'), '# Deploy notes\n- staging first\n');
    assert.equal((await pads.read('b2')).text, 'groceries', 'pads do not share text');
    assert.equal((await stat(join(dir, 'a1.md'))).mode & 0o777, 0o600, 'notes can hold secrets');
    assert.deepEqual((await readdir(dir)).sort(), ['a1.md', 'b2.md'], 'no temp file left behind');
  });

  test('the list names each pad by its first line, most recently changed first', async () => {
    const pads = createScratchpads({ dir });
    await save(pads, 'older', '\n![shot](older.assets/x.png)\n## Release checklist\nmore');
    await new Promise((r) => setTimeout(r, 20));
    await save(pads, 'newer', '- buy milk');
    assert.deepEqual(
      (await pads.list()).map(({ id, title }) => ({ id, title })),
      [
        { id: 'newer', title: 'buy milk' },
        { id: 'older', title: 'Release checklist' },
      ],
    );
  });

  test('a pad id can only name a file in the pads folder', async () => {
    const pads = createScratchpads({ dir });
    await assert.rejects(pads.read('../token'), RangeError);
    await assert.rejects(pads.write('a/b', 'x', revOf('')), RangeError);
    assert.equal(pads.asset('a1', '../../token'), null);
  });

  test('the version is the text, so it survives a daemon restart', async () => {
    await save(createScratchpads({ dir }), 'p', 'kept');
    const restarted = createScratchpads({ dir });
    assert.equal((await restarted.read('p')).rev, revOf('kept'));
    assert.equal((await restarted.write('p', 'kept, then more', revOf('kept'))).ok, true);
  });

  test('an edit made to the file outside the workbench is not overwritten', async () => {
    const pads = createScratchpads({ dir });
    await save(pads, 'p', 'from the browser');
    await writeFile(join(dir, 'p.md'), 'from vim');
    const result = await pads.write('p', 'browser keeps typing', revOf('from the browser'));
    assert.deepEqual(result, { ok: false, current: { text: 'from vim', rev: revOf('from vim') } });
    assert.equal(await readFile(join(dir, 'p.md'), 'utf8'), 'from vim');
  });

  test('two saves from the same version cannot both land', async () => {
    const pads = createScratchpads({ dir });
    const [a, b] = await Promise.all([pads.write('p', 'tab A', revOf('')), pads.write('p', 'tab B', revOf(''))]);
    assert.equal(a.ok, true);
    assert.deepEqual(b, { ok: false, current: { text: 'tab A', rev: revOf('tab A') } });
  });

  test('pages hear which pad changed, and not about saves that change nothing', async () => {
    const pads = createScratchpads({ dir });
    /** @type {Array<[string, Scratchpad]>} */
    const heard = [];
    pads.subscribe((id, pad) => heard.push([id, pad]));
    await pads.write('p', 'one', revOf(''));
    await pads.write('p', 'one', revOf('one'));
    await pads.write('p', 'two', revOf('')); // stale: refused
    assert.deepEqual(heard, [['p', { text: 'one', rev: revOf('one') }]]);
  });

  test('a stored file gets a unique name beside its pad, and is served by type', async () => {
    const pads = createScratchpads({ dir });
    const first = await pads.saveAsset('p', 'Screen Shot 1.png', new Uint8Array([1, 2, 3]));
    const second = await pads.saveAsset('p', 'Screen Shot 1.png', new Uint8Array([4]));
    assert.match(first, /^p\.assets\/[a-z0-9]+-Screen-Shot-1\.png$/);
    assert.notEqual(first, second, 'the same name twice keeps both files');
    const name = first.split('/')[1];
    const image = pads.asset('p', name);
    assert.deepEqual(image && { type: image.type, inline: image.inline }, { type: 'image/png', inline: true });
    assert.deepEqual([...(await readFile(image?.path ?? ''))], [1, 2, 3]);
    const page = pads.asset('p', 'x-notes.html');
    assert.deepEqual(page && { type: page.type, inline: page.inline }, { type: 'application/octet-stream', inline: false });
  });

  test('deleting a pad removes its file and its files, and tells open pages it is empty', async () => {
    const pads = createScratchpads({ dir });
    await save(pads, 'gone', 'secret');
    await pads.saveAsset('gone', 'a.png', new Uint8Array([1]));
    await save(pads, 'kept', 'stays');
    /** @type {Array<[string, Scratchpad]>} */
    const heard = [];
    pads.subscribe((id, pad) => heard.push([id, pad]));
    await pads.remove('gone');
    assert.deepEqual(await readdir(dir), ['kept.md']);
    assert.deepEqual(heard, [['gone', { text: '', rev: revOf('') }]]);
  });

  test('the single scratchpad of earlier versions becomes a pad, once', async () => {
    const legacy = join(state, 'scratchpad.md');
    await writeFile(legacy, 'old notes');
    assert.equal(await adoptLegacyScratchpad(legacy, dir), true);
    assert.equal((await createScratchpads({ dir }).read(LEGACY_PAD)).text, 'old notes');
    await writeFile(legacy, 'written by an old daemon later');
    assert.equal(await adoptLegacyScratchpad(legacy, dir), false, 'never overwrites the adopted pad');
    assert.equal(await readFile(join(dir, `${LEGACY_PAD}.md`), 'utf8'), 'old notes');
    await mkdir(join(state, 'empty'));
    assert.equal(await adoptLegacyScratchpad(join(state, 'none.md'), join(state, 'empty')), false);
  });
});
