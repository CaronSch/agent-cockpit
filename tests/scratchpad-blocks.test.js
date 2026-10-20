import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assetUrl, insertAsset, parseBlocks, serializeBlocks, titleOf, withGaps } from '../src/scratchpad/blocks.js';

const shot = { kind: /** @type {const} */ ('image'), name: 'shot.png', path: 'p1.assets/k2-shot.png' };
const log = { kind: /** @type {const} */ ('file'), name: 'build.log', path: 'p1.assets/k3-build.log' };

describe('scratchpad blocks', () => {
  test('lines that only reference a pad file become image and file blocks; the rest is text', () => {
    const text = 'before\n![shot.png](p1.assets/k2-shot.png)\nmiddle\nlines\n[build.log](p1.assets/k3-build.log)';
    assert.deepEqual(parseBlocks(text), [
      { kind: 'text', text: 'before' },
      shot,
      { kind: 'text', text: 'middle\nlines' },
      log,
    ]);
    assert.equal(serializeBlocks(parseBlocks(text)), text, 'unchanged text survives the round trip');
  });

  test('a link to anything else, or inside a sentence, stays text', () => {
    for (const text of ['see ![a](p1.assets/x.png) here', '![a](https://example.com/x.png)', '![a](../token)']) {
      assert.deepEqual(parseBlocks(text), [{ kind: 'text', text }]);
    }
  });

  test('there is somewhere to type around every file, and leaving it empty adds nothing', () => {
    const blocks = withGaps(parseBlocks('![shot.png](p1.assets/k2-shot.png)\n[build.log](p1.assets/k3-build.log)'));
    assert.deepEqual(blocks.map((b) => b.kind), ['text', 'image', 'text', 'file', 'text']);
    assert.equal(serializeBlocks(blocks), '![shot.png](p1.assets/k2-shot.png)\n[build.log](p1.assets/k3-build.log)');
    assert.deepEqual(withGaps([]), [{ kind: 'text', text: '' }], 'an empty pad is one empty text block');
  });

  test('a pasted file splits the text at the caret and takes a line of its own', () => {
    const blocks = [{ kind: /** @type {const} */ ('text'), text: 'first line\nsecond' }];
    const atLineEnd = serializeBlocks(insertAsset(blocks, 0, 'first line'.length, shot));
    assert.equal(atLineEnd, 'first line\n![shot.png](p1.assets/k2-shot.png)\nsecond');
    const midWord = serializeBlocks(insertAsset(blocks, 0, 3, shot));
    assert.equal(midWord, 'fir\n![shot.png](p1.assets/k2-shot.png)\nst line\nsecond');
  });

  test('a file name cannot break the Markdown line it is stored in', () => {
    const odd = { kind: /** @type {const} */ ('file'), name: 'a]b[c\nd', path: 'p1.assets/k-x' };
    assert.deepEqual(parseBlocks(serializeBlocks([odd])), [{ ...odd, name: 'abcd' }]);
  });

  test('a pad is named by its first line of text', () => {
    assert.equal(titleOf('\n![shot.png](p1.assets/k2-shot.png)\n## Release plan\nbody'), 'Release plan');
    assert.equal(titleOf('- [ ] call Sam'), '[ ] call Sam');
    assert.equal(titleOf('   \n'), '');
    assert.equal(titleOf('x'.repeat(100)).length, 80);
  });

  test('assets load from the pad they belong to', () => {
    assert.equal(assetUrl('p1.assets/k2-shot.png'), '/api/scratchpads/p1/assets/k2-shot.png');
  });
});
