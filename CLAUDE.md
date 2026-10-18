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
- **Local daemon** (`daemon/`, Node): the only process that touches the machine.
  `npm start` runs it; it serves the UI on `127.0.0.1:4777` and launches each omp
  session as `omp --mode rpc-ui` in the chosen directory, owning those processes.
  The workbench is self-contained: it shows agents it launched and does not attach
  to sessions started in other terminals. Later it also samples process trees,
  proxies model calls and observes the filesystem.
- **Wire** (`daemon/wire.js`): a JSON API for commands and one Server-Sent Events
  stream per page carrying every session's events in order: each omp stdout frame
  verbatim, each frame the daemon wrote to omp, stderr lines, undecodable stdout
  (`garbled`) and session status changes. The browser replays it on load, so a
  window shows the same history whether it was open all along or not.
  `src/daemon/client.js` is the browser side; widgets never open their own
  connections.
- **Windows keep their own settings** in `leaf.params` (e.g. which session an
  omp pane shows), saved with the layout.
- **Telemetry provenance**: every recorded fact carries its source: `harness`
  (omp said so), `proxy` (seen on the wire), or `os` (seen by the kernel or the
  filesystem). The UI shows the source. The gap between what an agent claims it
  did and what the OS saw is the product, so never merge the two silently.
- **Local only, single user.** No auth beyond the loopback guard below.

## Current state

What runs today:

- The split-tree window grid: windows (widgets) are dragged, dropped, split and
  resized with magnetic snapping, and the layout persists in localStorage.
- The daemon and the `omp` pane: start omp in a directory, chat with it from its
  structured event stream (streamed replies, thinking, tool calls with output,
  `!` bash), pick model and thinking level, log in to providers, use slash
  commands, answer approval and `ask` dialogs, steer or stop a running turn, and
  resume the conversation after a daemon restart. Several panes can run side by
  side, each bound to its own session.
- The Sessions window: every past omp conversation (read from omp's session
  files), searchable across titles, directories and prompts, sortable, and
  draggable onto the grid to resume it in a new omp pane. Sessions already open
  in a pane are marked and cannot be opened twice.

Not built yet: saved-context pins, scratchpad, terminal panes, process view,
telemetry views, cmux-parity features beyond the above.

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

- The daemon binds `127.0.0.1` only, checks every request's `Host` (DNS
  rebinding), requires the token cookie on every API request, and refuses any
  foreign `Origin` or cross-site `Sec-Fetch-Site`. The token is random, stored
  owner-only in `~/.agent-cockpit/token`, and reaches the browser once through
  the URL the daemon prints (it becomes an HttpOnly, SameSite=Strict cookie).
  Without this, any web page open in the user's browser can reach the daemon and
  run commands on the machine. `tests/daemon.test.js` guards each check.
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
- Run it: `npm start`, then open the URL it prints once (it carries the token;
  the browser keeps a cookie afterwards). `--port`, `--omp <path>` and
  `AGENT_COCKPIT_STATE_DIR` override the defaults.
- Before committing, all of these must pass (CI in `.github/workflows/ci.yml`
  runs the same on every push to `main` and every PR):
  - `npm run typecheck`
  - `npm test`: node:test suites in `tests/`: the pure modules, plus the daemon
    end to end against `tests/fixtures/fake-omp.js`, a scripted stand-in for omp
  - `npm run test:e2e`: Playwright suites in `e2e/`, driving the real app and
    daemon (with the fake omp) in Chromium. First run on a machine needs
    `npx playwright install chromium`.
  - `npm run claude-md:check`
- A UI behaviour change comes with an e2e test that fails without it.
- When omp changes its protocol, re-record frames from the real omp (never
  commit them: they contain local tool and MCP names) and update the fake to
  match.

## Keeping this file current

The block below is generated from the code by `scripts/update-claude-md.js` and
refreshed automatically by the git pre-commit hook (`.githooks/`, enabled by
`npm install`) and by a Claude Code edit hook (`.claude/settings.json`). Do not
edit it by hand.

The sections above are hand-written. A change that alters what the app does,
its constraints, or how to work on it updates them **in the same commit**; in
particular, move a capability into "Current state" when it ships.

<!-- BEGIN GENERATED: scripts/update-claude-md.js — do not edit by hand -->

### Modules (`src/` browser, `daemon/` local daemon)

