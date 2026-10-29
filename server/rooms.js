// Rooms, players, seats at the table, host controls, computer players, the
// turn clock and persistence. The rules themselves live in game.js; this file
// decides *who* may do *what*, keeps the running score across games, and
// builds what each person is allowed to see.

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import * as game from './game.js';
import { config, log } from './config.js';
import { normalizeCode, roomCode, text } from './names.js';
import * as push from './push.js';
import { rankName } from '../public/js/rules.js';

const HOST_HANDOVER_MS = 45_000; // an offline host is replaced after this
const FLIP_PAUSE_MS = Math.min(1_600, Math.round(config.botDelayMs * 1.6)); // a beat for the table to see a flipped blind card
const STALE_SEAT_MS = 120_000; // offline this long when a new match is dealt: you watch
const MAX_BOTS = 23;
const PILE_BACKS = 40; // how many buried pile cards the browser draws
const SEAT_CODE_MS = 15 * 60_000; // how long a seat code shown on screen can be used
const SEAT_LINK_MS = 12 * 3600_000; // and one tucked into a Home Screen link, which may not be opened for a while
const SEAT_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // nothing that looks like something else
const MAX_ALIASES = 8; // earlier names a renamed room still answers to
const NAME_MIN = 3;
const CHAT_KEEP = 100; // messages a room remembers
const CHAT_MAX = 240; // characters in one message
const CHAT_BURST = 6; // messages one person may send in ten seconds
const CHAT_PUSH_GAP_MS = 8_000; // someone who is away is not buzzed more often than this

// One accent color per player. The first twelve are the easiest to tell
// apart, so small tables draw from those before the rest are used.
export const COLORS = [
  '#e5484d', '#f76b15', '#ffb224', '#9bd12c', '#12a594', '#3b9eff', '#3e63dd', '#9a4fd0', '#ee5a8e', '#46a758', '#05a2c2', '#b8804f',
  '#f2d50f', '#d23197', '#7c66dc', '#ff8dcc', '#ff9a85', '#3dd68c', '#7ce2fe', '#b1a9ff', '#9a9cab', '#c9b458', '#6f8f3f', '#7d5a44',
];
const BOT_NAMES = `Riffle Deuce Trey Queenie Maverick Lucky Slim Duchess Bluff Shark Pips Rounder Ante Dolly Kitty Whist Gambit Ruff Flush Tally Marker Knave Parlor`.split(' ');

const now = () => Date.now();
const newId = () => randomBytes(6).toString('base64url');

/** "k7qm-2p9x" -> "K7QM2P9X" */
export const cleanSeatCode = (raw) =>
  text(raw)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 16);

/** A chat message as typed, made safe to keep: one line, no control characters, not too long. */
export function cleanChat(raw) {
  return text(raw)
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHAT_MAX)
    .trim();
}

export function cleanName(raw) {
  return text(raw)
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
}

const defaultSettings = () => ({
  limit: 100, // a match ends when somebody's running score reaches this
  turnSeconds: 0, // 0 = no clock
});

/**
 * The key a browser's stats are kept under: made from its seat token, so the
 * same browser is the same person however long it has been away, and the
 * token itself is never stored beside the stats.
 */
export const statKey = (token) => `h${createHash('sha256').update(String(token)).digest('hex').slice(0, 16)}`;

/** How many cards of each rank: { K: 2, 7: 1 }. */
const tally = (cards) => {
  const counts = {};
  for (const c of cards) counts[c.r] = (counts[c.r] ?? 0) + 1;
  return counts;
};

export const live = (room) => Boolean(room.round && room.round.phase !== 'over');
export const humansOnline = (room) => [...room.players.values()].some((p) => p.online && !p.bot);
const seated = (room) => [...room.players.values()].filter((p) => p.playing).sort((a, b) => a.joinedAt - b.joinedAt);

export class Rooms {
  constructor() {
    this.rooms = new Map();
    this.aliases = new Map(); // an earlier name of a renamed room -> the name it has now
    this.report = () => {}; // (kind, detail): the admin page's activity log listens here
    this.savedAt = null;
    this.saveError = null;
    this.saveTimer = null;
    this.file = path.join(config.dataDir, 'rooms.json');
    this.sendPush = push.send; // tests swap this for a recorder
  }

  // ───────────────────────── lifecycle ─────────────────────────

  create({ quiet = false } = {}) {
    if (this.rooms.size >= config.maxRooms) this.sweep(true);
    if (this.rooms.size >= config.maxRooms) return null;
    const code = this.freshCode();
    const room = {
      code,
      aliases: [],
      createdAt: now(),
      lastActive: now(),
      expiry: null, // null: the usual time after it was last used. 'never', or a fixed time, when the admin says so.
      hostId: null,
      locked: false,
      settings: defaultSettings(),
      players: new Map(),
      banned: [],
      chat: [], // the last hundred things people said: { id, by, name, color, text, at }
      stats: {}, // all-time, by person: { [key]: { name, color, bot, games, wins, points } }
      statAlias: {}, // a key that was merged into another -> the one it now counts for
      match: null, // a run of games played to the points limit
      round: null, // the game on the table right now
    };
    this.rooms.set(code, room);
    this.touch(room);
    if (!quiet) this.report('room.created', { code });
    return room;
  }

  /** Finds a room by its name, or by a name it used to have. */
  get(code) {
    return this.rooms.get(code) ?? this.rooms.get(this.aliases.get(code));
  }

  /** A generated name nothing else is using. */
  freshCode() {
    let code = roomCode();
    while (this.rooms.has(code) || this.aliases.has(code)) code = roomCode();
    return code;
  }

  /** When this room is due to be removed, or null if it is kept for good. */
  expiresAt(room) {
    if (room.expiry === 'never') return null;
    if (Number.isFinite(room.expiry)) return room.expiry;
    return room.lastActive + config.roomTtlHours * 3600_000;
  }

  /**
   * Sets when a room goes: 'default' (the usual time after it was last used),
   * 'never', or a fixed time. Returns an error or null.
   */
  setExpiry(room, mode, at = null) {
    if (mode === 'default') {
      // Back to the usual way, counted from now: a room that sat idle while it
      // was being kept would otherwise be overdue the moment it was let go.
      if (room.expiry != null) room.lastActive = now();
      room.expiry = null;
    } else if (mode === 'never') room.expiry = 'never';
    else if (mode === 'at') {
      const when = typeof at === 'number' ? at : NaN;
      if (!Number.isFinite(when)) return 'Pick a date and time.';
      if (when <= now()) return 'That time has already passed. To remove the room now, delete it.';
      if (when > now() + 3650 * 86400_000) return 'That is more than ten years away. Choose “never” instead.';
      room.expiry = Math.round(when);
    } else return 'Unknown setting.';
    this.scheduleSave();
    return null;
  }

