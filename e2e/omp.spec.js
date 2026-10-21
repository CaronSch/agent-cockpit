// Behaviour tests for the omp pane against the real daemon driving tests/fixtures/fake-omp.js.
import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { E2E_STATE_DIR, newWorkspace, savedLayout, workbenchPath } from './daemon.js';
import { composeAsk, composeFollowUp } from '../src/omp/message.js';

/** @typedef {import('@playwright/test').Page} Page */

test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: 'reduce' } });

const PROJECT = mkdtempSync(join(tmpdir(), 'ac-e2e-project-'));

/** @type {string[]} */
let problems = [];

/** Opens the workbench in a workspace of its own, and returns its name. @param {Page} page @param {{ signIn?: boolean }} [options] */
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
  const workspace = newWorkspace();
  await page.goto(workbenchPath(workspace, { signIn }));
  await expect(page.locator('.screen-switch')).toBeVisible(); // the app has started
  return workspace;
}

test.afterEach(() => {
  expect(problems, 'page errors / console errors during the test').toEqual([]);
});

/**
 * Runs `open`, which adds one omp window, and returns a locator pinned to that window
 * (`.last()` would re-resolve to whichever pane was added most recently).
 * @param {Page} page @param {() => Promise<void>} open
 */
async function paneAddedBy(page, open) {
  const ids = () => page.locator('.widget[data-widget="omp"]').evaluateAll((els) => els.map((e) => /** @type {HTMLElement} */ (e).dataset.id));
  const before = await ids();
  await open();
  await expect(page.locator('.widget[data-widget="omp"]')).toHaveCount(before.length + 1);
  const added = (await ids()).find((id) => !before.includes(id));
  return page.locator(`.widget[data-id="${added}"]`);
}

/** Adds an omp pane through the palette. @param {Page} page */
async function addOmpPane(page) {
  return paneAddedBy(page, async () => {
    await page.locator('#palette-toggle').click();
    await page.locator('#palette [data-type="omp"]').click();
    await page.keyboard.press('Escape');
  });
}

/** Starts omp in `dir` (the test project) and waits until it accepts prompts. @param {Page} page @param {string} [dir] */
async function startedPane(page, dir = PROJECT) {
  const pane = await addOmpPane(page);
  await pane.locator('input').fill(dir);
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

/** The next command of `type` the page sends to omp. @param {Page} page @param {string} type */
const rpcSent = (page, type) => page.waitForRequest((r) => r.url().endsWith('/rpc') && r.postDataJSON()?.type === type);

/**
 * The settings saved with `pane`'s window in `workspace`, as the daemon has them.
 * @param {Page} page @param {string} workspace @param {import('@playwright/test').Locator} pane
 */
async function savedParams(page, workspace, pane) {
  const id = await pane.getAttribute('data-id');
  /** @param {any} node @returns {any} */
  const find = (node) => (node?.id === id ? node : (node?.children ?? []).map(find).find(Boolean));
  return find(await savedLayout(page.request, workspace))?.params;
}

/**
 * Selects the bold word in `reply` and opens Ask on it; resolves to the question box.
 * @param {import('@playwright/test').Locator} pane @param {import('@playwright/test').Locator} reply
 */
async function askAbout(pane, reply) {
  await reply.locator('strong').dblclick();
  await pane.getByRole('button', { name: 'Ask', exact: true }).click();
  return pane.getByRole('textbox', { name: 'Ask about the selected text' });
}

test('a browser without the token is told how to sign in, and the daemon serves it nothing', async ({ page }) => {
  await openWorkbench(page, { signIn: false });
  const pane = await addOmpPane(page);
  await expect(pane.getByText('Open the URL printed by `bun start`')).toBeVisible();
  expect((await page.request.get('/api/sessions')).status()).toBe(401);

  // Its layout works but is kept only in memory, and the switcher says so.
  const switcher = page.locator('.screen-switch');
  await expect(switcher).toHaveText(/^Not saved/);
  await switcher.click();
  await expect(page.locator('.screen-menu')).toContainText('not signed in');
  await page.reload();
  await expect(switcher).toHaveText(/^Not saved/);
  await expect(page.locator('.widget')).toHaveCount(0);
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

test('a markdown table copies as Markdown, as CSV, and as a PNG image of the table', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'show me a table');
  const block = pane.locator('.omp-assistant').last().locator('.md-table-block');
  const table = block.locator('table');
  const copy = block.locator('.md-table-copy');
  const menu = block.locator('.md-table-copy-menu');
  /** @param {string} format */
  const copyAs = async (format) => {
    await expect(copy).toHaveText('Copy'); // the previous copy's report has gone
    await table.hover();
    await copy.click();
    await menu.getByRole('button', { name: format }).click();
    await expect(menu).toBeHidden();
    await expect(copy).toHaveText('Copied');
  };
  const clipboardText = () => page.evaluate(() => navigator.clipboard.readText());

  await copyAs('Markdown');
  expect(await clipboardText()).toBe('| When | What happens | Code |\n|---|---|---|\n| Now | Stuff happened | `tracked.rs:67` |');
  await copyAs('CSV');
  expect(await clipboardText()).toBe('When,What happens,Code\nNow,Stuff happened,tracked.rs:67');
  await copyAs('PNG image');
  const image = await page.evaluate(async () => {
    const item = (await navigator.clipboard.read()).find((i) => i.types.includes('image/png'));
    if (!item) return null;
    const bitmap = await createImageBitmap(await item.getType('image/png'));
    return { width: bitmap.width, height: bitmap.height };
  });
  const box = await table.boundingBox();
  if (!image || !box) throw new Error(`no image on the clipboard (${JSON.stringify(image)}) or no table (${JSON.stringify(box)})`);
  // Drawn at 2× from the table's own cells: about twice the rendered table, not a blank or the whole pane.
  expect(Math.abs(image.width / (2 * box.width) - 1)).toBeLessThan(0.35);
  expect(Math.abs(image.height / (2 * box.height) - 1)).toBeLessThan(0.35);
});

test('the message box is set like scratchpad text and starts one line high, placeholder and all', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  const draft = pane.locator('textarea');
  /** @param {import('@playwright/test').Locator} node */
  const font = (node) =>
    node.evaluate((el) => {
      const s = getComputedStyle(el);
      return { family: s.fontFamily, size: s.fontSize, lineHeight: s.lineHeight };
    });
  const padText = await page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement('textarea'));
    probe.className = 'pad-text';
    const s = getComputedStyle(probe);
    const style = { family: s.fontFamily, size: s.fontSize, lineHeight: s.lineHeight };
    probe.remove();
    return style;
  });
  expect(await font(draft)).toEqual(padText);

  // One line of text tall, even in a pane too narrow for the whole placeholder.
  const lines = () =>
    draft.evaluate((el) => {
      const s = getComputedStyle(el);
      return (el.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom)) / parseFloat(s.lineHeight);
    });
  await expect(draft).toHaveAttribute('placeholder', /^Message omp/);
  expect(await lines()).toBeCloseTo(1, 1);
  await page.setViewportSize({ width: 360, height: 800 });
  await expect.poll(lines).toBeCloseTo(1, 1);
  await draft.fill('one\ntwo');
  await expect.poll(lines).toBeCloseTo(2, 1);
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

