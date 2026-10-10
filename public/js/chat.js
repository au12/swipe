// Chat: the panel beside the game, the banner that shows a new message at the
// top of the screen, and the sound that goes with it.
//
// Messages arrive on the game's own connection: everything said so far when
// the room is joined ({ all }), then one at a time ({ m }).

import { $, $$, esc, initials, onColor } from './util.js';
import { play as sfx } from './sound.js';

let list = []; // { id, by, name, color, text, at }
let you = null; // this player's id, once known
let sendMessage = () => false;
let bannerTimer = null;

const hex = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#888888');
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/** `send(text)` puts a message on the wire; it returns false if there is no connection to put it on. */
export function init({ send }) {
  sendMessage = send;
  $('#chat-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#chat-input');
    const body = input.value.replace(/\s+/g, ' ').trim();
    if (!body) return;
    if (sendMessage(body) === false) return; // not connected: what was typed stays where it is
    input.value = '';
  });
  // Tapping the banner goes to the conversation.
  $('#chat-banner').addEventListener('click', () => {
    hideBanner();
    $('#chat').scrollIntoView({ block: 'center', behavior: 'smooth' });
    $('#chat-input').focus({ preventScroll: true });
  });
  window.addEventListener('scroll', () => !$('#chat-banner').hidden && placeBanner(), { passive: true });
  window.addEventListener('resize', () => !$('#chat-banner').hidden && placeBanner());
}

/** Who this browser is playing as, so its own messages read "You". */
export function setYou(id) {
  if (you === id) return;
  you = id;
  render();
}

/** A new room, or the same one left: nothing said elsewhere carries over. */
export function reset() {
  list = [];
  you = null;
  hideBanner();
  render();
}

/** Takes one message from the server: the whole conversation so far, or the newest line of it. */
export function receive(msg) {
  if (Array.isArray(msg.all)) {
    list = msg.all.filter((m) => m && typeof m.text === 'string');
    return render({ toEnd: true });
  }
  const m = msg.m;
  if (!m || typeof m.text !== 'string' || list.some((x) => x.id === m.id)) return;
  list.push(m);
  if (list.length > 150) list.splice(0, list.length - 150);
  const mine = m.by === you;
  render({ toEnd: mine });
  sfx(mine ? 'chatOut' : 'chatIn');
  if (!mine && !reading()) showBanner(m);
}

/** True while the reader is already in the conversation: typing in it, with the latest lines in view. */
function reading() {
  const el = $('#chat-list');
  if (document.activeElement !== $('#chat-input')) return false;
  const box = el.getBoundingClientRect();
  return box.bottom > 0 && box.top < window.innerHeight && el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

function render({ toEnd = false } = {}) {
  const el = $('#chat-list');
  if (!el) return;
  // Stay with the newest line unless the reader has scrolled back to read.
  const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.innerHTML = list.length
    ? list
        .map((m) => {
          const mine = m.by === you;
          return `<li class="${mine ? 'is-me' : ''}" style="--p:${hex(m.color)}" title="${esc(clock.format(new Date(m.at)))}"><b>${mine ? 'You' : esc(m.name)}</b> <span>${esc(m.text)}</span></li>`;
        })
        .join('')
    : '<li class="chat-empty">Nobody has said anything yet.</li>';
  if (toEnd || atEnd) el.scrollTop = el.scrollHeight;
}

// ───────────────────────── the banner ─────────────────────────

function showBanner(m) {
  const el = $('#chat-banner');
  const color = hex(m.color);
  el.innerHTML = `<span class="avatar" style="--p:${color};--on-p:${onColor(color)}">${esc(initials(m.name))}</span>
    <p><b>${esc(m.name)}</b> <span>${esc(m.text)}</span></p>`;
  el.hidden = false;
  placeBanner();
  // Run the entrance again for a message that arrives while another is showing.
  el.classList.remove('is-in');
  void el.offsetWidth;
  el.classList.add('is-in');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(hideBanner, Math.min(9000, 4200 + m.text.length * 28));
}

function hideBanner() {
  clearTimeout(bannerTimer);
  const el = $('#chat-banner');
  if (el) el.hidden = true;
}

/**
 * Puts the banner where it covers no card. Its place is just under the top
 * bar, over the turn order and the "your turn" heading, and it is only as tall
 * as the gap above the highest card on screen. When the page has been scrolled
 * and cards run right up to the bar, it sits on the bar itself, which is
 * always clear of them.
 */
function placeBanner() {
  const el = $('#chat-banner');
  const bar = $('#room .bar')?.getBoundingClientRect();
  const floor = Math.max(0, bar?.bottom ?? 0);
  let highest = Infinity;
  for (const card of $$('#room .card, #fx .card')) {
    const box = card.getBoundingClientRect();
    if (box.width && box.bottom > floor + 1 && box.top < window.innerHeight) highest = Math.min(highest, box.top);
  }
  const gap = 6;
  const under = highest - gap - (floor + gap); // the room between the bar and the first card
  const onBar = under < 40;
  el.style.top = `${onBar ? gap : floor + gap}px`;
  const height = onBar ? Math.max(30, floor - gap * 2) : Math.min(under, 76);
  el.style.maxHeight = `${height}px`;
  el.classList.toggle('is-tight', height < 56);
}
