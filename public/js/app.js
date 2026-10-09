// Entry point: routing, the connection, dialogs, wiring taps to actions, and
// the choreography that turns each change from the server into movement.

import { $, $$, esc, formatClock, icon, onColor, reducedMotion, sleep, store, toast } from './util.js';
import { Connection } from './net.js';
import { buzz, play as sfx, setSound, soundOn } from './sound.js';
import { backHTML, faceHTML, flipHTML } from './cards.js';
import { TEN, judge } from './rules.js';
import * as fx from './fx.js';
import * as push from './push.js';
import {
  colorOf,
  fitHand,
  hostName,
  inRound,
  isLive,
  matColor,
  myOpenCards,
  myTurn,
  pileSpec,
  pileStyle,
  playerOf,
  preview,
  renderActions,
  renderHand,
  renderLobby,
  renderPile,
  renderRails,
  renderResults,
  renderStrip,
  renderTable,
  renderTimer,
  renderTurn,
  viewed,
  who,
} from './view.js';

const cfg = JSON.parse($('#config').textContent);

let conn = null;
let state = null;
let me = null;
let clockOffset = 0;
let lastTick = null;
let settingsSig = '';

// What is on screen that the server doesn't decide.
const ui = {
  tableView: 'turn', // whose table cards: the player on turn, or 'me'
  handView: 'turn',
  selected: new Set(),
  pile: { count: 0, top: [], backs: [] }, // the pile as drawn (it lags the server while cards are in the air)
  mat: null,
  sending: false,
  blindSlot: null,
  push: 'off', // what this browser can do about notifications (push.support())
  seatCode: null, // { code, until }: a code on show in Room settings
};

// Seat codes arrive in answer to a request; this remembers what each was wanted for.
const seatWanted = [];

const send = (action, data) => conn?.send(action, data);
const api = (path) => new URL(path, document.baseURI).toString();

// ───────────────────────── boot ─────────────────────────

function hydrateIcons() {
  for (const el of $$('[data-icon]')) {
    const name = el.dataset.icon;
    if (name === 'sound') el.innerHTML = icon(soundOn() ? 'soundOn' : 'soundOff');
    else if (name === 'theme') el.innerHTML = icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon');
    else el.innerHTML = icon(name);
  }
}

