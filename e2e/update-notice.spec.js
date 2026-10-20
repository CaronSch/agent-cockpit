// Behaviour test for the notice a page shows when the daemon serves other UI files than it loaded.
import { test, expect } from '@playwright/test';
import { rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { e2eToken } from './daemon.js';

/** A served file the test adds and removes, as a `git pull` under the running daemon would. */
const PROBE = fileURLToPath(new URL('../styles/e2e-update-probe.css', import.meta.url));

test.afterEach(() => rmSync(PROBE, { force: true }));

test('a page running older UI code says so when you come back to it, and Reload brings it up to date', async ({ page }) => {
  /** @type {string[]} */
  const problems = [];
  page.on('pageerror', (err) => problems.push(err.message));
  await page.goto(`/?token=${e2eToken()}`);
  const notice = page.locator('.update-notice');
  await expect(notice).toBeAttached(); // the app is running (`#grid` is static HTML, there before it)
  /** Returning to the tab, which is when the page asks again (once it is connected). */
  const comeBack = () =>
    expect(async () => {
      const asked = page.waitForResponse((r) => r.url().endsWith('/api/ui'), { timeout: 500 });
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await asked;
    }).toPass({ timeout: 5000 });

  await comeBack();
  await expect(notice).toBeHidden();

  writeFileSync(PROBE, '/* e2e */\n');
  await comeBack();
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('role', 'status');
  await expect(notice).toContainText('Cockpit was updated');

  const reloaded = page.waitForEvent('load');
  await notice.getByRole('button', { name: 'Reload' }).click();
  await reloaded;
  await expect(notice).toBeAttached();
  await comeBack();
  await expect(notice).toBeHidden(); // the reloaded page runs what is served

  // Dismissed, it stays away until the files change again.
  rmSync(PROBE);
  await comeBack();
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice).toBeHidden();
  await comeBack();
  await expect(notice).toBeHidden();
  writeFileSync(PROBE, '/* e2e, again */\n');
  await comeBack();
  await expect(notice).toBeVisible();

  expect(problems).toEqual([]);
});