  /**
   * Gives a room a new name, which is also its link. Anything can be typed:
   * it is turned into lower-case letters, numbers and hyphens. Unless
   * `keepOld` is off, the names it had before keep leading to it. Returns
   * { code } or { error }.
   */
  rename(room, raw, { keepOld = true } = {}) {
    if (room.gone) return { error: 'That room is no longer here.' };
    const code = normalizeCode(raw);
    if (code.length < NAME_MIN) return { error: `A room name needs at least ${NAME_MIN} letters or numbers.` };
    if (code === room.code) return { error: 'That is already this room’s name.' };
    const owner = this.get(code);
    if (owner && owner !== room) return { error: 'Another room is using that name.' };

    const old = room.code;
    this.rooms.delete(old);
    let aliases = (room.aliases ?? []).filter((a) => a !== code);
    for (const a of room.aliases ?? []) this.aliases.delete(a);
    aliases = keepOld ? [...aliases, old].slice(-MAX_ALIASES) : [];
    room.aliases = aliases;
    room.code = code;
    this.rooms.set(code, room);
    for (const a of aliases) this.aliases.set(a, code);
    this.scheduleSave();
    this.broadcast(room); // open tabs follow the room to its new address
    return { code, old };
  }

  /** Takes a room off the server. Anyone in it is told why, if `notice` says. */
  remove(room, { notice = null, why = 'removed' } = {}) {
    if (this.rooms.get(room.code) !== room) return false;
    clearTimeout(room.timer);
    clearTimeout(room.botTimer);
    room.timer = null;
    room.botTimer = null;
    room.gone = true;
    this.rooms.delete(room.code);
    for (const a of room.aliases ?? []) this.aliases.delete(a);
    for (const p of room.players.values()) {
      for (const socket of p.sockets) {
        try {
          if (notice) socket.send(JSON.stringify({ t: 'fatal', code: 'closed', m: notice }));
          socket.close(4004, 'room closed');
        } catch {}
      }
      p.sockets = new Set();
    }
    this.report('room.removed', { code: room.code, why });
    this.scheduleSave();
    return true;
  }

  /** Shows a short message to everyone who has the room open. Returns how many people saw it. */
  announce(room, message) {
    const payload = JSON.stringify({ t: 'note', m: text(message).slice(0, 280) });
    let reached = 0;
    for (const p of room.players.values()) {
      let got = false;
      for (const socket of p.sockets) {
        if (socket.readyState !== 1) continue;
        socket.send(payload);
        got = true;
      }
      if (got) reached += 1;
    }
    return reached;
  }

  /** Takes a player out of the room. With `ban`, their browser cannot walk back in. */
  kick(room, p, { ban = true } = {}) {
    if (ban && p.token) room.banned.push(p.token);
    this.unseat(room, p);
    room.players.delete(p.id);
    for (const socket of p.sockets) {
      try {
        socket.send(JSON.stringify({ t: 'kicked' }));
        socket.close(4001, 'kicked');
      } catch {}
    }
    if (room.hostId === p.id) {
      room.hostId = null;
      this.ensureHost(room);
    }
  }

  touch(room) {
    room.lastActive = now();
    this.scheduleSave();
  }

  /**
   * Drop rooms whose time is up. A room is never removed while someone is in
   * it: it goes as soon as it empties. When the server is full (`aggressive`),
   * rooms idle for an hour go too, unless the admin has set their expiry.
   */
  sweep(aggressive = false) {
    let changed = false;
    for (const room of [...this.rooms.values()]) {
      const online = humansOnline(room);
      const idle = now() - room.lastActive;
      const at = this.expiresAt(room);
      const due = at != null && now() > at;
      if (!online && (due || (aggressive && room.expiry == null && idle > 3600_000))) {
        this.remove(room, { why: due ? 'expired' : 'made room' });
        log.debug(`Removed idle room ${room.code}`);
        continue;
      }
      // Forget long-gone watchers so the player list stays tidy.
      const inMatch = new Set(room.match?.order ?? []);
      for (const p of room.players.values()) {
        if (p.bot || p.online || p.id === room.hostId) continue;
        if (now() - p.seenAt > (inMatch.has(p.id) ? 6 : 1) * 3600_000) {
          if (inMatch.has(p.id)) this.unseat(room, p);
          room.players.delete(p.id);
          changed = true;
        }
      }
    }
    if (changed) this.scheduleSave();
  }

  // ───────────────────────── connections ─────────────────────────

  freeColor(room, exceptId) {
    const taken = new Set([...room.players.values()].filter((p) => p.id !== exceptId).map((p) => p.color));
    for (const tier of [COLORS.slice(0, 12), COLORS.slice(12)]) {
      const free = tier.filter((c) => !taken.has(c));
      if (free.length) return free[randomInt(free.length)];
    }
    return COLORS[randomInt(COLORS.length)];
  }

  /** Returns { player } or { error, code }. */
  connect(room, { token, name, claim = null, origin = null, ip = null, ua = null }, socket) {
    if (room.banned.includes(token)) return { code: 'banned', error: 'The host removed you from this room.' };
    // A seat code moves someone's seat to this browser before anything else happens.
    const claimed = claim ? this.claimSeat(room, token, claim) : null;
    let player = claimed ?? [...room.players.values()].find((p) => p.token === token);
    if (!player) {
      const nick = cleanName(name);
      const failed = claim ? { claimed: false } : {};
      if (!nick) return { code: 'name', error: 'Pick a name to join.', ...failed };
      if (room.locked) return { code: 'locked', error: 'This room is locked. Ask the host to unlock it.', ...failed };
      if (room.players.size >= config.maxPlayers) return { code: 'full', error: 'This room is full.', ...failed };
      player = {
        id: newId(),
        token,
        name: this.freeName(room, nick),
        color: this.freeColor(room),
        bot: false,
        // Walk in before the cards are out and you have a seat. Arrive
        // mid-match and you watch until you ask to be dealt in.
        playing: (!room.match || room.match.over) && seated(room).length < game.MAX_PLAYERS,
        online: false,
        sockets: new Set(),
        joinedAt: now(),
        seenAt: now(),
      };
      room.players.set(player.id, player);
    } else if (!claimed && !player.renamed && name && cleanName(name) && cleanName(name) !== player.name) {
      player.name = this.freeName(room, cleanName(name), player.id);
    }
    if (origin) player.origin = origin;
    // Where this player is connecting from: shown on the admin page, kept in memory only.
    socket.ip = ip;
    socket.ua = ua;
    if (ip) player.ip = ip;
    if (ua) player.ua = ua;
    // What has been said so far, to this browser only. New messages follow one at a time.
    try {
      socket.send(JSON.stringify({ t: 'chat', all: room.chat ?? [] }));
      socket.send(JSON.stringify({ t: 'stats', rows: this.statRows(room) }));
    } catch {}
    socket.visible = true;
    player.sockets.add(socket);
    player.online = true;
    player.seenAt = now();
    this.ensureHost(room);
    // The clock stops while a room is empty and picks up when someone returns.
    const r = room.round;
    if (r && r.autoPaused && r.pausedLeft != null) {
      r.deadline = now() + r.pausedLeft;
      r.pausedLeft = null;
      r.autoPaused = false;
    }
    this.syncTimer(room);
    this.touch(room);
    return { player, claimed: claim ? Boolean(claimed) : null };
  }

