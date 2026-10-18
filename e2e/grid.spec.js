// Behaviour tests for the cockpit grid, driven through real pointer and keyboard input.
import { test, expect } from '@playwright/test';

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */
/** @typedef {Record<string, Rect>} Rects */

const LAYOUT_KEY = 'cockpit.layout.v1';
const GAP = 6; // LAYOUT_OPTIONS.gap in src/app.js
const EDGE_PX = 18; // outer-edge drop band in src/interaction/drag-controller.js
const WIDE = { width: 1280, height: 720 };

// No WAAPI FLIP/enter animations, so bounding rects are the final layout rects.
test.use({ viewport: WIDE, contextOptions: { reducedMotion: 'reduce' } });

/** @type {string[]} */
let problems = [];

test.beforeEach(async ({ page }) => {
  problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
  // Keep runs hermetic: the web-font stylesheet is the only off-origin request.
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('#grid')).toBeVisible();
});

test.afterEach(() => {
  expect(problems, 'page errors / console errors during the test').toEqual([]);
});

/** Resolves after the app's pending requestAnimationFrame render has run. */
async function settle(/** @type {Page} */ page) {
  await page.evaluate(
    () => /** @type {Promise<void>} */ (new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))),
  );
}

/** Widget rects relative to the grid, keyed by leaf id. */
async function rects(/** @type {Page} */ page) {
  return page.evaluate(() => {
    const grid = /** @type {HTMLElement} */ (document.querySelector('#grid')).getBoundingClientRect();
    /** @type {Record<string, { x: number, y: number, w: number, h: number }>} */
    const out = {};
    for (const node of document.querySelectorAll('#grid .widget')) {
      const el = /** @type {HTMLElement} */ (node);
      const r = el.getBoundingClientRect();
      out[/** @type {string} */ (el.dataset.id)] = {
        x: Math.round(r.left - grid.left),
        y: Math.round(r.top - grid.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    }
    return out;
  });
}

/** Grid box in page coordinates. */
async function gridBox(/** @type {Page} */ page) {
  const box = await page.locator('#grid').boundingBox();
  if (!box) throw new Error('grid has no box');
  return { left: box.x, top: box.y, w: Math.round(box.width), h: Math.round(box.height) };
}

/** @returns {Promise<string | null>} */
const stored = (/** @type {Page} */ page) => page.evaluate((key) => localStorage.getItem(key), LAYOUT_KEY);

/** Waits for the debounced save to write something different from `previous`; returns the stored tree. */
async function savedAfter(/** @type {Page} */ page, /** @type {string | null} */ previous) {
  await expect.poll(() => stored(page)).not.toBe(previous);
  const raw = await stored(page);
  return JSON.parse(/** @type {string} */ (raw)).tree;
}

/** Waits until the stored tree holds exactly `ids` (in any order). */
async function savedLeafIds(/** @type {Page} */ page, /** @type {string[]} */ ids) {
  const leafIds = async () => {
    const raw = await stored(page);
    /** @type {string[]} */
    const found = [];
    /** @param {any} node */
    const walk = (node) => (node?.kind === 'leaf' ? found.push(node.id) : node?.children?.forEach(walk));
    walk(raw ? JSON.parse(raw).tree : null);
    return found.sort();
  };
  await expect.poll(leafIds).toEqual([...ids].sort());
}

/** Adds a pane through the palette and returns the new leaf id. */
async function addPane(/** @type {Page} */ page) {
  const before = Object.keys(await rects(page));
  await page.locator('#palette-toggle').click();
  await expect(page.locator('#palette')).toBeVisible();
  await page.locator('.palette-item').first().click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#palette')).toBeHidden();
  await expect(page.locator('.widget')).toHaveCount(before.length + 1);
  await settle(page);
  const added = Object.keys(await rects(page)).filter((id) => !before.includes(id));
  expect(added).toHaveLength(1);
  return added[0];
}

/** Builds A | B, then splits A (tall) downward: A over C on the left, B full height on the right. */
async function threePanes(/** @type {Page} */ page) {
  const a = await addPane(page);
  const b = await addPane(page);
  const c = await addPane(page);
  return { a, b, c };
}

/** Real pointer drag from one page point to another, letting the rAF-driven preview catch up before release. */
async function drag(
  /** @type {Page} */ page,
  /** @type {{ x: number, y: number }} */ from,
  /** @type {{ x: number, y: number }} */ to,
  { beforeRelease = async () => {} } = {},
) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await settle(page);
  await beforeRelease();
  await page.mouse.up();
  await settle(page);
}

/** Centre of a widget's title (inside the draggable header, away from grip and close). */
async function headPoint(/** @type {Page} */ page, /** @type {string} */ id) {
  const box = await page.locator(`.widget[data-id="${id}"] .widget-title`).boundingBox();
  if (!box) throw new Error(`no header for ${id}`);
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/** Drags widget `id` by its header to a grid-relative point. */
async function dragWidget(/** @type {Page} */ page, /** @type {string} */ id, /** @type {{ x: number, y: number }} */ gridPoint) {
  const g = await gridBox(page);
  await drag(page, await headPoint(page, id), { x: g.left + gridPoint.x, y: g.top + gridPoint.y }, {
    beforeRelease: () => expect(page.locator('.drop-indicator')).toHaveClass(/is-visible/),
  });
}

/** Asserts rects are pairwise disjoint, inside the grid, and cover it except for GAP-wide gutters. */
function expectTiling(/** @type {Rects} */ all, /** @type {{ w: number, h: number }} */ grid) {
  const list = Object.values(all);
  for (const r of list) {
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w).toBeLessThanOrEqual(grid.w);
    expect(r.y + r.h).toBeLessThanOrEqual(grid.h);
  }
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [p, q] = [list[i], list[j]];
      const disjoint = p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y;
      expect(disjoint, `${JSON.stringify(p)} overlaps ${JSON.stringify(q)}`).toBe(true);
    }
  }
  // Every sample point is inside a widget or within one gutter of one.
  const near = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ pad) =>
    list.some((r) => x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad);
  for (let x = 1; x < grid.w; x += 23) {
    for (let y = 1; y < grid.h; y += 23) {
      expect(near(x, y, GAP), `uncovered point ${x},${y}`).toBe(true);
    }
  }
}

