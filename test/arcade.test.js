// The au12 Arcade: what the server allows with ARCADE_URL set and without,
// and what the page reports to the arcade.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const servers = [];
after(() => servers.forEach((s) => s.kill()));

async function boot(env) {
  const port = 41000 + Math.floor(Math.random() * 900) + servers.length * 1000;
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PERSIST: 'false', LOG_LEVEL: 'silent', ...env },
    stdio: 'inherit',
  });
  servers.push(server);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return base;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

test('without ARCADE_URL nothing changes', async () => {
  const base = await boot({});
  const page = await fetch(`${base}/`);
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.doesNotMatch(page.headers.get('content-security-policy'), /frame-ancestors/);
  assert.equal((await fetch(`${base}/arcade.json`)).status, 404);
});

test('with ARCADE_URL the arcade may frame the game and hear from it', async () => {
  const base = await boot({ ARCADE_URL: 'https://arcade.example.com/some/path', ADMIN_PASSWORD: 'correct horse battery' });
  const page = await fetch(`${base}/r/lucky-riffle-42`);
  const csp = page.headers.get('content-security-policy');
  assert.equal(page.headers.get('x-frame-options'), null);
  assert.match(csp, /frame-ancestors 'self' https:\/\/arcade\.example\.com(;|$)/);
  assert.match(csp, /connect-src 'self' ws: wss: https:\/\/arcade\.example\.com;/);
  const html = await page.text();
  assert.match(html, /<script src="js\/vendor\/arcade\.js" data-game="swipe" data-config="\/arcade\.json"><\/script>/);

  const cfg = await fetch(`${base}/arcade.json`);
  assert.equal(cfg.status, 200);
  assert.deepEqual(await cfg.json(), { url: 'https://arcade.example.com' });

  // The admin page is never framed.
  const admin = await fetch(`${base}/admin`);
  assert.match(admin.headers.get('x-frame-options'), /^(DENY|SAMEORIGIN)$/);
  assert.doesNotMatch(admin.headers.get('content-security-policy'), /arcade\.example\.com/);
});

test('a junk ARCADE_URL is ignored', async () => {
  const base = await boot({ ARCADE_URL: 'javascript:alert(1)' });
  assert.equal((await fetch(`${base}/arcade.json`)).status, 404);
  assert.equal((await fetch(`${base}/`)).headers.get('x-frame-options'), 'SAMEORIGIN');
});

test('the page reports games and matches it saw end, once each', async () => {
  const sent = [];
  const memory = new Map();
  globalThis.localStorage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)) };
  globalThis.Arcade = {
    mode: 'embedded',
    kiosk: false,
    player: { id: 'p-mom', name: 'Mom' },
    ready: Promise.resolve(null),
    result: (outcome, opts) => sent.push({ outcome, ...opts.meta }),
    status: () => {},
    invite: () => {},
  };
  const { arcadeReport, personal } = await import('../public/js/arcade.js');

  const players = [
    { id: 'a', bot: false },
    { id: 'b', bot: true },
    { id: 'c', bot: true },
  ];
  const state = (round, match) => ({ you: 'a', players, round, match });
  const playing = { id: 'r1', phase: 'play', order: ['a', 'b', 'c'] };
  const won = { ...playing, phase: 'over', reason: 'out', winner: 'a' };
  const ongoing = { over: false, order: ['a', 'b', 'c'], champions: [], gameNo: 1 };

  // A finished game, seen happen: reported once.
  arcadeReport(state(playing, ongoing), state(won, ongoing));
  arcadeReport(state(playing, ongoing), state(won, ongoing));
  assert.deepEqual(sent, [{ outcome: 'win', match: false, players: 3, vs: 'bot' }]);

  // Opened on a game that is already over: nothing.
  arcadeReport(null, state(won, ongoing));
  arcadeReport(state(won, ongoing), state(won, ongoing));
  assert.equal(sent.length, 1);

  // Called off, or a game you only watched: nothing.
  const playing2 = { ...playing, id: 'r2' };
  arcadeReport(state(playing2, ongoing), state({ ...playing2, phase: 'over', reason: 'abandoned', winner: null }, ongoing));
  const watched = { id: 'r3', phase: 'play', order: ['b', 'c'] };
  arcadeReport(state(watched, ongoing), state({ ...watched, phase: 'over', reason: 'out', winner: 'b' }, ongoing));
  assert.equal(sent.length, 1);

  // The game that ends the match: the game, then the match.
  const last = { id: 'r4', phase: 'play', order: ['a', 'b', 'c'] };
  const ended = { ...ongoing, over: true, champions: ['b'], gameNo: 4 };
  arcadeReport(state(last, ongoing), state({ ...last, phase: 'over', reason: 'out', winner: 'c' }, ended));
  assert.deepEqual(sent.slice(1), [
    { outcome: 'loss', match: false, players: 3, vs: 'bot' },
    { outcome: 'loss', match: true, players: 3, vs: 'bot', games: 4 },
  ]);

  // Storage: the first arcade player on a browser keeps its plain keys.
  assert.equal(personal('token'), 'token');
  globalThis.Arcade.player = { id: 'p-dad', name: 'Dad' };
  assert.equal(personal('token'), 'token@p-dad');
  globalThis.Arcade.player = null;
  assert.equal(personal('token'), 'token@guest');
  globalThis.Arcade.player = { id: 'p-mom' };
  globalThis.Arcade.kiosk = true;
  assert.equal(personal('token'), 'token@p-mom');
  globalThis.Arcade.mode = 'off';
  assert.equal(personal('token'), 'token');
});