  // ───────────────────────── seat codes ─────────────────────────
  // A seat belongs to a browser (a random token in its storage). A seat code
  // hands it to another one: a second device, or the copy of Swipe on an
  // iPhone's Home Screen, which does not share storage with Safari.

  /**
   * A fresh code for this player. One shown on screen is good for a quarter
   * of an hour; one made for a Home Screen link (`forLink`) lasts half a day,
   * since the app may not be opened straight away. A player can hold a few at
   * once; using any of them spends them all.
   */
  seatCode(room, player, { forLink = false } = {}) {
    let code = '';
    for (let i = 0; i < 8; i++) code += SEAT_ALPHABET[randomInt(SEAT_ALPHABET.length)];
    const seat = { code, until: now() + (forLink ? SEAT_LINK_MS : SEAT_CODE_MS) };
    player.seats = [...(player.seats ?? []).filter((s) => s.until > now()), seat].slice(-4);
    this.touch(room);
    return seat;
  }

  /** Moves the seat that `code` belongs to onto `token`. Returns the player, or null if the code is no good. */
  claimSeat(room, token, raw) {
    const code = cleanSeatCode(raw);
    if (code.length !== 8) return null;
    const owner = [...room.players.values()].find((p) => !p.bot && (p.seats ?? []).some((s) => s.code === code && s.until > now()));
    if (!owner) return null;
    owner.seats = [];
    if (owner.token === token) return owner;

    // If this browser had already walked in as somebody new, that somebody goes.
    const stray = [...room.players.values()].find((p) => p.token === token);
    if (stray) {
      this.unseat(room, stray);
      room.players.delete(stray.id);
      if (room.hostId === stray.id) room.hostId = owner.id;
      for (const s of stray.sockets) {
        try {
          s.close(4002, 'seat changed'); // its tabs reconnect, and come back as the owner
        } catch {}
      }
    }
    // The browser that had the seat is told where it went.
    for (const s of owner.sockets) {
      try {
        s.send(JSON.stringify({ t: 'moved' }));
        s.close(4003, 'seat moved');
      } catch {}
    }
    owner.sockets = new Set();
    // The seat's record follows it: games from this browser count for the same person as before.
    const key = this.statKeyOf(room, owner);
    owner.token = token;
    if (statKey(token) !== key) (room.statAlias ??= {})[statKey(token)] = key;
    owner.push = null; // notifications were that browser's; this one asks for its own
    return owner;
  }

  // ───────────────────────── turn notifications ─────────────────────────

  /** True while the player has the game open and in front of them somewhere. */
  watching(player) {
    return [...player.sockets].some((s) => s.readyState === 1 && s.visible !== false);
  }

  /** A browser reports that its page was hidden (phone locked, app switched) or shown again. */
  setVisible(room, player, socket, visible) {
    socket.visible = Boolean(visible);
    if (!socket.visible) this.lookedAway(room, player);
  }

  /** Stores (or with null, forgets) where to send this player's notifications. Returns an error or null. */
  setPush(room, player, raw) {
    if (!config.push) return 'Turn notifications are switched off on this server.';
    const next = raw == null ? null : push.cleanSubscription(raw);
    if (raw != null && !next) return 'This browser’s notification service is not one Swipe can send to.';
    if (JSON.stringify(next) === JSON.stringify(player.push ?? null)) return null;
    player.push = next;
    this.touch(room);
    this.sendTo(room, player);
    return null;
  }

  /** The turn has passed to someone: if they are not looking, tell them. */
  alertTurn(room) {
    const r = room.round;
    if (!config.push || !r || r.phase !== 'play') return;
    const pid = game.current(r);
    if (r.alerted === pid) return; // still the same player's go (an extra turn after a swipe)
    r.alerted = pid;
    r.pushedTo = null;
    this.pushTurn(room, r, room.players.get(pid));
  }

  /** Someone stopped watching. If it is their own turn and they haven't been told, remind them shortly. */
  lookedAway(room, player) {
    const r = room.round;
    if (!config.push || !r || r.phase !== 'play' || !player.push) return;
    if (game.current(r) !== player.id || r.pushedTo === player.id) return;
    const timer = setTimeout(() => {
      if (room.gone || room.round !== r || r.phase !== 'play' || game.current(r) !== player.id || r.pushedTo === player.id) return;
      this.pushTurn(room, r, player, { reminder: true });
    }, config.pushRemindMs);
    timer.unref?.();
  }

  pushTurn(room, r, player, { reminder = false } = {}) {
    if (!player || player.bot || !player.push || this.watching(player)) return;
    r.pushedTo = player.id;
    this.notify(room, player, {
      kind: 'turn',
      title: reminder ? 'Still your turn' : 'Your turn',
      body: this.turnText(room, r, player),
    });
  }

  /** What happened just before this player's turn, and what they are playing onto. */
  turnText(room, r, player) {
    const count = ['no', 'a', 'two', 'three', 'four'];
    const words = (rank, n) => (n === 1 ? `${rank === 'A' || rank === '8' ? 'an' : 'a'} ${rankName(rank)}` : `${count[n]} ${rankName(rank, n)}`);
    const e = [...r.log].reverse().find((x) => x.k === 'play' || x.k === 'start' || x.k === 'skip');
    const who = e && e.by !== player.id ? room.players.get(e.by)?.name : null;
    let what = '';
    if (e?.k === 'start') what = 'The cards are dealt and you lead.';
    else if (e?.k === 'skip') what = who ? `${who} ran out of time and drew ${e.drew === 1 ? 'a card' : `${e.drew ?? 'no'} cards`}.` : '';
    else if (e && who) {
      if (e.effect === 'pickup') what = `${who} picked up the pile and led with ${words(e.r, e.n)}.`;
      else if (e.effect === 'swipe') what = `${who} swiped the pile with ${words(e.r, e.n)}.`;
      else what = `${who} played ${words(e.r, e.n)}.`;
    }
    const top = game.topOf(r.pile).rank;
    const next = !top ? 'Play anything.' : top === 'A' ? 'Aces only, or a ten.' : `${top} or lower, or a ten.`;
    return `${what} ${next}`.trim();
  }

