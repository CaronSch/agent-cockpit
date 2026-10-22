// Behaviour tests for the Sessions window: running sessions with their status and Stop,
// listing, search, sort, showing a session in an omp window, and archiving, against the real
// daemon reading journals from E2E_OMP_SESSIONS.
import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { E2E_OMP_SESSIONS, E2E_STATE_DIR, newWorkspace, savedLayout, workbenchPath } from './daemon.js';

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').Locator} Locator */

test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: 'reduce' } });

const ALPHA = mkdtempSync(join(tmpdir(), 'ac-e2e-alpha-'));
const BRAVO = mkdtempSync(join(tmpdir(), 'ac-e2e-bravo-'));
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
const ARCHIVE = join(E2E_STATE_DIR, 'archive', 'sessions');

/** @type {string[]} */
let problems = [];
/** The workspace this test lays out its windows in. */
let workspace = '';

/**
 * Empties `dir`, keeping the directory itself: the daemon watches it for changes, and a
 * watch does not follow a directory that is deleted and made again.
 * @param {string} dir
 */
function empty(dir) {
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true });
}

/** Writes a past conversation's journal, last active `ageMs` ago. @param {typeof JOURNALS[number]} j */
function writeJournal(j) {
  const lines = [
    ...(j.title ? [{ type: 'title', v: 1, title: j.title, source: 'auto' }] : []),
    { type: 'session', version: 3, id: j.name, timestamp: '2026-10-01T10:00:00.000Z', cwd: j.cwd },
    ...j.prompts.map((text) => ({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } })),
  ];
  writeFileSync(fileOf(j.name), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const at = new Date(Date.now() - j.ageMs);
  utimesSync(fileOf(j.name), at, at);
}

