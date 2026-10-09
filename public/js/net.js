// One WebSocket per room, with automatic reconnect.

export class Connection {
  constructor({ room, token, name, claim = null, onState, onError, onFatal, onStatus, onJoin, onSeat, onClaim }) {
    Object.assign(this, { room, token, name, claim, onState, onError, onFatal, onStatus, onJoin, onSeat, onClaim });
    this.ws = null;
    this.closed = false;
    this.attempt = 0;
    this.pingTimer = null;
    this.connect();
    // Phones suspend sockets in the background; reconnect as soon as we're visible again.
    // The server is told whenever the page is hidden or shown, so it knows
    // whether a turn needs a notification.
    this.onVisible = () => {
      if (document.visibilityState === 'visible' && !this.closed && (!this.ws || this.ws.readyState > 1)) {
        clearTimeout(this.retryTimer);
        this.connect();
      }
      this.raw({ t: 'vis', v: document.visibilityState === 'visible' });
    };
    this.onHide = () => this.raw({ t: 'vis', v: false });
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('pagehide', this.onHide);
  }

  url() {
    const u = new URL('ws', document.baseURI);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.toString();
  }

  connect() {
    if (this.closed) return;
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onopen = () => {
      // A seat code is offered once; after that this browser's own token is the seat.
      ws.send(JSON.stringify({ t: 'hello', room: this.room, token: this.token, name: this.name, claim: this.claim || undefined }));
      this.claim = null;
      ws.send(JSON.stringify({ t: 'vis', v: document.visibilityState === 'visible' }));
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => ws.readyState === 1 && ws.send('{"t":"ping"}'), 20000);
    };
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.t === 'state') {
        this.attempt = 0;
        this.onStatus?.(true);
        this.onState(msg.s);
        if (!ws.joined) {
          ws.joined = true;
          this.onJoin?.();
        }
      } else if (msg.t === 'err') {
        this.onError?.(msg.m);
      } else if (msg.t === 'fatal') {
        this.close();
        this.onFatal?.(msg.code, msg.m);
      } else if (msg.t === 'kicked') {
        this.close();
        this.onFatal?.('kicked', 'The host removed you from this room.');
      } else if (msg.t === 'moved') {
        this.close();
        this.onFatal?.('moved', 'Your seat was moved to another browser.');
      } else if (msg.t === 'seat') {
        this.onSeat?.(msg);
      } else if (msg.t === 'claim') {
        this.onClaim?.(msg.ok);
      }
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.closed || this.ws !== ws) return;
      this.onStatus?.(false);
      const delay = Math.min(8000, 400 * 2 ** this.attempt++);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {};
  }

  send(action, data = {}) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'a', a: action, ...data }));
  }

  /** Sends something that is not a game action (visibility, a request for a seat code). */
  raw(obj) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('pagehide', this.onHide);
    try {
      this.ws?.close();
    } catch {}
  }
}
