import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { parseSettings } from '../src/ui/settings.js';

describe('parseSettings', () => {
  test('nothing stored: the defaults', () => {
    assert.deepEqual(parseSettings(null), { onlyResponses: false, animatedSelection: true });
  });

  test('stored switches override their defaults; the rest keep theirs', () => {
    assert.deepEqual(parseSettings('{"animatedSelection":false}'), { onlyResponses: false, animatedSelection: false });
  });

  test('anything that is not a stored switch is ignored', () => {
    assert.deepEqual(parseSettings('{"onlyResponses":"yes","other":true}'), { onlyResponses: false, animatedSelection: true });
    assert.deepEqual(parseSettings('not json'), { onlyResponses: false, animatedSelection: true });
  });
});
