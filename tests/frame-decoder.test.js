import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createFrameDecoder } from '../daemon/frame-decoder.js';

/** @param {unknown} value */
const line = (value) => Buffer.from(`${JSON.stringify(value)}\n`);

/**
 * The rpc_chunk frames omp would send for one oversized object.
 * @param {unknown} payload @param {number} parts @param {string} [chunkId]
 */
function chunked(payload, parts, chunkId = 'rpc-1') {
  const bytes = Buffer.from(JSON.stringify(payload));
  const size = Math.ceil(bytes.length / parts);
  return Array.from({ length: parts }, (_, index) => ({
    type: 'rpc_chunk',
    chunkId,
    index,
    count: parts,
    byteLength: bytes.length,
    data: bytes.subarray(index * size, (index + 1) * size).toString('base64'),
  }));
}

describe('frame decoder', () => {
  test('splits newline-delimited frames even when a read ends mid-line and mid-character', () => {
    const decoder = createFrameDecoder();
    const bytes = Buffer.concat([line({ type: 'a', text: 'héllo ✓' }), line({ type: 'b' })]);
    const cut = bytes.indexOf(Buffer.from('✓')) + 1; // inside the 3-byte character
    const frames = [...decoder.push(bytes.subarray(0, cut)), ...decoder.push(bytes.subarray(cut))];
    assert.deepEqual(frames, [
      { ok: true, frame: { type: 'a', text: 'héllo ✓' } },
      { ok: true, frame: { type: 'b' } },
    ]);
  });

  test('reassembles a chunk sequence into the frame it carries', () => {
    const decoder = createFrameDecoder();
    const payload = { type: 'response', id: 'x', data: { text: 'é'.repeat(50) } };
    const frames = chunked(payload, 4).flatMap((c) => decoder.push(line(c)));
    assert.deepEqual(frames, [{ ok: true, frame: payload }]);
  });

  test('a frame interrupting a chunk sequence is kept, and the broken sequence is reported', () => {
    const decoder = createFrameDecoder();
    const [first, second] = chunked({ type: 'big' }, 2);
    const frames = [...decoder.push(line(first)), ...decoder.push(line({ type: 'agent_start' })), ...decoder.push(line(second))];
    assert.equal(frames.length, 3);
    assert.equal(frames[0].ok, false, 'the abandoned sequence');
    assert.deepEqual(frames[1], { ok: true, frame: { type: 'agent_start' } });
    assert.equal(frames[2].ok, false, 'the orphaned second chunk');
  });

  test('a chunk sequence whose size disagrees with byteLength is garbled, not parsed', () => {
    const decoder = createFrameDecoder();
    const parts = chunked({ type: 'big' }, 2).map((c) => ({ ...c, byteLength: c.byteLength + 5 }));
    const frames = parts.flatMap((c) => decoder.push(line(c)));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].ok, false);
  });

  test('stdout that is not a JSON object comes out as garbled text', () => {
    const decoder = createFrameDecoder();
    const frames = decoder.push(Buffer.from('warning: something\n[1,2]\n'));
    assert.deepEqual(
      frames.map((f) => (f.ok ? null : f.line)),
      ['warning: something', '[1,2]'],
    );
  });

  test('end() flushes an unterminated last line and reports the sequence it interrupted', () => {
    const decoder = createFrameDecoder();
    decoder.push(line(chunked({ type: 'big' }, 3)[0]));
    decoder.push(Buffer.from('{"type":"tail"}'));
    const rest = decoder.end();
    assert.equal(rest.length, 2);
    assert.equal(rest[0].ok, false, 'the unfinished sequence is reported');
    assert.deepEqual(rest[1], { ok: true, frame: { type: 'tail' } });
  });
});