test.describe('adding panes', () => {
  test('empty grid shows the hint; the first pane hides it and fills the whole grid', async ({ page }) => {
    await expect(page.locator('.grid-empty')).toBeVisible();
    await expect(page.locator('.widget')).toHaveCount(0);

    const id = await addPane(page);
    await expect(page.locator('.grid-empty')).toBeHidden();
    const g = await gridBox(page);
    expect(await rects(page)).toEqual({ [id]: { x: 0, y: 0, w: g.w, h: g.h } });
  });

  test('each new pane splits the largest pane along its longer side', async ({ page }) => {
    const g = await gridBox(page);
    const a = await addPane(page);
    const b = await addPane(page);

    // Wide pane → split right, two equal full-height columns.
    let r = await rects(page);
    expect(r[a]).toEqual({ x: 0, y: 0, w: (g.w - GAP) / 2, h: g.h });
    expect(r[b]).toEqual({ x: (g.w - GAP) / 2 + GAP, y: 0, w: (g.w - GAP) / 2, h: g.h });

    // Both columns are tall and equal; the first one (A) splits downward, B is untouched.
    const c = await addPane(page);
    r = await rects(page);
    expect(r[b]).toEqual({ x: (g.w - GAP) / 2 + GAP, y: 0, w: (g.w - GAP) / 2, h: g.h });
    expect(r[c]).toMatchObject({ x: r[a].x, w: r[a].w, y: r[a].y + r[a].h + GAP });
    expect(r[a].h + GAP + r[c].h).toBe(g.h);
    expectTiling(r, g);

    // B is now strictly the largest pane, so the fourth pane splits B, leaving A and C in place.
    const before = r;
    const d = await addPane(page);
    r = await rects(page);
    expect(r[a]).toEqual(before[a]);
    expect(r[c]).toEqual(before[c]);
    expect(r[d]).toMatchObject({ x: before[b].x, w: before[b].w, y: r[b].y + r[b].h + GAP });
    expect(r[b].h).toBeLessThan(before[b].h);
    expect(Object.keys(r)).toHaveLength(4);
    expectTiling(r, g);
  });
});

