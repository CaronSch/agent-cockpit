// Behaviour tests for the omp pane against the real daemon driving tests/fixtures/fake-omp.js.
import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { E2E_STATE_DIR, e2eToken } from './daemon.js';

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
  await expect(pane.getByText('Open the URL printed by `bun start`')).toBeVisible();
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

test('Ask on selected reply text answers in the popup and leaves the chat as it was', async ({ page }) => {
  await openWorkbench(page);
  const pane = await startedPane(page);
  await send(pane, 'hello');
  const reply = pane.locator('.omp-assistant').last();
  await expect(reply.locator('strong')).toHaveText('hello');
  await expect(pane.getByText(/Session renamed/)).toBeVisible(); // the chat has settled
  const transcript = pane.locator('.omp-transcript');
  const chat = await transcript.innerText();
  /** Selects the bold word in the reply and opens Ask on it. */
  const askAbout = async () => {
    await reply.locator('strong').dblclick();
    await pane.getByRole('button', { name: 'Ask', exact: true }).click();
    return pane.getByRole('textbox', { name: 'Ask about the selected text' });
  };
  const rpcSent = (/** @type {string} */ type) => page.waitForRequest((r) => r.url().endsWith('/rpc') && r.postDataJSON()?.type === type);

  // "slow": the answer streams in well after omp has taken the question.
  const box = await askAbout();
  const asked = rpcSent('btw');
  await box.fill('slow: what does this mean?');
  await box.press('Enter');
  expect((await asked).postDataJSON().question).toBe('About this part of our conversation:\n\n> hello\n\nslow: what does this mean?');
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
    const box = await askAbout();
    const started = rpcSent('btw');
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
  let cancelled = rpcSent('btw_cancel');
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
  const early = await askAbout();
  await early.fill('slow: never mind');
  await early.press('Enter');
  await pop.getByRole('button', { name: 'Close' }).click();
  cancelled = rpcSent('btw_cancel');
  release();
  expect((await cancelled).postDataJSON().recordId).toEqual(expect.any(String));
  await page.unroute('**/rpc');
  await ask('why, then?');
  await expect(pop.locator('.omp-ask-answer strong')).toHaveText('hello');
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
