// Motion. Cards that travel are "ghosts": copies drawn in a fixed layer above
// the page, flown from where a card was to where it is going, and removed
// when the real card appears underneath. Nothing here knows the rules.

import { $, reducedMotion, seeded, sleep } from './util.js';
import { backHTML } from './cards.js';
import { play as sfx } from './sound.js';

const layer = () => $('#fx');
const speed = () => (reducedMotion() ? 0.001 : 1);
const EASE_OUT = 'cubic-bezier(.2,.8,.25,1)';
const EASE_IN = 'cubic-bezier(.55,0,.9,.45)';

export function rectOf(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** A card-shaped rect of the given width, centred on another rect. */
export function cardRectAt(rect, w) {
  const h = w * 1.4;
  return { x: rect.x + rect.w / 2 - w / 2, y: rect.y + rect.h / 2 - h / 2, w, h };
}

/** Puts card markup in the effects layer, exactly over `rect`. */
export function ghost(html, rect) {
  const wrap = document.createElement('div');
  wrap.className = 'ghost';
  wrap.style.cssText = `left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px;--cw:${rect.w}px`;
  wrap.innerHTML = html;
  layer().append(wrap);
  return wrap;
}

/**
 * Flies a ghost from `from` to `to` (both rects; `to.rot` is the resting
 * angle). `lift` arcs it toward the viewer on the way. With `flip`, a
 * two-sided ghost turns face up in mid-air.
 */
export function fly(el, from, to, { duration = 340, delay = 0, rot0 = 0, lift = 0, flip = false, fade = false, easing = EASE_OUT } = {}) {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2);
  const dy = to.y + to.h / 2 - (from.y + from.h / 2);
  const s = to.w / from.w;
  const rot1 = to.rot ?? 0;
  const frames = [{ transform: `translate(0px,0px) rotate(${rot0}deg) scale(1)`, opacity: 1 }];
  if (lift) frames.push({ transform: `translate(${dx * 0.5}px,${dy * 0.5 - lift}px) rotate(${(rot0 + rot1) / 2}deg) scale(${((1 + s) / 2) * 1.1})`, opacity: 1, offset: 0.5 });
  frames.push({ transform: `translate(${dx}px,${dy}px) rotate(${rot1}deg) scale(${s})`, opacity: fade ? 0 : 1 });
  const opts = { duration: duration * speed(), delay: delay * speed(), easing, fill: 'both' };
  if (flip) {
    el.querySelector('.flip-in')?.animate([{ transform: 'rotateY(180deg)' }, { transform: 'rotateY(0deg)' }], { ...opts, easing: 'ease-in-out' });
  }
  return el.animate(frames, opts).finished.catch(() => {});
}

/** Turns a two-sided ghost over where it lies, lifting it a little as it goes. */
export function flipInPlace(el, { duration = 460 } = {}) {
  const opts = { duration: duration * speed(), easing: 'ease-in-out', fill: 'both' };
  el.querySelector('.flip-in')?.animate([{ transform: 'rotateY(180deg)' }, { transform: 'rotateY(0deg)' }], opts);
  return el
    .animate([{ transform: 'scale(1)' }, { transform: 'scale(1.22) translateY(-8%)', offset: 0.5 }, { transform: 'scale(1)' }], opts)
    .finished.catch(() => {});
}

// The pile's own cards are moved with the individual `translate`, `rotate`
// and `scale` properties, which stack on top of the transform that scatters
// them, so nothing has to be recomputed.

/** The swipe: every card in the pile is swept off one side of the screen. */
export function sweepOff(cards, dir = 1) {
  const far = window.innerWidth * 0.75 + 200;
  const list = cards.slice().reverse(); // top card leaves first
  return Promise.all(
    list.map((el, i) => {
      const rnd = seeded(`sweep${i}${cards.length}`);
      return el
        .animate(
          [
            { translate: '0px 0px', rotate: '0deg' },
            { translate: `${dir * far}px ${(rnd() - 0.6) * 160}px`, rotate: `${dir * (160 + rnd() * 380)}deg` },
          ],
          { duration: (430 + rnd() * 160) * speed(), delay: Math.min(i * 16, 220) * speed(), easing: EASE_IN, fill: 'both' },
        )
        .finished.catch(() => {});
    }),
  );
}

