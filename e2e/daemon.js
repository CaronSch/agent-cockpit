/** Where the e2e daemon listens and keeps its token, shared by the Playwright config and the specs. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const E2E_PORT = 4173;
export const E2E_STATE_DIR = join(tmpdir(), 'cockpit-e2e');
/** Stands in for ~/.omp/agent/sessions; the Sessions spec writes its journals here. */
export const E2E_OMP_SESSIONS = join(tmpdir(), 'cockpit-e2e-omp-sessions');

/** The token the e2e daemon wrote on startup. */
export const e2eToken = () => readFileSync(join(E2E_STATE_DIR, 'token'), 'utf8').trim();

/**
 * A workspace no other test uses: the specs share one daemon and run in parallel, so each
 * test lays out its screens in a workspace of its own.
 */
export const newWorkspace = () => `e2e-${randomUUID().slice(0, 8)}`;

/**
 * The workbench in `workspace`, through the token link (which leaves `?workspace=` in place)
 * unless the page is to stay signed out.
 * @param {string} workspace @param {{ signIn?: boolean }} [options]
 */
export const workbenchPath = (workspace, { signIn = true } = {}) =>
  `/?${signIn ? `token=${e2eToken()}&` : ''}workspace=${workspace}`;

/** The file the daemon keeps `workspace` in. @param {string} workspace */
export const workspaceFile = (workspace) => join(E2E_STATE_DIR, 'workspaces', `${workspace}.json`);

/**
 * The layout the daemon keeps for a workspace that one window uses: its only screen's tree,
 * or null when it keeps none.
 * @param {import('@playwright/test').APIRequestContext} request @param {string} workspace @returns {Promise<any>}
 */
export async function savedLayout(request, workspace) {
  const { screens } = await (await request.get(`/api/workspaces/${workspace}`)).json();
  if (screens.length > 1) throw new Error(`workspace ${workspace} has ${screens.length} screens, not one`);
  return screens[0]?.tree ?? null;
}
