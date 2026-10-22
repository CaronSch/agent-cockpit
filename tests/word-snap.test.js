import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { wordEnd, wordStart } from '../src/ui/word-snap.js';

/**
 * Snaps a selection written with `[` and `]` in `marked`, and writes the result the same way,
 * so each case reads as before → after.
 * @param {string} marked
 */
function snap(marked) {
  const start = marked.indexOf('[');
  const end = marked.indexOf(']') - 1;
  const text = marked.replace(/[[\]]/g, '');
  const [from, to] = [wordStart(text, start), wordEnd(text, end)];
  return `${text.slice(0, from)}[${text.slice(from, to)}]${text.slice(to)}`;
}

describe('word snapping', () => {
  test('an end partway through a word grows to take the whole word', () => {
    assert.equal(snap('the qu[ick brown fo]x jumps'), 'the [quick brown fox] jumps');
    assert.equal(snap('over the la[zy do]g.'), 'over the [lazy dog.]');
    assert.equal(snap('i[d]'), '[id]');
  });

  test('ends already on word edges stay where they are', () => {
    assert.equal(snap('the [quick brown] fox'), 'the [quick brown] fox');
    assert.equal(snap('the[ quick ]fox'), 'the[ quick ]fox');
  });

  test('a word is everything between spaces, punctuation included', () => {
    assert.equal(snap('call fo[o.ba]r() now'), 'call [foo.bar()] now');
    assert.equal(snap('(se[e this]), then'), '[(see this),] then');
    assert.equal(snap('set max_re[tries to 1]0'), 'set [max_retries to 10]');
    assert.equal(snap('un ca[fé]s'), 'un [cafés]');
  });
});
