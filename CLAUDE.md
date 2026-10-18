# Agent Cockpit

An open-source, in-browser workbench for agentic development with AI coding
harnesses. v1 drives omp only.

## The point: everything is a module

The reason this project exists is to make agentic development **as modular as
possible**. Every surface is a window (a widget) that the user places, splits,
stacks, duplicates and closes: chats, terminals, scratchpads, process views,
telemetry views. Nothing is a fixed panel. If a feature tempts you to add a
sidebar, a modal workflow, or a view that only works in one spot, make it a
widget instead.

- **Data views are modular too.** Each telemetry window shows one user-chosen
  slice: one agent or all, model calls, tool calls, processes, file writes,
  file reads, data sent to providers. Several windows can show different
  slices side by side.
- **One default layout** is suggested to new users, as a starting point. It is a
  layout like any other: editable, and never assumed by code.
- **Parity with omp in cmux.** Anything a user can do running omp inside cmux
  (manaflow-ai/cmux) must be possible here: the full omp interaction surface
  (prompts, slash commands, approvals, questions, plan mode, aborts, resume),
  plain shell terminals, split panes and workspaces, a per-workspace
  git branch/PR/cwd/listening-ports summary, "agent needs attention"
  notifications with jump-to-unread, a browser pane beside the agent, a command
  palette with project commands, session restore, and scripting.

Planned capabilities:

- **Structured agent panes**: omp sessions rendered from its event stream, not
  screen-scraped. Several open at once, side by side, each bound to a session.
- **Saved context**: pin parts of a chat into their own windows; fork a session
  into a new pane to compare.
