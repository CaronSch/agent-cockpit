// Behaviour tests for the omp pane against the real daemon driving tests/fixtures/fake-omp.js.
import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eToken } from './daemon.js';

/** @typedef {import('@playwright/test').Page} Page */

test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: 'reduce' } });

const PROJECT = mkdtempSync(join(tmpdir(), 'ac-e2e-project-'));

/** @type {string[]} */
let problems = [];

/** @param {Page} page @param {{ signIn?: boolean }} [options] */
async function openWorkbench(page, { signIn = true } = {}) {
  problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    // A signed-out page is refused with 401 on purpose; the browser logs that.
    if (msg.type() === 'error' && !(signIn === false && msg.text().includes('401'))) problems.push(`console.error: ${msg.text()}`);
  });
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  await page.goto(signIn ? `/?token=${e2eToken()}` : '/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('#grid')).toBeVisible();
}

test.afterEach(() => {
  expect(problems, 'page errors / console errors during the test').toEqual([]);
});

/**
 * Adds an omp pane through the palette and returns a locator pinned to that window
 * (`.last()` would re-resolve to whichever pane was added most recently).
 * @param {Page} page
 */
async function addOmpPane(page) {
  const ids = () => page.locator('.widget[data-widget="omp"]').evaluateAll((els) => els.map((e) => /** @type {HTMLElement} */ (e).dataset.id));
  const before = await ids();
  await page.locator('#palette-toggle').click();
  await page.locator('#palette [data-type="omp"]').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.widget[data-widget="omp"]')).toHaveCount(before.length + 1);
  const added = (await ids()).find((id) => !before.includes(id));
  return page.locator(`.widget[data-id="${added}"]`);
}

/** Starts omp in the test project and waits until it accepts prompts. @param {Page} page */
async function startedPane(page) {
  const pane = await addOmpPane(page);
  await pane.locator('input').fill(PROJECT);
  await pane.getByRole('button', { name: 'Start omp' }).click();
  await expect(pane.locator('textarea')).toBeVisible();
  await expect(pane.getByText('Fake Model')).toBeVisible(); // get_state answered: the session is ready
  return pane;
}

/** @param {import('@playwright/test').Locator} pane @param {string} text */
async function send(pane, text) {
  await pane.locator('textarea').fill(text);
  await pane.locator('textarea').press('Enter');
}

test('a browser without the token is told how to sign in, and the daemon serves it nothing', async ({ page }) => {
  await openWorkbench(page, { signIn: false });
  const pane = await addOmpPane(page);
  await expect(pane.getByText('Open the URL printed by `npm start`')).toBeVisible();
  expect((await page.request.get('/api/sessions')).status()).toBe(401);
});

test('a streamed reply renders once, as markdown, even though omp pre-fills message_start', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'hello');
  const reply = pane.locator('.omp-assistant').last();
  await expect(reply.locator('strong')).toHaveText('hello');
  await expect(reply.locator('li')).toHaveText(['one', 'two']);
  await expect(reply).toHaveText(/^You said: hello\s*one\s*two$/);
  await expect(pane.getByText('idle')).toBeVisible();
});

test('a markdown table in a reply renders as a table, not as pipes', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'show me a table');
  const table = pane.locator('.omp-assistant').last().locator('table');
  await expect(table.locator('th')).toHaveText(['When', 'What happens', 'Code']);
  await expect(table.locator('tbody td')).toHaveText(['Now', 'Stuff happened', 'tracked.rs:67']);
  await expect(table.locator('tbody td code')).toHaveText('tracked.rs:67');
  await expect(pane.locator('.omp-assistant').last()).not.toContainText('|');
});

test('the message box grows with the prompt, up to half the pane, and shrinks again after sending', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  const draft = pane.locator('textarea');
  const box = () =>
    draft.evaluate((el) => ({ height: el.getBoundingClientRect().height, scrolls: el.scrollHeight > el.clientHeight + 1 }));
  const paneHeight = await pane.locator('.omp-session').evaluate((el) => el.getBoundingClientRect().height);
  const empty = await box();

  await draft.fill(`${'a line of the prompt\n'.repeat(6)}the end`);
  const grown = await box();
  expect(grown.height).toBeGreaterThan(empty.height + 60);
  expect(grown.scrolls, 'the whole prompt shows').toBe(false);

  await draft.fill('a line of the prompt\n'.repeat(80));
  const capped = await box();
  expect(capped.height).toBeLessThanOrEqual(paneHeight / 2 + 1);
  expect(capped.height).toBeGreaterThan(grown.height);
  expect(capped.scrolls, 'past the cap it scrolls').toBe(true);

  await draft.press('Enter');
  await expect.poll(async () => (await box()).height).toBe(empty.height);
});

test('a tool call is one card whose output appears when expanded', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'run a tool');
  const card = pane.locator('.omp-tool');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('bash');
  await card.locator('summary').click();
  await expect(card.locator('pre').last()).toHaveText('hi');
});

test('an ask dialog is answered from the pane and omp continues with the answer', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'ask me');
  const dialog = pane.locator('.omp-dialogs');
  await expect(dialog.getByText('Which database?')).toBeVisible();
  await dialog.getByText('SQLite', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Submit' }).click();
  await expect(pane.locator('.omp-assistant').last()).toHaveText('You picked SQLite.');
  await expect(dialog.getByText('Which database?')).toHaveCount(0);
});

test('frames the pane does not know and stdout that is not JSON are shown, not dropped', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'mystery garble');
  await expect(pane.locator('.omp-unrecognised', { hasText: 'mystery_frame' })).toHaveCount(1);
  const garbled = pane.locator('.omp-unrecognised', { hasText: /garbled|not a JSON object/ });
  await expect(garbled).toHaveCount(1);
  await garbled.locator('summary').click();
  await expect(garbled).toContainText('this line is not json');
});

test('a reload shows the same conversation in the same window', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'remember me');
  await expect(pane.locator('.omp-assistant').last()).toContainText('You said: remember me');
  await page.reload();
  const again = page.locator('.widget[data-widget="omp"]');
  await expect(again.locator('.omp-user')).toContainText('remember me');
  await expect(again.locator('.omp-assistant').last()).toContainText('You said: remember me');
  await expect(again.locator('.omp-assistant', { hasText: 'You said: remember me' })).toHaveCount(1);
});

test('two panes run separate sessions side by side', async ({ page }) => {
  await openWorkbench(page);
  const left = await startedPane(page);
  const right = await startedPane(page);
  await send(left, 'left only');
  await expect(left.locator('.omp-assistant').last()).toContainText('You said: left only');
  await send(right, 'right only');
  await expect(right.locator('.omp-assistant').last()).toContainText('You said: right only');
  await expect(left.getByText('right only')).toHaveCount(0);
  await expect(right.getByText('left only')).toHaveCount(0);
});

test('closing the window ends its omp session', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  const sessionOf = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem('cockpit.layout.v1') ?? 'null')?.tree?.params?.session);
  await expect.poll(sessionOf).toBeTruthy();
  const session = await sessionOf();
  await pane.locator('.widget-close').click();
  await expect
    .poll(async () => (await (await page.request.get('/api/sessions')).json()).sessions.find((/** @type {any} */ s) => s.id === session)?.status)
    .toBe('exited');
});
