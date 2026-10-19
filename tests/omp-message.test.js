import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { asQuote, composeMessage, isCommand } from '../src/omp/message.js';

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
});
