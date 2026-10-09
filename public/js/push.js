// Turn notifications, from the browser's side: the service worker, the
// permission, and the "subscription" that is handed to the game server so it
// can reach this browser when the page is closed or the phone is locked.

import { store } from './util.js';

let key = null; // the server's public key; a subscription is tied to it
let registration = null;

/** True when Swipe is running as an installed app rather than in a browser tab. */
export const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export async function init(pushKey) {
  key = pushKey || null;
  if (!('serviceWorker' in navigator)) return;
  try {
    registration = await navigator.serviceWorker.register('sw.js');
  } catch {
    registration = null;
  }
}

/**
 * What this browser can do:
 *   'ok'       notifications can be turned on here
 *   'install'  an iPhone or iPad in a Safari tab: they work once Swipe is on the Home Screen
 *   'none'     this browser cannot show them
 *   'off'      the server has them switched off
 */
export function support() {
  if (!key) return 'off';
  if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) return 'ok';
  if (isIOS() && !standalone()) return 'install';
  return 'none';
}

export const blocked = () => 'Notification' in window && Notification.permission === 'denied';

/** Whether this browser has been asked to notify (the server has the last word: it may have lost the subscription). */
export const wanted = () => store.get('push') === 'on';

const toBytes = (b64u) => Uint8Array.from(atob(b64u.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const toB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function ready() {
  if (registration) return registration;
  if (!('serviceWorker' in navigator)) return null;
  return Promise.race([navigator.serviceWorker.ready, new Promise((resolve) => setTimeout(() => resolve(null), 4000))]);
}

/** A subscription made for a different server key is no use: the push service would refuse our messages. */
function forThisServer(sub) {
  const theirs = sub.options && sub.options.applicationServerKey;
  return !theirs || toB64u(theirs) === key;
}

async function subscribe(reg) {
  let sub = await reg.pushManager.getSubscription();
  if (sub && !forThisServer(sub)) {
    await sub.unsubscribe();
    sub = null;
  }
  return sub ?? reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(key) });
}

/**
 * Asks for permission and subscribes. Has to be called from a tap. Resolves
 * with the subscription to send to the server; rejects with a message for the player.
 */
export async function enable() {
  if (support() !== 'ok') throw new Error('This browser can’t show notifications.');
  // The permission question comes first, before anything is waited for: some
  // browsers (Safari above all) only allow it while the tap is still fresh.
  const asked = new Promise((resolve) => {
    const result = Notification.requestPermission(resolve); // old Safari answers through the callback
    if (result && typeof result.then === 'function') result.then(resolve, () => resolve('default'));
  });
  const answer = await asked;
  const reg = await ready();
  if (!reg) throw new Error('This browser can’t show notifications.');
  if (answer === 'denied') throw new Error('Notifications are blocked for this site. Allow them in your browser’s settings, then try again.');
  if (answer !== 'granted') throw new Error('Notifications weren’t allowed, so they stay off.');
  let sub;
  try {
    sub = await subscribe(reg);
  } catch {
    throw new Error('The browser’s notification service couldn’t be reached. Check your connection and try again.');
  }
  store.set('push', 'on');
  return sub.toJSON();
}

export async function disable() {
  store.set('push', 'off');
  try {
    const reg = await ready();
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
  } catch {}
}

/**
 * On joining a room: if notifications are on in this browser, the subscription
 * to hand to this room's server (asked for again if the old one has lapsed).
 * No prompt is ever shown from here.
 */
export async function resume() {
  if (support() !== 'ok' || !wanted() || Notification.permission !== 'granted') return null;
  try {
    const reg = await ready();
    return reg ? (await subscribe(reg)).toJSON() : null;
  } catch {
    return null;
  }
}

/** You are looking at the game now: take its notification off the screen. */
export async function clearShown(tag) {
  try {
    const reg = await ready();
    const shown = (await reg?.getNotifications?.({ tag })) ?? [];
    for (const n of shown) n.close();
  } catch {}
}

// Browsers that can install the site as an app say so with this event; keeping
// it lets Room settings offer an "Install" button.
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  window.dispatchEvent(new Event('swipe:installable'));
});
window.addEventListener('appinstalled', () => (installPrompt = null));
export const canInstall = () => Boolean(installPrompt) && !standalone();
export async function install() {
  if (!installPrompt) return false;
  const prompt = installPrompt;
  installPrompt = null;
  prompt.prompt();
  const choice = await prompt.userChoice.catch(() => null);
  return choice?.outcome === 'accepted';
}
