# Agent Cockpit

An in-browser workbench for agentic development with AI coding harnesses (omp
first): chats, terminals, scratchpads, process views and telemetry, each a
modular window you drag, drop, split and resize in a VS Code-style grid with
magnetic snapping.

Status: window-system skeleton. The only widget is an empty **Pane**; real
widgets plug into the registry. Direction and invariants live in
[`CLAUDE.md`](CLAUDE.md); deferred risks in [`RISKS.md`](RISKS.md).

No runtime dependencies, no build step: plain ES modules. Development tools
(TypeScript for JSDoc type checking, Playwright) are dev dependencies only.

```bash
npm install                      # dev tools + git hooks
npx playwright install chromium  # once per machine, for e2e
npm start                        # http://localhost:5173
npm run typecheck                # tsc --checkJs over JSDoc types
npm test                         # node:test suites for the pure modules
npm run test:e2e                 # Playwright, real app in Chromium
npm run test:coverage
```

CI (`.github/workflows/ci.yml`) runs all of the above on every push to `main`
and every pull request.

## Architecture

```
pointer events ──► rAF-coalesced controller ──► pure layout functions ──► diffed DOM writer
                    (drag / sash)                (grid-model, snap,        (grid-renderer)
                                                  drop-zone, compute-layout)
                         │                                 ▲
                         └──── commit once ──► layout atom ┘──► debounced localStorage save
```

- **Split tree** (`src/layout/grid-model.js`) — leaves are widgets, branches are
  rows/columns with fractional sizes. Every operation is pure and `normalize()`
  keeps the tree shallow (flattens same-axis nesting, lifts single children).
- **True landing preview** — while dragging, the drop is applied to a *copy* of the
  tree and the moving widget's future rect is shown, recomputed only when the
  hovered target/zone changes. The highlight animates `clip-path`, not geometry.
- **Magnetic sashes** (`src/layout/snap.js`) — dividers snap to aligned dividers
  elsewhere in the grid and to ⅓ · ½ · ⅔ of their pair, then clamp to minimum
  widget sizes. Hold **Alt** to resize freely.
- **Diffed rendering** (`src/render/grid-renderer.js`) — frames are keyed by leaf
  id and mounted once; only changed `transform` / `width` / `height` values are
  written. Structural changes animate with FLIP on `transform`.
- **Atoms** (`src/state/atom.js`) — `get/set/subscribe` plus `lens` and `view`.
- **Pointer trick from VS Code** — widget bodies get `pointer-events:none` during a
  gesture, and each widget is `contain: strict`.
- **Pointer events instead of native DnD** — no throttled `dragover`, full control
  of the ghost, touch support, and a gutter "sticky zone" so the preview does not
  flicker between widgets.

## Using the grid

| Action | How |
| --- | --- |
| Move a widget | Drag its header onto another widget: edges split, center swaps. Drag to the outer grid edge to span the full width/height |
| Resize | Drag a gutter (snaps magnetically; **Alt** = free). Double-click to split evenly. Focus a gutter and use arrow keys (**Shift** = large step) |
| Add a widget | **＋ Widget** → drag an item onto the grid, or click / Enter |
| Keyboard move | Focus a widget's grip (⠿) → **Alt+Shift+Arrow**; **Delete** closes it |
| Narrow screens | Below 640px the grid renders a scrolling single-column projection of the same widgets; the saved desktop layout is left untouched |

## Adding a widget

```js
// src/widgets/my-widget.js
export default {
  type: 'my-widget',
  title: 'My Widget',
  glyph: '◆',
  description: 'Shown in the palette',
  mount(body) {
    body.textContent = 'hello';
    return { destroy() {} };
  },
};
```

Register it in `src/widgets/registry.js`.

## Project layout

```
src/
├── layout/        pure: grid-model, compute-layout, drop-zone, snap, neighbors; new-leaf ids
├── render/        grid-renderer (diffed DOM), drop-indicator (clip-path preview)
├── interaction/   drag-controller, sash-controller
├── state/         atom, persistence
├── widgets/       registry + pane
├── ui/            palette, dom helpers
├── app.js         wiring
└── main.js        bootstrap
styles/            tokens.css, app.css
tests/             node:test suites for every pure module
```

Layout is saved to `localStorage["cockpit.layout.v1"]` (versioned and
schema-validated on load).