test('@ suggests files from the session directory; Tab, arrows, Enter and clicks complete them into mentions', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'ac-e2e-mentions-'));
  const project = join(root, 'proj');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(join(project, 'docs'));
  for (const name of ['src/app.js', 'src/api.js', 'README.md', 'notes with space.md', '.env']) writeFileSync(join(project, name), name);
  writeFileSync(join(root, 'sibling.txt'), 'hi');
  await openWorkbench(page);
  const pane = await startedPane(page, project);
  const draft = pane.locator('textarea');
  const list = pane.locator('.omp-suggest');
  const rows = list.getByRole('option');

  // `@` lists the session's directory: folders first and marked, dotfiles hidden.
  await draft.pressSequentially('read @');
  await expect(rows).toHaveText(['docs/', 'src/', 'notes with space.md', 'README.md']);
  await draft.pressSequentially('.');
  await expect(rows).toHaveText(['.env', 'notes with space.md', 'README.md']);
  await draft.press('Backspace');

  // Tab completes a folder with its slash and lists what is in it; then the common prefix, then the one left.
  await draft.pressSequentially('sr');
  await expect(rows).toHaveText(['src/']);
  await draft.press('Tab');
  await expect(draft).toHaveValue('read @src/');
  await expect(rows).toHaveText(['api.js', 'app.js']);
  await draft.press('Tab');
  await expect(draft).toHaveValue('read @src/ap');
  await draft.pressSequentially('p');
  await draft.press('Tab');
  await expect(draft).toHaveValue('read @src/app.js ');
  await expect(list).toBeHidden();

  // `@../` walks up; arrows move and Enter picks.
  await draft.pressSequentially('and @../');
  await expect(rows).toHaveText(['proj/', 'sibling.txt']);
  await draft.press('ArrowDown');
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
  await draft.press('Enter');
  await expect(draft).toHaveValue('read @src/app.js and @../sibling.txt ');

  // A click picks too; a name with spaces goes quoted, as omp reads it whole.
  await draft.pressSequentially('and @no');
  await rows.filter({ hasText: 'notes with space.md' }).click();
  await expect(draft).toHaveValue('read @src/app.js and @../sibling.txt and @"notes with space.md" ');
  await expect(draft).toBeFocused();

  // Esc closes the list without touching the draft.
  await draft.pressSequentially('@');
  await expect(list).toBeVisible();
  await draft.press('Escape');
  await expect(list).toBeHidden();
  await draft.press('Backspace');

  // The mentions go to omp as typed: it reads them relative to the session's directory.
  const sent = rpcSent(page, 'prompt');
  await draft.press('Enter');
  expect((await sent).postDataJSON().message).toBe('read @src/app.js and @../sibling.txt and @"notes with space.md"');
});

