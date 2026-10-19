// Behaviour tests for the Scratchpad window against the real daemon, which keeps pads in
// E2E_STATE_DIR/scratchpads/<id>.md with their files in <id>.assets/.
import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_STATE_DIR, e2eToken } from './daemon.js';

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').Locator} Locator */

test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: 'reduce' } });

const PADS = join(E2E_STATE_DIR, 'scratchpads');
/** A 1×1 PNG, so the browser has a real image to decode. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** @type {string[]} */
let problems = [];

/** @param {Page} page @param {{ clear?: boolean }} [options] */
async function openWorkbench(page, { clear = true } = {}) {
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  await page.goto(`/?token=${e2eToken()}`);
  if (clear) {
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  }
  await expect(page.locator('#grid')).toBeVisible();
}

/**
 * Adds a Scratchpad window from the palette (a click, or a drag onto the grid's right edge)
 * and returns a locator pinned to it.
 * @param {Page} page @param {{ drag?: boolean }} [options]
 */
async function addScratchpad(page, { drag = false } = {}) {
  const ids = () => page.locator('.widget[data-widget="scratchpad"]').evaluateAll((els) => els.map((e) => /** @type {HTMLElement} */ (e).dataset.id));
  const before = await ids();
  await page.locator('#palette-toggle').click();
  const item = page.locator('#palette [data-type="scratchpad"]');
  if (drag) {
    const from = await item.boundingBox();
    const grid = await page.locator('#grid').boundingBox();
    if (!from || !grid) throw new Error('nothing to drag');
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(grid.x + grid.width - 30, grid.y + grid.height / 2, { steps: 12 });
    await expect(page.locator('.drop-indicator')).toHaveClass(/is-visible/);
    await page.mouse.up();
  } else {
    await item.click();
  }
  await page.keyboard.press('Escape');
  await expect(page.locator('.widget[data-widget="scratchpad"]')).toHaveCount(before.length + 1);
  const added = (await ids()).find((id) => !before.includes(id));
  const window = page.locator(`.widget[data-id="${added}"]`);
  await expect(window.locator('.scratchpad-status')).toHaveText('Saved'); // loaded
  return window;
}

/** The pad file a window is showing, from its footer. @param {Locator} window */
async function padFile(window) {
  const file = await window.locator('.scratchpad-file').getAttribute('title');
  if (!file) throw new Error('no pad file shown');
  return file;
}

/** All of a pad's text, as the editor would save it. @param {Locator} window */
const editorText = (window) =>
  window.locator('.pad-text').evaluateAll((areas) => areas.map((a) => /** @type {HTMLTextAreaElement} */ (a).value).filter(Boolean).join('\n'));

/** @param {Locator} window @param {string} title */
async function switchTo(window, title) {
  await window.locator('.pad-switch').click();
  await window.getByRole('menuitem', { name: new RegExp(title) }).click();
}

/** Fires a paste of `files` at a text block, as the clipboard would. @param {Locator} area @param {Array<{ name: string, type: string, base64: string }>} files */
async function pasteFiles(area, files) {
  await area.evaluate((el, list) => {
    const data = new DataTransfer();
    for (const f of list) data.items.add(new File([Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, files);
}

test.beforeEach(() => {
  problems = [];
  rmSync(PADS, { recursive: true, force: true });
});

test.afterEach(() => {
  expect(problems, 'page errors / console errors during the test').toEqual([]);
});

test('each new Scratchpad window starts its own pad; the switcher opens another window’s pad', async ({ page }) => {
  await openWorkbench(page);
  const first = await addScratchpad(page);
  const second = await addScratchpad(page, { drag: true });

  await first.locator('.pad-text').first().fill('# Deploy notes\nstaging first');
  await second.locator('.pad-text').first().fill('groceries');
  await expect(first.locator('.scratchpad-status')).toHaveText('Saved');
  await expect(second.locator('.scratchpad-status')).toHaveText('Saved');
  await expect(first.locator('.pad-title')).toHaveText('Deploy notes');
  await expect(second.locator('.pad-text').first()).toHaveValue('groceries');
  expect(readFileSync(await padFile(first), 'utf8')).toBe('# Deploy notes\nstaging first');
  expect(readFileSync(await padFile(second), 'utf8')).toBe('groceries');
  // Clicked or dragged from the palette, a new window gets a fresh pad, never the shared
  // one that windows saved before there were several pads fall back to.
  for (const window of [first, second]) expect(await padFile(window)).not.toMatch(/\/scratchpad\.md$/);

  await switchTo(second, 'Deploy notes');
  await expect(second.locator('.pad-text').first()).toHaveValue('# Deploy notes\nstaging first');
  await first.locator('.pad-text').first().fill('# Deploy notes\nstaging first\nthen prod');
  await expect(second.locator('.pad-text').first()).toHaveValue('# Deploy notes\nstaging first\nthen prod');

  await page.reload();
  const windows = page.locator('.widget[data-widget="scratchpad"]');
  await expect(windows.locator('.pad-title')).toHaveText(['Deploy notes', 'Deploy notes']);
  await switchTo(windows.nth(1), 'groceries');
  await expect(windows.nth(1).locator('.pad-text').first()).toHaveValue('groceries', { timeout: 5000 });
});

test('a pasted screenshot is stored beside the pad and shown inline, between the text around it', async ({ page }) => {
  await openWorkbench(page);
  const window = await addScratchpad(page);
  const area = window.locator('.pad-text').first();
  await area.fill('before\nafter');
  await area.evaluate((el) => /** @type {HTMLTextAreaElement} */ (el).setSelectionRange(6, 6));
  await pasteFiles(area, [{ name: 'image.png', type: 'image/png', base64: PNG.toString('base64') }]);

  const img = window.locator('.pad-image img');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el) => /** @type {HTMLImageElement} */ (el).naturalWidth)).toBe(1);
  await expect(window.locator('.scratchpad-status')).toHaveText('Saved');
  const saved = readFileSync(await padFile(window), 'utf8');
  expect(saved).toMatch(/^before\n!\[image\.png\]\([a-z0-9-]+\.assets\/[a-z0-9]+-image\.png\)\nafter$/);
  const assetsDir = (await padFile(window)).replace(/\.md$/, '.assets');
  expect(readdirSync(assetsDir)).toHaveLength(1);
  await expect(window.locator('.pad-text')).toHaveCount(2);

  // Typing after the image still saves the whole pad, image line included.
  await window.locator('.pad-text').nth(1).fill('after, edited');
  await expect(window.locator('.scratchpad-status')).toHaveText('Saved');
  expect(readFileSync(await padFile(window), 'utf8')).toMatch(/^before\n!\[image\.png\]\(.+\)\nafter, edited$/);

  await window.locator('.pad-image').hover();
  await window.getByRole('button', { name: 'Remove image.png' }).click();
  await expect(img).toHaveCount(0);
  await expect(window.locator('.scratchpad-status')).toHaveText('Saved');
  expect(readFileSync(await padFile(window), 'utf8')).toBe('before\nafter, edited');
});

test('a dropped file that is not an image becomes a download link', async ({ page }) => {
  await openWorkbench(page);
  const window = await addScratchpad(page);
  await window.locator('.pad-text').first().fill('logs:');
  const drop = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(['line 1\nline 2\n'], 'build.log', { type: 'text/plain' }));
    return data;
  });
  await window.locator('.pad-doc').dispatchEvent('drop', { dataTransfer: drop });
  const link = window.locator('.pad-file a');
  await expect(link).toHaveText('build.log');
  await expect(window.locator('.scratchpad-status')).toHaveText('Saved');
  expect(readFileSync(await padFile(window), 'utf8')).toMatch(/^logs:\n\[build\.log\]\([a-z0-9-]+\.assets\/[a-z0-9]+-build\.log\)$/);
  const response = await page.request.get(/** @type {string} */ (await link.getAttribute('href')));
  expect(await response.text()).toBe('line 1\nline 2\n');
  expect(response.headers()['content-disposition']).toBe('attachment');
});

