#!/usr/bin/env bun
/**
 * Daemon entry point (`bun start`): serves the workbench on loopback and runs the omp
 * processes it shows.
 *
 *   bun daemon/main.js [--port 4777] [--omp <path to omp>] [--cwd <dir>]
 *
 * omp defaults to the `omp` on PATH (install it from https://omp.sh). `--cwd` is the
 * directory a new omp window suggests, the home directory unless given.
 * Environment: COCKPIT_PORT, COCKPIT_OMP, COCKPIT_CWD, COCKPIT_STATE_DIR (default ~/.cockpit; holds the
 * access token, unread.json (which conversations have news not read yet), scratchpads/,
 * attachments/, workspaces/ and archive/sessions/, the archived omp sessions), COCKPIT_OMP_SESSIONS (omp's session journals; default
 * `$PI_CODING_AGENT_DIR/sessions`, i.e. ~/.omp/agent/sessions).
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHistory } from './history.js';
import { createHub } from './hub.js';
import { createAttachments } from './attachments.js';
import { createScratchpads } from './scratchpad.js';
import { createDaemonServer } from './server.js';
import { createWorkspaces } from './workspace.js';
import { loadToken } from './token.js';
import { loadUnread } from './unread.js';

const ROOT = resolve(import.meta.dir, '..');
const VERSION_TIMEOUT_MS = 10_000;

/** @param {string} ompPath @returns {Promise<string | null>} */
async function ompVersion(ompPath) {
  try {
    const proc = Bun.spawn([ompPath, '--version'], { stderr: 'ignore', timeout: VERSION_TIMEOUT_MS });
    return (await new Response(proc.stdout).text()).trim() || null;
  } catch {
    return null;
  }
}

const { values } = parseArgs({ options: { port: { type: 'string' }, omp: { type: 'string' }, cwd: { type: 'string' } } });
const port = Number(values.port ?? process.env.COCKPIT_PORT ?? 4777);
const ompOption = values.omp ?? process.env.COCKPIT_OMP ?? 'omp';
// A path (not a bare command name) must not depend on each session's cwd.
const ompPath = ompOption.includes('/') ? resolve(ompOption) : ompOption;
const defaultCwd = resolve(values.cwd ?? process.env.COCKPIT_CWD ?? homedir());
const stateDir = process.env.COCKPIT_STATE_DIR ?? join(homedir(), '.cockpit');
const ompSessions =
  process.env.COCKPIT_OMP_SESSIONS ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.omp', 'agent'), 'sessions');

const token = await loadToken(stateDir);
const unread = await loadUnread({ file: join(stateDir, 'unread.json') }).catch((err) => {
  console.error(`[daemon] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
const hub = createHub({ ompPath, unread });
const scratchpadDir = join(stateDir, 'scratchpads');
/** @type {ReturnType<typeof createDaemonServer>} */
let server;
try {
  server = createDaemonServer({
    hub,
    history: createHistory({ root: ompSessions, archive: join(stateDir, 'archive', 'sessions') }),
    scratchpads: createScratchpads({ dir: scratchpadDir }),
    attachments: createAttachments({ dir: join(stateDir, 'attachments') }),
    workspaces: createWorkspaces({ dir: join(stateDir, 'workspaces') }),
    unread,
    token,
    root: ROOT,
    port,
    config: {
      defaultCwd,
      home: homedir(),
      scratchpadDir,
    },
  });
} catch (err) {
  const code = /** @type {{ code?: string }} */ (err).code;
  console.error(code === 'EADDRINUSE' ? `[daemon] port ${port} is in use; pass --port <n>` : `[daemon] ${err}`);
  process.exit(1);
}

console.log(`Cockpit daemon on http://127.0.0.1:${port}`);
console.log(`Open: http://cockpit.localhost:${port}/?token=${token}`);
// Asked after the server is up: starting omp just to read its version takes most of a second.
ompVersion(ompPath).then((version) =>
  console.log(version ? `omp: ${version}` : `omp: not found at "${ompPath}" (sessions will fail to start)`),
);

let stopping = false;
async function shutdown() {
  if (stopping) return process.exit(1); // second Ctrl+C: stop waiting
  stopping = true;
  void server.stop(true);
  await hub.closeAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
