// The all-time stat board: who has gone out most often in this room, and who
// is left holding the fewest points when somebody else does.
//
// The numbers come from the server (one row per person who has finished a
// game here) and arrive on the game's own connection, at the start and again
// whenever they change.

import { $, esc, icon, initials, onColor, plural } from './util.js';

let rows = []; // { id, name, color, bot, here, games, wins, points }
let room = '';

const hex = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#888888');
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);

/** The latest board from the server. */
export function receive(msg) {
  rows = (Array.isArray(msg.rows) ? msg.rows : [])
    .filter((r) => r && typeof r.name === 'string' && num(r.games) > 0)
    .map((r) => ({ id: String(r.id), name: r.name, color: hex(r.color), bot: Boolean(r.bot), games: num(r.games), wins: num(r.wins), points: num(r.points) }));
  if ($('#dlg-stats')?.open) render();
}

export function reset() {
  rows = [];
}

export function open(code) {
  room = code ?? '';
  render();
  const dialog = $('#dlg-stats');
  if (!dialog.open) dialog.showModal();
}

const who = (r, extra = '') =>
  `<span class="st-who"><span class="avatar" style="--p:${r.color};--on-p:${onColor(r.color)}">${r.bot ? icon('bot') : esc(initials(r.name))}</span><span class="st-id"><span class="st-name">${esc(r.name)}${r.bot ? '<small>computer</small>' : ''}</span>${extra}</span></span>`;

/** A thin bar for one number against the largest it could be. The number itself is always written beside it. */
const bar = (value, max) => `<span class="st-bar" aria-hidden="true"><i style="width:${max > 0 ? Math.max(value > 0 ? 3 : 0, Math.min(100, (value / max) * 100)).toFixed(1) : 0}%"></i></span>`;

const rate = (r) => (r.games ? r.wins / r.games : 0);
const average = (r) => (r.games ? r.points / r.games : 0);
const percent = (x) => `${Math.round(x * 100)}%`;
const one = (x) => (Math.round(x * 10) / 10).toFixed(1);

function render() {
  const body = $('#stats-body');
  $('#stats-room').textContent = room;
  if (!rows.length) {
    body.innerHTML = '<p class="st-empty">No game has been finished in this room yet. The board starts with the first one somebody goes out of.</p>';
    return;
  }

  // Going out: best win rate first; level on rate, whoever has done it more often.
  const winners = rows.slice().sort((a, b) => rate(b) - rate(a) || b.wins - a.wins || a.name.localeCompare(b.name));
  const lead = rate(winners[0]) > 0 ? rate(winners[0]) : null;
  const wins = winners
    .map(
      (r, i) => `<tr title="${esc(`${r.name} went out in ${r.wins} of ${plural(r.games, 'game')}`)}">
        <td class="st-rank">${i + 1}</td>
        <th scope="row">${who(r, lead !== null && rate(r) === lead ? `<span class="st-crown" title="Best win rate">${icon('crown')}</span>` : '')}</th>
        <td class="st-num">${r.wins}</td>
        <td class="st-num">${r.games}</td>
        <td class="st-num st-rate"><span class="st-main">${percent(rate(r))}</span>${bar(rate(r), 1)}</td>
      </tr>`,
    )
    .join('');

  // Average points: lowest first. The two ends of the list get a ribbon each.
  const steady = rows.slice().sort((a, b) => average(a) - average(b) || b.games - a.games || a.name.localeCompare(b.name));
  const most = Math.max(...steady.map(average));
  const spread = steady.length > 1 && average(steady[0]) < average(steady.at(-1));
  const tag = (i) => {
    if (!spread) return '';
    if (i === 0) return `<span class="st-tag is-good">${icon('check')}Most Consistent</span>`;
    if (i === steady.length - 1) return `<span class="st-tag is-poor">${icon('trend')}Needs Improvement</span>`;
    return '';
  };
  const avgs = steady
    .map(
      (r, i) => `<tr class="${spread && i === 0 ? 'is-good' : spread && i === steady.length - 1 ? 'is-poor' : ''}" title="${esc(`${r.name}: ${r.points} points over ${plural(r.games, 'game')}`)}">
        <td class="st-rank">${i + 1}</td>
        <th scope="row"><span class="st-cell">${who(r)}${tag(i)}</span></th>
        <td class="st-num st-main">${one(average(r))}</td>
        <td class="st-num st-avgbar">${bar(average(r), most)}<small>over ${plural(r.games, 'game')}</small></td>
      </tr>`,
    )
    .join('');

  body.innerHTML = `
    <section class="st-section" aria-labelledby="st-h-out">
      <h3 id="st-h-out">Going out</h3>
      <p class="st-note">How often each player has been the one to get rid of every card. Best win rate first.</p>
      <table class="st-table st-wins">
        <colgroup><col class="st-c-rank"><col><col class="st-c-out"><col class="st-c-games"><col class="st-c-rate"></colgroup>
        <thead><tr><th scope="col"><span class="sr">Place</span></th><th scope="col">Player</th><th scope="col" class="st-num">Went out</th><th scope="col" class="st-num">Games</th><th scope="col" class="st-num">Win rate</th></tr></thead>
        <tbody>${wins}</tbody>
      </table>
    </section>
    <section class="st-section" aria-labelledby="st-h-avg">
      <h3 id="st-h-avg">Average points</h3>
      <p class="st-note">What each player is left holding at the end of a game, on average, counting the games they went out as zero. Lowest first: lower is better.</p>
      <table class="st-table st-avgs">
        <colgroup><col class="st-c-rank"><col><col class="st-c-avg"><col class="st-c-bar"></colgroup>
        <thead><tr><th scope="col"><span class="sr">Place</span></th><th scope="col">Player</th><th scope="col" class="st-num">Average</th><th scope="col"><span class="sr">Compared, and how many games</span></th></tr></thead>
        <tbody>${avgs}</tbody>
      </table>
    </section>`;
}
