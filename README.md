# Agent Cockpit

An in-browser workbench for agentic development with AI coding harnesses (omp
first): chats, terminals, scratchpads, process views and telemetry, each a
modular window you drag, drop, split and resize in a VS Code-style grid with
magnetic snapping.

Status: early. A local daemon runs [omp](https://github.com/can1357/oh-my-pi)
sessions; the **omp** pane chats with them, the **Sessions** window lists past
ones to resume, and the **Scratchpad** keeps notes. Other windows are still to come.
Direction and invariants live in [`CLAUDE.md`](CLAUDE.md); deferred risks in
[`RISKS.md`](RISKS.md).

Requires Node 22+ and `omp` on your `PATH`. No runtime dependencies, no build
step: plain ES modules. Development tools (TypeScript for JSDoc type checking,
Playwright) are dev dependencies only.

```bash
npm install                      # dev tools + git hooks
npm start                        # daemon on http://127.0.0.1:4777; open the URL it prints
npx playwright install chromium  # once per machine, for e2e
npm run typecheck                # tsc --checkJs over JSDoc types
npm test                         # unit suites, plus the daemon against a fake omp
npm run test:e2e                 # Playwright: real app and daemon in Chromium
npm run test:coverage
```

The URL `npm start` prints carries an access token. Open it once; the browser
keeps it as a cookie. The daemon listens on loopback only and refuses requests
from other sites. Pick **＋ Widget → omp**, choose a directory, and start
chatting. To continue an earlier conversation, add **＋ Widget → Sessions**,
search or sort, and drag a session onto the grid (or press **Resume**). The list
comes from omp's session files (`~/.omp/agent/sessions`, or
`$AGENT_COCKPIT_OMP_SESSIONS`).

In an omp pane, select text in a reply to **Comment** on it: the comment waits as
a card above the message box and goes with your next prompt, quoting what it is
about. Or **Ask** about it: a quick side question that omp answers from the
conversation so far (its `btw`), shown in the popup. Neither the question nor the
answer is added to the chat; omp keeps them in its side-question history beside
the session. Closing the popup stops an answer still coming. Like a comment, a
paste longer than 10 lines or 1000 characters waits as a card above the message
box (click it to edit); it is sent wrapped in `<attachment>` tags. Paste a screenshot or
drop a file anywhere on the pane to attach it: the daemon stores it in
`~/.agent-cockpit/attachments/<day>/` and the prompt mentions it as
`@"<path>"`, which omp reads when the prompt starts a turn (images go to the
model; a steer sent while the agent works carries only the path, which the agent
can open itself). A pane whose agent finished its turn, or stopped to ask you
something, while you were not looking gets an electric-blue border (thinking,
tool runs and replies along the way do not); hovering, scrolling, clicking or
typing in it clears it.
Sessions started here are named by omp's title model after their first turn
(the daemon sends `/rename`, so a "Session renamed to …" note appears once).

**＋ Widget → Scratchpad** holds notes. Each new window starts its own pad; the
title button switches a window to another pad (or deletes one), and windows or
tabs showing the same pad stay in sync. Paste a screenshot or drop a file into
a pad to add it inline. Pads are plain Markdown files in
`~/.agent-cockpit/scratchpads/` with their files beside them, so you can open
them in an editor or point an agent at them. If a pad changes elsewhere while
you type, the window asks which version to keep.

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
  // ctx.params: this window's saved settings; ctx.setParams(patch) persists changes.
  // ctx.addWidget(type, params) / ctx.dragWidget(type, params, pointerdown) open another window.
  mount(body, ctx) {
    body.textContent = `hello ${ctx.params.name ?? 'world'}`;
    return { destroy() {} };
  },
};
```

Register it in `src/widgets/registry.js`. Widgets that talk to agents use the
page's shared daemon connection (`getDaemon()` in `src/daemon/client.js`).

## Project layout

```
src/
├── layout/        pure: grid-model, compute-layout, drop-zone, snap, neighbors; new-leaf ids
├── render/        grid-renderer (diffed DOM), drop-indicator (clip-path preview)
├── interaction/   drag-controller, sash-controller
├── state/         atom, persistence
├── daemon/        browser client for the daemon (one shared event stream)
├── omp/           omp pane internals: transcript reducer, markdown, views
├── sessions/      Sessions window ordering (pure)
├── scratchpad/    pads as blocks (text, images, files); each pad's page store: save, follow, conflicts
├── widgets/       registry, pane, omp, sessions, scratchpad
├── ui/            palette, dom helpers
├── app.js         wiring
└── main.js        bootstrap
daemon/            local daemon: HTTP server, loopback guard, omp processes, event log, session history, scratchpads
styles/            tokens.css, app.css, omp.css, sessions.css, scratchpad.css
tests/             node:test suites; fixtures/fake-omp.js stands in for omp
e2e/               Playwright suites against the real daemon
```

Layout is saved to `localStorage["cockpit.layout.v1"]` (versioned and
schema-validated on load).
