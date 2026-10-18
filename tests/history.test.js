import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHistory } from '../daemon/history.js';

/** @param {unknown[]} entries */
const journal = (entries) => `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
/** @param {string} text @param {Record<string, unknown>} [extra] */
const user = (text, extra = {}) => ({ type: 'message', id: 'u', message: { role: 'user', content: [{ type: 'text', text }], ...extra } });
/** @param {string} text */
const assistant = (text) => ({ type: 'message', id: 'a', message: { role: 'assistant', content: [{ type: 'text', text }] } });
/** @param {string} id @param {string} cwd */
const header = (id, cwd) => ({ type: 'session', version: 3, id, timestamp: '2026-10-01T10:00:00.000Z', cwd });

let root = '';
/** @type {string} */
let alpha = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ac-history-'));
  await mkdir(join(root, '-p-alpha', '2026-10-01_aaa'), { recursive: true });
  await mkdir(join(root, '-p-beta'));
  alpha = join(root, '-p-alpha', '2026-10-01_aaa.jsonl');
  await writeFile(
    alpha,
    journal([
      { type: 'title', v: 1, title: '\u{F056E} Fix the login flow', source: 'auto', pad: '   ' },
      header('aaa', '/p/alpha'),
      { type: 'custom_message', customType: 'notice', content: 'mounted tools, "role":"user" in passing' },
      user('fix the login bug'),
      assistant('done'),
      user('handoff summary', { attribution: 'agent' }),
      user('now add tests'),
    ]),
  );
  await writeFile(join(root, '-p-beta', '2026-10-02_bbb.jsonl'), journal([header('bbb', '/p/beta'), user('deploy staging')]));
  await writeFile(join(root, '-p-beta', '2026-10-03_ccc.jsonl'), journal([header('ccc', '/p/beta')])); // never prompted
  await writeFile(join(root, '-p-alpha', '2026-10-01_aaa', 'Explorer.jsonl'), journal([header('sub', '/p/alpha'), user('subagent task')]));
});

describe('session history', () => {
  test('one summary per conversation; subagent journals and never-prompted sessions are left out', async () => {
    const sessions = await createHistory({ root }).list();
    assert.deepEqual(sessions.map((s) => s.id).sort(), ['aaa', 'bbb']);
    const a = sessions.find((s) => s.id === 'aaa');
    assert.equal(a?.title, 'Fix the login flow', 'the nerd-font icon is stripped');
    assert.equal(a?.cwd, '/p/alpha');
    assert.equal(a?.file, alpha);
    assert.equal(a?.prompts, 2, 'agent-authored user messages are not prompts');
    assert.equal(a?.firstPrompt, 'fix the login bug');
    assert.equal(a?.lastPrompt, 'now add tests');
    assert.equal(a?.createdAt, Date.parse('2026-10-01T10:00:00.000Z'));
  });

  test('search needs every word, in any of title, directory or prompts, ignoring case', async () => {
    const history = createHistory({ root });
    /** @param {string} q */
    const ids = async (q) => (await history.list(q)).map((s) => s.id).sort();
    assert.deepEqual(await ids('TESTS alpha'), ['aaa']);
    assert.deepEqual(await ids('login'), ['aaa'], 'title and prompt');
    assert.deepEqual(await ids('beta'), ['bbb'], 'directory');
    assert.deepEqual(await ids('deploy login'), []);
    assert.deepEqual(await ids('handoff'), [], 'agent-authored text is not searched');
  });

  test('a journal that grew since the last listing is read again', async () => {
    const history = createHistory({ root });
    assert.deepEqual(await history.list('rollback'), []);
    await appendFile(alpha, journal([user('plan the rollback')]));
    const later = new Date(Date.now() + 5000);
    await utimes(alpha, later, later);
    const [hit] = await history.list('rollback');
    assert.equal(hit?.id, 'aaa');
    assert.equal(hit?.prompts, 3);
    assert.equal(hit?.lastPrompt, 'plan the rollback');
  });

  test('a torn last line (omp mid-write) does not lose the session', async () => {
    await appendFile(alpha, '{"type":"message","message":{"role":"user","content":[{"type":"te');
    const [a] = (await createHistory({ root }).list()).filter((s) => s.id === 'aaa');
    assert.equal(a?.prompts, 2);
  });

  test('a missing sessions directory is an empty history, not an error', async () => {
    assert.deepEqual(await createHistory({ root: join(root, 'nope') }).list(), []);
  });
});
