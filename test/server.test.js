// End-to-end tests: boot the real server and play over WebSockets.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import http from 'node:http';
import { judge, order } from '../public/js/rules.js';
import { browserKeys, checkVapid, decrypt } from './support/browser-side.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 39000 + Math.floor(Math.random() * 900);
const HTTP = `http://127.0.0.1:${PORT}`;
let server;

// A stand-in push service: records every message the game server sends it.
const PUSH_PORT = PORT + 1000;
const PUSH = `http://127.0.0.1:${PUSH_PORT}`;
const pushes = [];
const pushService = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    pushes.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(req.url.includes('/gone/') ? 410 : 201).end();
  });
});
const pushFor = async (path, n = 1) => {
  for (let i = 0; i < 80 && pushes.filter((p) => p.path === path).length < n; i++) await new Promise((r) => setTimeout(r, 25));
  return pushes.filter((p) => p.path === path);
};

before(async () => {
  await new Promise((resolve) => pushService.listen(PUSH_PORT, '127.0.0.1', resolve));
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', PERSIST: 'false', LOG_LEVEL: 'silent', DEAL_MS: '0', BOT_DELAY_MS: '2', MESSAGE_BUDGET: '100000', PUSH_EXTRA_HOSTS: `127.0.0.1:${PUSH_PORT}`, PUSH_REMIND_MS: '60' },
    stdio: 'inherit',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${HTTP}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => {
  server?.kill();
  pushService.close();
});

async function createRoom() {
  const res = await fetch(`${HTTP}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 201);
  return (await res.json()).code;
}

/** A tiny test client: tracks the latest state and lets tests await changes. */
function client(room, name, token = `token-${name}-${Math.random().toString(36).slice(2)}-pad`, { claim } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: 'https://swipe.example.org' } });
  const c = { ws, name, token, state: null, events: [], errors: [], fatal: null, waiters: [], seq: 0, replies: new Map() };
  const check = () => {
    c.waiters = c.waiters.filter((w) => {
      if (!w.pred(c)) return true;
      w.resolve(c.state);
      return false;
    });
  };
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', room, token, name, claim })));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.t === 'state') {
      c.state = msg.s;
      if (msg.s.round) c.events.push(msg.s.round.last); // every event this client was shown, in order
    }
    if (msg.t === 'err') c.errors.push(msg.m);
    if (msg.t === 'err' || msg.t === 'ack') c.replies.set(msg.n, msg.t === 'err' ? msg.m : null);
    if (msg.t === 'fatal' || msg.t === 'kicked' || msg.t === 'moved') c.fatal = msg;
    if (msg.t === 'seat') c.seat = msg;
    if (msg.t === 'claim') c.claim = msg;
    check();
  });
  c.until = (pred, what = 'condition') =>
    new Promise((resolve, reject) => {
      if (pred(c)) return resolve(c.state);
      const timer = setTimeout(() => reject(new Error(`${name}: timed out waiting for ${what}; errors: ${JSON.stringify(c.errors)}`)), 4000);
      c.waiters.push({ pred, resolve: (v) => (clearTimeout(timer), resolve(v)) });
    });
  c.ready = () => c.until((x) => x.state !== null, 'first state');
  c.me = () => c.state.players.find((p) => p.id === c.state.you);
  c.raw = (obj) => ws.send(JSON.stringify(obj));
  c.id = () => c.state.you;
  /** Sends an action and waits for the server's answer: null on success, else the error text. */
  c.do = async (a, data = {}) => {
    const n = ++c.seq;
    ws.send(JSON.stringify({ t: 'a', a, n, ...data }));
    await c.until((x) => x.replies.has(n) || x.fatal, `result of ${a}`);
    return c.replies.get(n) ?? null;
  };
  return c;
}

async function tableOf(names) {
  const code = await createRoom();
  const all = [];
  for (const name of names) {
    const c = client(code, name); // first in hosts
    await c.ready();
    all.push(c);
  }
  await all[0].until((x) => x.state.players.length === names.length, 'everyone in');
  return { code, all, host: all[0] };
}

const settle = (clients, pred, what) => Promise.all(clients.map((c) => c.until((x) => pred(x.state, x), what)));

/** Plays one legal move for whoever's turn it is, the way a cautious person would. */
async function takeTurn(clients) {
  const any = clients[0].state;
  const mover = clients.find((c) => c.id() === any.round.turn);
  const r = mover.state.round;
  const seat = r.seats[mover.id()];
  const top = { rank: r.pile.top.at(-1)?.r ?? null, run: r.pile.top.length };
  const seqBefore = r.last.seq;
  let err;
  if (r.pending) {
    err = await mover.do('play', { cards: [seat.blind[r.pending.slot].id] });
  } else {
    const open = [...r.mine, ...seat.up.filter(Boolean)].sort((a, b) => order(b.r) - order(a.r));
    const safe = open.find((c) => judge(top, c.r, 1).effect !== 'pickup');
    const slot = seat.blind.findIndex((c, i) => c && !seat.up[i]);
    if (safe) err = await mover.do('play', { cards: [safe.id] });
    else if (slot !== -1) err = await mover.do('flip', { slot });
    else err = await mover.do('play', { cards: [open[0].id] });
  }
  assert.equal(err, null);
  await settle(clients, (s) => s.round.last.seq > seqBefore, 'the move to land');
}

async function playOut(clients) {
  for (let i = 0; i < 5000 && clients[0].state.round.phase === 'play'; i++) await takeTurn(clients);
  assert.equal(clients[0].state.round.phase, 'over');
}

test('serves the app and a health check, and nothing outside public/', async () => {
  const html = await (await fetch(`${HTTP}/`)).text();
  assert.match(html, /<base href="\/">/);
  assert.ok(!html.includes('{{'), 'template placeholders are filled in');
  assert.equal((await fetch(`${HTTP}/js/rules.js`)).status, 200);
  assert.equal((await (await fetch(`${HTTP}/healthz`)).json()).ok, true);
  assert.equal((await fetch(`${HTTP}/api/rooms/nope-nope-00`)).status, 404);
  assert.equal((await fetch(`${HTTP}/../package.json`)).status, 404);
  assert.equal((await fetch(`${HTTP}/%2e%2e/package.json`)).status, 404);
});

test('a room that does not exist is refused', async () => {
  const c = client('no-such-room', 'Zed');
  await c.until((x) => x.fatal, 'fatal');
  assert.equal(c.fatal.code, 'no-room');
});

test('lobby: everyone gets a seat and a colour of their own; only the host can deal', async () => {
  const { all, host } = await tableOf(['Ana', 'Bo']);
  const [ana, bo] = all;
  assert.equal(ana.state.hostId, ana.id(), 'first player in is the host');
  assert.ok(ana.state.players.every((p) => p.playing));
  assert.equal(new Set(ana.state.players.map((p) => p.color)).size, 2);
  assert.match(await bo.do('start'), /Only the host/);
  assert.match(await bo.do('addBot'), /Only the host/);
  assert.equal(await bo.do('sit', { on: false }), null);
  assert.match(await host.do('start'), /at least 2 players/, 'one person cannot play alone');
  assert.equal(await bo.do('sit', { on: true }), null);
  assert.equal(await host.do('addBot'), null);
  await ana.until((x) => x.state.players.length === 3, 'the computer player');
  assert.equal(ana.state.players.filter((p) => p.bot).length, 1);
  assert.equal(await host.do('start'), null);
  await settle(all, (s) => s.round?.phase === 'play', 'the deal');
  assert.equal(ana.state.round.order.length, 3);
});

test('two people are enough for a game', async () => {
  const { all, host } = await tableOf(['Ana', 'Bo']);
  assert.equal(await host.do('start'), null);
  await settle(all, (s) => s.round?.phase === 'play', 'the deal');
  const r = host.state.round;
  assert.equal(r.order.length, 2);
  assert.equal(r.decks, 2);
  for (const c of all) assert.equal(c.state.round.mine.length, 12);
  await playOut(all);
  const end = host.state.round;
  assert.equal(end.reason, 'out');
  assert.equal(end.result.points[end.winner], 0);
});

test('the pile is sent as a face-up top and face-down cards beneath it', async () => {
  const { all, host } = await tableOf(['Ana', 'Bo', 'Cy']);
  await host.do('start');
  await settle(all, (s) => s.round?.phase === 'play', 'the deal');
  let checked = 0;
  for (let i = 0; i < 400 && all[0].state.round.phase === 'play'; i++) {
    await takeTurn(all);
    for (const c of all) {
      const pile = c.state.round.pile;
      const under = pile.count - pile.top.length;
      assert.equal(pile.backs.length, Math.min(under, 16));
      assert.ok(pile.backs.every((b) => b === 0 || b === 1), 'buried cards arrive as backs only');
      assert.ok(pile.top.every((card) => card.r === pile.top[0].r), 'the top run is one rank');
    }
    if (all[0].state.round.pile.backs.length >= 3) checked += 1;
    if (checked >= 5) break;
  }
  assert.ok(checked > 0, 'saw a pile with buried cards');
});

test('nobody is ever sent a card they could not see at a real table', async () => {
  const { all, host } = await tableOf(['Ana', 'Bo', 'Cy']);
  const watcher = client(all[0].state.code, 'Wren');
  await watcher.ready();
  await watcher.do('sit', { on: false });
  assert.equal(await host.do('start'), null);
  const everyone = [...all, watcher];
  await settle(everyone, (s) => s.round?.phase === 'play', 'the deal');

  const hands = new Map(all.map((c) => [c.id(), c.state.round.mine.map((card) => card.id)]));
  for (const c of all) {
    assert.equal(c.state.round.mine.length, 12);
    assert.equal(c.state.round.seats[c.id()].up.filter(Boolean).length, 4);
  }
  assert.equal(watcher.state.round.mine, null);

  for (const viewer of everyone) {
    const r = viewer.state.round;
    for (const pid of r.order) {
      const seat = r.seats[pid];
      assert.equal(seat.hand, 12);
      assert.equal(seat.backs.length, 12);
      assert.ok(seat.backs.every((b) => b === 0 || b === 1));
      assert.ok(seat.blind.every((b) => b && Object.keys(b).join() === 'b'), 'blind cards arrive as backs only');
    }
    // Everything the viewer was sent, minus their own hand: no other hand may appear in it.
    const { mine, ...rest } = r;
    const seen = JSON.stringify({ ...viewer.state, round: rest });
    for (const [pid, cardIds] of hands) {
      if (pid === viewer.id()) continue;
      for (const id of cardIds) assert.ok(!seen.includes(`"id":"${id}"`), `${viewer.name} was sent a card from another hand`);
    }
  }
});

test('a flipped blind card is shown to the whole table and has to be played', async () => {
  const { all, host } = await tableOf(['Ana', 'Bo', 'Cy']);
  await host.do('start');
  await settle(all, (s) => s.round?.phase === 'play', 'the deal');
  const mover = all.find((c) => c.id() === c.state.round.turn);
  const other = all.find((c) => c !== mover);
  assert.match(await mover.do('flip', { slot: 0 }), /face-up card on top/);
  assert.match(await other.do('flip', { slot: 0 }), /not your turn/);

  // Clear slot 0's face-up card with the mover's own turns, then flip what was under it.
  let guard = 0;
  while (all[0].state.round.phase === 'play' && guard++ < 400) {
    const m = all.find((c) => c.id() === c.state.round.turn);
    const r = m.state.round;
    const seat = r.seats[m.id()];
    const top = { rank: r.pile.top.at(-1)?.r ?? null, run: r.pile.top.length };
    const up = seat.up[0];
    if (!r.pending && up && judge(top, up.r, 1).ok) {
      // Plays the face-up card whatever it costs, to uncover the blind one.
      const seq = r.last.seq;
      assert.equal(await m.do('play', { cards: [up.id] }), null);
      await settle(all, (s) => s.round.last.seq > seq, 'the play');
      if (all[0].state.round.turn !== m.id()) continue;
    }
    const now = m.state.round;
    if (now.turn === m.id() && !now.pending && !now.seats[m.id()].up[0] && now.seats[m.id()].blind[0]) {
      const before = now.last.seq;
      assert.equal(await m.do('flip', { slot: 0 }), null);
      await settle(all, (s) => s.round.last.seq > before, 'the flip');
      const flip = m.events.find((e) => e.seq === before + 1);
      assert.equal(flip.kind, 'flip');
      if (flip.card.r === '10') {
        // A ten plays itself: everyone is shown the flip, then the swipe.
        await settle(all, (s) => s.round.last.seq === before + 2, 'the automatic play');
        for (const c of all) {
          const shown = c.events.filter((e) => e.seq > before).map((e) => e.kind);
          assert.deepEqual([...new Set(shown)], ['flip', 'play'], 'flip first, then the play');
          assert.equal(c.state.round.last.swipe, 'ten');
          assert.equal(c.state.round.pending, null);
          assert.equal(c.state.round.turn, m.id(), 'and the same player goes again');
        }
        return;
      }
      for (const c of all) {
        const shown = c.state.round.seats[m.id()].blind[0];
        assert.ok(shown.id && shown.r, 'everyone sees the flipped card');
        assert.equal(c.state.round.last.kind, 'flip');
      }
      const handCard = m.state.round.mine[0];
      assert.match(await m.do('play', { cards: [handCard.id] }), /(has to be played now|same rank)/);
      assert.equal(await m.do('play', { cards: [m.state.round.seats[m.id()].blind[0].id] }), null);
      return;
    }
    await takeTurn(all);
  }
  assert.fail('never got to flip a blind card');
});

test('a full match: scores add up, the winner leads the next game, the limit ends it', async () => {
  const { all, host } = await tableOf(['Ana', 'Bo', 'Cy']);
  assert.equal(await host.do('settings', { patch: { limit: 20 } }), null);
  assert.match(await all[1].do('settings', { patch: { limit: 50 } }), /Only the host/);
  assert.match(await host.do('settings', { patch: { limit: 5 } }), /20 to 1000/);
  await host.do('start');
  await settle(all, (s) => s.round?.phase === 'play', 'the deal');
  assert.equal(all[0].state.round.start.why, 'high');
  await playOut(all);

  const s = all[1].state;
  const r = s.round;
  assert.equal(r.reason, 'out');
  assert.equal(r.result.points[r.winner], 0);
  for (const pid of r.order) {
    assert.equal(s.match.scores[pid], r.result.points[pid]);
    if (pid !== r.winner) assert.ok(r.result.left[pid].length > 0 && r.result.points[pid] > 0);
  }
  assert.equal(s.match.gameNo, 1);
  assert.equal(s.match.history.length, 1);

  if (!s.match.over) {
    // Rare: everybody else was left with under 20 points. Play on until someone busts.
    for (let i = 0; i < 30 && !all[0].state.match.over; i++) {
      const winner = all[0].state.round.winner;
      await host.do('start');
      await settle(all, (st) => st.round.phase === 'play' && st.round.no === i + 2, 'the next deal');
      assert.equal(all[0].state.round.turn, winner, 'the last winner leads');
      assert.equal(all[0].state.round.start.why, 'winner');
      await playOut(all);
    }
  }
  const m = all[0].state.match;
  assert.equal(m.over, true);
  const low = Math.min(...m.order.map((pid) => m.scores[pid]));
  assert.deepEqual(m.champions, m.order.filter((pid) => m.scores[pid] === low));

  // Raising the limit lets the same match carry on; a fresh start resets it.
  assert.equal(await host.do('settings', { patch: { limit: 1000 } }), null);
  await host.until((x) => !x.state.match.over, 'match reopened');
  assert.equal(await host.do('lobby'), null);
  await host.until((x) => x.state.match === null && x.state.round === null, 'lobby');
});

test('computer players play by themselves and the host can play a turn for someone', async () => {
  const { all, host } = await tableOf(['Ana', 'Bo']);
  await host.do('addBot');
  await host.do('addBot');
  await host.until((x) => x.state.players.length === 4, 'two computer players');
  await host.do('start');
  await settle(all, (s) => s.round?.phase === 'play', 'the deal');
  assert.match(await all[1].do('auto'), /Only the host/);
  for (let i = 0; i < 3000 && host.state.round.phase === 'play'; i++) {
    const turn = host.state.round.turn;
    const seq = host.state.round.last.seq;
    const mover = host.state.players.find((p) => p.id === turn);
    if (turn === host.id()) await takeTurn(all);
    else if (!mover.bot) {
      // Bo has wandered off: the host plays the turn (a flip takes two steps).
      assert.equal(await host.do('auto'), null);
      await host.until((x) => x.state.round.last.seq > seq, 'the auto move');
    } else {
      await host.until((x) => x.state.round.last.seq > seq || x.state.round.phase !== 'play', 'the computer player to move');
    }
  }
  assert.equal(host.state.round.phase, 'over');
  assert.match(await host.do('auto'), /no turn/);
});

test('reconnecting with the same token keeps the seat and the hand', async () => {
  const { code, all, host } = await tableOf(['Ana', 'Bo', 'Cy']);
  await host.do('start');
  await settle(all, (s) => s.round?.phase === 'play', 'the deal');
  const bo = all[1];
  const hand = bo.state.round.mine.map((c) => c.id).sort();
  bo.ws.close();
  await host.until((x) => x.state.players.find((p) => p.name === 'Bo').online === false, 'Bo offline');
  const again = client(code, 'Bo', bo.token);
  await again.ready();
  assert.equal(again.id(), bo.id());
  assert.deepEqual(again.state.round.mine.map((c) => c.id).sort(), hand);
  await host.until((x) => x.state.players.find((p) => p.name === 'Bo').online === true, 'Bo back');
});

test('latecomers watch, can ask to be dealt in, and start on the table average', async () => {
  const { code, all, host } = await tableOf(['Ana', 'Bo', 'Cy']);
  await host.do('start');
  await settle(all, (s) => s.round?.phase === 'play', 'the deal');
  const dee = client(code, 'Dee');
  await dee.ready();
  assert.equal(dee.me().playing, false, 'arriving mid-match means watching');
  assert.equal(dee.state.round.mine, null);
  assert.match(await dee.do('play', { cards: ['0'] }), /not your turn/);
  assert.equal(await dee.do('sit', { on: true }), null);
  await playOut(all);
  const before = host.state.match;
  if (before.over) return; // someone hit 100 in one game: nothing more to check
  const average = Math.round(before.order.reduce((sum, pid) => sum + before.scores[pid], 0) / before.order.length);
  await host.do('start');
  await settle([...all, dee], (s) => s.round.no === 2 && s.round.phase === 'play', 'game two');
  assert.equal(dee.state.round.order.length, 4);
  assert.equal(dee.state.round.order.at(-1), dee.id(), 'new players sit at the end');
  assert.equal(dee.state.match.scores[dee.id()], average);
  assert.equal(dee.state.round.mine.length, 12);
});

test('leaving mid-game takes your cards out and passes the turn', async () => {
  const { all, host } = await tableOf(['Ana', 'Bo', 'Cy', 'Dee']);
  await host.do('start');
  await settle(all, (s) => s.round?.phase === 'play', 'the deal');
  const mover = all.find((c) => c.id() === c.state.round.turn);
  const rest = all.filter((c) => c !== mover);
  const orderBefore = mover.state.round.order;
  const next = orderBefore[(orderBefore.indexOf(mover.id()) + 1) % orderBefore.length];
  assert.equal(await mover.do('sit', { on: false }), null);
  await settle(rest, (s) => s.round.order.length === 3, 'three left');
  assert.equal(rest[0].state.round.turn, next);
  assert.equal(rest[0].state.round.burned, 20);
  assert.equal(mover.state.round.mine, null);
  assert.ok(!rest[0].state.match.order.includes(mover.id()));
});

test('host controls: lock, hand over, remove', async () => {
  const { code, all, host } = await tableOf(['Ana', 'Bo', 'Cy']);
  const [, bo, cy] = all;
  assert.equal(await host.do('lock', { on: true }), null);
  const late = client(code, 'Late');
  await late.until((x) => x.fatal, 'refusal');
  assert.equal(late.fatal.code, 'locked');
  await host.do('lock', { on: false });

  assert.equal(await host.do('kick', { id: cy.id() }), null);
  await cy.until((x) => x.fatal, 'kicked');
  const back = client(code, 'Cy', cy.token);
  await back.until((x) => x.fatal, 'still banned');
  assert.equal(back.fatal.code, 'banned');

  assert.equal(await host.do('giveHost', { id: bo.id() }), null);
  await bo.until((x) => x.state.hostId === bo.id(), 'new host');
  assert.match(await host.do('start'), /Only the host/);
  assert.equal(await bo.do('rename', { name: '  Bo   the  Second ' }), null);
  await host.until((x) => x.state.players.some((p) => p.name === 'Bo the Second'), 'rename');
  const colour = bo.me().color;
  await bo.do('recolor');
  await bo.until((x) => x.me().color !== colour, 'a new colour');
});

test('bad input never takes the server down', async () => {
  const { all, host } = await tableOf(['Ana', 'Bo', 'Cy']);
  await host.do('start');
  await settle(all, (s) => s.round?.phase === 'play', 'the deal');
  const mover = all.find((c) => c.id() === c.state.round.turn);
  for (const cards of [null, 'x', [], [{}], [1, 2, 3, 4, 5], ['__proto__'], [mover.state.round.mine[0].id, mover.state.round.mine[0].id]]) {
    assert.ok(await mover.do('play', { cards }), `refused: ${JSON.stringify(cards)}`);
  }
  for (const slot of [null, -1, 9, 'a', 1.5]) assert.ok(await mover.do('flip', { slot }));
  assert.ok(await mover.do('nonsense'));
  mover.ws.send('not json');
  mover.ws.send('{"t":"a"}');
  assert.equal((await (await fetch(`${HTTP}/healthz`)).json()).ok, true);
});

// ───────────────────────── notifications and seats, end to end ─────────────────────────

test('the page carries the push key, and the app pieces are served', async () => {
  const html = await (await fetch(`${HTTP}/`)).text();
  const cfg = JSON.parse(/<script id="config" type="application\/json">(.*?)<\/script>/s.exec(html)[1]);
  assert.equal(Buffer.from(cfg.pushKey, 'base64url').length, 65);
  const sw = await fetch(`${HTTP}/sw.js`);
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.equal(sw.headers.get('cache-control'), 'no-cache', 'a new service worker is picked up at once');
  const manifest = await (await fetch(`${HTTP}/manifest.webmanifest`)).json();
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '.');
  for (const icon of manifest.icons) {
    const res = await fetch(`${HTTP}/${icon.src}`);
    assert.equal(res.status, 200, icon.src);
    assert.equal(res.headers.get('content-type'), icon.type);
  }
  assert.ok(manifest.icons.some((i) => i.sizes === '192x192' && i.type === 'image/png'));
  assert.ok(manifest.icons.some((i) => i.sizes === '512x512' && i.type === 'image/png'));
  assert.equal((await fetch(`${HTTP}/icons/apple-touch-icon.png`)).status, 200);
});

test('added to a Home Screen from inside a room, the app opens in that room with the seat', async () => {
  const get = async (q) => (await (await fetch(`${HTTP}/manifest.webmanifest${q}`)).json()).start_url;
  assert.equal(await get('?room=lucky-riffle-42&seat=K7QM2P9X'), './r/lucky-riffle-42?seat=K7QM2P9X');
  assert.equal(await get('?room=lucky-riffle-42'), './r/lucky-riffle-42');
  assert.equal(await get('?room=Lucky_Riffle 42&seat=k7qm-2p9x'), './r/lucky-riffle-42?seat=K7QM2P9X');
  assert.equal(await get('?room=../../etc&seat="><script>'), './r/etc', 'nothing but a clean room code gets through');
  assert.equal(await get('?seat=K7QM2P9X'), '.');
});

test('a real push: signed, encrypted, and only for someone who is not looking', async () => {
  const { all, host } = await tableOf(['Ana', 'Bo', 'Cy']);
  const html = await (await fetch(`${HTTP}/`)).text();
  const serverKey = JSON.parse(/<script id="config" type="application\/json">(.*?)<\/script>/s.exec(html)[1]).pushKey;
  const devices = new Map(all.map((c) => [c, browserKeys()]));
  const path = (c) => `/push/${c.name}-${c.token.slice(-12)}`;
  for (const c of all) assert.equal(await c.do('push', { sub: { endpoint: `${PUSH}${path(c)}`, keys: devices.get(c).keys } }), null);
  await settle(all, (s) => s.notify === true, 'notifications on');
  assert.match(await host.do('push', { sub: { endpoint: 'http://127.0.0.1:1/elsewhere', keys: devices.get(host).keys } }), /not one Swipe can send to/);

  await host.do('start');
  await settle(all, (s) => s.round?.phase === 'play', 'the deal');
  const order = all[0].state.round.order.map((id) => all.find((c) => c.id() === id));
  const first = order.find((c) => c.id() === all[0].state.round.turn);
  const second = order[(order.indexOf(first) + 1) % 3];
  const third = order[(order.indexOf(first) + 2) % 3];

  // The second player locks their phone. The third keeps watching.
  second.raw({ t: 'vis', v: false });
  await second.do('rename', { name: second.name }); // round trip, so the server has seen it
  const before = pushes.length;
  let guard = 0;
  while (all[0].state.round.turn === first.id() && all[0].state.round.phase === 'play' && guard++ < 50) await takeTurn(all);
  if (all[0].state.round.phase !== 'play') return; // freak game: over before the turn passed
  assert.equal(all[0].state.round.turn, second.id());

  const [got] = await pushFor(path(second));
  assert.ok(got, 'the push service was called');
  assert.equal(got.headers['content-encoding'], 'aes128gcm');
  assert.equal(got.headers.ttl, '600');
  assert.equal(got.headers.urgency, 'high');
  assert.match(got.headers.topic, /^[\w-]{1,32}$/);
  const claims = checkVapid(got.headers.authorization, serverKey);
  assert.equal(claims.aud, PUSH);
  assert.equal(claims.sub, 'https://swipe.example.org', 'the site’s own address, taken from the connection');
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 24 * 3600);
  const device = devices.get(second);
  const message = JSON.parse(decrypt(got.body, device.privateKey, device.auth));
  assert.equal(message.title, 'Your turn');
  assert.equal(message.kind, 'turn');
  assert.equal(message.url, `r/${all[0].state.code}`);
  assert.match(message.body, new RegExp(`^${first.name} (played|picked up|swiped) .*(or lower, or a ten|Play anything|Aces only, or a ten)\\.$`));
  assert.ok(!got.body.toString('latin1').includes('Your turn'), 'nothing readable on the wire');
  assert.throws(() => decrypt(got.body, devices.get(third).privateKey, devices.get(third).auth), 'and nobody else’s keys open it');

  // Their turn is played for them (possibly in two steps); the third player is watching, so no push.
  for (let i = 0; i < 4 && all[0].state.round.turn === second.id() && all[0].state.round.phase === 'play'; i++) await takeTurn(all);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(pushes.filter((p) => p.path === path(third)).length, 0);
  assert.equal(pushes.filter((p) => p.path === path(first)).length, 0);
  assert.ok(pushes.length - before >= 1);
});

test('a test notification arrives, and a subscription the push service has dropped is cleared', async () => {
  const { all } = await tableOf(['Ana', 'Bo']);
  const [ana, bo] = all;
  const device = browserKeys();
  assert.match(await ana.do('pushTest'), /off in this browser/);
  assert.equal(await ana.do('push', { sub: { endpoint: `${PUSH}/push/test-${ana.token.slice(-8)}`, keys: device.keys } }), null);
  assert.equal(await ana.do('pushTest'), null);
  const [got] = await pushFor(`/push/test-${ana.token.slice(-8)}`);
  assert.equal(JSON.parse(decrypt(got.body, device.privateKey, device.auth)).title, 'Notifications are on');

  const gone = browserKeys();
  assert.equal(await bo.do('push', { sub: { endpoint: `${PUSH}/gone/${bo.token.slice(-8)}`, keys: gone.keys } }), null);
  await bo.until((x) => x.state.notify === true, 'on');
  assert.equal(await bo.do('pushTest'), null);
  await bo.until((x) => x.state.notify === false, 'cleared after the push service said 410');
  assert.equal(ana.state.notify, true, 'only the dead one');
});

test('a seat code carries a seat from one browser to another', async () => {
  const { code, all, host } = await tableOf(['Ana', 'Bo', 'Cy']);
  await host.do('start');
  await settle(all, (s) => s.round?.phase === 'play', 'the deal');
  const bo = all[1];
  const hand = bo.state.round.mine.map((c) => c.id).sort();
  bo.raw({ t: 'seat' });
  await bo.until((x) => x.seat, 'a seat code');
  assert.match(bo.seat.code, /^[A-Z2-9]{8}$/);
  assert.ok(!JSON.stringify(host.state).includes(bo.seat.code), 'nobody else is shown it');

  const wrong = client(code, '', undefined, { claim: 'AAAAAAAA' });
  await wrong.until((x) => x.fatal, 'refusal');
  assert.deepEqual(wrong.claim, { t: 'claim', ok: false });
  assert.equal(wrong.fatal.code, 'name', 'a bad code just leaves a stranger at the door');

  const app = client(code, '', undefined, { claim: bo.seat.code });
  await app.ready();
  assert.deepEqual(app.claim, { t: 'claim', ok: true });
  assert.equal(app.id(), bo.id());
  assert.equal(app.me().name, 'Bo');
  assert.deepEqual(app.state.round.mine.map((c) => c.id).sort(), hand);
  await bo.until((x) => x.fatal, 'the old browser is told');
  assert.equal(bo.fatal.t, 'moved');
  assert.equal(host.state.players.length, 3);

  const reuse = client(code, '', undefined, { claim: bo.seat.code });
  await reuse.until((x) => x.fatal, 'refusal');
  assert.equal(reuse.claim.ok, false, 'a code works once');
});