test('a comment on selected reply text goes with the next prompt, quoting what it is about', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'hello');
  const reply = pane.locator('.omp-assistant').last();
  await expect(reply.locator('strong')).toHaveText('hello');

  // Text outside the transcript (here the toolbar) is not something to comment on.
  await pane.locator('.omp-cwd').dblclick();
  await page.waitForTimeout(100);
  await expect(pane.locator('.omp-quote-btn')).toHaveCount(0);

  await reply.locator('strong').dblclick(); // selects the word, as a reader would
  await pane.getByRole('button', { name: 'Comment' }).click();
  const box = pane.getByRole('textbox', { name: 'Comment on the selected text' });
  await expect(pane.locator('.omp-quote-pop .omp-quote-preview')).toHaveText('hello');
  await box.fill('why this word?');
  await box.press('Enter');
  const card = pane.locator('.omp-card.is-comment');
  await expect(card).toContainText('“hello”');
  await expect(card).toContainText('why this word?');
  await expect(pane.locator('.omp-quote-pop')).toBeHidden();

  // A shell line goes as typed and leaves the comment waiting.
  await send(pane, '!echo hi');
  await expect(pane.locator('.omp-bash').last()).toBeVisible();
  await expect(card).toBeVisible();

  const sent = page.waitForRequest((r) => r.url().endsWith('/rpc') && r.postDataJSON()?.type === 'prompt');
  await send(pane, 'and the next step?');
  expect((await sent).postDataJSON().message).toBe('> hello\n\nwhy this word?\n\nand the next step?');
  await expect(card).toHaveCount(0);
  await expect(pane.locator('textarea')).toHaveValue('');
});

test('a ! draft turns the message box into a shell line that Enter runs in the session directory', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  const draft = pane.locator('textarea');
  const mark = pane.locator('.omp-shell-mark');
  const sendBtn = pane.locator('.omp-compose-row button');
  const heldNote = pane.getByText('These wait for your next prompt');
  const bashSent = () => page.waitForRequest((r) => r.url().endsWith('/rpc') && r.postDataJSON()?.type === 'bash');

  // A prompt: the box as usual. A long paste waits as a card for it.
  await draft.evaluate((node) => {
    const data = new DataTransfer();
    data.setData('text/plain', Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n'));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  const card = pane.locator('.omp-card.is-text');
  await draft.pressSequentially('ls');
  await expect(sendBtn).toHaveText('Send');
  await expect(mark).toBeHidden();
  await expect(card).toBeVisible();
  await expect(heldNote).toBeHidden();

  // Typing `!` in front, even after a space: a shell command, marked with where it runs, and
  // the card shown as waiting instead of going with it.
  await draft.evaluate((node) => /** @type {HTMLTextAreaElement} */ (node).setSelectionRange(0, 0));
  await page.keyboard.type(' !');
  await expect(sendBtn).toHaveText('Run');
  await expect(mark).toBeVisible();
  await expect(mark).toContainText('$ shell');
  await expect(mark).toContainText(basename(PROJECT));
  await expect(heldNote).toBeVisible();

  // Deleting the `!` makes it a prompt again.
  await draft.press('Backspace');
  await expect(sendBtn).toHaveText('Send');
  await expect(mark).toBeHidden();
  await expect(heldNote).toBeHidden();

  // Enter runs it as a command; its output shows, the card stays for the next prompt.
  await page.keyboard.type('!');
  await expect(sendBtn).toHaveText('Run');
  const sent = bashSent();
  await draft.press('Enter');
  expect((await sent).postDataJSON().command).toBe('ls');
  const run = pane.locator('.omp-bash').last();
  await expect(run.locator('.omp-bash-cmd')).toHaveText('$ ls');
  await expect(run).toContainText('hi');
  await expect(draft).toHaveValue('');
  await expect(sendBtn).toHaveText('Send');
  await expect(mark).toBeHidden();
  await expect(card).toBeVisible();
  await expect(heldNote).toBeHidden();

  // A bare `!` names nothing to run: it stays in the box.
  let ranBare = false;
  page.on('request', (r) => {
    if (r.url().endsWith('/rpc') && r.postDataJSON()?.type === 'bash') ranBare = true;
  });
  await send(pane, '!');
  await page.waitForTimeout(300);
  expect(ranBare, 'a bare ! sends no command').toBe(false);
  await expect(draft).toHaveValue('!');
  await expect(pane.locator('.omp-bash')).toHaveCount(1);
});

test('a ! command while the agent works runs at once, and is not sent as a steer', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'slow');
  await expect(pane.getByText('working')).toBeVisible();
  const sent = page.waitForRequest((r) => r.url().endsWith('/rpc') && ['bash', 'prompt'].includes(r.postDataJSON()?.type));
  await pane.locator('textarea').fill('!echo hi');
  await expect(pane.locator('.omp-compose-row button')).toHaveText('Run');
  await pane.locator('textarea').press('Enter');
  expect((await sent).postDataJSON()).toEqual({ type: 'bash', command: 'echo hi' });
  await expect(pane.locator('.omp-bash').last()).toContainText('hi');
  await expect(pane.getByText('working')).toBeVisible(); // the run came back while the turn went on
  await expect(pane.locator('.omp-assistant').last()).toContainText('You said: slow');
});

