// Rules engine. Pure functions over a plain "round" object (one deal of the
// cards, played until somebody goes out) — no sockets, no timers, no I/O — so
// it can be unit-tested and persisted as JSON.
//
// A card is { id, r, s, b }: rank ('A', '2' … '10', 'J', 'Q', 'K'), suit
// (s/h/d/c, which never matters) and back (0 red, 1 blue: the decks are a
// mismatched mix, as they are on a real table).

import { randomInt, randomUUID } from 'node:crypto';
import { RANKS, SET_MAX, SUITS, TEN, judge, order, points, topOf } from '../public/js/rules.js';

export { judge, order, points, topOf };

export const SLOTS = 4; // blind cards, each with a face-up card on top
export const HAND = 12;
export const PER_PLAYER = SLOTS * 2 + HAND; // 20
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 24;
export const SKIP_PENALTY = 3; // cards drawn by a player whose clock runs out
const LOG_MAX = 80;

/** Two decks for up to 4 players, three for 5–6, four for 7–8, and so on. */
export const decksFor = (players) => Math.max(2, Math.ceil(players / 2));

/** Fisher–Yates using a crypto-backed integer source (injectable for tests). */
export function shuffle(list, rnd = randomInt) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** `decks` standard 52-card decks, shuffled together, half red-backed and half blue. */
export function buildDeck(decks, rnd = randomInt) {
  const cards = [];
  for (let d = 0; d < decks; d++) for (const r of RANKS) for (const s of SUITS) cards.push({ r, s });
  // Backs are dealt out evenly and independently of the faces, so a back
  // never says anything about the card behind it.
  shuffle(cards, rnd).forEach((c, i) => (c.b = i % 2));
  return shuffle(cards, rnd).map((c, i) => ({ id: i.toString(36), r: c.r, s: c.s, b: c.b }));
}

const handTotal = (cards) => cards.reduce((sum, c) => sum + points(c.r), 0);

/**
 * Deals a round. `first` is the player who leads; leave it out and the lead
 * goes to whoever holds the highest total of card values in hand.
 */
export function createRound({ players, first = null, no = 1, rnd = randomInt }) {
  if (players.length < 2) throw new Error('Swipe needs at least two players');
  if (players.length > MAX_PLAYERS) throw new Error('Too many players');

  const decks = decksFor(players.length);
  const deck = buildDeck(decks, rnd);
  const seats = {};
  for (const pid of players) {
    seats[pid] = {
      blind: deck.splice(0, SLOTS),
      up: deck.splice(0, SLOTS),
      hand: deck.splice(0, HAND),
    };
  }

  let start;
  if (first && players.includes(first)) {
    start = { pid: first, why: 'winner', total: null };
  } else {
    const totals = players.map((pid) => handTotal(seats[pid].hand));
    const best = Math.max(...totals);
    const tied = players.filter((_, i) => totals[i] === best);
    start = { pid: tied[rnd(tied.length)], why: 'high', total: best };
  }

  return {
    id: randomUUID().slice(0, 8),
    no,
    phase: 'deal', // deal | play | over
    order: players.slice(),
    turn: players.indexOf(start.pid),
    turnNo: 1,
    seats,
    pile: [],
    burned: 0, // how many cards have been swiped out of the game…
    swiped: [], // …and the cards themselves, kept as a reserve for the stock
    stock: deck, // dealt to nobody. A skipped player draws their penalty from here.
    decks,
    aside: deck.length, // how many cards were left over after the deal
    pending: null, // { pid, slot }: a flipped blind card that must be played now
    start,
    seq: 1,
    last: { seq: 1, kind: 'deal' },
    log: [{ k: 'start', by: start.pid, why: start.why, total: start.total }],
    winner: null,
    reason: null,
    result: null,
    readyAt: null,
    deadline: null,
    pausedLeft: null,
    startedAt: Date.now(),
    endedAt: null,
  };
}

// ───────────────────────── helpers ─────────────────────────

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error) => ({ ok: false, error });

export const current = (r) => r.order[r.turn] ?? null;

export const cardsLeft = (seat) => seat.hand.length + seat.up.filter(Boolean).length + seat.blind.filter(Boolean).length;

