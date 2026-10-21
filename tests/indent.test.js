import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { indent, outdent } from '../src/ui/indent.js';
/** @import { IndentEdit } from '../src/ui/indent.js' */

/**
 * Applies an edit to text written with `[` and `]` marking the selection (`|` for a caret), and
 * writes the result the same way, so each case reads as before → after.
 * @param {(text: string, start: number, end: number) => IndentEdit | null} edit @param {string} marked
 */
function run(edit, marked) {
  const caret = marked.indexOf('|');
  const start = caret === -1 ? marked.indexOf('[') : caret;
  const end = caret === -1 ? marked.indexOf(']') - 1 : caret;
  const text = marked.replace(/[[\]|]/g, '');
  const result = edit(text, start, end);
  if (!result) return null;
  const next = text.slice(0, result.from) + result.text + text.slice(result.to);
  if (result.start === result.end) return `${next.slice(0, result.start)}|${next.slice(result.start)}`;
  return `${next.slice(0, result.start)}[${next.slice(result.start, result.end)}]${next.slice(result.end)}`;
}

describe('indent', () => {
  test('with no selection, puts two spaces at the caret', () => {
    assert.equal(run(indent, 'ab|cd'), 'ab  |cd');
    assert.equal(run(indent, '|'), '  |');
  });

  test('indents every line a selection touches, keeping the same text selected', () => {
    assert.equal(run(indent, 'one\nt[wo\nthr]ee\nfour'), 'one\n  t[wo\n  thr]ee\nfour');
    assert.equal(run(indent, '[one\ntwo]'), '[  one\n  two]');
  });

  test('a selection within one line indents that line, not replaces the text', () => {
    assert.equal(run(indent, 'a [b] c'), '  a [b] c');
  });

  test('a selection of whole lines ending at the next line’s start leaves that line alone', () => {
    assert.equal(run(indent, '[one\ntwo\n]three'), '[  one\n  two\n]three');
  });

  test('blank lines stay blank', () => {
    assert.equal(run(indent, '[one\n\ntwo]'), '[  one\n\n  two]');
    assert.equal(run(indent, 'x\n[\n]y'), null);
  });

  test('a selection starting at the very start of text that begins with a newline', () => {
    assert.equal(run(indent, '[\na]'), '[\n  a]');
  });
});

describe('outdent', () => {
  test('removes one indent from the caret’s line, the caret moving with its text', () => {
    assert.equal(run(outdent, '    a|b'), '  a|b');
    assert.equal(run(outdent, '  x\n    a|b\ny'), '  x\n  a|b\ny');
  });

  test('removes no more than the line has, and nothing from lines without an indent', () => {
    assert.equal(run(outdent, '[ one\ntwo\n   three]'), '[one\ntwo\n three]');
    assert.equal(run(outdent, 'a|b'), null);
  });

  test('takes a leading tab as one indent', () => {
    assert.equal(run(outdent, '\t\t|x'), '\t|x');
  });

  test('a caret inside the indent it removes goes to the start of the line', () => {
    assert.equal(run(outdent, ' | x'), '|x');
  });

  test('keeps the same text selected across lines', () => {
    assert.equal(run(outdent, '  o[ne\n  two\n  thr]ee'), 'o[ne\ntwo\nthr]ee');
  });

  test('undoes what indent did', () => {
    const before = 'a\nb\n\nc';
    const once = indent(before, 0, before.length);
    assert.ok(once);
    const indented = once.text;
    const back = outdent(indented, 0, indented.length);
    assert.equal(back?.text, before);
  });
});
