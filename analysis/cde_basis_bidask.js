// analysis/cde_basis_bidask.js
//
// Live bid/ask for CDE futures and perps, and the spread APYs computed at
// EXECUTABLE prices (sell at the bid, buy at the ask) instead of mid.
//
// Why a separate fetch: the bulk products list the main monitor polls has
// best_bid_price / best_ask_price fields but they come back empty. The public
// per-product order book endpoint (no auth) does return real quotes:
//   GET /api/v3/brokerage/market/product_book?product_id=X&limit=1
//
// Spread convention (matches the rest of the dashboard): a pair is (A, B) and
// the two possible trades are
//   Short A / Long B : sell A at its bid, buy B at its ask
//   Long A / Short B : buy A at its ask, sell B at its bid
// The "edge" of a trade is the price gap it locks in, annualized over the
// horizon until the legs converge (expiry of the dated leg; for front-vs-back,
// the time between the two expiries). Positive edge = profitable convergence.
// Mid edge uses the same formula at the book mids, so
//   executable edge = mid edge - cost of crossing the spread.

const YEAR_MS = 365 * 24 * 3600 * 1000;
const DAY_MS = 86_400_000;
const SANITY_CAP_PCT = 3000;
const BOOK_URL = 'https://api.coinbase.com/api/v3/brokerage/market/product_book';