export function remaining(seat) {
  return [...seat.hand, ...seat.up.filter(Boolean), ...seat.blind.filter(Boolean)];
}

export function note(r, entry) {
  r.log.push(entry);
  if (r.log.length > LOG_MAX) r.log.splice(0, r.log.length - LOG_MAX);
}

function emit(r, event) {
  r.seq += 1;
  r.last = { seq: r.seq, ...event };
}

function advance(r) {
  r.turn = (r.turn + 1) % r.order.length;
  r.turnNo += 1;
}

function guard(r, pid) {
  if (r.phase === 'deal') return 'The cards are still being dealt.';
  if (r.phase !== 'play') return 'This game is over.';
  if (current(r) !== pid) return 'It is not your turn.';
  return null;
}

function finish(r, { winner = null, reason }) {
  r.phase = 'over';
  r.winner = winner;
  r.reason = reason;
  r.pending = null;
  r.deadline = null;
  r.pausedLeft = null;
  r.endedAt = Date.now();
  const pts = {};
  const left = {};
  for (const pid of r.order) {
    left[pid] = remaining(r.seats[pid]);
    pts[pid] = handTotal(left[pid]);
  }
  r.result = { points: pts, left };
}

// ───────────────────────── moves ─────────────────────────

/**
 * Turn over a blind card. From here on it has to be played this turn, whatever
 * it turns out to be.
 */
export function flip(r, pid, slot) {
  const err = guard(r, pid);
  if (err) return fail(err);
  if (r.pending) return fail('You already flipped a blind card. Play it first.');
  const seat = r.seats[pid];
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS || !seat.blind[slot]) return fail('There is no blind card there.');
  if (seat.up[slot]) return fail('Play the face-up card on top of it first.');
  r.pending = { pid, slot };
  const card = seat.blind[slot];
  note(r, { k: 'flip', by: pid, r: card.r });
  emit(r, { kind: 'flip', by: pid, slot, card });
  return ok({ card });
}

/**
 * Play one to four equal cards, by id, from the hand, the face-up row, or a
 * blind card that has just been flipped.
 */
export function play(r, pid, ids) {
  const err = guard(r, pid);
  if (err) return fail(err);
  if (!Array.isArray(ids) || ids.length < 1) return fail('Pick at least one card.');
  if (ids.length > SET_MAX) return fail('A set is four cards at most.');
  const want = ids.map(String);
  if (new Set(want).size !== want.length) return fail('Pick each card once.');

  const seat = r.seats[pid];
  const picked = [];
  for (const id of want) {
    const inHand = seat.hand.find((c) => c.id === id);
    if (inHand) {
      picked.push({ card: inHand, from: 'hand' });
      continue;
    }
    const upSlot = seat.up.findIndex((c) => c && c.id === id);
    if (upSlot !== -1) {
      picked.push({ card: seat.up[upSlot], from: 'up', slot: upSlot });
      continue;
    }
    const blindSlot = seat.blind.findIndex((c) => c && c.id === id);
    if (blindSlot !== -1 && r.pending && r.pending.slot === blindSlot) {
      picked.push({ card: seat.blind[blindSlot], from: 'blind', slot: blindSlot });
      continue;
    }
    return fail('You do not have that card.');
  }

  const rank = picked[0].card.r;
  if (picked.some((p) => p.card.r !== rank)) return fail('Cards played together have to be the same rank.');
  if (r.pending && !picked.some((p) => p.from === 'blind')) return fail('You flipped a blind card, so it has to be played now.');

  const verdict = judge(topOf(r.pile), rank, picked.length);
  if (!verdict.ok) return verdict;

  for (const p of picked) {
    if (p.from === 'hand') seat.hand.splice(seat.hand.indexOf(p.card), 1);
    else seat[p.from][p.slot] = null;
  }
  r.pending = null;

  // Too high: the pile comes home first, then the cards start a new one.
  let pickup = 0;
  if (verdict.effect === 'pickup') {
    pickup = r.pile.length;
    seat.hand.push(...r.pile);
    r.pile = [];
  }
  r.pile.push(...picked.map((p) => p.card));

  let swiped = 0;
  if (verdict.effect === 'swipe') {
    swiped = r.pile.length;
    (r.swiped ??= []).push(...r.pile);
    r.burned += swiped;
    r.pile = [];
  }

  const out = cardsLeft(seat) === 0;
  note(r, {
    k: 'play',
    by: pid,
    r: rank,
    n: picked.length,
    effect: verdict.effect,
    swipe: verdict.swipe,
    again: verdict.again && !out,
    pickup,
    swiped,
    blind: picked.some((p) => p.from === 'blind'),
  });
  emit(r, {
    kind: 'play',
    by: pid,
    cards: picked.map((p) => ({ ...p.card, from: p.from, slot: p.slot ?? null })),
    effect: verdict.effect,
    swipe: verdict.swipe,
    again: verdict.again && !out,
    pickup,
    swiped,
    out,
  });

  if (out) {
    note(r, { k: 'out', by: pid });
    finish(r, { winner: pid, reason: 'out' });
  } else if (verdict.again) {
    r.turnNo += 1; // same player, fresh turn (and a fresh clock)
  } else {
    advance(r);
  }
  return ok({ effect: verdict.effect, again: verdict.again && !out, out });
}

