#!/usr/bin/env node
/**
 * Daemon entry point (`npm start`): serves the workbench on loopback and runs the omp
 * processes it shows.
 *
 *   node daemon/main.js [--port 4777] [--omp <path to omp>]
 *
 * Environment: AGENT_COCKPIT_PORT, AGENT_COCKPIT_OMP, AGENT_COCKPIT_STATE_DIR (default
 * ~/.agent-cockpit; holds the access token and scratchpads/), AGENT_COCKPIT_OMP_SESSIONS (omp's session
 * journals; default `$PI_CODING_AGENT_DIR/sessions`, i.e. ~/.omp/agent/sessions).
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { createHistory } from './history.js';
import { createHub } from './hub.js';
import { createAttachments } from './attachments.js';
import { adoptLegacyScratchpad, createScratchpads } from './scratchpad.js';
import { createDaemonServer } from './server.js';
import { loadToken } from './token.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION_TIMEOUT_MS = 10_000;

/** @param {string} ompPath @returns {Promise<string | null>} */
async function ompVersion(ompPath) {
  try {
    const { stdout } = await promisify(execFile)(ompPath, ['--version'], { timeout: VERSION_TIMEOUT_MS });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

const { values } = parseArgs({ options: { port: { type: 'string' }, omp: { type: 'string' } } });
const port = Number(values.port ?? process.env.AGENT_COCKPIT_PORT ?? 4777);
const ompOption = values.omp ?? process.env.AGENT_COCKPIT_OMP ?? 'omp';
// A path (not a bare command name) must not depend on each session's cwd.
const ompPath = ompOption.includes('/') ? resolve(ompOption) : ompOption;
const stateDir = process.env.AGENT_COCKPIT_STATE_DIR ?? join(homedir(), '.agent-cockpit');
const ompSessions =
  process.env.AGENT_COCKPIT_OMP_SESSIONS ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.omp', 'agent'), 'sessions');

const token = await loadToken(stateDir);
const version = await ompVersion(ompPath);
const hub = createHub({ ompPath });
const scratchpadDir = join(stateDir, 'scratchpads');
await adoptLegacyScratchpad(join(stateDir, 'scratchpad.md'), scratchpadDir);
const server = createDaemonServer({
  hub,
  history: createHistory({ root: ompSessions }),
  scratchpads: createScratchpads({ dir: scratchpadDir }),
  attachments: createAttachments({ dir: join(stateDir, 'attachments') }),
  token,
  root: ROOT,
  // npm sets INIT_CWD to where `npm start` was typed: the likeliest project to work on.
  config: {
    defaultCwd: process.env.INIT_CWD ?? process.cwd(),
    home: homedir(),
    ompVersion: version,
    scratchpadDir,
  },
});

server.on('error', (/** @type {NodeJS.ErrnoException} */ err) => {
  console.error(
    err.code === 'EADDRINUSE' ? `[daemon] port ${port} is in use; pass --port <n>` : `[daemon] ${err.message}`,
  );
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Agent Cockpit daemon on http://127.0.0.1:${port}`);
  console.log(version ? `omp: ${version}` : `omp: not found at "${ompPath}" (sessions will fail to start)`);
  console.log(`Open: http://127.0.0.1:${port}/?token=${token}`);
});

let stopping = false;
async function shutdown() {
  if (stopping) return process.exit(1); // second Ctrl+C: stop waiting
  stopping = true;
  server.close();
  server.closeAllConnections();
  await hub.closeAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
