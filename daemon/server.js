/**
 * HTTP face of the daemon: the workbench's static files, the JSON API and the event stream
 * (routes in `wire.js`), all behind the loopback guard.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { TOKEN_COOKIE, checkApiRequest, isAllowedHost, tokensMatch } from './guard.js';
import { SessionNotRunning } from './omp-session.js';
import { PAD_ID } from './scratchpad.js';
/** @import { IncomingMessage, ServerResponse } from 'node:http' */
/** @import { AddressInfo } from 'node:net' */
/** @import { DaemonConfig, Scratchpad, SessionEvent } from './wire.js' */
/** @import { Hub } from './hub.js' */
/** @typedef {ReturnType<typeof import('./history.js').createHistory>} History */
/** @typedef {ReturnType<typeof import('./scratchpad.js').createScratchpads>} Scratchpads */
/** @typedef {ReturnType<typeof import('./attachments.js').createAttachments>} Attachments */

const STATIC_DIRS = ['src', 'styles'];
const CONTENT_TYPES = /** @type {Record<string, string>} */ ({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
});
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;
const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;
const BASE_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
};
/**
 * Uploaded files are served from the workbench's own origin, so they must never run: no
 * sniffing, a sandbox for anything opened as a page, and only raster images shown inline.
 * Their names are unique, so they can be cached for good.
 */
const ASSET_HEADERS = {
  ...BASE_HEADERS,
  'cache-control': 'private, max-age=31536000, immutable',
  'content-security-policy': "sandbox; default-src 'none'; img-src 'self'; frame-ancestors 'none'",
};

class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** @param {ServerResponse} res @param {number} status @param {unknown} body */
function sendJson(res, status, body) {
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** @param {ServerResponse} res @param {number} status @param {string} text */
function sendText(res, status, text) {
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/** @param {IncomingMessage} req @param {number} limit @returns {Promise<Buffer>} */
async function readBody(req, limit) {
  if (Number(req.headers['content-length'] ?? 0) > limit) throw new HttpError(413, 'request body too large');
  /** @type {Buffer[]} */
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw new HttpError(413, 'request body too large');
    parts.push(part);
  }
  return Buffer.concat(parts);
}

/** @param {IncomingMessage} req @returns {Promise<any>} parsed untrusted JSON */
async function readJson(req) {
  const body = await readBody(req, MAX_BODY_BYTES);
  try {
    return JSON.parse(body.toString('utf8') || 'null');
  } catch {
    throw new HttpError(400, 'request body is not JSON');
  }
}

/** @param {string} input */
const expandHome = (input) => (input === '~' || input.startsWith('~/') ? homedir() + input.slice(1) : input);

/** @param {unknown} input @param {'directory' | 'file'} kind @param {string} field */
async function existingPath(input, kind, field) {
  if (typeof input !== 'string' || !input.trim()) throw new HttpError(400, `${field} is required`);
  const path = resolve(expandHome(input.trim()));
  const info = await stat(path).catch(() => null);
  const ok = kind === 'directory' ? info?.isDirectory() : info?.isFile();
  if (!ok) throw new HttpError(400, `${field} is not an existing ${kind}: ${path}`);
  return path;
}

/** @param {any} body */
function asCommand(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.type !== 'string') {
    throw new HttpError(400, 'expected an omp command object with a string `type`');
  }
  return /** @type {Record<string, unknown>} */ (body);
}

/**
 * @param {string | string[] | undefined} header @param {string} bootId
 * @returns {number} the last sequence number this client saw in the current boot, else 0
 */