test('the toolbar menus open under their button, close on Esc or a click outside, and set what is picked', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  const modelBtn = pane.getByRole('button', { name: 'Fake Model', exact: true });
  const thinkingBtn = pane.getByTitle('Choose thinking level');
  const menu = pane.locator('.omp-menu:popover-open');

  await modelBtn.click();
  await expect(menu.getByRole('button', { name: /Fake Large/ })).toBeVisible();
  await expect(menu.getByRole('searchbox')).toBeFocused();
  const [button, box] = [await modelBtn.boundingBox(), await menu.boundingBox()];
  if (!button || !box) throw new Error('menu not laid out');
  expect(Math.round(box.x)).toBe(Math.round(button.x));
  expect(box.y).toBeGreaterThanOrEqual(button.y + button.height);
  await menu.getByRole('searchbox').fill('large');
  await expect(menu.locator('.omp-menu-item')).toHaveText([/Fake Large/]);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(modelBtn).toBeFocused();

  // Opening another menu closes the first; a click outside closes either.
  await modelBtn.click();
  await expect(menu.getByRole('button', { name: /Fake Large/ })).toBeVisible();
  await thinkingBtn.click();
  await expect(menu).toHaveCount(1);
  await expect(menu.getByRole('button', { name: 'high', exact: true })).toBeVisible();
  await pane.locator('.omp-transcript').click();
  await expect(menu).toHaveCount(0);

  await thinkingBtn.click();
  const picked = page.waitForRequest((r) => r.url().endsWith('/rpc') && r.postDataJSON()?.type === 'set_thinking_level');
  await menu.getByRole('button', { name: 'high', exact: true }).click();
  expect((await picked).postDataJSON().level).toBe('high');
  await expect(menu).toHaveCount(0);
  await expect(thinkingBtn).toHaveText(/high/);
});

test('Ask on selected reply text answers in the popup and leaves the chat as it was', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'hello');
  const reply = pane.locator('.omp-assistant').last();
  await expect(reply.locator('strong')).toHaveText('hello');
  await expect(pane.getByText(/Session renamed/)).toBeVisible(); // the chat has settled
  const transcript = pane.locator('.omp-transcript');
  const chat = await transcript.innerText();

  // "slow": the answer streams in well after omp has taken the question.
  const box = await askAbout(pane, reply);
  const asked = rpcSent(page, 'btw');
  await box.fill('slow: what does this mean?');
  await box.press('Enter');
  expect((await asked).postDataJSON().question).toBe(composeAsk('hello', 'slow: what does this mean?'));
  const pop = pane.locator('.omp-quote-pop');
  await expect(pop.locator('.omp-ask-question')).toHaveText('slow: what does this mean?');
  await expect(pop.locator('.omp-ask-status')).toHaveText('Thinking…');
  await expect(pop.locator('.omp-ask-answer strong')).toHaveText('hello'); // the answer, as Markdown
  expect(await transcript.innerText()).toBe(chat);
  await expect(pane.locator('.omp-card')).toHaveCount(0); // and nothing waits for the next prompt
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();

  // A reload replays the side answer's frames; they still stay out of the chat.
  await page.reload();
  await expect(reply.locator('strong')).toHaveText('hello');
  await page.waitForTimeout(200);
  expect(await transcript.innerText()).toBe(chat);

  /** Asks `question` about the selection; resolves to omp's id for it. @param {string} question */
  const ask = async (question) => {
    const box = await askAbout(pane, reply);
    const started = rpcSent(page, 'btw');
    await box.fill(question);
    await box.press('Enter');
    const answered = await (await started).response();
    return /** @type {string} */ (answered ? (await answered.json()).data?.record?.id : null);
  };

  // A stray click does not throw away an answer still coming; closing the popup stops it.
  const id = await ask('slow: and why?');
  expect(id).toEqual(expect.any(String));
  await expect(pop.locator('.omp-ask-status')).toHaveText('Thinking…');
  await transcript.click({ position: { x: 5, y: 5 } });
  await expect(pop).toBeVisible();
  let cancelled = rpcSent(page, 'btw_cancel');
  await pop.getByRole('button', { name: 'Close' }).click();
  expect((await cancelled).postDataJSON().recordId).toBe(id);
  await expect(pop).toBeHidden();

  // Closed before omp has even taken the question: it is cancelled once omp names it, so the
  // next Ask is not refused for one still running.
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((resolve) => (release = () => resolve(undefined)));
  await page.route('**/rpc', async (route) => {
    if (route.request().postDataJSON()?.type === 'btw') await held;
    await route.continue();
  });
  const early = await askAbout(pane, reply);
  await early.fill('slow: never mind');
  await early.press('Enter');
  await pop.getByRole('button', { name: 'Close' }).click();
  cancelled = rpcSent(page, 'btw_cancel');
  release();
  expect((await cancelled).postDataJSON().recordId).toEqual(expect.any(String));
  await page.unroute('**/rpc');
  await ask('why, then?');
  await expect(pop.locator('.omp-ask-answer strong')).toHaveText('hello');
});

