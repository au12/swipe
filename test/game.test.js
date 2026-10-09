import test from 'node:test';
import assert from 'node:assert/strict';
import * as game from '../server/game.js';
import { judge, points, topOf } from '../public/js/rules.js';

let nextId = 0;
const card = (r) => ({ id: `t${nextId++}`, r, s: 's', b: 0 });
const cards = (...ranks) => ranks.map(card);

/** A three-player round with hand-built seats, already in the play phase with `a` to move. */
function table({ a = {}, b = {}, c = {}, pile = [] } = {}) {
  const r = game.createRound({ players: ['a', 'b', 'c'] });
  r.phase = 'play';
  r.turn = 0;
  for (const [pid, spec] of Object.entries({ a, b, c })) {
    const fill = (list) => Array.from({ length: 4 }, (_, i) => (list?.[i] ? card(list[i]) : null));
    r.seats[pid] = {
      hand: cards(...(spec.hand ?? ['2', '3'])),
      up: fill(spec.up ?? ['4', '4', '4', '4']),
      blind: fill(spec.blind ?? ['5', '5', '5', '5']),
    };
  }
  r.pile = cards(...pile);
  return r;
}
const ids = (r, pid, rank, n = 1) =>
  r.seats[pid].hand
    .filter((c) => c.r === rank)
    .slice(0, n)
    .map((c) => c.id);

test('card values: ace 1, pips at face value, courts 10, tens 20', () => {
  assert.deepEqual(['A', '2', '9', 'J', 'Q', 'K', '10'].map(points), [1, 2, 9, 10, 10, 10, 20]);
});

test('the deal: 20 cards each, 4 blind, 4 face-up, 12 in hand, half red and half blue', () => {
  for (const [n, decks] of [[2, 2], [3, 2], [4, 2], [5, 3], [6, 3], [8, 4], [24, 12]]) {
    const players = Array.from({ length: n }, (_, i) => `p${i}`);
    const r = game.createRound({ players });
    assert.equal(r.decks, decks);
    assert.equal(game.decksFor(n), decks);
    const all = [];
    for (const pid of players) {
      const s = r.seats[pid];
      assert.equal(s.hand.length, 12);
      assert.equal(s.up.length, 4);
      assert.equal(s.blind.length, 4);
      all.push(...s.hand, ...s.up, ...s.blind);
    }
    assert.equal(all.length, n * 20);
    assert.equal(new Set(all.map((c) => c.id)).size, all.length, 'no card is dealt twice');
    assert.equal(r.aside, decks * 52 - n * 20);
  }
  const deck = game.buildDeck(3);
  assert.equal(deck.length, 156);
  assert.equal(deck.filter((c) => c.b === 0).length, 78, 'exactly half the backs are red');
  assert.equal(deck.filter((c) => c.r === '10').length, 12);
});

test('the first lead goes to the highest hand; later games to whoever is named', () => {
  for (let i = 0; i < 20; i++) {
    const r = game.createRound({ players: ['a', 'b', 'c', 'd'] });
    const total = (pid) => r.seats[pid].hand.reduce((sum, c) => sum + points(c.r), 0);
    const best = Math.max(...r.order.map(total));
    assert.equal(total(game.current(r)), best);
    assert.deepEqual(r.start, { pid: game.current(r), why: 'high', total: best });
  }
  const r = game.createRound({ players: ['a', 'b', 'c'], first: 'c' });
  assert.equal(game.current(r), 'c');
  assert.equal(r.start.why, 'winner');
});

test('judge: equal or lower goes on, higher picks up, tens and fours swipe', () => {
  const on = (pile, rank, n) => judge(topOf(pile), rank, n);
  assert.equal(on([], 'K', 2).effect, 'place');
  assert.equal(on(['7'], '7', 1).effect, 'place');
  assert.equal(on(['7'], '3', 3).effect, 'place');
  assert.equal(on(['7'], '9', 1).effect, 'pickup');
  assert.equal(on(['J'], 'Q', 2).effect, 'pickup');
  assert.equal(on(['9'], 'A', 1).effect, 'place', 'aces are low');
  assert.equal(on(['A'], '2', 1).effect, 'pickup');

  assert.deepEqual(on(['7'], '10', 1), { ok: true, effect: 'swipe', swipe: 'ten', again: true });
  assert.equal(on([], '10', 1).effect, 'swipe', 'a ten goes on anything, even nothing');
  assert.match(on(['7'], '10', 2).error, /one at a time/);
  assert.equal(on([], '10', 4).ok, false, 'not even four tens together');
  assert.deepEqual(on(['9'], '5', 4), { ok: true, effect: 'swipe', swipe: 'four', again: true });
  assert.deepEqual(on([], 'Q', 4), { ok: true, effect: 'swipe', swipe: 'four', again: true });
  assert.deepEqual(on(['5'], '9', 4), { ok: true, effect: 'swipe', swipe: 'four', again: false }, 'four higher: swipe, but the turn ends');

  assert.equal(on(['8', '8', '8'], '8', 1).effect, 'swipe', 'the fourth eight completes the set');
  assert.equal(on(['8', '8', '8'], '8', 1).again, true);
  assert.equal(on(['8', '8', '8'], '8', 2).ok, false, 'a set never passes four');
  assert.equal(on(['8', '8'], '8', 3).ok, false);
  assert.equal(on(['8', '8'], '8', 2).effect, 'swipe');
  assert.equal(on(['8', '8'], '8', 1).effect, 'place');
  assert.equal(on(['8', '3', '8'], '8', 3).effect, 'swipe', 'only the unbroken run on top counts');
  assert.equal(on(['7'], '7', 5).ok, false);
});

