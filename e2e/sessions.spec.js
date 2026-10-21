// Behaviour tests for past sessions: the Sessions window (listing, search, sort, resuming into a
// new omp window) and the omp pane's own session picker (its start screen, `/resume`), against
// the real daemon reading journals from E2E_OMP_SESSIONS.
import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { E2E_OMP_SESSIONS, newWorkspace, workbenchPath } from './daemon.js';

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').Locator} Locator */

test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: 'reduce' } });

// As omp records a session's directory: symlinks resolved (macOS's temp dir is under /private).
const ALPHA = realpathSync(mkdtempSync(join(tmpdir(), 'ac-e2e-alpha-')));
const BRAVO = realpathSync(mkdtempSync(join(tmpdir(), 'ac-e2e-bravo-')));
const MINUTE = 60_000;

/**
 * Three past conversations. Last active: zebra, then deploy, then login, so every ordering
 * the tests check (by activity, by title either way) is a different sequence.
 */
const JOURNALS = [
  { name: 'login', cwd: ALPHA, title: 'Fix the login flow', prompts: ['fix the login bug', 'now add tests'], ageMs: 120 * MINUTE },
  { name: 'deploy', cwd: BRAVO, title: null, prompts: ['deploy staging'], ageMs: 30 * MINUTE },
  { name: 'zebra', cwd: ALPHA, title: 'Zebra cleanup', prompts: ['remove dead code'], ageMs: 10 * MINUTE },
];
/** @param {string} name */
const fileOf = (name) => join(E2E_OMP_SESSIONS, '-e2e-project', `2026-10-01_${name}.jsonl`);

/** @type {string[]} */
let problems = [];

test.beforeEach(async ({ page }) => {
  rmSync(E2E_OMP_SESSIONS, { recursive: true, force: true });
  mkdirSync(join(E2E_OMP_SESSIONS, '-e2e-project'), { recursive: true });
  for (const j of JOURNALS) {
    const lines = [
      ...(j.title ? [{ type: 'title', v: 1, title: j.title, source: 'auto' }] : []),
      { type: 'session', version: 3, id: j.name, timestamp: '2026-10-01T10:00:00.000Z', cwd: j.cwd },
      ...j.prompts.map((text) => ({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } })),
    ];
    writeFileSync(fileOf(j.name), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const at = new Date(Date.now() - j.ageMs);
    utimesSync(fileOf(j.name), at, at);
  }

  problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  await page.goto(workbenchPath(newWorkspace()));
  await expect(page.locator('.screen-switch')).toBeVisible(); // the app has started
});

test.afterEach(async ({ page }) => {
  // Sessions this spec started or resumed would otherwise stay running and show as open in the next test.
  await page.evaluate(
    async ({ journals, dirs }) => {
      const { sessions } = await (await fetch('/api/sessions')).json();
      for (const s of sessions) {
        const ours = s.sessionFile?.startsWith(journals) || dirs.includes(s.cwd);
        if (ours && s.status !== 'exited') await fetch(`/api/sessions/${s.id}`, { method: 'DELETE' });
      }
    },
    { journals: E2E_OMP_SESSIONS, dirs: [ALPHA, BRAVO] },
  );
  expect(problems, 'page errors / console errors during the test').toEqual([]);
});

/** @param {Page} page */
async function addSessionsWindow(page) {
  await page.locator('#palette-toggle').click();
  await page.locator('#palette [data-type="sessions"]').click();
  await page.keyboard.press('Escape');
  const window = page.locator('.widget[data-widget="sessions"]');
  await expect(window).toHaveCount(1);
  return window;
}

/** Row titles in display order. @param {Locator} window */
const titles = (window) => window.locator('.sessions-title');

/** @param {Locator} window @param {string} title */
const row = (window, title) => window.locator('.sessions-item', { has: window.page().locator('.sessions-title', { hasText: title }) });

/** @param {Page} page */
async function settle(page) {
  await page.evaluate(
    () => /** @type {Promise<void>} */ (new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))),
  );
}

