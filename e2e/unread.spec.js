// The daemon restarting changes nothing a user sees but a moment's reconnecting: nothing is
// awake once it is back, and a window shows its conversation from the journal again, still
// unread, until a message wakes it. Runs a daemon of its own, so restarting it leaves the
// other specs' daemon alone.
import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort, newWorkspace, startDaemon } from './daemon.js';

test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: 'reduce' } });

test('after the daemon restarts, a window shows its conversation again, still unread, and a message wakes it', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-e2e-unread-'));
  const stateDir = join(dir, 'state');
  const sessionsDir = join(dir, 'omp-sessions');
  mkdirSync(join(sessionsDir, '-p'), { recursive: true });
  const file = join(sessionsDir, '-p', '2026-10-01_kept.jsonl');
  const journal = [
    { type: 'session', version: 3, id: 'kept', timestamp: '2026-10-01T10:00:00.000Z', cwd: dir },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'keep me' }] } },
  ];
  writeFileSync(file, `${journal.map((l) => JSON.stringify(l)).join('\n')}\n`);
  /** @type {string[]} */
  const problems = [];
  page.on('pageerror', (err) => problems.push(err.message));
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const port = await freePort();
  /** The sessions this test's daemon has awake. */
  const awake = async () =>
    (await (await page.request.get(`http://127.0.0.1:${port}/api/sessions`)).json()).sessions.filter((/** @type {any} */ s) => s.status === 'ready' || s.status === 'starting');
  let daemon = await startDaemon({ port, stateDir, sessionsDir });
  try {
    await page.goto(daemon.url(newWorkspace()));
    await page.locator('#palette-toggle').click();
    await page.locator('#palette [data-type="sessions"]').click();
    await page.keyboard.press('Escape');
    const sessions = page.locator('.widget[data-widget="sessions"]');
    const kept = sessions.locator('.sessions-list .sessions-item', { hasText: 'keep me' });
    await kept.click();
    const pane = page.locator('.widget[data-widget="omp"]');
    await expect(pane.locator('.omp-user')).toContainText('keep me');

    await page.mouse.move(5, 5); // the top bar, outside every window
    await pane.locator('textarea').fill('hello');
    await pane.locator('textarea').press('Enter');
    await expect(pane.locator('.omp-assistant').last()).toContainText('You said: hello');
    await expect(kept).toHaveClass(/is-unread/);

    await daemon.stop(); // its sessions end with it
    daemon = await startDaemon({ port, stateDir, sessionsDir });
    // The page reconnects by itself: nothing is awake, and the window shows the journal, unread.
    await expect(kept).not.toHaveClass(/is-done/, { timeout: 10_000 });
    expect(await awake()).toEqual([]);
    await expect(kept).toHaveClass(/is-unread/);
    await expect(sessions.locator('.widget-label')).toHaveText('1 unread');
    await expect(pane.locator('.omp-user .omp-md')).toHaveText(['keep me', 'hello'], { useInnerText: true });
    await expect(pane.locator('.omp-assistant').last()).toContainText('You said: hello');
    await expect(pane).toHaveClass(/is-unread/);
    await page.reload();
    await expect(kept).toHaveClass(/is-unread/);
    await expect(pane.locator('.omp-assistant').last()).toContainText('You said: hello');
    expect(await awake()).toEqual([]);

    // A message wakes it, in the same conversation.
    await pane.locator('textarea').fill('and again');
    await pane.locator('textarea').press('Enter');
    await expect(pane.locator('.omp-assistant').last()).toContainText('You said: and again');
    await expect(pane.locator('.omp-user .omp-md')).toHaveText(['keep me', 'hello', 'and again'], { useInnerText: true });
    expect((await awake()).map((/** @type {any} */ s) => s.sessionFile)).toEqual([file]);
  } finally {
    await daemon.stop();
  }
  expect(problems).toEqual([]);
});
