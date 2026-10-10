// All-time stats: what a finished game adds to them, who they belong to when
// people come and go, and what the admin can do to them (reset, fold two
// people into one, rename).

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PERSIST = 'false';
process.env.LOG_LEVEL = 'silent';
process.env.DEAL_MS = '0';
const { Rooms, statKey } = await import('../server/rooms.js');
const game = await import('../server/game.js');

function tab() {
  const sent = [];
  const socket = { readyState: 1, sent, closed: null, send: (raw) => sent.push(JSON.parse(raw)), close: (code) => ((socket.closed = code), (socket.readyState = 3)) };
  return socket;
}
const tokenOf = (name) => `token-for-${name}-0123456789`;

function join(rooms, room, name, token = tokenOf(name)) {
  const socket = tab();
  const res = rooms.connect(room, { token, name }, socket);
  return { name, token, socket, player: res.player, key: statKey(token), board: () => socket.sent.filter((m) => m.t === 'stats').at(-1)?.rows ?? null };
}

function table(names) {
  const rooms = new Rooms();
  const room = rooms.create();
  const people = names.map((name) => join(rooms, room, name));
  return { rooms, room, people };
}

let n = 0;
const card = (rank) => ({ id: `s${n++}`, r: rank, s: 's', b: n % 2 });

/**
 * Plays a whole game in one move: `winner` goes out with their last card and
 * everyone else is left holding what `left` says ({ Bo: ['K', '5'] }).
 */
function playGame(rooms, room, winner, left = {}) {
  const host = [...room.players.values()].find((p) => p.id === room.hostId);
  assert.equal(rooms.act(room, host, { a: 'start' }), null);
  const r = room.round;
  r.phase = 'play';
  for (const pid of r.order) {
    const p = room.players.get(pid);
    const mine = p === winner.player ? ['2'] : (left[p.name] ?? ['K']);
    r.seats[pid] = { hand: mine.map(card), up: [null, null, null, null], blind: [null, null, null, null] };
  }
  r.pile = [];
  r.turn = r.order.indexOf(winner.player.id);
  assert.equal(rooms.act(room, winner.player, { a: 'play', cards: [r.seats[winner.player.id].hand[0].id] }), null);
  assert.equal(r.phase, 'over');
  assert.equal(r.winner, winner.player.id);
}
const row = (rows, name) => rows.find((x) => x.name === name);
const pick = (x) => x && { games: x.games, wins: x.wins, points: x.points };

test('a finished game adds a game for everyone in it, a win for whoever went out, and the points each was left with', () => {
  const { rooms, room, people } = table(['Ana', 'Bo', 'Cy']);
  const [ana, bo, cy] = people;
  assert.deepEqual(ana.board(), [], 'the board is sent on arrival, empty before the first game');

  playGame(rooms, room, ana, { Bo: ['K', '5'], Cy: ['10', 'A'] });
  for (const p of people) {
    const rows = p.board();
    assert.deepEqual(pick(row(rows, 'Ana')), { games: 1, wins: 1, points: 0 });
    assert.deepEqual(pick(row(rows, 'Bo')), { games: 1, wins: 0, points: 15 });
    assert.deepEqual(pick(row(rows, 'Cy')), { games: 1, wins: 0, points: 21 }, 'a ten still costs 20');
  }
  playGame(rooms, room, bo, { Ana: ['9'], Cy: ['3', '3'] });
  playGame(rooms, room, ana, { Bo: ['J'], Cy: ['4'] });
  const rows = cy.board();
  assert.deepEqual(pick(row(rows, 'Ana')), { games: 3, wins: 2, points: 9 });
  assert.deepEqual(pick(row(rows, 'Bo')), { games: 3, wins: 1, points: 25 });
  assert.deepEqual(pick(row(rows, 'Cy')), { games: 3, wins: 0, points: 31 });
  assert.deepEqual(row(rows, 'Ana'), { id: ana.key, name: 'Ana', color: ana.player.color, bot: false, here: true, games: 3, wins: 2, points: 9 });
  assert.ok(!JSON.stringify(rows).includes(ana.token), 'the key is made from the seat token but does not give it away');
});