/** Real pointer drag from a row to a grid point, checking the drop preview is up before release. @param {Page} page @param {Locator} from */
async function dragToGridRight(page, from) {
  const box = await from.boundingBox();
  const grid = await page.locator('#grid').boundingBox();
  if (!box || !grid) throw new Error('nothing to drag');
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(grid.x + grid.width - 40, grid.y + grid.height / 2, { steps: 12 });
  await settle(page);
}

test('past sessions are listed newest first, searchable across prompts and directories, and sortable', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await expect(titles(window)).toHaveText(['Zebra cleanup', 'deploy staging', 'Fix the login flow']);
  // Separate words, not "2h ago2 prompts": what copy-paste and screen readers get.
  await expect(row(window, 'Fix the login flow').locator('.sessions-meta')).toHaveText(`${ALPHA} 2h ago 2 prompts`);

  const search = window.getByRole('searchbox', { name: 'Search sessions' });
  await search.fill('tests');
  await expect(titles(window)).toHaveText(['Fix the login flow'], { timeout: 3000 }); // a later prompt, not the title
  await search.fill(BRAVO.split('/').pop() ?? '');
  await expect(titles(window)).toHaveText(['deploy staging']);
  await search.fill('');
  await expect(titles(window)).toHaveCount(3);

  await window.getByRole('combobox', { name: 'Sort by' }).selectOption('title');
  await expect(titles(window)).toHaveText(['deploy staging', 'Fix the login flow', 'Zebra cleanup']);
  await window.getByRole('button', { name: 'Reverse sort order' }).click();
  await expect(titles(window)).toHaveText(['Zebra cleanup', 'Fix the login flow', 'deploy staging']);

  await search.fill('zebra');
  await expect(titles(window)).toHaveText(['Zebra cleanup']);
  await page.reload();
  const again = page.locator('.widget[data-widget="sessions"]');
  await expect(again.getByRole('searchbox', { name: 'Search sessions' })).toHaveValue('zebra');
  await expect(again.getByRole('combobox', { name: 'Sort by' })).toHaveValue('title');
  await expect(titles(again)).toHaveText(['Zebra cleanup']);
});

test('dragging a session onto the grid resumes it in a new omp window, and it cannot be opened twice', async ({ page }) => {
  const window = await addSessionsWindow(page);
  const deploy = row(window, 'deploy staging');
  await dragToGridRight(page, deploy);
  await expect(page.locator('.drop-indicator')).toHaveClass(/is-visible/);
  await expect(page.locator('.widget[data-widget="omp"]'), 'nothing is placed before the drop').toHaveCount(0);
  await page.mouse.up();

  const pane = page.locator('.widget[data-widget="omp"]');
  await expect(pane).toHaveCount(1);
  await expect(pane.locator('.omp-user')).toContainText('earlier question');
  await expect(pane.locator('.omp-assistant')).toContainText('earlier answer');
  const sessions = async () => (await (await page.request.get('/api/sessions')).json()).sessions;
  const live = (await sessions()).filter((/** @type {any} */ s) => s.sessionFile === fileOf('deploy') && s.status !== 'exited');
  expect(live).toHaveLength(1);
  expect(live[0].cwd).toBe(BRAVO);

  await expect(deploy.locator('.sessions-badge')).toHaveText('open');
  await expect(deploy.getByRole('button', { name: 'Resume' })).toHaveCount(0);
  await dragToGridRight(page, deploy);
  await expect(page.locator('.drop-indicator')).not.toHaveClass(/is-visible/);
  await page.mouse.up();
  await deploy.dblclick();
  await settle(page);
  await expect(pane).toHaveCount(1);
});

test('Resume opens the session beside the list, and Enter does the same from the keyboard', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await row(window, 'Fix the login flow').getByRole('button', { name: 'Resume' }).click();
  await expect(page.locator('.widget[data-widget="omp"]')).toHaveCount(1);
  await expect(page.locator('.widget[data-widget="omp"] .omp-user')).toContainText('earlier question');

  await row(window, 'Zebra cleanup').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.widget[data-widget="omp"]')).toHaveCount(2);
  await expect(row(window, 'Zebra cleanup').locator('.sessions-badge')).toHaveText('open');
  await expect(page.locator('.widget[data-widget="sessions"]'), 'the list stays').toHaveCount(1);
});

