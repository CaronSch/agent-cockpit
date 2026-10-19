// Behaviour tests for the Scratchpad window against the real daemon, which keeps the notes in
// E2E_STATE_DIR/scratchpad.md.
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_STATE_DIR, e2eToken } from './daemon.js';

/** @typedef {import('@playwright/test').Page} Page */

test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: 'reduce' } });

const FILE = join(E2E_STATE_DIR, 'scratchpad.md');
const onDisk = () => readFileSync(FILE, 'utf8');

/** @type {string[]} */
let problems = [];

/** @param {Page} page */
async function openWorkbench(page) {
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  await page.goto(`/?token=${e2eToken()}`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('#grid')).toBeVisible();
}

/** Adds a Scratchpad window and returns a locator pinned to it. @param {Page} page */
async function addScratchpad(page) {
  const ids = () => page.locator('.widget[data-widget="scratchpad"]').evaluateAll((els) => els.map((e) => /** @type {HTMLElement} */ (e).dataset.id));
  const before = await ids();
  await page.locator('#palette-toggle').click();
  await page.locator('#palette [data-type="scratchpad"]').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.widget[data-widget="scratchpad"]')).toHaveCount(before.length + 1);
  const added = (await ids()).find((id) => !before.includes(id));
  const window = page.locator(`.widget[data-id="${added}"]`);
  await expect(window.locator('.scratchpad-status')).toHaveText('Saved'); // loaded
  return window;
}

test.beforeEach(() => {
  problems = [];
  mkdirSync(E2E_STATE_DIR, { recursive: true });
  writeFileSync(FILE, '');
});

test.afterEach(() => {
  expect(problems, 'page errors / console errors during the test').toEqual([]);
});

test('notes are shared by every Scratchpad window, saved to the file, and outlive closing a window', async ({ page }) => {
  await openWorkbench(page);
  const first = await addScratchpad(page);
  const second = await addScratchpad(page);

  await first.getByRole('textbox', { name: 'Scratchpad' }).fill('- check the flaky test\n- ask about the deploy');
  await expect(second.getByRole('textbox', { name: 'Scratchpad' })).toHaveValue('- check the flaky test\n- ask about the deploy');
  await expect(first.locator('.scratchpad-status')).toHaveText('Saved');
  expect(onDisk()).toBe('- check the flaky test\n- ask about the deploy');

  await first.locator('.widget-close').click();
  await expect(page.locator('.widget[data-widget="scratchpad"]')).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Scratchpad' })).toHaveValue('- check the flaky test\n- ask about the deploy');
});

test('another tab follows the notes as they are saved', async ({ page, context }) => {
  await openWorkbench(page);
  const here = await addScratchpad(page);
  const other = await context.newPage();
  await openWorkbench(other);
  const there = await addScratchpad(other);

  await here.getByRole('textbox', { name: 'Scratchpad' }).fill('typed in the first tab');
  await expect(there.getByRole('textbox', { name: 'Scratchpad' })).toHaveValue('typed in the first tab');
  await expect(there.locator('.scratchpad-status')).toHaveText('Saved');
});

test('an edit made to the file elsewhere is never overwritten without asking', async ({ page }) => {
  await openWorkbench(page);
  const window = await addScratchpad(page);
  const box = window.getByRole('textbox', { name: 'Scratchpad' });
  await box.fill('mine');
  await expect(window.locator('.scratchpad-status')).toHaveText('Saved');

  writeFileSync(FILE, 'edited in vim');
  await box.fill('mine, and more');
  await expect(window.getByRole('alert')).toContainText('changed somewhere else');
  await expect(window.locator('.scratchpad-status')).toHaveText('Not saved: choose a version above');
  expect(onDisk()).toBe('edited in vim');
  await expect(box).toHaveValue('mine, and more');

  await window.getByText('Show their version').click();
  await expect(window.locator('.scratchpad-theirs pre')).toHaveText('edited in vim');
  await window.getByRole('button', { name: 'Keep mine' }).click();
  await expect(window.locator('.scratchpad-status')).toHaveText('Saved');
  await expect(window.getByRole('alert')).toBeHidden();
  expect(onDisk()).toBe('mine, and more');
  // The refused save is logged by the browser as a failed request; that is the expected outcome.
  problems = problems.filter((p) => !p.includes('409'));
});
