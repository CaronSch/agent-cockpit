import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { commonPrefix, completeEntry, extendSegment, matchEntries, mentionAt } from '../src/omp/file-mention.js';
/** @import { DirEntry } from '../src/omp/file-mention.js' */

/** @param {string} text */
const at = (text) => mentionAt(text, text.length);

/** @param {string} name */
const file = (name) => ({ name, isDir: false });
/** @param {string} name */
const dir = (name) => ({ name, isDir: true });

describe('the mention being typed', () => {
  test('is the path after an @ at the start or after whitespace, split at its last slash', () => {
    assert.deepEqual(at('@'), { start: 0, end: 1, quote: '', dir: '', segment: '' });
    assert.deepEqual(at('look at @src/ap'), { start: 8, end: 15, quote: '', dir: 'src/', segment: 'ap' });
    assert.deepEqual(at('x\n@../../'), { start: 2, end: 9, quote: '', dir: '../../', segment: '' });
    assert.deepEqual(at('@~/co'), { start: 0, end: 5, quote: '', dir: '~/', segment: 'co' });
    assert.deepEqual(at('@/etc/ho'), { start: 0, end: 8, quote: '', dir: '/etc/', segment: 'ho' });
  });

  test('an open quote keeps spaces in the path', () => {
    assert.deepEqual(at('see @"my dir/no'), { start: 4, end: 15, quote: '"', dir: 'my dir/', segment: 'no' });
    assert.deepEqual(at("@'a \"b/c"), { start: 0, end: 8, quote: "'", dir: 'a "b/', segment: 'c' });
  });

  test('is none inside a word, past a finished mention, or once the path has ended', () => {
    for (const text of ['ben@example', '@src/app.js ', '@"a b.txt"', '@"a b.txt" ', 'plain text', '@a@b']) {
      assert.equal(at(text), null, text);
    }
  });

  test('is read up to the caret, not the end of the text', () => {
    assert.deepEqual(mentionAt('@src/app.js and more', 6), { start: 0, end: 6, quote: '', dir: 'src/', segment: 'a' });
  });
});

describe('the entries a segment matches', () => {
  /** @type {DirEntry[]} */
  const entries = [file('readme.md'), dir('src'), file('Spec.md'), file('.env'), dir('.git'), file('assets.json'), dir('scripts')];

  test('every visible entry for an empty segment, folders first, then by name', () => {
    assert.deepEqual(
      matchEntries(entries, '').map((e) => e.name),
      ['scripts', 'src', 'assets.json', 'readme.md', 'Spec.md'],
    );
  });

  test('names starting with it before names containing it, ignoring case', () => {
    assert.deepEqual(
      matchEntries(entries, 'S').map((e) => e.name),
      ['scripts', 'src', 'Spec.md', 'assets.json'],
    );
  });

  test('dotfiles only once the segment starts with a dot', () => {
    assert.deepEqual(
      matchEntries(entries, '.').map((e) => e.name),
      ['.git', '.env', 'assets.json', 'readme.md', 'Spec.md'],
    );
    assert.deepEqual(matchEntries(entries, 'env'), []);
  });
});

describe('Tab and choosing an entry', () => {
  test('Tab extends to what several entries starting with the segment share, spelled as the first', () => {
    assert.equal(commonPrefix([file('App.js'), file('apple.txt'), file('map.js')], 'a'), 'App');
    assert.equal(commonPrefix([file('api.js'), file('app.js')], 'ap'), null, 'nothing more in common');
    assert.equal(commonPrefix([file('app.js'), file('map.js')], 'ap'), null, 'one starts with it: Tab picks it instead');
    assert.equal(commonPrefix([file('ab'), file('abc')], ''), 'ab');
  });

  test('a file becomes a finished mention and a space; a folder stays open on its contents', () => {
    const query = { start: 0, end: 7, quote: /** @type {''} */ (''), dir: 'src/', segment: 'ap' };
    assert.equal(completeEntry(query, file('app.js')), '@src/app.js ');
    assert.equal(completeEntry(query, dir('api')), '@src/api/');
    assert.equal(extendSegment(query, 'app'), '@src/app');
  });

  test('a path a bare mention would cut short is quoted, and a typed quote is kept', () => {
    const bare = { start: 0, end: 1, quote: /** @type {''} */ (''), dir: '', segment: '' };
    assert.equal(completeEntry(bare, file('my notes.md')), '@"my notes.md" ');
    assert.equal(completeEntry(bare, dir('my dir')), '@"my dir/');
    assert.equal(completeEntry(bare, file('v1.')), '@"v1." ', 'omp trims a trailing dot');
    assert.equal(completeEntry(bare, file('(draft)')), '@"(draft)" ');
    assert.equal(completeEntry(bare, file('say "hi"')), `@'say "hi"' `);
    assert.equal(extendSegment(bare, 'my n'), '@"my n');
    const open = { start: 0, end: 9, quote: /** @type {'"'} */ ('"'), dir: 'my dir/', segment: '' };
    assert.equal(completeEntry(open, file('a.txt')), '@"my dir/a.txt" ');
  });
});
