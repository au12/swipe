// Sound effects, synthesised with Web Audio so there are no files to ship.
// Cards are filtered noise (paper has no pitch); everything that signals a
// change of fortune is a few notes.

import { store } from './util.js';

let ctx = null;
let master = null;
let noiseBuf = null;
let enabled = store.get('sound', 'on') === 'on';

export const soundOn = () => enabled;
export function setSound(on) {
  enabled = on;
  store.set('sound', on ? 'on' : 'off');
}

// Browsers only allow audio after a user gesture.
function context() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
// (Not just once: phones suspend audio when the page goes to the background,
// and only another tap can wake it.)
window.addEventListener('pointerdown', () => enabled && context());
window.addEventListener('keydown', () => enabled && context());

function tone(ac, { freq, to, start = 0, dur = 0.14, type = 'sine', gain = 0.12, attack = 0.012 }) {
  const t0 = ac.currentTime + start;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

/** A burst of filtered noise: the sound of paper, air and felt. */
function hiss(ac, { start = 0, dur = 0.06, freq = 2400, to, q = 0.9, gain = 0.2, type = 'bandpass', attack = 0.004 }) {
  const t0 = ac.currentTime + start;
  const src = ac.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const filter = ac.createBiquadFilter();
  filter.type = type;
  filter.Q.value = q;
  filter.frequency.setValueAtTime(freq, t0);
  if (to) filter.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter).connect(g).connect(master);
  src.start(t0, Math.random() * 0.9);
  src.stop(t0 + dur + 0.03);
}

const slap = (ac, start = 0, weight = 1) => {
  hiss(ac, { start, dur: 0.05, freq: 2600, q: 0.7, gain: 0.22 * weight });
  tone(ac, { start, freq: 150, to: 70, dur: 0.07, gain: 0.16 * weight, attack: 0.003 });
};

const SOUNDS = {
  // A card landing on the pile. `n` cards land one after another.
  card: (ac, n = 1) => {
    for (let i = 0; i < n; i++) slap(ac, i * 0.07, 1 - i * 0.08);
  },
  // A card sliding off the deck to a player.
  deal: (ac) => hiss(ac, { dur: 0.09, freq: 4200, to: 1500, q: 1.4, gain: 0.11 }),
  // Cards being pushed around a table in a heap.
  wash: (ac) => {
    for (let i = 0; i < 9; i++) {
      hiss(ac, { start: i * 0.085 + Math.random() * 0.03, dur: 0.12 + Math.random() * 0.08, freq: 900 + Math.random() * 1600, to: 1800 + Math.random() * 1500, q: 0.6, gain: 0.05 + Math.random() * 0.05, attack: 0.03 });
    }
  },
  // Squaring the deck up: a fast run of little clicks.
  riffle: (ac) => {
    let t = 0;
    for (let i = 0; i < 22; i++) {
      hiss(ac, { start: t, dur: 0.018, freq: 3200 + i * 60, q: 2, gain: 0.1 });
      t += 0.022 - i * 0.0006;
    }
    slap(ac, t + 0.05, 0.9);
  },
  pick: (ac) => tone(ac, { freq: 720, to: 980, dur: 0.05, type: 'triangle', gain: 0.07 }),
  unpick: (ac) => tone(ac, { freq: 760, to: 520, dur: 0.05, type: 'triangle', gain: 0.06 }),
  // The pile being swept off the table.
  swipe: (ac) => {
    hiss(ac, { dur: 0.42, freq: 500, to: 6500, q: 1.1, gain: 0.3, attack: 0.05 });
    hiss(ac, { start: 0.05, dur: 0.3, freq: 2400, to: 300, q: 0.5, gain: 0.12, attack: 0.08, type: 'lowpass' });
    [1319, 1568, 2093, 2637].forEach((f, i) => tone(ac, { freq: f, start: 0.16 + i * 0.055, dur: 0.22, type: 'triangle', gain: 0.07 }));
  },
  // Scooping the pile into your hand.
  pickup: (ac) => {
    for (let i = 0; i < 6; i++) hiss(ac, { start: i * 0.045, dur: 0.07, freq: 1500 + i * 180, q: 0.8, gain: 0.13 });
    tone(ac, { freq: 330, to: 165, dur: 0.34, type: 'triangle', gain: 0.11 });
    tone(ac, { freq: 247, to: 123, start: 0.1, dur: 0.36, type: 'sine', gain: 0.09 });
  },
  flip: (ac) => {
    hiss(ac, { dur: 0.07, freq: 1800, to: 4200, q: 1.2, gain: 0.16 });
    tone(ac, { freq: 392, start: 0.02, dur: 0.07, type: 'triangle', gain: 0.06 });
  },
  good: (ac) => {
    tone(ac, { freq: 659, dur: 0.1, type: 'triangle' });
    tone(ac, { freq: 988, start: 0.09, dur: 0.22, type: 'triangle' });
  },
  bad: (ac) => {
    tone(ac, { freq: 233, to: 196, dur: 0.2, type: 'sawtooth', gain: 0.06 });
    tone(ac, { freq: 175, to: 131, start: 0.16, dur: 0.3, type: 'sawtooth', gain: 0.06 });
  },
  turn: (ac) => {
    tone(ac, { freq: 587, dur: 0.16, type: 'sine', gain: 0.11 });
    tone(ac, { freq: 880, start: 0.11, dur: 0.3, type: 'sine', gain: 0.11 });
  },
  join: (ac) => tone(ac, { freq: 520, to: 780, dur: 0.12, type: 'sine', gain: 0.08 }),
  tick: (ac) => tone(ac, { freq: 1000, dur: 0.04, type: 'square', gain: 0.04 }),
  error: (ac) => tone(ac, { freq: 140, dur: 0.16, type: 'square', gain: 0.05 }),
  win: (ac) => {
    [523, 659, 784, 1047, 1319].forEach((f, i) => tone(ac, { freq: f, start: i * 0.1, dur: 0.3, type: 'triangle', gain: 0.11 }));
    tone(ac, { freq: 1047, start: 0.55, dur: 0.6, type: 'sine', gain: 0.08 });
    tone(ac, { freq: 1568, start: 0.55, dur: 0.6, type: 'sine', gain: 0.06 });
  },
  lose: (ac) => [392, 349, 294, 262].forEach((f, i) => tone(ac, { freq: f, start: i * 0.15, dur: 0.32, type: 'sine', gain: 0.1 })),
  // A score ticking up on the results board.
  count: (ac) => tone(ac, { freq: 1400, dur: 0.025, type: 'square', gain: 0.025 }),
};

export function play(name, arg) {
  if (!enabled) return;
  const ac = context();
  if (!ac || ac.state !== 'running') return;
  try {
    SOUNDS[name]?.(ac, arg);
  } catch {}
}

/** A short buzz on phones that support it. */
export function buzz(pattern) {
  if (!enabled) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {}
}
