// HTTP + WebSocket front door.
//
//   GET  /                 the app
//   GET  /r/<code>         the app, opened on a room
//   POST /api/rooms        create a room            -> { code }
//   GET  /api/rooms/<code> does this room exist?    -> { exists, players, locked }
//   GET  /healthz          liveness probe
//   GET  /admin            the admin page (see admin.js; off unless ADMIN_PASSWORD is set)
//   GET  /sw.js            the service worker (installable app, notifications)
//   GET  /manifest.webmanifest   the app manifest; with ?room=&seat= it opens
//                          straight into that room and brings the seat along
//   WS   /ws               game traffic (JSON messages)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { config, log } from './config.js';
import net from 'node:net';
import { normalizeCode, text } from './names.js';
import { Rooms, cleanSeatCode } from './rooms.js';
import * as push from './push.js';
import { createAdmin } from './admin.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'self'; form-action 'self'",
};

const rooms = new Rooms();
rooms.load();

// ───────────────────────── helpers ─────────────────────────

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const cleanIp = (raw) => {
  const ip = text(raw).trim().replace(/^::ffff:/i, '');
  return net.isIP(ip) ? ip : '';
};

/** Loopback, a home or Docker network, or link-local: where a reverse proxy on your own kit connects from. */
function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return ip === '::1' || /^f[cd]/i.test(ip) || /^fe[89ab]/i.test(ip);
}

/**
 * What a proxy says about the visitor is believed only when TRUST_PROXY says
 * there is a proxy and the connection really comes from a private address,
 * which is where your own proxy connects from. Someone who reaches the
 * server's port directly from the internet cannot pass themselves off.
 */
const viaProxy = (req) => config.trustProxy > 0 && (config.trustAnyProxy || isPrivate(cleanIp(req.socket.remoteAddress)));

/**
 * The visitor's address. Each proxy in front of the server adds the address
 * it heard from to the end of X-Forwarded-For, so with TRUST_PROXY proxies the
 * entry that many from the end is the one a visitor cannot make up.
 */
function clientIp(req) {
  const direct = cleanIp(req.socket.remoteAddress) || 'unknown';
  if (!viaProxy(req)) return direct;
  const chain = text(req.headers['x-forwarded-for'])
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!chain.length) return direct;
  return cleanIp(chain[Math.max(0, chain.length - config.trustProxy)]) || direct;
}

/** True if the visitor reached the site over HTTPS (directly, or as the proxy reports it). */
function isHttps(req) {
  if (req.socket.encrypted) return true;
  return viaProxy(req) && text(req.headers['x-forwarded-proto']).split(',')[0].trim() === 'https';
}

/** Tiny fixed-window limiter: `limit` hits per `windowMs` per key. */
function limiter(limit, windowMs) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (key) => {
    const n = (hits.get(key) ?? 0) + 1;
    hits.set(key, n);
    return n <= limit;
  };
}
const createLimit = limiter(20, 60_000);
const claimLimit = limiter(12, 60_000); // wrong seat codes are not free to guess

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(data);
}

function readJson(req, limit = 4096) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

// index.html is a template: the base path and site name are filled in once.
let indexHtml = null;
function renderIndex() {
  if (indexHtml && process.env.NODE_ENV !== 'development') return indexHtml;
  const raw = fs.readFileSync(path.join(config.publicDir, 'index.html'), 'utf8');
  const cfg = { siteName: config.siteName, needsPassword: Boolean(config.createPassword), pushKey: push.publicKey() };
  indexHtml = raw
    .replaceAll('{{BASE}}', `${config.basePath}/`)
    .replaceAll('{{SITE_NAME}}', escapeHtml(config.siteName))
    .replaceAll('{{CONFIG}}', JSON.stringify(cfg).replace(/</g, '\\u003c'));
  return indexHtml;
}

