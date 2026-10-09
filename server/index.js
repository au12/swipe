// HTTP + WebSocket front door.
//
//   GET  /                 the app
//   GET  /r/<code>         the app, opened on a room
//   POST /api/rooms        create a room            -> { code }
//   GET  /api/rooms/<code> does this room exist?    -> { exists, players, locked }
//   GET  /healthz          liveness probe
//   WS   /ws               game traffic (JSON messages)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { config, log } from './config.js';
import { normalizeCode } from './names.js';
import { Rooms } from './rooms.js';

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

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
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

function sameSecret(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
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
  const cfg = { siteName: config.siteName, needsPassword: Boolean(config.createPassword) };
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

/** Strips the configured base path; works whether or not the proxy strips it first. */
function localPath(rawUrl) {
  let pathname;
  try {
    pathname = new URL(rawUrl, 'http://x').pathname;
  } catch {
    return null;
  }
  const base = config.basePath;
  if (base && (pathname === base || pathname.startsWith(`${base}/`))) pathname = pathname.slice(base.length) || '/';
  return pathname;
}

// ───────────────────────── HTTP ─────────────────────────

const server = http.createServer(async (req, res) => {
  const pathname = localPath(req.url);
  if (pathname === null) return send(res, 400, 'Bad request');

  if (pathname === '/healthz') {
    let online = 0;
    for (const room of rooms.rooms.values()) for (const p of room.players.values()) if (p.online && !p.bot) online += 1;
    return send(res, 200, { ok: true, rooms: rooms.rooms.size, online, uptime: Math.round(process.uptime()) });
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
    log.info(`Room created: ${room.code}`);
    return send(res, 201, { code: room.code });
  }

  const roomInfo = /^\/api\/rooms\/([^/]+)$/.exec(pathname);
  if (roomInfo && req.method === 'GET') {
    const room = rooms.get(normalizeCode(roomInfo[1]));
    if (!room) return send(res, 404, { exists: false });
    return send(res, 200, { exists: true, players: room.players.size, locked: room.locked });
  }
  if (pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

  if (pathname === '/manifest.webmanifest') {
    const manifest = JSON.parse(fs.readFileSync(path.join(config.publicDir, 'manifest.webmanifest'), 'utf8'));
    manifest.name = manifest.short_name = config.siteName;
    return send(res, 200, Buffer.from(JSON.stringify(manifest)), { 'Content-Type': MIME['.webmanifest'], 'Cache-Control': 'no-cache' });
  }

  if (pathname === '/' || pathname === '/index.html' || /^\/r\/[^/]*\/?$/.test(pathname)) {
    return send(res, 200, renderIndex(), { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
  }
  return serveStatic(req, res, pathname);
});

// ───────────────────────── WebSocket ─────────────────────────

const wss = new WebSocketServer({ noServer: true, maxPayload: 96 * 1024 });

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

wss.on('connection', (ws) => {
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

    if (msg.t === 'hello') {
      if (player) return;
      const found = rooms.get(normalizeCode(msg.room));
      if (!found) return reply({ t: 'fatal', code: 'no-room', m: 'That room does not exist (or it expired).' });
      const token = String(msg.token ?? '');
      if (token.length < 16 || token.length > 128) return reply({ t: 'fatal', code: 'bad-token', m: 'Bad session.' });
      const result = rooms.connect(found, { token, name: msg.name }, ws);
      if (result.error) return reply({ t: 'fatal', code: result.code, m: result.error });
      room = found;
      player = result.player;
      rooms.broadcast(room);
      return;
    }

    if (msg.t === 'ping') return reply({ t: 'pong', now: Date.now() });

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
  });

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
setInterval(() => rooms.sweep(), 10 * 60_000).unref();

// ───────────────────────── start / stop ─────────────────────────

server.listen(config.port, config.host, () => {
  log.info(`${config.siteName} is listening on http://${config.host}:${config.port}${config.basePath || ''}`);
});

function shutdown(signal) {
  log.info(`${signal} received — saving rooms and shutting down`);
  rooms.save();
  for (const ws of wss.clients) ws.close(1001, 'server restarting');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
