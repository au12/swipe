// The admin page, end to end: boot the real server with an admin password
// and drive /admin/api the way the page does, with real players connected.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { deviceLabel } from '../server/admin.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 37000 + Math.floor(Math.random() * 900);
const HTTP = `http://127.0.0.1:${PORT}`;
const OFF = `http://127.0.0.1:${PORT + 1}`;
const PASSWORD = 'a long admin password, 4 tests';
const servers = [];

async function boot(port, env) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PERSIST: 'false', LOG_LEVEL: 'silent', DEAL_MS: '0', BOT_DELAY_MS: '2', MESSAGE_BUDGET: '100000', ADMIN_PASSWORD: '', ...env },
    stdio: 'inherit',
  });
  servers.push(child);
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

before(() => Promise.all([boot(PORT, { ADMIN_PASSWORD: PASSWORD, TRUST_PROXY: '1' }), boot(PORT + 1, {})]));
after(() => servers.forEach((s) => s.kill()));

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-swipe-admin': '1', ...headers }, body: JSON.stringify(body) });

let session = null;
/** Signs in once and returns the cookie to send. */
async function signIn(headers = {}) {
  const res = await post(`${HTTP}/admin/api/login`, { password: PASSWORD }, headers);
  assert.equal(res.status, 200);
  return { cookie: res.headers.get('set-cookie').split(';')[0], raw: res.headers.get('set-cookie') };
}
const cookie = async () => (session ??= (await signIn()).cookie);
const state = async () => (await fetch(`${HTTP}/admin/api/state`, { headers: { cookie: await cookie() } })).json();
/** One admin change. Returns the parsed answer with its HTTP status. */
async function act(body) {
  const res = await post(`${HTTP}/admin/api/act`, body, { cookie: await cookie() });
  return { status: res.status, ...(await res.json()) };
}
const roomIn = async (code) => (await state()).rooms.find((r) => r.code === code);

async function createRoom() {
  const res = await fetch(`${HTTP}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return (await res.json()).code;
}

/** A player's browser, as far as the server can tell. `via` is the X-Forwarded-For it arrives with. */
function client(room, name, { via = '198.51.100.7', ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', token = `token-${name}-${Math.random().toString(36).slice(2)}-padding` } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { 'X-Forwarded-For': via, 'User-Agent': ua } });
  const c = { ws, name, token, state: null, notes: [], fatal: null, closed: null, waiters: [] };
  const check = () => {
    c.waiters = c.waiters.filter((w) => (w.pred(c) ? (w.resolve(), false) : true));
  };
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', room, token, name })));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.t === 'state') c.state = msg.s;
    if (msg.t === 'note') c.notes.push(msg.m);
    if (msg.t === 'fatal' || msg.t === 'kicked') c.fatal = msg;
    check();
  });
  ws.on('close', (code) => {
    c.closed = code;
    check();
  });
  c.until = (pred, what = 'condition') =>
    new Promise((resolve, reject) => {
      if (pred(c)) return resolve();
      const timer = setTimeout(() => reject(new Error(`${name}: timed out waiting for ${what}`)), 4000);
      c.waiters.push({ pred, resolve: () => (clearTimeout(timer), resolve()) });
    });
  c.ready = () => c.until((x) => x.state !== null, 'first state');
  c.send = (a, data = {}) => ws.send(JSON.stringify({ t: 'a', a, ...data }));
  return c;
}

async function table(names, opts = {}) {
  const code = await createRoom();
  const all = [];
  for (const [i, name] of names.entries()) {
    const c = client(code, name, { via: `198.51.100.${10 + i}`, ...opts });
    await c.ready();
    all.push(c);
  }
  return { code, all };
}

// ───────────────────────── switched off ─────────────────────────

test('without ADMIN_PASSWORD the page explains itself and gives nothing away', async () => {
  const page = await fetch(`${OFF}/admin`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /ADMIN_PASSWORD/);
  assert.deepEqual(await (await fetch(`${OFF}/admin/api/session`)).json(), { enabled: false, authed: false, siteName: 'Swipe' });
  assert.equal((await fetch(`${OFF}/admin/api/state`)).status, 404);
  assert.equal((await post(`${OFF}/admin/api/login`, { password: '' })).status, 404, 'an empty password does not open a server that has none');
  assert.equal((await post(`${OFF}/admin/api/act`, { do: 'server.create' })).status, 404);
});

// ───────────────────────── signing in ─────────────────────────

test('the page and its files are served, and marked not to be stored or framed', async () => {
  for (const url of ['/admin', '/admin/']) {
    const res = await fetch(`${HTTP}${url}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.match(res.headers.get('x-robots-tag'), /noindex/);
    const html = await res.text();
    assert.ok(!html.includes('{{'), 'the template is filled in');
    assert.ok(!html.includes(PASSWORD));
  }
  assert.equal((await fetch(`${HTTP}/admin/admin.js`)).status, 200);
  assert.equal((await fetch(`${HTTP}/admin/admin.css`)).status, 200);
});

