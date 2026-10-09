// Small helpers shared by the client modules.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

export const store = {
  get(key, fallback = null) {
    try {
      return localStorage.getItem(`sw.${key}`) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`sw.${key}`, value);
    } catch {}
  },
};

const stroke = (d, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
const solid = (d) => `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${d}</svg>`;

export const ICONS = {
  copy: stroke('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>'),
  check: stroke('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  help: stroke('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.6 2.3c-.8.5-1.2 1-1.2 2"/><path d="M12 17v.01"/>'),
  gear: stroke('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  soundOn: stroke('<path d="M4 10v4h3l5 4V6L7 10H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>'),
  soundOff: stroke('<path d="M4 10v4h3l5 4V6L7 10H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
  sun: stroke('<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>'),
  moon: stroke('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'),
  close: stroke('<path d="M6 6l12 12M18 6L6 18"/>'),
  crown: solid('<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-1.8 10H4.8L3 8z"/>'),
  pause: solid('<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>'),
  play: solid('<path d="M7 5l12 7-12 7V5z"/>'),
  lock: stroke('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  bot: stroke('<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 8V4M9.5 13v1.5M14.5 13v1.5"/><circle cx="12" cy="3.5" r="1" fill="currentColor"/>'),
  swap: stroke('<path d="M7 7h12l-3-3M17 17H5l3 3"/>'),
  list: stroke('<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>'),
  plus: stroke('<path d="M12 5v14M5 12h14"/>'),
  eye: stroke('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>'),
  offline: stroke('<path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 4-2.6M19 13a10 10 0 0 0-5-2.9M2 9.5a15 15 0 0 1 4-2.8M22 9.5A15 15 0 0 0 10.5 5.1"/><path d="M12 20v.01"/>'),
  bell: stroke('<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>'),
  dice: stroke('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9v.01M15 15v.01M15 9v.01M9 15v.01M12 12v.01"/>'),
};

export const icon = (name) => ICONS[name] ?? '';

/** "Ana Maria" -> "AM", "bo" -> "BO" */
export function initials(name) {
  const parts = String(name).trim().split(/\s+/);
  const text = parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2);
  return text.toUpperCase();
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Ana" -> "Ana’s", "Jess" -> "Jess’s" */
export const possessive = (name) => `${name}’s`;

export function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Ink for text sitting on a player's colour: dark on light colours, white on the rest. */
export function onColor(hex) {
  const n = Number.parseInt(String(hex).slice(1), 16);
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return lum > 0.27 ? '#17130f' : '#ffffff';
}

/** A small repeatable random source: the same seed always gives the same numbers. */
export function seeded(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const toastTimer = new Map();
export function toast(message, { error = false } = {}) {
  const host = $('#toasts');
  // Don't stack identical messages.
  for (const el of host.children) if (el.textContent === message) el.remove();
  const el = document.createElement('div');
  el.className = `toast${error ? ' is-error' : ''}`;
  el.textContent = message;
  host.append(el);
  toastTimer.set(
    el,
    setTimeout(() => el.remove(), error ? 5000 : 2600),
  );
  while (host.children.length > 3) host.firstElementChild.remove();
}
