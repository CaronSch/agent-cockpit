import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptLegacyStateDir } from '../daemon/state-dir.js';

let home = '';
let legacy = '';
let current = '';

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ac-state-dir-'));
  legacy = join(home, '.agent-cockpit');
  current = join(home, '.cockpit');
});

describe('adoptLegacyStateDir', () => {
  test('moves the pre-rename folder, contents and all, when it is the only one', async () => {
    await mkdir(join(legacy, 'scratchpads'), { recursive: true });
    await writeFile(join(legacy, 'token'), 'secret');
    await writeFile(join(legacy, 'scratchpads', 'a.md'), 'notes');

    assert.equal(await adoptLegacyStateDir(legacy, current), true);
    assert.equal(await readFile(join(current, 'token'), 'utf8'), 'secret');
    assert.equal(await readFile(join(current, 'scratchpads', 'a.md'), 'utf8'), 'notes');
    assert.deepEqual(await readdir(home), ['.cockpit']);
  });

  test('never merges into or overwrites an existing folder', async () => {
    await mkdir(legacy);
    await writeFile(join(legacy, 'token'), 'old');
    await mkdir(current);
    await writeFile(join(current, 'token'), 'new');

    assert.equal(await adoptLegacyStateDir(legacy, current), false);
    assert.equal(await readFile(join(current, 'token'), 'utf8'), 'new');
    assert.equal(await readFile(join(legacy, 'token'), 'utf8'), 'old');
  });

  test('does nothing without a legacy folder, or when the legacy path is a file', async () => {
    assert.equal(await adoptLegacyStateDir(legacy, current), false);
    await writeFile(legacy, 'not a folder');
    assert.equal(await adoptLegacyStateDir(legacy, current), false);
    assert.deepEqual(await readdir(home), ['.agent-cockpit']);
  });
});
