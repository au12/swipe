// Web Push, by hand: no dependency, just node:crypto and fetch.
//
// A browser that turns notifications on gives us a "subscription": a URL at
// its vendor's push service (Apple, Google, Mozilla, Microsoft) and two keys.
// To notify it we POST an encrypted message to that URL. The push service
// only relays it; it cannot read it. Two standards do the work:
//
//   RFC 8291 / 8188  the message is encrypted to the browser's keys (aes128gcm)
//   RFC 8292 (VAPID) the request is signed with this server's own key pair, so
//                    the push service knows every message comes from one sender
//
// The key pair is made once and kept in the data folder. If it is ever lost,
// every browser has to turn notifications on again.

import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto';
import { config, log } from './config.js';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (text) => Buffer.from(String(text), 'base64url');

// ───────────────────────── this server's identity ─────────────────────────

let vapid = null; // { publicKey, privateKey } as base64url; the public half is an uncompressed P-256 point

function newKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function validKeys(k) {
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(fromB64u(k.privateKey));
    return b64u(ecdh.getPublicKey()) === k.publicKey;
  } catch {
    return false;
  }
}

/** Loads the key pair (environment first, then the data folder), making one on first run. */
export function loadKeys() {
  if (!config.push) return null;
  if (vapid) return vapid;
  const env = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  if (env.publicKey && env.privateKey) {
    if (validKeys(env)) return (vapid = env);
    log.warn('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY do not belong together; ignoring them.');
  }
  const file = path.join(config.dataDir, 'vapid.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (validKeys(saved)) return (vapid = { publicKey: saved.publicKey, privateKey: saved.privateKey });
    log.warn(`${file} is damaged; making a new key pair. Everyone will have to turn notifications on again.`);
  } catch {}
  vapid = newKeys();
  if (config.persist) {
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ ...vapid, createdAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
      log.info(`Made a key pair for turn notifications: ${file}`);
    } catch (err) {
      log.warn(`Could not save ${file} (${err.message}). Notifications will stop working after a restart.`);
    }
  }
  return vapid;
}

export const publicKey = () => loadKeys()?.publicKey ?? null;

/** For tests: use this key pair instead of the saved one. */
export function useKeys(keys) {
  vapid = keys;
}

// ───────────────────────── subscriptions ─────────────────────────

// Only ever POST to a real push service. A subscription comes from a browser,
// so without this anyone could point the server at an address of their choosing.
const PUSH_HOSTS = ['fcm.googleapis.com', 'push.apple.com', 'push.services.mozilla.com', 'notify.windows.com'];

function allowedEndpoint(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (config.pushExtraHosts.includes(url.host)) return url.protocol === 'https:' || url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  return PUSH_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

/**
 * Checks a subscription handed over by a browser and returns the three things
 * worth keeping, or null if it is not one we can use.
 */
export function cleanSubscription(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const endpoint = String(raw.endpoint ?? '');
  const p256dh = String(raw.keys?.p256dh ?? '');
  const auth = String(raw.keys?.auth ?? '');
  if (endpoint.length > 1024 || !allowedEndpoint(endpoint)) return null;
  const point = fromB64u(p256dh);
  if (point.length !== 65 || point[0] !== 4 || fromB64u(auth).length !== 16) return null;
  try {
    const probe = createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(point); // throws unless it is a point on the curve
  } catch {
    return null;
  }
  return { endpoint, p256dh: b64u(point), auth: b64u(fromB64u(auth)) };
}

// ───────────────────────── encryption (RFC 8291) ─────────────────────────

/**
 * Encrypts `plaintext` for one subscription. `salt` and `localKey` (an ECDH
 * object) are only ever passed by tests, to reproduce the RFC's worked example.
 */
export function encrypt(plaintext, sub, { salt = randomBytes(16), localKey = null } = {}) {
  const uaPublic = fromB64u(sub.p256dh);
  const authSecret = fromB64u(sub.auth);
  const local = localKey ?? createECDH('prime256v1');
  if (!localKey) local.generateKeys();
  const asPublic = local.getPublicKey();
  const shared = local.computeSecret(uaPublic);

  const hkdf = (ikm, saltBytes, info, length) => Buffer.from(hkdfSync('sha256', ikm, saltBytes, info, length));
  const ikm = hkdf(shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const key = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = createCipheriv('aes-128-gcm', key, nonce);
  // One record; the 0x02 says it is the last.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16); // record size
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

// ───────────────────────── who is asking (RFC 8292) ─────────────────────────

/** The Authorization header for a request to `endpoint`: a short-lived signed token plus our public key. */
export function vapidHeader(endpoint, contact, at = Date.now()) {
  const keys = loadKeys();
  const pub = fromB64u(keys.publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: keys.privateKey };
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(at / 1000) + 12 * 3600, sub: contact }));
  const signature = sign('sha256', Buffer.from(`${head}.${claims}`), { key: createPrivateKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

/** Push services want to know who to contact about a misbehaving sender: a mailto: or https: address. */
export function contactFor(origin) {
  if (/^(mailto:.+@.+|https:\/\/.+)/.test(config.pushContact)) return config.pushContact;
  if (/^https:\/\/[^/]+$/.test(origin ?? '') && !/^https:\/\/(localhost|127\.)/.test(origin)) return origin;
  return 'mailto:swipe-host@example.org';
}

// ───────────────────────── sending ─────────────────────────

/**
 * Sends one notification. Resolves to 'sent', 'gone' (the browser has
 * unsubscribed: forget the subscription) or 'failed' (try again another time).
 * Never throws.
 */
export async function send(sub, payload, { ttl = 600, topic = null, origin = null } = {}) {
  if (!config.push || !sub) return 'failed';
  try {
    const body = encrypt(JSON.stringify(payload), sub);
    const headers = {
      Authorization: vapidHeader(sub.endpoint, contactFor(origin)),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl), // not delivered within this many seconds: drop it, the moment has passed
      Urgency: 'high',
    };
    if (topic) headers.Topic = topic; // a newer message on the same topic replaces an undelivered older one
    const res = await fetch(sub.endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    if (res.ok) return 'sent';
    if (res.status === 404 || res.status === 410) return 'gone';
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    log.warn(`Push service ${new URL(sub.endpoint).host} answered ${res.status}: ${detail}`);
    return 'failed';
  } catch (err) {
    log.debug(`Push failed: ${err.message}`);
    return 'failed';
  }
}