test.describe('drag and drop', () => {
  test("dropping a header on another pane's bottom edge moves the pane beneath it", async ({ page }) => {
    const g = await gridBox(page);
    const { a, b, c } = await threePanes(page);
    let r = await rects(page);
    expect(r[b].x).toBeGreaterThan(r[a].x); // B starts as the right-hand column

    // Lower band of C, but further than EDGE_PX from the grid's bottom so it targets C, not the grid edge.
    const target = { x: r[c].x + r[c].w / 2, y: r[c].y + r[c].h - (EDGE_PX + 12) };
    await dragWidget(page, b, target);

    r = await rects(page);
    expect(r[b]).toMatchObject({ x: r[c].x, w: r[c].w, y: r[c].y + r[c].h + GAP });
    for (const id of [a, b, c]) expect(r[id]).toMatchObject({ x: 0, w: g.w }); // no column left
    expect(r[a].y).toBeLessThan(r[c].y);
    expectTiling(r, g);
  });

  test('dropping on an outer grid edge spans the full width or height', async ({ page }) => {
    const g = await gridBox(page);
    const { a, b, c } = await threePanes(page);

    // Top edge band: C becomes a full-width strip above A | B.
    await dragWidget(page, c, { x: Math.round(g.w / 2), y: EDGE_PX / 2 });
    let r = await rects(page);
    expect(r[c]).toMatchObject({ x: 0, y: 0, w: g.w });
    expect(r[c].h).toBeLessThan(g.h / 2);
    for (const id of [a, b]) expect(r[id].y).toBe(r[c].h + GAP);
    expect(r[a].x).toBeLessThan(r[b].x);
    expectTiling(r, g);

    // Left edge band: B becomes a full-height strip left of everything else.
    await dragWidget(page, b, { x: EDGE_PX / 2, y: Math.round(g.h / 2) });
    r = await rects(page);
    expect(r[b]).toMatchObject({ x: 0, y: 0, h: g.h });
    expect(r[b].w).toBeLessThan(g.w / 2);
    for (const id of [a, c]) expect(r[id].x).toBe(r[b].w + GAP);
    expectTiling(r, g);
  });
});

test.describe('sash resizing', () => {
  test('dragging a sash snaps to detents, Alt resizes freely, and the pair total is preserved', async ({ page }) => {
    const g = await gridBox(page);
    const a = await addPane(page);
    const b = await addPane(page);
    const pair = g.w - GAP;
    const sash = page.locator('.sash-row');
    await expect(sash).toHaveCount(1);

    const sashCenter = async () => {
      const box = await sash.boundingBox();
      if (!box) throw new Error('sash has no box');
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    };
    const twoThirds = Math.round(pair * (2 / 3));

    // Release 5px short of the 2/3 detent: the magnet pulls the sash onto it.
    let from = await sashCenter();
    await drag(page, from, { x: from.x + (twoThirds - pair / 2) - 5, y: from.y }, {
      beforeRelease: () => expect(page.locator('.snap-guide')).toHaveClass(/is-visible/),
    });
    let r = await rects(page);
    expect(r[a].w).toBe(twoThirds);
    expect(r[a].w + r[b].w).toBe(pair);
    expect(r[b].x).toBe(r[a].w + GAP);

    // With Alt held, magnets are off: the sash lands exactly where released.
    from = await sashCenter();
    await page.keyboard.down('Alt');
    await drag(page, from, { x: from.x - 155, y: from.y });
    await page.keyboard.up('Alt');
    r = await rects(page);
    expect(r[a].w).toBe(twoThirds - 155);
    expect(r[a].w + r[b].w).toBe(pair);
    expect(r[b].x).toBe(r[a].w + GAP);
    expect(r[a].h).toBe(g.h);
  });
});

test.describe('closing and keyboard moves', () => {
  test('the close button removes the pane and its sibling takes the freed space', async ({ page }) => {
    const g = await gridBox(page);
    const a = await addPane(page);
    const b = await addPane(page);
    await page.locator(`.widget[data-id="${b}"] .widget-close`).click();
    await settle(page);
    expect(await rects(page)).toEqual({ [a]: { x: 0, y: 0, w: g.w, h: g.h } });
    await expect(page.locator('.sash')).toHaveCount(0);
  });

  test('Delete on a focused grip removes that pane', async ({ page }) => {
    const g = await gridBox(page);
    const a = await addPane(page);
    const b = await addPane(page);
    await page.locator(`.widget[data-id="${a}"] .widget-grip`).focus();
    await page.keyboard.press('Delete');
    await settle(page);
    expect(await rects(page)).toEqual({ [b]: { x: 0, y: 0, w: g.w, h: g.h } });
  });

  test('Alt+Shift+Arrow on a grip moves the pane past its neighbour, or to the grid edge', async ({ page }) => {
    const g = await gridBox(page);
    const a = await addPane(page);
    const b = await addPane(page);
    const grip = page.locator(`.widget[data-id="${a}"] .widget-grip`);
    const half = (g.w - GAP) / 2;

    await grip.focus();
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await settle(page);
    let r = await rects(page);
    expect(r[b]).toEqual({ x: 0, y: 0, w: half, h: g.h });
    expect(r[a]).toEqual({ x: half + GAP, y: 0, w: half, h: g.h });

    // No neighbour above: the pane docks to the top edge across the full width.
    await expect(grip).toBeFocused();
    await page.keyboard.press('Alt+Shift+ArrowUp');
    await settle(page);
    r = await rects(page);
    expect(r[a]).toMatchObject({ x: 0, y: 0, w: g.w });
    expect(r[b]).toMatchObject({ x: 0, w: g.w, y: r[a].h + GAP });
  });
});