/**
 * True if the player could have put something on the pile without picking it
 * up: a card that fits, a ten, or four of a kind (which swipes whatever it
 * lands on). Blind cards do not count: flipping one is a gamble, not a play.
 */
export function hasPlay(r, pid) {
  const seat = r.seats[pid];
  const top = topOf(r.pile);
  const counts = new Map();
  for (const c of [...seat.hand, ...seat.up.filter(Boolean)]) counts.set(c.r, (counts.get(c.r) ?? 0) + 1);
  const fits = (rank, n) => {
    const verdict = judge(top, rank, n);
    return verdict.ok && verdict.effect !== 'pickup';
  };
  for (const [rank, n] of counts) {
    if (fits(rank, 1) || (n >= SET_MAX && fits(rank, SET_MAX))) return true;
  }
  return false;
}

/** Takes `n` cards off the stock. When it runs dry, the swiped cards are shuffled back in to refill it. */
function draw(r, n, rnd) {
  r.stock ??= [];
  r.swiped ??= [];
  const cards = [];
  while (cards.length < n) {
    if (r.stock.length === 0) {
      if (r.swiped.length === 0) break; // every card in the game is in somebody's hands or on the pile
      r.stock = shuffle(r.swiped, rnd);
      r.burned -= r.stock.length;
      r.swiped = [];
    }
    cards.push(r.stock.pop());
  }
  return cards;
}

/**
 * The clock ran out before the player did anything. They are skipped: nothing
 * is played, the pile stays where it is and play passes on. It costs them
 * cards from the stock (the cards nobody was dealt):
 *
 *   had something to play   three cards
 *   had nothing to play     three cards, or one for every card in the pile if
 *                           that is more — what picking it up would have cost,
 *                           so sitting out the clock is never the better deal
 *
 * A blind card that has already been flipped cannot be skipped: it has to be played.
 */
export function skip(r, pid, { rnd = randomInt } = {}) {
  const err = guard(r, pid);
  if (err) return fail(err);
  if (r.pending) return fail('A flipped blind card has to be played.');
  const forced = !hasPlay(r, pid);
  const cards = draw(r, forced ? Math.max(SKIP_PENALTY, r.pile.length) : SKIP_PENALTY, rnd);
  r.seats[pid].hand.push(...cards);
  note(r, { k: 'skip', by: pid, drew: cards.length, forced });
  // Everyone sees how many were drawn and the colour of their backs. Only the player sees what they are.
  emit(r, { kind: 'skip', by: pid, drew: cards.length, forced, backs: cards.map((c) => c.b) });
  advance(r);
  return ok({ drew: cards.length, forced });
}

/** The host called the game off. Nobody scores. */
export function abandon(r) {
  if (r.phase === 'over') return;
  note(r, { k: 'end' });
  finish(r, { reason: 'abandoned' });
  emit(r, { kind: 'end' });
}

/**
 * Takes a player out mid-game (they left, or the host removed them). Their
 * cards leave the game with them.
 */
