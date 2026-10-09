// When rooms go: the usual expiry, the admin's "never" and "on a date", old
// names after a rename, and all of it surviving a restart. Runs the Rooms
// class directly against a scratch data folder.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swipe-expiry-'));
process.env.PERSIST = 'true';
process.env.DATA_DIR = dir;
process.env.LOG_LEVEL = 'silent';
process.env.DEAL_MS = '0';
process.env.ROOM_TTL_HOURS = '48';
process.env.MAX_ROOMS = '6';
const { Rooms } = await import('../server/rooms.js');
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function tab() {
  const sent = [];
  const socket = { readyState: 1, sent, closed: null, send: (raw) => sent.push(JSON.parse(raw)), close: (code) => ((socket.closed = code), (socket.readyState = 3)) };
  return socket;
}
function sit(rooms, room, name) {
  const socket = tab();
  const { player } = rooms.connect(room, { token: `token-for-${name}-0123456789`, name, ip: '203.0.113.9', ua: 'Test/1.0' }, socket);
  return { player, socket };
}
/** Winds a room's clock back, as if it had last been used `ms` ago. */
const age = (room, ms) => (room.lastActive = Date.now() - ms);
const fresh = () => {
  const rooms = new Rooms();
  clearTimeout(rooms.saveTimer);
  return rooms;
};

test('left alone, a room goes 48 hours after it was last used, and not before', () => {
  const rooms = fresh();
  const young = rooms.create();
  const old = rooms.create();
  age(young, 47 * HOUR);
  age(old, 49 * HOUR);
  assert.equal(rooms.expiresAt(old), old.lastActive + 48 * HOUR);
  rooms.sweep();
  assert.equal(rooms.get(young.code), young);
  assert.equal(rooms.get(old.code), undefined);
  assert.equal(old.gone, true);
});

test('a room set to never expire outlasts any amount of idleness', () => {
  const rooms = fresh();
  const room = rooms.create();
  assert.equal(rooms.setExpiry(room, 'never'), null);
  assert.equal(rooms.expiresAt(room), null);
  age(room, 400 * DAY);
  rooms.sweep();
  assert.equal(rooms.get(room.code), room);
  // Let go, it gets the usual time counted from now, not from when it was last used.
  rooms.setExpiry(room, 'default');
  rooms.sweep();
  assert.equal(rooms.get(room.code), room);
  assert.ok(Math.abs(rooms.expiresAt(room) - (Date.now() + 48 * HOUR)) < 1000);
  age(room, 49 * HOUR);
  rooms.setExpiry(room, 'default'); // already the usual way: choosing it again is not a visit
  rooms.sweep();
  assert.equal(rooms.get(room.code), undefined);
});

test('a room with a date stays until then however idle, and goes after it however busy it was', () => {
  const rooms = fresh();
  const kept = rooms.create();
  const due = rooms.create();
  rooms.setExpiry(kept, 'at', Date.now() + 30 * DAY);
  rooms.setExpiry(due, 'at', Date.now() + 60_000);
  age(kept, 20 * DAY); // long past the usual 48 hours
  due.expiry = Date.now() - 1000; // its minute has passed
  due.lastActive = Date.now(); // and it was used a moment ago
  rooms.sweep();
  assert.equal(rooms.get(kept.code), kept);
  assert.equal(rooms.get(due.code), undefined);
});

test('no room is removed while someone is in it; it goes when they leave', () => {
  const rooms = fresh();
  const room = rooms.create();
  const { player, socket } = sit(rooms, room, 'Ana');
  room.expiry = Date.now() - 1000;
  rooms.sweep();
  assert.equal(rooms.get(room.code), room, 'still there with Ana in it');
  assert.equal(socket.closed, null);
  rooms.disconnect(room, player, socket);
  rooms.sweep();
  assert.equal(rooms.get(room.code), undefined);
});

test('a full server clears out idle rooms to make space, but not ones the admin has set', () => {
  const rooms = fresh();
  const made = Array.from({ length: 6 }, () => rooms.create());
  for (const room of made) age(room, 2 * HOUR);
  rooms.setExpiry(made[0], 'never');
  rooms.setExpiry(made[1], 'at', Date.now() + DAY);
  const extra = rooms.create(); // the seventh: the server holds six
  assert.ok(extra, 'space was found');
  assert.equal(rooms.get(made[0].code), made[0]);
  assert.equal(rooms.get(made[1].code), made[1]);
  assert.deepEqual(made.slice(2).map((room) => rooms.get(room.code)), [undefined, undefined, undefined, undefined]);
  // Fill it with rooms that may not be cleared and it really is full.
  const more = [rooms.create(), rooms.create(), rooms.create()];
  for (const room of [extra, ...more]) rooms.setExpiry(room, 'never');
  assert.equal(rooms.rooms.size, 6);
  assert.equal(rooms.create(), null);
});

