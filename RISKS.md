# Deferred risks

Risks that do not bite at the current stage, filed under the threshold at which
they do. Policy is in `CLAUDE.md` ("How we decide"). In short: every session reads
this file and decides, from the repo as it is, whether any threshold has been
crossed. A crossed threshold is raised with the owner before other work. A fixed
risk is deleted from this file.

Each entry gives: what goes wrong, and the planned response once the threshold is reached.

## When a telemetry feature is built

- **Model-call proxy misses some traffic.** The "data sent to providers" view
  works by pointing omp's provider base URLs at the daemon's proxy. Providers
  that cannot be redirected that way (OAuth/subscription logins, hard-coded
  endpoints) would bypass it, and the view would show less than was sent.
  *Response:* check each provider omp is configured with; try `omp
  auth-gateway` (an HTTP forward proxy) as the single choke point; label a
  provider that is not covered as uncovered in the UI instead of showing it empty.
- **File-read tracking needs root.** Reads are invisible to FSEvents. On macOS
  they need `eslogger` (root plus Full Disk Access); on Linux, eBPF or fanotify.
  *Response:* a separate, minimal, opt-in helper that only streams events to the
  daemon. The daemon itself never runs as root. Read views say when the helper
  is off.
- **The telemetry store grows without bound.** Prompts, responses and file
  events add up quickly. The first such store already exists: the daemon keeps
  every event since it started in memory and each page load replays all of it.
  *Threshold detail:* the daemon passes 1 GB resident, or a page takes visibly
  long to load its history. *Response:* retention by age and size, set by the
  user; replay only what open windows need.

## When the daemon restarts start costing work

- **A daemon restart interrupts running agents.** omp runs as a child of the
  daemon, so a restart ends every session. An omp pane can resume the
  conversation (`omp --resume`), but a turn that was running is lost.
  *Response:* relaunch with `omp --restore <session.jsonl>`, which also resumes
  the interrupted turn and its subagents; supervise outside the daemon only if
  that is not enough.

## When omp is upgraded past 18.10.3

- **The fake omp drifts from the real one.** `tests/fixtures/fake-omp.js`
  copies frame shapes recorded from omp 18.10.3; tests stay green while a newer
  omp sends something else. *Threshold detail:* `omp --version` (also printed
  at daemon start) is newer than 18.10.3. *Response:* re-record a session with
  the real omp, diff its frame and message types against the fake, update the
  fake and this version number.

- **The Sessions window reads omp's private journal format.** `daemon/history.js`
  parses `~/.omp/agent/sessions/<project>/*.jsonl` directly (the `title` and
  `session` records, user messages and their `attribution`); omp has no rpc for
  listing past sessions. A format change shows up as sessions with no title,
  no directory, or missing from the list. *Response:* compare a fresh journal
  with `tests/history.test.js`'s fixtures and update both.

## When the session history reaches thousands of journals

- **Listing past sessions gets slow.** The first listing after a daemon start
  reads every journal in full (28 journals, 66 MB: about 160 ms); later ones
  re-read only files whose size or mtime changed. *Threshold detail:* the first
  Sessions listing takes over a second. *Response:* read only each file's head
  and a bounded tail, or persist the summaries across restarts.

## When building the browser pane or chasing shortcut parity

- **A browser tab cannot fully match cmux.** Most external sites refuse to be
  framed (`X-Frame-Options`/CSP), so a browser pane only shows local dev servers
  reliably. A page also cannot capture browser-reserved shortcuts (⌘W, ⌘T, ⌘N).
  *Response:* wrap the same UI in Tauri; the daemon becomes its sidecar and the
  webview gets a native browser surface. Until then, limit the browser pane to
  localhost.
- **Some omp features may be TUI-only.** Anything omp does not expose over rpc
  is a parity gap for structured panes. *Response:* list the gaps; the terminal
  pane running omp's own TUI covers them until omp's rpc catches up.

## When a second harness is added

- **The adapter is shaped around omp.** If omp's rpc vocabulary leaks into the
  UI, a second harness means rewriting widgets. *Response:* define the daemon's
  own event vocabulary from what omp and the new harness have in common; make
  omp an adapter onto it. Do not abstract before the second harness exists.

## When the daemon is reachable from anything but loopback (LAN, remote, team)

- **No real auth.** The loopback guard (token plus Origin check) assumes one user
  on one machine. *Response:* real authentication, TLS, and per-user isolation of
  sessions and telemetry.
- **The telemetry store holds secrets.** Prompts, file contents, env values and
  tool output are stored in plain text, with the same trust as omp's own
  `~/.omp` session files. *Response:* redaction before storage or display to
  others, and encryption at rest.

## When telemetry can leave the machine (export, share, sync, OTLP)

- **Exported telemetry leaks secrets.** Same data as above, now off-machine.
  *Response:* redact on export by default, and preview before sharing.

## When announcing publicly, or publishing a package

- **Name collisions.** "Cockpit" is Red Hat's Linux admin UI, and the npm names
  may be taken. *Response:* check npm, GitHub and trademark conflicts for
  "agent-cockpit"; rename before announcing, not after.
- **macOS only.** Process sampling and file tracing are written for macOS first.
  *Response:* state supported platforms in the README; add Linux backends when
  someone needs them.
- **Outside contributions.** No contribution guide, no security policy.
  *Response:* add CONTRIBUTING and SECURITY (how to report daemon issues) before
  inviting contributors.
