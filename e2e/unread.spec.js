// Unread marks outlive the daemon: a session whose turn ended unread is still unread, as a
// past session, after the daemon restarts. Runs a daemon of its own, so restarting it leaves
// the other specs' daemon alone.
import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort, newWorkspace, startDaemon } from './daemon.js';

test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: 'reduce' } });

test('a session left unread is still unread after the daemon restarts', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-e2e-unread-'));
  const stateDir = join(dir, 'state');
  const sessionsDir = join(dir, 'omp-sessions');
  mkdirSync(join(sessionsDir, '-p'), { recursive: true });
  const journal = [
    { type: 'session', version: 3, id: 'kept', timestamp: '2026-10-01T10:00:00.000Z', cwd: dir },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'keep me' }] } },
  ];
  writeFileSync(join(sessionsDir, '-p', '2026-10-01_kept.jsonl'), `${journal.map((l) => JSON.stringify(l)).join('\n')}\n`);
  /** @type {string[]} */
  const problems = [];
  page.on('pageerror', (err) => problems.push(err.message));
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));

  const port = await freePort();
  let daemon = await startDaemon({ port, stateDir, sessionsDir });
  try {
    await page.goto(daemon.url(newWorkspace()));
    await page.locator('#palette-toggle').click();
    await page.locator('#palette [data-type="sessions"]').click();
    await page.keyboard.press('Escape');
    const sessions = page.locator('.widget[data-widget="sessions"]');
    const past = sessions.locator('.sessions-list .sessions-item', { hasText: 'keep me' });
    await past.getByRole('button', { name: 'Resume' }).click();
    const pane = page.locator('.widget[data-widget="omp"]');
    await expect(pane.getByText('Fake Model')).toBeVisible();

    await page.mouse.move(5, 5); // the top bar, outside every window
    await pane.locator('textarea').fill('hello');
    await pane.locator('textarea').press('Enter');
    await expect(pane.locator('.omp-assistant').last()).toContainText('hello');
    await expect(sessions.locator('.sessions-running .sessions-item')).toHaveClass(/is-unread/);

    await daemon.stop(); // its sessions end with it
    daemon = await startDaemon({ port, stateDir, sessionsDir });
    // The page reconnects by itself; the session is a past one now, and still unread.
    await expect(sessions.locator('.sessions-running .sessions-item')).toHaveCount(0, { timeout: 10_000 });
    await expect(past).toHaveClass(/is-unread/);
    await expect(sessions.locator('.widget-label')).toHaveText('1 unread');
    await page.reload();
    await expect(past).toHaveClass(/is-unread/);
  } finally {
    await daemon.stop();
  }
  expect(problems).toEqual([]);
});
