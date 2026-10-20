import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { asQuote, composeMessage, isCommand, isLargePaste } from '../src/omp/message.js';

describe('the message the omp pane sends', () => {
  test('each comment quotes its text, then says its piece, before the prompt', () => {
    const message = composeMessage('  and then deploy?  ', [
      { quote: 'Run the migration first.', comment: 'Which one?' },
      { quote: 'line one\n\nline three', comment: ' both? ' },
    ]);
    assert.equal(message, '> Run the migration first.\n\nWhich one?\n\n> line one\n>\n> line three\n\nboth?\n\nand then deploy?');
  });

  test('comments alone are a message; nothing at all is not', () => {
    assert.equal(composeMessage('', [{ quote: 'x', comment: 'why?' }]), '> x\n\nwhy?');
    assert.equal(composeMessage('   ', []), '');
  });

  test('a quote keeps its blank lines inside the quote', () => {
    assert.equal(asQuote('\na\n\nb\n'), '> a\n>\n> b');
  });

  test('slash commands and shell lines are commands, prose is not', () => {
    assert.equal(isCommand('/model'), true);
    assert.equal(isCommand('  !ls'), true);
    assert.equal(isCommand('use /tmp for it'), false);
  });

  test('pasted text follows the prompt as one attachment block; files follow as omp mentions', () => {
    const message = composeMessage(
      'why does this fail?',
      [],
      [
        { kind: 'text', text: 'Error: boom\n  at x.js:1\n\n' },
        { kind: 'file', path: '/state/attachments/2026-01-02/k1-shot.png' },
        { kind: 'file', path: '/tmp/odd "name".txt' },
      ],
    );
    assert.equal(
      message,
      'why does this fail?\n\n<attachment>\nError: boom\n  at x.js:1\n</attachment>\n\n@"/state/attachments/2026-01-02/k1-shot.png"\n\n@\'/tmp/odd "name".txt\'',
    );
    assert.equal(composeMessage('', [], [{ kind: 'file', path: '/a.png' }]), '@"/a.png"', 'an attachment alone is a message');
  });

  test('a paste becomes an attachment past 10 lines or 1000 characters, as in omp', () => {
    assert.equal(isLargePaste(Array(10).fill('x').join('\n')), false);
    assert.equal(isLargePaste(Array(11).fill('x').join('\n')), true);
    assert.equal(isLargePaste('x'.repeat(1000)), false);
    assert.equal(isLargePaste('x'.repeat(1001)), true);
  });
});