test('a session whose directory is gone says so instead of starting omp somewhere else', async ({ page }) => {
  const gone = join(tmpdir(), 'ac-e2e-gone-dir-that-does-not-exist');
  writeFileSync(
    fileOf('gone'),
    `${[{ type: 'session', version: 3, id: 'gone', timestamp: '2026-10-01T10:00:00.000Z', cwd: gone }, { type: 'message', message: { role: 'user', content: 'old work' } }].map((l) => JSON.stringify(l)).join('\n')}\n`,
  );
  const window = await addSessionsWindow(page);
  await row(window, 'old work').getByRole('button', { name: 'Resume' }).click();
  const pane = page.locator('.widget[data-widget="omp"]');
  await expect(pane.locator('.omp-error')).toContainText('cwd is not an existing directory');
  await expect(pane.getByRole('button', { name: 'New session' })).toBeVisible();
  // A failed request logs a console error in the browser; that is the expected outcome here.
  problems = problems.filter((p) => !p.includes('400'));
});

/** Adds an omp window through the palette; it opens on its start screen. @param {Page} page */
async function addOmpPane(page) {
  const before = await page.locator('.widget[data-widget="omp"]').count();
  await page.locator('#palette-toggle').click();
  await page.locator('#palette [data-type="omp"]').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.widget[data-widget="omp"]')).toHaveCount(before + 1);
  return page.locator('.widget[data-widget="omp"]').last();
}

/** Running sessions whose journal is `name`'s. @param {Page} page @param {string} name */
async function liveOn(page, name) {
  const { sessions } = await (await page.request.get('/api/sessions')).json();
  return sessions.filter((/** @type {any} */ s) => s.sessionFile === fileOf(name) && s.status !== 'exited');
}

test('the start screen lists the typed directory’s sessions, newest first, and a click resumes one there', async ({ page }) => {
  const pane = await addOmpPane(page);
  const field = pane.getByRole('textbox', { name: 'Directory' });
  const picker = pane.getByRole('list', { name: 'Resume a session here' });

  await field.fill(ALPHA);
  await expect(titles(picker)).toHaveText(['Zebra cleanup', 'Fix the login flow']);
  await expect(row(picker, 'Fix the login flow').locator('.sessions-preview')).toHaveText('fix the login bug');
  await expect(row(picker, 'Fix the login flow').locator('.sessions-meta')).toHaveText('2h ago 2 prompts');

  await field.fill(`${BRAVO}/`); // resolved as the daemon resolves a session's directory
  await expect(titles(picker)).toHaveText(['deploy staging']);
  await field.fill(mkdtempSync(join(tmpdir(), 'ac-e2e-empty-')));
  await expect(pane.locator('.session-picker'), 'no sessions, no list').toBeHidden();

  await field.fill(ALPHA);
  await row(picker, 'Fix the login flow').click();
  await expect(pane.locator('.omp-user')).toContainText('earlier question');
  const live = await liveOn(page, 'login');
  expect(live).toHaveLength(1);
  expect(live[0].cwd).toBe(ALPHA);
});