function lastSeenSeq(header, bootId) {
  const value = Array.isArray(header) ? header[0] : header;
  const [boot, seq] = (value ?? '').split(':');
  const n = Number(seq);
  return boot === bootId && Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * How long `/rpc` holds a request open waiting for omp's answer. Some commands answer only
 * when they finish (`bash`, `login`, `compact`); holding those would tie up the browser's
 * six connections per host and freeze the page, so after this the answer moves to the stream.
 */
export const RPC_HOLD_MS = 2000;

/**
 * @param {{ hub: Hub, history: History, scratchpads: Scratchpads, attachments: Attachments, token: string, root: string, config: DaemonConfig, rpcHoldMs?: number }} options
 */
export function createDaemonServer({ hub, history, scratchpads, attachments, token, root, config, rpcHoldMs = RPC_HOLD_MS }) {
  const rootDir = resolve(root);
  const indexFile = resolve(rootDir, 'index.html');
  const staticDirs = STATIC_DIRS.map((dir) => resolve(rootDir, dir));

  /** @param {IncomingMessage} req @param {ServerResponse} res */
  function stream(req, res) {
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
    res.write('retry: 1000\n\n');
    res.write(`data: ${JSON.stringify({ kind: 'hello', bootId: hub.bootId, sessions: hub.list() })}\n\n`);
    const send = (/** @type {SessionEvent} */ event) =>
      res.write(`id: ${hub.bootId}:${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    for (const event of hub.since(lastSeenSeq(req.headers['last-event-id'], hub.bootId))) send(event);
    const unsubscribe = hub.subscribe(send);
    // No id: scratchpad events are not part of the replayable log (see wire.js).
    const offScratchpad = scratchpads.subscribe((/** @type {string} */ id, /** @type {Scratchpad} */ pad) =>
      res.write(`data: ${JSON.stringify({ kind: 'scratchpad', id, ...pad })}\n\n`),
    );
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      offScratchpad();
    });
  }

  /**
   * The `/api/scratchpads` routes (see wire.js).
   * @param {IncomingMessage} req @param {ServerResponse} res @param {string} method @param {string[]} path
   */
  async function scratchpadRoute(req, res, method, [rawId, sub, rawName]) {
    if (rawId === undefined) {
      if (method === 'GET') return sendJson(res, 200, { pads: await scratchpads.list() });
      throw new HttpError(405, 'method not allowed');
    }
    const id = decodeURIComponent(rawId);
    if (!PAD_ID.test(id)) throw new HttpError(404, 'no such scratchpad');
    if (sub === undefined) {
      if (method === 'GET') return sendJson(res, 200, await scratchpads.read(id));
      if (method === 'DELETE') {
        await scratchpads.remove(id);
        return void res.writeHead(204, BASE_HEADERS).end();
      }
      if (method !== 'PUT') throw new HttpError(405, 'method not allowed');
      const body = await readJson(req);
      if (typeof body?.text !== 'string' || typeof body?.base !== 'string') {
        throw new HttpError(400, 'expected { text: string, base: string }');
      }
      const result = await scratchpads.write(id, body.text, body.base);
      if (!result.ok) return sendJson(res, 409, { error: 'the scratchpad changed since this edit began', current: result.current });
      return sendJson(res, 200, { rev: result.rev });
    }
    if (sub !== 'assets') throw new HttpError(404, 'no such route');
    if (rawName === undefined) {
      if (method !== 'POST') throw new HttpError(405, 'method not allowed');
      const name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'file'));
      const bytes = await readBody(req, MAX_UPLOAD_BYTES);
      return sendJson(res, 201, { path: await scratchpads.saveAsset(id, name, bytes) });
    }
    if (method !== 'GET') throw new HttpError(405, 'method not allowed');
    const asset = scratchpads.asset(id, decodeURIComponent(rawName));
    const info = asset && (await stat(asset.path).catch(() => null));
    if (!asset || !info?.isFile()) throw new HttpError(404, 'no such file');
    res.writeHead(200, {
      ...ASSET_HEADERS,
      'content-type': asset.type,
      'content-length': info.size,
      ...(asset.inline ? {} : { 'content-disposition': 'attachment' }),
    });
    createReadStream(asset.path).pipe(res);
  }

  /** @param {IncomingMessage} req @param {ServerResponse} res @param {URL} url */
  async function api(req, res, url) {
    const { pathname } = url;
    const method = req.method ?? 'GET';
    if (pathname === '/api/stream' && method === 'GET') return stream(req, res);
    if (pathname === '/api/config' && method === 'GET') return sendJson(res, 200, config);
    if (pathname === '/api/history' && method === 'GET') {
      return sendJson(res, 200, { sessions: await history.list(url.searchParams.get('q') ?? '') });
    }
    const pads = /^\/api\/scratchpads(?:\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?)?$/.exec(pathname);
    if (pads) return scratchpadRoute(req, res, method, pads.slice(1));
    if (pathname === '/api/attachments') {
      if (method !== 'POST') throw new HttpError(405, 'method not allowed');
      const name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'file'));
      return sendJson(res, 201, { path: await attachments.save(name, await readBody(req, MAX_UPLOAD_BYTES)) });
    }
    if (pathname === '/api/sessions' && method === 'GET') return sendJson(res, 200, { sessions: hub.list() });
    if (pathname === '/api/sessions' && method === 'POST') {
      const body = await readJson(req);
      const cwd = await existingPath(body?.cwd, 'directory', 'cwd');
      const resume = body?.resume == null ? null : await existingPath(body.resume, 'file', 'resume');
      return sendJson(res, 201, { session: hub.create({ cwd, resume }) });
    }

    const match = /^\/api\/sessions\/([^/]+)(?:\/(rpc|ui))?$/.exec(pathname);
    if (!match) throw new HttpError(404, 'no such route');
    const session = hub.get(decodeURIComponent(match[1]));
    if (!session) throw new HttpError(404, 'no such session');
    const action = match[2] ?? null;

    if (action === null && method === 'DELETE') {
      await session.close();
      res.writeHead(204, BASE_HEADERS).end();
      return;
    }
    if (action === 'rpc' && method === 'POST') {
      const command = asCommand(await readJson(req));
      if (command.type === 'extension_ui_response') throw new HttpError(400, 'send dialog answers to /ui');
      const { id, response } = session.command(command);
      response.catch(() => {}); // after the hold, the outcome travels on the stream
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const held = new Promise((resolve) => (timer = setTimeout(() => resolve(null), rpcHoldMs)));
      const answer = await Promise.race([response, held]).finally(() => clearTimeout(timer));
      return answer ? sendJson(res, 200, answer) : sendJson(res, 202, { pending: true, id });
    }
    if (action === 'ui' && method === 'POST') {
      const response = asCommand({ type: 'extension_ui_response', ...(await readJson(req)) });
      if (typeof response.id !== 'string') throw new HttpError(400, 'a dialog answer needs the request `id`');
      session.respondUi(response);
      res.writeHead(204, BASE_HEADERS).end();
      return;
    }
    throw new HttpError(405, 'method not allowed');
  }

  /** @param {ServerResponse} res @param {URL} url */
  function bootstrap(res, url) {
    if (!tokensMatch(url.searchParams.get('token') ?? undefined, token)) {
      return sendText(res, 403, 'This link does not match the running daemon. Use the URL it printed.');
    }
    url.searchParams.delete('token');
    res.writeHead(302, {
      ...BASE_HEADERS,
      'set-cookie': `${TOKEN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`,
      location: url.pathname + url.search,
    });
    res.end();
  }

  /** @param {ServerResponse} res @param {string} pathname */
  async function serveStatic(res, pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    } catch {
      return sendText(res, 400, 'bad path');
    }
    // Check the allowlist on the resolved file, never the raw path: `/src/..%2f…` passes a
    // prefix test and decodes to a file outside `src/`.
    const file = resolve(rootDir, `.${decoded}`);
    const allowed = file === indexFile || staticDirs.some((dir) => file.startsWith(dir + sep));
    const type = CONTENT_TYPES[extname(file)];
    if (!allowed || !type) return sendText(res, 404, 'not found');
    const body = await readFile(file).catch(() => null);
    if (!body) return sendText(res, 404, 'not found');
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': type });
    res.end(body);
  }

  const server = createServer((req, res) => {
    const port = /** @type {AddressInfo} */ (server.address()).port;
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const handled = (async () => {
      if (!isAllowedHost(req.headers.host, port)) return sendText(res, 403, 'unexpected Host header');
      if (url.pathname.startsWith('/api/')) {
        const verdict = checkApiRequest({ method: req.method ?? 'GET', headers: req.headers, port, token });
        if (!verdict.ok) return sendJson(res, verdict.status, { error: verdict.error });
        return api(req, res, url);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'method not allowed');
      if (url.searchParams.has('token')) return bootstrap(res, url);
      return serveStatic(res, url.pathname);
    })();
    handled.catch((err) => {
      const status = err instanceof HttpError ? err.status : err instanceof SessionNotRunning ? 409 : 500;
      if (status === 500) console.error('[daemon]', err);
      if (!res.headersSent) sendJson(res, status, { error: err.message });
      else res.end();
    });
  });
  return server;
}
