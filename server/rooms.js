// Rooms, players, seats at the table, host controls, computer players, the
// turn clock and persistence. The rules themselves live in game.js; this file
// decides *who* may do *what*, keeps the running score across games, and
// builds what each person is allowed to see.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import * as game from './game.js';
import { config, log } from './config.js';
import { roomCode } from './names.js';

const HOST_HANDOVER_MS = 45_000; // an offline host is replaced after this
const FLIP_PAUSE_MS = Math.min(1_600, Math.round(config.botDelayMs * 1.6)); // a beat for the table to see a flipped blind card
const STALE_SEAT_MS = 120_000; // offline this long when a new match is dealt: you watch
const MAX_BOTS = 23;
const PILE_BACKS = 16; // how many buried pile cards the browser draws

// One accent colour per player. The first twelve are the easiest to tell
// apart, so small tables draw from those before the rest are used.
export const COLORS = [
  '#e5484d', '#f76b15', '#ffb224', '#9bd12c', '#12a594', '#3b9eff', '#3e63dd', '#9a4fd0', '#ee5a8e', '#46a758', '#05a2c2', '#b8804f',
  '#f2d50f', '#d23197', '#7c66dc', '#ff8dcc', '#ff9a85', '#3dd68c', '#7ce2fe', '#b1a9ff', '#9a9cab', '#c9b458', '#6f8f3f', '#7d5a44',
];
const BOT_NAMES = `Riffle Deuce Trey Queenie Maverick Lucky Slim Duchess Bluff Shark Pips Rounder Ante Dolly Kitty Whist Gambit Ruff Flush Tally Marker Knave Parlor`.split(' ');

const now = () => Date.now();
const newId = () => randomBytes(6).toString('base64url');

export function cleanName(raw) {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
}

const defaultSettings = () => ({
  limit: 100, // a match ends when somebody's running score reaches this
  turnSeconds: 0, // 0 = no clock
});

const live = (room) => Boolean(room.round && room.round.phase !== 'over');
const humansOnline = (room) => [...room.players.values()].some((p) => p.online && !p.bot);
const seated = (room) => [...room.players.values()].filter((p) => p.playing).sort((a, b) => a.joinedAt - b.joinedAt);

export class Rooms {
  constructor() {
    this.rooms = new Map();
    this.saveTimer = null;
    this.file = path.join(config.dataDir, 'rooms.json');
  }

  // ───────────────────────── lifecycle ─────────────────────────

  create() {
    if (this.rooms.size >= config.maxRooms) this.sweep(true);
    if (this.rooms.size >= config.maxRooms) return null;
    let code = roomCode();
    while (this.rooms.has(code)) code = roomCode();
    const room = {
      code,
      createdAt: now(),
      lastActive: now(),
      hostId: null,
      locked: false,
      settings: defaultSettings(),
      players: new Map(),
      banned: [],
      match: null, // a run of games played to the points limit
      round: null, // the game on the table right now
    };
    this.rooms.set(code, room);
    this.touch(room);
    return room;
  }

  get(code) {
    return this.rooms.get(code);
  }

  touch(room) {
    room.lastActive = now();
    this.scheduleSave();
  }

  /** Drop rooms nobody has used for a while. */
  sweep(aggressive = false) {
    const ttl = config.roomTtlHours * 3600_000;
    for (const room of this.rooms.values()) {
      const online = humansOnline(room);
      const idle = now() - room.lastActive;
      if (!online && (idle > ttl || (aggressive && idle > 3600_000))) {
        clearTimeout(room.timer);
        clearTimeout(room.botTimer);
        this.rooms.delete(room.code);
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
        }
      }
    }
    this.scheduleSave();
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
  connect(room, { token, name }, socket) {
    if (room.banned.includes(token)) return { code: 'banned', error: 'The host removed you from this room.' };
    let player = [...room.players.values()].find((p) => p.token === token);
    if (!player) {
      const nick = cleanName(name);
      if (!nick) return { code: 'name', error: 'Pick a name to join.' };
      if (room.locked) return { code: 'locked', error: 'This room is locked. Ask the host to unlock it.' };
      if (room.players.size >= config.maxPlayers) return { code: 'full', error: 'This room is full.' };
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
    } else if (name && cleanName(name) && cleanName(name) !== player.name) {
      player.name = this.freeName(room, cleanName(name), player.id);
    }
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
    return { player };
  }

  disconnect(room, player, socket) {
    player.sockets.delete(socket);
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
        // sent as backs only: enough of them to draw the heap.
        pile: {
          count: r.pile.length,
          top: r.pile.slice(under),
          backs: r.pile.slice(Math.max(0, under - PILE_BACKS), under).map((c) => c.b),
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
      players: [...room.players.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((p) => ({ id: p.id, name: p.name, color: p.color, online: p.online, bot: p.bot, playing: p.playing })),
      match: m
        ? { gameNo: m.gameNo, order: m.order, scores: m.scores, over: m.over, champions: m.champions, history: m.history.slice(-40) }
        : null,
      round,
    };
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
      else if (e.kind === 'play' && (e.effect === 'swipe' || e.pickup)) wait += Math.round(pace * 1.1);
      room.botTimer = setTimeout(() => this.autoTurn(room, r), wait);
      room.botTimer.unref?.();
      return;
    }
    if (r.deadline) {
      room.timer = setTimeout(() => this.onTimeout(room), Math.max(0, r.deadline - now()) + 30);
      room.timer.unref?.();
    }
  }

  onTimeout(room) {
    const r = room.round;
    if (!r || r.phase !== 'play' || !r.deadline || r.deadline - now() > 250) return;
    if (!r.pending) game.note(r, { k: 'timeout', by: game.current(r) });
    this.autoTurn(room, r);
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
        this.checkMatch(room);
      }
    }
    this.syncTimer(room);
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
    // Seats run clockwise in the order people sat down. Anyone joining a match
    // that is already under way is added at the end.
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
    // Whoever went out last time leads. The very first lead goes to the
    // highest hand, which createRound works out when `first` is empty.
    const first = m.lastWinner && order.includes(m.lastWinner) ? m.lastWinner : null;
    room.round = game.createRound({ players: order, first, no: m.gameNo });
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
    const isHost = me.id === room.hostId;
    const hostOnly = () => (isHost ? null : 'Only the host can do that.');
    const r = room.round;
    const target = () => room.players.get(String(msg.id ?? ''));
    let err = null;

    switch (msg.a) {
      case 'rename': {
        const name = cleanName(msg.name);
        if (!name) return 'Names need at least one character.';
        me.name = this.freeName(room, name, me.id);
        break;
      }
      case 'recolor': {
        // Something different from what they have now, and from everyone else.
        const old = me.color;
        for (let i = 0; i < 8 && me.color === old; i++) me.color = this.freeColor(room, me.id);
        break;
      }
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
        if (!err) {
          if (p.token) room.banned.push(p.token);
          this.unseat(room, p);
          room.players.delete(p.id);
          for (const socket of p.sockets) {
            try {
              socket.send(JSON.stringify({ t: 'kicked' }));
              socket.close(4001, 'kicked');
            } catch {}
          }
        }
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
      const { players, timer, botTimer, ...rest } = room;
      return {
        ...rest,
        players: [...players.values()].map(({ sockets, ...p }) => ({ ...p, online: Boolean(p.bot) })),
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
    } catch (err) {
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
    const ttl = config.roomTtlHours * 3600_000;
    for (const saved of data.rooms ?? []) {
      if (now() - saved.lastActive > ttl) continue;
      const room = {
        ...saved,
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
    log.info(`Restored ${this.rooms.size} rooms from disk`);
  }
}
