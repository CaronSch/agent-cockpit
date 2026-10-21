# Cockpit

**A modular, in-browser workbench for coding agents.**

Cockpit runs [omp](https://omp.sh) coding agents from a local daemon and
shows them in your browser. Everything is a window: chats, past sessions and
scratchpads are widgets you drag, split, stack and resize on a snapping grid,
as many as you like, side by side.

| Window | What it does |
| --- | --- |
| **omp** | Chat with an agent in a directory: streamed replies, tool calls, model and thinking level, slash commands, approvals and questions, steer or stop. Start a line with `!` to run it as a shell command in the session's directory, even while the agent works (the message box turns into a shell line). Comment on or **Ask** about selected reply text (with follow-up questions, kept out of the chat); paste screenshots or drop files to attach them. **Fork** continues a copy of the conversation in a new window, as a session of its own. **Config** → *Only prompts and responses* hides the work in between, per pane. |
| **Sessions** | Every past omp conversation, searchable and sortable. Drag one onto the grid (or press **Resume**) to continue it. |
| **Scratchpad** | Markdown notes with inline screenshots and files, stored in `~/.cockpit/scratchpads/`. |

A pane whose agent finished or asks something while you looked away gets a blue
border. When the workbench's files change under an open tab, the top bar offers
**Reload**.

**Screens.** Each browser window is a screen of your workspace, like an extra
monitor: open a second window and it starts empty, with its own panes. Layouts
are kept by the daemon (`~/.cockpit/workspaces/`), so they survive a browser
restart: windows opened again get their screens back, and a reload keeps the
window's screen. The switcher in the top bar (**Screen 2 of 3**) lists every
screen and what it holds; a screen open in no window can be opened in this one
(**Open here**, without stopping its agents) or deleted (its agents end). Add
`?workspace=<name>` to the address for a separate workspace (lowercase letters,
digits and dashes; the default is `main`). Windows at two different addresses at
once (say `127.0.0.1` and `localhost`) do not see which screens the other has
open.

## Install

You need two programs:

- **omp**, a standalone program installed on its own. It is **not** a
  dependency of this repo; the daemon runs the `omp` on your `PATH`.

  ```bash
  curl -fsSL https://omp.sh/install | sh   # or: brew install can1357/tap/omp
  ```

- **[Bun](https://bun.sh)** 1.3.14 or later, which runs the daemon and tests.

  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```

## Quick start

```bash
bun install   # dev tools and git hooks
bun start     # daemon on http://cockpit.localhost:4777
```

1. Open the URL `bun start` prints **once**. It carries an access token, which
   the browser keeps as a cookie. Cookies and browser storage belong to one
   address, so the first visit at a new one (say `cockpit.localhost` after
   `127.0.0.1`, which still works) needs that printed URL once more.
2. **＋ Widget → omp**, pick a directory, start chatting.
3. To connect a model provider (Anthropic/Claude, for example), press **Login**
   in the pane's toolbar (omp's `/login`).

The daemon listens on loopback only and refuses requests from other sites.

| Option | Default |
| --- | --- |
| `--port <n>` / `COCKPIT_PORT` | `4777` |
| `--omp <path>` / `COCKPIT_OMP` | `omp` on `PATH` |
| `COCKPIT_STATE_DIR` (token, scratchpads, attachments, workspaces) | `~/.cockpit` |
| `COCKPIT_OMP_SESSIONS` (omp's session files) | `~/.omp/agent/sessions` |

Pass flags through with `bun start --port 4800`, or run `bun daemon/main.js`
from another directory to make that the suggested working directory.

## Develop

```bash
bunx playwright install chromium   # once per machine
bun run typecheck                  # tsc over JSDoc types
bun run test                       # unit suites + daemon against a fake omp
bun run test:e2e                   # Playwright: real app and daemon in Chromium
bun run claude-md:check            # generated part of CLAUDE.md is current
```

No build step: the UI is plain ES modules. CI runs all four checks on every
push to `main` and every pull request.

- [`CLAUDE.md`](CLAUDE.md): architecture, conventions, how to add a widget.
- [`RISKS.md`](RISKS.md): deferred risks and when they bite.
