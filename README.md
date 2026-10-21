# Cockpit

**A modular, in-browser workbench for coding agents.**

Cockpit runs [omp](https://omp.sh) coding agents from a local daemon and
shows them in your browser. Everything is a window: chats, past sessions and
scratchpads are widgets you drag, split, stack and resize on a snapping grid,
as many as you like, side by side.

| Window | What it does |
| --- | --- |
| **omp** | Chat with an agent in a directory: streamed replies, tool calls, model and thinking level, slash commands, approvals and questions, steer or stop. The window's top bar shows the conversation's title (its first prompt until you name it with `/rename`), and the toolbar how far the agent is through its todo list while it works. **Up** / **Down** in an empty message box recall earlier prompts, as in a shell. Start a line with `!` to run it as a shell command in the session's directory, even while the agent works (the message box turns into a shell line). Comment on or **Ask** about selected reply text (short answers, with follow-up questions, kept out of the chat); paste screenshots or drop files to attach them, or type `@` to mention files from the session's directory (`@src/`, `@../`, `@~/`; Tab completes). Copy a reply's table as Markdown, CSV or an image (**Copy**, on hover). **Fork** continues a copy of the conversation in a new window, as a session of its own; drag **Send** onto the grid to send the message in such a fork instead, placed where you drop it. **Config** → *Only prompts and responses* hides the work in between, per pane. |
| **Sessions** | Every past omp conversation, searchable, sortable and narrowed to one directory if wanted. Drag one (or its **Resume** button) onto the grid to continue it there, or press **Resume** to open it beside the list. **Archive** moves one out of omp's sessions into `~/.cockpit/archive/` (omp's own resume no longer offers it); **Archived** lists those, and **Restore** puts one back. |
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
2. **＋ Widget → omp**, pick a directory (folders are suggested as you type, from
   your home folder; Tab completes), start chatting.
3. To connect a model provider (Anthropic/Claude, for example), press **Login**
   in the pane's toolbar (omp's `/login`).

The daemon listens on loopback only and refuses requests from other sites.

| Option | Default |
| --- | --- |
| `--port <n>` / `COCKPIT_PORT` | `4777` |
| `--omp <path>` / `COCKPIT_OMP` | `omp` on `PATH` |
| `--cwd <dir>` / `COCKPIT_CWD` (the directory a new omp window suggests) | your home directory |
| `COCKPIT_STATE_DIR` (token, scratchpads, attachments, workspaces) | `~/.cockpit` |
| `COCKPIT_OMP_SESSIONS` (omp's session files) | `~/.omp/agent/sessions` |

Pass flags through with `bun start --port 4800 --cwd ~/code/app`.

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