test('nothing is shown or changed without signing in', async () => {
  assert.deepEqual(await (await fetch(`${HTTP}/admin/api/session`)).json(), { enabled: true, authed: false, siteName: 'Swipe' });
  assert.equal((await fetch(`${HTTP}/admin/api/state`)).status, 401);
  assert.equal((await fetch(`${HTTP}/admin/api/backup`)).status, 401);
  assert.equal((await post(`${HTTP}/admin/api/act`, { do: 'server.create' })).status, 401);
  assert.equal((await fetch(`${HTTP}/admin/api/state`, { headers: { cookie: 'swipe_admin=made-up' } })).status, 401);
  assert.equal((await post(`${HTTP}/admin/api/logout`, {})).status, 401);
});

test('a request another site could make a browser send is refused, password or not', async () => {
  // A cross-site form can post, but it cannot add a header or send JSON.
  const plain = await fetch(`${HTTP}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(plain.status, 400);
  assert.equal(plain.headers.get('set-cookie'), null);
  const form = await fetch(`${HTTP}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-swipe-admin': '1' }, body: `password=${encodeURIComponent(PASSWORD)}` });
  assert.equal(form.status, 400);
  const signed = await cookie();
  const noHeader = await fetch(`${HTTP}/admin/api/act`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: signed }, body: JSON.stringify({ do: 'server.create' }) });
  assert.equal(noHeader.status, 400, 'even with a good session');
});

test('the right password signs in with a cookie scripts cannot read and other sites cannot send', async () => {
  const { raw, cookie: c } = await signIn();
  assert.match(raw, /^swipe_admin=[\w-]{40,}; Path=\/admin; HttpOnly; SameSite=Strict; Max-Age=43200$/);
  assert.deepEqual(await (await fetch(`${HTTP}/admin/api/session`, { headers: { cookie: c } })).json(), { enabled: true, authed: true, siteName: 'Swipe' });
  // Behind an HTTPS proxy the cookie is for HTTPS only.
  const viaProxy = await signIn({ 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.50' });
  assert.match(viaProxy.raw, /; Secure$/);

  // Signing out ends that session and only that one.
  const out = await post(`${HTTP}/admin/api/logout`, {}, { cookie: viaProxy.cookie });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(`${HTTP}/admin/api/state`, { headers: { cookie: viaProxy.cookie } })).status, 401);
  assert.equal((await fetch(`${HTTP}/admin/api/state`, { headers: { cookie: c } })).status, 200);
});

test('wrong passwords are counted per address, and a forged X-Forwarded-For does not reset the count', async () => {
  // The proxy appends the address it saw, so the last entry is the real one. The first is whatever the visitor typed.
  const from = (n) => ({ 'X-Forwarded-For': `10.9.9.${n}, 203.0.113.99` });
  for (let i = 0; i < 6; i++) {
    const res = await post(`${HTTP}/admin/api/login`, { password: `guess ${i}` }, from(i));
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('set-cookie'), null);
  }
  const locked = await post(`${HTTP}/admin/api/login`, { password: PASSWORD }, from(77));
  assert.equal(locked.status, 429, 'even the right password has to wait now');
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.match((await locked.json()).error, /Try again in \d+ minutes/);
  // Someone else is not locked out with them.
  assert.equal((await post(`${HTTP}/admin/api/login`, { password: PASSWORD }, { 'X-Forwarded-For': '203.0.113.100' })).status, 200);
  const log = (await state()).events.filter((e) => e.kind === 'admin.denied' && e.ip === '203.0.113.99');
  assert.deepEqual(log.map((e) => e.n), [6], 'the run is one line in the activity list, with its address and a count');
});

