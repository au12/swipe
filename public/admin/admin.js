// The admin page. Asks the server what is going on every few seconds and
// draws it; every button sends one change and then asks again.

import { $, $$, esc, icon, initials, onColor, plural, store, toast } from '../js/util.js';

const REFRESH_MS = 3000;
const api = (path) => new URL(`admin/api/${path}`, document.baseURI);
/** A color the server sent, only if it is one: it goes into a style attribute. */
const hex = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#888888');
const roomLink = (code) => new URL(`r/${encodeURIComponent(code)}`, document.baseURI).toString();

let data = null; // the last answer from the server
let skew = 0; // server clock minus this one
let lastOk = 0;
let timer = null;
let signature = { rooms: '', server: '', log: '', tally: '' };
const open = new Map(); // room code -> whether its player list is unfolded (when the admin has said)
const picked = new Map(); // room code -> the stats keys ticked for making into one player
let editing = null; // { code, id } or { code, key }: the name being changed, if one is
const view = { tab: store.get('adminTab', 'rooms'), search: '', filter: 'all' };

// ───────────────────────── talking to the server ─────────────────────────

async function call(path, body) {
  const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Swipe-Admin': '1' }, body: JSON.stringify(body) };
  const res = await fetch(api(path), { credentials: 'same-origin', cache: 'no-store', ...init });
  const answer = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'login') {
    showGate();
    throw new Error('You have been signed out. Sign in again.');
  }
  if (!res.ok) throw new Error(answer.error || 'That did not work. Try again.');
  return answer;
}

/** One change, then a fresh look at the server. Returns the answer, or null if it failed (the reason is shown). */
async function change(body, done) {
  try {
    const answer = await call('act', body);
    if (done) toast(typeof done === 'function' ? done(answer) : done);
    await refresh();
    return answer;
  } catch (err) {
    toast(err.message, { error: true });
    return null;
  }
}

async function refresh() {
  try {
    const next = await call('state');
    skew = next.now - Date.now();
    lastOk = Date.now();
    data = next;
    $('#lost').hidden = true;
    render();
  } catch {
    if ($('#desk').hidden) return;
    $('#lost').hidden = Date.now() - lastOk < REFRESH_MS * 2.5;
  }
}

function startPolling() {
  clearInterval(timer);
  timer = setInterval(() => {
    if (document.visibilityState === 'visible' && !$('#desk').hidden) refresh();
  }, REFRESH_MS);
}

// ───────────────────────── words for times and sizes ─────────────────────────

const serverNow = () => Date.now() + skew;

