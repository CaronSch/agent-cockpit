import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { parseInline, parseMarkdown, safeHref } from '../src/omp/markdown.js';

describe('blocks', () => {
  test('headings, paragraphs with line breaks, and rules', () => {
    assert.deepEqual(parseMarkdown('## Plan\n\nfirst line\nsecond line\n\n---'), [
      { type: 'heading', level: 2, children: [{ type: 'text', text: 'Plan' }] },
      { type: 'paragraph', children: [{ type: 'text', text: 'first line' }, { type: 'break' }, { type: 'text', text: 'second line' }] },
      { type: 'rule' },
    ]);
  });

  test('fenced code keeps its language and content verbatim', () => {
    assert.deepEqual(parseMarkdown('```js\nconst a = `**x**`;\n\n<b>hi</b>\n```\nafter'), [
      { type: 'code', lang: 'js', text: 'const a = `**x**`;\n\n<b>hi</b>' },
      { type: 'paragraph', children: [{ type: 'text', text: 'after' }] },
    ]);
  });

  test('an unterminated fence (still streaming) runs to the end', () => {
    assert.deepEqual(parseMarkdown('```\nline 1\nline 2'), [{ type: 'code', lang: '', text: 'line 1\nline 2' }]);
  });

  test('bullet and numbered lists, with nesting', () => {
    const [list] = parseMarkdown('3. one\n4. two\n   - nested');
    assert.equal(list.type, 'list');
    assert.ok(list.type === 'list');
    assert.equal(list.ordered, true);
    assert.equal(list.start, 3);
    assert.equal(list.items.length, 2);
    assert.deepEqual(list.items[1][1], { type: 'list', ordered: false, start: 1, items: [[{ type: 'paragraph', children: [{ type: 'text', text: 'nested' }] }]] });
  });

  test('block quotes parse their contents', () => {
    assert.deepEqual(parseMarkdown('> **note**\n> more'), [
      {
        type: 'quote',
        children: [{ type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'text', text: 'note' }] }, { type: 'break' }, { type: 'text', text: 'more' }] }],
      },
    ]);
  });

  test('a table becomes header and body cells, with inline formatting in the cells', () => {
    /** @param {string} text */
    const t = (text) => ({ type: 'text', text });
    assert.deepEqual(parseMarkdown('| When | What happens | Code |\n|---|---|---|\n| Now | Stuff **happened** | `tracked.rs:67` |'), [
      {
        type: 'table',
        align: [null, null, null],
        head: [[t('When')], [t('What happens')], [t('Code')]],
        rows: [[[t('Now')], [t('Stuff '), { type: 'strong', children: [t('happened')] }], [{ type: 'code', text: 'tracked.rs:67' }]]],
        source: '| When | What happens | Code |\n|---|---|---|\n| Now | Stuff **happened** | `tracked.rs:67` |',
      },
    ]);
  });

  test('alignment, missing outer pipes, escaped pipes, and rows padded or cut to the header', () => {
    const [table] = parseMarkdown('a | b | c\n:--|:-:|--:\n1 \\| 2 | x\n1 | 2 | 3 | 4');
    assert.ok(table.type === 'table');
    assert.deepEqual(table.align, ['left', 'center', 'right']);
    const text = (/** @type {any} */ cell) => cell.map((/** @type {any} */ n) => n.text).join('');
    assert.deepEqual(table.rows.map((row) => row.map(text)), [['1 | 2', 'x', ''], ['1', '2', '3']]);
  });

  test('a table can start right under a paragraph line, and a mismatched divider is not one', () => {
    assert.deepEqual(parseMarkdown('Here it is:\n| a | b |\n|---|---|').map((b) => b.type), ['paragraph', 'table']);
    assert.deepEqual(parseMarkdown('a | b\n---').map((b) => b.type), ['paragraph', 'rule'], 'a rule under text with a pipe');
    assert.deepEqual(parseMarkdown('| a | b |\n|---|').map((b) => b.type), ['paragraph']);
  });

  test("a table's source is its own lines as written, without a paragraph above, text after, or quote markers", () => {
    const [, table] = parseMarkdown('Here it is:\n|a|b \\| c|\n|:-|-:|\n| 1 |  **2** |\n\nafter');
    assert.ok(table.type === 'table');
    assert.equal(table.source, '|a|b \\| c|\n|:-|-:|\n| 1 |  **2** |');
    const [quote] = parseMarkdown('> Note:\n> | a | b |\n> |---|---|\n> | 1 | 2 |\n\n| x |\n|---|');
    assert.ok(quote.type === 'quote' && quote.children[1].type === 'table');
    assert.equal(quote.children[1].source, '| a | b |\n|---|---|\n| 1 | 2 |');
  });
});

describe('inline', () => {
  test('code, bold and italic', () => {
    assert.deepEqual(parseInline('use `a*b*c` and **bold** or *it*'), [
      { type: 'text', text: 'use ' },
      { type: 'code', text: 'a*b*c' },
      { type: 'text', text: ' and ' },
      { type: 'strong', children: [{ type: 'text', text: 'bold' }] },
      { type: 'text', text: ' or ' },
      { type: 'em', children: [{ type: 'text', text: 'it' }] },
    ]);
  });

  test('snake_case identifiers and lone asterisks stay text', () => {
    assert.deepEqual(parseInline('call my_func_name with 2 * 3'), [{ type: 'text', text: 'call my_func_name with 2 * 3' }]);
  });

  test('raw HTML is plain text, never markup', () => {
    assert.deepEqual(parseMarkdown('<img src=x onerror=alert(1)>'), [
      { type: 'paragraph', children: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }] },
    ]);
  });

  test('backslash escapes', () => {
    assert.deepEqual(parseInline('\\*not em\\*'), [{ type: 'text', text: '*not em*' }]);
  });
});

describe('link safety', () => {
  test('http, https and mailto links become links', () => {
    assert.deepEqual(parseInline('[docs](https://example.com/a?b=1) <mailto:me@example.com>'), [
      { type: 'link', href: 'https://example.com/a?b=1', children: [{ type: 'text', text: 'docs' }] },
      { type: 'text', text: ' ' },
      { type: 'link', href: 'mailto:me@example.com', children: [{ type: 'text', text: 'me@example.com' }] },
    ]);
  });

  test('javascript:, data: and relative targets keep only their label', () => {
    assert.deepEqual(parseInline('[x](javascript:alert(1))'), [{ type: 'text', text: 'x' }]);
    assert.deepEqual(parseInline('[w](https://en.wikipedia.org/wiki/A_(b))'), [
      { type: 'link', href: 'https://en.wikipedia.org/wiki/A_(b)', children: [{ type: 'text', text: 'w' }] },
    ]);
    assert.deepEqual(parseInline('[y](data:text/html,hi)'), [{ type: 'text', text: 'y' }]);
    assert.deepEqual(parseInline('[z](/etc/passwd)'), [{ type: 'text', text: 'z' }]);
    assert.equal(safeHref('JaVaScRiPt:alert(1)'), null);
    assert.equal(safeHref('java\tscript:alert(1)'), null);
  });

  test('bare URLs are linked without trailing punctuation', () => {
    assert.deepEqual(parseInline('see https://example.com/x.'), [
      { type: 'text', text: 'see ' },
      { type: 'link', href: 'https://example.com/x', children: [{ type: 'text', text: 'https://example.com/x' }] },
      { type: 'text', text: '.' },
    ]);
  });
});