test('playing lower cards passes the turn clockwise', () => {
  const r = table({ a: { hand: ['6', '6', 'K'] }, pile: ['9'] });
  assert.equal(game.play(r, 'b', ids(r, 'b', '2')).ok, false, 'not b’s turn');
  const res = game.play(r, 'a', ids(r, 'a', '6', 2));
  assert.equal(res.ok, true);
  assert.equal(res.effect, 'place');
  assert.equal(r.pile.length, 3);
  assert.equal(r.seats.a.hand.length, 1);
  assert.equal(game.current(r), 'b');
  assert.equal(r.last.kind, 'play');
  assert.equal(r.last.cards.length, 2);
});

test('mixed ranks, borrowed cards and face-down cards are refused', () => {
  const r = table({ a: { hand: ['6', '7'] }, pile: ['9'] });
  assert.match(game.play(r, 'a', r.seats.a.hand.map((c) => c.id)).error, /same rank/);
  assert.match(game.play(r, 'a', [r.seats.b.hand[0].id]).error, /do not have/);
  assert.match(game.play(r, 'a', [r.seats.a.blind[0].id]).error, /do not have/, 'a blind card cannot be played by id');
  assert.match(game.play(r, 'a', []).error, /at least one/);
  const one = r.seats.a.hand[0].id;
  assert.match(game.play(r, 'a', [one, one]).error, /once/);
  assert.equal(r.pile.length, 1, 'nothing moved');
});

test('a higher card takes the pile into the hand and starts a new one', () => {
  const r = table({ a: { hand: ['K', 'K', '2'] }, pile: ['3', '5', '5'] });
  const res = game.play(r, 'a', ids(r, 'a', 'K', 2));
  assert.equal(res.effect, 'pickup');
  assert.deepEqual(r.pile.map((c) => c.r), ['K', 'K']);
  assert.deepEqual(r.seats.a.hand.map((c) => c.r).sort(), ['2', '3', '5', '5']);
  assert.equal(r.last.pickup, 3);
  assert.equal(game.current(r), 'b');
});

test('a ten swipes the pile and the same player goes again', () => {
  const r = table({ a: { hand: ['10', '4'] }, pile: ['3', '5', 'A'] });
  const res = game.play(r, 'a', ids(r, 'a', '10'));
  assert.equal(res.effect, 'swipe');
  assert.equal(res.again, true);
  assert.equal(r.pile.length, 0);
  assert.equal(r.burned, 4);
  assert.equal(game.current(r), 'a');
  assert.equal(game.play(r, 'a', ids(r, 'a', '4')).effect, 'place', 'anything goes on the empty pile');
  assert.equal(game.current(r), 'b');
});

test('four of a kind swipes: built up across players, or played at once', () => {
  const r = table({ a: { hand: ['8', '8', '2'] }, b: { hand: ['8', '8', '8', '3'] }, pile: ['J'] });
  game.play(r, 'a', ids(r, 'a', '8', 2));
  assert.match(game.play(r, 'b', ids(r, 'b', '8', 3)).error, /only 2 more/);
  const res = game.play(r, 'b', ids(r, 'b', '8', 2));
  assert.equal(res.effect, 'swipe');
  assert.equal(game.current(r), 'b', 'b completed the set, so b goes again');
  assert.equal(r.burned, 5);

  const r2 = table({ a: { hand: ['Q', 'Q', 'Q', 'Q', '2'] }, pile: ['3'] });
  const high = game.play(r2, 'a', ids(r2, 'a', 'Q', 4));
  assert.equal(high.effect, 'swipe');
  assert.equal(high.again, false);
  assert.equal(r2.seats.a.hand.length, 1, 'no pickup for four of a kind');
  assert.equal(r2.pile.length, 0);
  assert.equal(game.current(r2), 'b', 'four higher ends the turn');
});

