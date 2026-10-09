// One WebSocket per room, with automatic reconnect.

export class Connection {
  constructor({ room, token, name, onState, onError, onFatal, onStatus }) {
    Object.assign(this, { room, token, name, onState, onError, onFatal, onStatus });
    this.ws = null;
    this.closed = false;
    this.attempt = 0;
    this.pingTimer = null;
    this.connect();
    // Phones suspend sockets in the background; reconnect as soon as we're visible again.
    this.onVisible = () => {
      if (document.visibilityState === 'visible' && !this.closed && (!this.ws || this.ws.readyState > 1)) {
        clearTimeout(this.retryTimer);
        this.connect();
      }
    };
    document.addEventListener('visibilitychange', this.onVisible);
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
      ws.send(JSON.stringify({ t: 'hello', room: this.room, token: this.token, name: this.name }));
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
      } else if (msg.t === 'err') {
        this.onError?.(msg.m);
      } else if (msg.t === 'fatal') {
        this.close();
        this.onFatal?.(msg.code, msg.m);
      } else if (msg.t === 'kicked') {
        this.close();
        this.onFatal?.('kicked', 'The host removed you from this room.');
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

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    document.removeEventListener('visibilitychange', this.onVisible);
    try {
      this.ws?.close();
    } catch {}
  }
}