export function drop(r, pid, name = '') {
  const at = r.order.indexOf(pid);
  if (at === -1 || r.phase === 'over') return false;
  const wasTurn = r.turn === at;
  (r.swiped ??= []).push(...remaining(r.seats[pid]));
  r.burned += cardsLeft(r.seats[pid]);
  delete r.seats[pid];
  r.order.splice(at, 1);
  if (r.pending?.pid === pid) r.pending = null;
  note(r, { k: 'drop', by: pid, name });
  if (r.order.length < 2) {
    r.turn = 0;
    note(r, { k: 'end' });
    finish(r, { reason: 'abandoned' });
    emit(r, { kind: 'end' });
    return true;
  }
  if (at < r.turn) r.turn -= 1;
  else if (wasTurn) {
    r.turn %= r.order.length;
    r.turnNo += 1;
  }
  emit(r, { kind: 'drop', by: pid });
  return true;
}

// ───────────────────────── a move for someone who isn't there ─────────────────────────

/**
 * Picks a sensible move for the player whose turn it is. Used for computer
 * players, for turns that run out of time, and when the host plays a turn for
 * someone who wandered off. Returns { a: 'flip', slot } or { a: 'play', ids }.
 */
export function autoMove(r, pid) {
  if (r.phase !== 'play' || current(r) !== pid) return null;
  const seat = r.seats[pid];
  const top = topOf(r.pile);
  const open = [...seat.hand, ...seat.up.filter(Boolean)];
  const byRank = new Map();
  for (const c of open) byRank.set(c.r, [...(byRank.get(c.r) ?? []), c]);

  // As many of one rank as the pile will take. Tens always go one at a time.
  const most = (rank, forced = []) => {
    const mates = (byRank.get(rank) ?? []).filter((c) => !forced.includes(c));
    const cards = [...forced, ...mates];
    if (rank === TEN) return cards.slice(0, 1);
    const cap = rank === top.rank ? SET_MAX - top.run : SET_MAX;
    return cards.slice(0, Math.max(forced.length, Math.min(cap, cards.length)));
  };
  const move = (cards) => ({ a: 'play', ids: cards.map((c) => c.id) });

  if (r.pending) return move(most(seat.blind[r.pending.slot].r, [seat.blind[r.pending.slot]]));

  const options = [...byRank.keys()]
    .filter((rank) => rank !== TEN)
    .map((rank) => {
      const cards = most(rank);
      return { rank, cards, verdict: judge(top, rank, cards.length) };
    })
    .filter((o) => o.verdict.ok)
    .sort((a, b) => order(b.rank) - order(a.rank));
  const pick = (test) => options.find(test);

  // 1. Swipe and go again. 2. Shed the highest cards that fit. 3. Swipe with
  // four high cards. 4. Spend a ten. 5. Gamble on a blind card rather than
  // take the pile for certain. 6. Take the pile, leading with the highest set.
  const best =
    pick((o) => o.verdict.effect === 'swipe' && o.verdict.again) ??
    pick((o) => o.verdict.effect === 'place') ??
    pick((o) => o.verdict.effect === 'swipe');
  if (best) return move(best.cards);
  if (byRank.has(TEN)) return move(most(TEN));
  const slot = seat.blind.findIndex((c, i) => c && !seat.up[i]);
  if (slot !== -1) return { a: 'flip', slot };
  if (options.length) return move(options[0].cards);
  return null;
}

/**
 * A blind card that turns out to be a ten leaves nothing to decide: it can
 * only be played alone, and it always swipes. Returns the card, or null.
 */
export function flippedTen(r) {
  if (!r.pending || r.phase !== 'play') return null;
  const card = r.seats[r.pending.pid]?.blind[r.pending.slot];
  return card && card.r === TEN ? card : null;
}

/** Plays a flipped ten on its owner's behalf. */
export function playFlippedTen(r) {
  const card = flippedTen(r);
  return card ? play(r, r.pending.pid, [card.id]) : fail('No ten to play.');
}

/** Applies autoMove. Returns the result of the move, or a failure if there was nothing to do. */
export function autoPlay(r, pid) {
  const m = autoMove(r, pid);
  if (!m) return fail('Nothing to play.');
  return m.a === 'flip' ? flip(r, pid, m.slot) : play(r, pid, m.ids);
}