test('the start screen shows a directory’s five newest sessions, and the rest on request', async ({ page }) => {
  const busy = realpathSync(mkdtempSync(join(tmpdir(), 'ac-e2e-busy-')));
  for (let i = 1; i <= 7; i++) {
    const lines = [
      { type: 'session', version: 3, id: `busy${i}`, timestamp: '2026-10-01T10:00:00.000Z', cwd: busy },
      { type: 'message', message: { role: 'user', content: `task ${i}` } },
    ];
    writeFileSync(fileOf(`busy${i}`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const at = new Date(Date.now() - (10 - i) * MINUTE);
    utimesSync(fileOf(`busy${i}`), at, at);
  }
  const pane = await addOmpPane(page);
  await pane.getByRole('textbox', { name: 'Directory' }).fill(busy);
  const picker = pane.getByRole('list', { name: 'Resume a session here' });
  await expect(titles(picker)).toHaveText(['task 7', 'task 6', 'task 5', 'task 4', 'task 3']);
  await pane.getByRole('button', { name: 'Show 2 more' }).click();
  await expect(titles(picker)).toHaveText(['task 7', 'task 6', 'task 5', 'task 4', 'task 3', 'task 2', 'task 1']);
  await expect(pane.getByRole('button', { name: /^Show \d+ more$/ })).toBeHidden();
});

test('the start screen marks sessions open in another window and will not open them twice; Enter resumes', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await row(window, 'Zebra cleanup').getByRole('button', { name: 'Resume' }).click();
  await expect(page.locator('.widget[data-widget="omp"] .omp-user')).toContainText('earlier question');

  const pane = await addOmpPane(page);
  await pane.getByRole('textbox', { name: 'Directory' }).fill(ALPHA);
  const picker = pane.getByRole('list', { name: 'Resume a session here' });
  const zebra = row(picker, 'Zebra cleanup');
  await expect(zebra.locator('.sessions-badge')).toHaveText('open');
  await zebra.click();
  await zebra.press('Enter');
  await settle(page);
  await expect(pane.getByRole('button', { name: 'Start omp' }), 'still on the start screen').toBeVisible();
  expect(await liveOn(page, 'zebra')).toHaveLength(1);

  await row(picker, 'Fix the login flow').focus();
  await page.keyboard.press('Enter');
  await expect(pane.locator('.omp-user')).toContainText('earlier question');
  expect(await liveOn(page, 'login')).toHaveLength(1);
});

test('/resume in a running pane lists its directory’s sessions and switches the pane to the one picked', async ({ page }) => {
  const pane = await addOmpPane(page);
  await pane.getByRole('textbox', { name: 'Directory' }).fill(ALPHA);
  await pane.getByRole('button', { name: 'Start omp' }).click();
  await expect(pane.getByText('Fake Model')).toBeVisible();
  const first = (await (await page.request.get('/api/sessions')).json()).sessions.find((/** @type {any} */ s) => s.cwd === ALPHA && s.status === 'ready');
  const draft = pane.locator('textarea');
  const picker = pane.getByRole('list', { name: 'Resume a session in this directory' });

  await draft.fill('/res');
  await expect(pane.locator('.omp-suggestion-name')).toHaveText(['/resume']);

  /** @type {string[]} */
  const sent = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/rpc')) sent.push(String(r.postDataJSON()?.message ?? r.postDataJSON()?.type));
  });
  await draft.fill('/resume zebra');
  await draft.press('Enter');
  await expect(titles(picker)).toHaveText(['Zebra cleanup']);
  await expect(draft).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();

  await draft.fill('/resume');
  await draft.press('Enter');
  await expect(titles(picker)).toHaveText(['Zebra cleanup', 'Fix the login flow']);
  await pane.locator('.omp-transcript').click();
  await expect(picker, 'a click elsewhere closes it').toBeHidden();
  expect(sent.filter((m) => m.startsWith('/resume')), '/resume never reaches omp').toEqual([]);

  await draft.fill('/resume');
  await draft.press('Enter');
  await row(picker, 'Fix the login flow').click();
  await expect(pane.locator('.omp-user')).toContainText('earlier question');
  expect(await liveOn(page, 'login')).toHaveLength(1);
  const { sessions } = await (await page.request.get('/api/sessions')).json();
  expect(sessions.find((/** @type {any} */ s) => s.id === first.id)?.status, 'the old session was stopped').toBe('exited');
});

test('/resume during a running turn asks before stopping it', async ({ page }) => {
  const pane = await addOmpPane(page);
  await pane.getByRole('textbox', { name: 'Directory' }).fill(ALPHA);
  await pane.getByRole('button', { name: 'Start omp' }).click();
  await expect(pane.getByText('Fake Model')).toBeVisible();
  const draft = pane.locator('textarea');
  await draft.fill('something slow');
  await draft.press('Enter');
  await expect(pane.locator('.omp-activity')).toHaveText('working');

  await draft.fill('/resume');
  await draft.press('Enter');
  const picker = pane.getByRole('list', { name: 'Resume a session in this directory' });
  await row(picker, 'Zebra cleanup').click();
  await expect(pane.getByText('A turn is running. Stop it and resume “Zebra cleanup”?')).toBeVisible();
  await pane.getByRole('button', { name: 'Stop and resume' }).click();
  await expect(pane.locator('.omp-user')).toContainText('earlier question');
  expect(await liveOn(page, 'zebra')).toHaveLength(1);
});