test('Ask takes follow-ups in the same topic, one at a time, and keeps the whole thread out of the chat', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'hello');
  const reply = pane.locator('.omp-assistant').last();
  await expect(reply.locator('strong')).toHaveText('hello');
  await expect(pane.getByText(/Session renamed/)).toBeVisible(); // the chat has settled
  const transcript = pane.locator('.omp-transcript');
  const chat = await transcript.innerText();
  const pop = pane.locator('.omp-quote-pop');
  const questions = pop.locator('.omp-ask-question');
  const answers = pop.locator('.omp-ask-answer');
  const followUp = pop.getByRole('textbox', { name: 'Ask a follow-up' });

  const box = await askAbout(pane, reply);
  const first = rpcSent(page, 'btw');
  await box.fill('what does this mean?');
  await box.press('Enter');
  const topic = (await (await (await first).response())?.json())?.data?.record?.id;
  expect(topic).toEqual(expect.any(String));
  await expect(answers.nth(0).locator('strong')).toHaveText('hello');
  await expect(followUp).toBeFocused();

  // Shift+Enter starts a new line; Enter sends the follow-up in the topic, asking for a short answer.
  await followUp.fill('slow: and');
  await followUp.press('Shift+Enter');
  await followUp.pressSequentially('why?');
  await expect(followUp).toHaveValue('slow: and\nwhy?');
  const asked = rpcSent(page, 'btw');
  await followUp.press('Enter');
  expect((await asked).postDataJSON()).toMatchObject({ question: composeFollowUp('slow: and\nwhy?'), recordId: topic });
  // omp answers one side question at a time: nothing more can be asked until this answer is in.
  await expect(answers.nth(1)).toHaveText('Thinking…');
  await expect(followUp).toBeDisabled();
  await expect(pop.getByRole('button', { name: 'Ask', exact: true })).toBeDisabled();
  await expect(answers.nth(1)).toHaveText('More on hello: it came up once.');
  await expect(questions).toHaveText(['what does this mean?', 'slow: and\nwhy?']);
  await expect(answers.nth(0)).toHaveText('hello is what the conversation said.');
  await expect(followUp).toBeEnabled();

  // A failed answer shows in the thread, and the topic can still be asked about.
  await followUp.fill('fail, please');
  await followUp.press('Enter');
  await expect(answers.nth(2).locator('.omp-ask-error')).toHaveText('Provider error: overloaded');
  await followUp.fill('once more?');
  await followUp.press('Enter');
  await expect(answers.nth(3)).toHaveText('More on hello: it came up once.');
  await expect(questions).toHaveCount(4);

  expect(await transcript.innerText()).toBe(chat);
  await expect(pane.locator('.omp-card')).toHaveCount(0); // and nothing waits for the next prompt
});