test('renaming keeps old names pointing at the room, up to eight of them', () => {
  const rooms = fresh();
  const room = rooms.create();
  const first = room.code;
  const active = room.lastActive - 5000;
  room.lastActive = active;
  assert.deepEqual(rooms.rename(room, 'Poker Night'), { code: 'poker-night', old: first });
  assert.equal(room.lastActive, active, 'a rename is not a visit: the expiry clock is not restarted');
  assert.equal(rooms.get('poker-night'), room);
  assert.equal(rooms.get(first), room);
  assert.equal(rooms.rooms.has(first), false);
  for (let i = 0; i < 9; i++) rooms.rename(room, `night-${i}`);
  assert.equal(room.aliases.length, 8);
  assert.equal(rooms.get(first), undefined, 'the oldest names drop off');
  assert.equal(rooms.get('night-0'), room);
  // Taking an old name back removes it from the list of old ones.
  rooms.rename(room, 'night-3');
  assert.ok(!room.aliases.includes('night-3'));
  assert.equal(new Set(room.aliases).size, room.aliases.length);
  // Deleting the room frees every name it had.
  const names = [room.code, ...room.aliases];
  rooms.remove(room);
  for (const name of names) assert.equal(rooms.get(name), undefined);
  assert.equal(rooms.aliases.size, 0);
});

test('a removed room does nothing more: no moves, no timers, no saving of late arrivals', () => {
  const rooms = fresh();
  const room = rooms.create();
  const ana = sit(rooms, room, 'Ana');
  const bo = sit(rooms, room, 'Bo');
  assert.equal(rooms.act(room, ana.player, { a: 'start' }), null);
  assert.equal(rooms.remove(room, { notice: 'Closed.' }), true);
  assert.deepEqual(ana.socket.sent.at(-1), { t: 'fatal', code: 'closed', m: 'Closed.' });
  assert.equal(bo.socket.closed, 4004);
  assert.equal(room.timer, null);
  assert.match(rooms.act(room, ana.player, { a: 'start' }), /closed/);
  rooms.disconnect(room, ana.player, ana.socket); // the socket's close arriving afterwards
  assert.equal(room.timer, null);
  assert.equal(rooms.remove(room), false, 'removing it twice is harmless');
});

test('expiry, old names and the room itself come back after a restart; addresses do not', () => {
  const rooms = fresh();
  const forever = rooms.create();
  const dated = rooms.create();
  const usual = rooms.create();
  const lapsed = rooms.create();
  const overdue = rooms.create();
  const busy = rooms.create();
  rooms.setExpiry(forever, 'never');
  rooms.rename(forever, 'the long game');
  const when = Date.now() + 10 * DAY;
  rooms.setExpiry(dated, 'at', when);
  age(forever, 300 * DAY);
  age(dated, 5 * DAY);
  age(lapsed, 50 * HOUR);
  overdue.expiry = Date.now() - 1000;
  age(overdue, HOUR);
  busy.expiry = Date.now() - 1000; // its date has passed too, but it was being used when the server stopped
  const { player } = sit(rooms, usual, 'Ana');
  assert.equal(player.ip, '203.0.113.9');
  rooms.save();
  assert.ok(rooms.savedAt > 0);

  const saved = fs.readFileSync(path.join(dir, 'rooms.json'), 'utf8');
  assert.ok(!saved.includes('203.0.113.9') && !saved.includes('Test/1.0'), 'addresses and browsers stay out of the file');

  const next = fresh();
  next.load();
  assert.deepEqual([...next.rooms.keys()].sort(), ['the-long-game', dated.code, usual.code, busy.code].sort(), 'the two whose time had passed are not restored');
  // The one that was in use comes back for its players, and goes once nobody returns to it.
  const ana = sit(next, next.get(busy.code), 'Ana');
  next.sweep();
  assert.ok(next.get(busy.code));
  next.disconnect(next.get(busy.code), ana.player, ana.socket);
  next.sweep();
  assert.equal(next.get(busy.code), undefined);
  const back = next.get('the-long-game');
  assert.equal(back.expiry, 'never');
  assert.equal(next.get(forever.aliases[0]), back, 'its old name still finds it');
  assert.equal(next.get(dated.code).expiry, when);
  assert.equal(next.get(usual.code).expiry, null);
  assert.equal([...next.get(usual.code).players.values()][0].ip, undefined);
  for (const room of next.rooms.values()) clearTimeout(room.timer);
  clearTimeout(next.saveTimer);
});

test('a file saved before any of this existed loads as rooms with the usual expiry and no old names', () => {
  const file = path.join(dir, 'rooms.json');
  const old = { code: 'lucky-riffle-42', createdAt: Date.now() - HOUR, lastActive: Date.now() - HOUR, hostId: null, locked: false, settings: { limit: 100, turnSeconds: 0 }, players: [], banned: [], match: null, round: null };
  fs.writeFileSync(file, JSON.stringify({ version: 1, savedAt: Date.now(), rooms: [old, { ...old, code: 'dusty-ace-07', lastActive: Date.now() - 60 * HOUR }] }));
  const rooms = fresh();
  rooms.load();
  assert.deepEqual([...rooms.rooms.keys()], ['lucky-riffle-42']);
  const room = rooms.get('lucky-riffle-42');
  assert.deepEqual([room.expiry, room.aliases], [null, []]);
  assert.equal(rooms.expiresAt(room), room.lastActive + 48 * HOUR);
  assert.equal(rooms.rename(room, 'renamed').code, 'renamed');
  clearTimeout(rooms.saveTimer);
});
