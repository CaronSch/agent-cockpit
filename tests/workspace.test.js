import { test, describe, beforeEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaces } from '../daemon/workspace.js';
import { branch, leaf } from '../src/layout/grid-model.js';

const A = 's_0000000a';
const B = 's_0000000b';
const one = leaf('w_1', 'pane');
const two = branch('row', [leaf('w_1', 'pane'), leaf('w_2', 'omp')]);

let dir = '';

beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), 'ac-workspace-')), 'workspaces');
});

describe('workspace files', () => {
  test('a workspace never saved has no screens and no file; its first save creates both', async () => {
    const workspaces = createWorkspaces({ dir });
    assert.deepEqual(await workspaces.read('main'), { screens: [] });
    assert.deepEqual(await workspaces.write('main', A, one, null), { ok: true, rev: 1 });
    assert.deepEqual(await workspaces.read('main'), { screens: [{ id: A, rev: 1, tree: one }] });
    assert.equal((await stat(join(dir, 'main.json'))).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(dir), ['main.json'], 'no temporary file left behind');
  });

  test('screens keep the order they were created in, and survive a daemon restart', async () => {
    const workspaces = createWorkspaces({ dir });
    await workspaces.write('main', B, one, null);
    await workspaces.write('main', A, one, null);
    await workspaces.write('main', B, two, 1);
    const restarted = createWorkspaces({ dir });
    assert.deepEqual(await restarted.read('main'), {
      screens: [
        { id: B, rev: 2, tree: two },
        { id: A, rev: 1, tree: one },
      ],
    });
  });

  test('a save from an older rev is refused with what is there now, and changes nothing', async () => {
    const workspaces = createWorkspaces({ dir });
    await workspaces.write('main', A, one, null);
    await workspaces.write('main', A, two, 1);
    assert.deepEqual(await workspaces.write('main', A, one, 1), { ok: false, current: { id: A, rev: 2, tree: two } });
    assert.deepEqual(await workspaces.write('main', A, one, null), { ok: false, current: { id: A, rev: 2, tree: two } });
    assert.deepEqual(await workspaces.write('main', B, one, 3), { ok: false, current: null }, 'not stored is not rev 3');
    assert.deepEqual((await workspaces.read('main')).screens, [{ id: A, rev: 2, tree: two }]);
  });

  test('two saves from the same rev cannot both land', async () => {
    const workspaces = createWorkspaces({ dir });
    const results = await Promise.all([workspaces.write('main', A, one, null), workspaces.write('main', A, two, null)]);
    assert.deepEqual(
      results.map((r) => r.ok),
      [true, false],
    );
  });

  test('a screen whose layout becomes empty is deleted, and the file goes with the last one', async () => {
    const workspaces = createWorkspaces({ dir });
    await workspaces.write('main', A, one, null);
    await workspaces.write('main', B, one, null);
    assert.deepEqual(await workspaces.write('main', A, null, 1), { ok: true, rev: null });
    assert.deepEqual((await workspaces.read('main')).screens, [{ id: B, rev: 1, tree: one }]);
    assert.deepEqual(await workspaces.write('main', B, null, 1), { ok: true, rev: null });
    assert.deepEqual(await readdir(dir), []);
    assert.deepEqual(await workspaces.write('main', A, null, null), { ok: true, rev: null }, 'emptying a screen never stored stores nothing');
    assert.deepEqual(await readdir(dir), []);
  });

  test('a layout that is not a valid tree is refused and nothing is written', async () => {
    const workspaces = createWorkspaces({ dir });
    for (const bad of [{ kind: 'leaf', id: 7 }, branch('row', [leaf('x', 'pane'), leaf('x', 'pane')]), 'pane', undefined]) {
      await assert.rejects(workspaces.write('main', A, /** @type {any} */ (bad), null), RangeError);
    }
    await assert.rejects(workspaces.write('main', 'w_1', one, null), RangeError, 'not a screen id');
    assert.deepEqual(await readdir(dir).catch(() => []), []);
  });

  test('a workspace name can only name a file in the workspaces folder', async () => {
    const workspaces = createWorkspaces({ dir });
    for (const name of ['../token', '..', '.hidden', 'a/b', 'Main', '', 'x'.repeat(41), 'main.json']) {
      await assert.rejects(workspaces.read(name), RangeError, name);
      await assert.rejects(workspaces.write(name, A, one, null), RangeError, name);
    }
    for (const name of ['main', 'e2e-1a2b', '7', 'x'.repeat(40)]) assert.deepEqual(await workspaces.read(name), { screens: [] }, name);
  });

  test('a corrupt workspace file is never dropped or overwritten: reads and saves fail, naming it', async () => {
    const workspaces = createWorkspaces({ dir });
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'main.json');
    const corrupt = [
      '{not json',
      JSON.stringify({ version: 1, screens: [{ id: A, rev: 1, tree: { kind: 'leaf', id: 7 } }] }),
      JSON.stringify({ version: 2, screens: [] }),
      JSON.stringify({ version: 1, screens: [{ id: A, rev: 1, tree: null }] }),
      JSON.stringify({ version: 1, screens: [{ id: A, rev: 1, tree: one }, { id: A, rev: 1, tree: one }] }),
    ];
    for (const text of corrupt) {
      await writeFile(file, text);
      await assert.rejects(workspaces.read('main'), (err) => err instanceof Error && err.message.includes(file), text);
      await assert.rejects(workspaces.write('main', B, one, null), (err) => err instanceof Error && err.message.includes(file), text);
      await assert.rejects(workspaces.write('main', A, null, 1), (err) => err instanceof Error && err.message.includes(file), text);
      assert.equal(await readFile(file, 'utf8'), text);
    }
  });
});