test('long pasted text and pasted or dropped files go with the next prompt as attachments', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  const draft = pane.locator('textarea');
  /** Pastes `text` into the draft; true when the browser was left to paste it as typing. @param {string} text */
  const paste = (text) =>
    draft.evaluate((node, text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      return node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);

  // A short paste is ordinary typing; a long one becomes a card, as omp's editor does.
  expect(await paste('one\ntwo')).toBe(true);
  const log = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
  expect(await paste(log)).toBe(false);
  const textCard = pane.locator('.omp-card.is-text');
  await expect(textCard).toContainText('Paste #1 · +12 lines');

  // Clicking it opens the text to edit.
  await textCard.locator('.omp-card-main').click();
  const box = pane.getByRole('textbox', { name: 'Edit paste #1' });
  await expect(box).toHaveValue(log);
  await box.fill(`${log}\nline 13, added`);
  await pane.getByRole('button', { name: 'Save' }).click();
  await expect(textCard).toContainText('+13 lines');

  // A screenshot pasted from the clipboard shows as a thumbnail once stored.
  await draft.evaluate((node) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' }));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  const files = pane.locator('.omp-card.is-file');
  await expect(files.first()).not.toHaveClass(/is-uploading/);
  await expect(files.first().locator('img')).toBeVisible();

  // A file dropped anywhere on the pane; its upload is held so the message goes while it is on its way.
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((resolve) => (release = () => resolve(undefined)));
  await page.route('**/api/attachments', async (route) => {
    if (route.request().headers()['x-file-name'] === 'notes.txt') await held;
    await route.continue();
  });
  const dataTransfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(['hello from a file'], 'notes.txt', { type: 'text/plain' }));
    return data;
  });
  const session = pane.locator('.omp-session');
  await pane.locator('.omp-transcript').dispatchEvent('dragover', { dataTransfer });
  await expect(session).toHaveClass(/is-dropping/);
  await pane.locator('.omp-transcript').dispatchEvent('drop', { dataTransfer });
  await expect(session).not.toHaveClass(/is-dropping/);
  await expect(files.last()).toHaveClass(/is-uploading/);

  const sent = page.waitForRequest((r) => r.url().endsWith('/rpc') && r.postDataJSON()?.type === 'prompt');
  await draft.fill('what are these?');
  await draft.press('Enter');
  release();
  const message = (await sent).postDataJSON().message;
  const paths = [...message.matchAll(/@"([^"]+)"/g)].map((m) => m[1]);
  expect(message).toBe(`what are these?\n\n<attachment>\n${log}\nline 13, added\n</attachment>\n\n@"${paths[0]}"\n\n@"${paths[1]}"`);
  expect(paths[0]).toMatch(new RegExp(`^${join(E2E_STATE_DIR, 'attachments')}/.+-image\\.png$`));
  expect(paths[1]).toMatch(/-notes\.txt$/);
  expect(readFileSync(paths[1], 'utf8')).toBe('hello from a file');
  await expect(pane.locator('.omp-card')).toHaveCount(0);
});