test('a game that is called off counts for nothing, and neither does one a player walked out of', () => {
  const { rooms, room, people } = table(['Ana', 'Bo', 'Cy']);
  const [ana, bo, cy] = people;
  assert.equal(rooms.act(room, ana.player, { a: 'start' }), null);
  room.round.phase = 'play';
  assert.equal(rooms.act(room, ana.player, { a: 'endGame' }), null);
  assert.deepEqual(ana.board(), []);

  // Cy leaves the table part-way through the next one: the other two finish it.
  assert.equal(rooms.act(room, ana.player, { a: 'start' }), null);
  room.round.phase = 'play';
  assert.equal(rooms.act(room, cy.player, { a: 'sit', on: false }), null);
  const r = room.round;
  for (const pid of r.order) r.seats[pid] = { hand: [card(pid === ana.player.id ? '2' : 'Q')], up: [null, null, null, null], blind: [null, null, null, null] };
  r.pile = [];
  r.turn = r.order.indexOf(ana.player.id);
  assert.equal(rooms.act(room, ana.player, { a: 'play', cards: [r.seats[ana.player.id].hand[0].id] }), null);
  assert.deepEqual(bo.board().map((x) => x.name).sort(), ['Ana', 'Bo']);
});

test('computer players have a record too, under their name', () => {
  const { rooms, room, people } = table(['Ana']);
  const [ana] = people;
  rooms.act(room, ana.player, { a: 'addBot' });
  const bot = [...room.players.values()].find((p) => p.bot);
  playGame(rooms, room, ana);
  const rows = ana.board();
  assert.deepEqual(pick(row(rows, bot.name)), { games: 1, wins: 0, points: 10 });
  assert.equal(row(rows, bot.name).bot, true);
  assert.equal(row(rows, bot.name).id, `b:${bot.name.toLowerCase()}`);
});

test('someone the room has forgotten gets their record back when the same browser returns', () => {
  const { rooms, room, people } = table(['Ana', 'Bo', 'Cy']);
  const [ana, , cy] = people;
  playGame(rooms, room, cy);
  // Cy is gone for a day: the room tidies her seat away, as it does.
  rooms.disconnect(room, cy.player, cy.socket);
  rooms.act(room, ana.player, { a: 'lobby' });
  cy.player.seenAt = Date.now() - 24 * 3600_000;
  rooms.sweep();
  assert.equal(room.players.has(cy.player.id), false);
  assert.deepEqual(pick(row(ana.board() ?? rooms.statRows(room), 'Cy')), { games: 1, wins: 1, points: 0 }, 'the record outlives the seat');
  assert.equal(row(rooms.statRows(room), 'Cy').here, false);

  const back = join(rooms, room, 'Cy');
  assert.notEqual(back.player.id, cy.player.id, 'a new seat');
  playGame(rooms, room, ana);
  assert.deepEqual(pick(row(rooms.statRows(room), 'Cy')), { games: 2, wins: 1, points: 10 }, 'the same record');
  assert.equal(rooms.statRows(room).filter((x) => x.name === 'Cy').length, 1);
});

test('a seat moved to another browser with a seat code keeps its record, now and after being forgotten', () => {
  const { rooms, room, people } = table(['Ana', 'Bo']);
  const [ana, bo] = people;
  playGame(rooms, room, bo);
  const { code } = rooms.seatCode(room, bo.player);
  const phone = tab();
  assert.equal(rooms.connect(room, { token: 'bo-on-his-new-phone-token-01', name: '', claim: code }, phone).claimed, true);
  playGame(rooms, room, bo);
  assert.deepEqual(pick(row(rooms.statRows(room), 'Bo')), { games: 2, wins: 2, points: 0 });
  // Forgotten and back, from the phone: still the one record.
  rooms.disconnect(room, bo.player, phone);
  rooms.act(room, ana.player, { a: 'lobby' });
  bo.player.seenAt = Date.now() - 24 * 3600_000;
  rooms.sweep();
  rooms.connect(room, { token: 'bo-on-his-new-phone-token-01', name: 'Bo' }, tab());
  playGame(rooms, room, ana);
  assert.deepEqual(rooms.statRows(room).filter((x) => x.name === 'Bo').map(pick), [{ games: 3, wins: 2, points: 10 }]);
});

// ───────────────────────── the admin's side ─────────────────────────

