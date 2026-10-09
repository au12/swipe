// The push sender, checked against the worked example in RFC 8291 and against
// an independent decryption written out here the way a browser would do it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createPublicKey, verify } from 'node:crypto';
import { checkVapid, decrypt } from './support/browser-side.js';

process.env.PERSIST = 'false';
process.env.LOG_LEVEL = 'silent';
process.env.PUSH_EXTRA_HOSTS = '127.0.0.1:9';
const push = await import('../server/push.js');

const u = (text) => Buffer.from(text, 'base64url');

test('encryption reproduces the RFC 8291 example byte for byte', () => {
  const as = createECDH('prime256v1');
  as.setPrivateKey(u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'));
  assert.equal(as.getPublicKey().toString('base64url'), 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
  const sub = {
    endpoint: 'https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV',
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  };
  const body = push.encrypt('When I grow up, I want to be a watermelon', sub, { salt: u('DGv6ra1nlYgDCS1FRnbzlw'), localKey: as });
  assert.equal(
    body.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
      'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
      'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  );
  assert.equal(decrypt(body, u('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'), u(sub.auth)).toString(), 'When I grow up, I want to be a watermelon');
});

test('a message encrypted with fresh keys opens with the browser’s keys and no others', () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = Buffer.from('0123456789abcdef');
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
  const text = JSON.stringify({ title: 'Your turn', body: 'Señor Ünïcode played two sevens. ♠' });
  const a = push.encrypt(text, sub);
  const b = push.encrypt(text, sub);
  assert.notDeepEqual(a, b, 'a new salt and key every time');
  assert.equal(decrypt(a, ua.getPrivateKey(), auth).toString(), text);
  const other = createECDH('prime256v1');
  other.generateKeys();
  assert.throws(() => decrypt(a, other.getPrivateKey(), auth));
  assert.throws(() => decrypt(a, ua.getPrivateKey(), Buffer.from('fedcba9876543210')));
});

test('the VAPID header is a token signed by this server’s key, for that push service only', () => {
  const keys = push.loadKeys();
  assert.equal(u(keys.publicKey).length, 65);
  const now = Date.UTC(2026, 9, 9);
  const header = push.vapidHeader('https://web.push.apple.com/QAbc123', 'https://swipe.example.org', now);
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  assert.ok(m, header);
  const [, head, claims, sig, k] = m;
  assert.equal(k, keys.publicKey);
  assert.deepEqual(JSON.parse(u(head)), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(u(claims)), { aud: 'https://web.push.apple.com', exp: now / 1000 + 12 * 3600, sub: 'https://swipe.example.org' });
  const pub = u(k);
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.equal(u(sig).length, 64);
  assert.ok(verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, u(sig)), 'signature checks out');
  assert.ok(!verify('sha256', Buffer.from(`${head}.${claims}x`), { key, dsaEncoding: 'ieee-p1363' }, u(sig)));
  assert.equal(checkVapid(header, keys.publicKey).aud, 'https://web.push.apple.com');
});

test('the contact is the site’s own address unless one is configured', () => {
  assert.equal(push.contactFor('https://swipe.example.org'), 'https://swipe.example.org');
  assert.match(push.contactFor('http://192.168.1.5:3001'), /^mailto:/);
  assert.match(push.contactFor('https://localhost'), /^mailto:/);
  assert.match(push.contactFor(undefined), /^mailto:/);
});

test('only real push services are accepted as destinations', () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') };
  const ok = (endpoint, k = keys) => push.cleanSubscription({ endpoint, keys: k });
  for (const good of [
    'https://fcm.googleapis.com/fcm/send/abc:def',
    'https://web.push.apple.com/QGk3',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
    'https://db5p.notify.windows.com/w/?token=abc',
    'http://127.0.0.1:9/push/1',
  ]) {
    assert.deepEqual(ok(good), { endpoint: good, ...keys }, good);
  }
  for (const bad of [
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com.evil.example/x',
    'https://evilfcm.googleapis.com.example/x',
    'https://notpush.apple.com.example/x',
    'https://user:pw@fcm.googleapis.com/x',
    'https://192.168.1.1/admin',
    'http://127.0.0.1:8080/other-port',
    'http://localhost/',
    'file:///etc/passwd',
    'not a url',
    '',
  ]) {
    assert.equal(ok(bad), null, bad);
  }
  assert.equal(ok('https://fcm.googleapis.com/x', { ...keys, auth: 'short' }), null);
  assert.equal(ok('https://fcm.googleapis.com/x', { ...keys, p256dh: Buffer.alloc(65, 4).toString('base64url') }), null, 'not a point on the curve');
  assert.equal(ok('https://fcm.googleapis.com/x', {}), null);
  assert.equal(push.cleanSubscription(null), null);
  assert.equal(push.cleanSubscription('x'), null);
});