function toNum(v) {
  if (v === '' || v == null) return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

// Turn a product_book response into { bid, bidSize, ask, askSize, mid, time }.
// Returns { error } instead if the book is empty, one-sided, or crossed.
function parseBook(json) {
  const pb = json && json.pricebook;
  if (!pb) return { error: 'no pricebook' };
  let bestBid = null, bestAsk = null;
  for (const l of (pb.bids || [])) {
    const p = toNum(l.price);
    if (p != null && p > 0 && (bestBid == null || p > bestBid.p)) bestBid = { p, s: toNum(l.size) };
  }
  for (const l of (pb.asks || [])) {
    const p = toNum(l.price);
    if (p != null && p > 0 && (bestAsk == null || p < bestAsk.p)) bestAsk = { p, s: toNum(l.size) };
  }
  if (!bestBid || !bestAsk) return { error: 'one-sided or empty book' };
  if (bestBid.p > bestAsk.p) return { error: 'crossed book' };
  return {
    bid: bestBid.p, bidSize: bestBid.s, ask: bestAsk.p, askSize: bestAsk.s,
    mid: (bestBid.p + bestAsk.p) / 2, time: pb.time || null,
  };
}

// Fetches order books one request at a time on a fixed pace (the public
// endpoint rate-limits bursts: ~75 books fired at once got about two thirds
// rejected with HTTP 429). Requests are spaced minIntervalMs apart; on a 429
// the spacing widens automatically and the request is retried after a backoff,
// then the spacing creeps back down once things are calm. Each book is cached
// for ttlMs (failures only errorTtlMs) so several open tabs share one sweep,
// and a failed refresh falls back to the last good quote for up to maxStaleMs
// rather than blanking the row. Callers asking for an id already in flight
// share that request.
function createBookFetcher(fetchJSON, opts = {}) {
  const baseInterval = opts.minIntervalMs ?? 150;
  const maxInterval = opts.maxIntervalMs ?? 1500;
  let interval = baseInterval;
  const ttlMs = opts.ttlMs ?? 12000;
  const errorTtlMs = opts.errorTtlMs ?? 2000;
  const notFoundTtlMs = opts.notFoundTtlMs ?? 300000;   // a 404 won't fix itself in seconds
  const maxStaleMs = opts.maxStaleMs ?? 45000;
  const maxRetries = opts.maxRetries ?? 3;
  const backoffMs = opts.backoffMs ?? 1000;
  const now = opts.now || (() => Date.now());          // cache clock (injectable for tests)
  const sleep = opts.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
  const cache = new Map();     // id -> { at, result, ok }
  const lastGood = new Map();  // id -> { at, result }
  const inflight = new Map();  // id -> Promise<result>
  let nextSlot = 0;            // real-time pacing, independent of the cache clock
  let okStreak = 0;
  const stats = { requests: 0, rate429: 0, retries: 0 };

  async function pace() {
    const t = Date.now();
    const slot = Math.max(t, nextSlot);
    nextSlot = slot + interval;        // reserved synchronously => requests keep call order
    if (slot > t) await sleep(slot - t);
  }

  async function fetchWithRetry(id) {
    const url = `${BOOK_URL}?product_id=${encodeURIComponent(id)}&limit=1`;
    for (let attempt = 0; ; attempt++) {
      await pace();
      stats.requests++;
      try {
        const book = parseBook(await fetchJSON(url));
        if (++okStreak >= 20 && interval > baseInterval) { interval = Math.max(baseInterval, interval * 0.9); okStreak = 0; }
        return book;
      } catch (e) {
        const is429 = /HTTP 429/.test(e.message);
        if (is429) {
          stats.rate429++; okStreak = 0;
          interval = Math.min(Math.max(interval * 1.5, 50), maxInterval);
          if (attempt < maxRetries) { stats.retries++; await sleep(backoffMs * (attempt + 1)); continue; }
        }
        // keep the message short: strip the URL the caller's fetchJSON appends
        return { error: e.message.replace(/ for https?:\/\/\S+/, '') };
      }
    }
  }

  function fresh(id) {
    const hit = cache.get(id);
    if (!hit) return null;
    const ttl = hit.ok ? ttlMs : (/^HTTP 404/.test(hit.result.error || '') ? notFoundTtlMs : errorTtlMs);
    return now() - hit.at < ttl ? hit.result : null;
  }
  // Last good quote (with how old it is), or null if too old to trust.
  function staleFallback(id) {
    const g = lastGood.get(id);
    if (!g || now() - g.at > maxStaleMs) return null;
    return { ...g.result, stale: true };
  }

  function one(id) {
    const f = fresh(id);
    if (f) return Promise.resolve(f);
    if (inflight.has(id)) return inflight.get(id);
    const p = (async () => {
      let result = await fetchWithRetry(id);
      if (result.error) {
        const fb = staleFallback(id);
        cache.set(id, { at: now(), result: fb || result, ok: !!fb });
        return fb || result;
      }
      result = { ...result, fetchedAt: now() };
      cache.set(id, { at: now(), result, ok: true });
      lastGood.set(id, { at: now(), result });
      return result;
    })().finally(() => inflight.delete(id));
    inflight.set(id, p);
    return p;
  }

  // maxWaitMs: don't make the caller wait for a whole sweep. Anything not back
  // in time is served from the last good quote if there is one, else marked
  // { error: 'loading' }; the requests keep running and fill the cache for
  // the next call.
  async function getBooks(ids, o = {}) {
    const unique = [...new Set(ids)];
    const out = new Map();
    const all = Promise.all(unique.map(async (id) => { out.set(id, await one(id)); }));
    if (o.maxWaitMs != null) await Promise.race([all, sleep(o.maxWaitMs)]);
    else await all;
    for (const id of unique) {
      if (!out.has(id)) out.set(id, staleFallback(id) || { error: 'loading' });
    }
    return out;
  }
  return { getBooks, stats, _cache: cache, _interval: () => interval };
}

// legA / legB: { bid, ask, mid, bidSize, askSize, contractSize } (book mid).
// refMid: denominator for the % gap. horizonMs: time to convergence.
// Returns both directions' edges plus the cost of crossing, all annualized %.
function computePair(legA, legB, refMid, horizonMs) {
  if (!legA || !legB || !(refMid > 0) || !(horizonMs > 0)) return null;
  const ann = (YEAR_MS / horizonMs) * 100;
  const shortAEdge = (legA.bid - legB.ask) / refMid * ann;   // sell A @bid, buy B @ask
  const longAEdge = (legB.bid - legA.ask) / refMid * ann;    // buy A @ask, sell B @bid
  const midShortA = (legA.mid - legB.mid) / refMid * ann;    // mid edge, Short A / Long B
  const crossCost = ((legA.ask - legA.bid) / 2 + (legB.ask - legB.bid) / 2) / refMid * ann;
  const best = shortAEdge >= longAEdge ? 'SHORT_A' : 'LONG_A';
  const touchUsd = (leg, side) => {
    const size = side === 'bid' ? leg.bidSize : leg.askSize;
    const px = side === 'bid' ? leg.bid : leg.ask;
    return (size != null && leg.contractSize != null) ? size * leg.contractSize * px : null;
  };
  // Touch notional on the legs actually crossed for each direction.
  const tShort = [touchUsd(legA, 'bid'), touchUsd(legB, 'ask')];
  const tLong = [touchUsd(legA, 'ask'), touchUsd(legB, 'bid')];
  const minOrNull = (arr) => arr.some(v => v == null) ? null : Math.min(...arr);
  const unreliable = horizonMs < DAY_MS
    || [shortAEdge, longAEdge, midShortA].some(v => Math.abs(v) > SANITY_CAP_PCT);
  return {
    horizonDays: horizonMs / DAY_MS,
    // Spread-centric view (spread = A - B, the way the exchange's spread
    // products are quoted, e.g. AVA1-Perp = front minus perp). The spread's
    // bid is what you can SELL it for right now by hitting both legs, its ask
    // is what you can BUY it for. "Level" = that price annualized over the
    // horizon (price / ref * ann), i.e. how rich the spread is at that price.
    refMid, annFactor: ann,
    spreadBid: legA.bid - legB.ask, spreadAsk: legA.ask - legB.bid, spreadMid: legA.mid - legB.mid,
    bidLevel: shortAEdge, askLevel: -longAEdge, midLevel: midShortA,
    shortAEdge, longAEdge, midShortA, crossCost, best,
    bestExecEdge: best === 'SHORT_A' ? shortAEdge : longAEdge,
    // Mid edge expressed for the SAME direction as the best executable one,
    // so mid - crossCost = executable holds on the row.
    bestMidEdge: best === 'SHORT_A' ? midShortA : -midShortA,
    touchUsd: best === 'SHORT_A' ? minOrNull(tShort) : minOrNull(tLong),
    unreliable,
  };
}

const PAIR_NAMES = {
  FRONT_PERP: ['FRONT', 'PERP'],
  BACK_PERP: ['BACK', 'PERP'],
  FRONT_BACK: ['FRONT', 'BACK'],
};

// Smallest price step. Prefer the exchange's own increment when the product
// feed supplies it; otherwise infer it from how many decimals the live bid and
// ask use (flagged inferred=true because a quote like 0.50 prints as 0.5).
function decimalsOf(n) {
  if (n == null || !isFinite(n)) return 0;
  const s = String(n);
  const m = /e-(\d+)$/.exec(s);
  if (m) { const base = (s.split('e')[0].split('.')[1] || '').length; return +m[1] + base; }
  return (s.split('.')[1] || '').length;
}
function tickFor(productTick, book) {
  if (productTick > 0) return { tick: productTick, inferred: false };
  if (!book || book.error) return { tick: null, inferred: true };
  const d = Math.max(decimalsOf(book.bid), decimalsOf(book.ask));
  return { tick: +Math.pow(10, -d).toFixed(Math.min(d, 12)), inferred: true };
}

// CDE minimum price increments (price units) per underlying, from the exchange's
// contract spec table. Same tick for the standard and nano contract of a token.
const MIN_TICK = {
  BTC: 5, BTI: 5, BIT: 5, ETH: 0.5, ETI: 0.5, ET: 0.5, SOL: 0.01, SLC: 0.01,
  XRP: 0.0001, XRL: 0.0001, ADA: 0.0001, LTC: 0.01, LC: 0.01, DOGE: 0.00001, DOG: 0.00001,
  AVAX: 0.01, AVA: 0.01, LINK: 0.001, LNK: 0.001, SUI: 0.0001, BNB: 0.05, BNF: 0.05,
  HYPE: 0.01, HYF: 0.01, DOT: 0.001, XLM: 0.00001, SHIB: 0.00001, SHB: 0.00001,
  HBAR: 0.00001, HED: 0.00001, BCH: 0.05,
};

function guessSpreadTick(...vals) {
  let d = 0;
  for (const v of vals) { if (v == null || !isFinite(v)) continue; d = Math.max(d, decimalsOf(+(+v).toPrecision(10))); }
  return +Math.pow(10, -d).toFixed(Math.min(d, 12));
}

function legFrom(book, contractSize) {
  if (!book || book.error) return null;
  return { bid: book.bid, ask: book.ask, mid: book.mid, bidSize: book.bidSize, askSize: book.askSize, contractSize };
}

// Which product ids the page needs, so we only fetch legs that can form a pair.
function productIdsNeeded(snapRows, hidden = {}) {
  const ids = [];
  for (const r of snapRows) {
    if (hidden[r.root]) continue;
    const legs = [r.perp, r.dated, r.back].filter(Boolean);
    if (legs.length < 2) continue;
    for (const l of legs) ids.push(l.productId);
  }
  return ids;
}

// One output row per (token, pair). `books` is a Map id -> parseBook result.
function buildBidAskRows(snapRows, books, hidden = {}, nowMs = Date.now()) {
  const out = [];
  const stats = { legsOk: 0, legsFailed: 0 };
  for (const r of snapRows) {
    if (hidden[r.root]) continue;
    const L = {
      PERP: r.perp ? legFrom(books.get(r.perp.productId), r.perp.contractSize) : null,
      FRONT: r.dated ? legFrom(books.get(r.dated.productId), r.dated.contractSize) : null,
      BACK: r.back ? legFrom(books.get(r.back.productId), r.back.contractSize) : null,
    };
    const meta = {
      PERP: r.perp ? { id: r.perp.productId, tms: null, tick: r.perp.tick } : null,
      FRONT: r.dated ? { id: r.dated.productId, tms: r.dated.Tms, tick: r.dated.tick } : null,
      BACK: r.back ? { id: r.back.productId, tms: r.back.Tms, tick: r.back.tick } : null,
    };
    const fundAPY = r.perp ? r.perp.fundAPY : null;
    for (const [pair, [nameA, nameB]] of Object.entries(PAIR_NAMES)) {
      if (!meta[nameA] || !meta[nameB]) continue;      // token doesn't have both legs
      const bookA = books.get(meta[nameA].id), bookB = books.get(meta[nameB].id);
      const legA = L[nameA], legB = L[nameB];
      let horizonMs;
      if (pair === 'FRONT_BACK') horizonMs = meta.BACK.tms - meta.FRONT.tms;
      else horizonMs = (nameA === 'FRONT' ? meta.FRONT.tms : meta.BACK.tms);
      const refMid = nameB === 'PERP' ? (legB && legB.mid) : (legA && legA.mid);
      const c = computePair(legA, legB, refMid, horizonMs);
      if (!c) {
        const why = (bookA && bookA.error) || (bookB && bookB.error) || (!(horizonMs > 0) ? 'no time to expiry' : 'no quote');
        out.push({ root: r.root, pair, nameA, nameB, error: why });
        continue;
      }
      const shortA = c.best === 'SHORT_A';
      const direction = shortA ? `Short ${nameA} / Long ${nameB}` : `Long ${nameA} / Short ${nameB}`;
      // Perp funding: long perp pays the funding rate, short perp receives it.
      let fundingEffect = null;
      if (nameB === 'PERP' && fundAPY != null) {
        const longPerp = shortA;  // Short A / Long B => long the perp
        fundingEffect = longPerp ? -fundAPY : fundAPY;
      }
      // Default spread tick = the price grid the live spread bid/ask sit on
      // (decimals of the two quotes). This is only a starting guess; the page
      // lets the user type the real tick per token, which is saved.
      const tableTick = MIN_TICK[String(r.root).toUpperCase()];
      const spreadTick = tableTick || guessSpreadTick(c.spreadBid, c.spreadAsk);
      const apyPerTick = spreadTick ? spreadTick / c.refMid * c.annFactor : null;
      const spreadBps = (leg) => leg ? (leg.ask - leg.bid) / leg.mid * 1e4 : null;
      const ages = [bookA, bookB].map(b => !b ? null : (b.fetchedAt != null ? (nowMs - b.fetchedAt) / 1000
        : (b.time ? (nowMs - Date.parse(b.time)) / 1000 : null)))
        .filter(v => v != null && !isNaN(v));
      out.push({
        root: r.root, pair, nameA, nameB, direction, ...c,
        idA: meta[nameA].id, idB: meta[nameB].id,
        spreadTick, apyPerTick, tickFromTable: !!tableTick,
        // One funding payment, in spread-price units, for the BUY-spread side
        // (long first leg / short perp): the short perp receives funding when
        // the rate is positive. Selling the spread is the opposite sign.
        // Rate is a per-interval fraction, applied to the perp's mid price.
        fundPerCyclePx: (nameB === 'PERP' && r.perp && r.perp.fundingRate != null && legB) ? r.perp.fundingRate * legB.mid : null,
        fundIntervalSec: nameB === 'PERP' && r.perp ? (r.perp.fundingSec || null) : null,
        pairFundAPY: nameB === 'PERP' ? fundAPY : null,
        fundingEffect,
        netOfFunding: c.bestExecEdge + (fundingEffect || 0),
        spreadBpsA: spreadBps(legA), spreadBpsB: spreadBps(legB),
        maxBookAgeSec: ages.length ? Math.max(...ages) : null,
        flags: r.flags || [],
      });
    }
    // Only count legs of tokens that can actually form a pair; a perp-only
    // token has nothing to fetch and shouldn't show up as "without a quote".
    if (['PERP', 'FRONT', 'BACK'].filter(k => meta[k]).length < 2) continue;
    for (const k of ['PERP', 'FRONT', 'BACK']) {
      if (!meta[k]) continue;
      if (L[k]) stats.legsOk++; else stats.legsFailed++;
    }
  }
  return { rows: out, stats };
}

module.exports = {
  BOOK_URL, parseBook, createBookFetcher, computePair, buildBidAskRows, productIdsNeeded, PAIR_NAMES, tickFor, decimalsOf, guessSpreadTick, MIN_TICK,
};