test('hand and face-up cards can be played together as one set', () => {
  const r = table({ a: { hand: ['6', '2'], up: ['6', '6', 'K', 'K'] }, pile: ['9'] });
  const set = [...ids(r, 'a', '6'), ...r.seats.a.up.filter((c) => c.r === '6').map((c) => c.id)];
  const res = game.play(r, 'a', set);
  assert.equal(res.effect, 'place');
  assert.deepEqual(r.seats.a.up.map((c) => c?.r ?? null), [null, null, 'K', 'K']);
  assert.deepEqual(r.last.cards.map((c) => c.from).sort(), ['hand', 'up', 'up']);
});

test('blind cards: covered ones stay put, a flipped one must be played', () => {
  const r = table({ a: { hand: ['2', '9'], up: ['4', null, null, null], blind: ['7', '3', 'K', '10'] }, pile: ['5'] });
  assert.match(game.flip(r, 'a', 0).error, /face-up card on top/);
  assert.match(game.flip(r, 'b', 1).error, /not your turn/);
  assert.equal(game.flip(r, 'a', 1).ok, true);
  assert.deepEqual(r.pending, { pid: 'a', slot: 1 });
  assert.equal(r.last.kind, 'flip');
  assert.equal(r.last.card.r, '3');
  assert.match(game.flip(r, 'a', 2).error, /already flipped/);
  assert.match(game.play(r, 'a', ids(r, 'a', '2')).error, /has to be played now/);
  const res = game.play(r, 'a', [r.seats.a.blind[1].id]);
  assert.equal(res.effect, 'place');
  assert.equal(r.seats.a.blind[1], null);
  assert.equal(r.pending, null);
});

test('a flipped blind card that is too high takes the pile; matching cards may join it', () => {
  const r = table({ a: { hand: ['K', '2'], up: [null, null, 'K', '4'], blind: ['K', '3', '6', '6'] }, pile: ['5', '5'] });
  game.flip(r, 'a', 0);
  const set = [r.seats.a.blind[0].id, ...ids(r, 'a', 'K'), r.seats.a.up[2].id];
  const res = game.play(r, 'a', set);
  assert.equal(res.effect, 'pickup');
  assert.deepEqual(r.pile.map((c) => c.r), ['K', 'K', 'K']);
  assert.deepEqual(r.seats.a.hand.map((c) => c.r).sort(), ['2', '5', '5']);
});

test('going out ends the game and scores what everyone else still holds', () => {
  const r = table({
    a: { hand: ['3'], up: [], blind: [] },
    b: { hand: ['A', '9', 'K', '10'], up: ['J', null, null, null], blind: ['Q', '2', null, null] },
    c: { hand: [], up: [], blind: ['7', null, null, null] },
    pile: ['5'],
  });
  const res = game.play(r, 'a', ids(r, 'a', '3'));
  assert.equal(res.out, true);
  assert.equal(r.phase, 'over');
  assert.equal(r.winner, 'a');
  assert.deepEqual(r.result.points, { a: 0, b: 1 + 9 + 10 + 20 + 10 + 10 + 2, c: 7 });
  assert.equal(r.result.left.b.length, 7);
  assert.match(game.play(r, 'b', ids(r, 'b', 'A')).error, /over/);
});

test('a last card that is too high does not go out: the pile comes home first', () => {
  const r = table({ a: { hand: ['K'], up: [], blind: [] }, pile: ['5', '4'] });
  const res = game.play(r, 'a', ids(r, 'a', 'K'));
  assert.equal(res.out, false);
  assert.equal(r.phase, 'play');
  assert.equal(r.seats.a.hand.length, 2);
});

test('going out on a swipe still wins', () => {
  const r = table({ a: { hand: ['10'], up: [], blind: [] }, pile: ['5'] });
  const res = game.play(r, 'a', ids(r, 'a', '10'));
  assert.equal(res.out, true);
  assert.equal(r.winner, 'a');
});

test('nothing can be played while the cards are being dealt', () => {
  const r = game.createRound({ players: ['a', 'b', 'c'] });
  const pid = game.current(r);
  assert.match(game.play(r, pid, [r.seats[pid].hand[0].id]).error, /still being dealt/);
});

test('dropping a player keeps the turn order intact', () => {
  const r = table();
  r.turn = 1; // b to move
  assert.equal(game.drop(r, 'a'), true);
  assert.deepEqual(r.order, ['b', 'c']);
  assert.equal(game.current(r), 'b');
  assert.equal(r.burned, 10);

  const r2 = table();
  r2.turn = 2; // c to move, c leaves: back round to a
  game.drop(r2, 'c');
  assert.equal(game.current(r2), 'a');

  const r3 = table();
  game.drop(r3, 'a');
  game.drop(r3, 'b');
  assert.equal(r3.phase, 'over');
  assert.equal(r3.reason, 'abandoned');
});

