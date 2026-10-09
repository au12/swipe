// Playing cards, drawn as inline SVG so they stay sharp at any size and need
// no image files. The faces follow the classic American poker deck: corner
// indices, pips in the standard arrangements, two-headed court cards and a
// big ace of spades. Backs are two static files (red and blue) used as CSS
// backgrounds, so a fan of thirty face-down cards costs thirty empty elements.

import { esc } from './util.js';
import { rankName } from './rules.js';

const RED = '#c8102e';
const BLACK = '#16161a';
const GOLD = '#f2c230';
const BLUE = '#1d3f94';
const SKIN = '#fff6e6';

// Suit shapes in a 100 × 100 box centred on the origin.
const SUIT_PATH = {
  h: 'M0 40C-13 25-42 6-42-16c0-15 11-24 22-24 9 0 17 6 20 14 3-8 11-14 20-14 11 0 22 9 22 24C42 6 13 25 0 40z',
  d: 'M0-46C9-29 21-13 34 0 21 13 9 29 0 46-9 29-21 13-34 0-21-13-9-29 0-46z',
  s: 'M0-44C12-26 42-9 42 13c0 13-10 22-21 22-8 0-14-4-18-10 1 9 5 17 12 22h-30c7-5 11-13 12-22-4 6-10 10-18 10-11 0-21-9-21-22C-42-9-12-26 0-44z',
  c: 'M0-45a19 19 0 0 1 15 31a19 19 0 1 1-10 33c1 10 5 19 12 25h-34c7-6 11-15 12-25a19 19 0 1 1-10-33A19 19 0 0 1 0-45z',
};
const SUIT_NAME = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
const isRed = (suit) => suit === 'h' || suit === 'd';
const ink = (suit) => (isRed(suit) ? RED : BLACK);

const pip = (suit, x, y, size, flip = false, fill = ink(suit)) =>
  `<path d="${SUIT_PATH[suit]}" fill="${fill}" transform="translate(${x} ${y})${flip ? ' rotate(180)' : ''} scale(${size / 100})"/>`;

/** A small inline suit symbol for use in running text. */
export const suitIcon = (suit) =>
  `<svg class="suit" viewBox="-50 -50 100 100" aria-hidden="true"><path d="${SUIT_PATH[suit]}" fill="${isRed(suit) ? 'var(--suit-red)' : 'currentColor'}"/></svg>`;

// Pip positions: three columns, rows from top to bottom. Pips in the lower
// half are drawn upside down, as on a real card.
const L = 88;
const C = 125;
const R = 162;
const T = 74;
const M = 175;
const B = 276;
const Q1 = 141.3; // second and third of four rows
const Q3 = 208.7;
const PIPS = {
  2: [[C, T], [C, B]],
  3: [[C, T], [C, M], [C, B]],
  4: [[L, T], [R, T], [L, B], [R, B]],
  5: [[L, T], [R, T], [C, M], [L, B], [R, B]],
  6: [[L, T], [R, T], [L, M], [R, M], [L, B], [R, B]],
  7: [[L, T], [R, T], [C, 124.5], [L, M], [R, M], [L, B], [R, B]],
  8: [[L, T], [R, T], [C, 124.5], [L, M], [R, M], [C, 225.5], [L, B], [R, B]],
  9: [[L, T], [R, T], [L, Q1], [R, Q1], [C, M], [L, Q3], [R, Q3], [L, B], [R, B]],
  10: [[L, T], [R, T], [C, 107.5], [L, Q1], [R, Q1], [L, Q3], [R, Q3], [C, 242.5], [L, B], [R, B]],
};

function corner(rank, suit) {
  const label =
    rank === '10'
      ? `<text x="31" y="58" text-anchor="middle" class="ten">10</text>`
      : `<text x="30" y="60" text-anchor="middle">${rank}</text>`;
  const one = `<g fill="${ink(suit)}" class="idx">${label}${pip(suit, 30, 88, 30)}</g>`;
  return `${one}<g transform="rotate(180 125 175)">${one}</g>`;
}

