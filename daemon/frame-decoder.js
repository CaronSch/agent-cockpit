/**
 * Decodes omp's stdout: newline-delimited JSON frames, with protocol-v2 `rpc_chunk`
 * sequences reassembled into the one frame they carry.
 *
 * Nothing is dropped. A line that is not a JSON object, or a chunk sequence that breaks
 * the rules in omp's rpc docs (interleaved, out of order, wrong size, not UTF-8), comes
 * out as a `garbled` result instead of a frame.
 */

const DEFAULT_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const NEWLINE = 0x0a;

/** @typedef {{ ok: true, frame: Record<string, any> } | { ok: false, line: string, error: string }} Decoded */

/**
 * @typedef {{
 *   chunkId: string, count: number, byteLength: number,
 *   parts: Buffer[], size: number, next: number,
 * }} ChunkRun
 */

/** @param {string} line @param {string} error @returns {Decoded} */
const garbled = (line, error) => ({ ok: false, line, error });

/** @param {{ maxReassembledBytes?: number }} [options] */
export function createFrameDecoder({ maxReassembledBytes = DEFAULT_MAX_REASSEMBLED_BYTES } = {}) {
  /** @type {Buffer[]} */
  let partial = [];
  /** @type {ChunkRun | null} */
  let run = null;
  const utf8 = new TextDecoder('utf-8', { fatal: true });

  /** @param {string} reason @returns {Decoded} */
  function abandonRun(reason) {
    const lost = /** @type {ChunkRun} */ (run);
    run = null;
    return garbled(`rpc_chunk ${lost.chunkId}: ${lost.next} of ${lost.count} parts received`, reason);
  }

  /** @param {Record<string, any>} f @param {string} line @returns {Decoded[]} */
  function onChunk(f, line) {
    const wellFormed =
      typeof f.chunkId === 'string' &&
      Number.isInteger(f.index) &&
      Number.isInteger(f.count) &&
      f.count > 0 &&
      Number.isInteger(f.byteLength) &&
      f.byteLength >= 0 &&
      typeof f.data === 'string';
    if (!wellFormed) return [...(run ? [abandonRun('malformed rpc_chunk')] : []), garbled(line, 'malformed rpc_chunk')];

    /** @type {Decoded[]} */
    const out = [];
    if (f.index === 0) {
      if (run) out.push(abandonRun('a new chunk sequence started before this one finished'));
      if (f.byteLength > maxReassembledBytes) return [...out, garbled(line, 'rpc_chunk sequence exceeds the reassembly limit')];
      run = { chunkId: f.chunkId, count: f.count, byteLength: f.byteLength, parts: [], size: 0, next: 0 };
    }
    if (!run || f.chunkId !== run.chunkId || f.index !== run.next || f.count !== run.count || f.byteLength !== run.byteLength) {
      if (run) out.push(abandonRun('rpc_chunk out of sequence'));
      return [...out, garbled(line, 'rpc_chunk out of sequence')];
    }

    const bytes = Buffer.from(f.data, 'base64');
    run.parts.push(bytes);
    run.size += bytes.length;
    run.next += 1;
    if (run.size > run.byteLength) return [...out, abandonRun('rpc_chunk sequence is longer than its byteLength')];
    if (run.next < run.count) return out;

    const done = run;
    run = null;
    const label = `rpc_chunk ${done.chunkId}`;
    if (done.size !== done.byteLength) return [...out, garbled(label, 'reassembled size does not match byteLength')];
    let text;
    try {
      text = utf8.decode(Buffer.concat(done.parts));
    } catch {
      return [...out, garbled(label, 'reassembled bytes are not valid UTF-8')];
    }
    const frame = parseObject(text);
    return [...out, frame ?? garbled(text, 'reassembled rpc_chunk payload is not a JSON object')];
  }

  /** @param {string} text @returns {Decoded | null} */
  function parseObject(text) {
    try {
      const value = JSON.parse(text);
      return value && typeof value === 'object' && !Array.isArray(value) ? { ok: true, frame: value } : null;
    } catch {
      return null;
    }
  }

  /** @param {string} line @returns {Decoded[]} */
  function decodeLine(line) {
    if (line.trim() === '') return [];
    const decoded = parseObject(line);
    if (!decoded) return [...(run ? [abandonRun('chunk sequence interrupted')] : []), garbled(line, 'not a JSON object')];
    if (decoded.ok && decoded.frame.type === 'rpc_chunk') return onChunk(decoded.frame, line);
    return [...(run ? [abandonRun('chunk sequence interrupted by another frame')] : []), decoded];
  }

  return {
    /** @param {Buffer} data @returns {Decoded[]} */
    push(data) {
      /** @type {Decoded[]} */
      const out = [];
      let start = 0;
      for (let i = data.indexOf(NEWLINE); i !== -1; i = data.indexOf(NEWLINE, start)) {
        partial.push(data.subarray(start, i));
        out.push(...decodeLine(Buffer.concat(partial).toString('utf8')));
        partial = [];
        start = i + 1;
      }
      if (start < data.length) partial.push(data.subarray(start));
      return out;
    },
    /** Flushes whatever is left when stdout closes. @returns {Decoded[]} */
    end() {
      const rest = Buffer.concat(partial).toString('utf8');
      partial = [];
      /** @type {Decoded[]} */
      const out = rest.trim() ? decodeLine(rest) : [];
      if (run) out.push(abandonRun('stdout closed mid-sequence'));
      return out;
    },
  };
}