/** Picking up: the pile's cards are gathered into `to` (a hand, or a seat chip). */
export function gatherTo(cards, to) {
  const list = cards.slice().reverse();
  return Promise.all(
    list.map((el, i) => {
      const from = rectOf(el);
      const dx = to.x + to.w / 2 - (from.x + from.w / 2);
      const dy = to.y + to.h / 2 - (from.y + from.h / 2);
      return el
        .animate(
          [
            { translate: '0px 0px', scale: '1', opacity: 1 },
            { translate: `${dx * 0.9}px ${dy * 0.9}px`, scale: '0.6', opacity: 1, offset: 0.85 },
            { translate: `${dx}px ${dy}px`, scale: '0.45', opacity: 0 },
          ],
          { duration: 420 * speed(), delay: Math.min(i * 22, 260) * speed(), easing: 'cubic-bezier(.5,0,.3,1)', fill: 'both' },
        )
        .finished.catch(() => {});
    }),
  );
}

/** A short label that floats up from a spot and fades: "+14". */
export function floatLabel(text, at, color) {
  const el = document.createElement('div');
  el.className = 'float-label';
  el.textContent = text;
  el.style.cssText = `left:${at.x + at.w / 2}px;top:${at.y + at.h / 2}px;--p:${color}`;
  layer().append(el);
  el.animate(
    [
      { transform: 'translate(-50%,-50%) scale(.6)', opacity: 0 },
      { transform: 'translate(-50%,-90%) scale(1.15)', opacity: 1, offset: 0.2 },
      { transform: 'translate(-50%,-150%) scale(1)', opacity: 1, offset: 0.75 },
      { transform: 'translate(-50%,-200%) scale(1)', opacity: 0 },
    ],
    { duration: 1300 * Math.max(speed(), 0.4), easing: 'ease-out', fill: 'both' },
  ).finished.then(() => el.remove(), () => el.remove());
}

/**
 * The big moment: a band in the player's colour tears across the screen
 * with the word on it, then follows the pile off the table.
 */