// ── Court cards ──
// One half-figure, drawn in the top half of the frame and repeated upside
// down in the bottom half. Kings wear a crown and a beard, queens a coronet
// and long hair, jacks a flat cap with a feather.
function courtHalf(rank, suit) {
  const robe = isRed(suit) ? RED : BLUE;
  const trim = isRed(suit) ? BLUE : RED;
  const line = `stroke="${BLACK}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"`;
  const hair = rank === 'K' ? '#3b3b44' : GOLD;
  const parts = [];

  // Robe and collar.
  parts.push(`<path d="M58 175v-22c12-22 38-36 67-36s55 14 67 36v22z" fill="${robe}" ${line}/>`);
  parts.push(`<path d="M107 175l18-56 18 56z" fill="${GOLD}" ${line}/>`);
  parts.push(`<path d="M125 132l7 12-7 12-7-12zM125 158l5 9-5 8-5-8z" fill="${trim}"/>`);
  parts.push(`<path d="M58 160c14-20 30-30 46-36M192 160c-14-20-30-30-46-36" fill="none" stroke="${GOLD}" stroke-width="5" stroke-linecap="round"/>`);

  // Hair behind the head.
  if (rank === 'Q') parts.push(`<path d="M99 82c-10 12-13 34-8 52l14-10zM151 82c10 12 13 34 8 52l-14-10z" fill="${hair}" ${line}/>`);
  else parts.push(`<path d="M100 84c-7 8-8 22-5 32l11-6zM150 84c7 8 8 22 5 32l-11-6z" fill="${hair}" ${line}/>`);

  // Head.
  parts.push(`<path d="M104 88c0-14 9-22 21-22s21 8 21 22c0 18-9 34-21 34s-21-16-21-34z" fill="${SKIN}" ${line}/>`);
  parts.push(`<path d="M113 92h7M130 92h7M125 94v10l-4 3M119 112q6 4 12 0" fill="none" stroke="${BLACK}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`);
  if (rank === 'K') parts.push(`<path d="M106 104c2 16 9 26 19 26s17-10 19-26c-6 8-12 11-19 11s-13-3-19-11z" fill="${hair}" ${line}/>`);

  // Headwear.
  if (rank === 'K') {
    parts.push(`<path d="M99 80V52l13 12 13-18 13 18 13-12v28z" fill="${GOLD}" ${line}/>`);
    parts.push(`<path d="M99 80h52v-9H99z" fill="${trim}" ${line}/>`);
    parts.push(`<circle cx="99" cy="50" r="4" fill="${robe}"/><circle cx="125" cy="44" r="4.5" fill="${robe}"/><circle cx="151" cy="50" r="4" fill="${robe}"/>`);
  } else if (rank === 'Q') {
    parts.push(`<path d="M101 80c-2-9 0-17 4-23l9 9 11-14 11 14 9-9c4 6 6 14 4 23z" fill="${GOLD}" ${line}/>`);
    parts.push(`<circle cx="125" cy="50" r="4.5" fill="${trim}"/><circle cx="105" cy="56" r="3.5" fill="${robe}"/><circle cx="145" cy="56" r="3.5" fill="${robe}"/>`);
    // A flower in hand.
    parts.push(`<path d="M78 150V118" fill="none" stroke="#1f7a3f" stroke-width="3" stroke-linecap="round"/>`);
    parts.push(`<g fill="${SKIN}" stroke="${BLACK}" stroke-width="1.6"><circle cx="78" cy="103" r="6"/><circle cx="69" cy="110" r="6"/><circle cx="87" cy="110" r="6"/><circle cx="72" cy="120" r="6"/><circle cx="84" cy="120" r="6"/></g><circle cx="78" cy="113" r="4.5" fill="${GOLD}"/>`);
  } else {
    parts.push(`<path d="M96 82c-2-16 10-27 29-27s31 11 29 27z" fill="${trim}" ${line}/>`);
    parts.push(`<path d="M96 82h58" fill="none" stroke="${GOLD}" stroke-width="5" stroke-linecap="round"/>`);
    parts.push(`<path d="M150 64c10-14 24-18 34-12-12 0-20 8-26 20z" fill="${GOLD}" ${line}/>`);
    // A halberd over the shoulder.
    parts.push(`<path d="M172 172V98" fill="none" stroke="${BLACK}" stroke-width="3.5" stroke-linecap="round"/>`);
    parts.push(`<path d="M172 82l9 16h-18z" fill="${GOLD}" ${line}/>`);
  }

  // The suit, top left of the frame.
  parts.push(pip(suit, 78, 64, 30));
  return parts.join('');
}

