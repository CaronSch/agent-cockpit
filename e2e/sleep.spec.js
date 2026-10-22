// Sessions go to sleep by themselves once idle and unused (daemon/sleep.js), and nobody needs
// to notice: a window keeps showing its conversation, and the next message wakes it. Runs a
// daemon of its own that puts sessions to sleep after under a second.
import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort, newWorkspace, startDaemon } from './daemon.js';

test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: 'reduce' } });

const SLEEP_AFTER_MS = 800;

test('an idle session nobody uses goes to sleep, never mid-turn; its window keeps the conversation and wakes it to send', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-e2e-sleep-'));
  const stateDir = join(dir, 'state');
  const sessionsDir = join(dir, 'omp-sessions');
  mkdirSync(join(sessionsDir, '-p'), { recursive: true });
  const file = join(sessionsDir, '-p', '2026-10-01_nap.jsonl');
  const journal = [
    { type: 'title', v: 1, title: 'Nap time' },
    { type: 'session', version: 3, id: 'nap', timestamp: '2026-10-01T10:00:00.000Z', cwd: dir },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'before the nap' }] } },
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
  const daemon = await startDaemon({ port, stateDir, sessionsDir, env: { COCKPIT_SLEEP_AFTER_MS: String(SLEEP_AFTER_MS) } });
  try {
    await page.goto(daemon.url(newWorkspace()));
    await page.locator('#palette-toggle').click();
    await page.locator('#palette [data-type="sessions"]').click();
    await page.keyboard.press('Escape');
    await page.locator('.sessions-item', { hasText: 'Nap time' }).click();
    const pane = page.locator('.widget[data-widget="omp"]');
    await expect(pane.locator('.omp-user')).toContainText('before the nap');
    expect(await awake(), 'shown from its journal').toEqual([]);

    // A turn longer than the wait before sleep: awake all through it.
    await page.mouse.move(5, 5); // nobody uses the window from here on
    await pane.locator('textarea').fill('slow');
    await pane.locator('textarea').press('Enter');
    await expect(pane.locator('.omp-activity')).toHaveText('working');
    await expect(pane.locator('.omp-assistant').last()).toContainText('You said: slow', { timeout: 5000 });
    expect(await awake(), 'not asleep mid-turn').toHaveLength(1);

    // Then idle and unused: it goes to sleep, and the window shows the same conversation.
    await expect.poll(awake, { timeout: 5000 }).toEqual([]);
    await expect(pane.locator('.omp-user .omp-md')).toHaveText(['before the nap', 'slow'], { useInnerText: true });
    await expect(pane.locator('.omp-banner')).toBeHidden();
    await expect(pane.locator('.omp-activity')).toHaveText('idle');

    // The next message wakes it and goes.
    await pane.locator('textarea').fill('after the nap');
    await pane.locator('textarea').press('Enter');
    await expect(pane.locator('.omp-assistant').last()).toContainText('You said: after the nap');
    await expect(pane.locator('.omp-user .omp-md')).toHaveText(['before the nap', 'slow', 'after the nap'], { useInnerText: true });
  } finally {
    await daemon.stop();
  }
  expect(problems).toEqual([]);
});