  // ───────────────────────── all-time stats ─────────────────────────
  // Kept per room, by person rather than by seat: a player who has been away
  // long enough to be forgotten by the room still has their record when they
  // come back, as long as it is the same browser. When it is not (cleared
  // storage, a new phone), the admin can fold two records into one.

  /** The key this player's games are counted under. */
  statKeyOf(room, p) {
    p.sid ??= p.bot ? `b:${p.name.toLowerCase()}` : statKey(p.token);
    return this.resolveStatKey(room, p.sid);
  }

  /** Follows a key through any merges to the one it counts for now. */
  resolveStatKey(room, key) {
    const alias = room.statAlias ?? {};
    let at = key;
    for (let i = 0; i < 20 && alias[at]; i++) at = alias[at];
    return at;
  }

  /** A game somebody went out of: one more game for everyone who finished it, a win for whoever went out. */
  recordGame(room, r) {
    room.stats ??= {};
    for (const pid of r.order) {
      const p = room.players.get(pid);
      if (!p) continue;
      const key = this.statKeyOf(room, p);
      const s = (room.stats[key] ??= { name: p.name, color: p.color, bot: p.bot, games: 0, wins: 0, points: 0 });
      s.name = p.name;
      s.color = p.color;
      s.games += 1;
      if (pid === r.winner) s.wins += 1;
      s.points += r.result.points[pid] ?? 0;
    }
    this.broadcastStats(room);
  }

  /** The board as everyone sees it: one row for each person who has finished a game here. */
  statRows(room) {
    const here = new Map();
    for (const p of room.players.values()) here.set(this.statKeyOf(room, p), p);
    return Object.entries(room.stats ?? {})
      .filter(([, s]) => s.games > 0)
      .map(([key, s]) => {
        const p = here.get(key);
        return { id: key, name: p?.name ?? s.name, color: p?.color ?? s.color, bot: Boolean(s.bot), here: Boolean(p), games: s.games, wins: s.wins, points: s.points };
      });
  }

  broadcastStats(room) {
    const payload = JSON.stringify({ t: 'stats', rows: this.statRows(room) });
    for (const p of room.players.values()) {
      for (const socket of p.sockets) {
        if (socket.readyState === 1) socket.send(payload);
      }
    }
    this.scheduleSave();
  }

  /** Wipes one person's record, or with no key everybody's. Returns how many records went. */
  resetStats(room, key = null) {
    room.stats ??= {};
    let n = 0;
    if (key == null) {
      n = Object.keys(room.stats).length;
      room.stats = {};
    } else {
      const at = this.resolveStatKey(room, key);
      if (room.stats[at]) n = 1;
      delete room.stats[at];
    }
    this.broadcastStats(room);
    return n;
  }

  /**
   * Folds several people's records into one, for when the same person has
   * ended up in the room more than once. Their games, wins and points are
   * added together under `keep`, and from now on games played from any of
   * those browsers count there.
   *
   * If more than one of them is in the room at the moment, one seat survives:
   * the kept person's if they have one. It is handed to whichever of them is
   * actually connected, and the other seats leave the room (and any game on
   * the table) the way a player who walked out would. Returns { key, name,
   * merged, removed } or { error }.
   */
  consolidate(room, keys, keep, name = '') {
    room.stats ??= {};
    room.statAlias ??= {};
    const all = [...new Set((Array.isArray(keys) ? keys : []).map((k) => this.resolveStatKey(room, text(k))).filter(Boolean))];
    const kept = this.resolveStatKey(room, text(keep));
    if (all.length < 2) return { error: 'Tick at least two players to make into one.' };
    if (!all.includes(kept)) return { error: 'Choose which of them to keep.' };
    const seatsOf = (key) => [...room.players.values()].filter((p) => this.statKeyOf(room, p) === key);
    const known = (key) => Boolean(room.stats[key]) || seatsOf(key).length > 0;
    if (!all.every(known)) return { error: 'One of those players is no longer here. Look again and try once more.' };
    if (all.some((key) => key.startsWith('b:'))) return { error: 'Computer players can’t be made into one with anybody.' };

    const seats = all.flatMap(seatsOf);
    const survivor = seatsOf(kept)[0] ?? seats.slice().sort((a, b) => Number(b.online) - Number(a.online) || b.seenAt - a.seenAt)[0] ?? null;
    const wanted = cleanName(name);
    const others = [...room.players.values()].filter((p) => !seats.includes(p));
    const finalName = wanted || survivor?.name || room.stats[kept]?.name || '';
    if (wanted && others.some((p) => p.name.toLowerCase() === wanted.toLowerCase())) return { error: 'Someone else in this room already has that name.' };

    // The records.
    const sum = { name: finalName, color: survivor?.color ?? room.stats[kept]?.color ?? COLORS[0], bot: false, games: 0, wins: 0, points: 0 };
    for (const key of all) {
      const s = room.stats[key];
      if (s) {
        sum.games += s.games;
        sum.wins += s.wins;
        sum.points += s.points;
      }
      delete room.stats[key];
      if (key !== kept) room.statAlias[key] = kept;
    }
    if (sum.games > 0) room.stats[kept] = sum;

    // The seats.
    const removed = [];
    if (survivor) {
      const live = seats.filter((p) => p !== survivor && p.online).sort((a, b) => b.seenAt - a.seenAt)[0];
      // The person is at a browser the surviving seat does not know: hand the seat to it.
      const handOver = !survivor.online && live ? live.token : null;
      for (const p of seats) {
        if (p === survivor) continue;
        this.unseat(room, p);
        room.players.delete(p.id);
        if (room.hostId === p.id) room.hostId = survivor.id;
        removed.push(p.name);
        for (const socket of p.sockets) {
          try {
            if (handOver && p.token === handOver) socket.close(4002, 'seat changed'); // it reconnects, and is the survivor
            else {
              socket.send(JSON.stringify({ t: 'moved' }));
              socket.close(4003, 'seat moved');
            }
          } catch {}
        }
        p.sockets = new Set();
      }
      if (handOver) {
        survivor.token = handOver;
        survivor.push = null;
        survivor.seats = [];
      }
      survivor.sid = kept;
      survivor.name = finalName;
      // The admin has said who this is: a browser arriving with another name saved does not change it back.
      survivor.renamed = true;
    }
    this.afterChange(room);
    this.broadcast(room);
    this.broadcastStats(room);
    return { key: kept, name: finalName, merged: all.length, removed };
  }