test.describe('persistence', () => {
  test('a customised layout survives reload with the same ids and rects', async ({ page }) => {
    const { a, b, c } = await threePanes(page);
    await savedLeafIds(page, [a, b, c]);
    const r0 = await rects(page);

    // Make the layout non-default: move B under C (waiting for that save), then resize freely.
    let previous = await stored(page);
    await dragWidget(page, b, { x: r0[c].x + 100, y: r0[c].y + r0[c].h - (EDGE_PX + 12) });
    await savedAfter(page, previous);
    const moved = await rects(page);

    previous = await stored(page);
    const sash = page.locator('.sash-col').first(); // the A / rest divider
    const box = await sash.boundingBox();
    if (!box) throw new Error('sash has no box');
    const from = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    await page.keyboard.down('Alt');
    await drag(page, from, { x: from.x, y: from.y + 37 });
    await page.keyboard.up('Alt');
    const before = await rects(page);
    expect(before[b].x).toBe(0); // B left the right-hand column
    expect(before[a].h).toBe(moved[a].h + 37);
    await savedAfter(page, previous);

    await page.reload();
    await expect(page.locator('.widget')).toHaveCount(3);
    await settle(page);
    expect(await rects(page)).toEqual(before);
  });

  test('closing every pane persists the empty state across reload', async ({ page }) => {
    const a = await addPane(page);
    expect(await savedAfter(page, null)).toMatchObject({ kind: 'leaf', id: a });

    const previous = await stored(page);
    await page.locator(`.widget[data-id="${a}"] .widget-close`).click();
    expect(await savedAfter(page, previous)).toBeNull();

    await page.reload();
    await settle(page);
    await expect(page.locator('.grid-empty')).toBeVisible();
    await expect(page.locator('.widget')).toHaveCount(0);
  });

  for (const [name, value] of [
    ['unparseable JSON', '{not json'],
    ['a schema-invalid tree', JSON.stringify({ version: 1, tree: { kind: 'leaf', id: 7 } })],
    ['an unknown version', JSON.stringify({ version: 99, tree: { kind: 'leaf', id: 'w_1', widget: 'pane' } })],
  ]) {
    test(`corrupt storage (${name}) falls back to a working empty grid`, async ({ page }) => {
      await page.evaluate(([key, raw]) => localStorage.setItem(key, raw), [LAYOUT_KEY, value]);
      await page.reload();
      await settle(page);
      await expect(page.locator('.boot-error')).toHaveCount(0);
      await expect(page.locator('.grid-empty')).toBeVisible();
      await expect(page.locator('.widget')).toHaveCount(0);

      // The app is fully alive, and the next save replaces the bad data.
      const id = await addPane(page);
      const g = await gridBox(page);
      expect(await rects(page)).toEqual({ [id]: { x: 0, y: 0, w: g.w, h: g.h } });
      expect(await savedAfter(page, value)).toMatchObject({ kind: 'leaf', id });
    });
  }
});

test.describe('narrow viewport', () => {
  test('below 640px the panes stack in one column; widening restores the saved split', async ({ page }) => {
    const { a, b, c } = await threePanes(page);
    const wide = await rects(page);
    await savedLeafIds(page, [a, b, c]);
    const previous = await stored(page);

    await page.setViewportSize({ width: 600, height: WIDE.height });
    await expect(page.locator('#grid')).toHaveClass(/\bis-stacked\b/);
    await settle(page);
    const g = await gridBox(page);
    const r = await rects(page);
    // Tree order: A, C, B — one full-width column, top to bottom, gap-separated.
    const order = [a, c, b];
    order.forEach((id, i) => {
      expect(r[id]).toMatchObject({ x: 0, w: g.w });
      if (i > 0) expect(r[id].y).toBe(r[order[i - 1]].y + r[order[i - 1]].h + GAP);
    });
    expect(r[a].y).toBe(0);
    await expect(page.locator('.sash').filter({ visible: true })).toHaveCount(0);

    // Stacking is a projection only: header drags are inert and nothing is saved.
    const head = await headPoint(page, b);
    await drag(page, head, { x: head.x, y: head.y - 300 });
    expect(await rects(page)).toEqual(r);
    expect(await stored(page)).toBe(previous);

    await page.setViewportSize(WIDE);
    await expect(page.locator('#grid')).not.toHaveClass(/\bis-stacked\b/);
    await settle(page);
    expect(await rects(page)).toEqual(wide);
  });
});