test('resetting one player leaves the others alone; resetting the room clears the board', () => {
  const { rooms, room, people } = table(['Ana', 'Bo', 'Cy']);
  const [ana, bo] = people;
  playGame(rooms, room, ana);
  playGame(rooms, room, bo);
  assert.equal(rooms.resetStats(room, bo.key), 1);
  assert.deepEqual(ana.board().map((x) => x.name).sort(), ['Ana', 'Cy'], 'everyone is sent the new board');
  assert.deepEqual(pick(row(ana.board(), 'Ana')), { games: 2, wins: 1, points: 10 });
  assert.equal(rooms.resetStats(room, bo.key), 0, 'nothing left to reset');
  assert.equal(rooms.resetStats(room, 'no-such-key'), 0);
  // He starts again from nothing.
  playGame(rooms, room, bo);
  assert.deepEqual(pick(row(ana.board(), 'Bo')), { games: 1, wins: 1, points: 0 });

  assert.equal(rooms.resetStats(room), 3);
  assert.deepEqual(ana.board(), []);
  assert.deepEqual(room.stats, {});
});

test('the same person twice: the stale seat is offline, and the admin folds the newcomer into it', () => {
  const { rooms, room, people } = table(['Ana', 'Bo', 'Cy']);
  const [ana, bo] = people;
  playGame(rooms, room, bo, { Ana: ['4'] });
  playGame(rooms, room, ana, { Bo: ['9'] });
  const scoreBefore = room.match.scores[bo.player.id];

  // Bo clears his browser. The room sees his old seat go offline and a stranger called "Bo 2" walk in.
  rooms.disconnect(room, bo.player, bo.socket);
  const again = join(rooms, room, 'Bo', 'a-brand-new-browser-token-01');
  assert.equal(again.player.name, 'Bo 2');
  assert.equal(again.player.playing, false, 'mid-match, he is only watching');
  assert.equal(room.players.size, 4);

  const res = rooms.consolidate(room, [bo.key, again.key], bo.key);
  assert.deepEqual(res, { key: bo.key, name: 'Bo', merged: 2, removed: ['Bo 2'] });
  // One Bo: the old seat, with its place in the match and its score, now answering to the new browser.
  assert.equal(room.players.size, 3);
  assert.equal(room.players.has(again.player.id), false);
  assert.equal(bo.player.token, 'a-brand-new-browser-token-01');
  assert.equal(room.match.scores[bo.player.id], scoreBefore);
  assert.equal(room.match.order.includes(bo.player.id), true);
  assert.equal(again.socket.closed, 4002, 'the new browser is told to reconnect…');
  const tabAgain = tab();
  const rejoined = rooms.connect(room, { token: 'a-brand-new-browser-token-01', name: 'Bo' }, tabAgain);
  assert.equal(rejoined.player, bo.player, '…and comes back as Bo');
  assert.equal(bo.player.online, true);

  playGame(rooms, room, bo);
  assert.deepEqual(rooms.statRows(room).filter((x) => x.name.startsWith('Bo')).map(pick), [{ games: 3, wins: 2, points: 9 }]);
});

test('folding adds the records together, and games from either browser count for the one person from then on', () => {
  const { rooms, room, people } = table(['Ana', 'Bo']);
  const [ana, bo] = people;
  playGame(rooms, room, bo, { Ana: ['7'] });
  // Bo plays on as "Bobby" from another browser for a while, with a seat of his own.
  rooms.act(room, ana.player, { a: 'lobby' });
  const bobby = join(rooms, room, 'Bobby', 'bobbys-other-browser-token-01');
  rooms.disconnect(room, bo.player, bo.socket);
  rooms.act(room, ana.player, { a: 'bench', id: bo.player.id });
  playGame(rooms, room, ana, { Bobby: ['K', 'K'] });
  playGame(rooms, room, bobby, { Ana: ['2'] });
  assert.deepEqual(pick(row(rooms.statRows(room), 'Bo')), { games: 1, wins: 1, points: 0 });
  assert.deepEqual(pick(row(rooms.statRows(room), 'Bobby')), { games: 2, wins: 1, points: 20 });

  // Kept under the name the admin types. The seat in use (Bobby's, he is the one connected) survives.
  const res = rooms.consolidate(room, [bo.key, bobby.key], bobby.key, 'Robert');
  assert.deepEqual({ key: res.key, name: res.name, removed: res.removed }, { key: bobby.key, name: 'Robert', removed: ['Bo'] });
  assert.equal(bobby.player.name, 'Robert');
  assert.equal(room.players.has(bo.player.id), false);
  assert.deepEqual(rooms.statRows(room).map((x) => [x.name, pick(x)]).sort(), [['Ana', { games: 3, wins: 1, points: 9 }], ['Robert', { games: 3, wins: 2, points: 20 }]].sort());

  // His first browser turns up again one day. Whatever name it uses, its games are Robert's.
  rooms.act(room, ana.player, { a: 'lobby' });
  rooms.disconnect(room, bobby.player, bobby.socket);
  const old = join(rooms, room, 'Bo');
  assert.notEqual(old.player, bobby.player);
  rooms.act(room, ana.player, { a: 'bench', id: bobby.player.id });
  playGame(rooms, room, old);
  const robert = rooms.statRows(room).filter((x) => x.id === bobby.key);
  assert.deepEqual(robert.map(pick), [{ games: 4, wins: 3, points: 20 }]);
  assert.equal(rooms.statRows(room).length, 2, 'no third record appears');
});

