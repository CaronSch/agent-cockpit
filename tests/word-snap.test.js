import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { isBoundary, snapSpan } from '../src/ui/word-snap.js';

/**
 * Snaps a selection written with `[` and `]` in `marked`, and writes the result the same way,
 * so each case reads as before → after.
 * @param {string} marked
 */
function snap(marked) {
  const start = marked.indexOf('[');
  const end = marked.indexOf(']') - 1;
  const text = marked.replace(/[[\]]/g, '');
  const [from, to] = snapSpan(text, start, end);
  return `${text.slice(0, from)}[${text.slice(from, to)}]${text.slice(to)}`;
}

describe('word snapping', () => {
  test('a selection spanning words grows to take the words its ends are in', () => {
    assert.equal(snap('the qu[ick brown fo]x jumps'), 'the [quick brown fox] jumps');
    assert.equal(snap('over the la[zy do]g.'), 'over the [lazy dog.]');
    assert.equal(snap('You sa[id: hel]lo'), 'You [said: hello]');
  });

  test('a selection inside one word stays exactly as made', () => {
    assert.equal(snap('the qu[ic]k fox'), 'the qu[ic]k fox');
    assert.equal(snap('i[d]'), 'i[d]');
    assert.equal(snap('the [quick] fox'), 'the [quick] fox');
  });

  test('ends never reach a neighbouring word', () => {
    assert.equal(snap('the [quick brown] fox'), 'the [quick brown] fox');
    assert.equal(snap('the[ quick ]fox'), 'the[ quick ]fox');
    assert.equal(snap('the quick[ br]own'), 'the quick[ brown]', 'a start on a space stays on it');
  });

  test('punctuation comes with its word', () => {
    assert.equal(snap('call fo[o.bar() no]w'), 'call [foo.bar() now]');
    assert.equal(snap('(se[e this]), then'), '[(see this),] then');
    assert.equal(snap('set max_re[tries to 1]0'), 'set [max_retries to 10]');
    assert.equal(snap('un ca[fé al]ors'), 'un [café alors]');
  });

  test('a long token (a path, a URL) snaps by segment, its closing punctuation with it', () => {
    assert.equal(snap('see src/omp/drag-hi[ghlight.js and ma]in.rs'), 'see src/omp/[drag-highlight.js and main.rs]');
    assert.equal(snap('at https://exa[mple.com/docs/refusals-and-fall]back.'), 'at https://[example.com/docs/refusals-and-fallback.]');
    assert.equal(snap('fix a[nd examples/backtest/m]ain.rs'), 'fix [and examples/backtest/main.]rs');
    assert.equal(isBoundary('examples/backtest/main.rs', 'examples/'.length), true);
    assert.equal(isBoundary('short/path.rs', 'short/'.length), false, 'a short token is one word');
  });

  test('a backwards selection snaps the same way: the span is what counts', () => {
    // snapSpan sees the span; which end was dragged only matters to the selection's direction.
    assert.equal(snap('the qu[ick brown fo]x'), 'the [quick brown fox]');
  });
});
