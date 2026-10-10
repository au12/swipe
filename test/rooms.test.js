// Room-level behaviour that needs a hand-built table: runs the Rooms class
// directly, with stand-in sockets that record what each player was sent.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PERSIST = 'false';
process.env.LOG_LEVEL = 'silent';
process.env.DEAL_MS = '0';
process.env.PUSH_REMIND_MS = '40';
const { Rooms } = await import('../server/rooms.js');
const { createECDH } = await import('node:crypto');
const game = await import('../server/game.js');

/** A stand-in for a browser tab: records what it is sent, and can be closed. */
function tab() {
  const sent = [];
  const socket = { readyState: 1, sent, closed: null, send: (raw) => sent.push(JSON.parse(raw)), close: (code) => ((socket.closed = code), (socket.readyState = 3)) };
  return socket;
}

/** A subscription a real browser could have produced. */
function subscription(tag = 'a') {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${tag}`, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 3).toString('base64url') } };
}

function table(names) {
  const rooms = new Rooms();
  const pushed = [];
  rooms.sendPush = async (sub, payload, opts) => {
    pushed.push({ to: sub.endpoint, ...payload, opts });
    return rooms.pushResult ?? 'sent';
  };
  const room = rooms.create();
  const people = names.map((name) => {
    const socket = tab();
    const sent = socket.sent;
    const token = `token-for-${name}-0123456789`;
    const { player } = rooms.connect(room, { token, name, origin: 'https://swipe.example.org' }, socket);
    return { name, token, socket, player, sent, states: () => sent.filter((m) => m.t === 'state').map((m) => m.s) };
  });
  rooms.pushed = pushed;
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

// ───────────────────────── turn notifications ─────────────────────────

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
/** Plays the current player's lowest card that fits, by any means, so the turn moves on. */
function pass(rooms, room, r, people) {
  const pid = game.current(r);
  const who = people.find((p) => p.player.id === pid);
  const seat = r.seats[pid];
  seat.hand = [card('A'), card('A'), ...seat.hand];
  assert.equal(rooms.act(room, who.player, { a: 'play', cards: [seat.hand[0].id] }), null);
}

test('a player who is not looking gets a notification when the turn reaches them', async () => {
  const { rooms, room, r, people } = table(['Ana', 'Bo', 'Cy']);
  const [ana, bo, cy] = people;
  assert.equal(rooms.act(room, bo.player, { a: 'push', sub: subscription('bo') }), null);
  assert.equal(rooms.act(room, cy.player, { a: 'push', sub: subscription('cy') }), null);
  assert.equal(bo.states().at(-1).notify, true);
  assert.equal(ana.states().at(-1)?.notify ?? false, false, 'nobody else is told');
  assert.ok(!JSON.stringify(ana.sent).includes('fcm.googleapis.com'), 'a subscription is never sent to anyone');

  rooms.setVisible(room, bo.player, bo.socket, false); // Bo locks his phone; Cy stays on the page
  r.pile = [card('K')];
  pass(rooms, room, r, people); // Ana plays: Bo's turn
  await tick();
  assert.equal(rooms.pushed.length, 1);
  const n = rooms.pushed[0];
  assert.equal(n.to, 'https://fcm.googleapis.com/fcm/send/bo');
  assert.equal(n.title, 'Your turn');
  assert.equal(n.body, 'Ana played an ace. Aces only, or a ten.');
  assert.equal(n.url, `r/${room.code}`);
  assert.equal(n.tag, `swipe-${room.code}`);
  assert.equal(n.opts.origin, 'https://swipe.example.org');
  assert.match(n.opts.topic, /^[\w-]{1,32}$/);

  pass(rooms, room, r, people); // Bo's turn is played: Cy's turn, and Cy is watching
  await tick();
  assert.equal(rooms.pushed.length, 1, 'no notification for someone with the game in front of them');
});

test('an extra turn is not announced twice, and coming round again is', async () => {
  const { rooms, room, r, people } = table(['Ana', 'Bo']);
  const [ana, bo] = people;
  rooms.act(room, bo.player, { a: 'push', sub: subscription('bo') });
  rooms.setVisible(room, bo.player, bo.socket, false);
  pass(rooms, room, r, people); // to Bo
  await tick();
  assert.equal(rooms.pushed.length, 1);
  // The host plays Bo's turn for him: a ten, so Bo goes again. He has already been told.
  const seat = r.seats[bo.player.id];
  seat.hand = [card('10'), card('2'), card('2')];
  seat.up = [null, null, null, null];
  assert.equal(rooms.act(room, ana.player, { a: 'auto' }), null);
  assert.equal(game.current(r), bo.player.id);
  await tick();
  assert.equal(rooms.pushed.length, 1, 'same turn-holder, no second notification');
  assert.equal(rooms.act(room, ana.player, { a: 'auto' }), null); // Bo's extra turn is played: over to Ana
  pass(rooms, room, r, people); // Ana plays: Bo again
  await tick();
  assert.equal(rooms.pushed.length, 2, 'a new turn, a new notification');
});

test('looking away during your own turn brings a reminder, once', async () => {
  const { rooms, room, r, people } = table(['Ana', 'Bo', 'Cy']);
  const [ana] = people;
  rooms.act(room, ana.player, { a: 'push', sub: subscription('ana') });
  assert.equal(game.current(r), ana.player.id);
  rooms.alertTurn(room);
  await tick();
  assert.equal(rooms.pushed.length, 0, 'she is looking at it');
  rooms.setVisible(room, ana.player, ana.socket, false);
  await tick(10);
  assert.equal(rooms.pushed.length, 0, 'not straight away');
  await tick(80);
  assert.equal(rooms.pushed.length, 1);
  assert.equal(rooms.pushed[0].title, 'Still your turn');
  rooms.setVisible(room, ana.player, ana.socket, true);
  rooms.setVisible(room, ana.player, ana.socket, false);
  await tick(80);
  assert.equal(rooms.pushed.length, 1, 'only one reminder a turn');

  // Coming back before the reminder is due cancels it.
  const again = table(['Dee', 'Eli']);
  const dee = again.people[0];
  again.rooms.act(again.room, dee.player, { a: 'push', sub: subscription('dee') });
  again.rooms.setVisible(again.room, dee.player, dee.socket, false);
  again.rooms.setVisible(again.room, dee.player, dee.socket, true);
  await tick(80);
  assert.equal(again.rooms.pushed.length, 0);
});

test('closing the tab counts as not looking', async () => {
  const { rooms, room, r, people } = table(['Ana', 'Bo', 'Cy']);
  const [, bo] = people;
  rooms.act(room, bo.player, { a: 'push', sub: subscription('bo') });
  bo.socket.readyState = 3;
  rooms.disconnect(room, bo.player, bo.socket);
  pass(rooms, room, r, people);
  await tick();
  assert.equal(rooms.pushed.length, 1);
});

test('a subscription the browser has dropped is forgotten', async () => {
  const { rooms, room, r, people } = table(['Ana', 'Bo', 'Cy']);
  const [, bo] = people;
  rooms.act(room, bo.player, { a: 'push', sub: subscription('bo') });
  rooms.setVisible(room, bo.player, bo.socket, false);
  rooms.pushResult = 'gone';
  pass(rooms, room, r, people);
  await tick();
  assert.equal(bo.player.push, null);
  assert.equal(bo.states().at(-1).notify, false, 'and the browser is told, so it can offer to turn them back on');
});

test('notifications: bad destinations are refused, a test can be sent, and they can be turned off', async () => {
  const { rooms, room, people } = table(['Ana', 'Bo']);
  const [ana] = people;
  assert.match(rooms.act(room, ana.player, { a: 'pushTest' }), /off in this browser/);
  assert.match(rooms.act(room, ana.player, { a: 'push', sub: { ...subscription(), endpoint: 'https://192.168.1.1/admin' } }), /not one Swipe can send to/);
  assert.match(rooms.act(room, ana.player, { a: 'push', sub: 'nonsense' }), /not one Swipe can send to/);
  assert.equal(ana.player.push ?? null, null);
  const sub = subscription('ana');
  assert.equal(rooms.act(room, ana.player, { a: 'push', sub }), null);
  const before = ana.sent.length;
  assert.equal(rooms.act(room, ana.player, { a: 'push', sub }), null);
  assert.equal(ana.sent.length, before, 'sending the same subscription again changes nothing');
  assert.equal(rooms.act(room, ana.player, { a: 'pushTest' }), null);
  await tick();
  assert.equal(rooms.pushed.at(-1).kind, 'test');
  assert.equal(rooms.act(room, ana.player, { a: 'push', sub: null }), null);
  assert.equal(ana.player.push, null);
  assert.equal(ana.states().at(-1).notify, false);
});

test('computer players and the game being over never trigger a notification', async () => {
  const { rooms, room, r, people } = table(['Ana', 'Bo']);
  const [ana, bo] = people;
  rooms.act(room, bo.player, { a: 'push', sub: subscription('bo') });
  rooms.setVisible(room, bo.player, bo.socket, false);
  const seat = r.seats[ana.player.id];
  seat.hand = [card('3')];
  seat.up = [null, null, null, null];
  seat.blind = [null, null, null, null];
  assert.equal(rooms.act(room, ana.player, { a: 'play', cards: [seat.hand[0].id] }), null);
  assert.equal(r.phase, 'over');
  await tick();
  assert.equal(rooms.pushed.length, 0);
});

// ───────────────────────── seat codes ─────────────────────────

test('a seat code moves the seat, cards and score to another browser', () => {
  const { rooms, room, r, people } = table(['Ana', 'Bo', 'Cy']);
  const [, bo] = people;
  const hand = r.seats[bo.player.id].hand.map((c) => c.id);
  rooms.act(room, bo.player, { a: 'push', sub: subscription('bo') });
  const { code, until } = rooms.seatCode(room, bo.player);
  assert.match(code, /^[A-HJ-NP-TV-Z2-9]{8}$/);
  assert.ok(until > Date.now() + 14 * 60_000);

  const phone = tab();
  const res = rooms.connect(room, { token: 'a-brand-new-browser-token-xyz', name: '', claim: `${code.slice(0, 4)}-${code.slice(4).toLowerCase()}` }, phone);
  assert.equal(res.claimed, true);
  assert.equal(res.player, bo.player, 'the same player, not a newcomer');
  assert.equal(bo.player.name, 'Bo');
  assert.equal(bo.player.token, 'a-brand-new-browser-token-xyz');
  assert.equal(bo.player.push, null, 'the old browser’s notifications do not follow');
  assert.equal(room.players.size, 3);
  assert.deepEqual(r.seats[bo.player.id].hand.map((c) => c.id), hand);
  assert.equal(bo.socket.closed, 4003);
  assert.deepEqual(bo.sent.at(-1), { t: 'moved' });
  rooms.broadcast(room);
  assert.equal(phone.sent.at(-1).s.round.mine.length, hand.length, 'the new browser sees the hand');

  // The code is spent (and so is any other this player was holding), and the old browser is a stranger now.
  const again = rooms.connect(room, { token: 'yet-another-browser-token-123', name: '', claim: code }, tab());
  assert.equal(again.claimed, false);
  assert.equal(again.code, 'name');
  const old = rooms.connect(room, { token: bo.token, name: '' }, tab());
  assert.equal(old.code, 'name');
});

test('a wrong, expired or missing seat code changes nothing', () => {
  const { rooms, room, people } = table(['Ana', 'Bo']);
  const [, bo] = people;
  const { code } = rooms.seatCode(room, bo.player);
  for (const guess of ['', 'AAAAAAAA', code.slice(0, 7), `${code}X`, '<script>']) {
    const res = rooms.connect(room, { token: 'a-guessing-browser-token-00', name: '', claim: guess }, tab());
    assert.notEqual(res.claimed, true, guess);
    assert.equal(res.code, 'name');
  }
  bo.player.seats[0].until = Date.now() - 1;
  assert.equal(rooms.connect(room, { token: 'a-late-browser-token-000000', name: '', claim: code }, tab()).claimed, false);
  assert.equal(bo.player.token, bo.token);
  assert.equal(room.players.size, 2);
});

test('someone who already walked in as a newcomer can still claim their real seat', () => {
  const { rooms, room, r, people } = table(['Ana', 'Bo', 'Cy']);
  const [ana, bo] = people;
  const newcomer = tab();
  const first = rooms.connect(room, { token: 'the-home-screen-app-token-01', name: 'Bo' }, newcomer);
  assert.equal(first.player.name, 'Bo 2');
  assert.equal(room.players.size, 4);
  const { code } = rooms.seatCode(room, bo.player);
  const res = rooms.connect(room, { token: 'the-home-screen-app-token-01', name: 'Bo', claim: code }, tab());
  assert.equal(res.claimed, true);
  assert.equal(res.player, bo.player);
  assert.equal(room.players.size, 3, 'the stand-in is gone');
  assert.equal(newcomer.closed, 4002);
  assert.equal(r.order.length, 3);
  assert.equal(room.hostId, ana.player.id);
});

test('a player can hold a few seat codes at once; using one spends them all', () => {
  const { rooms, room, people } = table(['Ana', 'Bo']);
  const [, bo] = people;
  const codes = [1, 2, 3, 4, 5].map(() => rooms.seatCode(room, bo.player).code);
  assert.equal(new Set(codes).size, 5);
  assert.equal(bo.player.seats.length, 4, 'the four newest are kept');
  assert.equal(rooms.connect(room, { token: 'first-other-browser-token-0', name: '', claim: codes[0] }, tab()).claimed, false, 'the oldest fell off');
  assert.equal(rooms.connect(room, { token: 'second-other-browser-token-', name: '', claim: codes[2] }, tab()).claimed, true);
  assert.equal(rooms.connect(room, { token: 'third-other-browser-token-0', name: '', claim: codes[4] }, tab()).claimed, false);
});

test('a seat code made for a Home Screen link outlives one shown on screen', () => {
  const { rooms, room, people } = table(['Ana', 'Bo']);
  const [, bo] = people;
  const shown = rooms.seatCode(room, bo.player);
  const link = rooms.seatCode(room, bo.player, { forLink: true });
  assert.ok(shown.until - Date.now() <= 15 * 60_000);
  assert.ok(link.until - Date.now() > 11 * 3600_000);
  // Three hours on, the app is opened for the first time: the link's code still works.
  bo.player.seats.forEach((s) => (s.until -= 3 * 3600_000));
  assert.equal(rooms.connect(room, { token: 'too-late-with-the-short-one', name: '', claim: shown.code }, tab()).claimed, false);
  assert.equal(rooms.connect(room, { token: 'the-home-screen-app-token-02', name: '', claim: link.code }, tab()).claimed, true);
});

// ───────────────────────── the turn clock ─────────────────────────

/** Makes the clock run out right now for whoever is on turn. */
function expire(rooms, room, r) {
  r.deadline = Date.now() - 1;
  rooms.onTimeout(room);
}

test('when the clock runs out the player is skipped: nothing is played, and she draws three cards', () => {
  const { rooms, room, r, people } = table(['Ana', 'Bo', 'Cy']);
  const [ana, bo] = people;
  const seat = r.seats[ana.player.id];
  seat.hand = [card('10'), card('3'), card('3'), card('K')]; // plenty she could have played
  r.pile = [card('9'), card('6')];
  const stock = r.stock.length;
  const before = JSON.stringify([seat.up, seat.blind, r.seats[bo.player.id], r.pile, r.burned]);

  expire(rooms, room, r);

  assert.equal(JSON.stringify([seat.up, seat.blind, r.seats[bo.player.id], r.pile, r.burned]), before, 'nothing was played');
  assert.equal(seat.hand.length, 4 + 3);
  assert.equal(r.stock.length, stock - 3);
  assert.equal(game.current(r), bo.player.id, 'play passes to the next player');
  const drawn = seat.hand.slice(4);
  for (const viewer of people) {
    const s = viewer.states().at(-1);
    assert.deepEqual(s.round.last, { seq: r.seq, kind: 'skip', by: ana.player.id, drew: 3, forced: false, backs: drawn.map((c) => c.b) }, 'everyone is told');
    assert.deepEqual(s.round.log.at(-1), { k: 'skip', by: ana.player.id, drew: 3, forced: false });
    assert.equal(s.round.seats[ana.player.id].left, 4 + 3 + 8);
    assert.ok(!('stock' in s.round) && !('swiped' in s.round), 'the stock is nobody’s to see');
    // Only Ana is told which cards she drew.
    const told = JSON.stringify(s);
    for (const c of drawn) assert.equal(told.includes(`"id":"${c.id}"`), viewer === ana, `${viewer.name} and card ${c.id}`);
  }
  assert.deepEqual(ana.states().at(-1).round.mine.slice(4).map((c) => c.id), drawn.map((c) => c.id));
});

test('skipped with nothing she could have played, she draws a card for every card in the pile', () => {
  const { rooms, room, r, people } = table(['Ana', 'Bo', 'Cy']);
  const [ana, bo] = people;
  const seat = r.seats[ana.player.id];
  seat.hand = [card('K'), card('Q')];
  seat.up = [card('J'), card('J'), card('9'), card('8')];
  r.pile = ['7', '7', '6', '5', '5', '4', '2'].map(card);

  expire(rooms, room, r);

  assert.equal(seat.hand.length, 2 + 7);
  assert.equal(r.pile.length, 7, 'the pile stays for the next player');
  assert.equal(game.current(r), bo.player.id);
  const last = bo.states().at(-1).round.last;
  assert.deepEqual({ drew: last.drew, forced: last.forced, backs: last.backs.length }, { drew: 7, forced: true, backs: 7 });
});

test('the clock only acts when it has really run out', () => {
  const { rooms, room, r, people } = table(['Ana', 'Bo']);
  r.deadline = Date.now() + 5000;
  rooms.onTimeout(room);
  assert.equal(game.current(r), people[0].player.id);
  r.deadline = null;
  rooms.onTimeout(room);
  assert.equal(game.current(r), people[0].player.id);
  assert.equal(r.last.kind, 'deal');
});

test('running out of time with a blind card already flipped plays that card, alone', () => {
  const { rooms, room, r, people } = table(['Ana', 'Bo', 'Cy']);
  const [ana, bo] = people;
  const seat = r.seats[ana.player.id];
  seat.hand = [card('6'), card('6'), card('2')];
  seat.up[0] = null;
  seat.blind[0] = card('6');
  r.pile = [card('9')];
  assert.equal(rooms.act(room, ana.player, { a: 'flip', slot: 0 }), null);

  expire(rooms, room, r);

  assert.equal(r.pending, null);
  assert.equal(seat.blind[0], null);
  assert.equal(seat.hand.length, 3, 'her matching sixes stay in her hand: that was her call to make');
  assert.deepEqual(r.pile.map((c) => c.r), ['9', '6']);
  assert.equal(game.current(r), bo.player.id);
  assert.deepEqual(r.log.slice(-2).map((e) => e.k), ['timeout', 'play']);
});

test('a skip sends the next player their notification, saying what happened', async () => {
  const { rooms, room, r, people } = table(['Ana', 'Bo', 'Cy']);
  const [, bo] = people;
  rooms.act(room, bo.player, { a: 'push', sub: subscription('bo') });
  rooms.setVisible(room, bo.player, bo.socket, false);
  r.pile = [card('J')];
  expire(rooms, room, r);
  await tick();
  assert.equal(rooms.pushed.length, 1);
  assert.equal(rooms.pushed[0].body, 'Ana ran out of time and drew 3 cards. J or lower, or a ten.');
});

test('the host playing a turn for someone still plays it, flip and all', async () => {
  const { rooms, room, r, people } = table(['Ana', 'Bo', 'Cy']);
  const [ana, bo] = people;
  r.turn = r.order.indexOf(bo.player.id);
  const seat = r.seats[bo.player.id];
  seat.hand = [card('K')];
  seat.up = [null, card('Q'), card('Q'), card('J')];
  seat.blind[0] = card('4');
  r.pile = [card('2')];
  rooms.syncTimer(room); // the table was rearranged by hand: let the clock catch up with whose turn it is
  assert.equal(rooms.act(room, ana.player, { a: 'auto' }), null); // flips the blind card for Bo
  assert.deepEqual(r.pending, { pid: bo.player.id, slot: 0 });
  await tick(60); // the card is shown for a moment, then goes down
  for (let i = 0; i < 80 && r.pending; i++) await tick(25);
  assert.equal(r.pending, null);
  assert.equal(seat.blind[0], null);
  assert.ok(!r.log.some((e) => e.k === 'timeout' || e.k === 'skip'), 'nobody ran out of time');
});

// ───────────────────────── chat ─────────────────────────

const chats = (person) => person.sent.filter((m) => m.t === 'chat' && m.m).map((m) => m.m);

test('a message reaches everyone in the room, the sender included, and nobody’s cards change', () => {
  const { rooms, room, r, people } = table(['Ana', 'Bo', 'Cy']);
  const [ana, bo, cy] = people;
  const before = JSON.stringify([r.seats, r.pile, r.turn, r.seq]);
  assert.equal(rooms.act(room, bo.player, { a: 'chat', text: '  Nice   swipe,\n Ana!  ' }), null);
  for (const p of [ana, bo, cy]) {
    assert.deepEqual(
      chats(p).map((m) => ({ ...m, at: null })),
      [{ id: 1, by: bo.player.id, name: 'Bo', color: bo.player.color, text: 'Nice swipe, Ana!', at: null }],
      p.name,
    );
    assert.equal(p.states().length, 0, 'talk is not a move: no new picture of the table is sent');
  }
  assert.ok(Math.abs(chats(ana)[0].at - Date.now()) < 2000);
  assert.equal(JSON.stringify([r.seats, r.pile, r.turn, r.seq]), before);

  // Someone watching, not dealt in, can talk too.
  const watcher = tab();
  const { player: dee } = rooms.connect(room, { token: 'token-for-Dee-0123456789', name: 'Dee' }, watcher);
  assert.equal(dee.playing, false);
  assert.equal(rooms.act(room, dee, { a: 'chat', text: 'Room for one more next game?' }), null);
  assert.equal(chats(ana).at(-1).name, 'Dee');
  assert.equal(chats(ana).at(-1).id, 2);
});

test('someone joining is sent what has been said so far, and the room remembers the last hundred', () => {
  const { rooms, room, people } = table(['Ana', 'Bo']);
  const [ana] = people;
  for (let i = 1; i <= 104; i++) {
    ana.player.said = []; // (not the point of this test)
    assert.equal(rooms.act(room, ana.player, { a: 'chat', text: `line ${i}` }), null);
  }
  assert.equal(room.chat.length, 100);
  assert.deepEqual([room.chat[0].text, room.chat.at(-1).text], ['line 5', 'line 104']);

  const late = tab();
  rooms.connect(room, { token: 'token-for-Cy-0123456789ab', name: 'Cy' }, late);
  const history = late.sent.find((m) => m.t === 'chat');
  assert.equal(history.all.length, 100);
  assert.equal(history.all.at(-1).text, 'line 104');
  assert.ok(late.sent.findIndex((m) => m.t === 'chat') < late.sent.length, 'it arrives with the first picture of the room');

  // And it is saved with the room, without the bookkeeping that paces people.
  const saved = rooms.serialize().find((x) => x.code === room.code);
  assert.equal(saved.chat.length, 100);
  assert.ok(saved.players.every((p) => !('said' in p) && !('chatPushedAt' in p)));
});

test('empty, oversized and odd messages are tidied or refused; a flood is slowed', () => {
  const { rooms, room, people } = table(['Ana', 'Bo']);
  const [ana, bo] = people;
  for (const text of ['', '   ', '\n\t', null, undefined, 42 === 0, {}, { toString: 1 }, ['hi']]) {
    assert.match(rooms.act(room, ana.player, { a: 'chat', text }), /Type a message/, JSON.stringify(text));
  }
  assert.equal(chats(bo).length, 0);

  assert.equal(rooms.act(room, ana.player, { a: 'chat', text: `<b>hi</b> ${'x'.repeat(400)}` }), null);
  const long = chats(bo).at(-1).text;
  assert.equal(long.length, 240);
  assert.ok(long.startsWith('<b>hi</b> x'), 'markup is kept as plain text: showing it safely is the page’s job');
  assert.equal(rooms.act(room, ana.player, { a: 'chat', text: 'a\u0000b c\u0007d' }), null);
  assert.equal(chats(bo).at(-1).text, 'a b c d');
  assert.equal(rooms.act(room, ana.player, { a: 'chat', text: 7 }), null, 'a number is fine');
  assert.equal(chats(bo).at(-1).text, '7');

  // Six in ten seconds is the most one person may send. It does not hold anyone else up.
  ana.player.said = [];
  for (let i = 0; i < 6; i++) assert.equal(rooms.act(room, ana.player, { a: 'chat', text: `quick ${i}` }), null);
  const count = chats(bo).length;
  assert.match(rooms.act(room, ana.player, { a: 'chat', text: 'one too many' }), /a lot of messages/);
  assert.equal(chats(bo).length, count, 'the refused one went to nobody');
  assert.equal(rooms.act(room, bo.player, { a: 'chat', text: 'steady on' }), null);
  ana.player.said = ana.player.said.map((at) => at - 11_000); // ten seconds later
  assert.equal(rooms.act(room, ana.player, { a: 'chat', text: 'sorry' }), null);
});

test('a message is pushed to whoever is away, and only to them', async () => {
  const { rooms, room, people } = table(['Ana', 'Bo', 'Cy', 'Dee']);
  const [ana, bo, cy, dee] = people;
  for (const p of [ana, bo, cy]) rooms.act(room, p.player, { a: 'push', sub: subscription(p.name) });
  // Dee has notifications off. Bo has locked his phone; Cy has closed the tab; Ana is looking at the game.
  rooms.setVisible(room, bo.player, bo.socket, false);
  rooms.disconnect(room, cy.player, cy.socket);
  rooms.setVisible(room, dee.player, dee.socket, false);
  rooms.pushed.length = 0;

  assert.equal(rooms.act(room, ana.player, { a: 'chat', text: 'Anyone still there?' }), null);
  await tick();
  assert.deepEqual(rooms.pushed.map((p) => p.to).sort(), [subscription('Bo').endpoint, subscription('Cy').endpoint].sort());
  const sent = rooms.pushed[0];
  assert.deepEqual(
    { kind: sent.kind, title: sent.title, body: sent.body, tag: sent.tag, url: sent.url },
    { kind: 'chat', title: `Ana in ${room.code}`, body: 'Anyone still there?', tag: `swipe-chat-${room.code}`, url: `r/${room.code}` },
  );

  // Its tag and topic are its own, so it never replaces a "your turn" still waiting on the phone.
  rooms.pushed.length = 0;
  rooms.notify(room, bo.player, { kind: 'turn', title: 'Your turn', body: 'Play anything.' });
  await tick();
  assert.equal(rooms.pushed[0].tag, `swipe-${room.code}`);
  assert.notEqual(rooms.pushed[0].opts.topic, sent.opts.topic);

  // The sender is never notified of their own message, away or not.
  rooms.pushed.length = 0;
  rooms.setVisible(room, bo.player, bo.socket, false);
  bo.player.chatPushedAt = 0;
  cy.player.chatPushedAt = 0;
  assert.equal(rooms.act(room, bo.player, { a: 'chat', text: 'Here, just slow.' }), null);
  await tick();
  assert.deepEqual(rooms.pushed.map((p) => p.to), [subscription('Cy').endpoint]);
});

test('a run of messages does not buzz an absent player again and again', async () => {
  const { rooms, room, people } = table(['Ana', 'Bo']);
  const [ana, bo] = people;
  rooms.act(room, bo.player, { a: 'push', sub: subscription('Bo') });
  rooms.setVisible(room, bo.player, bo.socket, false);
  rooms.pushed.length = 0;
  for (const text of ['one', 'two', 'three']) rooms.act(room, ana.player, { a: 'chat', text });
  await tick();
  assert.deepEqual(rooms.pushed.map((p) => p.body), ['one'], 'the phone buzzes once');
  assert.equal(chats(bo).length, 3, 'all three are waiting in the room');
  bo.player.chatPushedAt -= 9_000; // a little later
  rooms.act(room, ana.player, { a: 'chat', text: 'four' });
  await tick();
  assert.deepEqual(rooms.pushed.map((p) => p.body), ['one', 'four']);
  // Back and looking: nothing more is pushed.
  rooms.setVisible(room, bo.player, bo.socket, true);
  bo.player.chatPushedAt = 0;
  ana.player.said = [];
  rooms.act(room, ana.player, { a: 'chat', text: 'five' });
  await tick();
  assert.equal(rooms.pushed.length, 2);
});
