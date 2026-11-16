// The au12 Arcade (github.com/au12/arcade), when Swipe is one of its games.
//
// js/vendor/arcade.js is the arcade's own script. In the arcade's frame it
// learns who is playing; opened on its own it asks the arcade named in
// /arcade.json. Without an arcade every call here quietly does nothing.

import { store } from './util.js';

const A = globalThis.Arcade ?? null;

/** Waits for the arcade to say who is playing, but not for long. */
export function arcadeReady(ms = 1500) {
  if (!A) return Promise.resolve(null);
  return Promise.race([A.ready, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
}

/** The arcade player's name, for the name box. */
export const arcadeName = () => (A?.player?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 20);

/**
 * A storage key that belongs to whoever is playing, so each person at a shared
 * arcade cabinet keeps a seat and a name of their own. The first arcade player
 * on a browser keeps the plain keys (the seat they already had there); anyone
 * else, a guest in the arcade's frame and everyone on a kiosk gets their own.
 */
export function personal(key) {
  if (!A || (A.mode !== 'embedded' && A.mode !== 'direct')) return key;
  const id = A.player?.id;
  if (!id) return A.mode === 'embedded' ? `${key}@guest` : key;
  if (A.kiosk) return `${key}@${id}`;
  let owner = store.get('arcadeOwner');
  if (!owner) store.set('arcadeOwner', (owner = id));
  return owner === id ? key : `${key}@${id}`;
}

let lastStatus = '';
/** What the game is doing: 'menu', 'playing' or 'over'. */
export function arcadeStatus(status) {
  if (!A || status === lastStatus) return;
  lastStatus = status;
  A.status(status);
}

/** The room's link, shown as a QR code on the arcade cabinet so phones can join. */
export function arcadeInvite(url) {
  A?.invite(url, url ? 'Scan to join this table' : '');
}

const reported = new Set();

/**
 * Reports the end of a game you were dealt into (a win or a loss), and the end
 * of the match when the last game decides it. Only a change seen happen here
 * counts: a page opened on an already-finished game reports nothing.
 */
export function arcadeReport(prev, next) {
  if (!A || !prev?.round || !next?.round) return;
  const a = prev.round;
  const r = next.round;
  const me = next.you;
  if (r.phase !== 'over' || a.id !== r.id || a.phase === 'over' || r.reason !== 'out') return;
  if (!r.order?.includes(me) || reported.has(r.id)) return;
  reported.add(r.id);

  const bot = new Set(next.players.filter((p) => p.bot).map((p) => p.id));
  const others = r.order.filter((id) => id !== me);
  const meta = { match: false, players: r.order.length, vs: others.every((id) => bot.has(id)) ? 'bot' : 'people' };
  A.result(r.winner === me ? 'win' : 'loss', { meta });

  const m = next.match;
  if (m?.over && !prev.match?.over && m.order?.includes(me)) {
    A.result(m.champions.includes(me) ? 'win' : 'loss', { meta: { ...meta, match: true, games: m.gameNo } });
  }
}