test('deleting a pad removes its file, and the window moves on to a fresh pad', async ({ page }) => {
  await openWorkbench(page);
  const window = await addScratchpad(page);
  await window.locator('.pad-text').first().fill('temporary');
  await expect(window.locator('.scratchpad-status')).toHaveText('Saved');
  const file = await padFile(window);

  await window.locator('.pad-switch').click();
  await window.getByRole('menuitem', { name: 'Delete this scratchpad…' }).click();
  await expect(window.locator('.pad-menu')).toContainText('Delete “temporary”');
  await window.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(window.locator('.pad-title')).toHaveText('Untitled');
  await expect(window.locator('.pad-text').first()).toHaveValue('');
  expect(existsSync(file)).toBe(false);
  expect(await padFile(window)).not.toBe(file);
});

test('a window saved before there were several pads still shows the old shared notes', async ({ page }) => {
  mkdirSync(PADS, { recursive: true });
  writeFileSync(join(PADS, 'scratchpad.md'), 'notes from before');
  await openWorkbench(page);
  await page.evaluate(() => {
    const tree = { kind: 'leaf', id: 'w_legacy1', widget: 'scratchpad' };
    localStorage.setItem('cockpit.layout.v1', JSON.stringify({ version: 1, savedAt: new Date().toISOString(), tree }));
  });
  await page.reload();
  await expect(page.locator('.widget[data-widget="scratchpad"] .pad-text').first()).toHaveValue('notes from before');
});

test('an edit made to the file elsewhere is never overwritten without asking', async ({ page }) => {
  await openWorkbench(page);
  const window = await addScratchpad(page);
  const box = window.locator('.pad-text').first();
  await box.fill('mine');
  await expect(window.locator('.scratchpad-status')).toHaveText('Saved');
  const file = await padFile(window);

  writeFileSync(file, 'edited in vim');
  await box.fill('mine, and more');
  await expect(window.getByRole('alert')).toContainText('changed somewhere else');
  await expect(window.locator('.scratchpad-status')).toHaveText('Not saved: choose a version above');
  expect(readFileSync(file, 'utf8')).toBe('edited in vim');
  await expect(box).toHaveValue('mine, and more');

  await window.getByText('Show their version').click();
  await expect(window.locator('.scratchpad-theirs pre')).toHaveText('edited in vim');
  await window.getByRole('button', { name: 'Keep mine' }).click();
  await expect(window.locator('.scratchpad-status')).toHaveText('Saved');
  await expect(window.getByRole('alert')).toBeHidden();
  expect(readFileSync(file, 'utf8')).toBe('mine, and more');
  // The refused save is logged by the browser as a failed request; that is the expected outcome.
  problems = problems.filter((p) => !p.includes('409'));
});

test('another tab showing the same pad follows it as it is saved', async ({ page, context }) => {
  await openWorkbench(page);
  const here = await addScratchpad(page);
  await here.locator('.pad-text').first().fill('typed in the first tab');
  await expect(here.locator('.scratchpad-status')).toHaveText('Saved');
  const other = await context.newPage();
  await openWorkbench(other);
  const there = await addScratchpad(other);
  await switchTo(there, 'typed in the first tab');

  await here.locator('.pad-text').first().fill('typed in the first tab, and more');
  await expect(there.locator('.pad-text').first()).toHaveValue('typed in the first tab, and more');
  expect(await editorText(there)).toBe('typed in the first tab, and more');
});