function currentRoomCode() {
  const base = new URL(document.baseURI).pathname;
  const rel = location.pathname.startsWith(base) ? location.pathname.slice(base.length) : location.pathname.replace(/^\//, '');
  const m = /^r\/([^/]+)\/?$/.exec(rel);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}

function goToRoom(code) {
  location.href = api(`r/${encodeURIComponent(code)}`);
}

function show(id) {
  for (const view of ['home', 'room', 'notice']) $(`#${view}`).hidden = view !== id;
}

function notice(title, text, actions) {
  $('#notice-title').textContent = title;
  $('#notice-text').textContent = text;
  $('#notice-actions').innerHTML = actions;
  show('notice');
}

/** Cards scale with the screen: big enough to read, small enough that a phone shows the whole table. */
function sizeCards() {
  const stage = $('.stage');
  const w = Math.min(stage?.clientWidth || window.innerWidth, window.innerWidth);
  // Top to bottom the table is about 5.2 cards tall (table cards, pile, one
  // row of hand) plus everything that isn't a card: bars, labels, buttons.
  const strip = $('#strip');
  const chrome = strip && getComputedStyle(strip).display === 'none' ? 396 : 402;
  const byHeight = (window.innerHeight - chrome) / 5.2;
  const cw = Math.max(44, Math.min(w * 0.158, byHeight, 94));
  document.documentElement.style.setProperty('--cw', `${cw.toFixed(1)}px`);
}

function boot() {
  hydrateIcons();
  bindGlobal();
  sizeCards();
  push.init(cfg.pushKey).then(() => {
    ui.push = push.support();
    if (state) refreshPushUi();
  });
  const code = currentRoomCode();
  // An app put on an iPhone's Home Screen from inside a room always starts at
  // that room, with the seat code it was installed with. The code is good
  // once; on every later launch, go to the front door instead.
  const launchSeat = new URLSearchParams(location.search).get('seat');
  if (code && launchSeat && push.standalone()) {
    if (store.get('seatUsed') === launchSeat) return location.replace(api('.'));
    store.set('seatUsed', launchSeat);
  }
  if (code) enterRoom(code);
  else showHome();
}

// ───────────────────────── home ─────────────────────────

async function createRoom() {
  const body = cfg.needsPassword ? { password: $('#create-password').value } : {};
  const res = await fetch(api('api/rooms'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not create a room.');
  return data.code;
}

/**
 * The home page plays the game in miniature: cards land on a pile, lower
 * each time, until a ten or a fourth-of-a-kind sweeps it away.
 */
async function homeTable() {
  const host = $('#home-table');
  const COLORS = ['#3e63dd', '#e5484d', '#12a594', '#f76b15', '#9a4fd0'];
  const HANDS = [
    [['K', 's'], ['9', 'h'], ['9', 'c'], ['6', 'd'], ['10', 's']],
    [['Q', 'd'], ['J', 'c'], ['7', 'h'], ['7', 's'], ['7', 'd'], ['7', 'c']],
    [['J', 'h'], ['8', 's'], ['5', 'd'], ['5', 'c'], ['2', 'h'], ['10', 'd']],
  ];
  host.innerHTML = '<div class="home-mat"><div class="home-wipe"></div><div class="pile home-pile"></div><span class="home-word">Swipe!</span></div>';
  const mat = host.firstElementChild;
  const pileEl = $('.home-pile', host);
  const wipe = $('.home-wipe', host);
  const word = $('.home-word', host);
  let colour = 0;
  mat.style.setProperty('--mat', matColor(COLORS[0]));
  let id = 0;

  const draw = (cards, hideLast = false) => {
    const top = [];
    for (let i = cards.length - 1; i >= 0 && cards[i].r === cards.at(-1).r; i--) top.unshift(cards[i]);
    const spec = pileSpec('home', cards.length, top, cards.slice(0, cards.length - top.length).map((c) => c.b));
    pileEl.innerHTML = spec
      .map((s, n) =>
        s.kind === 'back'
          ? backHTML(s.b, { cls: 'pile-card', style: pileStyle(s) })
          : faceHTML(s.card, { cls: 'pile-card is-top', style: `${pileStyle(s)}${hideLast && n === spec.length - 1 ? ';visibility:hidden' : ''}` }),
      )
      .join('');
    return spec.at(-1);
  };

  if (reducedMotion()) {
    draw(HANDS[1].slice(0, 5).map(([r, s], i) => ({ id: `h${i}`, r, s, b: i % 2 })));
    return;
  }

  for (let round = 0; document.body.contains(host) && !$('#home').hidden; round++) {
    const hand = HANDS[round % HANDS.length];
    const cards = [];
    for (const [r, s] of hand) {
      await sleep(cards.length ? 720 : 500);
      if ($('#home').hidden) return;
      const card = { id: `h${id++}`, r, s, b: id % 2 };
      cards.push(card);
      draw(cards, true);
      const el = pileEl.lastElementChild;
      el.style.visibility = '';
      const side = id % 2 ? 1 : -1;
      el.animate(
        [
          { translate: `${side * 60}px 150%`, rotate: `${side * 50}deg`, scale: '1.25', opacity: 0 },
          { opacity: 1, offset: 0.25 },
          { translate: '0px 0px', rotate: '0deg', scale: '1', opacity: 1 },
        ],
        { duration: 380, easing: 'cubic-bezier(.2,.8,.25,1)' },
      );
    }
    await sleep(650);
    if ($('#home').hidden) return;
    // The swipe: cards go one way, the next colour comes in behind them.
    colour = (colour + 1) % COLORS.length;
    const next = matColor(COLORS[colour]);
    wipe.style.background = next;
    word.animate(
      [
        { transform: 'translate(-160%,-50%) skewX(-14deg)', opacity: 1 },
        { transform: 'translate(-50%,-50%) skewX(-14deg)', opacity: 1, offset: 0.3, easing: 'cubic-bezier(.1,.9,.2,1)' },
        { transform: 'translate(-44%,-50%) skewX(-14deg)', opacity: 1, offset: 0.72, easing: 'cubic-bezier(.55,0,.9,.45)' },
        { transform: 'translate(160%,-50%) skewX(-14deg)', opacity: 1 },
      ],
      { duration: 1250, fill: 'both' },
    );
    wipe.animate([{ clipPath: 'polygon(0 0, 0 0, -25% 100%, -25% 100%)' }, { clipPath: 'polygon(0 0, 125% 0, 100% 100%, -25% 100%)' }], { duration: 520, easing: 'cubic-bezier(.3,.6,.2,1)', fill: 'both' });
    await fx.sweepOff($$('.pile-card', pileEl), 1);
    mat.style.setProperty('--mat', next);
    wipe.style.background = 'transparent';
    pileEl.innerHTML = '';
    await sleep(500);
  }
}

function showHome() {
  show('home');
  document.title = cfg.siteName;
  $('#create-password-row').hidden = !cfg.needsPassword;
  homeTable();

  // Opened from the Home Screen, or just come back: offer the room you were last in.
  const last = store.get('room');
  if (last) {
    fetch(api(`api/rooms/${encodeURIComponent(last)}`))
      .then((res) => {
        if (!res.ok) return;
        const el = $('#home-back');
        el.innerHTML = `<a class="btn btn-large" href="${esc(api(`r/${encodeURIComponent(last)}`))}">Back to ${esc(last)}</a>`;
        el.hidden = false;
      })
      .catch(() => {});
  }

  $('#create-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.target.querySelector('button');
    button.disabled = true;
    try {
      goToRoom(await createRoom());
    } catch (err) {
      toast(err.message, { error: true });
      button.disabled = false;
    }
  });

  $('#join-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    let code = $('#join-code').value.trim();
    // Accept a pasted invite link as well as a bare code.
    const fromLink = /\/r\/([^/?#\s]+)/.exec(code);
    if (fromLink) code = fromLink[1];
    code = code.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (!code) return toast('Type the room code first.', { error: true });
    const res = await fetch(api(`api/rooms/${encodeURIComponent(code)}`)).catch(() => null);
    if (res?.ok) goToRoom(code);
    else toast('There is no room with that code. Check the spelling, or create a new room.', { error: true });
  });
}

// ───────────────────────── room ─────────────────────────

function token() {
  let t = store.get('token');
  if (!t || t.length < 16) {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    t = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    store.set('token', t);
  }
  return t;
}

function askName({ rename = false } = {}) {
  const dialog = $('#dlg-name');
  dialog.dataset.rename = rename ? '1' : '';
  $('#name-submit').textContent = rename ? 'Save name' : 'Join room';
  $('#name-seat').hidden = rename;
  $('#name-input').value = store.get('name', '');
  if (!dialog.open) dialog.showModal();
  $('#name-input').select();
}

function enterRoom(code) {
  show('room');
  sizeCards();
  $('#invite-code').textContent = code;
  document.title = `${code} | ${cfg.siteName}`;
  ui.tableView = store.get('tableView', 'turn') === 'me' ? 'me' : 'turn';
  ui.handView = store.get('handView', 'turn') === 'me' ? 'me' : 'turn';

  // A link that carries a seat code (the Home Screen app's first launch) claims that seat.
  const params = new URLSearchParams(location.search);
  const claim = params.get('seat');
  if (claim) {
    history.replaceState(null, '', location.pathname);
    return connect(code, store.get('name') ?? '', claim);
  }

  const name = store.get('name');
  if (name) return connect(code, name);
  // No name yet: make sure the room exists before asking for one.
  fetch(api(`api/rooms/${encodeURIComponent(code)}`))
    .then((res) => (res.status === 404 ? roomMissing() : askName()))
    .catch(() => askName());
}

const homeLink = () => `<a class="btn" href="${esc(api('.'))}">Go to the home page</a>`;

function roomMissing() {
  notice(
    'That room isn’t here',
    'It may have expired, or the link has a typo.',
    `<button class="btn btn-primary" data-act="create-from-notice">Create a new room</button>${homeLink()}`,
  );
}

function connect(code, name, claim = null) {
  conn?.close();
  conn = new Connection({
    room: code,
    token: token(),
    name,
    claim,
    onState,
    onJoin: joined,
    onSeat: gotSeatCode,
    onClaim: (ok) => {
      if (ok) toast('Your seat has moved to this browser.');
      else toast('That seat code didn’t work. It may have expired or been used already.', { error: true });
    },
    onError: (message) => {
      ui.sending = false;
      sfx('error');
      toast(message, { error: true });
      if (state) renderActions(state, me, ui);
    },
    onStatus: (up) => ($('#conn-banner').hidden = up),
    onFatal: (kind, message) => {
      const home = homeLink();
      // Whatever was open belongs to a room this browser is no longer in.
      for (const dialog of $$('dialog[open]')) if (!(kind === 'name' && dialog.id === 'dlg-name')) dialog.close();
      if (kind === 'name') return askName();
      if (kind === 'no-room') return roomMissing();
      if (kind === 'locked') return notice('This room is locked', 'Ask the host to unlock it, then reload this page.', `<button class="btn btn-primary" data-act="reload">Try again</button>${home}`);
      if (kind === 'full') return notice('This room is full', message, home);
      if (kind === 'moved') return notice('Your seat has moved', 'This game is now open in another browser, with your cards and your score. To come back here, ask for a seat code there.', home);
      return notice('You’re out of this room', message, home);
    },
  });
}

// ───────────────────────── the queue ─────────────────────────
// Snapshots are shown one at a time, in order, so a move's animation always
// finishes before the next one starts. If the tab falls behind (it was in the
// background, or people are playing fast), it skips the show and catches up.

const queue = [];
let busy = false;
let seen = null; // { round, seq } of the last event shown

function onState(next) {
  queue.push(next);
  if (!busy) drain();
}

async function drain() {
  busy = true;
  while (queue.length) {
    const next = queue.shift();
    try {
      await step(next, queue.length > 0 || document.hidden);
    } catch (err) {
      console.error(err);
      fx.clearAll();
      commit(next);
    }
  }
  busy = false;
}

async function step(next, hurry) {
  const prev = state;
  const nextMe = next.players.find((p) => p.id === next.you);
  if (!nextMe) return;
  clockOffset = next.now - Date.now();

  const r = next.round;
  const ev = r?.last ?? null;
  const fresh = Boolean(ev) && (!seen || seen.round !== r.id || ev.seq > seen.seq);
  const sameGame = Boolean(prev?.round) && prev.round.id === r?.id && !$('#game').hidden;
  const showy = fresh && !hurry;

  if (showy && sameGame && ev.kind === 'play') await showPlay(prev, next, ev);
  else if (showy && sameGame && ev.kind === 'flip') await showFlip(prev, next, ev);
  else if (showy && sameGame && ev.kind === 'skip') await showSkip(prev, ev);

  const dealing = fresh && ev.kind === 'deal' && r.phase === 'deal';
  commit(next, { dealing: dealing && !hurry });
  if (dealing && !hurry) await showDeal(next);

  afterEffects(prev, next, ev, { showy: !hurry, fresh });
  seen = r ? { round: r.id, seq: ev.seq } : null;
}

/** Makes `next` the truth and redraws everything from it. */
function commit(next, { dealing = false } = {}) {
  const prev = state;
  state = next;
  me = next.players.find((p) => p.id === next.you);
  ui.sending = false;
  // A seat that arrived by code brings its name with it.
  if (!store.get('name')) store.set('name', me.name);
  if (store.get('room') !== next.code) store.set('room', next.code);

  const r = next.round;
  // Keep only selections that are still playable; a flipped blind card is always in.
  const open = new Set(myTurn(next, me) ? myOpenCards(next, me).map((c) => c.id) : []);
  for (const id of [...ui.selected]) if (!open.has(id)) ui.selected.delete(id);
  if (r?.pending?.pid === me.id && myTurn(next, me)) {
    const flipped = r.seats[me.id].blind[r.pending.slot];
    const rank = flipped.r;
    for (const c of myOpenCards(next, me)) if (ui.selected.has(c.id) && c.r !== rank) ui.selected.delete(c.id);
    ui.selected.add(flipped.id);
  }
  ui.pile = r ? { count: r.pile.count, top: r.pile.top, backs: r.pile.backs ?? [] } : { count: 0, top: [], backs: [] };

  renderAll({ dealing, turnChanged: prev?.round?.turn !== r?.turn || prev?.round?.id !== r?.id });
}

function phaseOf(s) {
  if (!s.round) return 'lobby';
  return s.round.phase === 'over' ? 'results' : 'game';
}

function renderAll({ dealing = false, turnChanged = false } = {}) {
  const phase = phaseOf(state);
  const was = document.body.dataset.phase;
  document.body.dataset.phase = phase;
  $('#lobby').hidden = phase !== 'lobby';
  $('#game').hidden = phase !== 'game';
  $('#results').hidden = phase !== 'results';
  if (was !== phase) {
    sizeCards();
    window.scrollTo(0, 0); // a new screen starts at its top, wherever the last one was left
  }

  $('#me-chip').textContent = me.name;
  $('#me-chip').style.cssText = `--p:${me.color};--on-p:${onColor(me.color)}`;
  $('#invite-code').textContent = state.code;
  document.documentElement.style.setProperty('--me', me.color);
  document.documentElement.style.setProperty('--on-me', onColor(me.color));

  renderRails(state, me);
  if (phase === 'lobby') renderLobby(state, me, ui);
  if (phase === 'results') renderResults(state, me);
  if (phase === 'game') {
    const r = state.round;
    $('#game').classList.toggle('is-dealing', dealing);
    $('#game').classList.toggle('is-my-turn', myTurn(state, me));
    setMat(colorOf(state, r.turn), turnChanged && was === 'game' && !dealing);
    renderStrip(state, me);
    renderTurn(state, me);
    renderTable(state, me, ui);
    renderPile(state, ui.pile);
    renderHand(state, me, ui);
    renderActions(state, me, ui);
    renderTimer(state, me, clockOffset, true);
  }
  if ($('#dlg-settings').open) renderSettings();
  if ($('#dlg-player').open) renderPlayerDialog($('#dlg-player').dataset.id);
  if ($('#dlg-blind').open && !canFlip(ui.blindSlot)) $('#dlg-blind').close();
  updateTitle();
}

/** Redraws only what a tap on a card changes. */
function renderSelection() {
  renderTable(state, me, ui);
  renderHand(state, me, ui);
  renderActions(state, me, ui);
}

/** The mat takes the colour of whoever's turn it is. A new turn wipes the new colour across. */
function setMat(hex, animate) {
  const mat = $('#mat');
  const color = matColor(hex);
  mat.style.setProperty('--turn', hex);
  mat.style.setProperty('--on-turn', onColor(hex));
  if (ui.mat === color) return;
  const wipe = $('#mat-wipe');
  if (!animate || !ui.mat || reducedMotion()) {
    mat.style.setProperty('--mat', color);
  } else {
    wipe.style.background = color;
    wipe
      .animate([{ clipPath: 'polygon(0 0, 0 0, -25% 100%, -25% 100%)' }, { clipPath: 'polygon(0 0, 125% 0, 100% 100%, -25% 100%)' }], { duration: 460, easing: 'cubic-bezier(.3,.6,.2,1)', fill: 'both' })
      .finished.then(() => {
        mat.style.setProperty('--mat', color);
        wipe.style.background = 'transparent';
      })
      .catch(() => {});
  }
  ui.mat = color;
}

function updateTitle() {
  if (!state) return;
  const mine = myTurn(state, me);
  document.title = `${mine && document.hidden ? '● Your turn | ' : ''}${state.code} | ${cfg.siteName}`;
}

setInterval(() => {
  if (!state || $('#game').hidden) return;
  const secs = renderTimer(state, me, clockOffset);
  // A quiet tick for the last five seconds, only for whoever is on the clock.
  if (secs != null && secs <= 5 && secs > 0 && secs !== lastTick && myTurn(state, me)) sfx('tick');
  lastTick = secs;
}, 250);

// ───────────────────────── choreography ─────────────────────────

const cardWidth = () => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cw')) || 60;

/** Somewhere on screen that stands for a player: their chip in the turn order, or their row in the scores. */
function anchorOf(pid) {
  const candidates = [`#strip [data-pid="${CSS.escape(pid)}"]`, `#rail-left [data-id="${CSS.escape(pid)}"] .avatar`, '#turn .turn-name'];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return fx.rectOf(el);
  }
  return { x: window.innerWidth / 2, y: 60, w: 0, h: 0 };
}

/** Where a played card starts its flight from. */
function sourceFor(card, actor, used) {
  const sel = `[data-cid="${CSS.escape(card.id)}"]`;
  const el = document.querySelector(`#tablezone ${sel}, #hand ${sel}`);
  if (el) return { el, rect: fx.rectOf(el), flip: false };
  const hand = $('#hand');
  if (card.from === 'hand' && hand?.dataset.pid === actor) {
    const backs = $$('.card.back', hand).filter((b) => !used.has(b));
    const back = backs.at(-1);
    if (back) {
      used.add(back);
      return { el: back, rect: fx.rectOf(back), flip: true };
    }
  }
  if (card.from !== 'hand') {
    const slot = document.querySelector(`#tablezone .slots[data-pid="${CSS.escape(actor)}"] .slot[data-slot="${card.slot}"]`);
    if (slot) return { el: null, rect: fx.cardRectAt(fx.rectOf(slot), cardWidth()), flip: false };
  }
  return { el: null, rect: fx.cardRectAt(anchorOf(actor), cardWidth() * 0.45), flip: false };
}

/** Where a picked-up pile goes: the hand on show if it is theirs, otherwise their chip. */
function pickupTarget(actor) {
  const hand = $('#hand');
  if (hand?.dataset.pid === actor) return fx.rectOf($('#handzone'));
  return anchorOf(actor);
}

async function showPlay(prev, next, ev) {
  const r0 = prev.round;
  const actor = ev.by;
  const color = colorOf(next, actor);
  const used = new Set();
  const sources = ev.cards.map((c) => sourceFor(c, actor, used));

  // Too high: the old pile goes home with them first.
  if (ev.pickup) {
    const to = pickupTarget(actor);
    sfx('pickup');
    if (actor === me.id) buzz([30, 40, 30]);
    fx.floatLabel(`+${ev.pickup}`, to, color);
    await fx.gatherTo($$('#pile .pile-card'), to);
    ui.pile = { count: 0, top: [], backs: [] };
    renderPile(prev, ui.pile);
  }

  // The pile as it will look once these cards have landed.
  const before = ui.pile;
  const joins = before.top.length && before.top.at(-1).r === ev.cards[0].r;
  // If these cards cover a different rank, what was on top turns face down under them.
  const after = {
    count: before.count + ev.cards.length,
    top: joins ? [...before.top, ...ev.cards] : ev.cards,
    backs: joins ? before.backs : [...before.backs, ...before.top.map((c) => c.b)],
  };
  const spec = pileSpec(r0.id, after.count, after.top, after.backs);
  const anchor = fx.rectOf($('#pile'));
  // Cards already on top shuffle along to make room for the newcomers.
  for (const el of $$('#pile .pile-card.is-top')) {
    const s = spec.find((x) => x.card?.id === el.dataset.cid);
    if (s) el.style.cssText = pileStyle(s);
  }

  const ghosts = ev.cards.map((card, i) => {
    const src = sources[i];
    const s = spec.find((x) => x.card?.id === card.id);
    const to = { x: anchor.x + s.x * anchor.w, y: anchor.y + s.y * anchor.w, w: anchor.w, h: anchor.h, rot: s.rot };
    if (src.el) src.el.style.visibility = 'hidden';
    const g = fx.ghost(src.flip ? flipHTML(card) : faceHTML(card), src.rect);
    const delay = i * 75;
    const duration = 330;
    setTimeout(() => sfx('card'), delay + duration - 50);
    return fx.fly(g, src.rect, to, { delay, duration, lift: 22, flip: src.flip, rot0: (i - (ev.cards.length - 1) / 2) * 4 }).then(() => g);
  });
  const landed = await Promise.all(ghosts);
  ui.pile = after;
  renderPile(prev, ui.pile);
  landed.forEach((g) => g.remove());

  if (ev.effect === 'swipe') {
    $('#pile').classList.add('is-hot');
    await sleep(reducedMotion() ? 0 : ev.swipe === 'four' ? 420 : 300);
    sfx('swipe');
    buzz(actor === me.id ? [20, 30, 60] : 25);
    const sub = ev.swipe === 'ten' ? 'A ten clears the pile' : 'Four of a kind';
    fx.callout('Swipe!', { color, on: onColor(color), sub });
    await sleep(reducedMotion() ? 0 : 150);
    await fx.sweepOff($$('#pile .pile-card'), 1); // the same way the band is travelling
    $('#pile').classList.remove('is-hot');
    ui.pile = { count: 0, top: [], backs: [] };
    renderPile(prev, ui.pile);
    await sleep(reducedMotion() ? 0 : 260);
  } else {
    await sleep(reducedMotion() ? 0 : 120);
  }
}

async function showFlip(prev, next, ev) {
  const slot = document.querySelector(`#tablezone .slots[data-pid="${CSS.escape(ev.by)}"] .slot[data-slot="${ev.slot}"] .blind`);
  sfx('flip');
  if (slot) {
    const rect = fx.rectOf(slot);
    slot.style.visibility = 'hidden';
    const g = fx.ghost(flipHTML(ev.card), rect);
    await fx.flipInPlace(g);
    setTimeout(() => g.remove(), 60);
  }
  const top = { rank: prev.round.pile.top.at(-1)?.r ?? null, run: prev.round.pile.top.length };
  const verdict = judge(top, ev.card.r, 1);
  sfx(verdict.effect === 'pickup' ? 'bad' : 'good');
  if (!slot) toast(`${who(next, me, ev.by)} flipped a blind ${ev.card.r}.`);
}

/** Somebody's clock ran out: everyone gets the banner, and it is not a friendly one. */
async function showSkip(prev, ev) {
  const mine = ev.by === me.id;
  const name = playerOf(prev, ev.by)?.name ?? 'Someone';
  sfx('skip');
  buzz(mine ? [90, 50, 90, 50, 220] : [50, 40, 50]);
  for (const dialog of $$('#dlg-blind[open]')) dialog.close();
  const drew = ev.drew ?? 0;
  const banner = fx.skipped({
    sub: mine ? 'You ran out of time' : `${esc(name)} ran out of time`,
    penalty: drew ? `+${drew} ${drew === 1 ? 'card' : 'cards'}` : '',
    shake: $('#mat'),
  });
  if (!drew || reducedMotion()) return banner;

  // The penalty cards drop in from above the banner, face down, into the hand
  // if it is on screen and otherwise onto the player's chip.
  await sleep(260);
  const toHand = $('#hand')?.dataset.pid === ev.by;
  const target = toHand ? fx.rectOf($('#handzone')) : anchorOf(ev.by);
  const cw = cardWidth();
  const backs = (ev.backs ?? []).slice(0, 14);
  const flights = backs.map((b, i) => {
    const spread = (i - (backs.length - 1) / 2) * cw * 0.5;
    const from = { x: window.innerWidth / 2 - cw / 2 + spread, y: -cw * 1.6, w: cw, h: cw * 1.4 };
    const to = toHand
      ? { x: target.x + target.w / 2 - cw / 2 + spread * 0.6, y: target.y + target.h / 2 - cw * 0.7, w: cw, h: cw * 1.4, rot: (i % 2 ? 1 : -1) * 4 }
      : { ...fx.cardRectAt(target, cw * 0.4), rot: 0 };
    const g = fx.ghost(backHTML(b), from);
    setTimeout(() => sfx('deal'), i * 70 + 200);
    return fx.fly(g, from, to, { delay: i * 70, duration: 420, rot0: (i % 2 ? -1 : 1) * 25, fade: !toHand, easing: 'cubic-bezier(.5,0,.6,1)' }).then(() => g);
  });
  setTimeout(() => fx.floatLabel(`+${drew}`, target, '#e3101e'), 320);
  const landed = await Promise.all(flights);
  await banner;
  landed.forEach((g) => g.remove());
}

/** The opening: the wash, then your own eight table cards and your hand are dealt to you. */
async function showDeal(s) {
  const r = s.round;
  const left = r.readyAt - (Date.now() + clockOffset);
  const game = $('#game');
  const finish = () => game.classList.remove('is-dealing');
  if (left < 3600 || reducedMotion()) return finish();
  const k = Math.min(1, (left - 400) / 7900); // squeeze the sequence if we arrived late

  // The deck ends up where the pile lives. The shuffle itself happens in the
  // middle of the screen, where there is room for it.
  const home = fx.rectOf($('#pile'));
  const mid = { x: home.x + home.w / 2, y: Math.max(home.y + home.h / 2, window.innerHeight * 0.47) };
  const clear = await fx.wash({ mid, home, decks: r.decks, k });
  if (state?.round?.id !== r.id || $('#game').hidden) {
    finish();
    return clear();
  }

  // Every face the viewer is allowed to see, so a dealt card can turn over as it lands.
  const faces = new Map([...(r.mine ?? []), ...Object.values(r.seats).flatMap((seat) => seat.up.filter(Boolean))].map((c) => [c.id, c]));
  const dealTo = async (targets, { gap, flight }) => {
    await Promise.all(
      targets.map((el, i) => {
        const to = { ...fx.rectOf(el), rot: 0 };
        const card = faces.get(el.dataset.cid);
        const back = el.classList.contains('b1') ? 1 : 0;
        const g = fx.ghost(card ? flipHTML(card) : backHTML(back), home);
        setTimeout(() => sfx('deal'), i * gap * k);
        return fx.fly(g, home, to, { delay: i * gap * k, duration: flight * k, lift: 10, flip: Boolean(card), rot0: -8 }).then(() => {
          el.classList.add('is-dealt');
          g.remove();
        });
      }),
    );
  };

  await dealTo($$('#tablezone .slot .blind'), { gap: 110, flight: 300 });
  await dealTo($$('#tablezone .slot .up'), { gap: 110, flight: 340 });
  await dealTo($$('#hand .card'), { gap: 52, flight: 280 });
  finish();
  await clear();
}

/** Sounds and flourishes that follow from what changed. */
function afterEffects(prev, next, ev, { showy, fresh }) {
  const r = next.round;
  const a = prev?.round;
  if (!prev) return;

  if (!r) {
    if (next.players.length > prev.players.length) sfx('join');
    return;
  }
  if (!showy) return;

  // Somebody went out, or the game was called off.
  if (r.phase === 'over' && (!a || a.phase !== 'over' || a.id !== r.id)) {
    if (r.reason !== 'out') return;
    const won = r.winner === me.id;
    const champs = next.match?.over ? next.match.champions : [];
    const colors = next.match?.over && champs.length ? champs.map((id) => colorOf(next, id)) : [colorOf(next, r.winner)];
    fx.confetti([...colors, '#fffdf8', '#c5202a', '#1c4a96'], { count: next.match?.over ? 110 : 60 });
    setTimeout(() => sfx(won || champs.includes(me.id) ? 'win' : inRound(next, me.id) ? 'lose' : 'good'), 150);
    if (won) buzz([40, 60, 40, 60, 120]);
    fx.countUp($$('#results .score-total'), { delay: 500 });
    return;
  }

  if (fresh && ev?.kind === 'drop') toast(`${playerOf(prev, ev.by)?.name ?? 'Someone'} left the game.`);

  // It just became your turn.
  if (r.phase === 'play' && r.turn === me.id && !(a?.phase === 'play' && a.turn === me.id && a.id === r.id)) {
    sfx('turn');
    buzz(70);
    $('.turn-name')?.animate([{ transform: 'scale(1.12)' }, { transform: 'scale(1)' }], { duration: 380, easing: 'cubic-bezier(.2,1.6,.4,1)' });
  }
  if (r.phase === 'play' && a?.phase === 'deal' && r.turn !== me.id) sfx('good');
}

// ───────────────────────── picking and playing cards ─────────────────────────

function pickCard(id) {
  if (!state || !myTurn(state, me) || busy) return;
  const open = myOpenCards(state, me);
  const card = open.find((c) => c.id === id);
  if (!card) return;
  const r = state.round;
  const flipped = r.pending?.pid === me.id ? r.seats[me.id].blind[r.pending.slot] : null;
  if (flipped && id === flipped.id) return toast('That is your flipped blind card. It has to be played.');

  if (ui.selected.has(id)) {
    ui.selected.delete(id);
    sfx('unpick');
  } else {
    const current = open.filter((c) => ui.selected.has(c.id));
    if (current.length && current[0].r !== card.r) {
      if (flipped) return toast(`Only another ${flipped.r} can go down with your flipped card.`, { error: true });
      ui.selected.clear();
    }
    if (card.r === TEN && current.length && current[0].r === TEN) ui.selected.clear(); // one ten at a time: the tap moves the pick
    if (ui.selected.size >= 4) return toast('A set is four cards at most.', { error: true });
    ui.selected.add(id);
    sfx('pick');
  }
  renderSelection();
}

function pickAll(n) {
  const p = preview(state, me, ui);
  if (!p) return;
  const rest = myOpenCards(state, me).filter((c) => c.r === p.rank && !ui.selected.has(c.id));
  while (ui.selected.size < n && rest.length) ui.selected.add(rest.shift().id);
  sfx('pick');
  renderSelection();
}

function playSelected() {
  if (ui.sending || busy) return;
  const p = preview(state, me, ui);
  if (!p || !p.verdict.ok) return;
  ui.sending = true;
  send('play', { cards: p.cards.map((c) => c.id) });
}

function canFlip(slot) {
  const r = state?.round;
  const seat = r?.seats[me?.id];
  return Boolean(seat && myTurn(state, me) && !r.pending && seat.blind[slot] && !seat.up[slot]);
}

// ───────────────────────── settings dialog ─────────────────────────

const CLOCK_CHOICES = [0, 15, 20, 30, 45, 60, 90, 120];
const LIMIT_CHOICES = [50, 100, 150, 200, 300];

function renderSettings() {
  const s = state.settings;
  const isHost = me.id === state.hostId;
  const live = isLive(state);
  const sig = JSON.stringify([s, isHost, live, state.locked, Boolean(state.match), ui.push, state.notify, push.blocked(), push.canInstall(), ui.seatCode, document.documentElement.dataset.theme]);
  const body = $('#settings-body');
  if (sig === settingsSig) return;
  // Don't yank the number out from under someone who is typing.
  if (body.contains(document.activeElement) && document.activeElement.type === 'number') return;
  settingsSig = sig;
  const off = isHost ? '' : ' disabled';

  body.innerHTML = `
    ${isHost ? '' : `<p class="readonly-note">Only the host (${esc(hostName(state))}) can change these.</p>`}
    <section class="set-group">
      <h3>Match</h3>
      <div class="set-row"><div><label for="set-limit">Points limit</label><small>The match ends when someone’s running score reaches this. Lowest score wins.</small></div>
        <div class="limit-pick">
          <div class="seg" role="radiogroup">${LIMIT_CHOICES.map((v) => `<label><input type="radio" name="limitPreset" value="${v}"${v === s.limit ? ' checked' : ''}${off}><span>${v}</span></label>`).join('')}</div>
          <input id="set-limit" name="limit" type="number" inputmode="numeric" min="20" max="1000" step="5" value="${s.limit}"${off} aria-label="Points limit">
        </div></div>
      <div class="set-row"><div><label for="set-clock">Turn clock</label><small>When it runs out, that player is skipped and draws 3 cards. With nothing to play, they draw as many as the pile holds if that is more.</small></div>
        <select id="set-clock" name="turnSeconds"${off}>${CLOCK_CHOICES.map((t) => `<option value="${t}"${t === s.turnSeconds ? ' selected' : ''}>${t === 0 ? 'Off' : formatClock(t * 1000)}</option>`).join('')}</select></div>
    </section>
    <section class="set-group">
      <h3>This device</h3>
      <div class="set-row"><div><label>Appearance</label></div>
        <button type="button" class="btn btn-small" data-act="theme">${document.documentElement.dataset.theme === 'dark' ? 'Switch to light' : 'Switch to dark'}</button></div>
      ${notifyRow()}
      ${
        push.canInstall()
          ? `<div class="set-row"><div><label>Install</label><small>Puts Swipe on this device like an app, in a window of its own.</small></div>
              <button type="button" class="btn btn-small" data-act="install">Install Swipe</button></div>`
          : ''
      }
      <div class="set-row"><div><label>Another browser</label><small>A seat code moves your seat, cards and score to a different browser or device. It works once, within 15 minutes.</small></div>
        <div class="set-actions set-actions-end">
          <button type="button" class="btn btn-small" data-act="seat-code">${ui.seatCode ? 'New code' : 'Show a seat code'}</button>
          <button type="button" class="btn btn-small" data-act="have-seat">Enter a code</button>
        </div></div>
      ${ui.seatCode ? `<p class="seat-code" aria-live="polite"><b>${esc(ui.seatCode.code.slice(0, 4))}-${esc(ui.seatCode.code.slice(4))}</b><span>Open this room in the other browser and choose “Already playing in another browser?”</span></p>` : ''}
    </section>
    ${
      isHost
        ? `<section class="set-group">
            <h3>Room</h3>
            <label class="check"><input type="checkbox" name="locked"${state.locked ? ' checked' : ''}>
              <span>Lock the room<small>Nobody new can join. People already here can still reconnect.</small></span></label>
            <div class="set-actions">
              <button type="button" class="btn btn-small" data-act="add-bot">Add a computer player</button>
              ${live ? '<button type="button" class="btn btn-small" data-act="end-game">Call this game off</button>' : ''}
              ${state.match ? '<button type="button" class="btn btn-small" data-act="lobby">End the match</button>' : ''}
            </div>
          </section>`
        : ''
    }`;
}

/** The "Turn notifications" row: what it offers depends on the browser and on what is already on. */
function notifyRow() {
  if (ui.push === 'off') return '';
  const row = (hint, control) => `<div class="set-row"><div><label>Turn notifications</label><small>${hint}</small></div>${control}</div>`;
  if (ui.push === 'install') {
    return row('On an iPhone or iPad these need Swipe on your Home Screen. Tap the Share button, then <b>Add to Home Screen</b>, and open Swipe from there. Your seat comes with you.', '');
  }
  if (ui.push === 'none') return row('This browser can’t show notifications.', '');
  if (state.notify && push.wanted()) {
    return row(
      'On. You’ll hear when it’s your turn and you’re not looking, even with this device locked.',
      `<div class="set-actions set-actions-end"><button type="button" class="btn btn-small" data-act="push-test">Send a test</button><button type="button" class="btn btn-small" data-act="push-off">Turn off</button></div>`,
    );
  }
  if (push.blocked()) return row('Blocked for this site. Allow notifications in your browser’s settings, then come back here.', '');
  return row('Hear when it’s your turn, even with this device locked.', '<button type="button" class="btn btn-small btn-you" data-act="push-on">Turn on</button>');
}

// ───────────────────────── notifications and seats ─────────────────────────

function refreshPushUi() {
  if ($('#dlg-settings').open) renderSettings();
  if (state && phaseOf(state) === 'lobby') renderLobby(state, me, ui);
}

/** Runs once each time the connection to a room is made. */
function joined() {
  ui.push = push.support();
  // Notifications turned on in this browser follow you from room to room without asking again.
  push.resume().then((sub) => sub && send('push', { sub }));
  push.clearShown(`swipe-${state?.code ?? currentRoomCode()}`);
  // In a Safari tab on an iPhone, keep a seat code tucked into the "Add to
  // Home Screen" link, so the installed app opens in this room as you.
  if (push.isIOS() && !push.standalone()) carrySeat();
}

function carrySeat() {
  const room = currentRoomCode();
  const point = (code) => ($('#manifest').href = api(`manifest.webmanifest?room=${encodeURIComponent(room)}&seat=${encodeURIComponent(code)}`));
  // One code per room, kept for this tab: asking again on every reconnect
  // would push out the code an already-installed app is waiting to use.
  try {
    const kept = JSON.parse(sessionStorage.getItem('sw.carry') ?? 'null');
    if (kept && kept.room === room && kept.until - Date.now() > 3600_000) return point(kept.code);
  } catch {}
  seatWanted.push((seat) => {
    try {
      sessionStorage.setItem('sw.carry', JSON.stringify({ room, code: seat.code, until: seat.until }));
    } catch {}
    point(seat.code);
  });
  conn?.raw({ t: 'seat', link: true });
}

function gotSeatCode(seat) {
  const wanted = seatWanted.shift();
  if (typeof wanted === 'function') return wanted(seat);
  ui.seatCode = seat;
  clearTimeout(gotSeatCode.timer);
  gotSeatCode.timer = setTimeout(() => {
    ui.seatCode = null;
    refreshPushUi();
  }, Math.max(0, seat.until - (Date.now() + clockOffset)));
  refreshPushUi();
  $('.seat-code')?.scrollIntoView({ block: 'nearest' });
}

async function turnOnNotifications() {
  if (ui.push === 'install' || ui.push === 'none') {
    settingsSig = '';
    renderSettings();
    if (!$('#dlg-settings').open) $('#dlg-settings').showModal();
    return;
  }
  try {
    const sub = await push.enable();
    send('push', { sub });
    setTimeout(() => send('pushTest'), 600);
    toast('Turn notifications are on. A test is on its way.');
  } catch (err) {
    toast(err.message, { error: true });
  }
  refreshPushUi();
}

function enterSeatCode() {
  const code = window.prompt('Seat code from your other browser:');
  if (!code || !code.trim()) return;
  for (const id of ['dlg-name', 'dlg-settings']) if ($(`#${id}`).open) $(`#${id}`).close();
  connect(currentRoomCode(), store.get('name') ?? '', code.trim());
}

function onSettingsChange(event) {
  const el = event.target;
  if (!state || me.id !== state.hostId) return;
  if (el.name === 'locked') return send('lock', { on: el.checked });
  const patch = {};
  if (el.name === 'limitPreset') patch.limit = Number(el.value);
  else if (el.name === 'limit') {
    const v = Math.round(Number(el.value));
    if (!Number.isFinite(v) || v < 20 || v > 1000) return toast('The points limit can be anything from 20 to 1000.', { error: true });
    patch.limit = v;
  } else if (el.name === 'turnSeconds') patch.turnSeconds = Number(el.value);
  else return;
  settingsSig = '';
  send('settings', { patch });
}

// ───────────────────────── player dialog (host) ─────────────────────────

function renderPlayerDialog(id) {
  const dialog = $('#dlg-player');
  const p = playerOf(state, id);
  if (!p || me.id !== state.hostId) return dialog.open && dialog.close();
  dialog.dataset.id = id;
  $('#player-title').textContent = p.name;
  const r = state.round;
  const theirTurn = r?.phase === 'play' && r.turn === p.id && p.id !== me.id;
  const atTable = state.match ? state.match.order.includes(p.id) : p.playing;
  const live = isLive(state) && inRound(state, p.id);
  const buttons = [
    theirTurn && !p.bot ? '<button type="button" class="btn" data-act="auto">Play this turn for them</button>' : '',
    atTable && p.id !== me.id ? `<button type="button" class="btn" data-act="bench">${live ? 'Take them out of the game' : 'Move them to watching'}</button>` : '',
    p.id !== state.hostId && !p.bot ? '<button type="button" class="btn" data-act="give-host">Make host</button>' : '',
    p.id !== me.id ? `<button type="button" class="btn btn-danger" data-act="kick">${p.bot ? 'Remove this computer player' : 'Remove from room'}</button>` : '',
  ].filter(Boolean);
  $('#player-body').innerHTML = `<div class="player-actions">${buttons.join('') || '<p class="set-hint">This is you. Nothing to do here.</p>'}</div>
    ${live && p.id !== me.id ? '<p class="set-hint">Taking someone out mid-game removes their cards from play.</p>' : ''}`;
}

// ───────────────────────── events ─────────────────────────

async function copyInvite() {
  const url = api(`r/${encodeURIComponent(state?.code ?? currentRoomCode())}`);
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied. Send it to your friends.');
  } catch {
    window.prompt('Copy this invite link:', url);
  }
}

function bindGlobal() {
  document.addEventListener('click', (event) => {
    // Clicking the dimmed backdrop closes a dialog (except the name prompt).
    if (event.target instanceof HTMLDialogElement && event.target.id !== 'dlg-name') return event.target.close();
    const closer = event.target.closest('[data-close]');
    if (closer) return closer.closest('dialog').close();

    const el = event.target.closest('[data-act]');
    if (!el) {
      const card = event.target.closest('.card.can-pick, .card.is-locked');
      if (card) pickCard(card.dataset.cid);
      return;
    }
    const playerId = $('#dlg-player').dataset.id;
    switch (el.dataset.act) {
      case 'rules':
        return $('#dlg-rules').showModal();
      case 'sound':
        setSound(!soundOn());
        hydrateIcons();
        if (soundOn()) sfx('card', 2);
        return;
      case 'theme': {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        store.set('theme', next);
        settingsSig = '';
        if (state && $('#dlg-settings').open) renderSettings();
        return hydrateIcons();
      }
      case 'settings':
        if (!state) return;
        settingsSig = '';
        renderSettings();
        return $('#dlg-settings').showModal();
      case 'push-on':
        return turnOnNotifications();
      case 'push-off':
        send('push', { sub: null });
        return push.disable().then(refreshPushUi);
      case 'push-test':
        send('pushTest');
        return toast('Sent. If nothing shows up, check this device’s notification settings for Swipe.');
      case 'install':
        return push.install().then(refreshPushUi);
      case 'seat-code':
        seatWanted.push('show');
        return conn?.raw({ t: 'seat' });
      case 'have-seat':
        return enterSeatCode();
      case 'rename':
        return askName({ rename: true });
      case 'invite':
        return copyInvite();
      case 'recolor':
        return send('recolor');
      case 'sit':
        return send('sit', { on: true });
      case 'stand':
        if (inRound(state, me.id) && isLive(state) && !window.confirm('Leave this game? Your cards are taken out of play and you’ll be watching.')) return;
        return send('sit', { on: false });
      case 'add-bot':
        return send('addBot');
      case 'start':
        return send('start');

      // ── playing ──
      case 'toggle-table':
        ui.tableView = viewed(state, me, ui.tableView) === me.id ? 'turn' : 'me';
        store.set('tableView', ui.tableView);
        return renderTable(state, me, ui);
      case 'toggle-hand':
        ui.handView = viewed(state, me, ui.handView) === me.id ? 'turn' : 'me';
        store.set('handView', ui.handView);
        return renderHand(state, me, ui);
      case 'blind': {
        const slot = Number(el.dataset.slot);
        if (!canFlip(slot) || busy) return;
        ui.blindSlot = slot;
        return $('#dlg-blind').showModal();
      }
      case 'pick-all':
        return pickAll(Number(el.dataset.n));
      case 'play':
        return playSelected();

      // ── host ──
      case 'auto':
        send('auto');
        return $('#dlg-player').open && $('#dlg-player').close();
      case 'end-game':
        return window.confirm('Call this game off? Nobody scores for it.') && send('endGame');
      case 'lobby':
        if (!window.confirm(state?.match?.over ? 'Go back to the lobby? The scores are cleared.' : 'End the match and go back to the lobby? The scores are cleared.')) return;
        return send('lobby');
      case 'lock':
        return send('lock', { on: !state.locked });
      case 'pause':
        return send('pause', { on: state.round.pausedLeft == null });
      case 'add-time':
        return send('addTime', { secs: 30 });
      case 'player':
        if (me.id !== state.hostId) return;
        renderPlayerDialog(el.dataset.id);
        return $('#dlg-player').showModal();
      case 'bench':
        send('bench', { id: playerId });
        return $('#dlg-player').close();
      case 'give-host':
        send('giveHost', { id: playerId });
        return $('#dlg-player').close();
      case 'kick': {
        const p = playerOf(state, playerId);
        if (!p?.bot && !window.confirm('Remove this player? They won’t be able to rejoin from the same browser.')) return;
        send('kick', { id: playerId });
        return $('#dlg-player').close();
      }
      case 'create-from-notice':
        if (cfg.needsPassword) return (location.href = api('.'));
        return createRoom().then(goToRoom, (err) => toast(err.message, { error: true }));
      case 'reload':
        return location.reload();
    }
  });

  $('#invite').addEventListener('click', copyInvite);
  $('#settings-body').addEventListener('change', onSettingsChange);

  $('#blind-form').addEventListener('submit', () => {
    if (canFlip(ui.blindSlot)) send('flip', { slot: ui.blindSlot });
  });

  $('#name-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('#name-input').value.replace(/\s+/g, ' ').trim().slice(0, 20);
    if (!name) return $('#name-input').focus();
    store.set('name', name);
    const dialog = $('#dlg-name');
    dialog.close();
    if (dialog.dataset.rename && conn && state) send('rename', { name });
    else connect(currentRoomCode(), name);
  });
  // The name prompt can't be dismissed until you have a name.
  $('#dlg-name').addEventListener('cancel', (event) => {
    if (!$('#dlg-name').dataset.rename) event.preventDefault();
  });

  document.addEventListener('keydown', (event) => {
    if (!state || document.querySelector('dialog[open]') || !myTurn(state, me)) return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.key === 'Enter' && ui.selected.size && !(event.target instanceof HTMLButtonElement)) playSelected();
    if (event.key === 'Escape' && ui.selected.size) {
      const r = state.round;
      const keep = r.pending?.pid === me.id ? r.seats[me.id].blind[r.pending.slot].id : null;
      ui.selected = new Set(keep ? [keep] : []);
      renderSelection();
    }
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      sizeCards();
      fitHand();
    }, 80);
  });
  document.addEventListener('visibilitychange', updateTitle);
  // Back in front of the game: its notification has done its job.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state) push.clearShown(`swipe-${state.code}`);
  });
  window.addEventListener('swipe:installable', () => state && refreshPushUi());
}

boot();