test.beforeEach(async ({ page }) => {
  empty(E2E_OMP_SESSIONS);
  empty(ARCHIVE);
  mkdirSync(join(E2E_OMP_SESSIONS, '-e2e-project'), { recursive: true });
  for (const j of JOURNALS) writeJournal(j);

  problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  workspace = newWorkspace();
  await page.goto(workbenchPath(workspace));
  await expect(page.locator('.screen-switch')).toBeVisible(); // the app has started
  // Unread marks outlive sessions: an earlier test's must not show in this one.
  await page.evaluate(async (ids) => {
    for (const id of ids) {
      await fetch(`/api/unread/${id}/read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ at: Number.MAX_SAFE_INTEGER }) });
    }
  }, JOURNALS.map((j) => j.name));
});

test.afterEach(async ({ page }) => {
  // Sessions this spec resumed would otherwise stay running and show as open in the next test.
  await page.evaluate(async (dir) => {
    const { sessions } = await (await fetch('/api/sessions')).json();
    for (const s of sessions) {
      if (s.sessionFile?.startsWith(dir) && s.status !== 'exited') await fetch(`/api/sessions/${s.id}`, { method: 'DELETE' });
    }
  }, E2E_OMP_SESSIONS);
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

/** Past rows' titles in display order. @param {Locator} window */
const titles = (window) => window.locator('.sessions-list .sessions-title');

/** A past session's row. @param {Locator} window @param {string} title */
const row = (window, title) => window.locator('.sessions-list .sessions-item', { has: window.page().locator('.sessions-title', { hasText: title }) });

/**
 * A running session's row. Tests run in parallel against one daemon, so the Running list also
 * holds other tests' sessions: rows are found by session id.
 * @param {Locator} window @param {string} session
 */
const runningRow = (window, session) => window.locator(`.sessions-running .sessions-item[data-session="${session}"]`);

/** @param {Page} page */
const daemonSessions = async (page) => (await (await page.request.get('/api/sessions')).json()).sessions;

/** The session omp window `pane` shows, once the layout saved with it says. @param {Page} page @param {Locator} pane @returns {Promise<string>} */
async function shownSession(page, pane) {
  const id = await pane.getAttribute('data-id');
  /** @param {any} node @returns {any} */
  const find = (node) => (node?.id === id ? node : (node?.children ?? []).map(find).find(Boolean));
  let session = null;
  await expect.poll(async () => (session = find(await savedLayout(page.request, workspace))?.params?.session ?? null)).toBeTruthy();
  return /** @type {string} */ (/** @type {unknown} */ (session));
}

/** Starts omp in a new omp window (added through the palette), in `dir`. @param {Page} page @param {string} dir */
async function startedPane(page, dir) {
  const before = await page.locator('.widget[data-widget="omp"]').count();
  await page.locator('#palette-toggle').click();
  await page.locator('#palette [data-type="omp"]').click();
  await page.keyboard.press('Escape');
  const pane = page.locator('.widget[data-widget="omp"]').nth(before);
  await pane.locator('input').fill(dir);
  await pane.getByRole('button', { name: 'Start omp' }).click();
  await expect(pane.getByText('Fake Model')).toBeVisible();
  return pane;
}

/** @param {Page} page */
async function settle(page) {
  await page.evaluate(
    () => /** @type {Promise<void>} */ (new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))),
  );
}

/** Real pointer drag from a row to a point, holding the button there. @param {Page} page @param {Locator} from @param {{ x: number, y: number }} to */
async function dragTo(page, from, to) {
  await from.scrollIntoViewIfNeeded();
  const box = await from.boundingBox();
  if (!box) throw new Error('nothing to drag');
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await settle(page);
}

/** Real pointer drag from a row to the grid's right edge. @param {Page} page @param {Locator} from */
async function dragToGridRight(page, from) {
  const grid = await page.locator('#grid').boundingBox();
  if (!grid) throw new Error('no grid');
  await dragTo(page, from, { x: grid.x + grid.width - 40, y: grid.y + grid.height / 2 });
}

/** The middle of a window. @param {Locator} window */
async function middleOf(window) {
  const box = await window.boundingBox();
  if (!box) throw new Error('window not laid out');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
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

test('a session omp writes while the window is open shows up by itself', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await expect(titles(window)).toHaveText(['Zebra cleanup', 'deploy staging', 'Fix the login flow']);
  writeJournal({ name: 'fresh', cwd: BRAVO, title: 'Fresh work', prompts: ['start fresh'], ageMs: 0 });
  await expect(titles(window)).toHaveText(['Fresh work', 'Zebra cleanup', 'deploy staging', 'Fix the login flow']);
});

test('dragging a session onto the grid resumes it in a new omp window; dragged again, a second window shows the same session', async ({ page }) => {
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
  const live = async () => (await daemonSessions(page)).filter((/** @type {any} */ s) => s.sessionFile === fileOf('deploy') && s.status !== 'exited');
  expect(await live()).toHaveLength(1);
  expect((await live())[0].cwd).toBe(BRAVO);
  const session = await shownSession(page, pane);
  await expect(deploy, 'listed once: as running, not as past').toHaveCount(0);
  await expect(runningRow(window, session)).toBeVisible();

  // Running, it is shown again rather than resumed a second time: one omp, two windows.
  await dragToGridRight(page, runningRow(window, session));
  await expect(page.locator('.drop-indicator')).toHaveClass(/is-visible/);
  await page.mouse.up();
  await expect(pane).toHaveCount(2);
  await expect(pane.nth(1).locator('.omp-assistant')).toContainText('earlier answer');
  expect(await shownSession(page, pane.nth(1))).toBe(session);
  expect(await live()).toHaveLength(1);
});

test('the Resume button drags out too, resuming the session where it is dropped', async ({ page }) => {
  const window = await addSessionsWindow(page);
  const resume = row(window, 'Fix the login flow').getByRole('button', { name: 'Resume' });
  const from = await resume.boundingBox();
  const grid = await page.locator('#grid').boundingBox();
  if (!from || !grid) throw new Error('nothing to drag');
  // The grid's left edge: a click on Resume would open it beside the list instead.
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(grid.x + 10, grid.y + grid.height / 2, { steps: 12 });
  await expect(page.locator('.drop-indicator')).toHaveClass(/is-visible/);
  await page.mouse.up();

  const pane = page.locator('.widget[data-widget="omp"]');
  await expect(pane).toHaveCount(1);
  await expect(pane.locator('.omp-user')).toContainText('earlier question');
  const [placed, list] = [await pane.boundingBox(), await window.boundingBox()];
  expect(placed && list && placed.x < list.x).toBe(true);
});

test('Resume opens the session in a new omp window when there is none, then in the last one used; Enter does the same', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await row(window, 'Fix the login flow').getByRole('button', { name: 'Resume' }).click();
  const pane = page.locator('.widget[data-widget="omp"]');
  await expect(pane).toHaveCount(1);
  await expect(pane.locator('.omp-user')).toContainText('earlier question');
  const login = await shownSession(page, pane);

  await row(window, 'Zebra cleanup').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => shownSession(page, pane)).not.toBe(login);
  await expect(pane, 'shown in the window there is, not a new one').toHaveCount(1);
  await expect(runningRow(window, await shownSession(page, pane))).toBeVisible();
  await expect(runningRow(window, login), 'the session it showed before runs on').toBeVisible();
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

test('Archive hides a session from the list (and from omp), Archived lists it, and Restore puts it back', async ({ page }) => {
  mkdirSync(fileOf('zebra').replace(/\.jsonl$/, ''));
  writeFileSync(join(fileOf('zebra').replace(/\.jsonl$/, ''), 'Explorer.jsonl'), '');
  const window = await addSessionsWindow(page);
  await row(window, 'Zebra cleanup').getByRole('button', { name: 'Archive' }).click();
  await expect(titles(window)).toHaveText(['deploy staging', 'Fix the login flow']);
  expect(existsSync(fileOf('zebra')), 'gone from where omp resumes sessions').toBe(false);
  expect(existsSync(join(ARCHIVE, '-e2e-project', '2026-10-01_zebra', 'Explorer.jsonl')), 'kept, folder and all').toBe(true);

  const toggle = window.getByRole('button', { name: 'Archived' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(titles(window)).toHaveText(['Zebra cleanup']);
  await expect(window.locator('.sessions-status')).toHaveText('1 archived session');
  const archived = row(window, 'Zebra cleanup');
  await expect(archived.getByRole('button', { name: 'Resume' })).toHaveCount(0);
  await archived.dblclick();
  await settle(page);
  await expect(page.locator('.widget[data-widget="omp"]'), 'an archived session does not resume').toHaveCount(0);

  await archived.getByRole('button', { name: 'Restore' }).click();
  await expect(window.locator('.sessions-status')).toHaveText('No archived sessions.');
  await toggle.click();
  await expect(titles(window)).toHaveText(['Zebra cleanup', 'deploy staging', 'Fix the login flow']);
  expect(existsSync(join(fileOf('zebra').replace(/\.jsonl$/, ''), 'Explorer.jsonl'))).toBe(true);
});

test('Archive does not drag the session out: pressed and moved onto the grid, it opens nothing', async ({ page }) => {
  const window = await addSessionsWindow(page);
  const from = await row(window, 'Zebra cleanup').getByRole('button', { name: 'Archive' }).boundingBox();
  const grid = await page.locator('#grid').boundingBox();
  if (!from || !grid) throw new Error('nothing to drag');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(grid.x + 10, grid.y + grid.height / 2, { steps: 12 });
  await expect(page.locator('.drop-indicator')).not.toHaveClass(/is-visible/);
  await page.mouse.up();
  await settle(page);
  await expect(page.locator('.widget[data-widget="omp"]')).toHaveCount(0);
});

test('a running session is listed once, as running, even with its window closed, and only Stop lists it as past again to archive', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await row(window, 'deploy staging').getByRole('button', { name: 'Resume' }).click();
  const pane = page.locator('.widget[data-widget="omp"]');
  const session = await shownSession(page, pane);
  await pane.locator('.widget-close').click();
  await expect(pane).toHaveCount(0);

  await expect(runningRow(window, session)).toBeVisible();
  await expect(titles(window), 'not as past, where it could be archived').toHaveText(['Zebra cleanup', 'Fix the login flow']);
  const search = window.getByRole('searchbox', { name: 'Search sessions' });
  await search.fill('deploy');
  await expect(titles(window), 'searched, through its journal').toHaveText([]);
  await expect(runningRow(window, session)).toBeVisible();
  await search.fill('login');
  await expect(titles(window)).toHaveText(['Fix the login flow'], { timeout: 3000 });
  await expect(runningRow(window, session)).toHaveCount(0);
  await search.fill('');

  await runningRow(window, session).getByRole('button', { name: 'Stop' }).click();
  await expect(runningRow(window, session)).toHaveCount(0);
  await expect(titles(window)).toHaveText(['Zebra cleanup', 'deploy staging', 'Fix the login flow']);
  await expect(row(window, 'deploy staging').getByRole('button', { name: 'Archive' })).toBeEnabled();
});

test('Running lists every running session with how it is doing; a click shows it in the omp window used last', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await row(window, 'Fix the login flow').getByRole('button', { name: 'Resume' }).click();
  const first = page.locator('.widget[data-widget="omp"]').first();
  const login = await shownSession(page, first);
  const second = await startedPane(page, ALPHA);
  const fresh = await shownSession(page, second);
  await expect(runningRow(window, login).locator('.sessions-title')).toHaveText('Earlier work');
  await expect(runningRow(window, fresh).locator('.sessions-title')).toHaveText('New session');
  await expect(runningRow(window, fresh).locator('.sessions-state')).toHaveText('idle');

  // Working while a turn runs; done (and unread) once it ends unread; idle again once looked at.
  await page.mouse.move(5, 5); // the top bar: no window is being looked at
  await second.locator('textarea').fill('slow');
  await second.locator('textarea').press('Enter');
  await expect(runningRow(window, fresh).locator('.sessions-state')).toHaveText('working');
  await expect(runningRow(window, fresh).locator('.sessions-title')).toHaveText('slow');
  await expect(runningRow(window, fresh).locator('.sessions-state')).toHaveText('done', { timeout: 5000 });
  await expect(runningRow(window, fresh)).toHaveClass(/is-unread/);
  const { x, y } = await middleOf(second);
  await page.mouse.move(x, y);
  await expect(runningRow(window, fresh).locator('.sessions-state')).toHaveText('idle');

  // The second window was used last: a click shows the session there; its own runs on.
  await runningRow(window, login).click();
  await expect.poll(() => shownSession(page, second)).toBe(login);
  await expect(second.locator('.omp-user')).toContainText('earlier question');
  expect(await shownSession(page, first)).toBe(login);
  await expect(runningRow(window, fresh)).toBeVisible();
  expect((await daemonSessions(page)).find((/** @type {any} */ s) => s.id === fresh).status).toBe('ready');
});

test('a session dragged onto the middle of an omp window is shown there', async ({ page }) => {
  const window = await addSessionsWindow(page);
  const target = await startedPane(page, ALPHA);
  const before = await shownSession(page, target);
  await dragTo(page, row(window, 'Zebra cleanup'), await middleOf(target));
  await expect(page.locator('.drop-indicator')).toHaveClass(/is-visible/);
  await expect(page.locator('.drop-indicator')).toContainText('Show here');
  await page.mouse.up();
  await expect(page.locator('.widget[data-widget="omp"]'), 'no window added').toHaveCount(1);
  await expect(target.locator('.omp-user')).toContainText('earlier question');
  await expect.poll(() => shownSession(page, target)).not.toBe(before);

  // A running one too: the window goes back to the session it showed first.
  await dragTo(page, runningRow(window, before), await middleOf(target));
  await page.mouse.up();
  await expect.poll(() => shownSession(page, target)).toBe(before);
  await expect(page.locator('.widget[data-widget="omp"]')).toHaveCount(1);
});

test('the directory menu narrows the list to one directory, with search, sort and the archive, and is kept per window', async ({ page }) => {
  const window = await addSessionsWindow(page);
  const menu = window.getByRole('combobox', { name: 'Directory' });
  await expect(menu.locator('option')).toHaveText(['All directories', `${ALPHA} (2)`, `${BRAVO} (1)`]);
  await expect(menu).toHaveValue('');

  await menu.selectOption(ALPHA);
  await expect(titles(window)).toHaveText(['Zebra cleanup', 'Fix the login flow']);
  await window.getByRole('combobox', { name: 'Sort by' }).selectOption('title');
  await expect(titles(window)).toHaveText(['Fix the login flow', 'Zebra cleanup']);
  await window.getByRole('searchbox', { name: 'Search sessions' }).fill('tests');
  await expect(titles(window)).toHaveText(['Fix the login flow'], { timeout: 3000 });
  await window.getByRole('searchbox', { name: 'Search sessions' }).fill('deploy');
  await expect(window.locator('.sessions-status')).toHaveText('No session matches.');
  await expect(menu, 'the choice stays while nothing there matches').toHaveValue(ALPHA);
  await window.getByRole('searchbox', { name: 'Search sessions' }).fill('');

  await row(window, 'Zebra cleanup').getByRole('button', { name: 'Archive' }).click();
  await expect(titles(window)).toHaveText(['Fix the login flow']);
  await window.getByRole('button', { name: 'Archived' }).click();
  await expect(titles(window)).toHaveText(['Zebra cleanup']);
  await expect(menu.locator('option')).toHaveText(['All directories', `${ALPHA} (1)`]);
  await window.getByRole('button', { name: 'Archived' }).click();

  // A second Sessions window starts on all directories and keeps a choice of its own.
  const id = await window.getAttribute('data-id');
  const first = page.locator(`.widget[data-id="${id}"]`);
  await page.locator('#palette-toggle').click();
  await page.locator('#palette [data-type="sessions"]').click();
  await page.keyboard.press('Escape');
  const other = page.locator(`.widget[data-widget="sessions"]:not([data-id="${id}"])`);
  await expect(other).toHaveCount(1);
  await expect(other.getByRole('combobox', { name: 'Directory' })).toHaveValue('');
  await other.getByRole('combobox', { name: 'Directory' }).selectOption(BRAVO);
  await expect(titles(other)).toHaveText(['deploy staging']);
  await expect(titles(first)).toHaveText(['Fix the login flow']);

  await page.reload();
  await expect(first.getByRole('combobox', { name: 'Directory' })).toHaveValue(ALPHA);
  await expect(titles(first)).toHaveText(['Fix the login flow']);
  await expect(other.getByRole('combobox', { name: 'Directory' })).toHaveValue(BRAVO);
  await expect(titles(other)).toHaveText(['deploy staging']);
});

/** A finished turn in `pane`, sent from the keyboard while the pointer is on the top bar, outside every window. @param {Page} page @param {Locator} pane @param {string} text */
async function turnWhileAway(page, pane, text) {
  await page.mouse.move(5, 5);
  await pane.locator('textarea').fill(text);
  await pane.locator('textarea').press('Enter');
  await expect(pane.locator('.omp-assistant').last()).toContainText(text);
}

test('a turn that ends while nobody looks stays unread, across reloads and after the session stops, until it is read', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await window.getByRole('combobox', { name: 'Directory' }).selectOption(BRAVO); // only this test's sessions
  await row(window, 'deploy staging').getByRole('button', { name: 'Resume' }).click();
  const pane = page.locator('.widget[data-widget="omp"]');
  const session = await shownSession(page, pane);
  await expect(window.locator('.widget-label')).toBeHidden();

  await turnWhileAway(page, pane, 'hello');
  const running = runningRow(window, session);
  await expect(running).toHaveClass(/is-unread/);
  await expect(running.locator('.sessions-state')).toHaveText('done');
  await expect(running.getByRole('img', { name: 'Unread' })).toBeVisible();
  await expect(window.locator('.widget-label')).toHaveText('1 unread');
  await expect(pane).toHaveClass(/is-unread/);

  await page.reload();
  await expect(running).toHaveClass(/is-unread/);
  await expect(pane).toHaveClass(/is-unread/);

  // Stopped, it is a past session, still unread: blue dot, bold title.
  await running.getByRole('button', { name: 'Stop' }).click();
  const past = row(window, 'deploy staging');
  await expect(past).toHaveClass(/is-unread/);
  await expect(past.locator('.sessions-title')).toHaveCSS('font-weight', '600');
  await expect(window.locator('.widget-label')).toHaveText('1 unread');
  await page.reload();
  await expect(past).toHaveClass(/is-unread/);

  // Archived, it keeps the mark; restored, it still has it.
  await past.getByRole('button', { name: 'Archive' }).click();
  await window.getByRole('button', { name: 'Archived' }).click();
  await expect(past).toHaveClass(/is-unread/);
  await past.getByRole('button', { name: 'Restore' }).click();
  await window.getByRole('button', { name: 'Archived' }).click();
  await expect(past).toHaveClass(/is-unread/);

  // Showing it from Sessions reads it.
  await past.getByRole('button', { name: 'Resume' }).click();
  await expect(past).toHaveCount(0); // listed as running again
  await expect.poll(() => shownSession(page, pane)).not.toBe(session);
  const again = runningRow(window, await shownSession(page, pane));
  await expect(again).toBeVisible();
  await expect(again).not.toHaveClass(/is-unread/);
  await expect(pane).not.toHaveClass(/is-unread/);
  await expect(window.locator('.widget-label')).toBeHidden();
});

test('reading a session in its omp window clears its mark in Sessions', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await row(window, 'deploy staging').getByRole('button', { name: 'Resume' }).click();
  const pane = page.locator('.widget[data-widget="omp"]');
  const running = runningRow(window, await shownSession(page, pane));
  await turnWhileAway(page, pane, 'hello');
  await expect(running).toHaveClass(/is-unread/);
  const { x, y } = await middleOf(pane);
  await page.mouse.move(x, y);
  await expect(pane).not.toHaveClass(/is-unread/);
  await expect(running).not.toHaveClass(/is-unread/);
  await expect(running.locator('.sessions-state')).toHaveText('idle');
  await page.reload();
  await expect(running).toBeVisible();
  await expect(running).not.toHaveClass(/is-unread/);
});

test('a row’s menu, from a right-click or its ⋯ button, marks a session read or unread beside its other actions', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await window.getByRole('combobox', { name: 'Directory' }).selectOption(ALPHA); // only this test's sessions
  const menu = page.getByRole('menu');
  const zebra = row(window, 'Zebra cleanup');
  await zebra.click({ button: 'right' });
  await expect(menu.getByRole('menuitem')).toHaveText(['Resume', 'Mark as unread', 'Archive']);
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await menu.getByRole('menuitem', { name: 'Mark as unread' }).click();
  await expect(menu).toHaveCount(0);
  await expect(zebra).toHaveClass(/is-unread/);
  await expect(window.locator('.widget-label')).toHaveText('1 unread');

  await zebra.hover();
  await zebra.getByRole('button', { name: 'More actions' }).click();
  await expect(menu.getByRole('menuitem')).toHaveText(['Resume', 'Mark as read', 'Archive']);
  await menu.getByRole('menuitem', { name: 'Mark as read' }).click();
  await expect(zebra).not.toHaveClass(/is-unread/);

  // The menu's Archive is the row's.
  await zebra.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(titles(window)).toHaveText(['Fix the login flow']);
  await window.getByRole('button', { name: 'Archived' }).click();
  await zebra.click({ button: 'right' });
  await expect(menu.getByRole('menuitem')).toHaveText(['Mark as unread', 'Restore']);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('from the keyboard, Shift+F10 opens a running row’s menu; Mark as unread lights its window, which the pointer resting there does not clear', async ({ page }) => {
  const window = await addSessionsWindow(page);
  await row(window, 'Zebra cleanup').getByRole('button', { name: 'Resume' }).click();
  const pane = page.locator('.widget[data-widget="omp"]');
  const running = runningRow(window, await shownSession(page, pane));
  await expect(pane.locator('.omp-user')).toContainText('earlier question');
  const { x, y } = await middleOf(pane);
  await page.mouse.move(x, y); // looking at the window

  const menu = page.getByRole('menu');
  await running.focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu.getByRole('menuitem')).toHaveText(['Show', 'Mark as unread', 'Stop']);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(running, 'Esc gives focus back to the row').toBeFocused();

  await page.keyboard.press('ContextMenu');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Mark as unread' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(running).toHaveClass(/is-unread/);
  await expect(running, 'focus is back on the row').toBeFocused();
  await expect(pane).toHaveClass(/is-unread/);
  // The pointer has been resting on the window all along: that is not reading the mark.
  await settle(page);
  await expect(pane).toHaveClass(/is-unread/);
  await expect(running).toHaveClass(/is-unread/);
  // Moving it there again is.
  await page.mouse.move(x + 10, y + 10);
  await expect(pane).not.toHaveClass(/is-unread/);
  await expect(running).not.toHaveClass(/is-unread/);
});