// ───────────────────────── what it shows ─────────────────────────

test('the state lists the server, every room and who is in it, with addresses and browsers', async () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
  const code = await createRoom();
  const ana = client(code, 'Ana', { via: '203.0.113.7' });
  await ana.ready();
  const bo = client(code, 'Bo', { via: '6.6.6.6, 198.51.100.24', ua: iphone }); // "6.6.6.6" is forged
  await bo.ready();
  const cy = client(code, 'Cy', { via: '192.0.2.61' });
  await cy.ready();
  ana.send('addBot');
  ana.send('start');
  await ana.until((x) => x.state.round?.phase === 'play', 'the game to start');
  cy.ws.close();
  await ana.until((x) => x.state.players.find((p) => p.name === 'Cy')?.online === false, 'Cy to go offline');

  const s = await state();
  assert.equal(s.server.version, '1.0.0');
  assert.match(s.server.node, /^v\d+/);
  assert.equal(s.server.persist, false);
  assert.equal(s.server.trustProxy, 1);
  assert.equal(s.server.roomTtlHours, 48);
  assert.ok(s.server.startedAt <= s.now && s.server.memory.rss > 0);
  assert.ok(s.totals.rooms >= 1 && s.totals.online >= 2 && s.totals.games >= 1);

  const room = s.rooms.find((r) => r.code === code);
  assert.equal(room.status, 'playing');
  assert.equal(room.inUse, true);
  assert.equal(room.online, 2);
  assert.equal(room.expiry, 'default');
  assert.ok(Math.abs(room.expiresAt - (room.lastActive + 48 * 3600_000)) < 5);
  assert.equal(room.players.find((p) => p.id === room.turn) !== undefined, true);
  const by = Object.fromEntries(room.players.map((p) => [p.name, p]));
  assert.deepEqual(by.Ana.ips, ['203.0.113.7']);
  assert.deepEqual(by.Bo.ips, ['198.51.100.24'], 'the address the proxy saw, not the one the visitor claimed');
  assert.equal(by.Ana.device, 'Linux, Chrome');
  assert.equal(by.Bo.device, 'iPhone, Safari');
  assert.equal(by.Ana.host, true);
  assert.equal(by.Ana.online && by.Bo.online, true);
  assert.equal(by.Cy.online, false);
  assert.deepEqual(by.Cy.ips, ['192.0.2.61'], 'someone who left keeps the address they were last seen at');
  assert.equal(by.Ana.cards, 20);
  assert.equal(by.Ana.score, 0);
  const bot = room.players.find((p) => p.bot);
  assert.deepEqual([bot.ips, bot.device, bot.online], [[], '', false]);

  // Nothing that would let the admin page's reader play as someone, and no cards.
  const text = JSON.stringify(s);
  for (const c of [ana, bo, cy]) assert.ok(!text.includes(c.token), 'no seat tokens');
  assert.ok(!text.includes(PASSWORD) && !/"hand"|"blind"|"stock"/.test(text));
  for (const c of [ana, bo]) c.ws.close();
});

