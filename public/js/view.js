// Everything you can see in a room, as functions from the latest snapshot to
// HTML: the turn-order strip, the mat (whose turn, their table cards, the
// pile), the hand, the action bar, the lobby, the results and the side rails.
// Nothing in here talks to the server or starts an animation.

import { $, esc, formatClock, icon, initials, onColor, plural, possessive, seeded } from './util.js';
import { backHTML, faceHTML } from './cards.js';
import { TEN, judge, order, rankName } from './rules.js';

// ───────────────────────── who is who ─────────────────────────

export const playerOf = (state, id) => state.players.find((p) => p.id === id);
export const colorOf = (state, id) => playerOf(state, id)?.color ?? '#9a9cab';
export const inRound = (state, id) => Boolean(state.round?.order.includes(id));
export const isLive = (state) => Boolean(state.round && state.round.phase !== 'over');
export const myTurn = (state, me) => state.round?.phase === 'play' && state.round.turn === me.id;
export const hostName = (state) => playerOf(state, state.hostId)?.name ?? 'the host';

/** "You" for the viewer, otherwise the player's name. */
export const who = (state, me, id) => (id === me.id ? 'You' : (playerOf(state, id)?.name ?? 'Someone'));
const whose = (state, me, id) => (id === me.id ? 'Your' : possessive(playerOf(state, id)?.name ?? 'Someone'));