function court(rank, suit) {
  const half = courtHalf(rank, suit);
  return `<rect x="56" y="38" width="138" height="274" rx="6" fill="#fffdf6" stroke="${BLUE}" stroke-width="3"/>
    <g>${half}</g><g transform="rotate(180 125 175)">${half}</g>
    <path d="M58 175h134" stroke="${BLACK}" stroke-width="2.5"/>`;
}

function aceOfSpades() {
  const p = SUIT_PATH.s;
  return `<path d="${p}" fill="${BLACK}" transform="translate(125 172) scale(1.72)"/>
    <path d="${p}" fill="none" stroke="#fff" stroke-width="1.6" transform="translate(125 170) scale(1.36)"/>
    <path d="${p}" fill="#fff" transform="translate(125 160) scale(0.5)"/>
    <path d="${p}" fill="${BLACK}" transform="translate(125 159) scale(0.3)"/>`;
}

function center(rank, suit) {
  if (rank === 'A') return suit === 's' ? aceOfSpades() : pip(suit, 125, 175, 112);
  if (rank === 'J' || rank === 'Q' || rank === 'K') return court(rank, suit);
  return PIPS[rank].map(([x, y]) => pip(suit, x, y, 46, y > 176)).join('');
}

const faceCache = new Map();
function faceSvg(rank, suit) {
  const key = rank + suit;
  if (!faceCache.has(key)) {
    faceCache.set(key, `<svg viewBox="0 0 250 350" aria-hidden="true">${center(rank, suit)}${corner(rank, suit)}</svg>`);
  }
  return faceCache.get(key);
}

export const cardLabel = (card) => `${rankName(card.r)} of ${SUIT_NAME[card.s]}`;

/**
 * A face-up card. `tag` is 'button' for cards you can tap and 'span' for the
 * rest; `cls` and `attrs` are passed through.
 */
export function faceHTML(card, { tag = 'span', cls = '', attrs = '', style = '' } = {}) {
  const type = tag === 'button' ? ' type="button"' : '';
  return `<${tag}${type} class="card face ${cls}" data-cid="${esc(card.id)}" data-r="${card.r}" data-b="${card.b}"${style ? ` style="${style}"` : ''} ${attrs} aria-label="${cardLabel(card)}">${faceSvg(card.r, card.s)}</${tag}>`;
}

/** A face-down card: 0 is a red back, 1 a blue one. */
export function backHTML(b, { tag = 'span', cls = '', attrs = '', style = '' } = {}) {
  const type = tag === 'button' ? ' type="button"' : '';
  return `<${tag}${type} class="card back b${b ? 1 : 0} ${cls}"${style ? ` style="${style}"` : ''} ${attrs}></${tag}>`;
}

/** A card with both sides, for flips in mid-air. Shows its back until `.is-up` is added. */
export function flipHTML(card, { cls = '', style = '' } = {}) {
  return `<span class="card flipper ${cls}"${style ? ` style="${style}"` : ''}><span class="flip-in">${backHTML(card.b, { cls: 'flip-back' })}${faceHTML(card, { cls: 'flip-face' })}</span></span>`;
}