function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 6 * 3600) return `${Math.floor(s / 3600)} h${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)} min` : ''}`;
  const h = Math.round(s / 3600);
  if (h < 48) return `${h} h`;
  if (h < 14 * 24) return `${Math.floor(h / 24)} d${h % 24 ? ` ${h % 24} h` : ''}`;
  return `${Math.round(h / 24)} days`;
}
const ago = (t) => (serverNow() - t < 5000 ? 'just now' : `${span(serverNow() - t)} ago`);
const until = (t) => (t - serverNow() <= 0 ? 'any minute now' : `in ${span(t - serverNow())}`);

const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const longFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'medium' });
const when = (t) => dateFormat.format(new Date(t));
/** A time that keeps itself up to date: "5 min ago", with the full date on hover. */
const rel = (t, kind = 'ago') => `<time data-rel="${kind}" data-t="${Number(t)}" title="${esc(longFormat.format(new Date(t)))}">${esc(kind === 'ago' ? ago(t) : until(t))}</time>`;

function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/** For <input type="datetime-local">: this browser's own time, no zone. */
function localStamp(t) {
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** What the server will make of a typed room name. (The same steps as names.js.) */
const slug = (raw) =>
  String(raw ?? '')
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

// ───────────────────────── drawing ─────────────────────────

function render() {
  if (!data) return;
  const s = data.server;
  const t = data.totals;

  const tally = [
    [t.rooms, t.rooms === 1 ? 'room' : 'rooms', `of ${s.maxRooms} allowed`],
    [t.inUse, 'in use now', ''],
    [t.online, t.online === 1 ? 'person online' : 'people online', t.bots ? `and ${plural(t.bots, 'computer player')}` : ''],
    [t.games, t.games === 1 ? 'game being played' : 'games being played', ''],
  ];
  const tallyHtml = tally.map(([n, label, note]) => `<div><dt>${esc(label)}${note ? ` <small>${esc(note)}</small>` : ''}</dt><dd>${n}</dd></div>`).join('');
  if (signature.tally !== tallyHtml) $('#tally').innerHTML = signature.tally = tallyHtml;

  // Each part is drawn on its own: a slip in one never leaves the others stale.
  for (const part of [renderRooms, renderServer, renderLog, tick]) {
    try {
      part();
    } catch (err) {
      console.error(err);
    }
  }
}

function statusLine(room) {
  const name = (id) => room.players.find((p) => p.id === id)?.name ?? 'someone';
  if (room.status === 'lobby') return room.players.length ? 'In the lobby' : 'Nobody has joined yet';
  if (room.status === 'dealing') return `Dealing game ${room.gameNo}`;
  if (room.status === 'results') return room.matchOver ? `Match over after ${plural(room.gameNo, 'game')}` : `Between games (${room.gameNo} played)`;
  const clock = room.clock?.pausedLeft != null ? ', clock paused' : '';
  return `Playing game ${room.gameNo}, ${name(room.turn)} to play${clock}`;
}

function expiryLine(room) {
  if (room.expiry === 'never') return '<b>Never expires</b>';
  const stuck = room.expiresAt <= serverNow() && room.inUse;
  const text = stuck ? 'Expires when it empties' : `Expires ${rel(room.expiresAt, 'until')}`;
  const note = room.expiry === 'at' ? `set by you: ${esc(when(room.expiresAt))}` : `${data.server.roomTtlHours} h after it was last used`;
  return `${text} <small>${note}</small>`;
}

/** "5 games, went out 2 (40%), 12.4 average", or a dash for someone who has not finished a game. */
function recordLine(x) {
  if (!x.games) return '<span class="muted">No games yet</span>';
  return `<b>${Number(x.wins)}</b> out of ${plural(Number(x.games), 'game')} <small>${Math.round((x.wins / x.games) * 100)}% won, ${(Math.round((x.points / x.games) * 10) / 10).toFixed(1)} points a game</small>`;
}

/** The tick box that marks someone for being made into one player with others. Computer players have none. */
function pickBox(room, x) {
  if (x.bot) return '<td class="ppick"></td>';
  const on = picked.get(room.code)?.has(x.key);
  return `<td class="ppick"><input type="checkbox" data-pick data-code="${esc(room.code)}" data-key="${esc(x.key)}"${on ? ' checked' : ''} aria-label="Tick ${esc(x.name)} to make into one player with others"></td>`;
}

/** A name that turns into a box to type in when it is clicked, with a tick to save and a cross to cancel. */
function nameCell(room, x, ref) {
  const mine = editing && editing.code === room.code && ((ref.id && editing.id === ref.id) || (ref.key && editing.key === ref.key));
  const attrs = `data-code="${esc(room.code)}"${ref.id ? ` data-id="${esc(ref.id)}"` : ''}${ref.key ? ` data-key="${esc(ref.key)}"` : ''}`;
  if (mine) {
    return `<form class="name-edit" ${attrs}>
      <input type="text" name="name" maxlength="20" value="${esc(x.name)}" autocomplete="off" spellcheck="false" aria-label="New name for ${esc(x.name)}">
      <button class="tool tool-small name-save" type="submit" title="Save the name">${icon('check')}<span class="sr">Save</span></button>
      <button class="tool tool-small" type="button" data-act="rename-cancel" title="Cancel">${icon('close')}<span class="sr">Cancel</span></button>
    </form>`;
  }
  return `<button class="pname pname-btn" type="button" data-act="rename-player" ${attrs} title="Click to rename">${esc(x.name)}</button>`;
}

function playerRow(room, p) {
  const badges = [
    p.host ? '<span class="tagp">host</span>' : '',
    p.bot ? '<span class="tagp">computer</span>' : '',
    !p.bot && !p.playing ? '<span class="tagp">watching</span>' : '',
    p.notify ? `<span class="tagp tagp-icon" title="Turn notifications are on">${icon('bell')}</span>` : '',
  ].join('');
  let status;
  if (p.bot) status = '<span class="muted">always here</span>';
  else if (p.online) status = `<span class="on">Online</span>${p.tabs > 1 ? ` <small>${p.tabs} tabs</small>` : ''}${p.watching ? '' : ' <small>not looking</small>'}`;
  else status = `<span class="muted">Left ${rel(p.seenAt)}</span>`;
  const where = p.ips.length ? p.ips.map((ip) => `<code>${esc(ip)}</code>`).join(' ') : '<span class="muted">—</span>';
  const game = [p.cards != null ? plural(p.cards, 'card') : '', p.score != null ? `${p.score} pts` : ''].filter(Boolean).join(', ');
  const turn = room.turn === p.id ? ' is-turn' : '';
  const c = esc(room.code);
  return `<tr class="${p.online || p.bot ? '' : 'is-away'}${turn}">
    ${pickBox(room, p)}
    <th scope="row"><span class="pdot" style="--p:${hex(p.color)};--on-p:${onColor(hex(p.color))}">${esc(initials(p.name))}</span>${p.bot ? `<span class="pname">${esc(p.name)}</span>` : nameCell(room, p, { id: p.id })}${badges}</th>
    <td data-label="Status">${status}</td>
    <td data-label="Address" class="${p.online ? '' : 'is-old'}">${where}</td>
    <td data-label="Browser">${p.device ? esc(p.device) : '<span class="muted">—</span>'}</td>
    <td data-label="In the game">${game ? esc(game) : '<span class="muted">—</span>'}</td>
    <td data-label="All-time" class="prec">${recordLine(p)}</td>
    <td class="pacts">
      ${p.bot || p.host ? '' : `<button class="link" type="button" data-act="host" data-code="${c}" data-id="${esc(p.id)}">Make host</button>`}
      ${p.games ? `<button class="link" type="button" data-act="reset-stats" data-code="${c}" data-key="${esc(p.key)}">Reset stats</button>` : ''}
      <button class="link link-danger" type="button" data-act="kick" data-code="${c}" data-id="${esc(p.id)}">Remove</button>
    </td>
  </tr>`;
}

/** Someone with a record here who is not in the room now: gone long ago, or back under another name. */
function absentRow(room, x) {
  const c = esc(room.code);
  return `<tr class="is-away is-absent">
    ${pickBox(room, x)}
    <th scope="row"><span class="pdot is-away" style="--p:${hex(x.color)};--on-p:${onColor(hex(x.color))}">${esc(initials(x.name))}</span>${x.bot ? `<span class="pname">${esc(x.name)}</span><span class="tagp">computer</span>` : nameCell(room, x, { key: x.key })}</th>
    <td data-label="Status"><span class="muted">Not in the room</span></td>
    <td data-label="Address"><span class="muted">—</span></td>
    <td data-label="Browser"><span class="muted">—</span></td>
    <td data-label="In the game"><span class="muted">—</span></td>
    <td data-label="All-time" class="prec">${recordLine(x)}</td>
    <td class="pacts"><button class="link" type="button" data-act="reset-stats" data-code="${c}" data-key="${esc(x.key)}">Reset stats</button></td>
  </tr>`;
}

/** Everyone in a room who has a seat or a record, as the consolidate dialog needs them. */
const peopleOf = (room) => [...room.players.filter((p) => !p.bot).map((p) => ({ ...p, live: true })), ...room.absent.filter((x) => !x.bot).map((x) => ({ ...x, live: false, online: false }))];
/** The ticked ones that are still there. */
const pickedIn = (room) => {
  const keys = picked.get(room.code);
  return keys ? [...new Set(peopleOf(room).filter((x) => keys.has(x.key)).map((x) => x.key))] : [];
};

function roomCard(room) {
  const mover = room.players.find((p) => p.id === room.turn);
  const turnColor = mover ? hex(mover.color) : null;
  const people = room.players.filter((p) => !p.bot);
  const unfolded = open.has(room.code) ? open.get(room.code) : room.inUse;
  const chips = room.players
    .map((p) => `<span class="pdot${p.online || p.bot ? '' : ' is-away'}" style="--p:${hex(p.color)};--on-p:${onColor(hex(p.color))}" title="${esc(p.name)}${p.bot ? ' (computer)' : p.online ? '' : ' (offline)'}">${p.bot ? icon('bot') : esc(initials(p.name))}</span>`)
    .join('');
  const who = room.players.length
    ? `${plural(people.length, 'person', 'people')}, ${room.online} online${room.players.length > people.length ? `, ${plural(room.players.length - people.length, 'computer player')}` : ''}`
    : 'Nobody here';
  const c = esc(room.code);
  return `<article class="aroom${room.inUse ? ' is-used' : ''}" data-code="${c}" style="${turnColor ? `--turn:${turnColor}` : ''}">
    <header class="room-head">
      <div class="room-name">
        <h2>${c}</h2>
        <button class="tool tool-small" type="button" data-act="copy" data-code="${c}" title="Copy the room link">${icon('copy')}<span class="sr">Copy the link to ${c}</span></button>
        <a class="link room-open" href="${esc(roomLink(room.code))}" target="_blank" rel="noopener">Open</a>
      </div>
      <p class="room-state">${room.inUse ? '<span class="live" aria-hidden="true"></span>' : ''}${esc(statusLine(room))}${room.locked ? ` <span class="tagp tagp-warn">${icon('lock')} locked</span>` : ''}</p>
    </header>
    <dl class="room-facts">
      <div><dt>Last used</dt><dd>${room.inUse ? 'In use now' : rel(room.lastActive)}</dd></div>
      <div><dt>Expiry</dt><dd>${expiryLine(room)}</dd></div>
      <div><dt>Created</dt><dd>${rel(room.createdAt)}</dd></div>
      <div><dt>Rules</dt><dd>To ${Number(room.settings.limit)} points, ${room.settings.turnSeconds ? `${Number(room.settings.turnSeconds)} s turn clock` : 'no turn clock'}</dd></div>
    </dl>
    ${room.aliases.length ? `<p class="room-alias">Also answers to ${room.aliases.map((a) => `<code>${esc(a)}</code>`).join(', ')}</p>` : ''}
    <div class="room-acts">
      <button class="btn btn-small" type="button" data-act="expiry" data-code="${c}">Change expiry</button>
      <button class="btn btn-small" type="button" data-act="rename" data-code="${c}">Rename</button>
      <button class="btn btn-small" type="button" data-act="message" data-code="${c}"${room.online ? '' : ' disabled title="Nobody is in this room to read it"'}>Message</button>
      <button class="btn btn-small" type="button" data-act="lock" data-code="${c}" data-on="${room.locked ? '0' : '1'}">${room.locked ? 'Unlock' : 'Lock'}</button>
      ${room.live ? `<button class="btn btn-small" type="button" data-act="end-game" data-code="${c}">End this game</button>` : ''}
      ${room.gameNo ? `<button class="btn btn-small" type="button" data-act="reset" data-code="${c}">Back to the lobby</button>` : ''}
      ${room.banned ? `<button class="btn btn-small" type="button" data-act="unban" data-code="${c}">Let ${plural(room.banned, 'removed player')} back in</button>` : ''}
      <button class="btn btn-small btn-danger" type="button" data-act="delete" data-code="${c}">Delete</button>
    </div>
    ${
      room.players.length || room.absent.length
        ? `<details class="room-people"${unfolded ? ' open' : ''} data-code="${c}">
      <summary><span class="chips">${chips}</span><span class="who">${esc(who)}${room.absent.length ? `, and ${plural(room.absent.length, 'record')} of people not here now` : ''}</span></summary>
      <div class="ptable-wrap"><table class="ptable">
        <thead><tr><th scope="col"><span class="sr">Tick to make into one player</span></th><th scope="col">Player</th><th scope="col">Status</th><th scope="col">Address</th><th scope="col">Browser</th><th scope="col">In the game</th><th scope="col">All-time</th><th scope="col"><span class="sr">Actions</span></th></tr></thead>
        <tbody>${room.players.map((p) => playerRow(room, p)).join('')}${room.absent.map((x) => absentRow(room, x)).join('')}</tbody>
      </table></div>
      <div class="people-acts">
        <span class="muted small">Tick two or more players who are the same person, then</span>
        <button class="btn btn-small" type="button" data-act="consolidate" data-code="${c}"${pickedIn(room).length >= 2 ? '' : ' disabled'}>Consolidate${pickedIn(room).length >= 2 ? ` ${pickedIn(room).length} players` : ''}</button>
        <span class="people-gap"></span>
        <button class="btn btn-small btn-danger" type="button" data-act="reset-all-stats" data-code="${c}"${room.statsKept ? '' : ' disabled'}>Reset all stats</button>
      </div>
    </details>`
        : `<p class="room-nobody muted">${esc(who)}</p>`
    }
  </article>`;
}

function shownRooms() {
  const q = view.search.trim().toLowerCase();
  return data.rooms
    .filter((room) => {
      if (view.filter === 'used' && !room.inUse) return false;
      if (view.filter === 'empty' && room.inUse) return false;
      if (view.filter === 'kept' && room.expiry === 'default') return false;
      if (!q) return true;
      const hay = [room.code, ...room.aliases, ...room.players.flatMap((p) => [p.name, ...p.ips, p.device]), ...room.absent.map((x) => x.name)].join('\n').toLowerCase();
      return hay.includes(q);
    })
    .sort((a, b) => Number(b.inUse) - Number(a.inUse) || b.lastActive - a.lastActive);
}

function renderRooms() {
  const list = shownRooms();
  let html;
  if (!data.rooms.length) html = '<p class="empty">No rooms yet. People make one from the home page, or you can make one here with <b>New room</b>.</p>';
  else if (!list.length) html = '<p class="empty">No room matches that. Clear the search or choose <b>All rooms</b>.</p>';
  else html = list.map(roomCard).join('');
  // Times tick on their own (see tick), so they are left out of the comparison.
  const sig = html.replace(/<time[^>]*>[^<]*<\/time>/g, (m) => m.replace(/>[^<]*</, '><'));
  if (sig === signature.rooms) return;
  // Don't pull the page out from under a button that is being pressed or a field in use.
  const busy = document.activeElement && $('#rooms').contains(document.activeElement) && document.activeElement.matches(':active');
  if (busy) return;
  // A name is being typed: leave the list as it is until that is saved or cancelled.
  if (editing && $('#rooms .name-edit')) return;
  const focus = document.activeElement?.closest?.('#rooms [data-act]');
  const ticked = document.activeElement?.closest?.('#rooms [data-pick]');
  signature.rooms = sig;
  $('#rooms').innerHTML = html;
  if (ticked) $$('#rooms [data-pick]').find((el) => el.dataset.code === ticked.dataset.code && el.dataset.key === ticked.dataset.key)?.focus({ preventScroll: true });
  if (focus) {
    const again = $$('#rooms [data-act]').find((el) => el.dataset.act === focus.dataset.act && el.dataset.code === focus.dataset.code && el.dataset.id === focus.dataset.id);
    again?.focus({ preventScroll: true });
  }
}

function renderServer() {
  const s = data.server;
  const yes = (v, on = 'On', off = 'Off') => (v ? on : off);
  const groups = [
    [
      'Running',
      [
        ['Version', `${esc(s.siteName)} ${esc(s.version)}`],
        ['Started', `${rel(s.startedAt)} <small>${esc(when(s.startedAt))}</small>`],
        ['Node.js', esc(s.node)],
        ['System', `${esc(s.platform)} <small>host ${esc(s.hostname)}, process ${s.pid}</small>`],
        ['Memory', `${size(s.memory.rss)} <small>${size(s.memory.heap)} of it in use by the game</small>`],
        ['Load', s.load.toFixed(2)],
        ['Open connections', `${data.totals.sockets}`],
      ],
    ],
    [
      'Saving',
      [
        ['Rooms are saved', s.persist ? 'To a file, a moment after anything changes' : '<b class="warn">No. PERSIST is off: a restart loses every room</b>'],
        ['File', s.persist ? `<code>${esc(s.filePath)}</code>${s.file ? ` <small>${size(s.file.size)}</small>` : ' <small>not written yet</small>'}` : '<span class="muted">—</span>'],
        ['Last saved', s.saveError ? `<b class="warn">Failed: ${esc(s.saveError)}</b>` : s.savedAt ? rel(s.savedAt) : '<span class="muted">Not since the server started</span>'],
      ],
    ],
    [
      'Rooms',
      [
        ['A room expires', `${s.roomTtlHours} hours after it was last used <small>ROOM_TTL_HOURS</small>`],
        ['Rooms allowed', `${s.maxRooms} <small>MAX_ROOMS</small>`],
        ['People per room', `${s.maxPlayers} <small>MAX_PLAYERS_PER_ROOM</small>`],
        ['Creating a room', s.createPassword ? 'Needs the server password' : 'Open to anyone who can reach the site'],
        ['Shuffle and deal', `${(s.dealMs / 1000).toFixed(1)} s <small>DEAL_MS</small>`],
        ['Computer players wait', `${(s.botDelayMs / 1000).toFixed(1)} s a move <small>BOT_DELAY_MS</small>`],
      ],
    ],
    [
      'Notifications',
      [
        ['Turn notifications', yes(s.push)],
        ['Browsers signed up', `${s.subscriptions}`],
        ['Contact given to push services', s.pushContact ? esc(s.pushContact) : '<span class="muted">The site’s own address</span>'],
      ],
    ],
    [
      'Network',
      [
        ['Listening on', `<code>${esc(s.listen)}</code>`],
        ['Base path', `<code>${esc(s.basePath)}</code>`],
        ['Proxies trusted', s.trustProxy ? `${s.trustProxy} <small>TRUST_PROXY: addresses come from X-Forwarded-For</small>` : 'None <small>addresses are the connection’s own</small>'],
        ['Allowed origins', s.allowedOrigins.length ? s.allowedOrigins.map((o) => `<code>${esc(o)}</code>`).join(' ') : 'Any'],
        ['Messages per connection', `${s.messageBudget} every 5 s <small>MESSAGE_BUDGET</small>`],
        ['Admin sessions', `${s.admins} signed in <small>each lasts ${s.sessionHours} h</small>`],
        ['Log level', esc(s.logLevel)],
      ],
    ],
  ];
  const html = groups
    .map(([title, rows]) => `<section class="fact-group"><h2>${title}</h2><dl>${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl></section>`)
    .join('');
  const sig = html.replace(/<time[^>]*>[^<]*<\/time>/g, '');
  if (sig === signature.server) return;
  signature.server = sig;
  $('#server').innerHTML = html;
}

const q = (s) => `<code>${esc(s)}</code>`;
function eventText(e) {
  const from = e.ip ? ` from ${q(e.ip)}` : '';
  switch (e.kind) {
    case 'room.created':
      return `Room ${q(e.code)} was created`;
    case 'room.removed':
      return `Room ${q(e.code)} ${e.why === 'expired' ? 'expired and was removed' : 'was removed to make space'}`;
    case 'admin.signin':
      return `Admin signed in${from}`;
    case 'admin.signout':
      return `Admin signed out${from}`;
    case 'admin.denied':
      return `<b class="warn">Wrong admin password</b>${from}${e.n > 1 ? `, ${Number(e.n)} times` : ''}`;
    case 'admin.backup':
      return 'A backup was downloaded';
    case 'admin.server.create':
      return `You created room ${q(e.code)}`;
    case 'admin.server.save':
      return 'You saved the rooms to disk';
    case 'admin.server.message':
      return `You told everyone (${plural(e.reached, 'person', 'people')}): “${esc(e.text)}”`;
    case 'admin.server.cleanup':
      return `You cleaned up: ${plural(Number(e.removed), 'room')} idle for ${Number(e.hours)} h or more removed`;
    case 'admin.server.signout':
      return `You signed out ${plural(e.others, 'other admin session')}`;
    case 'admin.room.expiry':
      return `You set ${q(e.code)} to ${e.mode === 'never' ? 'never expire' : e.mode === 'at' ? `expire on ${esc(when(e.until))}` : 'expire the usual way'}`;
    case 'admin.room.rename':
      return `You renamed ${q(e.was)} to ${q(e.code)}${e.keepOld ? '' : ' and retired its old links'}`;
    case 'admin.room.delete':
      return `You deleted room ${q(e.code)}`;
    case 'admin.room.lock':
      return `You ${e.on ? 'locked' : 'unlocked'} ${q(e.code)}`;
    case 'admin.room.message':
      return `You told ${q(e.code)} (${plural(e.reached, 'person', 'people')}): “${esc(e.text)}”`;
    case 'admin.room.endGame':
      return `You ended the game in ${q(e.code)}`;
    case 'admin.room.reset':
      return `You sent ${q(e.code)} back to the lobby`;
    case 'admin.room.unban':
      return `You let ${plural(e.n, 'removed player')} back into ${q(e.code)}`;
    case 'admin.room.statsReset':
      return e.name ? `You reset ${esc(e.name)}’s stats in ${q(e.code)}` : `You reset all stats in ${q(e.code)} (${plural(Number(e.n), 'player')})`;
    case 'admin.room.consolidate':
      return `You made ${Number(e.merged)} players into one in ${q(e.code)}: ${esc(e.name)}`;
    case 'admin.room.renamePlayer':
      return `You renamed ${esc(e.was)} to ${esc(e.name)} in ${q(e.code)}`;
    case 'admin.room.host':
      return `You made ${esc(e.name)} the host of ${q(e.code)}`;
    case 'admin.room.kick':
      return `You removed ${esc(e.name)} from ${q(e.code)}${e.ban ? '' : ' (free to rejoin)'}`;
    default:
      return esc(e.kind);
  }
}

function renderLog() {
  const html = data.events.length
    ? data.events.map((e) => `<li><span class="ev-time" title="${esc(longFormat.format(new Date(e.at)))}">${esc(when(e.at))}</span><span>${eventText(e)}</span></li>`).join('')
    : '<li class="empty">Nothing has happened since the server started.</li>';
  if (html === signature.log) return;
  signature.log = html;
  $('#log').innerHTML = html;
}

/** Keeps "5 min ago" honest between answers from the server. */
function tick() {
  for (const el of $$('time[data-rel]')) {
    const t = Number(el.dataset.t);
    const text = el.dataset.rel === 'ago' ? ago(t) : until(t);
    if (el.textContent !== text) el.textContent = text;
  }
  if (lastOk) $('#fresh').textContent = Date.now() - lastOk < REFRESH_MS * 2 ? 'Live' : `Last updated ${span(Date.now() - lastOk)} ago`;
  $('#fresh').classList.toggle('is-stale', Boolean(lastOk) && Date.now() - lastOk >= REFRESH_MS * 2);
}

function showTab(tab) {
  view.tab = ['rooms', 'server', 'log'].includes(tab) ? tab : 'rooms';
  store.set('adminTab', view.tab);
  for (const button of $$('.tabs [data-tab]')) button.setAttribute('aria-selected', String(button.dataset.tab === view.tab));
  for (const name of ['rooms', 'server', 'log']) $(`#tab-${name}`).hidden = name !== view.tab;
}