test('the auto player always finds a legal move and prefers not to take the pile', () => {
  let r = table({ a: { hand: ['3', '6', '6', 'K'], up: ['2', 'A', 'A', 'Q'] }, pile: ['9'] });
  assert.deepEqual(game.autoMove(r, 'a').ids.sort(), ids(r, 'a', '6', 2).sort(), 'sheds the highest set that fits');

  r = table({ a: { hand: ['3', '8', 'K'], up: ['2', 'A', 'A', 'Q'] }, pile: ['J', '8', '8', '8'] });
  assert.deepEqual(game.autoMove(r, 'a').ids, ids(r, 'a', '8'), 'completes four of a kind');

  r = table({ a: { hand: ['Q', '10'], up: [] }, pile: ['2'] });
  assert.deepEqual(game.autoMove(r, 'a').ids, ids(r, 'a', '10'), 'spends a ten before picking up');

  r = table({ a: { hand: ['Q'], up: [null, '9', '9', '9'] }, pile: ['2'] });
  assert.deepEqual(game.autoMove(r, 'a'), { a: 'flip', slot: 0 }, 'gambles on a blind card before picking up');

  r = table({ a: { hand: ['Q', 'J'], up: ['9', '9', '9', '9'] }, pile: ['2'] });
  assert.equal(game.autoMove(r, 'a').ids.length, 4, 'four nines swipe without a pickup');

  r = table({ a: { hand: ['Q', 'J'], up: ['9', '8', '7', '6'] }, pile: ['2'] });
  assert.deepEqual(game.autoMove(r, 'a').ids, ids(r, 'a', 'Q'), 'otherwise leads the new pile with its highest card');

  r = table({ a: { hand: ['10', '10'], up: [], blind: [] }, pile: ['2'] });
  assert.equal(game.autoMove(r, 'a').ids.length, 1, 'tens go one at a time, even when they are all that is left');
});

test('tens are played singly, one per turn, as many turns as you have tens', () => {
  const r = table({ a: { hand: ['10', '10', '4'], up: ['10', null, null, null] }, pile: ['3', '5'] });
  const tens = [...ids(r, 'a', '10', 2), r.seats.a.up[0].id];
  assert.match(game.play(r, 'a', tens.slice(0, 2)).error, /one at a time/);
  assert.match(game.play(r, 'a', [tens[0], tens[2]]).error, /one at a time/, 'hand and table tens cannot be paired either');
  assert.equal(r.pile.length, 2, 'nothing moved');
  for (const id of tens) {
    const res = game.play(r, 'a', [id]);
    assert.equal(res.effect, 'swipe');
    assert.equal(game.current(r), 'a', 'each ten earns another turn');
  }
  assert.equal(r.burned, 2 + 3);
});

test('a flipped ten is recognised so it can be played without asking', () => {
  const r = table({ a: { hand: ['10', '2'], up: [null, null, '4', '4'], blind: ['10', '6', '5', '5'] }, pile: ['3', '5', 'A'] });
  assert.equal(game.flippedTen(r), null);
  game.flip(r, 'a', 1);
  assert.equal(game.flippedTen(r), null, 'a six is not a ten');
  assert.equal(game.playFlippedTen(r).ok, false);
  game.play(r, 'a', [r.seats.a.blind[1].id]); // six on an ace: picks up, turn passes
  r.turn = 0;
  game.flip(r, 'a', 0);
  assert.equal(game.flippedTen(r).r, '10');
  const res = game.playFlippedTen(r);
  assert.equal(res.effect, 'swipe');
  assert.equal(r.pending, null);
  assert.equal(r.seats.a.blind[0], null);
  assert.equal(r.seats.a.hand.filter((c) => c.r === '10').length, 1, 'the ten in hand stays there');
  assert.equal(game.current(r), 'a');
  assert.equal(r.pile.length, 0);
});

test('auto players can always finish a game, from two at the table to six', () => {
  for (let n = 0; n < 40; n++) {
    const players = ['a', 'b', 'c', 'd', 'e', 'f'].slice(0, 2 + (n % 5));
    const r = game.createRound({ players });
    r.phase = 'play';
    const total = players.length * 20;
    let moves = 0;
    while (r.phase === 'play') {
      const res = game.autoPlay(r, game.current(r));
      assert.equal(res.ok, true, res.error);
      const held = players.reduce((sum, pid) => sum + game.cardsLeft(r.seats[pid]), 0);
      assert.equal(held + r.pile.length + r.burned, total, 'every card is somewhere');
      assert.ok(game.topOf(r.pile).run < 4, 'four of a kind never sits on the pile');
      assert.ok(!r.pile.some((c) => c.r === '10'), 'a ten never sits on the pile');
      if (++moves > 20000) assert.fail('game did not finish');
    }
    assert.equal(game.cardsLeft(r.seats[r.winner]), 0);
    assert.equal(r.result.points[r.winner], 0);
  }
});
