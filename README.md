# Swipe

A self-hosted, real-time version of the card game Swipe for 2 to 24 players, played in the browser. Create a room, share the link, play from your phones.

Shed your cards onto the pile, equal or lower every time. Play a ten, or make four of a kind, and the whole pile is swiped off the table. First out wins the game; everyone else scores what they are left holding, and the lowest total wins the match.

Swipe is built on the same server as [Tradecraft](https://github.com/au12/tradecraft): one small Node process, rooms behind a link, no accounts, no database, no build step.

| Your turn | The swipe | Scores | Desktop |
| --- | --- | --- | --- |
| ![](docs/turn.png) | ![](docs/swipe.png) | ![](docs/results.png) | ![](docs/desktop.png) |

## What you get

**The game**

- The server runs the rules: sets of one to four equal cards, equal-or-lower on the pile, picking up when you play higher, tens, four of a kind (laid at once or built up across turns), blind cards, going out, scoring.
- Two decks for up to 4 players and one more for every two players after that, mixed together, half red-backed and half blue.
- A match runs over as many games as it takes for someone to reach the points limit (100 unless the host changes it). Every game is led by whoever was dealt the highest cards.
- Tap cards to build a set from your hand and your face-up row together. The button tells you what the set will do before you commit: go on the pile, swipe it, or cost you a pickup.
- Blind cards ask for confirmation, then flip for the whole table to see.
- Computer players, for filling a table or trying the game on your own.
- An optional turn clock. When it runs out that player is skipped, with a banner nobody can miss, and draws penalty cards. The host can pause it or add 30 seconds.
- Turn notifications: a push when it is your turn and you are not looking, even with the phone locked. See [Notifications and installing](#notifications-and-installing).
- A play-by-play log, newest move first, and a running scoreboard.
- All-time stats for each room, opened from the Scores panel: how often each player has gone out, how many games they have played and their win rate, best win rate first; and what each is left holding on average, lowest first, with a ribbon for the Most Consistent and one for whoever Needs Improvement.
- Chat for the room, just above the log. A new message also shows for a few seconds in a banner at the top of the screen, placed so it never covers a card, with a sound in the manner of an old instant messenger. Anyone who is away and has notifications on gets it as a notification.
- Tap the pile to see what is in it: how many of each rank you would be picking up, and what they add up to.

**The room**

- No accounts. A room is a link like `/r/lucky-riffle-42`.
- The first person in is the host: deal, add computer players, play a turn for someone who has wandered off, sit people out, remove them, hand over hosting, lock the room, change the points limit.
- Everyone gets a color of their own. The mat in the middle of the screen takes the color of whoever's turn it is.
- Players who drop reconnect into their seat with their hand. If the host disappears, hosting passes to someone else.
- People who arrive mid-match watch, and can ask to be dealt in from the next game. They start on the table's average score.
- A seat code moves your seat, cards and score to another browser or device.
- Nobody is ever sent a card they could not see at a real table: your own hand, everyone's face-up row, a blind card once it is flipped, and the top of the pile. Everything else leaves the server as a card back.

**The table**

- Laid out for a phone held upright: whose turn it is at the top, then the pile, the table cards, and the hand below. Buttons under each section switch between the current player's cards and your own.
- The shuffle is a full-screen casino wash: the deck bursts, swirls, is raked back in, cut and riffled, and then your own cards are dealt to you. Cards fly from where they are to where they are going, piles get scooped up, and a swipe looks like one.
- Sound effects are synthesised in the browser, so there are no audio files. Light and dark themes.

**Hosting**

- One dependency (`ws`). Fonts and card art are bundled. The only outside requests are the notifications themselves, sent to the browser makers' push services.
- Installable as an app on phones and desktops.
- Rooms are saved to a JSON file and survive a restart, including the clock. No database.
- An [admin page](#the-admin-page) at `/admin` shows every room and who is in it, and lets you rename, keep, message or delete them.
- Works behind a reverse proxy, on a sub-path if you want.

## How the rules were read

The rule sheet leaves a few things open. These are the calls the game makes; each is one small place in [`public/js/rules.js`](public/js/rules.js) or [`server/game.js`](server/game.js) if you play it differently.

- **No jokers.** The sheet gives them no rank and no score, so each deck is the standard 52.
- **Face-up table cards can be played at any time**, on their own or together with matching cards from your hand. A blind card becomes playable as soon as the face-up card on top of it is gone, whether or not you still hold cards.
- **Tens go down one at a time.** Each one swipes and earns another turn, so a second ten can follow on that turn. A blind card that turns out to be a ten is played automatically.
- **Going out counts even if the last card is a swipe.** A last card that is too high does not go out: the pile comes home first.
- **Who leads** is decided by the cards in every game, not by who went out last. Each player's twelve hand cards and four face-up cards are added up at their scoring values, except that tens count as nothing (a hand full of tens is advantage enough), and the highest total leads. Blind cards are not counted. Ties are settled at random among those tied. The sum is `leadTotal` in [`server/game.js`](server/game.js). Tens are still 20 each against whoever is left holding them.
- **All-time stats count finished games only.** A game somebody went out of adds one game for everyone who was still in it, a win for whoever went out, and the points each was left with (zero for the winner, so the average rewards going out). A game that was called off counts for nothing, and neither does one a player left part-way through, for that player. Records are kept per room and per browser, so the same person on a new browser starts a second record until the admin consolidates the two. Computer players have records too.
- **What is in the pile is public.** Every card in it was played face up, so anyone may see how many of each rank it holds. Their order and suits stay buried.
- **The match ends when someone reaches the limit** (100 is enough; it does not have to be passed). Ties for the lowest score share the win.
- **Leaving mid-game** takes your cards out of play. Your score is kept in case you come back.
- **A skipped turn costs cards.** When the clock runs out, nothing is played and the pile stays put, but the player draws 3 cards from the stock (the cards nobody was dealt). If they had nothing they could have played (no card that fits, no ten, no four of a kind) they draw 3 or as many cards as the pile holds, whichever is more, so sitting out the clock is never better than picking up. An unflipped blind card does not count as something to play. If the stock runs out, the swiped cards are shuffled back into it. The number is `SKIP_PENALTY` in [`server/game.js`](server/game.js). A blind card that has already been flipped is the exception to all of this: it is committed, so it is played.
- **Two can play.** The sheet says three to twenty-four; two works and is allowed.

## Run it

### Docker Compose

```sh
git clone <this repo> swipe && cd swipe
docker compose up -d --build
```

Open <http://localhost:3001>. Saved rooms live in `./data`. (The compose file maps host port 3001 so Swipe can run next to Tradecraft; change it to whatever you like.)

### Docker

```sh
docker build -t swipe .
docker run -d --name swipe -p 3001:3000 -v "$PWD/data:/data" --restart unless-stopped swipe
```

The container runs as uid 1000. If the folder you mount is owned by someone else, add `--user <uid>:<gid>` (on Unraid that is `--user 99:100`). If the app can't write to `/data` it still runs; it logs a warning and rooms won't survive a restart.

### Unraid

The repository includes a GitHub Actions workflow ([`.github/workflows/docker-image.yml`](.github/workflows/docker-image.yml)) that builds the image and publishes it to `ghcr.io/<your-username>/<repo-name>:latest` on every push, so nothing has to be built on the server.

1. Push this project to your own GitHub repository and wait for the **Build image** run on the Actions tab to go green.
2. Make the package public once: your GitHub profile, **Packages**, the package, **Package settings**, **Change visibility**.
3. In the Unraid terminal, create the data folder with Unraid's usual owner:

   ```sh
   mkdir -p /mnt/user/appdata/swipe
   chown -R 99:100 /mnt/user/appdata/swipe
   ```

4. Docker tab, **Add Container**, with Advanced View switched on:

   | Field | Value |
   | --- | --- |
   | Name | `swipe` |
   | Repository | `ghcr.io/<your-username>/<repo-name>:latest` (all lower case) |
   | Network Type | Bridge |
   | WebUI | `http://[IP]:[PORT:3000]` |
   | Extra Parameters | `--user 99:100` |
   | Port | container `3000`, host `3001` (or any free port) |
   | Path | container `/data`, host `/mnt/user/appdata/swipe` |
   | Variable | `ADMIN_PASSWORD`, a long password of your own, if you want the [admin page](#the-admin-page) |

To update later, push your changes, let the workflow finish, then use **Check for Updates** on the Docker tab.

### Node, no container

Needs Node 20 or newer.

```sh
npm ci --omit=dev
npm start
```

A sample systemd unit is in [`deploy/swipe.service`](deploy/swipe.service).

## Notifications and installing

Swipe can be installed like an app, and can send a notification when it is your turn or when someone sends a chat message while you are away. Players turn it on with **Notify me on my turn** in the lobby or under **Room settings**; it then follows them from room to room on that device without asking again.

**What the server needs**

- **HTTPS on a real hostname.** Browsers only allow notifications (and installing) on a secure address, so this works behind a reverse proxy with a certificate and not on a plain `http://` LAN address. `localhost` is the one exception, for testing. The proxy needs no extra settings.
- **Outbound internet access.** Notifications go from the server to Apple's, Google's, Mozilla's or Microsoft's push service, which hands them to the device. Nothing comes in.
- **Nothing else.** On first start the server makes a key pair and saves it as `vapid.json` in the data folder, next to `rooms.json`. Keep that file: if it is lost, everyone has to turn notifications on again. Each player's subscription (an address at their browser's push service and two keys) is stored with them in `rooms.json` and goes when the room does.

**iPhone and iPad**

Apple only delivers notifications to web apps on the Home Screen, not to Safari tabs. So on an iPhone: open the room, tap **Share**, then **Add to Home Screen**, open Swipe from the new icon, and turn notifications on there. The installed app does not share storage with Safari, so the link it is installed with carries a one-time seat code: it opens in the same room as the same player. Later launches start at the front page, which offers **Back to** your last room.

Android, and desktop Chrome, Edge and Firefox, need none of that: notifications work from an ordinary tab, and installing is optional.

**When a notification is sent**

- The turn passes to you and the game is not in front of you (page hidden, phone locked, tab closed). Extra turns after a swipe are not announced again.
- You look away during your own turn without playing: one reminder, after 20 seconds.
- Someone sends a chat message and the game is not in front of you. A run of messages buzzes you once, not once each (at most one every 8 seconds); the rest are waiting in the room. Chat notifications are separate from "your turn" ones, so neither replaces the other.
- Never while you are looking at the game, and never to computer players.

Messages are encrypted for the one browser they are meant for (RFC 8291) and signed with the server's key (VAPID, RFC 8292). The push service that relays them cannot read them. An undelivered notification is dropped after ten minutes, and a newer one replaces an older one for the same room.

**Seat codes**

A seat belongs to a browser. **Room settings → Another browser** shows a code that moves it to a different browser or device: open the room there, choose **Already playing in another browser?** and enter the code. Codes work once and last 15 minutes.

## The admin page

Set `ADMIN_PASSWORD` and restart, then open `/admin` (for example `https://swipe.example.com/admin`) and sign in. Without the variable the page is switched off and says so.

![The admin page: two rooms, one mid-game, with the people in each](docs/admin.png)

**Rooms.** Every room on the server, the ones in use first:

- What it is doing (lobby, dealing, whose turn, between games), when it was last used, when it expires, and its rules.
- Who is in it: name, whether they are connected and looking at the game, the address they connect from, their device and browser, cards in hand and score, and whether they are the host, a computer player or watching.
- **Change expiry.** The usual way (`ROOM_TTL_HOURS` after it was last used), never, or on a date and time you pick. A room is never removed while someone is in it; if its time comes then, it goes when the last person leaves.
- **Rename.** The name is the room's link, so whatever you type is fitted to lower-case letters, numbers and hyphens: "Friday Night Cards!" becomes `friday-night-cards`. Or ask for a new random name. People in the room move with it, and the old link keeps working unless you untick that, which cuts off everyone who only has the old one.
- Each player's **all-time record** in that room, and the records of people who have played there but are not in it now.
  - **Click a name** to change it: it becomes a box to type in, with a tick to save and a cross to cancel (Enter and Escape do the same). The player's browser does not change it back; they still can, themselves.
  - **Reset stats** for one player, or **Reset all stats** for the room. Both ask first.
  - **Consolidate**: tick two or more players who are really the same person (someone who cleared their browser and came back as "Bo 2", say) and make them one. Their games, wins and points are added together, and from then on games from any of those browsers count for that one player. If more than one of them has a seat in the room, the one you choose to keep stays, with its place and score in the match, and the others leave; a browser that is connected takes over a kept seat that is offline, so the person carries on where they were.
- **Message** the people in a room; **Lock** it; **End this game** or send it **Back to the lobby**; make someone the host; **Remove** a player (kept out, or free to return); let removed players back in; **Delete** the room, which tells whoever is in it that it was closed.
- Search by room, player or address. **New room** (named if you like, no server password needed), **Message everyone**, and **Clean up**, which removes empty rooms idle for as long as you choose and leaves alone any whose expiry you set.

**Server.** Version, uptime, memory, where and when rooms were last saved, the limits and settings in force, notification sign-ups, and how the server sees the network. **Save rooms now**, **Download a backup** (the saved rooms as a file; it holds the keys to people's seats, so keep it to yourself) and **Sign out other admin sessions**.

**Activity.** What has happened since the server started: rooms created and expired, every admin sign-in and wrong password with the address it came from, and each change made here.

How it is protected:

- The password is checked on the server, in constant time. Six wrong tries from one address lock that address out for ten minutes; 300 from everywhere lock sign-in for everyone for ten minutes. Use a long password and none of this matters; with a short one it only slows a guesser down.
- A sign-in is a random token in a cookie that scripts cannot read and other sites cannot send (`HttpOnly`, `SameSite=Strict`, and `Secure` when you arrive over HTTPS). It lasts `ADMIN_SESSION_HOURS` and is held in memory, so restarting the server signs you out.
- Nothing is changed for a request that another website could make your browser send.
- Addresses and browsers are kept in memory while someone is connected. They are never written to `rooms.json` or to the backup.
- All-time stats are saved with the room in `rooms.json` too, keyed by a hash of each browser's seat token rather than the token itself.
- A room's last hundred chat messages are saved with it in `rooms.json`, so they survive a restart and are in the backup. They go when the room does.
- Use a different password from `CREATE_PASSWORD`, and reach the page over HTTPS.

### Keeping it to your own network

The password is the lock; the proxy can also refuse to show the door to anyone outside your network. In Nginx Proxy Manager, edit the proxy host, open **Advanced**, and paste this into **Custom Nginx Configuration** with your own network in place of `10.0.10.0/24`:

```nginx
location ^~ /admin {
    allow 10.0.10.0/24;
    deny all;
    include conf.d/include/proxy.conf;
}
```

For plain nginx the block is the same with your own `proxy_pass` and headers in place of the `include` line; there is a copy in [`deploy/nginx.conf`](deploy/nginx.conf).

- `^~` matters: without it, Nginx Proxy Manager's asset-caching rule would answer for `/admin/admin.js` and `/admin/admin.css` instead of this block.
- The rule sees the address the proxy sees. If you open the site by its public name from inside your network and get a 403, your router is sending you out and back in, so you arrive with your public address. Point the name at the proxy on your local DNS, or open the app by its LAN address, and the rule sees who you really are.
- With Cloudflare's proxy in front, every visitor arrives from Cloudflare and this rule shuts everyone out, you included.
- The server reads a request's path the way nginx does, so there is no spelling of `/admin` that gets past the rule and still opens the page.

## Configuration

Everything is an environment variable. All are optional.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on. |
| `HOST` | `0.0.0.0` | Address to bind. |
| `SITE_NAME` | `Swipe` | The name shown on the page and in the browser tab. |
| `BASE_PATH` | *(empty)* | Set to e.g. `/swipe` to serve under a sub-path. |
| `CREATE_PASSWORD` | *(empty)* | If set, creating a room needs this password. Joining a room never does. |
| `ADMIN_PASSWORD` | *(empty)* | Turns on the [admin page](#the-admin-page) at `/admin` and is the password for it. Empty means no admin page. |
| `ADMIN_SESSION_HOURS` | `12` | How long an admin sign-in lasts. |
| `TRUST_PROXY` | `1` | How many reverse proxies are in front of the server. It decides which entry of `X-Forwarded-For` is taken as a visitor's address. `0` ignores the header. See [Behind a reverse proxy](#behind-a-reverse-proxy). |
| `TRUST_PROXY_ANY` | `false` | The proxy's headers are only believed when it connects from a private address. Set to `true` if yours connects from a public one. |
| `DATA_DIR` | `./data` (`/data` in Docker) | Where `rooms.json` and `vapid.json` are written. |
| `PERSIST` | `true` | Set to `false` to keep rooms in memory only. |
| `ROOM_TTL_HOURS` | `48` | Idle rooms are deleted after this long, unless the admin page says otherwise for a room. |
| `MAX_ROOMS` | `500` | Upper limit on rooms. |
| `MAX_PLAYERS_PER_ROOM` | `64` | Upper limit on people in a room, watchers included. 24 can be dealt in. |
| `ALLOWED_ORIGINS` | *(any)* | Comma-separated origins allowed to open the WebSocket, e.g. `https://games.example.com`. |
| `PUSH` | `true` | Set to `false` to switch turn notifications off. |
| `PUSH_CONTACT` | *(the site's address)* | A `mailto:` or `https:` address push services can use to reach whoever runs this server. |
| `PUSH_EXTRA_HOSTS` | *(empty)* | Extra push-service hosts to accept, comma-separated. Only the four big browser makers' services are accepted otherwise. |
| `PUSH_REMIND_MS` | `20000` | How long after you look away during your own turn the reminder is sent. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | *(made on first start)* | Supply the notification key pair yourself instead of keeping it in `DATA_DIR/vapid.json`. |
| `BOT_DELAY_MS` | `1000` | Roughly how long a computer player takes over a move. |
| `DEAL_MS` | `8400` | How long the shuffle-and-deal sequence gets before play opens. Shorten it and the animation squeezes to fit; under about 3.6 seconds it is skipped. |
| `MESSAGE_BUDGET` | `40` | Messages one connection may send every five seconds. |
| `LOG_LEVEL` | `info` | `info`, `debug` or `silent`. |

The points limit and the turn clock are per room, in **Room settings**.

## Behind a reverse proxy

The app speaks plain HTTP and one WebSocket at `/ws`. The proxy has to pass the WebSocket upgrade through.

- nginx: [`deploy/nginx.conf`](deploy/nginx.conf)
- Caddy: [`deploy/Caddyfile`](deploy/Caddyfile)
- Traefik and Nginx Proxy Manager need no special settings beyond enabling WebSocket support.

For a sub-path, set `BASE_PATH=/swipe` and forward `/swipe/` to the app. It works whether or not the proxy strips the prefix.

Notifications and installing need the HTTPS address; see [Notifications and installing](#notifications-and-installing).

**Visitors' addresses.** The admin page shows where each player connects from, and wrong admin passwords are counted per address. Behind a proxy every connection comes from the proxy, so the server reads `X-Forwarded-For` instead, and `TRUST_PROXY` says how many proxies add to it: `1` for Nginx Proxy Manager, nginx, Caddy or Traefik on their own (the default), `2` with Cloudflare in front of that, `0` with no proxy at all. The header is only believed when the connection comes from a private address (the same machine, a Docker network, your LAN or a VPN), so someone who reaches the app's port directly from outside cannot make one up. If the admin page shows the same address for everybody, the number is too low; if it shows nonsense, too high.

If you put this on the public internet, consider setting `CREATE_PASSWORD` so strangers can't open rooms on your server, and `ALLOWED_ORIGINS` to your own address. If you turn on the admin page, give it a long password: anyone who can reach the site can reach its sign-in form.

## How it is put together

```text
server/
  index.js    HTTP (static files, small JSON API) and the WebSocket endpoint
  rooms.js    rooms, players, seats, host controls, computer players, the turn
              clock, the running score, saving to disk, and the per-player view
              (who is allowed to see what)
  game.js     one deal of the cards, as pure functions over a plain object
  push.js     turn notifications: message encryption and signing, written out
              with node:crypto, and the key pair
  admin.js    the admin page's side of things: sign-in, what it is shown, the
              changes it may make
  names.js    room codes
  config.js   environment variables
public/       the client: plain HTML, CSS and ES modules, served as-is
  js/rules.js   what a set of cards does to the pile. The server enforces it
                and the browser previews with it, from this one file
  js/cards.js   the cards themselves, drawn as SVG
  js/view.js    everything on screen, as functions from a snapshot to HTML
  js/fx.js      motion: flights, the wash, the swipe, confetti
  js/sound.js   sound effects, synthesised with Web Audio
  js/push.js    notifications from the browser's side: permission, subscribing
  js/chat.js    the chat panel and the banner a new message shows in
  js/stats.js   the all-time stat board
  js/app.js     the connection, taps, dialogs, and the order things animate in
  sw.js         the service worker: shows notifications, makes the app installable
  admin/        the admin page: one HTML file, one script, one stylesheet
test/         rules tests and end-to-end tests over real WebSockets
```

The server is the only source of truth. Each change produces a fresh snapshot per player, filtered to what that player may see, so a client can't learn a hidden card by reading network traffic. Clients send small actions; the server sends whole snapshots, each carrying the one event that produced it (`round.last`), which is what the browser animates.

### API

| | |
| --- | --- |
| `POST /api/rooms` | Create a room. Body `{ "password": "…" }` if `CREATE_PASSWORD` is set. Returns `{ "code": "…" }`. |
| `GET /api/rooms/:code` | `{ exists, code, players, locked }`, or 404. `code` is the room's current name if it was renamed. |
| `/admin/api/…` | The admin page's own API, all of it behind the sign-in. See the top of [`server/admin.js`](server/admin.js). |
| `GET /healthz` | `{ ok, rooms, online, uptime }`. |
| `GET /manifest.webmanifest` | The app manifest. With `?room=…&seat=…` its start address is that room, carrying the seat code. |

## Development

```sh
npm install
npm run dev     # restarts on server changes; the client has no build step
npm test        # rules tests + end-to-end tests that boot the server
```

## Licence and credits

GPL-3.0-or-later, the same licence as Tradecraft, whose server this one grew out of. See [`LICENSE`](LICENSE).

- The typefaces are [Archivo](https://github.com/Omnibus-Type/Archivo) by Omnibus-Type and [Besley](https://github.com/indestructible-type/Besley) by indestructible type*, both under the SIL Open Font License ([`public/fonts/`](public/fonts)).
- The card faces and backs were drawn for this project. They follow the look of a classic American poker deck and are not copies of any maker's artwork. Bicycle is a trademark of The United States Playing Card Company; this project is not affiliated with or endorsed by them.
