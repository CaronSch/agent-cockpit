import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScratchpad, revOf } from '../daemon/scratchpad.js';

let dir = '';
let file = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ac-scratchpad-'));
  file = join(dir, 'state', 'scratchpad.md');
});

describe('scratchpad file', () => {
  test('starts empty, and a save is a plain owner-only file', async () => {
    const pad = createScratchpad({ file });
    const empty = await pad.read();
    assert.deepEqual(empty, { text: '', rev: revOf('') });

    const saved = await pad.write('# todo\n- ship it\n', empty.rev);
    assert.deepEqual(saved, { ok: true, rev: revOf('# todo\n- ship it\n') });
    assert.equal(await readFile(file, 'utf8'), '# todo\n- ship it\n');
    assert.equal((await stat(file)).mode & 0o777, 0o600, 'notes can hold secrets');
    assert.deepEqual(await readdir(join(dir, 'state')), ['scratchpad.md'], 'no temp file left behind');
  });

  test('the version is the text, so it survives a daemon restart', async () => {
    const first = createScratchpad({ file });
    const { rev } = await first.write('kept', (await first.read()).rev).then((r) => (r.ok ? r : assert.fail()));
    const restarted = createScratchpad({ file });
    assert.equal((await restarted.read()).rev, rev);
    assert.equal((await restarted.write('kept, then more', rev)).ok, true);
  });

  test('an edit made to the file outside the workbench is not overwritten', async () => {
    const pad = createScratchpad({ file });
    const { rev } = await pad.read();
    await pad.write('from the browser', rev);
    const base = revOf('from the browser');
    await writeFile(file, 'from vim');
    const result = await pad.write('browser keeps typing', base);
    assert.deepEqual(result, { ok: false, current: { text: 'from vim', rev: revOf('from vim') } });
    assert.equal(await readFile(file, 'utf8'), 'from vim');
  });

  test('two saves from the same version cannot both land', async () => {
    const pad = createScratchpad({ file });
    const { rev } = await pad.read();
    const [a, b] = await Promise.all([pad.write('tab A', rev), pad.write('tab B', rev)]);
    assert.equal(a.ok, true);
    assert.deepEqual(b, { ok: false, current: { text: 'tab A', rev: revOf('tab A') } });
    assert.equal(await readFile(file, 'utf8'), 'tab A');
  });

  test('pages hear about changes, not about saves that change nothing', async () => {
    const pad = createScratchpad({ file });
    /** @type {string[]} */
    const heard = [];
    pad.subscribe((p) => heard.push(p.text));
    const { rev } = await pad.read();
    await pad.write('one', rev);
    await pad.write('one', revOf('one'));
    await pad.write('two', rev); // stale: refused
    assert.deepEqual(heard, ['one']);
  });
});
