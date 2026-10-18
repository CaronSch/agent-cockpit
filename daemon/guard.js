/**
 * Loopback guard: decides which requests may reach the daemon (CLAUDE.md, Invariants).
 *
 * - Host must name the daemon on loopback, so a DNS-rebinding page cannot pose as it.
 * - API requests must carry the token cookie. It is SameSite=Strict, so the browser never
 *   attaches it to a request started by another site.
 * - A request with a foreign Origin (or a cross-site Sec-Fetch-Site) is refused even with
 *   the cookie, and state-changing requests must state their Origin.
 */
import { timingSafeEqual } from 'node:crypto';

export const TOKEN_COOKIE = 'ac_token';

/** @typedef {{ ok: true } | { ok: false, status: number, error: string }} Verdict */
/** @typedef {Record<string, string | string[] | undefined>} Headers */

/** @param {number} port */
export const ownOrigins = (port) => [`http://127.0.0.1:${port}`, `http://localhost:${port}`];

/** @param {string | undefined} host @param {number} port */
export const isAllowedHost = (host, port) => host === `127.0.0.1:${port}` || host === `localhost:${port}`;

/** @param {string | undefined} header @returns {Map<string, string>} */
export function parseCookies(header) {
  const cookies = new Map();
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return cookies;
}

/** Constant-time comparison. @param {string | undefined} given @param {string} token */
export function tokensMatch(given, token) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** @param {number} status @param {string} error @returns {Verdict} */
const deny = (status, error) => ({ ok: false, status, error });

/** @param {Headers} headers @param {string} name */
const single = (headers, name) => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * @param {{ method: string, headers: Headers, port: number, token: string }} request
 * @returns {Verdict}
 */
export function checkApiRequest({ method, headers, port, token }) {
  if (!isAllowedHost(single(headers, 'host'), port)) return deny(403, 'unexpected Host header');
  const origin = single(headers, 'origin');
  if (origin !== undefined && !ownOrigins(port).includes(origin)) return deny(403, 'cross-origin request refused');
  const site = single(headers, 'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return deny(403, 'cross-site request refused');
  if (method !== 'GET' && method !== 'HEAD' && origin === undefined) return deny(403, 'missing Origin header');
  if (!tokensMatch(parseCookies(single(headers, 'cookie')).get(TOKEN_COOKIE), token)) {
    return deny(401, 'not authenticated: open the URL the daemon printed');
  }
  return { ok: true };
}
