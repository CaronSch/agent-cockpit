import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { paneCommand, withPaneCommands } from '../src/omp/pane-commands.js';

describe('pane commands', () => {
  test('/resume is the pane\'s, with whatever follows it as a filter', () => {
    assert.deepEqual(paneCommand('/resume'), { name: 'resume', arg: '' });
    assert.deepEqual(paneCommand('  /resume  '), { name: 'resume', arg: '' });
    assert.deepEqual(paneCommand('/resume login  flow '), { name: 'resume', arg: 'login  flow' });
  });

  test('anything else goes to omp', () => {
    for (const text of ['/resumes', '/rename x', 'resume', 'please /resume', '!/resume', '']) assert.equal(paneCommand(text), null, text);
  });

  test('suggestions list the pane\'s commands first, without omp\'s of the same name', () => {
    const omp = [
      { name: 'rename', aliases: [], description: 'Rename', hint: '' },
      { name: 'resume', aliases: [], description: 'omp would show its TUI picker', hint: '' },
    ];
    const names = withPaneCommands(omp).map((c) => `${c.name}: ${c.description}`);
    assert.deepEqual(names, ['resume: Resume another session from this directory in this pane', 'rename: Rename']);
  });
});
