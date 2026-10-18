/** Where the e2e daemon listens and keeps its token, shared by the Playwright config and the specs. */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const E2E_PORT = 4173;
export const E2E_STATE_DIR = join(tmpdir(), 'agent-cockpit-e2e');

/** The token the e2e daemon wrote on startup. */
export const e2eToken = () => readFileSync(join(E2E_STATE_DIR, 'token'), 'utf8').trim();