export function callout(text, { color, on = '#fff', sub = '', hold = 620 } = {}) {
  const el = document.createElement('div');
  el.className = 'callout';
  el.style.cssText = `--p:${color};--on-p:${on}`;
  el.innerHTML = `<div class="callout-band"><b>${text}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
  layer().append(el);
  const band = el.firstElementChild;
  const k = Math.max(speed(), 0.3);
  const total = 260 + hold + 300;
  const done = band
    .animate(
      [
        { transform: 'translateX(-110%) skewX(-14deg)', offset: 0 },
        { transform: 'translateX(0%) skewX(-14deg)', offset: 260 / total, easing: 'cubic-bezier(.1,.9,.2,1)' },
        { transform: 'translateX(3%) skewX(-14deg)', offset: (260 + hold) / total, easing: EASE_IN },
        { transform: 'translateX(120%) skewX(-14deg)', offset: 1 },
      ],
      { duration: total * k, fill: 'both' },
    )
    .finished.catch(() => {});
  done.then(() => el.remove());
  return done;
}

const SUIT_GLYPHS = ['♠', '♥', '♦', '♣'];
/** Suits raining down in the given colours. */
export function confetti(colors, { count = 70 } = {}) {
  if (reducedMotion()) return;
  const host = layer();
  const w = window.innerWidth;
  const h = window.innerHeight;
  for (let i = 0; i < count; i++) {
    const el = document.createElement('i');
    el.className = 'confetto';
    el.textContent = SUIT_GLYPHS[i % 4];
    const size = 14 + Math.random() * 22;
    el.style.cssText = `left:${Math.random() * w}px;top:-40px;font-size:${size}px;color:${colors[i % colors.length]}`;
    host.append(el);
    const drift = (Math.random() - 0.5) * 260;
    el.animate(
      [
        { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
        { transform: `translate(${drift * 0.6}px,${h * 0.6}px) rotate(${(Math.random() - 0.5) * 540}deg)`, opacity: 1, offset: 0.7 },
        { transform: `translate(${drift}px,${h + 80}px) rotate(${(Math.random() - 0.5) * 900}deg)`, opacity: 0.6 },
      ],
      { duration: 1900 + Math.random() * 1700, delay: Math.random() * 700, easing: 'cubic-bezier(.3,.2,.6,1)', fill: 'both' },
    ).finished.then(() => el.remove(), () => el.remove());
  }
}

/** Numbers that tick up from `data-from` to `data-to`. */
export function countUp(elements, { duration = 900, delay = 0 } = {}) {
  if (reducedMotion()) return;
  for (const el of elements) {
    const from = Number(el.dataset.from);
    const to = Number(el.dataset.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) continue;
    el.textContent = from;
    const start = performance.now() + delay;
    let last = from;
    const tick = (t) => {
      const k = Math.min(1, Math.max(0, (t - start) / duration));
      const value = Math.round(from + (to - from) * (1 - (1 - k) ** 3));
      if (value !== last) {
        el.textContent = value;
        last = value;
        if (value % 3 === 0 || value === to) sfx('count');
      }
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

/**
 * The wash: a heap of red- and blue-backed cards pushed around the table the
 * way a dealer mixes them, then squared up into one stack. Resolves with the
 * stack's rect and a function that clears it away.
 */
export async function wash({ center, cw, duration = 2600, count = 30 }) {
  const k = speed();
  const host = layer();
  const scene = document.createElement('div');
  scene.className = 'wash';
  host.append(scene);
  const spreadX = Math.min(window.innerWidth * 0.36, cw * 3.4);
  const spreadY = Math.min(window.innerHeight * 0.17, cw * 2.1);
  const home = { x: center.x - cw / 2, y: center.y - cw * 0.7, w: cw, h: cw * 1.4 };
  const rnd = seeded(`wash${Date.now()}`);
  const cards = [];

  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'ghost wash-card';
    el.style.cssText = `left:${home.x}px;top:${home.y}px;width:${home.w}px;height:${home.h}px;--cw:${cw}px`;
    el.innerHTML = backHTML(i % 2);
    scene.append(el);
    cards.push(el);

    // Each card wanders round the heap on its own loop: an ellipse with a
    // wobble, so the whole thing reads as two hands stirring.
    const phase = rnd() * Math.PI * 2;
    const turns = (rnd() < 0.5 ? -1 : 1) * (0.9 + rnd() * 0.9);
    const reach = 0.35 + rnd() * 0.65;
    const spin = (rnd() - 0.5) * 900;
    const steps = 9;
    const frames = [{ transform: 'translate(0px,0px) rotate(0deg)', offset: 0, easing: 'ease-out' }];
    for (let s = 1; s <= steps; s++) {
      const t = s / (steps + 1);
      const a = phase + turns * Math.PI * 2 * t;
      const wobble = 1 + 0.25 * Math.sin(a * 3 + i);
      frames.push({
        transform: `translate(${Math.cos(a) * spreadX * reach * wobble}px,${Math.sin(a) * spreadY * reach * wobble}px) rotate(${(spin * t + (rnd() - 0.5) * 50).toFixed(0)}deg)`,
        offset: 0.08 + t * 0.78,
        easing: 'ease-in-out',
      });
    }
    // Squared up: a neat stack, each card a hair above the last.
    frames.push({ transform: `translate(0px,${-i * 0.35}px) rotate(${i % 2 ? 0.6 : -0.6}deg)`, offset: 1 });
    el.animate(frames, { duration: duration * k, fill: 'both' });
  }

  if (k === 1) {
    sfx('wash');
    setTimeout(() => sfx('wash'), duration * 0.3);
    setTimeout(() => sfx('wash'), duration * 0.58);
    setTimeout(() => sfx('riffle'), duration * 0.86);
  }
  await sleep(duration * k);
  return {
    home,
    scene,
    /** The stack is carried off the table. */
    clear: async () => {
      await Promise.all(
        cards.map(
          (el, i) =>
            el.animate([{ opacity: 1, translate: '0px 0px' }, { opacity: 0, translate: `0px ${-cw * 0.5}px` }], { duration: 260 * k, delay: (count - i) * 4 * k, fill: 'forwards' })
              .finished.catch(() => {}),
        ),
      );
      scene.remove();
    },
  };
}

/** Removes anything still in the air (used when catching up after a tab was in the background). */
export function clearAll() {
  layer().replaceChildren();
}
