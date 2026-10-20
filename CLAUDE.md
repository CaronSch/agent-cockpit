# Cockpit

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
- **Scratchpads**: free-form notes with screenshots next to the agents, any
  number of them, each openable in several windows.
- **Terminal panes**: a real shell (and omp's own TUI, if wanted).
- **Process view**: the processes each agent runs, and their CPU, memory and I/O.
- **Telemetry**: every model call, tool call, process and file-system access,
  including reads and data sent to model providers.

## Architecture

- **Browser UI** (`src/`): the window grid and the widgets. No build step.
- **Local daemon** (`daemon/`, Bun): the only process that touches the machine.
  `bun start` runs it; it serves the UI on `127.0.0.1:4777` (`Bun.serve`) and
  launches each omp session as `omp --mode rpc-ui` in the chosen directory
  (`Bun.spawn`), owning those processes. omp is the `omp` on PATH unless `--omp`
  says otherwise. Prefer Bun's own APIs where they make the code smaller.
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
  omp pane shows), saved with the layout. **User data lives with the daemon**,
  not in the layout: anything that must outlive a window, a browser profile or
  a port change (the scratchpad's notes) is a file in the state directory
  (`~/.cockpit`). Closing a window must never delete it.
- **Telemetry provenance**: every recorded fact carries its source: `harness`
  (omp said so), `proxy` (seen on the wire), or `os` (seen by the kernel or the
  filesystem). The UI shows the source. The gap between what an agent claims it
  did and what the OS saw is the product, so never merge the two silently.
- **Local only, single user.** No auth beyond the loopback guard below.

## Current state

What runs today:

- The split-tree window grid: windows (widgets) are dragged, dropped, split and
  resized with magnetic snapping, and the layout persists in localStorage. A tab
  running older UI code than the daemon serves says so in the top bar and offers
  Reload (the files' version: `daemon/ui-files.js`).
- The daemon and the `omp` pane: start omp in a directory, chat with it from its
  structured event stream (streamed replies with Markdown and tables, thinking,
  tool calls with output, `!` bash), pick model and thinking level, log in to
  providers, use slash commands, answer approval and `ask` dialogs, steer or stop
  a running turn, and resume the conversation after a daemon restart. Several
  panes can run side by side, each bound to its own session. The message box
  grows with the prompt; selected reply text can be commented on (the comment goes
  quoted with the next prompt) or asked about (omp's `btw` answers in the popup,
  outside the chat); long pastes become editable cards and pasted or dropped
  files are stored in `~/.cockpit/attachments/` and sent as omp `@"<path>"`
  mentions. A pane whose agent finished its turn (or asks something) while its
  user was not looking gets an electric-blue border until it is hovered,
  scrolled, clicked or typed in.
- The Sessions window: every past omp conversation (read from omp's session
  files), searchable across titles, directories and prompts, sortable, and
  draggable onto the grid to resume it in a new omp pane. Sessions already open
  in a pane are marked and cannot be opened twice. Sessions the daemon runs get a
  summarising title: after a turn settles in an unnamed session it sends omp
  `/rename`, which RPC mode otherwise never does by itself.
- Scratchpad windows: each new window starts its own pad; a switcher reopens or
  deletes any pad, and two windows (or tabs) on one pad stay in sync. Pads are
  Markdown files in `~/.cockpit/scratchpads/`; pasted or dropped
  screenshots and files are stored beside them and shown inline. An edit made
  elsewhere (the file itself, another tab) is never overwritten without asking.

Not built yet: saved-context pins, terminal panes, process view,
telemetry views, cmux-parity features beyond the above.

## How we decide

- **Simple beats clever**, except where the workbench needs it: structured panes
  and the rich, modular workbench are not to be simplified away.
- **Clean and minimal, never hacky.** Write the least code that does the job
  properly, and delete what nothing uses. No workarounds, special cases or
  shortcuts that hide a problem instead of fixing it: if the clean fix is out of
  reach, stop and tell the owner.
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
  owner-only in `~/.cockpit/token`, and reaches the browser once through
  the URL the daemon prints (it becomes an HttpOnly, SameSite=Strict cookie).
  Without this, any web page open in the user's browser can reach the daemon and
  run commands on the machine. `tests/daemon.test.js` guards each check.
- Every agent the workbench shows was launched by the daemon.
- An omp event or message kind the adapter does not know is shown as an
  unrecognised entry, never dropped. Telemetry that silently loses events lies.

## Constraints

- The daemon, tests and scripts run on Bun (1.3.14+, omp's own minimum); the
  browser UI is plain ES modules with no build step (`bun start`). Dev-only
  tooling is TypeScript (type checking, never compiling), Playwright and
  `@types/bun`. Runtime dependencies are allowed only to avoid rebuilding a
  mature subsystem (terminal emulation, PTY handling), and each one is named in
  this file. Adding any other runtime dependency, dev tool, or bundler is a
  decision for the owner, not a side effect of a feature.
- omp is not a dependency: the user installs it on its own (https://omp.sh) and
  the daemon runs the `omp` on PATH. The version the fake omp in `tests/` was
  recorded from is in `RISKS.md`; a newer installed omp means re-recording frames.
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
  (`git worktree add ../cockpit-<topic> -b <branch> main`), never by
  switching branches or stashing in the shared tree.
- Run it: `bun install`, then `bun start`, then open the URL it prints once (it
  carries the token; the browser keeps a cookie afterwards). `--port`,
  `--omp <path>` (or `COCKPIT_OMP`) and `COCKPIT_STATE_DIR` override
  the defaults.
- Before committing, all of these must pass (CI in `.github/workflows/ci.yml`
  runs the same on every push to `main` and every PR):
  - `bun run typecheck`
  - `bun run test`: `bun test` suites in `tests/`: the pure modules, plus the
    daemon end to end against `tests/fixtures/fake-omp.js`, a scripted stand-in
    for omp (plain `bun test` would also pick up `e2e/*.spec.js`)
  - `bun run test:e2e`: Playwright suites in `e2e/`, driving the real app and
    daemon (with the fake omp) in Chromium. First run on a machine needs
    `bunx playwright install chromium`.
  - `bun run claude-md:check`
- A UI behaviour change comes with an e2e test that fails without it.
- When omp changes its protocol, re-record frames from the real omp (never
  commit them: they contain local tool and MCP names) and update the fake to
  match.

## Commits & PRs

Every commit message and PR title is a [Conventional
Commit](https://gist.github.com/qoomon/5dfcdf8eec66a051ecd85625518cfd13); the
`commit-msg` hook in `.githooks/` rejects any other.

```
<type>(<optional scope>): <description>

<optional body>

<optional footer>
```

| Type | Use for |
|---|---|
| `feat` | adds, adjusts or removes a feature |
| `fix` | resolves a bug in a preceding feature commit |
| `refactor` | rewrites code without altering behavior |
| `perf` | refactor specifically targeting performance |
| `style` | formatting/whitespace only, no behavior change |
| `test` | adds or corrects tests |
| `docs` | documentation only |
| `build` | build tools, dependencies, versioning |
| `ops` | infrastructure, deployment, CI/CD, monitoring, backups |
| `chore` | maintenance: initial commit, `.gitignore`, housekeeping |

- **Description** (mandatory): imperative mood ("add", not "added"/"adds"),
  lowercase first letter, no trailing period, concise.
- **Scope** (optional): the area touched (`omp`, `daemon`, `scratchpad`, `ui`, …).
  Never an issue identifier.
- **Body** (optional): motivation, and how the behavior differs from before.
- **Footer** (optional): issue references (`Closes #123`) and breaking changes.
- **Breaking changes**: `!` before the colon, plus a `BREAKING CHANGE:` footer
  if it needs explaining.
- Merge and revert commits keep git's default message.

```
feat(omp): ask about selected reply text
fix(scratchpad): keep pasted images when the pad is renamed
refactor!: drop the Node daemon

BREAKING CHANGE: install Bun to run the daemon.
```

## Keeping this file current

The block below is generated from the code by `scripts/update-claude-md.js` and
refreshed automatically by the git pre-commit hook (`.githooks/`, enabled by
`bun install`) and by a Claude Code edit hook (`.claude/settings.json`). Do not
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
- `src/layout/snap.js` — Magnetic sash behaviour: detents pull the sash onto aligned positions, then minimum sizes clamp the result.
- `src/main.js` — Bootstrap: starts the app and shows a visible error if it cannot.
- `src/omp/activity.js` — Which omp events turn an omp window "unread": the agent's final response, when it hands the turn back to the user, or a question it stops to ask them.
- `src/omp/composer.js` — The omp pane's message box: a draft that grows with its text up to half the pane, cards for what goes with the next message (comments on quoted transcript text, pasted text, files), and the Send button.
- `src/omp/dialogs-view.js` — Inline dialogs for omp's extension UI requests (select, confirm, input, editor, ask); each one answers through a single `respond(payload)` call.
- `src/omp/items-view.js` — DOM for one transcript item of the omp pane (messages, tool cards, shell runs, notes, unrecognised frames), built from text nodes only.
- `src/omp/markdown-dom.js` — Renders the safe markdown tree from `markdown.js` as DOM nodes (text nodes only, never HTML).
- `src/omp/markdown.js` — Safe markdown subset for agent text: parses into a small block/inline tree, never HTML.
- `src/omp/message.js` — Builds what the omp pane sends from what the user wrote: the prompt (comments on quoted parts of earlier replies, the draft, then attachments) and side questions about a quote.
- `src/omp/selection-popup.js` — Actions on highlighted transcript text: select part of a reply and Comment and Ask buttons appear at the end of the selection.
- `src/omp/transcript.js` — Transcript reducer for one omp session: folds the daemon's SessionEvents into display items plus derived session state, with no DOM.
- `src/render/drop-indicator.js` — Landing preview for drag & drop, plus the sash snap guide.
- `src/render/grid-renderer.js` — Imperative, diffed DOM writer for the grid.
- `src/scratchpad/blocks.js` — A scratchpad's text as blocks to edit: runs of text, and the images and files it references, kept free of the DOM so the round trip can be tested.
- `src/scratchpad/store.js` — The page's copy of one scratchpad: every window in the page showing that pad edits this one object, so they agree as you type; it saves to the daemon after a pause and follows what other pages save.
- `src/sessions/order.js` — Sorting and labels for the Sessions window, kept free of the DOM so they can be tested.
- `src/state/atom.js` — Tiny observable cell: get/set/subscribe.
- `src/state/persistence.js` — Versioned, schema-validated layout storage in localStorage.
- `src/ui/autosize.js` — Grows a textarea to fit its text, up to a maximum height, after which it scrolls.
- `src/ui/dom.js` — Element construction helpers: elements, buttons that never submit a form, and file-drag checks.
- `src/ui/format.js` — Text formatters shared across the UI: error messages, home-relative paths and JSON dumps, with no DOM.
- `src/ui/palette.js` — "Add widget" palette.
- `src/ui/update-notice.js` — The "updated, reload" notice in the top bar: shown while the daemon serves other UI files than this page loaded (see daemon/ui-files.js), so a tab left open never runs stale code unknowingly.
- `src/widgets/omp.js` — The omp pane: starts an omp coding agent in a chosen directory through the daemon and lets the user chat with it and set it up, rendered from omp's structured event stream.
- `src/widgets/pane.js` — An empty window: the frame every real widget is mounted into, with nothing inside.
- `src/widgets/registry.js` — Widgets the palette can add, keyed by type.
- `src/widgets/scratchpad.js` — Notes beside the agents: text with screenshots and files in it.
- `src/widgets/sessions.js` — Past omp sessions, searchable and sortable: drag one onto the grid, or press Resume, to continue it in a new omp window.
- `daemon/attachments.js` — Files attached to omp prompts: stored where omp can read them, one folder per day, so a prompt can mention them as `@"<path>"` and omp attaches them itself (images to the model, text inlined; see omp's file mentions).
- `daemon/frame-decoder.js` — Decodes omp's stdout: newline-delimited JSON frames, with protocol-v2 `rpc_chunk` sequences reassembled into the one frame they carry.
- `daemon/guard.js` — Loopback guard: decides which requests may reach the daemon (CLAUDE.md, Invariants).
- `daemon/history.js` — Past omp sessions, read from omp's session files: one summary per conversation, searchable by title, directory and what the user asked.
- `daemon/hub.js` — The daemon's omp sessions and the single ordered event log the browser replays.
- `daemon/main.js` — Daemon entry point (`bun start`): serves the workbench on loopback and runs the omp processes it shows.
- `daemon/omp-session.js` — One omp process in RPC mode: launch, protocol setup, command/response correlation and lifecycle, with everything it does reported as session events.
- `daemon/scratchpad.js` — Scratchpads: plain Markdown files the daemon keeps, one per pad, with pasted screenshots and files stored beside them.
- `daemon/server.js` — HTTP face of the daemon: the workbench's static files, the JSON API and the event stream (routes in `wire.js`), all behind the loopback guard.
- `daemon/token.js` — The daemon's access token: random, created once, kept owner-only in the state directory so a browser stays signed in across daemon restarts.
- `daemon/ui-files.js` — The files that make up the browser UI: which ones the daemon serves, and a version that changes whenever any of them does, so an open page can tell it is running older code.
- `daemon/wire.js` — Wire contract between the daemon and the browser: session metadata, stream events and HTTP payloads.

### Registered widgets

- `pane` — Pane: An empty window
- `omp` — omp: Chat with an omp coding agent
- `sessions` — Sessions: Past omp sessions: search, sort, drag one out to resume it
- `scratchpad` — Scratchpad: Notes with screenshots and files; each new window starts its own pad

### Scripts

- `bun run start` — `bun daemon/main.js`
- `bun run test` — `bun test`
- `bun run test:coverage` — `bun test --coverage`
- `bun run test:e2e` — `playwright test`
- `bun run typecheck` — `tsc -p .`
- `bun run claude-md` — `bun scripts/update-claude-md.js`
- `bun run claude-md:check` — `bun scripts/update-claude-md.js --check`
- `bun run prepare` — `git config core.hooksPath .githooks`

### Test suites

`tests/atom.test.js`, `tests/compute-layout.test.js`, `tests/daemon-client.test.js`, `tests/daemon.test.js`, `tests/drop-zone.test.js`, `tests/frame-decoder.test.js`, `tests/grid-model.test.js`, `tests/history.test.js`, `tests/markdown.test.js`, `tests/neighbors.test.js`, `tests/omp-activity.test.js`, `tests/omp-message.test.js`, `tests/omp-transcript.test.js`, `tests/persistence.test.js`, `tests/scratchpad-blocks.test.js`, `tests/scratchpad-store.test.js`, `tests/scratchpad.test.js`, `tests/sessions-order.test.js`, `tests/snap.test.js`, `tests/ui-files.test.js`, `e2e/grid.spec.js`, `e2e/omp.spec.js`, `e2e/scratchpad.spec.js`, `e2e/sessions.spec.js`, `e2e/update-notice.spec.js`

<!-- END GENERATED -->