  /**
   * The admin gives someone a name: a player in the room (by player id), or a
   * record of someone who is not (by stats key). The player's browser does not
   * get to change it back just by reconnecting. Returns { name } or { error }.
   */
  renamePerson(room, { id = null, key = null }, raw) {
    const name = cleanName(raw);
    if (!name) return { error: 'A name needs at least one character.' };
    const p = id ? room.players.get(text(id)) : null;
    if (id && !p) return { error: 'That player has already left.' };
    if ([...room.players.values()].some((x) => x !== p && x.name.toLowerCase() === name.toLowerCase())) return { error: 'Someone else in this room already has that name.' };
    let was;
    if (p) {
      was = p.name;
      p.name = name;
      p.renamed = true;
      const s = (room.stats ?? {})[this.statKeyOf(room, p)];
      if (s) s.name = name;
    } else {
      const s = (room.stats ?? {})[this.resolveStatKey(room, text(key))];
      if (!s) return { error: 'That player’s record is no longer here.' };
      was = s.name;
      s.name = name;
    }
    this.scheduleSave();
    this.broadcast(room);
    this.broadcastStats(room);
    return { name, was };
  }

  // ───────────────────────── chat ─────────────────────────

  /**
   * Someone says something to the room. Everyone with the room open gets it at
   * once; anyone who is not looking (and has notifications on) is sent a
   * notification instead. Returns an error or null.
   */
  say(room, player, raw) {
    const body = cleanChat(raw);
    if (!body) return 'Type a message first.';
    // A few at a time is talking; a stream of them is not.
    const recent = (player.said ?? []).filter((at) => now() - at < 10_000);
    if (recent.length >= CHAT_BURST) return 'That’s a lot of messages. Give it a few seconds.';
    player.said = [...recent, now()];

    room.chat ??= [];
    room.chatSeq = (room.chatSeq ?? 0) + 1;
    const message = { id: room.chatSeq, by: player.id, name: player.name, color: player.color, text: body, at: now() };
    room.chat.push(message);
    if (room.chat.length > CHAT_KEEP) room.chat.splice(0, room.chat.length - CHAT_KEEP);

    const payload = JSON.stringify({ t: 'chat', m: message });
    for (const p of room.players.values()) {
      for (const socket of p.sockets) {
        if (socket.readyState === 1) socket.send(payload);
      }
      if (p.id === player.id || p.bot || !p.push || this.watching(p)) continue;
      if (now() - (p.chatPushedAt ?? 0) < CHAT_PUSH_GAP_MS) continue;
      p.chatPushedAt = now();
      // Its own tag and topic, so it never takes the place of a "your turn" that is still waiting.
      this.notify(room, p, { kind: 'chat', title: `${player.name} in ${room.code}`, body }, { tag: `swipe-chat-${room.code}`, topic: 'chat' });
    }
    this.touch(room);
    return null;
  }

  /** Sends one notification and forgets the subscription if the browser has dropped it. */
  notify(room, player, message, { tag = `swipe-${room.code}`, topic: about = 'turn' } = {}) {
    const target = player.push;
    if (!config.push || !target) return;
    const payload = { ...message, room: room.code, url: `r/${room.code}`, tag };
    const topic = createHash('sha256')
      .update(about === 'turn' ? `${room.code}:${player.id}` : `${about}:${room.code}:${player.id}`)
      .digest('base64url')
      .slice(0, 24);
    Promise.resolve(this.sendPush(target, payload, { ttl: 600, topic, origin: player.origin ?? null }))
      .then((result) => {
        if (result !== 'gone' || player.push !== target) return;
        player.push = null;
        this.touch(room);
        this.sendTo(room, player);
      })
      .catch(() => {});
  }

  disconnect(room, player, socket) {
    player.sockets.delete(socket);
    if (room.gone) return;
    if (!this.watching(player)) this.lookedAway(room, player);
    if (player.sockets.size > 0) return;
    player.online = false;
    player.seenAt = now();
    const anyone = humansOnline(room);
    const r = room.round;
    if (!anyone && r && r.deadline && r.phase === 'play') {
      r.pausedLeft = Math.max(1000, r.deadline - now());
      r.deadline = null;
      r.autoPaused = true;
    }
    this.syncTimer(room);
    if (player.id === room.hostId && anyone) {
      setTimeout(() => {
        if (this.ensureHost(room)) this.broadcast(room);
      }, HOST_HANDOVER_MS + 500).unref?.();
    }
    this.touch(room);
    this.broadcast(room);
  }

  /** Makes sure the room has a reachable host. Returns true if it changed. */
  ensureHost(room) {
    const host = room.players.get(room.hostId);
    if (host && (host.online || now() - host.seenAt < HOST_HANDOVER_MS)) return false;
    const next = [...room.players.values()].filter((p) => p.online && !p.bot).sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (!next || next.id === room.hostId) return false;
    room.hostId = next.id;
    return true;
  }

