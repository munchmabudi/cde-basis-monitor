// venues/deribit_client.js
// Shared public market-data client for Deribit (no auth, no rate-limit on public
// subscriptions). Uses Node's built-in global WebSocket (Node >=21). One WS
// connection, batched multi-channel subscribe, snapshot+delta book feeds.
//
// Deribit v2 book channel (recommended over REST polling for time-sensitive use):
//   book.{instrument}.{group}.{depth}.{interval}
//     group   = none | raw      (raw = full per-level change deltas)
//     depth   = 100ms (aggregated, level format [price, qty]) — simplest to consume
//     interval= 100ms
// Frame (aggregated): data.bids/asks = [[price, qty], ...]; qty 0 => remove level.
//
// We cache the latest full book per instrument and expose getBook(inst).

const WS_URL = 'wss://www.deribit.com/ws/api/v2';

class DeribitClient {
  constructor() {
    this.ws = null;
    this.ready = false;
    this.connected = false;
    this.books = new Map();      // instrument -> { bids:Map(price->qty), asks:Map(price->qty), seq, ts }
    this.subs = new Set();       // channels we've requested
    this.pending = null;         // ws instance being opened
    this.reqId = 1;
    this.onReadyCbs = [];
    this.reconnectDelay = 2000;
    this._connect();
  }

  _connect() {
    try { this.ws = new WebSocket(WS_URL); }
    catch (e) { console.error('[deribit] ws construct failed:', e.message); this._scheduleReconnect(); return; }

    this.ws.onopen = () => {
      this.connected = true;
      this.ready = true;
      // (re)subscribe everything requested so far
      if (this.subs.size) this._sendSubscribe([...this.subs]);
      this.onReadyCbs.splice(0).forEach(cb => cb());
    };

    this.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.method === 'subscription') this._onBook(msg.params);
    };

    this.ws.onclose = () => {
      this.connected = false; this.ready = false;
      this._scheduleReconnect();
    };
    this.ws.onerror = () => { try { this.ws.close(); } catch {} };
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null; this._connect();
    }, this.reconnectDelay);
  }

  _sendSubscribe(channels) {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0', id: this.reqId++, method: 'public/subscribe', params: { channels },
    }));
  }

  // ensure an instrument is subscribed; returns a promise that resolves when the
  // first snapshot has arrived (so getSnapshot won't race an empty book).
  // ensure an instrument is subscribed; resolves when the first snapshot
  // arrives (so getSnapshot won't race an empty book). Times out after
  // FETCH_TIMEOUT_MS so a non-existent instrument can NEVER hang the monitor.
  ensure(inst, depth = '100ms', timeoutMs = 8000) {
    const ch = `book.${inst}.${depth}`;
    if (!this.subs.has(ch)) {
      this.subs.add(ch);
      if (this.connected) this._sendSubscribe([ch]);
    }
    return new Promise((resolve) => {
      if (this.books.has(inst)) return resolve();
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const to = setTimeout(finish, timeoutMs); // give up gracefully if no snapshot
      const check = () => {
        if (this.books.has(inst)) { clearTimeout(to); return finish(); }
        if (this.ready) setTimeout(check, 100); else this.onReadyCbs.push(check);
      };
      check();
    });
  }

  _onBook({ channel, data }) {
    // channel like book.BTC-PERPETUAL.100ms
    const inst = data.instrument_name;
    let b = this.books.get(inst);
    if (!b) { b = { bids: new Map(), asks: new Map(), ts: 0 }; this.books.set(inst, b); }

    const apply = (side, levels) => {
      for (const lv of levels) {
        // Deribit aggregated book levels: ["new"|"change", price, qty]  (3-elem)
        // or [price, qty] on some feeds. Handle both.
        const price = parseFloat(lv[lv.length === 3 ? 1 : 0]);
        const qty = parseFloat(lv[lv.length === 3 ? 2 : 1]);
        if (!(qty > 0)) side.delete(price);
        else side.set(price, qty);
      }
    };
    if (Array.isArray(data.bids)) apply(b.bids, data.bids);
    if (Array.isArray(data.asks)) apply(b.asks, data.asks);
    b.ts = data.timestamp ?? Date.now();
  }

  getBook(inst) { return this.books.get(inst) || null; }

  // normalized snapshot matching the engine's Snap shape
  snapshot(inst, label = 'deribit') {
    const b = this.books.get(inst);
    if (!b || b.bids.size === 0 || b.asks.size === 0) return null;
    const bidPx = [...b.bids.keys()].sort((x, y) => y - x);
    const askPx = [...b.asks.keys()].sort((x, y) => x - y);
    const bestBid = bidPx[0], bestAsk = askPx[0];
    return {
      venue: label,
      instrument: inst,
      markPrice: (bestBid + bestAsk) / 2,
      bestBid, bestAsk,
      fundingRate: 0, fundingIntervalHours: 1,
      bids: bidPx.map(p => ({ price: p, qty: b.bids.get(p) })),
      asks: askPx.map(p => ({ price: p, qty: b.asks.get(p) })),
      timestamp: b.ts,
    };
  }
}

// singleton — one WS connection shared across all instruments/monitors
const client = new DeribitClient();
module.exports = { client, DeribitClient };
