/**
 * The "updated, reload" notice in the top bar: shown while the daemon serves other UI files
 * than this page loaded (see daemon/ui-files.js), so a tab left open never runs stale code
 * unknowingly. It never reloads by itself: a reload would drop an unsent draft.
 */
import { el } from './dom.js';
/** @import { DaemonClient } from '../daemon/client.js' */

/** @param {{ daemon: DaemonClient, reload?: () => void }} options */
export function createUpdateNotice({ daemon, reload = () => location.reload() }) {
  const root = el('div', 'update-notice');
  root.setAttribute('role', 'status');
  root.hidden = true;
  const reloadBtn = el('button', 'btn btn-accent', 'Reload');
  reloadBtn.type = 'button';
  reloadBtn.addEventListener('click', () => reload());
  const dismiss = el('button', 'update-notice-dismiss', '×');
  dismiss.type = 'button';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.title = 'Hide until the next update';
  dismiss.addEventListener('click', () => {
    root.hidden = true;
  });
  root.append(el('span', 'update-notice-text', 'Cockpit was updated. Reload to use the new version.'), reloadBtn, dismiss);

  // A daemon restart reports its files on reconnect; a `git pull` under a running daemon
  // changes them silently, so ask again whenever the user comes back to the tab (while
  // connected: a page without the token, or with the daemon down, has no one to ask).
  const offChange = daemon.onUiChange((outdated) => {
    root.hidden = !outdated;
  });
  const check = () => {
    if (document.visibilityState === 'visible' && daemon.status() === 'open') void daemon.checkUi();
  };
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', check);

  return {
    root,
    destroy() {
      offChange();
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
      root.remove();
    },
  };
}