const hexToRgb = (hex) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const luminance = ([r, g, b]) => {
  const lin = (v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

/**
 * A player's colour as a tabletop: the same hue, taken deep enough that white
 * cards and white type sit comfortably on it.
 */
export function matColor(hex) {
  const from = hexToRgb(hex);
  const ink = [20, 15, 11];
  let mixed = from;
  for (let t = 0.2; t <= 0.9; t += 0.03) {
    mixed = from.map((v, i) => Math.round(v + (ink[i] - v) * t));
    if (luminance(mixed) <= 0.13) break;
  }
  return `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Inline custom properties that tint an element with a player's colour. */
export const tint = (hex) => `--p:${hex};--on-p:${onColor(hex)}`;

function avatar(p, extra = '') {
  return `<span class="avatar${p.online ? '' : ' is-offline'}${extra}" style="${tint(p.color)}">${p.bot ? icon('bot') : esc(initials(p.name))}</span>`;
}

// ───────────────────────── words ─────────────────────────

const COUNT = ['no', 'a', 'two', 'three', 'four'];
/** "a king", "an eight", "two sevens" */
export function setWords(rank, n) {
  if (n === 1) return `${rank === 'A' || rank === '8' ? 'an' : 'a'} ${rankName(rank)}`;
  return `${COUNT[n] ?? n} ${rankName(rank, n)}`;
}

/** One log entry as a sentence. */
export function describe(state, me, e) {
  const name = e.by ? who(state, me, e.by) : '';
  const again = (id) => (id === me.id ? 'You go again.' : `${who(state, me, id)} goes again.`);
  switch (e.k) {
    case 'start':
      return e.why === 'high'
        ? `${name} ${e.by === me.id ? 'hold' : 'holds'} the highest hand (${e.total} points) and ${e.by === me.id ? 'lead' : 'leads'}.`
        : `${name} went out last game and ${e.by === me.id ? 'lead' : 'leads'} this one.`;
    case 'flip':
      return `${name} flipped a blind card: ${setWords(e.r, 1)}.`;
    case 'play': {
      const set = setWords(e.r, e.n);
      if (e.effect === 'pickup') return `${name} picked up ${plural(e.pickup, 'card')} and led with ${set}.`;
      if (e.effect === 'swipe') {
        const made = e.swipe === 'ten' ? `${name} played ${set}.` : e.n === 4 ? `${name} played ${set}.` : `${name} made it four ${rankName(e.r, 4)}.`;
        const then = e.again ? again(e.by) : e.swipe === 'four' && e.n === 4 && e.swiped > 4 ? 'The turn passes.' : '';
        return `${made} Swipe! ${then}`.trim();
      }
      return `${name} played ${set}.`;
    }
    case 'out':
      return `${name} ${e.by === me.id ? 'are' : 'is'} out of cards.`;
    case 'drop':
      return `${e.by === me.id ? 'You' : (playerOf(state, e.by)?.name ?? e.name ?? 'Someone')} left the game. Those cards are out.`;
    case 'timeout':
      return `${name} ran out of time.`;
    case 'skip': {
      const was = e.by === me.id ? 'were' : 'was';
      if (!e.drew) return `${name} ran out of time and ${was} skipped.`;
      const why = e.forced && e.drew > 3 ? ' With nothing to play, that’s one for every card in the pile.' : '';
      return `${name} ran out of time, ${was} skipped and drew ${plural(e.drew, 'card')}.${why}`;
    }
    case 'end':
      return 'The game was called off.';
    default:
      return '';
  }
}

function lastLine(state, me) {
  const log = state.round?.log ?? [];
  const e = log.at(-1);
  return e ? describe(state, me, e) : '';
}

// ───────────────────────── strip: turn order ─────────────────────────

export function renderStrip(state, me) {
  const r = state.round;
  const el = $('#strip');
  if (!r) return (el.innerHTML = '');
  el.innerHTML = r.order
    .map((pid) => {
      const p = playerOf(state, pid);
      if (!p) return '';
      const seat = r.seats[pid];
      const turn = r.phase === 'play' && r.turn === pid;
      const label = `${p.name}${pid === me.id ? ' (you)' : ''}: ${plural(seat.left, 'card')} left${p.online ? '' : ', offline'}`;
      return `<button type="button" class="seatchip${turn ? ' is-turn' : ''}${pid === me.id ? ' is-you' : ''}" data-act="player" data-id="${esc(pid)}" data-pid="${esc(pid)}" style="${tint(p.color)}" title="${esc(label)}" aria-label="${esc(label)}">
          ${avatar(p)}<b class="seatchip-n">${seat.left}</b>
        </button>`;
    })
    .join('');
  // Keep the player on turn in view without ever scrolling the page itself.
  const chip = el.querySelector('.is-turn');
  if (chip) el.scrollTo({ left: chip.offsetLeft - (el.clientWidth - chip.offsetWidth) / 2, behavior: 'smooth' });
}

// ───────────────────────── mat: whose turn ─────────────────────────

export function renderTurn(state, me) {
  const r = state.round;
  if (!r) return;
  const el = $('#turn');
  let title;
  let sub;
  if (r.phase === 'deal') {
    title = 'Shuffling';
    sub = `Game ${r.no}. ${plural(r.decks, 'deck')} mixed together, 20 cards each.`;
  } else {
    title = r.turn === me.id ? 'Your turn' : `${possessive(playerOf(state, r.turn)?.name ?? 'Someone')} turn`;
    sub = lastLine(state, me);
  }
  el.innerHTML = `<div class="turn-main">
      <h2 class="turn-name${r.turn === me.id && r.phase === 'play' ? ' is-you' : ''}">${esc(title)}</h2>
      <p class="turn-sub">${esc(sub)}</p>
    </div>
    <div class="timer" id="timer" hidden>
      <span class="timer-value" id="timer-value" role="timer" aria-live="off"></span>
      <span class="timer-controls" id="timer-controls"></span>
    </div>`;
}

// ───────────────────────── mat: the four table stacks ─────────────────────────

/** Whose cards a zone is showing: the player on turn, unless the viewer asked for their own. */
export function viewed(state, me, pref) {
  const r = state.round;
  if (!r) return null;
  if (r.phase === 'deal') return inRound(state, me.id) ? me.id : r.turn;
  if (pref === 'me' && inRound(state, me.id)) return me.id;
  return r.turn;
}

/** How a card of this rank would fare on the pile right now: 'ok', 'swipe', 'high' or 'no'. */
function prospect(r, rank) {
  const top = { rank: r.pile.top.at(-1)?.r ?? null, run: r.pile.top.length };
  const v = judge(top, rank, 1);
  if (!v.ok) return 'no';
  if (rank === TEN) return 'swipe';
  return v.effect === 'pickup' ? 'high' : 'ok';
}

export function renderTable(state, me, ui) {
  const r = state.round;
  const el = $('#tablezone');
  if (!r) return (el.innerHTML = '');
  const pid = viewed(state, me, ui.tableView);
  const seat = r.seats[pid];
  if (!seat) return (el.innerHTML = '');
  const mine = pid === me.id;
  const acting = mine && myTurn(state, me);
  const flipped = r.pending?.pid === pid ? r.pending.slot : -1;

  const slots = seat.up
    .map((up, i) => {
      const blind = seat.blind[i];
      let under = '';
      if (blind && i === flipped) {
        under = faceHTML(blind, { cls: `is-flipped is-picked${acting ? ' is-locked' : ''}`, attrs: `data-from="blind" data-slot="${i}"` });
      } else if (blind) {
        const open = acting && !up && !r.pending;
        under = backHTML(blind.b, {
          tag: open ? 'button' : 'span',
          cls: `blind${open ? ' can-flip' : ''}`,
          attrs: `data-slot="${i}"${open ? ' data-act="blind" aria-label="Blind card. Flip it to play it."' : ''}`,
        });
      }
      let top = '';
      if (up) {
        const can = acting;
        const cls = ['up', can ? 'can-pick' : '', ui.selected.has(up.id) ? 'is-picked' : '', can && prospect(r, up.r) === 'high' ? 'is-high' : '']
          .filter(Boolean)
          .join(' ');
        top = faceHTML(up, { tag: can ? 'button' : 'span', cls, attrs: `data-from="up" data-slot="${i}"` });
      }
      return `<div class="slot${!up && !blind ? ' is-empty' : ''}${up && blind ? ' is-stacked' : ''}" data-slot="${i}">${under}${top}</div>`;
    })
    .join('');

  const canToggle = inRound(state, me.id) && r.turn !== me.id && r.phase === 'play';
  const other = playerOf(state, r.turn)?.name ?? 'theirs';
  el.innerHTML = `<div class="slots" data-pid="${esc(pid)}">${slots}</div>
    <div class="zone-foot">
      <span class="zone-label"><i class="dot" style="${tint(colorOf(state, pid))}"></i>${esc(whose(state, me, pid))} table cards</span>
      ${canToggle ? `<button type="button" class="btn btn-small btn-mat" data-act="toggle-table">${icon('swap')}${mine ? `Show ${esc(possessive(other))}` : 'Show mine'}</button>` : ''}
    </div>`;
}

// ───────────────────────── mat: the pile ─────────────────────────

const PILE_SHOWN = 40; // buried cards that are drawn; the server sends this many backs
const PILE_TALL = 0.56; // the tallest a pile is drawn, in card-widths
const PILE_TILT = 0.36; // how much of its height shows as cards sitting higher up the screen
const LIGHT = { x: 0.46, y: 0.8 }; // where a shadow falls on the mat, per card-width of height: the lamp is up and to the left

/**
 * How far off the mat the card `i` from the bottom rests, in card-widths.
 * A real card is far thinner than this, or a pile of ten would look like a
 * pile of one. It climbs quickly at first and more slowly after, so three
 * cards against fifteen is as plain to see as fifteen against sixty.
 */
const pileHeight = (i) => Math.min(PILE_TALL, 0.07 * Math.sqrt(i));

/**
 * Where every visible card of the pile sits, in card-widths from the centre.
 * Buried cards are turned face down, so the heap shows red and blue backs
 * peeking out, each tossed its own way: most land near the middle, a few
 * well off it, and some nearly sideways. The scatter is repeatable (the same
 * card always lands the same way). The cards that matter — the run on top —
 * are face up and fanned so each index can be read.
 *
 * Every card also has a height `z`. The higher a card is, the higher up the
 * screen it sits (as a heap does seen from a chair, not from the ceiling), the
 * slightly larger it is drawn, and the further and softer its shadow falls.
 * `gx`/`gy` is the spot on the mat directly beneath it, and `floor` how far
 * down the screen the mat under the middle of the pile is.
 *
 * `backs` lists the back colours of the buried cards, ending with the one
 * directly under the top run. It may be shorter than the pile is deep.
 */
export function pileSpec(roundId, count, top, backs = []) {
  const under = Math.max(0, count - top.length);
  const shown = Math.min(under, backs.length, PILE_SHOWN);
  const tallest = pileHeight(Math.max(0, count - 1));
  const place = (s) => {
    const z = pileHeight(s.i);
    return { ...s, z, k: 1 + z * 0.14, floor: (PILE_TILT * tallest) / 2, gx: s.x, gy: s.y + (PILE_TILT * tallest) / 2, y: s.y - PILE_TILT * (z - tallest / 2) };
  };
  const out = [];
  for (let i = under - shown; i < under; i++) {
    const rnd = seeded(`${roundId}:${i}`);
    const bell = () => (rnd() + rnd() + rnd()) / 3 - 0.5; // -0.5 to 0.5, mostly near the middle
    const x = bell() * 1.02;
    const y = bell() * 0.6;
    // Most cards land roughly square; two in five were tossed and lie any way round.
    const rot = rnd() < 0.4 ? (rnd() - 0.5) * 180 : bell() * 130;
    out.push(place({ kind: 'back', i, b: backs[backs.length - (under - i)], x, y, rot }));
  }
  const n = top.length;
  top.forEach((card, j) => {
    const rnd = seeded(`${roundId}:${under + j}:top`);
    const k = j - (n - 1) / 2;
    out.push(place({ kind: 'face', i: under + j, card, x: k * 0.3 + (rnd() - 0.5) * 0.06, y: (rnd() - 0.5) * 0.1, rot: k * 7 + (rnd() - 0.5) * 9 }));
  });
  return out;
}

/**
 * A pile card's place, plus what its own shadows need. A box-shadow turns
 * with its card, so the card's thin edge (which always shows on the side
 * nearest you) and the shadow it leaves on the cards beneath (which always
 * falls away from the light) are worked out here against its rotation.
 */
export function pileStyle(s) {
  const rad = (s.rot * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  const f = (n, d = 3) => n.toFixed(d);
  return `--x:${f(s.x)};--y:${f(s.y)};--rot:${f(s.rot, 1)}deg;--k:${f(s.k ?? 1)};--ex:${f(sin)};--ey:${f(cos)};--lx:${f(0.32 * cos + 0.95 * sin)};--ly:${f(0.95 * cos - 0.32 * sin)}`;
}

/** Where a pile card is on screen, given where the pile is: the place a card flying to the pile should land. */
export function pileRect(anchor, s) {
  const k = s.k ?? 1;
  return { x: anchor.x + s.x * anchor.w - ((k - 1) * anchor.w) / 2, y: anchor.y + s.y * anchor.w - ((k - 1) * anchor.h) / 2, w: anchor.w * k, h: anchor.h * k, rot: s.rot };
}

/**
 * The pile's markup: first what it casts on the mat, then the cards.
 *
 * Each card throws its own shadow, offset and blurred in step with its height.
 * They are drawn solid and faded as one group, so where they overlap the mat
 * gets no darker: together they are a single shadow, crisp where the pile
 * meets the mat and long and soft where its top overhangs. A few cards barely
 * mark the mat; sixty of them stand in their own shade.
 */
export function pileHTML(spec, { hideLast = false } = {}) {
  if (!spec.length) return '';
  const f = (n) => n.toFixed(3);
  const tallest = spec.at(-1).z;
  const shade = (s) => `<i class="pile-shade" style="--x:${f(s.gx + LIGHT.x * s.z)};--y:${f(s.gy + LIGHT.y * s.z)};--rot:${s.rot.toFixed(1)}deg;--blur:${f(0.014 + 0.4 * s.z)}"></i>`;
  // Under everything, the shade a heap gathers round its foot: wider and deeper the taller it stands.
  const pool = `<i class="pile-shade is-pool" style="--x:${f(LIGHT.x * tallest * 0.35)};--y:${f(spec[0].floor + LIGHT.y * tallest * 0.35)};--rot:0deg;--blur:${f(0.1 + 0.5 * tallest)};--grow:${f(0.05 + 0.26 * tallest)};--a:${f(Math.min(0.3, 0.08 + 0.45 * tallest))}"></i>`;
  const shades = spec.map((s, n) => (hideLast && n === spec.length - 1 ? '' : shade(s))).join('');
  const cards = spec
    .map((s, n) => {
      const style = `${pileStyle(s)}${hideLast && n === spec.length - 1 ? ';visibility:hidden' : ''}`;
      return s.kind === 'back' ? backHTML(s.b, { cls: 'pile-card', style }) : faceHTML(s.card, { cls: 'pile-card is-top', style });
    })
    .join('');
  // A taller pile keeps more of the lamp off the mat, so its shadow is deeper as well as longer.
  const depth = Math.min(0.5, 0.28 + 0.4 * tallest);
  return `<div class="pile-shades" aria-hidden="true">${pool}<div class="pile-cast" style="opacity:${f(depth)}">${shades}</div></div>${cards}`;
}

export function renderPile(state, pile) {
  const r = state.round;
  const el = $('#pile');
  el.classList.remove('is-clearing');
  if (!r) return (el.innerHTML = '');
  const spec = pileSpec(r.id, pile.count, pile.top, pile.backs);
  el.innerHTML = (pile.count === 0 ? '<span class="pile-empty"></span>' : '') + pileHTML(spec);

  const top = pile.top.at(-1)?.r ?? null;
  const run = pile.top.length;
  let rule;
  let more = '';
  // A ten or a fourth card only ever sits here for the instant before the swipe.
  const doomed = top === TEN || run >= 4;
  if (!top) rule = 'Play anything';
  else if (doomed) rule = top === TEN ? 'A ten!' : 'Four of a kind!';
  else if (top === 'A') rule = 'Aces only';
  else rule = `${top} or lower`;
  if (top && !doomed && run >= 2) more = `${run === 3 ? 'One' : 'Two'} more ${rankName(top, 4 - run)} to swipe`;
  $('#pile-right').innerHTML = `<div class="pile-count" title="Cards in the pile"><b>${pile.count}</b><span>in the pile</span></div>
    <p class="pile-rule">${rule}${top && !doomed ? '<small>or a ten</small>' : ''}</p>
    ${more ? `<p class="pile-more">${more}</p>` : ''}`;
  $('#pile-left').innerHTML = r.burned ? `<p class="pile-burned"><b>${r.burned}</b><span>swiped away</span></p>` : '';
}

// ───────────────────────── hand ─────────────────────────

/** Low to high, tens last (they are the wild ones), equal ranks side by side. */
export function sortHand(cards) {
  const key = (c) => (c.r === TEN ? 99 : order(c.r));
  return cards.slice().sort((a, b) => key(a) - key(b) || (a.s < b.s ? -1 : a.s > b.s ? 1 : a.id < b.id ? -1 : 1));
}

/**
 * Fits `n` overlapping cards into `width`: as few rows as will keep every
 * index readable. Returns the per-row count and how far apart cards sit.
 */
export function handFit(n, width, cw, { comfy = 0.44, tight = 0.3, maxRows = 3 } = {}) {
  if (n <= 0) return { per: 1, step: cw, rows: 1 };
  for (let rows = 1; rows <= 12; rows++) {
    const per = Math.ceil(n / rows);
    const step = per > 1 ? Math.min(cw + 6, (width - cw) / (per - 1)) : cw;
    if (step >= comfy * cw || (rows >= maxRows && step >= tight * cw) || rows === 12) return { per, step: Math.max(step, 8), rows };
  }
  return { per: n, step: cw, rows: 1 };
}

export function renderHand(state, me, ui) {
  const r = state.round;
  const el = $('#handzone');
  if (!r) return (el.innerHTML = '');
  const pid = viewed(state, me, ui.handView);
  const seat = r.seats[pid];
  if (!seat) return (el.innerHTML = '');
  const mine = pid === me.id;
  const acting = mine && myTurn(state, me);
  const canToggle = inRound(state, me.id) && r.turn !== me.id && r.phase === 'play';
  const other = playerOf(state, r.turn)?.name ?? 'theirs';

  let cards;
  if (mine) {
    cards = sortHand(r.mine ?? [])
      .map((c) => {
        const cls = [acting ? 'can-pick' : '', ui.selected.has(c.id) ? 'is-picked' : '', acting && prospect(r, c.r) === 'high' ? 'is-high' : '']
          .filter(Boolean)
          .join(' ');
        return faceHTML(c, { tag: acting ? 'button' : 'span', cls, attrs: 'data-from="hand"' });
      })
      .join('');
  } else {
    cards = seat.backs.map((b) => backHTML(b)).join('');
  }
  const empty = seat.hand === 0 ? `<p class="hand-empty">${mine ? 'Your hand is empty. The table cards are all you have left.' : 'No cards in hand. Only table cards left.'}</p>` : '';

  el.style.cssText = tint(colorOf(state, pid));
  el.classList.toggle('is-mine', mine);
  el.classList.toggle('is-acting', acting);
  el.innerHTML = `<div class="zone-head">
      <span class="zone-label"><i class="dot"></i>${esc(whose(state, me, pid))} hand<b class="zone-n">${seat.hand}</b></span>
      ${canToggle ? `<button type="button" class="btn btn-small" data-act="toggle-hand">${icon('swap')}${mine ? `Show ${esc(possessive(other))}` : 'Show mine'}</button>` : ''}
    </div>
    <div class="hand${mine ? '' : ' is-backs'}" id="hand" data-pid="${esc(pid)}" data-n="${seat.hand}">${cards}</div>${empty}`;
  fitHand();
}

/** Sets the overlap of the hand to suit its width. Called after render and on resize. */
export function fitHand() {
  const hand = $('#hand');
  if (!hand) return;
  const n = Number(hand.dataset.n);
  const cw = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cw')) || 60;
  const box = getComputedStyle(hand.parentElement);
  const width = hand.parentElement.clientWidth - Number.parseFloat(box.paddingLeft) - Number.parseFloat(box.paddingRight) - 2;
  const backs = hand.classList.contains('is-backs');
  const fit = handFit(n, width, cw, backs ? { comfy: 0.3, tight: 0.2, maxRows: 2 } : {});
  const step = Math.floor(fit.step * 100) / 100;
  hand.style.setProperty('--step', `${step}px`);
  hand.style.maxWidth = `${Math.ceil(Math.max(cw, step) + step * (fit.per - 1)) + 1}px`;
  hand.dataset.rows = fit.rows;
}

// ───────────────────────── action bar ─────────────────────────

/** Every card the viewer could put into a set right now, with where it sits. */
export function myOpenCards(state, me) {
  const r = state.round;
  const seat = r?.seats[me.id];
  if (!seat) return [];
  const list = [...(r.mine ?? []), ...seat.up.filter(Boolean)];
  if (r.pending?.pid === me.id) list.push(seat.blind[r.pending.slot]);
  return list;
}

/** What the selected cards would do. Null when nothing is selected. */
export function preview(state, me, ui) {
  const r = state.round;
  const cards = myOpenCards(state, me).filter((c) => ui.selected.has(c.id));
  if (!cards.length) return null;
  const top = { rank: r.pile.top.at(-1)?.r ?? null, run: r.pile.top.length };
  return { cards, rank: cards[0].r, verdict: judge(top, cards[0].r, cards.length), top };
}

export function renderActions(state, me, ui) {
  const r = state.round;
  const el = $('#actions');
  if (!r || r.phase === 'over') return (el.innerHTML = '');
  el.style.cssText = tint(me.color);
  const seatedHere = inRound(state, me.id);
  const isHost = me.id === state.hostId;
  const mover = playerOf(state, r.turn);

  if (r.phase === 'deal') return (el.innerHTML = '<p class="act-hint">The cards are on their way.</p>');

  if (!myTurn(state, me)) {
    const nudge =
      isHost && mover && !mover.bot && !mover.online
        ? `<button type="button" class="btn" data-act="auto">Play ${esc(possessive(mover.name))} turn for them</button>`
        : '';
    const watching = !seatedHere
      ? me.playing
        ? 'You’ll be dealt in when the next game starts.'
        : 'You’re watching this one.'
      : `Waiting for ${esc(mover?.name ?? 'the next player')}${mover && !mover.online ? ', who is offline' : ''}.`;
    const join = !seatedHere && !me.playing ? '<button type="button" class="btn btn-you" data-act="sit">Deal me in next game</button>' : '';
    return (el.innerHTML = `<p class="act-hint">${watching}</p>${nudge}${join}`);
  }

  // A flipped ten plays itself: there is nothing to press.
  if (r.pending && r.seats[me.id]?.blind[r.pending.slot]?.r === TEN) {
    return (el.innerHTML = '<p class="act-hint is-swipe">A ten! It swipes the pile, and you go again.</p>');
  }

  const p = preview(state, me, ui);
  if (!p) {
    const hint = r.pending ? 'Your blind card is face up. It has to be played now.' : 'Tap the cards you want to play. Cards of the same rank go down together.';
    return (el.innerHTML = `<p class="act-hint">${hint}</p><button type="button" class="btn btn-you btn-play" disabled>Play</button>`);
  }

  const { cards, rank, verdict } = p;
  const label = cards.map(() => rank).join(' ');
  let hint;
  let mood = '';
  if (!verdict.ok) {
    hint = verdict.error;
    mood = 'is-bad';
  } else if (verdict.effect === 'pickup') {
    hint = `Higher than the pile: you pick up ${plural(r.pile.count, 'card')} first.`;
    mood = 'is-warn';
  } else if (verdict.effect === 'swipe') {
    hint = verdict.again ? 'Swipes the pile, and you go again.' : 'Four of a kind over a lower card: swipes the pile, then your turn ends.';
    mood = 'is-swipe';
  } else {
    hint = r.pile.count ? 'Goes on the pile.' : 'Starts the pile.';
  }

  // Offer the rest of the rank in one tap when more would fit.
  const open = myOpenCards(state, me).filter((c) => c.r === rank);
  const room = rank === TEN ? 1 : rank === p.top.rank ? 4 - p.top.run : 4;
  const most = Math.min(open.length, room);
  const all = most > cards.length ? `<button type="button" class="btn btn-all" data-act="pick-all" data-n="${most}">All ${most}</button>` : '';

  el.innerHTML = `<p class="act-hint ${mood}">${esc(hint)}</p>
    ${all}
    <button type="button" class="btn btn-you btn-play ${mood}" data-act="play"${verdict.ok ? '' : ' disabled'}>${verdict.ok && verdict.effect === 'pickup' ? 'Pick up, play' : 'Play'} <b>${label}</b></button>`;
}

// ───────────────────────── timer ─────────────────────────

export function renderTimer(state, me, clockOffset, full = false) {
  const r = state?.round;
  const el = $('#timer');
  if (!el) return null;
  const running = r && r.phase === 'play' && (r.deadline || r.pausedLeft != null);
  el.hidden = !running;
  if (!running) return null;
  const paused = r.pausedLeft != null;
  const left = paused ? r.pausedLeft : r.deadline - (Date.now() + clockOffset);
  $('#timer-value').textContent = formatClock(left);
  el.classList.toggle('is-low', !paused && left <= 10_000);
  el.classList.toggle('is-paused', paused);
  if (full) {
    $('#timer-controls').innerHTML =
      me.id === state.hostId
        ? `<button class="tool" type="button" data-act="pause" title="${paused ? 'Resume the clock' : 'Pause the clock'}">${icon(paused ? 'play' : 'pause')}<span class="sr">${paused ? 'Resume' : 'Pause'} the clock</span></button>
           <button class="tool" type="button" data-act="add-time" title="Add 30 seconds">+30<span class="sr"> seconds</span></button>`
        : '';
  }
  return paused ? null : Math.ceil(left / 1000);
}

// ───────────────────────── lobby ─────────────────────────

export function startProblem(state) {
  const n = state.players.filter((p) => p.playing).length;
  if (n < state.limits.min) return `Swipe needs at least ${state.limits.min} players. ${n === 0 ? 'Nobody is' : n === 1 ? 'One is' : `${COUNT[n][0].toUpperCase()}${COUNT[n].slice(1)} are`} seated.`;
  if (n > state.limits.max) return `Swipe seats ${state.limits.max} at most.`;
  return '';
}

function rulesLine(state) {
  const s = state.settings;
  return `The match ends when someone reaches ${s.limit} points. ${s.turnSeconds ? `${formatClock(s.turnSeconds * 1000)} on the clock for each turn.` : 'No turn clock.'}`;
}

const seatsShown = new Set(); // so only a newcomer's seat pops in
let resultsShown = null; // the round whose results have already made their entrance

export function renderLobby(state, me, ui = {}) {
  const el = $('#lobby');
  const isHost = me.id === state.hostId;
  const seatedPlayers = state.players.filter((p) => p.playing);
  const watching = state.players.filter((p) => !p.playing);
  const problem = startProblem(state);
  const decks = Math.max(2, Math.ceil(seatedPlayers.length / 2));

  const seat = (p) => {
    const tags = [p.id === me.id ? 'you' : '', p.id === state.hostId ? 'host' : '', p.bot ? 'computer' : '', p.online ? '' : 'offline'].filter(Boolean).join(', ');
    const inner = `${avatar(p)}<span class="seat-name">${esc(p.name)}</span>${tags ? `<span class="seat-tags">${tags}</span>` : ''}`;
    const fresh = seatsShown.has(p.id) ? '' : ' is-new';
    seatsShown.add(p.id);
    return isHost && p.id !== me.id
      ? `<li><button type="button" class="seat${fresh}" data-act="player" data-id="${esc(p.id)}" style="${tint(p.color)}">${inner}</button></li>`
      : `<li><span class="seat${fresh}${p.id === me.id ? ' is-you' : ''}" style="${tint(p.color)}">${inner}</span></li>`;
  };

  el.style.setProperty('--mat', matColor(me.color));
  el.innerHTML = `<header class="lobby-head">
      <h2 class="display">${seatedPlayers.length < state.limits.min ? 'Pull up a chair' : 'Ready to deal'}</h2>
      <p>${plural(seatedPlayers.length, 'player')} at the table${seatedPlayers.length >= state.limits.min ? `, ${plural(decks, 'deck')} shuffled together` : ''}. Send the link to bring in more.</p>
    </header>
    <ul class="seats">
      ${seatedPlayers.map(seat).join('')}
      ${isHost && seatedPlayers.length < state.limits.max ? `<li><button type="button" class="seat seat-add" data-act="add-bot">${icon('plus')}<span class="seat-name">Add a computer player</span></button></li>` : ''}
    </ul>
    ${watching.length ? `<p class="lobby-watching">Watching: ${watching.map((p) => esc(p.name)).join(', ')}</p>` : ''}
    <div class="lobby-you" style="${tint(me.color)}">
      <span class="lobby-you-label">${avatar(me)}This is your colour.</span>
      <button type="button" class="btn btn-small btn-mat" data-act="recolor">${icon('dice')}Pick another</button>
      <button type="button" class="btn btn-small btn-mat" data-act="${me.playing ? 'stand' : 'sit'}">${me.playing ? 'Watch instead' : 'Take a seat'}</button>
      ${(ui.push === 'ok' && !state.notify) || ui.push === 'install' ? `<button type="button" class="btn btn-small btn-mat" data-act="push-on">${icon('bell')}Notify me on my turn</button>` : ''}
    </div>
    <p class="lobby-rules">${rulesLine(state)} ${isHost ? '<button type="button" class="link" data-act="settings">Change</button>' : ''}</p>
    <div class="lobby-go" style="${tint(me.color)}">
      ${
        isHost
          ? `<button type="button" class="btn btn-you btn-large" data-act="start"${problem ? ' disabled' : ''}>Deal the cards</button>`
          : `<p class="lobby-wait">Waiting for ${esc(hostName(state))} to deal.</p>`
      }
      <button type="button" class="btn btn-large btn-mat" data-act="invite">${icon('copy')}Copy invite link</button>
    </div>
    ${problem && isHost ? `<p class="lobby-problem">${esc(problem)}</p>` : ''}`;
}

// ───────────────────────── results ─────────────────────────

function miniCards(cards) {
  if (!cards.length) return '<span class="mini-none">No cards left</span>';
  const sorted = sortHand(cards);
  const shown = sorted.slice(0, 36);
  const rest = sorted.length - shown.length;
  return (
    shown.map((c) => `<i class="mini${c.r === TEN ? ' is-ten' : ''}${c.s === 'h' || c.s === 'd' ? ' is-red' : ''}">${c.r}</i>`).join('') +
    (rest > 0 ? `<i class="mini mini-more">+${rest}</i>` : '')
  );
}

export function renderResults(state, me) {
  const r = state.round;
  const m = state.match;
  const el = $('#results');
  if (!r || r.phase !== 'over') return (el.innerHTML = '');
  const isHost = me.id === state.hostId;
  const limit = state.settings.limit;
  const abandoned = r.reason !== 'out';
  const winner = playerOf(state, r.winner);
  const champs = (m?.champions ?? []).map((id) => playerOf(state, id)).filter(Boolean);
  const matchOver = Boolean(m?.over);
  const lead = matchOver && champs.length ? champs[0] : winner;

  el.style.setProperty('--mat', matColor(lead?.color ?? me.color));

  let title;
  let sub;
  if (abandoned) {
    title = 'Game called off';
    sub = 'Nobody scores for this one.';
  } else if (matchOver) {
    const names = champs.map((p) => (p.id === me.id ? 'You' : p.name));
    const total = m.scores[champs[0]?.id] ?? 0;
    title = champs.length > 1 ? `${names.join(' and ')} share the match` : `${names[0]} ${champs[0].id === me.id ? 'win' : 'wins'} the match`;
    sub = `Lowest score after ${plural(m.gameNo, 'game')}: ${plural(total, 'point')}. Someone reached ${limit}, so that’s the match.`;
  } else {
    title = r.winner === me.id ? 'You’re out!' : `${winner?.name ?? 'Someone'} is out!`;
    sub = `Game ${r.no} is done. Everyone else scores what they were left holding.`;
  }

  const ids = (m?.order ?? r.order).filter((id) => r.order.includes(id));
  const rows = ids
    .map((id) => ({ id, p: playerOf(state, id), gained: abandoned ? 0 : (r.result?.points[id] ?? 0), total: m?.scores[id] ?? 0, left: r.result?.left[id] ?? [] }))
    .filter((row) => row.p)
    .sort((a, b) => a.total - b.total || a.gained - b.gained);
  const body = rows
    .map((row, i) => {
      const pct = Math.min(100, Math.round((row.total / limit) * 100));
      const bust = row.total >= limit;
      const champ = matchOver && champs.some((c) => c.id === row.id);
      return `<li class="score-row${row.id === r.winner && !abandoned ? ' is-out' : ''}${bust ? ' is-bust' : ''}${champ ? ' is-champ' : ''}" style="${tint(row.p.color)};--i:${i}">
          ${avatar(row.p)}
          <div class="score-who">
            <span class="score-name">${esc(row.p.name)}${row.id === me.id ? ' <small>you</small>' : ''}${champ ? ` ${icon('crown')}` : ''}</span>
            <span class="score-left">${row.id === r.winner && !abandoned ? '<span class="mini-none">Went out</span>' : miniCards(row.left)}</span>
          </div>
          <div class="score-nums">
            <span class="score-gain" data-count="${row.gained}">${abandoned ? '' : `+${row.gained}`}</span>
            <b class="score-total" data-from="${row.total - row.gained}" data-to="${row.total}">${row.total}</b>
          </div>
          <span class="score-bar"><i style="width:${pct}%"></i></span>
        </li>`;
    })
    .join('');

  const next = matchOver ? 'Start a new match' : m ? 'Deal the next game' : 'Deal the cards';
  el.classList.toggle('is-fresh', resultsShown !== r.id);
  resultsShown = r.id;
  el.innerHTML = `<header class="results-head">
      <h2 class="display">${esc(title)}</h2>
      <p>${esc(sub)}</p>
    </header>
    <ol class="scores" style="--limit:'${limit}'">${body}</ol>
    <p class="results-limit">Playing to ${limit}. Lowest score wins.</p>
    <div class="results-go" style="${tint(me.color)}">
      ${
        isHost
          ? `<button type="button" class="btn btn-you btn-large" data-act="start">${next}</button>
             ${matchOver ? '<button type="button" class="btn btn-large btn-mat" data-act="lobby">Back to the lobby</button>' : ''}`
          : `<p class="lobby-wait">Waiting for ${esc(hostName(state))} to ${matchOver ? 'start a new match' : 'deal the next game'}.</p>`
      }
      ${!inRound(state, me.id) && !me.playing ? '<button type="button" class="btn btn-large btn-mat" data-act="sit">Deal me in</button>' : ''}
    </div>`;
}

// ───────────────────────── rails ─────────────────────────

function scorePanel(state, me) {
  const r = state.round;
  const m = state.match;
  const isHost = me.id === state.hostId;
  const limit = state.settings.limit;
  const ids = m?.order ?? state.players.filter((p) => p.playing).map((p) => p.id);
  const rows = ids
    .map((id) => playerOf(state, id))
    .filter(Boolean)
    .map((p) => {
      const score = m?.scores[p.id] ?? 0;
      const left = r && r.phase !== 'over' ? r.seats[p.id]?.left : null;
      const turn = r?.phase === 'play' && r.turn === p.id;
      const tagList = [p.id === me.id ? 'you' : '', p.bot ? 'computer' : '', p.online ? '' : 'offline'].filter(Boolean).join(', ');
      const inner = `${avatar(p)}
          <span class="pl-name">${p.id === state.hostId ? icon('crown') : ''}<span>${esc(p.name)}</span>${tagList ? `<small>${tagList}</small>` : ''}</span>
          ${left != null ? `<span class="pl-cards" title="Cards left">${left}</span>` : ''}
          <b class="pl-score" title="Points so far">${score}</b>
          <span class="score-bar"><i style="width:${Math.min(100, (score / limit) * 100)}%"></i></span>`;
      const cls = `pl${turn ? ' is-turn' : ''}`;
      return isHost
        ? `<li><button type="button" class="${cls}" data-act="player" data-id="${esc(p.id)}" style="${tint(p.color)}">${inner}</button></li>`
        : `<li><div class="${cls}" style="${tint(p.color)}">${inner}</div></li>`;
    })
    .join('');
  const watchers = state.players.filter((p) => !ids.includes(p.id));
  const watchList = watchers
    .map((p) => {
      const label = `${esc(p.name)}${p.playing && m ? ' (in next game)' : ''}`;
      return isHost && p.id !== me.id
        ? `<button type="button" class="watcher" data-act="player" data-id="${esc(p.id)}">${label}</button>`
        : `<span class="watcher">${label}</span>`;
    })
    .join('');
  const inMatch = ids.includes(me.id);
  const seatBtn = !m
    ? ''
    : inMatch
      ? '<button type="button" class="btn btn-small" data-act="stand">Leave the table</button>'
      : me.playing
        ? '<button type="button" class="btn btn-small" data-act="stand">Don’t deal me in</button>'
        : '<button type="button" class="btn btn-small" data-act="sit">Deal me in next game</button>';
  return `<section class="side">
      <div class="side-row"><h2>Scores</h2><span class="side-meta">${m ? `Game ${m.gameNo}, to ${limit}` : `To ${limit}`}</span></div>
      <ol class="pls${r && r.phase !== 'over' ? ' has-cards' : ''}">${rows || '<li class="side-meta">Nobody is seated yet.</li>'}</ol>
      ${r && r.phase !== 'over' ? '<p class="side-meta side-key">Cards left, then points so far.</p>' : ''}
      ${watchers.length ? `<div class="watchers"><span class="side-meta">Watching</span>${watchList}</div>` : ''}
      ${seatBtn}
    </section>`;
}

function hostPanel(state) {
  const live = isLive(state);
  const buttons = [];
  if (live) buttons.push('<button type="button" class="btn btn-small" data-act="end-game">Call this game off</button>');
  if (state.match) buttons.push('<button type="button" class="btn btn-small" data-act="lobby">End the match</button>');
  buttons.push('<button type="button" class="btn btn-small" data-act="add-bot">Add a computer player</button>');
  buttons.push(`<button type="button" class="btn btn-small" data-act="lock" aria-pressed="${state.locked}">${icon('lock')}${state.locked ? 'Unlock room' : 'Lock room'}</button>`);
  return `<section class="side">
      <h2>Host controls</h2>
      <div class="set-actions">${buttons.join('')}</div>
      <p class="side-meta">Tap a player to play a turn for them, sit them out or remove them.</p>
    </section>`;
}

function logPanel(state, me) {
  const entries = state.round?.log ?? [];
  const cls = (e) => (e.k === 'play' && e.effect === 'swipe' ? ' class="log-swipe"' : e.k === 'play' && e.effect === 'pickup' ? ' class="log-pickup"' : e.k === 'skip' ? ' class="log-skip"' : e.k === 'out' || e.k === 'end' ? ' class="log-end"' : '');
  return `<section class="side">
      <div class="side-row"><h2>Play by play</h2>${state.round ? `<span class="side-meta">Game ${state.round.no}</span>` : ''}</div>
      <ol class="log" id="log">${
        entries.map((e) => `<li${cls(e)} style="${e.by ? tint(colorOf(state, e.by)) : ''}">${esc(describe(state, me, e))}</li>`).join('') ||
        '<li class="log-empty">Every card played shows up here.</li>'
      }</ol>
    </section>`;
}

export function renderRails(state, me) {
  const oldLog = $('#log');
  const stick = !oldLog || oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 40;
  $('#rail-left').innerHTML = scorePanel(state, me) + (me.id === state.hostId ? hostPanel(state) : '');
  $('#rail-right').innerHTML = logPanel(state, me);
  const log = $('#log');
  if (stick && log) log.scrollTop = log.scrollHeight;
}