- **Scratchpad**: free-form notes next to the agents, shared across windows.
- **Terminal panes**: a real shell (and omp's own TUI, if wanted).
- **Process view**: the processes each agent runs, and their CPU, memory and I/O.
- **Telemetry**: every model call, tool call, process and file-system access,
  including reads and data sent to model providers.

## Architecture

- **Browser UI** (`src/`): the window grid and the widgets. No build step.
- **Local daemon** (not yet written): the only process that touches the machine.
  It launches omp in rpc mode and owns those processes. The workbench is
  self-contained: it shows agents it launched and does not attach to sessions
  started in other terminals. The daemon also samples process trees, proxies
  model calls, observes the filesystem, and stores events locally.
- **Telemetry provenance**: every recorded fact carries its source: `harness`
  (omp said so), `proxy` (seen on the wire), or `os` (seen by the kernel or the
  filesystem). The UI shows the source. The gap between what an agent claims it
  did and what the OS saw is the product, so never merge the two silently.
- **Local only, single user.** No auth beyond the loopback guard below.

## Current state

Window-system skeleton only. None of the capabilities above exist yet. What runs
today is a VS Code-style split-tree grid: windows (widgets) are dragged, dropped,
split and resized with magnetic snapping, the layout persists in localStorage,
and the only widget is an empty `pane`. There is no daemon and no harness
connection.

## How we decide

- **Simple beats clever**, except where the workbench needs it: structured panes
  and the rich, modular workbench are not to be simplified away.
- **Risks:** weigh each one when it comes up, decide, and tell the owner in one
  line what you decided. Fix a risk now only if it bites at the current stage
  *and* the fix costs little next to the damage. Drop small risks whose cover
  needs significant complexity. A risk that only bites at a later stage (going
  public, a second user, remote access, a new platform) goes in `RISKS.md`,
  under the threshold at which it bites.
- **At the start of every session, read `RISKS.md`.** For each threshold, decide
  from the repo's current state whether it has been crossed. If one has, tell the
  owner and propose the fix before other work. When a risk is fixed, delete its
  entry.

## Invariants (current stage)

- The daemon binds `127.0.0.1` only, requires a per-launch random token on every
  connection, and rejects any `Origin` that is not the workbench's own. Without
  this, any web page open in the user's browser can reach the daemon and run
  commands on the machine.
- Every agent the workbench shows was launched by the daemon.
- An omp event or message kind the adapter does not know is shown as an
  unrecognised entry, never dropped. Telemetry that silently loses events lies.

## Constraints

- The browser UI is plain ES modules with no build step (`npm start`). Dev-only
  tooling is TypeScript (type checking, never compiling), Playwright and
  `@types/node`. Runtime dependencies are allowed only to avoid rebuilding a
  mature subsystem (terminal emulation, PTY handling), and each one is named in
  this file. Adding any other runtime dependency, dev tool, or bundler is a
  decision for the owner, not a side effect of a feature.
- Types are JSDoc in the `.js` files, checked by `tsc` in strict mode. No `.ts`
  files, no `@ts-ignore`/`@ts-expect-error`; `any` only for untrusted input
  (parsed JSON, storage). A type lives in the module that owns the value and is
  shared with `/** @import { … } from '…' */`.
- `src/layout/` stays pure (no DOM, no globals beyond `crypto`): it is where the
  layout logic is unit-tested.
- New windows are widgets: one module in `src/widgets/` registered in
  `src/widgets/registry.js` (contract documented there).
- Every module opens with a `/** … */` comment whose first sentence says what it
  is for; the module map below is built from it.

## Working here

- Several agent sessions may share this checkout. Make changes in a worktree
  (`git worktree add ../agent-cockpit-<topic> -b <branch> main`), never by
  switching branches or stashing in the shared tree.
- Before committing, all of these must pass (CI in `.github/workflows/ci.yml`
  runs the same on every push to `main` and every PR):
  - `npm run typecheck`
  - `npm test`: node:test unit suites for the pure modules in `tests/`
  - `npm run test:e2e`: Playwright suites in `e2e/`, driving the real app in
    Chromium. First run on a machine needs `npx playwright install chromium`.
  - `npm run claude-md:check`
- A UI behaviour change comes with an e2e test that fails without it.

## Keeping this file current

The block below is generated from the code by `scripts/update-claude-md.js` and
refreshed automatically by the git pre-commit hook (`.githooks/`, enabled by
`npm install`) and by a Claude Code edit hook (`.claude/settings.json`). Do not
edit it by hand.

The sections above are hand-written. A change that alters what the app does,
its constraints, or how to work on it updates them **in the same commit**; in
particular, move a capability into "Current state" when it ships.

<!-- BEGIN GENERATED: scripts/update-claude-md.js — do not edit by hand -->

### Modules (`src/`)

- `src/app.js` — Cockpit controller: owns the layout atom and wires rendering, interaction and widgets together.
- `src/interaction/drag-controller.js` — Pointer-driven drag & drop for moving widgets and adding new ones.
- `src/interaction/sash-controller.js` — Sash (divider) resizing with magnetic detents.
- `src/layout/compute-layout.js` — Turns a split tree into absolute pixel rects for leaves and sashes.
- `src/layout/drop-zone.js` — Drop-zone hit testing.
- `src/layout/grid-model.js` — Split-tree layout model (same shape as VS Code's GridView).
- `src/layout/neighbors.js` — Geometric neighbour lookup for keyboard moves (Alt+Shift+Arrow).
- `src/layout/new-leaf.js` — Fresh leaf ids for widgets entering the tree.
- `src/layout/snap.js` — Magnetic sash behaviour: detents pull the sash onto aligned positions, then minimum sizes clamp the result.
- `src/main.js` — Bootstrap: starts the app and shows a visible error if it cannot.
- `src/render/drop-indicator.js` — Landing preview for drag & drop, plus the sash snap guide.
- `src/render/grid-renderer.js` — Imperative, diffed DOM writer for the grid.
- `src/state/atom.js` — Tiny Focal-style atom: get/set/subscribe plus `lens(key)` and `view(fn)`.
- `src/state/persistence.js` — Versioned, schema-validated layout storage in localStorage.
- `src/ui/dom.js` — Element construction helper.
- `src/ui/palette.js` — "Add widget" palette.
- `src/widgets/pane.js` — An empty window: the frame every real widget is mounted into, with nothing inside.
- `src/widgets/registry.js` — Widgets the palette can add, keyed by type.

### Registered widgets

- `pane` — Pane: An empty window

### npm scripts

- `npm run start` — `python3 -m http.server 5173`
- `npm run test` — `node --test "tests/**/*.test.js"`
- `npm run test:coverage` — `node --test --experimental-test-coverage "tests/**/*.test.js"`
- `npm run test:e2e` — `playwright test`
- `npm run typecheck` — `tsc -p .`
- `npm run claude-md` — `node scripts/update-claude-md.js`
- `npm run claude-md:check` — `node scripts/update-claude-md.js --check`
- `npm run prepare` — `git config core.hooksPath .githooks`

### Test suites

`tests/atom.test.js`, `tests/compute-layout.test.js`, `tests/drop-zone.test.js`, `tests/grid-model.test.js`, `tests/neighbors.test.js`, `tests/persistence.test.js`, `tests/snap.test.js`, `e2e/grid.spec.js`

<!-- END GENERATED -->