test('deviceLabel names the device and browser', () => {
  assert.equal(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15'), 'Mac, Safari');
  assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'), 'Windows, Edge');
  assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'), 'Android phone, Chrome');
  assert.equal(deviceLabel('Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1'), 'iPad, Chrome');
  assert.equal(deviceLabel('Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'), 'Linux, Firefox');
  assert.equal(deviceLabel(''), '');
  assert.equal(deviceLabel(null), '');
  assert.equal(deviceLabel('curl/8.5.0'), 'curl/8.5.0');
});

// ───────────────────────── renaming ─────────────────────────

test('a room can be renamed to any text; the people in it follow, and the old link still works', async () => {
  const { code, all } = await table(['Ana', 'Bo']);
  const [ana] = all;

  const res = await act({ do: 'room.rename', code, name: '  Friday Night: Cards & Snacks!  ' });
  assert.equal(res.status, 200);
  assert.equal(res.code, 'friday-night-cards-snacks');
  await Promise.all(all.map((c) => c.until((x) => x.state.code === 'friday-night-cards-snacks', 'the new name')));

  const room = await roomIn('friday-night-cards-snacks');
  assert.deepEqual(room.aliases, [code]);
  assert.equal((await state()).rooms.some((r) => r.code === code), false, 'it is listed once, under its new name');
  for (const name of [code, 'friday-night-cards-snacks', 'FRIDAY night cards snacks']) {
    assert.equal((await fetch(`${HTTP}/api/rooms/${encodeURIComponent(name)}`)).status, 200, name);
  }
  // Someone arriving by the old link lands in the same room, and is told its name.
  const late = client(code, 'Cy');
  await late.ready();
  assert.equal(late.state.code, 'friday-night-cards-snacks');
  assert.equal(late.state.players.length, 3);
  await ana.until((x) => x.state.players.length === 3, 'Cy to arrive');
  // The admin can keep using either name too.
  assert.equal((await act({ do: 'room.lock', code, on: true })).ok, true);
  assert.equal((await roomIn('friday-night-cards-snacks')).locked, true);
  for (const c of [...all, late]) c.ws.close();
});

test('names that are too short, unchanged or taken are refused, and nothing changes', async () => {
  const a = await createRoom();
  const b = await createRoom();
  assert.match((await act({ do: 'room.rename', code: a, name: '!!' })).error, /at least 3/);
  assert.match((await act({ do: 'room.rename', code: a, name: 'x y' })).error ?? '', /^$/, '"x-y" is three characters');
  assert.match((await act({ do: 'room.rename', code: 'x-y', name: a.toUpperCase() })).error ?? '', /^$/, 'a room may take back a name it used to have');
  assert.match((await act({ do: 'room.rename', code: a, name: a })).error, /already this room/);
  assert.match((await act({ do: 'room.rename', code: a, name: b })).error, /Another room/);
  assert.equal((await act({ do: 'room.rename', code: b, name: 'second table' })).ok, true);
  assert.match((await act({ do: 'room.rename', code: a, name: b })).error, /Another room/, 'a name another room used to have still belongs to it');
  assert.match((await act({ do: 'room.rename', code: 'no-such-room-00', name: 'anything' })).error, /no longer here/);
  assert.equal((await roomIn(a)).code, a);
  // A new room is never handed a name that is somebody's old one (the generator is asked until it finds a free one).
  const long = await act({ do: 'room.rename', code: a, name: 'x'.repeat(80) });
  assert.equal(long.code, 'x'.repeat(40), 'long names are cut to 40');
});

test('a random rename gives a fresh generated name; turning off old links cuts every one of them', async () => {
  const { code, all } = await table(['Ana']);
  const first = await act({ do: 'room.rename', code, random: true });
  assert.match(first.code, /^[a-z]+-[a-z]+-\d\d$/);
  assert.notEqual(first.code, code);
  const second = await act({ do: 'room.rename', code: first.code, name: 'the back room', keepOld: false });
  assert.equal(second.code, 'the-back-room');
  assert.deepEqual((await roomIn('the-back-room')).aliases, []);
  assert.equal((await fetch(`${HTTP}/api/rooms/${code}`)).status, 404);
  assert.equal((await fetch(`${HTTP}/api/rooms/${first.code}`)).status, 404);
  await all[0].until((x) => x.state.code === 'the-back-room', 'the player to be moved along');
  // The old name is free for someone else now.
  const other = await createRoom();
  assert.equal((await act({ do: 'room.rename', code: other, name: code })).ok, true);
  all[0].ws.close();
});

// ───────────────────────── expiry ─────────────────────────

test('expiry can be set to never, to a date, and back to the usual', async () => {
  const code = await createRoom();
  assert.equal((await act({ do: 'room.expiry', code, mode: 'never' })).ok, true);
  let room = await roomIn(code);
  assert.deepEqual([room.expiry, room.expiresAt], ['never', null]);

  const at = Date.now() + 30 * 86400_000;
  assert.equal((await act({ do: 'room.expiry', code, mode: 'at', at })).ok, true);
  room = await roomIn(code);
  assert.deepEqual([room.expiry, room.expiresAt], ['at', at]);

  assert.match((await act({ do: 'room.expiry', code, mode: 'at', at: Date.now() - 1000 })).error, /already passed/);
  assert.match((await act({ do: 'room.expiry', code, mode: 'at', at: 'tomorrow' })).error, /date and time/);
  assert.match((await act({ do: 'room.expiry', code, mode: 'at', at: Date.now() + 4000 * 86400_000 })).error, /never/);
  assert.match((await act({ do: 'room.expiry', code, mode: 'soon' })).error, /Unknown/);
  assert.equal((await roomIn(code)).expiresAt, at, 'a refused change changes nothing');

  assert.match((await act({ do: 'room.expiry', code, mode: 'at', at: String(at) })).error, /date and time/, 'the time is a number or nothing');
  assert.equal((await act({ do: 'room.expiry', code, mode: 'default' })).ok, true);
  room = await roomIn(code);
  assert.equal(room.expiry, 'default');
  assert.ok(Math.abs(room.expiresAt - (room.lastActive + 48 * 3600_000)) < 5);
});

// ───────────────────────── deleting ─────────────────────────

test('deleting a room tells the people in it, closes their connections and frees the name', async () => {
  const { code, all } = await table(['Ana', 'Bo']);
  await act({ do: 'room.rename', code, name: 'doomed table' });
  assert.equal((await act({ do: 'room.delete', code: 'doomed-table' })).ok, true);
  for (const c of all) {
    await c.until((x) => x.closed !== null, 'the connection to close');
    assert.deepEqual({ t: c.fatal.t, code: c.fatal.code }, { t: 'fatal', code: 'closed' });
    assert.match(c.fatal.m, /closed/);
    assert.equal(c.closed, 4004);
  }
  assert.equal(await roomIn('doomed-table'), undefined);
  for (const name of ['doomed-table', code]) assert.equal((await fetch(`${HTTP}/api/rooms/${name}`)).status, 404, 'its old name goes with it');
  assert.match((await act({ do: 'room.delete', code: 'doomed-table' })).error, /no longer here/);
  // Coming back to the link finds nothing.
  const back = client('doomed-table', 'Ana', { token: all[0].token });
  await back.until((x) => x.fatal !== null, 'the answer');
  assert.equal(back.fatal.code, 'no-room');
  back.ws.close();
});

// ───────────────────────── the other controls ─────────────────────────

test('a message reaches everyone in one room, or everyone on the server', async () => {
  const one = await table(['Ana', 'Bo']);
  const two = await table(['Cy']);
  const sent = await act({ do: 'room.message', code: one.code, text: '  Pizza is here.\n\nFinish the hand!  ' });
  assert.equal(sent.reached, 2);
  await Promise.all(one.all.map((c) => c.until((x) => x.notes.length === 1, 'the message')));
  assert.deepEqual(one.all[0].notes, ['Pizza is here. Finish the hand!']);
  await tick();
  assert.deepEqual(two.all[0].notes, [], 'the other room hears nothing');

  const all = await act({ do: 'server.message', text: 'Restarting in five minutes.' });
  assert.ok(all.reached >= 3);
  await two.all[0].until((x) => x.notes.length === 1, 'the announcement');
  assert.deepEqual(one.all[1].notes.at(-1), 'Restarting in five minutes.');

  assert.match((await act({ do: 'room.message', code: one.code, text: '   ' })).error, /Type a message/);
  assert.equal((await act({ do: 'room.message', code: one.code, text: 'x'.repeat(500) })).ok, true);
  await one.all[0].until((x) => x.notes.length === 3, 'the long one');
  assert.equal(one.all[0].notes.at(-1).length, 280);
  for (const c of [...one.all, ...two.all]) c.ws.close();
});

test('lock, make host, end the game and back to the lobby all reach the table', async () => {
  const { code, all } = await table(['Ana', 'Bo', 'Cy']);
  const [ana, bo] = all;

  await act({ do: 'room.lock', code, on: true });
  await ana.until((x) => x.state.locked === true, 'the lock');
  const late = client(code, 'Dee');
  await late.until((x) => x.fatal !== null, 'to be turned away');
  assert.equal(late.fatal.code, 'locked');
  await act({ do: 'room.lock', code, on: false });
  await ana.until((x) => x.state.locked === false, 'the unlock');

  const boId = bo.state.you;
  assert.equal((await act({ do: 'room.host', code, id: boId })).ok, true);
  await ana.until((x) => x.state.hostId === boId, 'the new host');
  assert.match((await act({ do: 'room.host', code, id: 'nobody' })).error, /can’t host/);

  assert.match((await act({ do: 'room.endGame', code })).error, /No game/);
  bo.send('start');
  await ana.until((x) => x.state.round?.phase === 'play', 'the game');
  assert.equal((await roomIn(code)).live, true);
  assert.equal((await act({ do: 'room.endGame', code })).ok, true);
  await ana.until((x) => x.state.round?.phase === 'over' && x.state.round.reason === 'abandoned', 'the game to be called off');
  assert.equal(ana.state.match.gameNo, 1, 'the match is still there');

  assert.equal((await act({ do: 'room.reset', code })).ok, true);
  await ana.until((x) => x.state.round === null && x.state.match === null, 'the lobby');
  assert.equal((await roomIn(code)).status, 'lobby');
  for (const c of all) c.ws.close();
});

test('removing a player puts them out; kept out by default, free to return if not', async () => {
  const { code, all } = await table(['Ana', 'Bo', 'Cy']);
  const [ana, bo, cy] = all;
  ana.send('start');
  await ana.until((x) => x.state.round?.phase === 'play', 'the game');

  assert.equal((await act({ do: 'room.kick', code, id: bo.state.you })).ok, true);
  await bo.until((x) => x.closed !== null, 'Bo to be put out');
  assert.equal(bo.fatal.t, 'kicked');
  await ana.until((x) => x.state.players.length === 2 && x.state.round.order.length === 2, 'the game to go on without him');
  assert.equal((await roomIn(code)).banned, 1);
  const again = client(code, 'Bo', { token: bo.token });
  await again.until((x) => x.fatal !== null, 'the door to stay shut');
  assert.equal(again.fatal.code, 'banned');

  // The admin can remove the host too; someone else takes over.
  assert.equal((await act({ do: 'room.kick', code, id: ana.state.you, ban: false })).ok, true);
  await ana.until((x) => x.closed !== null, 'Ana to be put out');
  await cy.until((x) => x.state.hostId === cy.state.you, 'Cy to become host');
  assert.equal((await roomIn(code)).banned, 1, 'she was not banned');
  const anaBack = client(code, 'Ana', { token: ana.token });
  await anaBack.ready();
  assert.equal(anaBack.state.players.length, 2);

  // And the banned can be let back in.
  assert.deepEqual([(await act({ do: 'room.unban', code })).n, (await roomIn(code)).banned], [1, 0]);
  const boBack = client(code, 'Bo', { token: bo.token });
  await boBack.ready();
  assert.match((await act({ do: 'room.kick', code, id: 'nobody' })).error, /already left/);
  for (const c of [cy, anaBack, boBack]) c.ws.close();
});

test('the admin can make a room, named or not, and clean up the idle ones', async () => {
  const made = await act({ do: 'server.create' });
  assert.match(made.code, /^[a-z]+-[a-z]+-\d\d$/);
  const named = await act({ do: 'server.create', name: 'Sunday League' });
  assert.equal(named.code, 'sunday-league');
  const before = (await state()).rooms.length;
  assert.match((await act({ do: 'server.create', name: 'sunday league' })).error, /Another room/);
  assert.match((await act({ do: 'server.create', name: '?' })).error, /at least 3/);
  assert.equal((await state()).rooms.length, before, 'a refused room is not left behind');

  const used = await table(['Ana']);
  await act({ do: 'room.expiry', code: 'sunday-league', mode: 'never' });
  for (const hours of ['x', null, '0', undefined, [0]]) assert.match((await act({ do: 'server.cleanup', hours })).error, /how long/, JSON.stringify(hours));
  assert.deepEqual((await act({ do: 'server.cleanup', hours: 1 })).removed, [], 'nothing here is an hour old');
  const cleaned = await act({ do: 'server.cleanup', hours: 0 });
  assert.ok(cleaned.removed.includes(made.code));
  const left = (await state()).rooms.map((r) => r.code);
  assert.ok(left.includes('sunday-league'), 'a room with its expiry set is kept');
  assert.ok(left.includes(used.code), 'and so is a room with someone in it');
  assert.equal(left.length, (await state()).rooms.filter((r) => r.inUse || r.expiry !== 'default').length);
  used.all[0].ws.close();
});

test('the backup is the saved rooms; other sessions can be signed out; unknown requests are refused', async () => {
  const backup = await fetch(`${HTTP}/admin/api/backup`, { headers: { cookie: await cookie() } });
  assert.equal(backup.status, 200);
  assert.match(backup.headers.get('content-disposition'), /^attachment; filename="swipe-rooms-[\d-]+\.json"$/);
  const data = await backup.json();
  assert.equal(data.version, 1);
  const league = data.rooms.find((r) => r.code === 'sunday-league');
  assert.equal(league.expiry, 'never');
  assert.ok(!JSON.stringify(data).includes('"ip"'), 'addresses are never part of what is saved');

  assert.match((await act({ do: 'server.save' })).error, /switched off/, 'this test server does not save');
  assert.match((await act({ do: 'server.nonsense' })).error, /Unknown/);
  assert.match((await act({ do: 'room.nonsense', code: 'sunday-league' })).error, /Unknown/);
  assert.equal((await post(`${HTTP}/admin/api/act`, 'not an object', { cookie: await cookie() })).status, 400);
  assert.equal((await fetch(`${HTTP}/admin/api/elsewhere`, { headers: { cookie: await cookie() } })).status, 404);

  const other = await signIn({ 'X-Forwarded-For': '203.0.113.200' });
  const out = await act({ do: 'server.signout' });
  assert.ok(out.others >= 1);
  assert.equal((await fetch(`${HTTP}/admin/api/state`, { headers: { cookie: other.cookie } })).status, 401);
  assert.equal((await fetch(`${HTTP}/admin/api/state`, { headers: { cookie: await cookie() } })).status, 200, 'the session that asked stays');
});

test('the activity list records what was done, newest first', async () => {
  const events = (await state()).events;
  const kinds = events.map((e) => e.kind);
  for (const kind of ['admin.signin', 'admin.denied', 'room.created', 'admin.room.rename', 'admin.room.expiry', 'admin.room.delete', 'admin.room.kick', 'admin.server.cleanup', 'admin.backup']) {
    assert.ok(kinds.includes(kind), kind);
  }
  assert.ok(events.every((e, i) => i === 0 || events[i - 1].at >= e.at));
  assert.ok(events.every((e) => Number.isFinite(e.at)), 'every entry has its own time');
  const dated = events.find((e) => e.kind === 'admin.room.expiry' && e.mode === 'at');
  assert.ok(dated.until > dated.at);
});

// ───────────────────────── hostile input ─────────────────────────

test('malformed input is refused without taking the server down', async () => {
  const trap = { toString: 1 }; // String() throws on this
  // Before signing in: the password, in every shape.
  for (const password of [trap, ['x'], [PASSWORD], 7, null, true]) {
    const res = await post(`${HTTP}/admin/api/login`, { password }, { 'X-Forwarded-For': '203.0.113.150' });
    assert.ok(res.status === 403 || res.status === 429, `${JSON.stringify(password)} -> ${res.status}`);
    assert.equal(res.headers.get('set-cookie'), null);
  }
  // A game connection: every field of the first message.
  for (const hello of [{ room: trap }, { room: 'x', token: trap }, { token: 'a'.repeat(20), name: trap }, { token: 'a'.repeat(20), name: 'Ana', claim: trap }]) {
    const code = await createRoom();
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ t: 'hello', room: code, ...hello }));
    await tick(60);
    ws.close();
  }
  // Signed in: every field of a change.
  const code = await createRoom();
  for (const body of [{ do: trap }, { do: 'room.rename', code: trap }, { do: 'room.rename', code, name: trap }, { do: 'room.kick', code, id: trap }, { do: 'room.message', code, text: trap }, { do: 'room.expiry', code, mode: trap, at: trap }, { do: 'server.message', text: [1] }, { do: 'server.create', name: trap }, [], 5]) {
    const res = await act(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.error);
  }
  assert.equal((await roomIn(code)).code, code, 'the room is untouched');
  assert.equal((await fetch(`${HTTP}/healthz`)).status, 200, 'and the server is still up');
});

