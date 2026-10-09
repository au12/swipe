// Room-level behaviour that needs a hand-built table: runs the Rooms class
// directly, with stand-in sockets that record what each player was sent.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PERSIST = 'false';
process.env.LOG_LEVEL = 'silent';
process.env.DEAL_MS = '0';
const { Rooms } = await import('../server/rooms.js');
const game = await import('../server/game.js');

function table(names) {
  const rooms = new Rooms();
  const room = rooms.create();
  const people = names.map((name) => {
    const sent = [];
    const socket = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
    const { player } = rooms.connect(room, { token: `token-for-${name}-0123456789`, name }, socket);
    return { name, player, sent, states: () => sent.filter((m) => m.t === 'state').map((m) => m.s) };
  });
  assert.equal(rooms.act(room, people[0].player, { a: 'start' }), null);
  const r = room.round;
  r.phase = 'play';
  r.turn = r.order.indexOf(people[0].player.id);
  for (const p of people) p.sent.length = 0;
  return { rooms, room, r, people };
}

let n = 0;
const card = (rank) => ({ id: `z${n++}`, r: rank, s: 's', b: n % 2 });

test('a blind card that turns out to be a ten is played at once, and everyone sees both steps', () => {
  const { rooms, room, r, people } = table(['Ana', 'Bo', 'Cy']);
  const [ana, bo] = people;
  const seat = r.seats[ana.player.id];
  seat.up[0] = null;
  seat.blind[0] = card('10');
  seat.hand = [card('10'), card('4')];
  r.pile = [card('K'), card('7'), card('7')];

  assert.equal(rooms.act(room, ana.player, { a: 'flip', slot: 0 }), null);

  for (const viewer of [ana, bo]) {
    const [flip, play] = viewer.states();
    assert.equal(viewer.states().length, 2, 'two snapshots: the flip, then the play');
    assert.equal(flip.round.last.kind, 'flip');
    assert.equal(flip.round.last.card.r, '10');
    assert.deepEqual(flip.round.pending, { pid: ana.player.id, slot: 0 });
    assert.equal(flip.round.pile.count, 3, 'the pile is still there while the card turns over');
    assert.equal(play.round.last.kind, 'play');
    assert.equal(play.round.last.swipe, 'ten');
    assert.equal(play.round.last.cards[0].from, 'blind');
    assert.equal(play.round.pending, null);
    assert.equal(play.round.pile.count, 0);
    assert.equal(play.round.turn, ana.player.id, 'the extra turn is theirs');
  }
  assert.equal(seat.blind[0], null);
  assert.equal(seat.hand.length, 2, 'the ten in hand was not dragged along');
});

test('any other flipped card waits for its owner to play it', () => {
  const { rooms, room, r, people } = table(['Ana', 'Bo', 'Cy']);
  const [ana] = people;
  const seat = r.seats[ana.player.id];
  seat.up[0] = null;
  seat.blind[0] = card('6');
  r.pile = [card('K')];
  assert.equal(rooms.act(room, ana.player, { a: 'flip', slot: 0 }), null);
  assert.equal(ana.states().length, 1);
  assert.equal(ana.states()[0].round.last.kind, 'flip');
  assert.deepEqual(r.pending, { pid: ana.player.id, slot: 0 });
});

test('a ten flipped for someone else (the host playing their turn) is played at once too', () => {
  const { rooms, room, r, people } = table(['Ana', 'Bo', 'Cy']);
  const [ana, bo] = people;
  r.turn = r.order.indexOf(bo.player.id);
  const seat = r.seats[bo.player.id];
  seat.hand = [card('K')];
  seat.up = [null, card('Q'), card('Q'), card('J')];
  seat.blind[0] = card('10');
  r.pile = [card('2')];
  assert.equal(game.autoMove(r, bo.player.id).a, 'flip', 'with nothing that fits, the auto player gambles on the blind card');
  assert.equal(rooms.act(room, ana.player, { a: 'auto' }), null);
  const kinds = ana.states().map((s) => s.round.last.kind);
  assert.deepEqual(kinds, ['flip', 'play']);
  assert.equal(r.pending, null);
  assert.equal(r.pile.length, 0);
  assert.equal(game.current(r), bo.player.id);
});

test('two tens in one message are refused', () => {
  const { rooms, room, r, people } = table(['Ana', 'Bo', 'Cy']);
  const [ana] = people;
  const seat = r.seats[ana.player.id];
  seat.hand = [card('10'), card('10'), card('3')];
  assert.match(rooms.act(room, ana.player, { a: 'play', cards: seat.hand.slice(0, 2).map((c) => c.id) }), /one at a time/);
  assert.equal(rooms.act(room, ana.player, { a: 'play', cards: [seat.hand[0].id] }), null);
  assert.equal(game.current(r), ana.player.id);
  assert.equal(rooms.act(room, ana.player, { a: 'play', cards: [seat.hand[0].id] }), null);
  assert.equal(seat.hand.length, 1);
});