test('records of people who are not in the room can be folded together too, and three at once', () => {
  const { rooms, room, people } = table(['Ana', 'Bo']);
  const [ana] = people;
  room.stats = {
    [ana.key]: { name: 'Ana', color: '#e5484d', bot: false, games: 4, wins: 2, points: 30 },
    hOLD1: { name: 'Dee', color: '#12a594', bot: false, games: 5, wins: 1, points: 80 },
    hOLD2: { name: 'Dee 2', color: '#3b9eff', bot: false, games: 2, wins: 2, points: 0 },
    hOLD3: { name: 'D', color: '#ffb224', bot: false, games: 1, wins: 0, points: 12 },
  };
  const res = rooms.consolidate(room, ['hOLD1', 'hOLD2', 'hOLD3'], 'hOLD2');
  assert.deepEqual(res, { key: 'hOLD2', name: 'Dee 2', merged: 3, removed: [] });
  assert.deepEqual(room.stats.hOLD2, { name: 'Dee 2', color: '#3b9eff', bot: false, games: 8, wins: 3, points: 92 });
  assert.deepEqual(Object.keys(room.stats).sort(), [ana.key, 'hOLD2'].sort());
  assert.equal(rooms.resolveStatKey(room, 'hOLD1'), 'hOLD2');
  assert.equal(rooms.resolveStatKey(room, 'hOLD3'), 'hOLD2');
  // Folded again later, the trail still leads to wherever the record ends up.
  room.stats.hNEW = { name: 'Deirdre', color: '#9a4fd0', bot: false, games: 1, wins: 1, points: 0 };
  assert.equal(rooms.consolidate(room, ['hOLD1', 'hNEW'], 'hNEW').key, 'hNEW');
  assert.equal(rooms.resolveStatKey(room, 'hOLD3'), 'hNEW');
  assert.equal(room.stats.hNEW.games, 9);
});

test('consolidating refuses what makes no sense, and changes nothing when it does', () => {
  const { rooms, room, people } = table(['Ana', 'Bo', 'Cy']);
  const [ana, bo, cy] = people;
  rooms.act(room, ana.player, { a: 'addBot' });
  const bot = [...room.players.values()].find((p) => p.bot);
  playGame(rooms, room, ana);
  const before = JSON.stringify([room.stats, room.statAlias, [...room.players.keys()]]);
  assert.match(rooms.consolidate(room, [bo.key], bo.key).error, /at least two/);
  assert.match(rooms.consolidate(room, [bo.key, bo.key], bo.key).error, /at least two/, 'the same player twice is one player');
  assert.match(rooms.consolidate(room, [bo.key, cy.key], ana.key).error, /which of them to keep/);
  assert.match(rooms.consolidate(room, [bo.key, 'hNOBODY'], bo.key).error, /no longer here/);
  assert.match(rooms.consolidate(room, [bo.key, `b:${bot.name.toLowerCase()}`], bo.key).error, /Computer players/);
  assert.match(rooms.consolidate(room, [bo.key, cy.key], bo.key, 'ana').error, /already has that name/);
  assert.match(rooms.consolidate(room, null, bo.key).error, /at least two/);
  assert.match(rooms.consolidate(room, [{ toString: 1 }, {}], {}).error, /at least two/);
  assert.equal(JSON.stringify([room.stats, room.statAlias, [...room.players.keys()]]), before);
});

