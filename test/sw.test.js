// The service worker, run outside a browser: its handlers are called with
// stand-ins for the things a browser would give them.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

function worker({ windows = [], scope = 'https://swipe.example.org/' } = {}) {
  const handlers = {};
  const shown = [];
  const opened = [];
  const focused = [];
  const self = {
    addEventListener: (type, fn) => (handlers[type] = fn),
    skipWaiting: () => (self.skipped = true),
    registration: { scope, showNotification: async (title, options) => shown.push({ title, ...options }) },
    clients: {
      claim: async () => (self.claimed = true),
      matchAll: async () => windows.map((url) => ({ url, focus: async () => focused.push(url) })),
      openWindow: async (url) => opened.push(url),
    },
  };
  vm.runInNewContext(source, { self, URL });
  const fire = async (type, event = {}) => {
    let pending = null;
    handlers[type]({ ...event, waitUntil: (p) => (pending = p) });
    await pending;
  };
  return { self, handlers, shown, opened, focused, fire };
}
const message = (obj) => ({ data: { json: () => obj, text: () => JSON.stringify(obj) } });

test('it takes over straight away and listens for the right things', async () => {
  const w = worker();
  assert.deepEqual(Object.keys(w.handlers).sort(), ['activate', 'install', 'notificationclick', 'push']);
  await w.fire('install');
  await w.fire('activate');
  assert.ok(w.self.skipped && w.self.claimed);
  assert.ok(!('fetch' in w.handlers), 'no fetch handler: nothing is ever served from a cache');
});

test('a push becomes a notification that carries where to go', async () => {
  const w = worker();
  await w.fire('push', message({ title: 'Your turn', body: 'Ana played two sevens. 7 or lower, or a ten.', url: 'r/lucky-riffle-42', tag: 'swipe-lucky-riffle-42', kind: 'turn' }));
  // (Round-tripped through JSON: the worker ran in its own context, so its objects are not this file's objects.)
  assert.deepEqual(JSON.parse(JSON.stringify(w.shown)), [
    {
      title: 'Your turn',
      body: 'Ana played two sevens. 7 or lower, or a ten.',
      tag: 'swipe-lucky-riffle-42',
      renotify: true,
      icon: 'icons/icon-192.png',
      badge: 'icons/badge-96.png',
      data: { url: 'r/lucky-riffle-42', kind: 'turn' },
    },
  ]);
});

test('every push shows something, even an empty or garbled one', async () => {
  const w = worker();
  await w.fire('push', { data: null });
  await w.fire('push', { data: { json: () => { throw new Error('not json'); }, text: () => 'plain words' } });
  assert.equal(w.shown.length, 2);
  assert.equal(w.shown[0].title, 'Swipe');
  assert.equal(w.shown[1].body, 'plain words');
});

const tap = (url) => ({ notification: { data: { url }, close() { this.closed = true; } } });

test('tapping it focuses the game if it is already open on that room', async () => {
  const w = worker({ windows: ['https://swipe.example.org/', 'https://swipe.example.org/r/lucky-riffle-42'] });
  const event = tap('r/lucky-riffle-42');
  await w.fire('notificationclick', event);
  assert.ok(event.notification.closed);
  assert.deepEqual(w.focused, ['https://swipe.example.org/r/lucky-riffle-42']);
  assert.deepEqual(w.opened, []);
});

test('otherwise it opens the room', async () => {
  const w = worker({ windows: ['https://swipe.example.org/r/another-room-07'] });
  await w.fire('notificationclick', tap('r/lucky-riffle-42'));
  assert.deepEqual(w.opened, ['https://swipe.example.org/r/lucky-riffle-42']);
  assert.deepEqual(w.focused, []);
});

test('under a sub-path the room link stays inside it', async () => {
  const w = worker({ scope: 'https://example.org/swipe/' });
  await w.fire('notificationclick', tap('r/lucky-riffle-42'));
  assert.deepEqual(w.opened, ['https://example.org/swipe/r/lucky-riffle-42']);
  await w.fire('notificationclick', { notification: { data: null, close() {} } });
  assert.equal(w.opened[1], 'https://example.org/swipe/');
});