// ───────────────────────── dialogs ─────────────────────────

const dlg = $('#dlg');
let onSubmit = null;

/**
 * Opens the one dialog with a title, a body and a button. `submit` gets the
 * form's fields; it returns true to close, or throws with the reason to show.
 */
function ask({ title, body, ok, danger = false, submit, ready }) {
  $('#dlg-title').textContent = title;
  // A fresh element each time, so one dialog's listeners never outlive it.
  $('#dlg-body').innerHTML = '<div class="dlg-body"></div>';
  const inner = $('#dlg-body').firstElementChild;
  inner.innerHTML = body;
  $('#dlg-error').hidden = true;
  const button = $('#dlg-ok');
  button.textContent = ok;
  button.disabled = false;
  button.className = `btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`;
  onSubmit = submit;
  if (!dlg.open) dlg.showModal();
  ready?.(inner);
  ($('[autofocus]', inner) ?? button).focus();
}

$('#dlg-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#dlg-ok');
  button.disabled = true;
  try {
    const fields = Object.fromEntries(new FormData(event.target));
    const answer = await call('act', onSubmit(fields));
    dlg.close();
    if (onSubmit.done) toast(onSubmit.done(answer));
    await refresh();
  } catch (err) {
    $('#dlg-error').textContent = err.message;
    $('#dlg-error').hidden = false;
    button.disabled = false;
  }
});

