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
 * The shuffle, done the way a casino dealer does it, and big enough to fill
 * the screen:
 *
 *   burst    the deck drops in the middle of the screen and scatters
 *   wash     every card swirls through a figure of eight, the way two hands
 *            stir a heap, while a few get flicked up toward you
 *   gather   the heap is pulled back into one stack
 *   riffle   the stack is cut into its red and its blue cards, and the two
 *            halves are riffled together and squared up with a bridge
 *   carry    the shuffled deck slides to where the pile lives, ready to deal
 *
 * `mid` is the centre of the show, `home` the rect the deck ends up in, and
 * `k` squeezes the whole thing in time (for someone who arrived late).
 * Resolves, once the deck is home, with a function that clears it away.
 */
export async function wash({ mid, home, decks = 2, k = 1 }) {
  const host = layer();
  const scene = document.createElement('div');
  scene.className = 'wash';
  scene.innerHTML = '<div class="wash-dim"></div><div class="wash-ring"></div><div class="wash-cards"></div>';
  host.append(scene);
  const [dim, ring, deck] = scene.children;

  const n = Math.max(44, Math.min(72, decks * 26));
  const w = home.w;
  const h = home.h;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const portrait = vh > vw * 1.15;
  const big = Math.min(1.3, Math.max(1, (vw * 0.2) / w)); // cards are a little larger while they are in play
  // How far the heap reaches. On a phone the figure of eight stands upright to use the height.
  const reachX = Math.max(w * 1.2, Math.min(vw * 0.5 - w * 0.7 * big, w * 5.2));
  const reachY = Math.max(w * 1.4, Math.min(vh * 0.47 - h * 0.68 * big, w * (portrait ? 5.2 : 3.4)));
  const left = mid.x - w / 2;
  const top = mid.y - h / 2;
  const dx = home.x - left;
  const dy = home.y - top;
  const rnd = seeded(`wash${Date.now()}`);

  // The timeline, in milliseconds at full speed.
  const BURST = 430;
  const WASH_END = 3050;
  const GATHERED = 3460;
  const CUT = 3740;
  const RIFFLE = 3900;
  const RIFFLE_SPAN = 640;
  const DROP = 170;
  const BRIDGE = RIFFLE + RIFFLE_SPAN + DROP; // 4710
  const CARRY = 4960;
  const TOTAL = 5320;
  const at = (t) => Math.min(1, Math.max(0, t / TOTAL));
  const tf = (x, y, rot, scale) => `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) rotate(${rot.toFixed(1)}deg) scale(${scale.toFixed(3)})`;

  deck.style.transformOrigin = `${mid.x}px ${mid.y}px`;
  const cards = [];
  for (let i = 0; i < n; i++) {
    const el = document.createElement('div');
    el.className = 'ghost wash-card';
    el.style.cssText = `left:${left}px;top:${top}px;width:${w}px;height:${h}px;--cw:${w}px`;
    el.innerHTML = backHTML(i % 2);
    deck.append(el);
    cards.push(el);

    const side = i % 2 ? 1 : -1; // red backs cut to the left, blue to the right
    const lift = -i * 0.3; // each card a hair above the last
    const frames = [{ transform: tf(0, lift - 40, 0, big * 1.25), offset: 0, easing: 'cubic-bezier(.15,.85,.3,1.2)' }];

    // Burst: out to a ring, spinning.
    const a0 = (Math.PI * 2 * i) / n + (rnd() - 0.5) * 0.9;
    const r0 = 0.5 + rnd() * 0.5;
    let rot = (rnd() - 0.5) * 540;
    frames.push({ transform: tf(Math.cos(a0) * reachX * r0, Math.sin(a0) * reachY * r0, rot, big), offset: at(BURST * (0.82 + rnd() * 0.18)), easing: 'ease-in-out' });

    // Wash: a figure of eight, each card on its own size of loop and at its own pace.
    const phase = rnd() * Math.PI * 2;
    const turns = (rnd() < 0.5 ? -1 : 1) * (1.15 + rnd() * 0.9);
    const m = 0.3 + rnd() * 0.7;
    const spin = (rnd() - 0.5) * 1300;
    const tossed = i % 9 === 4 ? 2 + Math.floor(rnd() * 9) : -1; // a few cards get flicked up at you
    const STEPS = 12;
    for (let s = 1; s <= STEPS; s++) {
      const tau = s / (STEPS + 1);
      const u = phase + turns * Math.PI * 2 * tau;
      const eightA = Math.cos(u) * m;
      const eightB = Math.sin(2 * u) * m;
      const x = (portrait ? eightB : eightA) * reachX + (rnd() - 0.5) * w * 0.3;
      const y = (portrait ? eightA : eightB) * reachY + (rnd() - 0.5) * w * 0.3;
      rot = spin * tau + (rnd() - 0.5) * 60;
      const up = s === tossed;
      frames.push({ transform: tf(x, y, up ? rot + 360 : rot, up ? big * 1.75 : big), offset: at(BURST + tau * (WASH_END - BURST)), easing: 'ease-in-out' });
    }

    // Gather into one stack.
    frames.push({ transform: tf(0, lift, side * 3, big), offset: at(GATHERED - (1 - i / n) * 110), easing: 'cubic-bezier(.3,0,.2,1)' });
    frames.push({ transform: tf(0, lift, side * 3, big), offset: at(GATHERED + 70), easing: 'cubic-bezier(.3,0,.2,1)' });
    // Cut: reds to one side, blues to the other, each packet fanned a little
    // and leaning in, far enough apart that the middle is clear.
    const inPacket = Math.floor(i / 2);
    const cut = tf(side * (w * 1.06 * big + inPacket * 0.85), -inPacket * 0.45, -side * 11, big);
    frames.push({ transform: cut, offset: at(CUT), easing: 'linear' });
    // Riffle: the packets let go one card at a time, alternating.
    const t0 = RIFFLE + (i / n) * RIFFLE_SPAN;
    frames.push({ transform: cut, offset: at(t0), easing: 'cubic-bezier(.4,0,.8,.6)' });
    const square = (i % 2 ? 0.7 : -0.7);
    frames.push({ transform: tf(0, lift, square, big), offset: at(t0 + DROP), easing: 'linear' });
    // Carry the deck home.
    frames.push({ transform: tf(0, lift, square, big), offset: at(CARRY), easing: 'cubic-bezier(.5,0,.2,1)' });
    frames.push({ transform: tf(dx, dy + lift, square, 1), offset: 1 });
    el.animate(frames, { duration: TOTAL * k, fill: 'both' });
  }

  // The whole heap breathes and rocks as it is pushed about, then gets squared up with a bridge.
  deck.animate(
    [
      { transform: 'rotate(0deg) scale(1)', offset: 0 },
      { transform: 'rotate(0deg) scale(1)', offset: at(BURST), easing: 'ease-in-out' },
      { transform: 'rotate(-7deg) scale(1.07)', offset: at(1050), easing: 'ease-in-out' },
      { transform: 'rotate(6deg) scale(0.94)', offset: at(1700), easing: 'ease-in-out' },
      { transform: 'rotate(-5deg) scale(1.06)', offset: at(2350), easing: 'ease-in-out' },
      { transform: 'rotate(0deg) scale(1)', offset: at(WASH_END) },
      { transform: 'rotate(0deg) scale(1)', offset: at(BRIDGE), easing: 'ease-out' },
      { transform: 'rotate(0deg) scale(1.12,0.84)', offset: at(BRIDGE + 85), easing: 'ease-in-out' },
      { transform: 'rotate(0deg) scale(0.95,1.07)', offset: at(BRIDGE + 170), easing: 'ease-out' },
      { transform: 'rotate(0deg) scale(1)', offset: at(CARRY) },
      { transform: 'rotate(0deg) scale(1)', offset: 1 },
    ],
    { duration: TOTAL * k, fill: 'both' },
  );
  // The room dims for the show and comes back as the deck is carried home.
  dim.animate([{ opacity: 0 }, { opacity: 1, offset: at(260) }, { opacity: 1, offset: at(CARRY - 120) }, { opacity: 0 }], { duration: TOTAL * k, fill: 'both' });
  ring.style.cssText = `left:${mid.x}px;top:${mid.y}px;width:${w * 2}px;height:${w * 2}px`;
  ring.animate(
    [
      { transform: 'translate(-50%,-50%) scale(0.2)', opacity: 0.85 },
      { transform: `translate(-50%,-50%) scale(${(Math.max(reachX, reachY) / w) * 1.5})`, opacity: 0 },
    ],
    { duration: 620 * k, delay: 60 * k, easing: 'cubic-bezier(.1,.7,.2,1)', fill: 'both' },
  );

  if (k > 0.5) {
    const cue = (t, name, arg) => setTimeout(() => sfx(name, arg), t * k);
    cue(0, 'burst');
    for (const t of [470, 1050, 1650, 2250]) cue(t, 'wash');
    cue(WASH_END, 'gather');
    cue(RIFFLE, 'riffle', RIFFLE_SPAN * k);
    cue(BRIDGE + 60, 'bridge');
    cue(CARRY, 'deal');
  }
  await sleep(TOTAL * k);

  return async () => {
    await Promise.all(
      cards.map((el, i) =>
        el
          .animate([{ opacity: 1, translate: '0px 0px' }, { opacity: 0, translate: `0px ${-w * 0.5}px` }], { duration: 240 * k, delay: (n - i) * 3 * k, fill: 'forwards' })
          .finished.catch(() => {}),
      ),
    );
    scene.remove();
  };
}

/** Removes anything still in the air (used when catching up after a tab was in the background). */
export function clearAll() {
  layer().replaceChildren();
}