test('a final response that lands while you are elsewhere lights the pane until you look at it', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  const draft = pane.locator('textarea');
  const lookAway = () => page.mouse.move(5, 5); // the top bar, outside the pane
  /** Sends from the keyboard, so the pointer stays wherever it is. @param {string} text */
  const sendFromKeyboard = async (text) => {
    await draft.fill(text);
    await draft.press('Enter');
    await expect(pane.locator('.omp-assistant').last()).toContainText(text);
  };
  await lookAway();
  await sendFromKeyboard('first');
  await expect(pane).toHaveClass(/is-unread/);

  // Still unread after a reload: what was not seen is not forgotten.
  await page.reload();
  await expect(pane.locator('.omp-assistant').last()).toContainText('first');
  await expect(pane).toHaveClass(/is-unread/);

  const box = await pane.boundingBox();
  if (!box) throw new Error('pane not laid out');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(pane).not.toHaveClass(/is-unread/);
  // …and read stays read, even across a reload straight after.
  await lookAway();
  await page.reload();
  await expect(pane.locator('.omp-assistant').last()).toContainText('first');
  await page.waitForTimeout(200);
  await expect(pane).not.toHaveClass(/is-unread/);

  // Scrolling the transcript reads it.
  await sendFromKeyboard('second');
  await expect(pane).toHaveClass(/is-unread/);
  await pane.locator('.omp-transcript').dispatchEvent('wheel');
  await expect(pane).not.toHaveClass(/is-unread/);

  // So does putting the cursor in the message box (without the mouse).
  await sendFromKeyboard('third');
  await expect(pane).toHaveClass(/is-unread/);
  await page.locator('#palette-toggle').focus();
  await draft.focus();
  await expect(pane).not.toHaveClass(/is-unread/);

  // Output that arrives while the pointer is over the pane is read as it comes.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await sendFromKeyboard('fourth');
  await page.waitForTimeout(200);
  await expect(pane).not.toHaveClass(/is-unread/);

  // The middle of a turn (an intermediate reply, a tool run) is not news; its end is.
  await lookAway();
  await draft.fill('slow');
  await draft.press('Enter');
  await expect(pane.locator('.omp-assistant', { hasText: 'Let me check first.' })).toBeVisible();
  await expect(pane.locator('.omp-tool').last()).toBeVisible();
  await expect(pane).not.toHaveClass(/is-unread/);
  await expect(pane.locator('.omp-assistant').last()).toContainText('You said: slow');
  await expect(pane).toHaveClass(/is-unread/);
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

test('Config can show only prompts and final replies, per pane, across a reload, and back', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  const reply = pane.locator('.omp-assistant', { hasText: 'You said: run a tool and think' });
  await send(pane, 'run a tool and think');
  await expect(reply).toBeVisible();
  await expect(pane.locator('.omp-tool')).toHaveCount(1);
  await expect(pane.locator('.omp-thinking')).toHaveCount(1);

  const only = pane.locator('.omp-settings:popover-open').getByRole('checkbox', { name: 'Only prompts and responses' });
  await pane.getByRole('button', { name: 'Config' }).click();
  await expect(only).not.toBeChecked();
  await only.check();
  await expect(pane.locator('.omp-tool')).toHaveCount(0);
  await expect(pane.locator('.omp-thinking')).toHaveCount(0);
  await expect(pane.locator('.omp-user')).toHaveText(/run a tool and think/);
  await expect(pane.locator('.omp-assistant')).toHaveCount(1);
  await expect(reply).toBeVisible();
  await page.keyboard.press('Escape');

  // A running turn is one indicator: its intermediate reply and tool run stay hidden.
  await send(pane, 'slow');
  await expect(pane.locator('.omp-working')).toHaveText('Working… 2 steps');
  await expect(pane.locator('.omp-tool')).toHaveCount(0);
  await expect(pane.getByText('Let me check first.')).toHaveCount(0);
  await expect(pane.locator('.omp-assistant').last()).toContainText('You said: slow');
  await expect(pane.locator('.omp-working')).toHaveCount(0);
  await expect(pane.getByText('Let me check first.')).toHaveCount(0);

  // The setting is this window's: another pane shows everything.
  const other = await startedPane(page);
  await send(other, 'run a tool');
  await expect(other.locator('.omp-tool')).toHaveCount(1);
  await expect(pane.locator('.omp-tool')).toHaveCount(0);

  // The window keeps the setting (and its id) across a reload.
  await page.reload();
  await expect(pane.locator('.omp-assistant').last()).toContainText('You said: slow');
  await expect(pane.locator('.omp-tool')).toHaveCount(0);
  await expect(pane.locator('.omp-thinking')).toHaveCount(0);

  // Switching it off brings back everything it hid.
  await pane.getByRole('button', { name: 'Config' }).click();
  await expect(only).toBeChecked();
  await only.uncheck();
  await expect(pane.locator('.omp-tool')).toHaveCount(2);
  await expect(pane.locator('.omp-thinking')).toHaveCount(1);
  await expect(pane.getByText('Let me check first.')).toBeVisible();
  await expect(reply).toBeVisible();
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

test('Fork continues a copy of the conversation in a new pane, as a session of its own', async ({ page }) => {
  const workspace = await openWorkbench(page);
  const source = await startedPane(page);
  const fork = source.getByRole('button', { name: 'Fork', exact: true });
  await expect(fork, 'omp has saved nothing yet').toBeDisabled();
  await send(source, 'shared start');
  await expect(source.locator('.omp-assistant').last()).toContainText('You said: shared start');

  const forked = await paneAddedBy(page, () => fork.click());
  await expect(forked.locator('.omp-user')).toHaveText([/shared start$/]);
  await expect(forked.locator('.omp-assistant')).toHaveText([/You said: shared start/]);
  await expect(forked.getByText('Fake Model')).toBeVisible();

  await send(forked, 'fork only');
  await expect(forked.locator('.omp-assistant').last()).toContainText('You said: fork only');
  await send(source, 'source only');
  await expect(source.locator('.omp-assistant').last()).toContainText('You said: source only');
  await expect(source.locator('.omp-user')).toHaveText([/shared start$/, /source only$/]);
  await expect(forked.locator('.omp-user')).toHaveText([/shared start$/, /fork only$/]);

  // The window saves its own journal, not the source's, and drops the fork request: after a
  // daemon restart its Resume continues the fork instead of forking again.
  await expect.poll(async () => (await savedParams(page, workspace, forked))?.sessionFile).toMatch(/\.jsonl$/);
  const [mine, theirs] = [await savedParams(page, workspace, forked), await savedParams(page, workspace, source)];
  expect(theirs.sessionFile).toMatch(/\.jsonl$/);
  expect(mine.sessionFile).not.toBe(theirs.sessionFile);
  expect(mine.fork).toBeNull();
});

test('dragging Send sends the message in a fork placed where it is dropped, and empties this box', async ({ page }) => {
  const workspace = await openWorkbench(page);
  const source = await startedPane(page);
  await send(source, 'shared start');
  await expect(source.locator('.omp-assistant').last()).toContainText('You said: shared start');
  const draft = source.locator('textarea');
  const sendBtn = source.getByRole('button', { name: 'Send', exact: true });
  const grid = await page.locator('#grid').boundingBox();
  const button = await sendBtn.boundingBox();
  if (!grid || !button) throw new Error('not laid out');
  const onSend = { x: button.x + button.width / 2, y: button.y + button.height / 2 };

  // Dropped on the grid's left edge: the fork goes left of this pane, not beside it as Fork's would.
  await draft.fill('fork only');
  const forked = await paneAddedBy(page, async () => {
    await page.mouse.move(onSend.x, onSend.y);
    await page.mouse.down();
    await page.mouse.move(grid.x + 10, grid.y + grid.height / 2, { steps: 12 });
    await expect(page.locator('.drop-indicator')).toHaveClass(/is-visible/);
    await page.mouse.up();
  });
  await expect(forked.locator('.omp-user')).toHaveText([/shared start$/, /fork only$/]);
  await expect(forked.locator('.omp-assistant').last()).toContainText('You said: fork only');
  await expect(draft).toHaveValue('');
  const [mine, theirs] = [await forked.boundingBox(), await source.boundingBox()];
  expect(mine && theirs && mine.x < theirs.x).toBe(true);
  // Sent once: the window drops the message as it sends it, so a reload does not send it again.
  await expect.poll(async () => (await savedParams(page, workspace, forked))?.prompt).toBeNull();
  await page.reload();
  const again = page.locator(`.widget[data-id="${await forked.getAttribute('data-id')}"]`);
  await expect(again.locator('.omp-assistant').last()).toContainText('You said: fork only');
  await expect(again.locator('.omp-user')).toHaveText([/shared start$/, /fork only$/]);

  // A drag called off with Esc and let go over Send sends nothing anywhere; the message stays.
  const box = page.locator(`.widget[data-id="${await source.getAttribute('data-id')}"] textarea`);
  await box.fill('stay here');
  await page.mouse.move(onSend.x, onSend.y);
  await page.mouse.down();
  await page.mouse.move(grid.x + 10, grid.y + grid.height / 2, { steps: 12 });
  await page.keyboard.press('Escape');
  await page.mouse.move(onSend.x, onSend.y, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('.widget[data-widget="omp"]')).toHaveCount(2);
  await expect(box).toHaveValue('stay here');
  await box.press('Enter');
  const home = page.locator(`.widget[data-id="${await source.getAttribute('data-id')}"]`);
  await expect(home.locator('.omp-assistant').last()).toContainText('You said: stay here');
  await expect(home.locator('.omp-user')).toHaveText([/shared start$/, /stay here$/]);
});

test('the window’s top bar names its conversation, and the name is saved with the window', async ({ page }) => {
  const workspace = await openWorkbench(page);
  const pane = await startedPane(page);
  const label = pane.locator('.widget-label');
  await expect(label, 'a new session has no name yet').toBeHidden();
  await send(pane, 'fix the login bug');
  await expect(label).toHaveText('About fix the login bug');
  await expect(pane.getByRole('heading', { name: 'omp About fix the login bug' })).toBeVisible();
  await expect.poll(async () => (await savedParams(page, workspace, pane))?.name).toBe('About fix the login bug');
});

test('Up and Down in the message box step through what was sent, as in a shell', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  const draft = pane.locator('textarea');
  await send(pane, 'first');
  await expect(pane.locator('.omp-assistant').last()).toContainText('You said: first');
  await send(pane, '!echo hi');
  await expect(pane.locator('.omp-bash.is-ok')).toContainText('hi');
  await send(pane, 'third');
  await expect(pane.locator('.omp-assistant').last()).toContainText('You said: third');

  await draft.press('ArrowUp');
  await expect(draft).toHaveValue('third');
  await draft.press('ArrowUp');
  await expect(draft).toHaveValue('!echo hi');
  await expect(pane.locator('.omp-composer')).toHaveClass(/is-shell/); // recalled as the command it was
  await draft.press('ArrowUp');
  await expect(draft).toHaveValue('first');
  await draft.press('ArrowDown');
  await draft.press('ArrowDown');
  await expect(draft).toHaveValue('third');
  await draft.press('ArrowDown');
  await expect(draft).toHaveValue('');

  // Up never throws away what the user is writing.
  await draft.fill('my draft');
  await draft.press('ArrowUp');
  await expect(draft).toHaveValue('my draft');
});

test('while the agent works through its todo list, the toolbar shows how far it is', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  const progress = pane.locator('.omp-progress');
  await send(pane, 'slow todo'); // a three-task list, one done, then 1.5 s of work
  await expect(progress).toHaveText('1/3');
  await expect(progress).toHaveAttribute('title', '1 of 3 tasks done\nNow: Write the fix');
  await expect(progress.locator('progress')).toHaveJSProperty('value', 1);
  await expect(pane.getByText('idle')).toBeVisible();
  await expect(progress, 'no turn, no progress').toBeHidden();
});

test('closing the window ends its omp session', async ({ page }) => {
  const workspace = await openWorkbench(page);
  const pane = await startedPane(page);
  const sessionOf = async () => (await savedLayout(page.request, workspace))?.params?.session;
  await expect.poll(sessionOf).toBeTruthy();
  const session = await sessionOf();
  await pane.locator('.widget-close').click();
  await expect
    .poll(async () => (await (await page.request.get('/api/sessions')).json()).sessions.find((/** @type {any} */ s) => s.id === session)?.status)
    .toBe('exited');
});