- `src/app.js` — Cockpit controller: owns the layout atom and wires rendering, interaction and widgets together.
- `src/daemon/client.js` — Browser side of the daemon connection: one event stream per page, shared by every widget.
- `src/interaction/drag-controller.js` — Pointer-driven drag & drop for moving widgets and adding new ones.
- `src/interaction/sash-controller.js` — Sash (divider) resizing with magnetic detents.
- `src/layout/compute-layout.js` — Turns a split tree into absolute pixel rects for leaves and sashes.
- `src/layout/drop-zone.js` — Drop-zone hit testing.
- `src/layout/grid-model.js` — Split-tree layout model (same shape as VS Code's GridView).
- `src/layout/neighbors.js` — Geometric neighbour lookup for keyboard moves (Alt+Shift+Arrow).
- `src/layout/new-leaf.js` — Fresh leaf ids for widgets entering the tree.
- `src/layout/snap.js` — Magnetic sash behaviour: detents pull the sash onto aligned positions, then minimum sizes clamp the result.
- `src/main.js` — Bootstrap: starts the app and shows a visible error if it cannot.
- `src/omp/dialogs-view.js` — Inline dialogs for omp's extension UI requests (select, confirm, input, editor, ask); each one answers through a single `respond(payload)` call.
- `src/omp/items-view.js` — DOM for one transcript item of the omp pane (messages, tool cards, shell runs, notes, unrecognised frames), built from text nodes only.
- `src/omp/markdown-dom.js` — Renders the safe markdown tree from `markdown.js` as DOM nodes (text nodes only, never HTML).
- `src/omp/markdown.js` — Safe markdown subset for agent text: parses into a small block/inline tree, never HTML.
- `src/omp/transcript.js` — Transcript reducer for one omp session: folds the daemon's SessionEvents into display items plus derived session state, with no DOM.
- `src/render/drop-indicator.js` — Landing preview for drag & drop, plus the sash snap guide.
- `src/render/grid-renderer.js` — Imperative, diffed DOM writer for the grid.
- `src/sessions/order.js` — Sorting and labels for the Sessions window, kept free of the DOM so they can be tested.
- `src/state/atom.js` — Tiny Focal-style atom: get/set/subscribe plus `lens(key)` and `view(fn)`.
- `src/state/persistence.js` — Versioned, schema-validated layout storage in localStorage.
- `src/ui/dom.js` — Element construction helper.
- `src/ui/palette.js` — "Add widget" palette.
- `src/widgets/omp.js` — The omp pane: starts an omp coding agent in a chosen directory through the daemon and lets the user chat with it and set it up, rendered from omp's structured event stream.
- `src/widgets/pane.js` — An empty window: the frame every real widget is mounted into, with nothing inside.
- `src/widgets/registry.js` — Widgets the palette can add, keyed by type.
- `src/widgets/sessions.js` — Past omp sessions, searchable and sortable: drag one onto the grid, or press Resume, to continue it in a new omp window.
- `daemon/frame-decoder.js` — Decodes omp's stdout: newline-delimited JSON frames, with protocol-v2 `rpc_chunk` sequences reassembled into the one frame they carry.
- `daemon/guard.js` — Loopback guard: decides which requests may reach the daemon (CLAUDE.md, Invariants).
- `daemon/history.js` — Past omp sessions, read from omp's session files: one summary per conversation, searchable by title, directory and what the user asked.
- `daemon/hub.js` — The daemon's omp sessions and the single ordered event log the browser replays.
- `daemon/main.js` — Daemon entry point (`npm start`): serves the workbench on loopback and runs the omp processes it shows.
- `daemon/omp-session.js` — One omp process in RPC mode: launch, protocol setup, command/response correlation and lifecycle, with everything it does reported as session events.
- `daemon/server.js` — HTTP face of the daemon: the workbench's static files, the JSON API and the event stream (routes in `wire.js`), all behind the loopback guard.
- `daemon/token.js` — The daemon's access token: random, created once, kept owner-only in the state directory so a browser stays signed in across daemon restarts.
- `daemon/wire.js` — Wire contract between the daemon and the browser: session metadata, stream events and HTTP payloads.

### Registered widgets

- `pane` — Pane: An empty window
- `omp` — omp: Chat with an omp coding agent
- `sessions` — Sessions: Past omp sessions: search, sort, drag one out to resume it

### npm scripts

- `npm run start` — `node daemon/main.js`
- `npm run test` — `node --test "tests/**/*.test.js"`
- `npm run test:coverage` — `node --test --experimental-test-coverage "tests/**/*.test.js"`
- `npm run test:e2e` — `playwright test`
- `npm run typecheck` — `tsc -p .`
- `npm run claude-md` — `node scripts/update-claude-md.js`
- `npm run claude-md:check` — `node scripts/update-claude-md.js --check`
- `npm run prepare` — `git config core.hooksPath .githooks`

### Test suites

`tests/atom.test.js`, `tests/compute-layout.test.js`, `tests/daemon-client.test.js`, `tests/daemon.test.js`, `tests/drop-zone.test.js`, `tests/frame-decoder.test.js`, `tests/grid-model.test.js`, `tests/history.test.js`, `tests/markdown.test.js`, `tests/neighbors.test.js`, `tests/omp-transcript.test.js`, `tests/persistence.test.js`, `tests/sessions-order.test.js`, `tests/snap.test.js`, `e2e/grid.spec.js`, `e2e/omp.spec.js`, `e2e/sessions.spec.js`

<!-- END GENERATED -->