test('many slow sign-in attempts opened together do not each get a guess', async () => {
  // Open the requests first, send the passwords afterwards: all of them passed the first look at the count.
  const http = await import('node:http');
  const attempt = (i) =>
    new Promise((resolve) => {
      const body = JSON.stringify({ password: `slow guess ${i}` });
      const req = http.request(`${HTTP}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-swipe-admin': '1', 'content-length': Buffer.byteLength(body), 'x-forwarded-for': '203.0.113.180' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.flushHeaders();
      setTimeout(() => req.end(body), 150);
    });
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => attempt(i)));
  assert.equal(results.filter((s) => s === 403).length, 6, results.join(' '));
  assert.equal(results.filter((s) => s === 429).length, 14);
});

test('IPv6 addresses in one /64 share a count; an address that is not one is not believed', async () => {
  for (let i = 0; i < 6; i++) {
    assert.equal((await post(`${HTTP}/admin/api/login`, { password: 'no' }, { 'X-Forwarded-For': `2001:db8:1:2::${i + 1}` })).status, 403);
  }
  assert.equal((await post(`${HTTP}/admin/api/login`, { password: PASSWORD }, { 'X-Forwarded-For': '2001:db8:1:2:aaaa:bbbb:cccc:dddd' })).status, 429, 'same /64');
  assert.equal((await post(`${HTTP}/admin/api/login`, { password: PASSWORD }, { 'X-Forwarded-For': '2001:db8:1:3::1' })).status, 200, 'a different /64');

  // A header that is not an address falls back to the connection's own.
  const code = await createRoom();
  const odd = client(code, 'Odd', { via: '"><script>alert(1)</script>' });
  await odd.ready();
  assert.deepEqual((await roomIn(code)).players[0].ips, ['127.0.0.1']);
  odd.ws.close();
});

// ───────────────────────── one meaning per address ─────────────────────────

test('only a plain /admin path is the admin page, so a proxy rule on /admin cannot be sidestepped', async () => {
  const http = await import('node:http');
  // Sent exactly as written: no client-side tidying of the path.
  const get = (path) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'GET' }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });
  const isAdmin = (r) => r.status === 200 && /login-form|"enabled"/.test(r.body);

  // What nginx also reads as /admin (it resolves dots and merges slashes before matching), this server serves…
  for (const path of ['/admin', '/admin/', '/admin?x=1', '/./admin', '/x/../admin', '/x/%2e%2e/admin', '//admin', '/admin//api/session', '/admin/api/session']) {
    assert.ok(isAdmin(await get(path)), `${path} is the admin page`);
  }
  // …and nothing else is. Each of these would slip past a "location /admin" rule.
  for (const path of ['//x/admin', '//x/admin/api/session', '//x/admin/api/state', '/x\\..\\admin', '\\admin', '/\\admin', '/x/..\\admin/api/session', '/%61dmin', '/Admin', '/ADMIN/api/session', '/admin;x', '/r/admin/../../x\\..\\admin']) {
    const res = await get(path);
    assert.ok(!isAdmin(res), `${path} -> ${res.status}`);
    assert.ok([400, 404].includes(res.status), `${path} -> ${res.status}`);
  }
  // The game itself is unaffected by the stricter reading.
  const code = await createRoom();
  for (const path of ['/', `/r/${code}`, `/r/${code}?seat=ABCDEFGH`, '/css/style.css', `/api/rooms/${code}`, '/manifest.webmanifest?room=x']) {
    assert.equal((await get(path)).status, 200, path);
  }
  // A game connection on anything but a plain /ws is refused as well.
  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}//x/ws`);
    ws.on('error', resolve);
    ws.on('open', () => assert.fail('opened'));
  });
});