  freeName(room, name, exceptId) {
    const taken = new Set([...room.players.values()].filter((p) => p.id !== exceptId).map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; n < 100; n++) {
      const candidate = `${name.slice(0, 17)} ${n}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return `${name.slice(0, 14)} ${randomInt(1000)}`;
  }

  // ───────────────────────── views ─────────────────────────

  /**
   * The room as one player is allowed to see it. Faces are only ever sent to
   * someone who could see them at a real table: your own hand, everyone's
   * face-up row, a blind card once it has been flipped, and the cards on top
   * of the pile. Everything else leaves the server as a card back.
   */
  viewFor(room, me) {
    const r = room.round;
    const m = room.match;
    let round = null;
    if (r) {
      const over = r.phase === 'over';
      const seats = {};
      for (const pid of r.order) {
        const s = r.seats[pid];
        const flipped = r.pending?.pid === pid ? r.pending.slot : -1;
        seats[pid] = {
          hand: s.hand.length,
          // Backs only, in an order that has nothing to do with the faces.
          backs: s.hand
            .slice()
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .map((c) => c.b),
          up: s.up,
          blind: s.blind.map((c, i) => (c ? (i === flipped ? c : { b: c.b }) : null)),
          left: game.cardsLeft(s),
        };
      }
      const top = game.topOf(r.pile);
      const under = r.pile.length - top.run;
      round = {
        id: r.id,
        no: r.no,
        phase: r.phase,
        order: r.order,
        turn: game.current(r),
        turnNo: r.turnNo,
        pending: r.pending,
        // The run on top is face up for everyone. The cards beneath it are
        // sent as backs only: enough of them to draw the heap. Every card in
        // the pile was played face up, so how many of each rank it holds is
        // no secret, and anyone may ask (tap the pile). Their order and suits
        // stay buried.
        pile: {
          count: r.pile.length,
          top: r.pile.slice(under),
          backs: r.pile.slice(Math.max(0, under - PILE_BACKS), under).map((c) => c.b),
          ranks: tally(r.pile),
        },
        burned: r.burned,
        decks: r.decks,
        seats,
        mine: r.seats[me.id]?.hand ?? null,
        start: r.start,
        last: r.last,
        log: r.log,
        winner: r.winner,
        reason: r.reason,
        result: over ? r.result : null,
        readyAt: r.readyAt,
        deadline: r.deadline,
        pausedLeft: r.pausedLeft,
      };
    }
    return {
      code: room.code,
      now: now(),
      you: me.id,
      hostId: room.hostId,
      locked: room.locked,
      settings: room.settings,
      limits: { min: game.MIN_PLAYERS, max: game.MAX_PLAYERS },
      notify: Boolean(me.push), // turn notifications are on for this player's browser
      players: [...room.players.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((p) => ({ id: p.id, name: p.name, color: p.color, online: p.online, bot: p.bot, playing: p.playing })),
      match: m
        ? { gameNo: m.gameNo, order: m.order, scores: m.scores, over: m.over, champions: m.champions, history: m.history.slice(-40) }
        : null,
      round,
    };
  }

  /** One player's view, to that player only. */
  sendTo(room, player) {
    if (!room.players.has(player.id)) return;
    const payload = JSON.stringify({ t: 'state', s: this.viewFor(room, player) });
    for (const socket of player.sockets) {
      if (socket.readyState === 1) socket.send(payload);
    }
  }

  broadcast(room) {
    for (const player of room.players.values()) {
      if (player.sockets.size === 0) continue;
      const payload = JSON.stringify({ t: 'state', s: this.viewFor(room, player) });
      for (const socket of player.sockets) {
        if (socket.readyState === 1) socket.send(payload);
      }
    }
  }

  // ───────────────────────── clock and computer players ─────────────────────────

  syncTimer(room) {
    clearTimeout(room.timer);
    clearTimeout(room.botTimer);
    room.timer = null;
    room.botTimer = null;
    const r = room.round;
    if (!r || r.phase === 'over') return;

    if (r.phase === 'deal') {
      room.timer = setTimeout(() => {
        if (room.round !== r || r.phase !== 'deal') return;
        r.phase = 'play';
        this.afterChange(room);
        this.broadcast(room);
      }, Math.max(0, (r.readyAt ?? 0) - now()) + 20);
      room.timer.unref?.();
      return;
    }

    const anyone = humansOnline(room);
    const mover = room.players.get(game.current(r));
    const key = `${r.id}:${r.turnNo}`;
    if (r.timerKey !== key) {
      r.timerKey = key;
      const secs = mover?.bot ? 0 : room.settings.turnSeconds;
      r.pausedLeft = null;
      r.autoPaused = false;
      r.deadline = secs > 0 ? now() + secs * 1000 : null;
      if (r.deadline && !anyone) {
        r.pausedLeft = secs * 1000;
        r.deadline = null;
        r.autoPaused = true;
      }
    }

    if (mover?.bot) {
      // Computer players only move while somebody is there to watch, and they
      // wait out the animations a move sets off on everyone's screen.
      if (!anyone || (r.pausedLeft != null && !r.autoPaused)) return;
      const e = r.last;
      const pace = config.botDelayMs;
      let wait = pace + randomInt(Math.round(pace * 0.7) + 1);
      if (e.kind === 'flip') wait = Math.round(pace * 1.6);
      else if (e.kind === 'skip' || (e.kind === 'play' && (e.effect === 'swipe' || e.pickup))) wait += Math.round(pace * 1.1);
      room.botTimer = setTimeout(() => this.autoTurn(room, r), wait);
      room.botTimer.unref?.();
      return;
    }
    if (r.deadline) {
      room.timer = setTimeout(() => this.onTimeout(room), Math.max(0, r.deadline - now()) + 30);
      room.timer.unref?.();
    }
  }

  /**
   * The turn clock ran out. The player is skipped: nothing is played for them,
   * they draw penalty cards (see game.skip) and play passes on. The one
   * exception is a blind card they have already flipped, which is committed
   * and goes down on its own.
   */
  onTimeout(room) {
    const r = room.round;
    if (!r || r.phase !== 'play' || !r.deadline || r.deadline - now() > 250) return;
    const pid = game.current(r);
    if (r.pending) {
      // (flipDue: the flip was made for them a moment ago, by the host; nobody ran out of time.)
      if (!r.flipDue) game.note(r, { k: 'timeout', by: pid });
      game.play(r, pid, [r.seats[pid].blind[r.pending.slot].id]);
    } else {
      game.skip(r, pid);
    }
    r.flipDue = false;
    this.afterChange(room);
    this.broadcast(room);
  }

  /** Makes a move for whoever's turn it is. */
  autoTurn(room, r) {
    if (room.round !== r || r.phase !== 'play') return 'There is no turn to play.';
    const res = game.autoPlay(r, game.current(r));
    if (!res.ok) {
      log.warn(`Auto move failed in ${room.code}: ${res.error}`);
      return res.error;
    }
    this.settleFlip(room, r);
    // A flipped blind card stays on show for a moment before it is played.
    // (Computer players pace themselves in syncTimer.)
    if (r.pending && !room.players.get(game.current(r))?.bot) {
      r.deadline = now() + FLIP_PAUSE_MS;
      r.pausedLeft = null;
      r.flipDue = true;
    }
    this.afterChange(room);
    this.broadcast(room);
    return null;
  }

  /**
   * A flipped ten plays itself. Everyone is sent the flip first, so they see
   * the card turn over, and then the swipe that follows straight after it.
   */
  settleFlip(room, r) {
    if (!game.flippedTen(r)) return;
    this.broadcast(room);
    game.playFlippedTen(r);
  }

  /** Bookkeeping after anything that may have moved the game on. */
  afterChange(room) {
    const r = room.round;
    const m = room.match;
    if (r && r.phase === 'over' && !r.scored) {
      r.scored = true;
      if (m && r.reason === 'out') {
        for (const pid of r.order) m.scores[pid] = (m.scores[pid] ?? 0) + r.result.points[pid];
        m.lastWinner = r.winner;
        m.history.push({ no: r.no, winner: r.winner, points: r.result.points });
        if (m.history.length > 200) m.history.shift();
        this.recordGame(room, r);
        this.checkMatch(room);
      }
    }
    this.syncTimer(room);
    this.alertTurn(room);
    this.touch(room);
  }

  /** The match ends when someone reaches the limit; the lowest score takes it. */
  checkMatch(room) {
    const m = room.match;
    if (!m || m.over || m.gameNo === 0 || live(room)) return;
    const scores = m.order.map((pid) => m.scores[pid] ?? 0);
    if (scores.length && scores.some((s) => s >= room.settings.limit)) {
      const low = Math.min(...scores);
      m.over = true;
      m.champions = m.order.filter((pid) => (m.scores[pid] ?? 0) === low);
    }
  }

  // ───────────────────────── the table ─────────────────────────

  /** Takes someone out of the match. If cards are out, theirs leave the game. */
  unseat(room, player) {
    player.playing = false;
    const m = room.match;
    if (m) m.order = m.order.filter((id) => id !== player.id);
    const r = room.round;
    if (r && r.phase !== 'over') game.drop(r, player.id, player.name);
  }

  startGame(room) {
    if (live(room)) return 'A game is still being played.';
    let m = room.match;
    if (!m || m.over) {
      m = { id: newId(), gameNo: 0, order: [], scores: {}, history: [], over: false, champions: [], lastWinner: null };
      // A new match is for the people who are here. Anyone who closed the tab
      // a while ago watches instead of holding up the first turn.
      for (const p of room.players.values()) {
        if (p.playing && !p.bot && !p.online && now() - p.seenAt > STALE_SEAT_MS) p.playing = false;
      }
    }
    // Who is playing this game: everyone still seated, and anyone who has just
    // sat down. The seating itself is shuffled for every game (game.createRound).
    const keep = m.order.filter((pid) => room.players.get(pid)?.playing);
    const fresh = seated(room)
      .map((p) => p.id)
      .filter((pid) => !keep.includes(pid));
    const order = [...keep, ...fresh];
    if (order.length < game.MIN_PLAYERS) {
      return `Swipe needs at least ${game.MIN_PLAYERS} players. Share the link, or add a computer player.`;
    }
    if (order.length > game.MAX_PLAYERS) return `Swipe seats ${game.MAX_PLAYERS} at most. Ask a few people to watch this one.`;

    // Latecomers start on the table average so nobody strolls in at zero.
    const average = keep.length && m.gameNo > 0 ? Math.round(keep.reduce((sum, pid) => sum + (m.scores[pid] ?? 0), 0) / keep.length) : 0;
    for (const pid of fresh) m.scores[pid] = Math.max(m.scores[pid] ?? 0, average);
    for (const pid of keep) m.scores[pid] ??= 0;

    m.order = order;
    m.gameNo += 1;
    room.match = m;
    // Who leads is decided by the cards, every game: see game.leadTotal.
    room.round = game.createRound({ players: order, no: m.gameNo });
    room.round.readyAt = now() + config.dealMs; // play opens when the shuffle-and-deal sequence is done
    return null;
  }

  addBot(room) {
    const bots = [...room.players.values()].filter((p) => p.bot);
    if (bots.length >= MAX_BOTS || room.players.size >= config.maxPlayers) return 'That is enough computer players.';
    const used = new Set([...room.players.values()].map((p) => p.name.toLowerCase()));
    const names = BOT_NAMES.filter((n) => !used.has(n.toLowerCase()));
    const name = names.length ? names[randomInt(names.length)] : this.freeName(room, 'Robot');
    const bot = {
      id: newId(),
      token: null,
      name,
      color: this.freeColor(room),
      bot: true,
      playing: seated(room).length < game.MAX_PLAYERS,
      online: true,
      sockets: new Set(),
      joinedAt: now(),
      seenAt: now(),
    };
    room.players.set(bot.id, bot);
    return null;
  }

  // ───────────────────────── settings ─────────────────────────

  applySettings(room, patch) {
    if (!patch || typeof patch !== 'object') return 'Nothing to change.';
    const next = { ...room.settings };
    const intIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
    if ('limit' in patch) {
      if (!intIn(patch.limit, 20, 1000)) return 'The points limit can be anything from 20 to 1000.';
      next.limit = patch.limit;
    }
    if ('turnSeconds' in patch) {
      if (!(patch.turnSeconds === 0 || intIn(patch.turnSeconds, 10, 600))) return 'The turn clock runs from 10 seconds to 10 minutes, or off.';
      next.turnSeconds = patch.turnSeconds;
    }
    const clockChanged = next.turnSeconds !== room.settings.turnSeconds;
    room.settings = next;
    if (clockChanged && room.round) room.round.timerKey = null;
    // Raising the limit after the final whistle lets the same match carry on.
    const m = room.match;
    if (m?.over && m.order.every((pid) => (m.scores[pid] ?? 0) < next.limit)) {
      m.over = false;
      m.champions = [];
    }
    this.checkMatch(room);
    return null;
  }

  // ───────────────────────── actions ─────────────────────────

  /** Handles one message from a player. Returns an error string or null. */
  act(room, me, msg) {
    if (room.gone) return 'This room has been closed.';
    const isHost = me.id === room.hostId;
    const hostOnly = () => (isHost ? null : 'Only the host can do that.');
    const r = room.round;
    const target = () => room.players.get(text(msg.id));
    let err = null;

    switch (msg.a) {
      case 'rename': {
        const name = cleanName(msg.name);
        if (!name) return 'Names need at least one character.';
        me.name = this.freeName(room, name, me.id);
        me.renamed = false; // their own choice again, whatever the admin had set
        this.broadcastStats(room);
        break;
      }
      case 'recolor': {
        // Something different from what they have now, and from everyone else.
        const old = me.color;
        for (let i = 0; i < 8 && me.color === old; i++) me.color = this.freeColor(room, me.id);
        this.broadcastStats(room);
        break;
      }
      // Notifications are between one player and the server: nobody else hears about them.
      case 'push':
        return this.setPush(room, me, msg.sub);
      // Talk reaches everyone in the room, but it is not a move: nothing about the game changes.
      case 'chat':
        return this.say(room, me, msg.text);
      case 'pushTest':
        if (!me.push) return 'Turn notifications are off in this browser.';
        this.notify(room, me, { kind: 'test', title: 'Notifications are on', body: 'You’ll get one of these when it’s your turn, or someone sends a message, and you’re not looking.' });
        return null;

      case 'sit': {
        const on = Boolean(msg.on);
        if (on === me.playing) break;
        if (!on) this.unseat(room, me);
        else if (seated(room).length >= game.MAX_PLAYERS) return `The table is full: Swipe seats ${game.MAX_PLAYERS}.`;
        else me.playing = true;
        break;
      }

      // ── playing cards ──
      case 'flip': {
        if (!r) return 'The game has not started.';
        const res = game.flip(r, me.id, Number(msg.slot));
        if (!res.ok) return res.error;
        this.settleFlip(room, r);
        break;
      }
      case 'play': {
        if (!r) return 'The game has not started.';
        const res = game.play(r, me.id, msg.cards);
        if (!res.ok) return res.error;
        break;
      }

      // ── host controls ──
      case 'start':
        err = hostOnly() ?? this.startGame(room);
        break;
      case 'endGame':
        err = hostOnly();
        if (!err && r) game.abandon(r);
        break;
      case 'lobby':
        err = hostOnly();
        if (!err) {
          if (live(room)) game.abandon(r);
          this.afterChange(room);
          room.round = null;
          room.match = null;
        }
        break;
      case 'settings':
        err = hostOnly() ?? this.applySettings(room, msg.patch);
        break;
      case 'lock':
        err = hostOnly();
        if (!err) room.locked = Boolean(msg.on);
        break;
      case 'addBot':
        err = hostOnly() ?? this.addBot(room);
        break;
      case 'auto': {
        // Play the current turn for someone who has wandered off.
        err = hostOnly();
        if (!err && (!r || r.phase !== 'play')) err = 'There is no turn to play.';
        if (!err && game.current(r) === me.id) err = 'That is your own turn. Pick your cards.';
        if (!err) return this.autoTurn(room, r);
        break;
      }
      case 'bench': {
        err = hostOnly();
        const p = target();
        if (!err && !p) err = 'That player has left.';
        if (!err) this.unseat(room, p);
        break;
      }
      case 'giveHost': {
        err = hostOnly();
        const p = target();
        if (!err && (!p || p.bot)) err = 'That player can’t host.';
        if (!err) room.hostId = p.id;
        break;
      }
      case 'kick': {
        err = hostOnly();
        const p = target();
        if (!err && (!p || p.id === me.id)) err = 'You can’t remove that player.';
        if (!err) this.kick(room, p);
        break;
      }
      case 'pause': {
        err = hostOnly();
        if (!err && r && r.phase === 'play') {
          if (msg.on && r.deadline) {
            r.pausedLeft = Math.max(0, r.deadline - now());
            r.deadline = null;
            r.autoPaused = false;
          } else if (!msg.on && r.pausedLeft != null) {
            r.deadline = now() + r.pausedLeft;
            r.pausedLeft = null;
          }
        }
        break;
      }
      case 'addTime': {
        err = hostOnly();
        const secs = Number(msg.secs);
        if (!err && r && Number.isFinite(secs) && Math.abs(secs) <= 600) {
          if (r.deadline) r.deadline = Math.max(now() + 1000, r.deadline + secs * 1000);
          else if (r.pausedLeft != null) r.pausedLeft = Math.max(1000, r.pausedLeft + secs * 1000);
        }
        break;
      }
      default:
        return 'Unknown action.';
    }

    if (err) return err;
    this.afterChange(room);
    this.broadcast(room);
    return null;
  }

  // ───────────────────────── persistence ─────────────────────────

  scheduleSave() {
    if (!config.persist || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 1500);
    this.saveTimer.unref?.();
  }

  serialize() {
    return [...this.rooms.values()].map((room) => {
      const { players, timer, botTimer, gone, ...rest } = room;
      return {
        ...rest,
        // (Addresses and browsers are for the admin page while someone is connected. They are not written to disk.)
        players: [...players.values()].map(({ sockets, ip, ua, said, chatPushedAt, ...p }) => ({ ...p, online: Boolean(p.bot) })),
      };
    });
  }

  save() {
    if (!config.persist) return;
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: now(), rooms: this.serialize() }));
      fs.renameSync(tmp, this.file);
      this.savedAt = now();
      this.saveError = null;
    } catch (err) {
      this.saveError = err.message;
      log.warn(`Could not save rooms: ${err.message}`);
    }
  }

  load() {
    if (!config.persist) return;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return;
    }
    for (const saved of data.rooms ?? []) {
      // A room past its time is not brought back, with one exception: a room
      // with a date that was in use when the server stopped. Nobody is removed
      // from a room they are in, so it returns, and goes once it is empty.
      const due = this.expiresAt(saved);
      const inUseAtStop = Number.isFinite(saved.expiry) && (data.savedAt ?? 0) - saved.lastActive < 10 * 60_000;
      if (due != null && now() > due && !inUseAtStop) continue;
      if (this.rooms.has(saved.code)) continue;
      const room = {
        ...saved,
        expiry: saved.expiry ?? null,
        aliases: (saved.aliases ?? []).filter((a) => typeof a === 'string' && a !== saved.code),
        chat: Array.isArray(saved.chat) ? saved.chat.slice(-CHAT_KEEP) : [],
        stats: saved.stats && typeof saved.stats === 'object' ? saved.stats : {},
        statAlias: saved.statAlias && typeof saved.statAlias === 'object' ? saved.statAlias : {},
        settings: { ...defaultSettings(), ...saved.settings },
        players: new Map(saved.players.map((p) => [p.id, { ...p, online: Boolean(p.bot), sockets: new Set() }])),
      };
      const r = room.round;
      if (r && r.deadline) {
        // The clock does not run while the server is down.
        r.pausedLeft = Math.max(1000, r.deadline - (data.savedAt ?? now()));
        r.deadline = null;
        r.autoPaused = true;
      }
      this.rooms.set(room.code, room);
      this.syncTimer(room);
    }
    // Earlier names, unless something else has since taken them.
    for (const room of this.rooms.values()) {
      room.aliases = room.aliases.filter((a) => !this.rooms.has(a) && !this.aliases.has(a));
      for (const a of room.aliases) this.aliases.set(a, room.code);
    }
    this.savedAt = data.savedAt ?? null;
    log.info(`Restored ${this.rooms.size} rooms from disk`);
  }
}
