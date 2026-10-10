// The admin page: /admin.
//
//   GET  /admin                  the page (a sign-in form until you are signed in)
//   GET  /admin/api/session      { enabled, authed }
//   POST /admin/api/login        { password }      sets the session cookie
//   POST /admin/api/logout
//   GET  /admin/api/state        the server, every room and who is in it
//   POST /admin/api/act          { do: 'room.rename', code, … }   one change
//   GET  /admin/api/backup       the saved rooms, as a file
//
// It is switched off unless ADMIN_PASSWORD is set. A session is a random
// token in an HttpOnly, SameSite=Strict cookie, held in memory: restarting
// the server signs everyone out. Every request that changes something must
// also carry a header that a page on another site cannot send.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as game from './game.js';
import { config, log } from './config.js';
import { normalizeCode, text } from './names.js';
import { humansOnline, live } from './rooms.js';

const COOKIE = 'swipe_admin';
const GUARD_HEADER = 'x-swipe-admin';
const MAX_SESSIONS = 20;
const FAIL_WINDOW_MS = 10 * 60_000;
const FAILS_PER_ADDRESS = 6; // wrong passwords from one address in that window
const FAILS_IN_ALL = 300; // and from everywhere put together: a brake on guessing from many addresses at once
const EVENTS_MAX = 150;

const now = () => Date.now();

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** "Mozilla/5.0 (iPhone; …) … Safari/604.1" -> "iPhone, Safari" */
export function deviceLabel(ua) {
  const s = text(ua);
  if (!s) return '';
  const device = /iPhone/.test(s)
    ? 'iPhone'
    : /iPad/.test(s)
      ? 'iPad'
      : /Android/.test(s)
        ? /Mobile/.test(s)
          ? 'Android phone'
          : 'Android tablet'
        : /CrOS/.test(s)
          ? 'Chromebook'
          : /Macintosh|Mac OS X/.test(s)
            ? 'Mac'
            : /Windows/.test(s)
              ? 'Windows'
              : /Linux|X11/.test(s)
                ? 'Linux'
                : '';
  const browser = /Edg(e|A|iOS)?\//.test(s)
    ? 'Edge'
    : /OPR\/|Opera/.test(s)
      ? 'Opera'
      : /SamsungBrowser/.test(s)
        ? 'Samsung Internet'
        : /Firefox\/|FxiOS/.test(s)
          ? 'Firefox'
          : /Chrome\/|CriOS/.test(s)
            ? 'Chrome'
            : /Safari\//.test(s)
              ? 'Safari'
              : '';
  return [device, browser].filter(Boolean).join(', ') || s.slice(0, 40);
}

