// The heart of Swipe: what a card is worth, and what happens when a set of
// equal cards lands on the pile. This one file is used by the server (to
// enforce the rules) and by the browser (to preview a move before you make it),
// so the two can never disagree. No imports, no I/O.

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS = ['s', 'h', 'd', 'c'];
export const TEN = '10';
export const SET_MAX = 4;

// Lowest to highest: A-2-3-4-5-6-7-8-9-J-Q-K. Tens sit outside the order.
const ORDER = { A: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, J: 11, Q: 12, K: 13 };

/** Where a rank sits in the order. Tens have no rank, so they return 0. */
export const order = (rank) => ORDER[rank] ?? 0;

/** What a card left in your hand costs you when somebody else goes out. */
export function points(rank) {
  if (rank === TEN) return 20;
  if (rank === 'A') return 1;
  return ORDER[rank] > 9 ? 10 : ORDER[rank];
}

export const RANK_NAMES = {
  A: ['ace', 'aces'], 2: ['two', 'twos'], 3: ['three', 'threes'], 4: ['four', 'fours'], 5: ['five', 'fives'],
  6: ['six', 'sixes'], 7: ['seven', 'sevens'], 8: ['eight', 'eights'], 9: ['nine', 'nines'], 10: ['ten', 'tens'],
  J: ['jack', 'jacks'], Q: ['queen', 'queens'], K: ['king', 'kings'],
};
export const rankName = (rank, n = 1) => RANK_NAMES[rank]?.[n === 1 ? 0 : 1] ?? String(rank);

/**
 * The rank showing on top of a pile and how many of it are stacked there.
 * `pile` is a list of cards (or bare ranks), bottom first.
 */
export function topOf(pile) {
  if (!pile || pile.length === 0) return { rank: null, run: 0 };
  const rankAt = (i) => (typeof pile[i] === 'string' ? pile[i] : pile[i].r);
  const rank = rankAt(pile.length - 1);
  let run = 1;
  while (run < pile.length && rankAt(pile.length - 1 - run) === rank) run += 1;
  return { rank, run };
}

/**
 * What happens if `n` cards of `rank` are played onto a pile whose top is `top`.
 *
 *   place   the cards go on the pile, play passes on
 *   swipe   the pile leaves the game. `again` says whether the player goes again
 *   pickup  the cards are higher than the pile: the player takes the pile first,
 *           then the cards start a new one
 *
 * Returns { ok: false, error } when the set is not allowed at all.
 */
export function judge(top, rank, n) {
  const fail = (error) => ({ ok: false, error });
  if (!Number.isInteger(n) || n < 1) return fail('Pick at least one card.');
  if (n > SET_MAX) return fail('A set is four cards at most.');
  if (!(rank in RANK_NAMES)) return fail('That is not a card.');

  // Tens go on anything, at any time, and always swipe. One is all it takes,
  // so one is all that may be played; the extra turn is there for the next.
  if (rank === TEN) {
    if (n > 1) return fail('Tens go down one at a time. Play one, then another on your extra turn.');
    return { ok: true, effect: 'swipe', swipe: 'ten', again: true };
  }

  const topRank = top?.rank ?? null;
  const run = top?.run ?? 0;

  if (topRank === null || order(rank) <= order(topRank)) {
    if (rank === topRank) {
      // Adding to a set that is already there: it may reach four, never pass it.
      const room = SET_MAX - run;
      if (n > room) {
        return fail(
          `There ${run === 1 ? 'is' : 'are'} already ${run} ${rankName(rank, run)} on top, so only ${room} more can go on.`,
        );
      }
      if (n === room) return { ok: true, effect: 'swipe', swipe: 'four', again: true };
      return { ok: true, effect: 'place', swipe: null, again: false };
    }
    if (n === SET_MAX) return { ok: true, effect: 'swipe', swipe: 'four', again: true };
    return { ok: true, effect: 'place', swipe: null, again: false };
  }

  // Higher than the pile. Four of a kind still swipes it away, but the turn ends.
  if (n === SET_MAX) return { ok: true, effect: 'swipe', swipe: 'four', again: false };
  return { ok: true, effect: 'pickup', swipe: null, again: false };
}
