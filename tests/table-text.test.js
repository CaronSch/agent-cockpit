import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { parseMarkdown } from '../src/omp/markdown.js';
import { inlineText, tableCsv } from '../src/omp/table-text.js';
/** @import { TableBlock } from '../src/omp/markdown.js' */

/** @param {string} source @returns {TableBlock} */
function table(source) {
  const [block] = parseMarkdown(source);
  assert.ok(block.type === 'table');
  return block;
}

describe('cell text', () => {
  test('formatting is dropped but its text kept, escaped pipes are literal, and breaks are new lines', () => {
    const { rows } = table('| a | b | c |\n|---|---|---|\n| `x \\| y` | **bold _and_ em** | see [the docs](https://example.com) |');
    assert.deepEqual(rows[0].map(inlineText), ['x | y', 'bold and em', 'see the docs']);
    assert.equal(inlineText([{ type: 'text', text: 'one' }, { type: 'break' }, { type: 'strong', children: [{ type: 'text', text: 'two' }] }]), 'one\ntwo');
  });
});

describe('CSV', () => {
  test('header first, plain fields as they are, inline code and bold as their text', () => {
    assert.equal(
      tableCsv(table('| When | What happens | Code |\n|---|---|---|\n| Now | Stuff **happened** | `tracked.rs:67` |')),
      'When,What happens,Code\nNow,Stuff happened,tracked.rs:67',
    );
  });

  test('commas, quotes, line breaks and edge whitespace are quoted; empty cells stay empty fields', () => {
    const csv = tableCsv(table('| a | b | c | d |\n|---|---|---|---|\n| 1, 2 | say "hi" | `  padded` |  |\n| x \\| y | | z |'));
    assert.equal(csv, 'a,b,c,d\n"1, 2","say ""hi""","  padded",\nx | y,,z,');
    const broken = /** @type {TableBlock} */ ({
      ...table('| a |\n|---|'),
      rows: [[[{ type: 'text', text: 'one' }, { type: 'break' }, { type: 'text', text: 'two' }]], [[{ type: 'text', text: 'end ' }]]],
    });
    assert.equal(tableCsv(broken), 'a\n"one\ntwo"\n"end "');
  });
});