export function createAdmin({ rooms, sockets, clientIp, isHttps, send, readJson, securityHeaders }) {
  const sessions = new Map(); // token -> { until, born, ip }
  const fails = new Map(); // address -> { n, until }
  const events = []; // newest last
  const startedAt = now() - Math.round(process.uptime() * 1000);
  let version = '';
  try {
    version = JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8')).version ?? '';
  } catch {}
  let page = null;

  const enabled = () => Boolean(config.adminPassword);
  const record = (kind, detail = {}) => {
    // A run of wrong passwords from one address is one line with a count, so it cannot push everything else off the list.
    const last = events.at(-1);
    if (kind === 'admin.denied' && last?.kind === kind && last.ip === detail.ip) {
      last.n = (last.n ?? 1) + 1;
      last.at = now();
      return;
    }
    events.push({ ...detail, at: now(), kind });
    if (events.length > EVENTS_MAX) events.splice(0, events.length - EVENTS_MAX);
  };
  // Rooms that come and go on their own. (What the admin does is recorded where it is done.)
  rooms.report = (kind, detail) => {
    if (kind === 'room.removed' && !['expired', 'made room'].includes(detail.why)) return;
    record(kind, detail);
  };

  if (enabled() && config.adminPassword.length < 10) {
    log.warn('ADMIN_PASSWORD is short. The admin page is reachable by anyone who can reach this server: use a long one.');
  }
  if (enabled() && config.adminPassword === config.createPassword) {
    log.warn('ADMIN_PASSWORD is the same as CREATE_PASSWORD. Everyone you let create rooms can open the admin page: use a different one.');
  }

  // ───────────────────────── sessions ─────────────────────────

  const cookiePath = `${config.basePath}/admin`;
  const cookie = (req, value, maxAge) =>
    `${COOKIE}=${value}; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;

  function tokenOf(req) {
    for (const part of String(req.headers.cookie ?? '').split(';')) {
      const at = part.indexOf('=');
      if (at !== -1 && part.slice(0, at).trim() === COOKIE) return part.slice(at + 1).trim();
    }
    return '';
  }

  /** The session this request belongs to, if it is still good. */
  function sessionOf(req) {
    const token = tokenOf(req);
    const session = token && sessions.get(token);
    if (!session) return null;
    if (session.until < now()) {
      sessions.delete(token);
      return null;
    }
    return session;
  }

  function failuresFor(key) {
    const entry = fails.get(key);
    if (!entry || entry.until < now()) return { n: 0, until: now() + FAIL_WINDOW_MS };
    return entry;
  }
  // One home or phone gets a whole block of IPv6 addresses (a /64), so those are counted together.
  const keyFor = (ip) => (ip.includes(':') ? `${ip.split(':').slice(0, 4).join(':')}::/64` : ip);
  const blockedFor = (ip) => {
    for (const [key, limit] of [[keyFor(ip), FAILS_PER_ADDRESS], ['*', FAILS_IN_ALL]]) {
      const entry = failuresFor(key);
      if (entry.n >= limit) return Math.max(1, Math.ceil((entry.until - now()) / 1000));
    }
    return 0;
  };
  const countFailure = (ip) => {
    for (const key of [keyFor(ip), '*']) {
      const entry = failuresFor(key);
      entry.n += 1;
      fails.set(key, entry);
    }
    if (fails.size > 5000) for (const [key, entry] of fails) if (entry.until < now()) fails.delete(key);
  };

  async function login(req, res) {
    const ip = clientIp(req);
    const refuse = (wait) => send(res, 429, { error: `Too many wrong passwords. Try again in ${Math.ceil(wait / 60)} minutes.` }, { 'Retry-After': String(wait) });
    let wait = blockedFor(ip);
    if (wait) return refuse(wait);
    const body = await readJson(req);
    if (!body) return send(res, 400, { error: 'Bad request.' });
    // Asked again now that the request has arrived in full: many slow requests
    // opened together must not all get a guess. From here to the count below
    // nothing waits, so each one sees the failures of those before it.
    wait = blockedFor(ip);
    if (wait) return refuse(wait);
    if (!sameSecret(body.password, config.adminPassword)) {
      countFailure(ip);
      record('admin.denied', { ip });
      log.warn(`Admin sign-in failed from ${ip}`);
      await new Promise((resolve) => setTimeout(resolve, 400));
      return send(res, 403, { error: 'That password is not right.' });
    }
    fails.delete(keyFor(ip));
    for (const [token, session] of sessions) if (session.until < now()) sessions.delete(token);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, { born: now(), until: now() + config.adminSessionHours * 3600_000, ip });
    record('admin.signin', { ip });
    log.info(`Admin signed in from ${ip}`);
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, token, config.adminSessionHours * 3600) });
  }

  // ───────────────────────── what the page shows ─────────────────────────

  function describeRoom(room) {
    const r = room.round;
    const m = room.match;
    const people = [...room.players.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    const stats = room.stats ?? {};
    const record = (key) => ({ games: stats[key]?.games ?? 0, wins: stats[key]?.wins ?? 0, points: stats[key]?.points ?? 0 });
    const seatedKeys = new Set(people.map((p) => rooms.statKeyOf(room, p)));
    // People with a record here who are not in the room any more: they left long ago, or came back as somebody new.
    const absent = Object.entries(stats)
      .filter(([key]) => !seatedKeys.has(key))
      .map(([key, s]) => ({ key, name: s.name, color: s.color, bot: Boolean(s.bot), ...record(key) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const players = people.map((p) => {
      const open = [...p.sockets].filter((s) => s.readyState === 1);
      const ips = [...new Set(open.map((s) => s.ip).filter(Boolean))];
      const seat = r && r.phase !== 'over' ? r.seats[p.id] : null;
      return {
        id: p.id,
        key: rooms.statKeyOf(room, p),
        ...record(rooms.statKeyOf(room, p)),
        name: p.name,
        color: p.color,
        bot: p.bot,
        host: p.id === room.hostId,
        online: p.bot ? false : p.online,
        playing: p.playing,
        tabs: open.length,
        watching: open.some((s) => s.visible !== false),
        ips: ips.length ? ips : p.ip && !p.bot ? [p.ip] : [],
        device: p.bot ? '' : deviceLabel(open[0]?.ua ?? p.ua),
        joinedAt: p.joinedAt,
        seenAt: p.seenAt,
        notify: Boolean(p.push),
        score: m && m.order.includes(p.id) ? (m.scores[p.id] ?? 0) : null,
        cards: seat ? game.cardsLeft(seat) : null,
      };
    });
    let status = 'lobby';
    if (r) status = r.phase === 'over' ? 'results' : r.phase === 'deal' ? 'dealing' : 'playing';
    const turn = r && r.phase === 'play' ? game.current(r) : null;
    return {
      code: room.code,
      aliases: room.aliases ?? [],
      createdAt: room.createdAt,
      lastActive: room.lastActive,
      expiry: room.expiry === 'never' ? 'never' : Number.isFinite(room.expiry) ? 'at' : 'default',
      expiresAt: rooms.expiresAt(room),
      inUse: humansOnline(room),
      online: players.filter((p) => p.online).length,
      locked: room.locked,
      hostId: room.hostId,
      status,
      live: live(room),
      gameNo: m?.gameNo ?? 0,
      matchOver: Boolean(m?.over),
      turn,
      pile: r && r.phase !== 'over' ? r.pile.length : null,
      clock: r ? { deadline: r.deadline ?? null, pausedLeft: r.pausedLeft ?? null } : null,
      settings: room.settings,
      banned: room.banned.length,
      players,
      absent,
      statsKept: Object.values(stats).filter((s) => s.games > 0).length,
    };
  }

  function state() {
    const list = [...rooms.rooms.values()].map(describeRoom);
    const memory = process.memoryUsage();
    let file = null;
    try {
      const stat = fs.statSync(rooms.file);
      file = { size: stat.size, changedAt: Math.round(stat.mtimeMs) };
    } catch {}
    const people = list.flatMap((room) => room.players);
    return {
      now: now(),
      totals: {
        rooms: list.length,
        inUse: list.filter((room) => room.inUse).length,
        online: people.filter((p) => p.online).length,
        people: people.filter((p) => !p.bot).length,
        bots: people.filter((p) => p.bot).length,
        games: list.filter((room) => room.live).length,
        sockets: sockets(),
      },
      server: {
        siteName: config.siteName,
        version,
        node: process.version,
        platform: `${os.type()} ${os.release()} (${process.arch})`,
        hostname: os.hostname(),
        pid: process.pid,
        startedAt,
        memory: { rss: memory.rss, heap: memory.heapUsed },
        load: os.loadavg()[0],
        listen: `${config.host}:${config.port}`,
        basePath: config.basePath || '/',
        trustProxy: config.trustProxy,
        allowedOrigins: config.allowedOrigins,
        persist: config.persist,
        dataDir: config.dataDir,
        filePath: rooms.file,
        file,
        savedAt: rooms.savedAt,
        saveError: rooms.saveError,
        roomTtlHours: config.roomTtlHours,
        maxRooms: config.maxRooms,
        maxPlayers: config.maxPlayers,
        createPassword: Boolean(config.createPassword),
        push: config.push,
        pushContact: config.pushContact,
        subscriptions: [...rooms.rooms.values()].reduce((n, room) => n + [...room.players.values()].filter((p) => p.push).length, 0),
        dealMs: config.dealMs,
        botDelayMs: config.botDelayMs,
        messageBudget: config.messageBudget,
        logLevel: config.logLevel,
        sessionHours: config.adminSessionHours,
        admins: [...sessions.values()].filter((s) => s.until > now()).length,
      },
      rooms: list,
      events: events.slice(-60).reverse(),
    };
  }

  // ───────────────────────── changes ─────────────────────────

  const cleanText = (raw) =>
    text(raw)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 280);

  /** Carries out one change. Returns { ok: true, … } or { error }. */
  function act(body, req) {
    const what = text(body.do);
    const fail = (error) => ({ error });
    const done = (detail = {}, extra = {}) => {
      record(`admin.${what}`, detail);
      log.info(`Admin: ${what} ${JSON.stringify(detail)}`);
      return { ok: true, ...extra };
    };

    // ── the whole server ──
    if (what === 'server.create') {
      const room = rooms.create({ quiet: true });
      if (!room) return fail(`The server is full: it holds ${config.maxRooms} rooms. Delete one first.`);
      if (body.name) {
        const renamed = rooms.rename(room, body.name, { keepOld: false });
        if (renamed.error) {
          rooms.remove(room, { why: 'not created' });
          return fail(renamed.error);
        }
      }
      return done({ code: room.code }, { code: room.code });
    }
    if (what === 'server.save') {
      if (!config.persist) return fail('Saving is switched off on this server (PERSIST=false).');
      rooms.save();
      return rooms.saveError ? fail(`Could not save: ${rooms.saveError}`) : done();
    }
    if (what === 'server.message') {
      const text = cleanText(body.text);
      if (!text) return fail('Type a message first.');
      let reached = 0;
      for (const room of rooms.rooms.values()) reached += rooms.announce(room, text);
      return done({ text, reached }, { reached });
    }
    if (what === 'server.cleanup') {
      const hours = typeof body.hours === 'number' ? body.hours : NaN;
      if (!Number.isFinite(hours) || hours < 0 || hours > 24 * 365) return fail('Pick how long a room has to have been idle.');
      const removed = [];
      for (const room of [...rooms.rooms.values()]) {
        if (humansOnline(room) || room.expiry != null) continue;
        if (now() - room.lastActive < hours * 3600_000) continue;
        rooms.remove(room, { why: 'cleaned up' });
        removed.push(room.code);
      }
      return done({ hours, removed: removed.length }, { removed });
    }
    if (what === 'server.signout') {
      const mine = tokenOf(req);
      let n = 0;
      for (const token of [...sessions.keys()]) {
        if (token === mine) continue;
        sessions.delete(token);
        n += 1;
      }
      return done({ others: n }, { others: n });
    }

    // ── one room ──
    if (!what.startsWith('room.')) return fail('Unknown action.');
    const room = rooms.get(normalizeCode(body.code));
    if (!room) return fail('That room is no longer here.');
    const code = room.code;
    const player = () => room.players.get(text(body.id));

    switch (what) {
      case 'room.expiry': {
        const err = rooms.setExpiry(room, text(body.mode), body.at);
        return err ? fail(err) : done({ code, mode: body.mode, until: body.mode === 'at' ? room.expiry : undefined });
      }
      case 'room.rename': {
        const res = rooms.rename(room, body.random ? rooms.freshCode() : body.name, { keepOld: body.keepOld !== false });
        return res.error ? fail(res.error) : done({ code: res.code, was: res.old, keepOld: body.keepOld !== false }, { code: res.code });
      }
      case 'room.delete':
        rooms.remove(room, { notice: 'This room was closed by the person who runs this server.', why: 'deleted' });
        return done({ code });
      case 'room.lock':
        room.locked = Boolean(body.on);
        rooms.scheduleSave();
        rooms.broadcast(room);
        return done({ code, on: room.locked });
      case 'room.message': {
        const text = cleanText(body.text);
        if (!text) return fail('Type a message first.');
        const reached = rooms.announce(room, text);
        return done({ code, text, reached }, { reached });
      }
      case 'room.endGame':
        if (!live(room)) return fail('No game is being played in that room.');
        game.abandon(room.round);
        rooms.afterChange(room);
        rooms.broadcast(room);
        return done({ code });
      case 'room.reset':
        if (live(room)) game.abandon(room.round);
        rooms.afterChange(room);
        room.round = null;
        room.match = null;
        rooms.syncTimer(room);
        rooms.broadcast(room);
        return done({ code });
      case 'room.unban': {
        const n = room.banned.length;
        room.banned = [];
        rooms.scheduleSave();
        return done({ code, n }, { n });
      }
      case 'room.statsReset': {
        const key = body.key == null ? null : text(body.key);
        if (body.key != null && !key) return fail('Choose whose stats to reset.');
        const who = key ? (room.stats?.[rooms.resolveStatKey(room, key)]?.name ?? null) : null;
        const n = rooms.resetStats(room, key);
        if (key && !n) return fail('That player has no stats to reset.');
        return done({ code, name: who, n }, { n });
      }
      case 'room.consolidate': {
        const res = rooms.consolidate(room, body.keys, body.keep, body.name);
        return res.error ? fail(res.error) : done({ code, name: res.name, merged: res.merged, removed: res.removed.length }, { name: res.name, removed: res.removed });
      }
      case 'room.renamePlayer': {
        const res = rooms.renamePerson(room, { id: body.id ? text(body.id) : null, key: body.key ? text(body.key) : null }, body.name);
        return res.error ? fail(res.error) : done({ code, name: res.name, was: res.was }, { name: res.name });
      }
      case 'room.host': {
        const p = player();
        if (!p || p.bot) return fail('That player can’t host.');
        room.hostId = p.id;
        rooms.scheduleSave();
        rooms.broadcast(room);
        return done({ code, name: p.name });
      }
      case 'room.kick': {
        const p = player();
        if (!p) return fail('That player has already left.');
        rooms.kick(room, p, { ban: body.ban !== false && !p.bot });
        rooms.afterChange(room);
        rooms.broadcast(room);
        return done({ code, name: p.name, ban: body.ban !== false && !p.bot });
      }
      default:
        return fail('Unknown action.');
    }
  }

  // ───────────────────────── routing ─────────────────────────

  const NO_STORE = { 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex, nofollow' };
  const json = (res, status, body, headers = {}) => send(res, status, body, { ...NO_STORE, ...headers });

  function renderPage() {
    if (page && process.env.NODE_ENV !== 'development') return page;
    const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    page = fs
      .readFileSync(path.join(config.publicDir, 'admin', 'index.html'), 'utf8')
      .replaceAll('{{BASE}}', `${config.basePath}/`)
      .replaceAll('{{SITE_NAME}}', escapeHtml(config.siteName));
    return page;
  }

  /** Answers anything under /admin that is the admin page's own. Returns false for the rest (its script and stylesheet). */
  async function handle(req, res, pathname) {
    if (pathname === '/admin' || pathname === '/admin/' || pathname === '/admin/index.html') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed'), true;
      res.writeHead(200, { ...securityHeaders, ...NO_STORE, 'Content-Type': 'text/html; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : renderPage());
      return true;
    }
    if (!pathname.startsWith('/admin/api/')) return false;
    const route = pathname.slice('/admin/api/'.length);

    if (route === 'session' && req.method === 'GET') {
      json(res, 200, { enabled: enabled(), authed: enabled() && Boolean(sessionOf(req)), siteName: config.siteName });
      return true;
    }
    if (!enabled()) return json(res, 404, { error: 'The admin page is switched off.' }), true;

    // Nothing is changed for a request another site could have made a browser send.
    const guarded = req.headers[GUARD_HEADER] === '1' && String(req.headers['content-type'] ?? '').startsWith('application/json');
    if (req.method === 'POST' && !guarded) return json(res, 400, { error: 'Bad request.' }), true;

    if (route === 'login' && req.method === 'POST') return await login(req, res), true;

    const session = sessionOf(req);
    if (!session) return json(res, 401, { error: 'Sign in first.' }), true;

    if (route === 'logout' && req.method === 'POST') {
      sessions.delete(tokenOf(req));
      record('admin.signout', { ip: clientIp(req) });
      return json(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) }), true;
    }
    if (route === 'state' && req.method === 'GET') return json(res, 200, state()), true;
    if (route === 'backup' && req.method === 'GET') {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      record('admin.backup', {});
      const body = Buffer.from(JSON.stringify({ version: 1, savedAt: now(), rooms: rooms.serialize() }, null, 1));
      return json(res, 200, body, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="swipe-rooms-${stamp}.json"` }), true;
    }
    if (route === 'act' && req.method === 'POST') {
      const body = await readJson(req, 8192);
      if (!body || typeof body !== 'object') return json(res, 400, { error: 'Bad request.' }), true;
      let result;
      try {
        result = act(body, req);
      } catch (err) {
        log.warn(`Admin action "${text(body.do)}" failed: ${err.stack ?? err}`);
        result = { error: 'Something went wrong on the server.' };
      }
      return json(res, result.error ? 400 : 200, result), true;
    }
    return json(res, 404, { error: 'Not found.' }), true;
  }

  return { handle, state, act, record, sessions };
}
