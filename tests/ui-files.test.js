import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUiVersion } from '../daemon/ui-files.js';

/** @type {string} */
let root;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ac-ui-files-'));
  await mkdir(join(root, 'src', 'omp'), { recursive: true });
  await mkdir(join(root, 'styles'));
  await writeFile(join(root, 'index.html'), '<!doctype html>');
  await writeFile(join(root, 'src', 'omp', 'pane.js'), 'export const a = 1;');
  await writeFile(join(root, 'styles', 'app.css'), 'body {}');
  await writeFile(join(root, 'README.md'), '# readme');
});

describe('the UI version', () => {
  test('changes when a served file changes, appears or goes', async () => {
    const ui = createUiVersion(root);
    const first = await ui.current();
    assert.equal(await ui.current(), first, 'stable while nothing changes');

    await writeFile(join(root, 'src', 'omp', 'pane.js'), 'export const a = 2;'); // same size, new bytes
    const edited = await ui.current();
    assert.notEqual(edited, first);

    await writeFile(join(root, 'styles', 'new.css'), 'p {}');
    const added = await ui.current();
    assert.notEqual(added, edited);
    await rm(join(root, 'styles', 'new.css'));
    assert.equal(await ui.current(), edited, 'the same files are the same version again');

    await writeFile(join(root, 'index.html'), '<!doctype html><title>x</title>');
    assert.notEqual(await ui.current(), edited);
  });

  test('ignores files the daemon does not serve', async () => {
    const ui = createUiVersion(root);
    const first = await ui.current();
    await writeFile(join(root, 'README.md'), '# changed');
    await writeFile(join(root, 'src', 'notes.txt'), 'not served');
    await writeFile(join(root, 'src', 'omp', '.pane.js.swp'), 'an editor swap file');
    assert.equal(await ui.current(), first);
  });

  test('is the same for the same files wherever they are checked out', async () => {
    const other = await mkdtemp(join(tmpdir(), 'ac-ui-files-'));
    await mkdir(join(other, 'src', 'omp'), { recursive: true });
    await mkdir(join(other, 'styles'));
    await writeFile(join(other, 'index.html'), '<!doctype html>');
    await writeFile(join(other, 'src', 'omp', 'pane.js'), 'export const a = 1;');
    await writeFile(join(other, 'styles', 'app.css'), 'body {}');
    assert.equal(await createUiVersion(other).current(), await createUiVersion(root).current());
  });
});