const roomOf = (code) => data?.rooms.find((room) => room.code === code);
const onlineNames = (room) => room.players.filter((p) => p.online).map((p) => p.name);
const listNames = (names) => (names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`);

function askExpiry(room) {
  const start = room.expiry === 'at' ? room.expiresAt : serverNow() + 7 * 86400_000;
  const submit = (f) => ({ do: 'room.expiry', code: room.code, mode: f.mode, at: f.mode === 'at' ? new Date(f.at).getTime() : undefined });
  submit.done = () => 'Expiry changed';
  ask({
    title: `When should ${room.code} expire?`,
    ok: 'Save expiry',
    body: `
      <label class="choice"><input type="radio" name="mode" value="default"${room.expiry === 'default' ? ' checked' : ''}><span><b>The usual way</b><small>${data.server.roomTtlHours} hours after it was last used. Every visit starts the count again${room.expiry === 'default' ? '' : ', and so does choosing this now'}.</small></span></label>
      <label class="choice"><input type="radio" name="mode" value="never"${room.expiry === 'never' ? ' checked' : ''}><span><b>Never</b><small>It stays until you delete it, through restarts and however long it sits empty.</small></span></label>
      <label class="choice"><input type="radio" name="mode" value="at"${room.expiry === 'at' ? ' checked' : ''}><span><b>On a date</b><small>It stays until then, used or not, and goes after that.</small></span></label>
      <div class="when" id="when">
        <input type="datetime-local" name="at" value="${localStamp(start)}" min="${localStamp(Date.now())}" aria-label="Date and time">
        <div class="quick">
          <button class="btn btn-small" type="button" data-add="1">+1 day</button>
          <button class="btn btn-small" type="button" data-add="7">+1 week</button>
          <button class="btn btn-small" type="button" data-add="30">+30 days</button>
          <button class="btn btn-small" type="button" data-add="365">+1 year</button>
        </div>
      </div>
      <p class="muted small">A room is never removed while someone is in it. If its time comes then, it goes when the last person leaves.</p>`,
    ready: (body) => {
      const at = $('[name=at]', body);
      const sync = () => ($('#when', body).hidden = $('[name=mode]:checked', body)?.value !== 'at');
      body.addEventListener('change', sync);
      body.addEventListener('click', (event) => {
        const add = event.target.closest('[data-add]');
        if (!add) return;
        const from = Math.max(Date.now(), new Date(at.value).getTime() || 0);
        at.value = localStamp(from + Number(add.dataset.add) * 86400_000);
      });
      sync();
    },
    submit,
  });
}

function askRename(room) {
  const submit = (f) => ({ do: 'room.rename', code: room.code, name: f.name, keepOld: f.keepOld === 'on' });
  submit.done = (answer) => `Renamed to ${answer.code}`;
  ask({
    title: `Rename ${room.code}`,
    ok: 'Rename',
    body: `
      <label class="field"><span>New name</span>
        <input type="text" name="name" maxlength="60" autocomplete="off" autocapitalize="none" spellcheck="false" value="${esc(room.code)}" autofocus></label>
      <p class="preview" id="preview"></p>
      <button class="btn btn-small" type="button" id="random-name">Give it a new random name</button>
      <label class="tick"><input type="checkbox" name="keepOld" checked><span>Keep the old link working<small>Untick this to cut off anyone who only has the old link. People in the room now move with it either way.</small></span></label>
      <p class="muted small">The name is the room’s link, so it is kept to lower-case letters, numbers and hyphens. Type anything and it is fitted to that. A short or obvious name is easy to guess: lock the room if that matters.</p>`,
    ready: (body) => {
      const input = $('[name=name]', body);
      const show = () => {
        const code = slug(input.value);
        // (A name this room used to have is its own to take back.)
        const taken = data.rooms.some((r) => r.code !== room.code && (r.code === code || r.aliases.includes(code)));
        $('#dlg-ok').disabled = code.length < 3 || code === room.code || taken;
        $('#preview', body).innerHTML =
          code.length < 3
            ? 'At least 3 letters or numbers.'
            : taken
              ? `<b class="warn">Another room is using ${esc(code)}.</b>`
              : code === room.code
                ? 'That is its name now.'
                : `Its link will be <code>${esc(roomLink(code))}</code>`;
      };
      input.addEventListener('input', show);
      $('#random-name', body).addEventListener('click', () => {
        const keepOld = $('[name=keepOld]', body).checked;
        dlg.close();
        change({ do: 'room.rename', code: room.code, random: true, keepOld }, (answer) => `Renamed to ${answer.code}`);
      });
      input.select();
      show();
    },
    submit,
  });
}

function askMessage(room) {
  const everyone = !room;
  const names = everyone ? [] : onlineNames(room);
  const submit = (f) => (everyone ? { do: 'server.message', text: f.text } : { do: 'room.message', code: room.code, text: f.text });
  submit.done = (answer) => (answer.reached ? `Shown to ${plural(answer.reached, 'person', 'people')}` : 'Nobody was there to see it');
  ask({
    title: everyone ? 'Message everyone' : `Message ${room.code}`,
    ok: 'Send',
    body: `
      <label class="field"><span>${everyone ? `Shown to all ${plural(data.totals.online, 'person', 'people')} online, in every room` : `Shown to ${esc(listNames(names))}`}</span>
        <textarea name="text" rows="3" maxlength="280" required autofocus placeholder="${everyone ? 'The server restarts in five minutes. Your game will be saved.' : 'Something this table should know'}"></textarea></label>
      <p class="muted small">It appears at the bottom of their screen for a few seconds. People who are not connected right now will not see it.</p>`,
    submit,
  });
}

function askDelete(room) {
  const names = onlineNames(room);
  const submit = () => ({ do: 'room.delete', code: room.code });
  submit.done = () => `Deleted ${room.code}`;
  ask({
    title: `Delete ${room.code}?`,
    ok: 'Delete room',
    danger: true,
    body: `<p>The room, its scores and any game on the table are gone for good. Its link stops working.</p>
      ${names.length ? `<p><b class="warn">${esc(listNames(names))} ${names.length === 1 ? 'is' : 'are'} in it right now</b> and will be shown that the room was closed.</p>` : '<p class="muted">Nobody is in it right now.</p>'}`,
    submit,
  });
}

function askKick(room, p) {
  const submit = (f) => ({ do: 'room.kick', code: room.code, id: p.id, ban: f.ban === 'on' });
  submit.done = () => `Removed ${p.name}`;
  ask({
    title: `Remove ${p.name} from ${room.code}?`,
    ok: 'Remove',
    danger: true,
    body: `<p>${p.bot ? 'This computer player leaves the table.' : 'They are put out of the room and lose their seat and score.'}${room.live && p.playing ? ' Their cards leave the game with them.' : ''}</p>
      ${p.bot ? '' : '<label class="tick"><input type="checkbox" name="ban" checked><span>Keep them out<small>Their browser cannot rejoin this room. Untick to let them walk back in with the link.</small></span></label>'}`,
    submit,
  });
}

function askCreate() {
  const submit = (f) => ({ do: 'server.create', name: f.name || undefined });
  submit.done = (answer) => `Created ${answer.code}`;
  ask({
    title: 'New room',
    ok: 'Create room',
    body: `
      <label class="field"><span>Name (leave empty for a random one)</span>
        <input type="text" name="name" maxlength="60" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="friday-night-cards" autofocus></label>
      <p class="preview" id="preview"></p>
      <p class="muted small">Whoever opens the link first becomes the host. Rooms made here do not need the server password.</p>`,
    ready: (body) => {
      const input = $('[name=name]', body);
      const show = () => {
        const code = slug(input.value);
        const taken = data.rooms.some((r) => r.code === code || r.aliases.includes(code));
        const bad = input.value.trim() !== '' && (code.length < 3 || taken);
        $('#dlg-ok').disabled = bad;
        $('#preview', body).innerHTML = !input.value.trim() ? '' : code.length < 3 ? 'At least 3 letters or numbers.' : taken ? `<b class="warn">Another room is using ${esc(code)}.</b>` : `Its link will be <code>${esc(roomLink(code))}</code>`;
      };
      input.addEventListener('input', show);
      show();
    },
    submit,
  });
}

function askCleanup() {
  const count = (hours) => data.rooms.filter((room) => !room.inUse && room.expiry === 'default' && serverNow() - room.lastActive >= hours * 3600_000).length;
  const submit = (f) => ({ do: 'server.cleanup', hours: Number(f.hours) });
  submit.done = (answer) => (answer.removed.length ? `Removed ${plural(answer.removed.length, 'room')}` : 'Nothing to remove');
  ask({
    title: 'Clean up idle rooms',
    ok: 'Remove them',
    danger: true,
    body: `
      <label class="field"><span>Remove rooms nobody has used for</span>
        <select name="hours">
          <option value="1">1 hour or more</option>
          <option value="6">6 hours or more</option>
          <option value="24" selected>a day or more</option>
          <option value="168">a week or more</option>
          <option value="0">any time at all (every empty room)</option>
        </select></label>
      <p class="preview" id="preview"></p>
      <p class="muted small">Rooms with someone in them are left alone, and so are rooms whose expiry you have set yourself.</p>`,
    ready: (body) => {
      const select = $('[name=hours]', body);
      const show = () => {
        const n = count(Number(select.value));
        $('#preview', body).textContent = n ? `That is ${plural(n, 'room')} right now.` : 'No rooms match right now.';
        $('#dlg-ok').disabled = n === 0;
      };
      select.addEventListener('change', show);
      show();
    },
    submit,
  });
}

/** Two or more ticked players who are really one person: which to keep, and under what name. */
function askConsolidate(room) {
  const keys = pickedIn(room);
  const all = peopleOf(room);
  // One line per record. (The same person can have two seats on one record; the first is enough to show.)
  const rows = keys.map((key) => all.find((x) => x.key === key));
  // Keep the seat that is in the match if there is one, else whoever has played most.
  const best = rows.slice().sort((a, b) => Number(b.score != null) - Number(a.score != null) || b.games - a.games || Number(b.live) - Number(a.live))[0];
  const total = rows.reduce((sum, x) => ({ games: sum.games + x.games, wins: sum.wins + x.wins, points: sum.points + x.points }), { games: 0, wins: 0, points: 0 });
  const seated = rows.filter((x) => x.live).length;
  const where = (x) => (x.live ? (x.online ? 'online now' : 'in the room, offline') : 'not in the room');
  const submit = (f) => ({ do: 'room.consolidate', code: room.code, keys, keep: f.keep, name: f.name });
  submit.done = (answer) => {
    picked.delete(room.code);
    return `Now one player: ${answer.name}`;
  };
  ask({
    title: `Make ${keys.length} players into one`,
    ok: 'Consolidate',
    danger: true,
    body: `
      <p>Their records are added together: <b>${total.wins}</b> out of ${plural(total.games, 'game')} in all. From now on, games played from any of their browsers count for the one player.</p>
      <fieldset class="keep-list"><legend>Keep</legend>
        ${rows
          .map(
            (x) => `<label class="choice"><input type="radio" name="keep" value="${esc(x.key)}" data-name="${esc(x.name)}"${x === best ? ' checked' : ''}>
          <span><b>${esc(x.name)}</b><small>${esc(where(x))}${x.score != null ? `, ${x.score} points in the match` : ''}. ${x.games ? `${x.wins} out of ${plural(x.games, 'game')}` : 'No games yet'}.</small></span></label>`,
          )
          .join('')}
      </fieldset>
      <label class="field"><span>Name to go by</span>
        <input type="text" name="name" maxlength="20" autocomplete="off" spellcheck="false" value="${esc(best.name)}"></label>
      ${
        seated > 1
          ? '<p class="muted small"><b class="warn">More than one of them has a seat in the room.</b> The one you keep stays, with its place and score in the match; the others leave the room, and any cards they hold in a game on the table leave with them. If the one you keep is offline and another is connected, the connected browser takes over the kept seat.</p>'
          : '<p class="muted small">Nobody is taken out of the room by this.</p>'
      }
      <p class="muted small">This cannot be undone.</p>`,
    ready: (body) => {
      const name = $('[name=name]', body);
      let typed = false;
      name.addEventListener('input', () => (typed = true));
      body.addEventListener('change', (event) => {
        if (event.target.name === 'keep' && !typed) name.value = event.target.dataset.name;
      });
    },
    submit,
  });
}

function askConfirm({ title, text, ok, body, done, danger = false }) {
  const submit = () => body;
  submit.done = () => done;
  ask({ title, ok, danger, body: `<p>${text}</p>`, submit });
}

// ───────────────────────── clicks ─────────────────────────

document.addEventListener('click', async (event) => {
  if (event.target.closest('[data-close]')) return dlg.close();
  const tab = event.target.closest('.tabs [data-tab]');
  if (tab) return showTab(tab.dataset.tab);

  const el = event.target.closest('[data-act]');
  if (!el) return;
  const room = el.dataset.code ? roomOf(el.dataset.code) : null;
  if (el.dataset.code && !room) return toast('That room is no longer here.', { error: true });
  const player = room && el.dataset.id ? room.players.find((p) => p.id === el.dataset.id) : null;

  switch (el.dataset.act) {
    case 'theme': {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      store.set('theme', next);
      return hydrateIcons();
    }
    case 'signout':
      await call('logout', {}).catch(() => {});
      return showGate();
    case 'signout-others':
      return change({ do: 'server.signout' }, (a) => (a.others ? `Signed out ${plural(a.others, 'other session')}` : 'No other sessions were signed in'));
    case 'save':
      return change({ do: 'server.save' }, 'Saved');
    case 'create':
      return askCreate();
    case 'cleanup':
      return askCleanup();
    case 'message-all':
      return askMessage(null);
    case 'copy':
      try {
        await navigator.clipboard.writeText(roomLink(room.code));
        toast('Link copied');
      } catch {
        window.prompt('The link to this room:', roomLink(room.code));
      }
      return;
    case 'expiry':
      return askExpiry(room);
    case 'rename':
      return askRename(room);
    case 'message':
      return askMessage(room);
    case 'delete':
      return askDelete(room);
    case 'lock':
      return change({ do: 'room.lock', code: room.code, on: el.dataset.on === '1' }, el.dataset.on === '1' ? 'Locked: nobody new can join' : 'Unlocked');
    case 'unban':
      return change({ do: 'room.unban', code: room.code }, 'They can use the link again');
    case 'end-game':
      return askConfirm({ title: `End the game in ${room.code}?`, text: 'The game on the table is called off and nobody scores for it. The match and its scores carry on.', ok: 'End the game', danger: true, body: { do: 'room.endGame', code: room.code }, done: 'Game ended' });
    case 'reset':
      return askConfirm({ title: `Send ${room.code} back to the lobby?`, text: 'Any game on the table is called off and the match scores are cleared. Everyone stays in the room.', ok: 'Back to the lobby', danger: true, body: { do: 'room.reset', code: room.code }, done: 'Back in the lobby' });
    case 'host':
      if (player) return change({ do: 'room.host', code: room.code, id: player.id }, `${player.name} is the host now`);
      return;
    case 'kick':
      if (player) return askKick(room, player);
      return;
    case 'rename-player':
      editing = el.dataset.id ? { code: room.code, id: el.dataset.id } : { code: room.code, key: el.dataset.key };
      return redrawRooms(() => {
        const input = $('#rooms .name-edit input');
        input?.focus();
        input?.select();
      });
    case 'rename-cancel':
      editing = null;
      return redrawRooms();
    case 'consolidate':
      if (pickedIn(room).length >= 2) return askConsolidate(room);
      return;
    case 'reset-stats': {
      const x = peopleOf(room).find((y) => y.key === el.dataset.key) ?? [...room.players, ...room.absent].find((y) => y.key === el.dataset.key);
      if (!x) return;
      return askConfirm({
        title: `Reset ${x.name}’s stats?`,
        text: `${esc(x.name)}’s all-time record in ${esc(room.code)} goes back to nothing: ${x.wins} out of ${plural(x.games, 'game')}, gone. Nobody else’s is touched, and the score in the match being played stays as it is. This cannot be undone.`,
        ok: 'Reset stats',
        danger: true,
        body: { do: 'room.statsReset', code: room.code, key: x.key },
        done: `${x.name}’s stats are reset`,
      });
    }
    case 'reset-all-stats':
      return askConfirm({
        title: `Reset all stats in ${room.code}?`,
        text: `The all-time record of every player in this room goes back to nothing: ${plural(room.statsKept, 'player')} in all. The score in the match being played stays as it is. This cannot be undone.`,
        ok: 'Reset all stats',
        danger: true,
        body: { do: 'room.statsReset', code: room.code },
        done: 'All stats in the room are reset',
      });
    default:
  }
});

/** Draws the room list again now, whatever the last answer from the server looked like. */
function redrawRooms(then) {
  signature.rooms = '';
  if (data) renderRooms();
  then?.();
}

// A name being changed: Enter or the tick saves it, Escape or the cross cancels.
document.addEventListener('submit', async (event) => {
  const form = event.target.closest?.('.name-edit');
  if (!form) return;
  event.preventDefault();
  const name = form.elements.name.value;
  const body = { do: 'room.renamePlayer', code: form.dataset.code, name };
  if (form.dataset.id) body.id = form.dataset.id;
  else body.key = form.dataset.key;
  try {
    const answer = await call('act', body);
    editing = null;
    toast(`Renamed to ${answer.name}`);
    signature.rooms = '';
    await refresh();
  } catch (err) {
    toast(err.message, { error: true });
    form.elements.name.focus();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && editing && event.target.closest?.('.name-edit')) {
    editing = null;
    redrawRooms();
  }
});

// Ticking players to make into one. The ticks are remembered here, so they survive the list being redrawn.
document.addEventListener('change', (event) => {
  const box = event.target.closest?.('[data-pick]');
  if (!box) return;
  const keys = picked.get(box.dataset.code) ?? new Set();
  if (box.checked) keys.add(box.dataset.key);
  else keys.delete(box.dataset.key);
  picked.set(box.dataset.code, keys);
  redrawRooms();
});

// Remember which player lists were unfolded or folded by hand.
document.addEventListener(
  'toggle',
  (event) => {
    const details = event.target;
    if (details.matches?.('.room-people')) open.set(details.dataset.code, details.open);
  },
  true,
);

$('#room-search').addEventListener('input', (event) => {
  view.search = event.target.value;
  if (data) renderRooms();
});
$('#room-filter').addEventListener('change', (event) => {
  view.filter = event.target.value;
  if (data) renderRooms();
});

// ───────────────────────── signing in ─────────────────────────

function hydrateIcons() {
  for (const el of $$('[data-icon]')) el.innerHTML = icon(el.dataset.icon === 'theme' ? (document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon') : el.dataset.icon);
}

function showGate(enabled = true) {
  clearInterval(timer);
  if (dlg.open) dlg.close();
  data = null;
  signature = { rooms: '', server: '', log: '', tally: '' };
  // Nothing about the rooms or the people in them stays in the page once it is signed out.
  for (const id of ['tally', 'rooms', 'server', 'log']) $(`#${id}`).innerHTML = '';
  $('#fresh').textContent = '';
  $('#desk').hidden = true;
  $('#gate').hidden = false;
  $('#login-form').hidden = !enabled;
  $('#gate-off').hidden = enabled;
  if (enabled) $('#login-password').focus();
}

async function showDesk() {
  $('#gate').hidden = true;
  $('#desk').hidden = false;
  $('#login-password').value = '';
  showTab(view.tab);
  await refresh();
  startPolling();
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#login-submit');
  button.disabled = true;
  $('#login-error').hidden = true;
  try {
    await call('login', { password: $('#login-password').value });
    await showDesk();
  } catch (err) {
    $('#login-error').textContent = err.message;
    $('#login-error').hidden = false;
    $('#login-password').select();
  }
  button.disabled = false;
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('#desk').hidden) refresh();
});
setInterval(tick, 1000);

hydrateIcons();
call('session')
  .then((session) => (session.authed ? showDesk() : showGate(session.enabled)))
  .catch(() => showGate(true));