function serveStatic(req, res, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return send(res, 400, 'Bad request');
  }
  const rel = path.normalize(decoded).replace(/^([/\\])+/, '');
  const file = path.join(config.publicDir, rel);
  if (!file.startsWith(config.publicDir + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'Not found');
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const ext = path.extname(file).toLowerCase();
    const headers = {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      ETag: etag,
      'Cache-Control': ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/**
 * The path a request is for, with the configured base path stripped (it works
 * whether or not the proxy strips it first).
 *
 * It is read the way nginx reads one, so that a rule in a proxy ("only my LAN
 * may open /admin") and this server always agree about what is being asked
 * for. A target has to be a plain path: "//host/admin" is not a path, and a
 * backslash is not a slash. "." and ".." are resolved and doubled slashes are
 * merged, as nginx does before it matches a location.
 */
function localPath(rawUrl) {
  const raw = text(rawUrl).split('?')[0];
  if (!raw.startsWith('/') || /[\\#\u0000- \u007f]/.test(raw)) return null;
  let pathname;
  try {
    pathname = new URL(`http://x${raw.replace(/\/{2,}/g, '/')}`).pathname.replace(/\/{2,}/g, '/');
  } catch {
    return null;
  }
  const base = config.basePath;
  if (base && (pathname === base || pathname.startsWith(`${base}/`))) pathname = pathname.slice(base.length) || '/';
  return pathname;
}

// ───────────────────────── HTTP ─────────────────────────

const server = http.createServer((req, res) => {
  // Whatever a request contains, the worst it can do is fail on its own.
  handle(req, res).catch((err) => {
    log.warn(`Request ${req.method} ${req.url} failed: ${err.stack ?? err}`);
    if (res.headersSent) return res.destroy();
    send(res, 500, { error: 'Something went wrong on the server.' });
  });
});

async function handle(req, res) {
  const pathname = localPath(req.url);
  if (pathname === null) return send(res, 400, 'Bad request');

  if (pathname === '/healthz') {
    let online = 0;
    for (const room of rooms.rooms.values()) for (const p of room.players.values()) if (p.online && !p.bot) online += 1;
    return send(res, 200, { ok: true, rooms: rooms.rooms.size, online, uptime: Math.round(process.uptime()) });
  }

  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    if (await admin.handle(req, res, pathname)) return;
  }

  if (pathname === '/api/rooms' && req.method === 'POST') {
    if (!createLimit(clientIp(req))) return send(res, 429, { error: 'Too many rooms created. Try again in a minute.' });
    const body = await readJson(req);
    if (!body) return send(res, 400, { error: 'Bad request.' });
    if (config.createPassword && !sameSecret(body.password ?? '', config.createPassword)) {
      return send(res, 403, { error: 'That password is not right.' });
    }
    const room = rooms.create();
    if (!room) return send(res, 503, { error: 'This server is full. Try again later.' });
    log.info(`Room created: ${room.code} (from ${clientIp(req)})`);
    return send(res, 201, { code: room.code });
  }

  const roomInfo = /^\/api\/rooms\/([^/]+)$/.exec(pathname);
  if (roomInfo && req.method === 'GET') {
    let asked = roomInfo[1];
    try {
      asked = decodeURIComponent(asked);
    } catch {}
    const room = rooms.get(normalizeCode(asked));
    if (!room) return send(res, 404, { exists: false });
    // (`code` is the name the room has now; the one asked for may be an older one.)
    return send(res, 200, { exists: true, code: room.code, players: room.players.size, locked: room.locked });
  }
  if (pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

  if (pathname === '/manifest.webmanifest') {
    const manifest = JSON.parse(fs.readFileSync(path.join(config.publicDir, 'manifest.webmanifest'), 'utf8'));
    manifest.name = manifest.short_name = config.siteName;
    // Added to a Home Screen from inside a room, the app opens in that room.
    // On an iPhone the installed copy has storage of its own, so a seat code
    // rides along to bring the player's seat with it.
    const query = new URL(req.url, 'http://x').searchParams;
    const roomCode = normalizeCode(query.get('room'));
    const seat = cleanSeatCode(query.get('seat'));
    if (roomCode) manifest.start_url = `./r/${roomCode}${seat.length === 8 ? `?seat=${seat}` : ''}`;
    return send(res, 200, Buffer.from(JSON.stringify(manifest)), { 'Content-Type': MIME['.webmanifest'], 'Cache-Control': 'no-cache' });
  }

  if (pathname === '/' || pathname === '/index.html' || /^\/r\/[^/]*\/?$/.test(pathname)) {
    return send(res, 200, renderIndex(), { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
  }
  return serveStatic(req, res, pathname);
}

// ───────────────────────── WebSocket ─────────────────────────

const wss = new WebSocketServer({ noServer: true, maxPayload: 96 * 1024 });
const admin = createAdmin({ rooms, sockets: () => wss.clients.size, clientIp, isHttps, send, readJson, securityHeaders: SECURITY_HEADERS });

server.on('upgrade', (req, socket, head) => {
  if (localPath(req.url) !== '/ws') {
    socket.destroy();
    return;
  }
  if (config.allowedOrigins.length) {
    const origin = String(req.headers.origin ?? '').replace(/\/$/, '');
    if (!config.allowedOrigins.includes(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  const origin = String(req.headers.origin ?? '').replace(/\/$/, '').slice(0, 200) || null;
  const ua = String(req.headers['user-agent'] ?? '').slice(0, 300) || null;
  ws.alive = true;
  ws.budget = config.messageBudget; // messages allowed per 5 seconds
  let room = null;
  let player = null;

  const reply = (obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));

  ws.on('pong', () => (ws.alive = true));

  ws.on('message', (raw) => {
    if ((ws.budget -= 1) < 0) return reply({ t: 'err', m: 'Slow down a little.' });
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    try {
      receive(msg);
    } catch (err) {
      log.warn(`Message "${text(msg.t)}" failed: ${err.stack ?? err}`);
    }
  });

  function receive(msg) {
    if (msg.t === 'hello') {
      if (player) return;
      const found = rooms.get(normalizeCode(msg.room));
      if (!found) return reply({ t: 'fatal', code: 'no-room', m: 'That room does not exist (or it expired).' });
      const token = text(msg.token);
      if (token.length < 16 || token.length > 128) return reply({ t: 'fatal', code: 'bad-token', m: 'Bad session.' });
      const claim = text(msg.claim) && claimLimit(ip) ? text(msg.claim) : null;
      const result = rooms.connect(found, { token, name: msg.name, claim, origin, ip, ua }, ws);
      if (msg.claim) reply({ t: 'claim', ok: Boolean(result.claimed) });
      if (result.error) return reply({ t: 'fatal', code: result.code, m: result.error });
      room = found;
      player = result.player;
      rooms.broadcast(room);
      return;
    }

    // The page was hidden or shown: decides whether a turn needs a notification.
    if (msg.t === 'vis' && player && room) {
      if (room.players.has(player.id)) rooms.setVisible(room, player, ws, msg.v);
      return;
    }
    // A code that moves this seat to another browser. Sent to this socket only.
    if (msg.t === 'seat' && player && room) {
      if (room.players.has(player.id) && player.sockets.has(ws)) reply({ t: 'seat', ...rooms.seatCode(room, player, { forLink: Boolean(msg.link) }) });
      return;
    }

    if (msg.t === 'ping') return reply({ t: 'pong', now: Date.now() });
    if (room?.gone) return; // the room was closed while this message was on its way

    if (msg.t === 'a' && player && room) {
      if (!room.players.has(player.id)) return; // kicked
      let err;
      try {
        err = rooms.act(room, player, msg);
      } catch (e) {
        log.warn(`Action "${msg.a}" failed in ${room.code}: ${e.stack ?? e}`);
        err = 'Something went wrong on the server.';
      }
      // Clients may number their requests ("n") to get a definite answer.
      if (err) reply({ t: 'err', m: err, n: msg.n });
      else if (msg.n != null) reply({ t: 'ack', n: msg.n });
    }
  }

  ws.on('close', () => {
    if (room && player && room.players.has(player.id)) rooms.disconnect(room, player, ws);
  });
  ws.on('error', () => {});
});

// Drop dead connections and refill message budgets.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    try {
      ws.ping();
    } catch {}
  }
}, 25_000).unref();
setInterval(() => {
  for (const ws of wss.clients) ws.budget = config.messageBudget;
}, 5_000).unref();
setInterval(() => rooms.sweep(), 60_000).unref();

// ───────────────────────── start / stop ─────────────────────────

push.loadKeys();

server.listen(config.port, config.host, () => {
  log.info(`${config.siteName} is listening on http://${config.host}:${config.port}${config.basePath || ''}`);
  log.info(config.adminPassword ? `The admin page is at ${config.basePath}/admin` : 'The admin page is off. Set ADMIN_PASSWORD to turn it on.');
});

function shutdown(signal) {
  log.info(`${signal} received — saving rooms and shutting down`);
  rooms.save();
  for (const ws of wss.clients) ws.close(1001, 'server restarting');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
// A slip somewhere must not end everyone's game: note it and carry on.
process.on('uncaughtException', (err) => log.warn(`Uncaught: ${err.stack ?? err}`));
process.on('unhandledRejection', (err) => log.warn(`Unhandled: ${err?.stack ?? err}`));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
