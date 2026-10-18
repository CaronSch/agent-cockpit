/** Bootstrap: starts the app and shows a visible error if it cannot. */
import { createApp } from './app.js';

try {
  createApp(document);
} catch (err) {
  console.error('[cockpit] failed to start', err);
  const message = document.createElement('p');
  message.className = 'boot-error';
  message.setAttribute('role', 'alert');
  message.textContent = 'Cockpit failed to start. See the browser console for details.';
  document.body.prepend(message);
}