test('two of them connected at once: the kept seat stays, the other is shown out rather than left to wander back in', () => {
  const { rooms, room, people } = table(['Ana', 'Bo']);
  const [ana, bo] = people;
  const twin = join(rooms, room, 'Bo', 'bos-second-open-browser-tok-01');
  playGame(rooms, room, ana);
  const res = rooms.consolidate(room, [bo.key, twin.key], bo.key);
  assert.deepEqual(res.removed, ['Bo 2']);
  assert.equal(bo.player.token, bo.token, 'the kept seat keeps its own browser');
  assert.equal(bo.socket.closed, null);
  assert.deepEqual(twin.socket.sent.at(-1), { t: 'moved' });
  assert.equal(twin.socket.closed, 4003);
});

test('the admin can rename a player; their browser does not change it back, but they can', () => {
  const { rooms, room, people } = table(['Ana', 'Bo']);
  const [ana, bo] = people;
  playGame(rooms, room, bo);
  ana.socket.sent.length = 0;

  assert.deepEqual(rooms.renamePerson(room, { id: bo.player.id }, '  Robert   the  Bruce '), { name: 'Robert the Bruce', was: 'Bo' });
  assert.equal(bo.player.name, 'Robert the Bruce');
  assert.equal(ana.socket.sent.filter((m) => m.t === 'state').at(-1).s.players.find((p) => p.id === bo.player.id).name, 'Robert the Bruce', 'the room sees it at once');
  assert.equal(row(ana.board(), 'Robert the Bruce').games, 1, 'and so does the board');

  // His browser still has "Bo" saved and says so every time it reconnects.
  rooms.disconnect(room, bo.player, bo.socket);
  rooms.connect(room, { token: bo.token, name: 'Bo' }, tab());
  assert.equal(bo.player.name, 'Robert the Bruce');
  // Changing it himself is his business.
  assert.equal(rooms.act(room, bo.player, { a: 'rename', name: 'Rob' }), null);
  assert.equal(bo.player.name, 'Rob');
  rooms.connect(room, { token: bo.token, name: 'Robbie' }, tab());
  assert.equal(bo.player.name, 'Robbie', 'and his browser is believed again after that');

  assert.match(rooms.renamePerson(room, { id: bo.player.id }, 'ANA').error, /already has that name/);
  assert.match(rooms.renamePerson(room, { id: bo.player.id }, '   ').error, /at least one character/);
  assert.match(rooms.renamePerson(room, { id: 'nobody' }, 'X').error, /already left/);
  assert.equal(rooms.renamePerson(room, { id: bo.player.id }, 'x'.repeat(50)).name.length, 20);
  assert.equal(rooms.renamePerson(room, { id: bo.player.id }, 'Robbie').name, 'Robbie', 'keeping their own name is not a clash');
});

test('a record of someone who is no longer in the room can be renamed as well', () => {
  const { rooms, room } = table(['Ana', 'Bo']);
  room.stats.hGONE = { name: 'Dee 2', color: '#12a594', bot: false, games: 3, wins: 1, points: 40 };
  assert.deepEqual(rooms.renamePerson(room, { key: 'hGONE' }, 'Dee'), { name: 'Dee', was: 'Dee 2' });
  assert.equal(row(rooms.statRows(room), 'Dee').games, 3);
  assert.match(rooms.renamePerson(room, { key: 'hNOBODY' }, 'X').error, /no longer here/);
  assert.match(rooms.renamePerson(room, { key: 'hGONE' }, 'Bo').error, /already has that name/);
});

test('stats are saved with the room and restored with it', () => {
  const { rooms, room, people } = table(['Ana', 'Bo']);
  const [ana, bo] = people;
  playGame(rooms, room, ana);
  rooms.consolidate(room, [bo.key, 'hOLD'], bo.key); // refused: hOLD is nobody
  room.stats.hOLD = { name: 'Old Bo', color: '#12a594', bot: false, games: 2, wins: 0, points: 30 };
  rooms.consolidate(room, [bo.key, 'hOLD'], bo.key);
  const saved = JSON.parse(JSON.stringify(rooms.serialize().find((x) => x.code === room.code)));
  assert.deepEqual(saved.stats[bo.key], { name: 'Bo', color: bo.player.color, bot: false, games: 3, wins: 0, points: 40 });
  assert.deepEqual(saved.statAlias, { hOLD: bo.key });
  assert.ok(saved.players.every((p) => typeof p.sid === 'string'), 'each seat remembers whose record it is');
  assert.ok(!JSON.stringify(saved.stats).includes('token'));
  void game;
});
