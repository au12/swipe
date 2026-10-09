// What a browser does with a push message, for the tests: makes the keys a
// subscription carries, and opens a message with them (RFC 8291, receiving end).

import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';

/** A browser's side of a subscription: its key pair and its secret. */
export function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    privateKey: ecdh.getPrivateKey(),
    auth,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
  };
}

export function decrypt(body, uaPrivate, authSecret) {
  const salt = body.subarray(0, 16);
  const idLen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idLen);
  const data = body.subarray(21 + idLen);
  const ua = createECDH('prime256v1');
  ua.setPrivateKey(uaPrivate);
  const shared = ua.computeSecret(asPublic);
  const hk = (ikm, s, info, n) => Buffer.from(hkdfSync('sha256', ikm, s, info, n));
  const ikm = hk(shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32);
  const key = hk(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hk(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = createDecipheriv('aes-128-gcm', key, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  if (plain.at(-1) !== 2) throw new Error('missing last-record marker');
  return plain.subarray(0, plain.length - 1);
}

/** Checks a "vapid t=…, k=…" Authorization header. Returns the token's claims, or throws. */
export function checkVapid(header, expectedKey) {
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header ?? '');
  if (!m) throw new Error(`not a VAPID header: ${header}`);
  const [, head, claims, sig, k] = m;
  if (expectedKey && k !== expectedKey) throw new Error('signed with a different key');
  const pub = Buffer.from(k, 'base64url');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  if (!verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))) throw new Error('bad signature');
  return JSON.parse(Buffer.from(claims, 'base64url'));
}
