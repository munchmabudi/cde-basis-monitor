'use strict';
// analysis/cde_fills.js
//
// Shadow-mode "fill logger" for CDE spread market making. It sends nothing to
// the exchange. It watches the public trade tape of the dated futures and asks:
// "if we had been the maker on that trade and hedged on the other leg's touch,
// what spread price would we have traded at?"
//
// Rules (spread S = A - B, the way the exchange quotes it):
//   A taker BUY hit the offer, so the passive side (the maker) SOLD.
//   A taker SELL hit the bid, so the passive side (the maker) BOUGHT.
//   Maker bought X, hedge by SELLING the other leg at its bid; maker sold X, hedge by BUYING the other leg at its ask.
//   X = A, maker long A : S = p - B.bid   (we bought the spread)
//   X = A, maker short A: S = p - B.ask   (we sold the spread)
//   X = B, maker long B : S = A.bid - p   (we sold the spread)
//   X = B, maker short B: S = A.ask - p   (we bought the spread)
// Each simulated fill also records the synthetic bid / offer at that moment
// (A.bid - B.ask and A.ask - B.bid) and how many ticks away from that touch the
// fill was ("distTicks"). A bid resting d ticks above the synthetic bid would
// have been hit by every simulated buy with distTicks <= d, which is the
// fill-rate curve the quote sheet uses to pick a price.
//
// Honest limits: the hedge quote is the nearest SAMPLE of the other leg's book
// (a REST sweep every few seconds), not the exact quote at the trade time, and
// the tape says nothing about our queue position. Fills here are therefore an
// upper bound, and the "lagSec" on each record shows how stale the hedge quote was.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { parseBook, BOOK_URL } = require('./cde_basis_bidask');

const PRODUCTS_URL = 'https://api.coinbase.com/api/v3/brokerage/market/products';
const RING_CAP = 6000;           // quote samples kept per product (~25h at 15s)
const SEEN_CAP = 4000;           // trade ids remembered per product
const KEEP_MS = 24 * 3600_000;   // fills kept in memory for the fill curve
const MEM_FILL_CAP = 60000;

function num(v) { if (v === '' || v == null) return null; const n = parseFloat(v); return isFinite(n) ? n : null; }

// --- public ticker (recent trades) ---
// Response shape (Advanced Trade public API):
//   { trades:[{ trade_id, product_id, price, size, time, side }], best_bid, best_ask }
function parseTicker(json) {
  const trades = [];
  for (const t of ((json && json.trades) || [])) {
    const price = num(t.price), size = num(t.size), tMs = Date.parse(t.time);
    const side = String(t.side || '').toUpperCase();
    if (price == null || price <= 0 || size == null || !isFinite(tMs) || (side !== 'BUY' && side !== 'SELL')) continue;
    trades.push({ id: String(t.trade_id), price, size, tMs, side });
  }
  trades.sort((a, b) => a.tMs - b.tMs);
  return { trades, bid: num(json && json.best_bid), ask: num(json && json.best_ask) };
}

// --- quote history ring ---
function createRing() {
  const m = new Map();  // id -> [{t, bid, ask}] ascending in t
  return {
    add(id, t, bid, ask, bidSize, askSize) {
      let a = m.get(id); if (!a) { a = []; m.set(id, a); }
      if (a.length && t <= a[a.length - 1].t) return;
      a.push({ t, bid, ask, bidSize: bidSize == null ? null : bidSize, askSize: askSize == null ? null : askSize });
      if (a.length > RING_CAP) a.splice(0, a.length - RING_CAP + 500);
    },
    latest(id) { const a = m.get(id); return a && a.length ? a[a.length - 1] : null; },
    // nearest sample in time (binary search), with its distance in seconds
    at(id, t) {
      const a = m.get(id); if (!a || !a.length) return null;
      let lo = 0, hi = a.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid].t < t) lo = mid + 1; else hi = mid; }
      let best = a[lo];
      if (lo > 0 && Math.abs(a[lo - 1].t - t) <= Math.abs(best.t - t)) best = a[lo - 1];
      return { ...best, lagSec: Math.abs(best.t - t) / 1000 };
    },
    size(id) { const a = m.get(id); return a ? a.length : 0; },
  };
}

// --- the core translation: one tape trade -> hypothetical hedged spread fill ---
// xName: which leg traded ('A' or 'B'); qA, qB: {bid, ask} quotes of the two legs.
// takerSide: 'BUY' | 'SELL' (aggressor on the tape). Returns null if quotes are unusable.
function synthFill(xName, price, takerSide, qA, qB, tick) {
  if (!qA || !qB || !(tick > 0)) return null;
  if (!(qA.bid > 0 && qA.ask > 0 && qB.bid > 0 && qB.ask > 0)) return null;
  const makerBought = takerSide === 'SELL';
  const synBid = qA.bid - qB.ask, synAsk = qA.ask - qB.bid;
  let spreadSide, s;
  if (xName === 'A') {
    if (makerBought) { spreadSide = 'BUY'; s = price - qB.bid; }
    else { spreadSide = 'SELL'; s = price - qB.ask; }
  } else {
    if (makerBought) { spreadSide = 'SELL'; s = qA.bid - price; }
    else { spreadSide = 'BUY'; s = qA.ask - price; }
  }
  // ticks away from the synthetic touch on the side we would have quoted:
  // a bought spread is a bid, measured up from the synthetic bid; a sold
  // spread is an offer, measured down from the synthetic offer.
  const distTicks = spreadSide === 'BUY' ? (s - synBid) / tick : (synAsk - s) / tick;
  const mid = (synBid + synAsk) / 2;
  const edgeMidTicks = (spreadSide === 'BUY' ? mid - s : s - mid) / tick;
  return { spreadSide, makerSide: makerBought ? 'BUY' : 'SELL', price: s, synBid, synAsk, distTicks, edgeMidTicks };
}

// Is the feed's `side` the taker's side or the maker's? Coinbase's own docs differ between
// its APIs, so check it against the tape instead of assuming: a taker BUY should trade at or
// above the future's own mid, a taker SELL at or below it.
function createSideChecker(mode) {
  let same = 0, flipped = 0;
  return {
    observe(feedSide, price, q) {
      if (!q || !(q.bid > 0 && q.ask > 0)) return;
      const mid = (q.bid + q.ask) / 2;
      if (price === mid) return;
      const takerFromPrice = price > mid ? 'BUY' : 'SELL';
      if (price > q.bid && price < q.ask) return; // inside the touch: ambiguous
      if (takerFromPrice === feedSide) same++; else flipped++;
    },
    takerSide(feedSide) {
      if (mode === 'taker') return feedSide;
      if (mode === 'maker') return feedSide === 'BUY' ? 'SELL' : 'BUY';
      const n = same + flipped;
      if (n >= 20 && flipped / n > 0.6) return feedSide === 'BUY' ? 'SELL' : 'BUY';
      return feedSide;
    },
    summary() { const n = same + flipped; return { mode, n, sameAsTaker: n ? same / n : null, active: mode === 'auto' ? (n >= 20 && flipped / n > 0.6 ? 'maker' : 'taker') : mode }; },
  };
}

// Tokens in scope come from the monitor's latest snapshot rows.
// scope row: { root, perp:{productId}, dated:{productId,Tms}, back:{...} }
const LEGS = { FRONT_PERP: ['FRONT', 'PERP'], BACK_PERP: ['BACK', 'PERP'], FRONT_BACK: ['FRONT', 'BACK'] };
function legIds(r) { return { PERP: r.perp && r.perp.productId, FRONT: r.dated && r.dated.productId, BACK: r.back && r.back.productId }; }

function createTape(opts) {
  const fetchJSON = opts.fetchJSON;
  const getScope = opts.getScope;                    // () => snapshot rows
  const tickOf = opts.tickOf;                        // (root) => spread tick
  const logPath = opts.logPath || null;
  const sweepMs = opts.sweepMs || 15000;
  const maxLagSec = opts.maxLagSec ?? 45;
  const minIntervalMs = opts.minIntervalMs || 150;
  const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const now = opts.now || (() => Date.now());
  const rootsFilter = opts.roots && opts.roots.length ? new Set(opts.roots.map(s => s.toUpperCase())) : null;
  const log = opts.log || (() => {});
  const pairsAllowed = opts.pairs && opts.pairs.length ? new Set(opts.pairs) : null;   // which spreads to pair trades into (default: all)
  const coveragePath = opts.coveragePath || null;
  const sweepTimes = [];            // ms timestamps of completed sweeps (persisted): what time the tape actually covered

  const ring = createRing();
  const seen = new Map();            // productId -> Set of trade ids
  const primed = new Set();          // productIds whose first (historic) page was swallowed
  const checker = createSideChecker(opts.sideMode || 'auto');
  const fills = [];                  // recent simulated fills (compact)
  const counters = { sweeps: 0, requests: 0, errors: 0, trades: 0, fills: 0, skippedLag: 0, skippedNoQuote: 0, lastSweepAt: null, lastSweepMs: null, lastError: null, startedAt: now() };
  let interval = minIntervalMs, nextSlot = 0, timer = null, running = false;

  async function pace() {
    const t = Date.now(); const slot = Math.max(t, nextSlot); nextSlot = slot + interval;
    if (slot > t) await sleep(slot - t);
  }
  async function get(url) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await pace(); counters.requests++;
      try { return await fetchJSON(url); }
      catch (e) {
        counters.errors++; counters.lastError = e.message.replace(/ for https?:\/\/\S+/, '');
        if (/HTTP 429/.test(e.message)) { interval = Math.min(interval * 1.6, 1500); await sleep(800 * (attempt + 1)); continue; }
        return null;
      }
    }
    return null;
  }

  function appendLog(rec) {
    if (!logPath) return;
    try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); fs.appendFileSync(logPath, JSON.stringify(rec) + '\n'); }
    catch (e) { counters.lastError = 'fill log: ' + e.message; }
  }

  function ingestTrades(row, xName, pid, parsed, tNow) {
    let s = seen.get(pid); if (!s) { s = new Set(); seen.set(pid, s); }
    const first = !primed.has(pid); primed.add(pid);
    const ids = legIds(row);
    for (const tr of parsed.trades) {
      if (s.has(tr.id)) continue;
      s.add(tr.id);
      if (first && tNow - tr.tMs > maxLagSec * 1000) continue;   // history from before we were watching
      counters.trades++;
      const qX = ring.at(pid, tr.tMs);
      if (qX && qX.lagSec <= maxLagSec) checker.observe(tr.side, tr.price, qX);
      const taker = checker.takerSide(tr.side);
      for (const [pair, [nA, nB]] of Object.entries(LEGS)) {
        if (nA !== xName && nB !== xName) continue;
        if (pairsAllowed && !pairsAllowed.has(pair)) continue;
        if (!ids[nA] || !ids[nB]) continue;
        const qA = ring.at(ids[nA], tr.tMs), qB = ring.at(ids[nB], tr.tMs);
        if (!qA || !qB) { counters.skippedNoQuote++; continue; }
        const lag = Math.max(qA.lagSec, qB.lagSec);
        if (lag > maxLagSec) { counters.skippedLag++; continue; }
        const tick = tickOf(row.root, qA, qB);
        const f = synthFill(nA === xName ? 'A' : 'B', tr.price, taker, qA, qB, tick);
        if (!f) { counters.skippedNoQuote++; continue; }
        const rec = {
          t: new Date(tr.tMs).toISOString(), root: row.root, pair, leg: xName, pid, tid: tr.id, px: tr.price, size: tr.size,
          feedSide: tr.side, taker, maker: f.makerSide, side: f.spreadSide, spx: +f.price.toPrecision(10),
          synBid: +f.synBid.toPrecision(10), synAsk: +f.synAsk.toPrecision(10),
          dist: +f.distTicks.toFixed(3), edgeMid: +f.edgeMidTicks.toFixed(3), lag: +lag.toFixed(1), tick,
        };
        counters.fills++;
        pushFill({ ...rec, tMs: tr.tMs });
        appendLog(rec);
        if (opts.onFill) { try { opts.onFill({ ...rec, tMs: tr.tMs }); } catch (e) { counters.lastError = 'onFill: ' + e.message; } }
      }
    }
    if (s.size > SEEN_CAP) { const keep = [...s].slice(-SEEN_CAP / 2); seen.set(pid, new Set(keep)); }
  }
  function pushFill(f) {
    fills.push(f);
    if (fills.length > MEM_FILL_CAP) fills.splice(0, fills.length - MEM_FILL_CAP + 5000);
  }

  async function sweep() {
    if (running) return; running = true;
    const t0 = Date.now();
    try {
      const rows = (getScope() || []).filter(r => r.perp && (r.dated || r.back) && (!rootsFilter || rootsFilter.has(String(r.root).toUpperCase())));
      for (const row of rows) {
        const ids = legIds(row);
        for (const name of ['PERP', 'FRONT', 'BACK']) {
          const id = ids[name]; if (!id) continue;
          const j = await get(`${BOOK_URL}?product_id=${encodeURIComponent(id)}&limit=1`);
          const b = j && parseBook(j);
          if (b && !b.error) ring.add(id, Date.now(), b.bid, b.ask, b.bidSize, b.askSize);
        }
        for (const name of ['FRONT', 'BACK']) {
          const id = ids[name]; if (!id) continue;
          const j = await get(`${PRODUCTS_URL}/${encodeURIComponent(id)}/ticker?limit=100`);
          if (j) ingestTrades(row, name, id, parseTicker(j), Date.now());
        }
      }
      counters.sweeps++; counters.lastSweepAt = now();
      { const tt = now() - (Date.now() - t0); sweepTimes.push(tt); if (sweepTimes.length > 20000) sweepTimes.splice(0, 2000);
        if (coveragePath) { try { fs.mkdirSync(path.dirname(coveragePath), { recursive: true }); fs.appendFileSync(coveragePath, tt + '\n'); } catch { /* best effort */ } } } counters.lastSweepMs = Date.now() - t0;
      if (opts.onSweep) { try { opts.onSweep(); } catch (e) { counters.lastError = 'onSweep: ' + e.message; } }
      const cut = now() - KEEP_MS; let k = 0; while (k < fills.length && fills[k].tMs < cut) k++; if (k) fills.splice(0, k);
    } catch (e) { counters.lastError = e.message; log('tape sweep failed: ' + e.message); }
    finally { running = false; }
  }

  // Fill-rate curve for one token/pair on the side we would quote ('BUY' = bid, 'SELL' = offer):
  // for d in [dMin..dMax], how many hypothetical fills per hour sit at distance <= d (a resting
  // quote d ticks inside the synthetic touch would have been hit by all of them).
  // Time the tape was actually running inside the window: the sum of gaps between consecutive
  // sweeps (gaps longer than maxGapMs are downtime and are not counted), and when coverage began.
  function coverage(windowMs, maxGapMs = 10 * 60_000) {
    const t1 = now(), t0 = t1 - windowMs; let covered = 0, start = null, prev = null;
    for (const t of sweepTimes) {
      if (t < t0) continue;
      if (start == null) start = t;
      if (prev != null && t - prev <= maxGapMs) covered += t - prev;
      prev = t;
    }
    if (prev != null && t1 - prev <= maxGapMs) covered += t1 - prev;
    return { coveredMs: covered, startMs: start };
  }
  function curve(root, pair, side, o = {}) {
    const windowMs = o.windowMs || 6 * 3600_000, dMin = o.dMin ?? -3, dMax = o.dMax ?? 20;
    const t1 = now(); const cov = coverage(windowMs);
    // only count fills from times the tape was covering, and divide by that same covered time
    const startMs = cov.startMs == null ? t1 : cov.startMs; const elapsed = Math.max(60_000, cov.coveredMs);
    // perp-hedged spreads: pick fills by the traded CONTRACT, so a month that rolls from 2nd to 1st keeps its history
    const byProd = o.pid && /_PERP$/.test(pair);
    const sel = fills.filter(f => f.root === root && (byProd ? (f.pid === o.pid && /_PERP$/.test(f.pair)) : f.pair === pair) && f.side === side && f.tMs >= startMs && f.tMs >= t1 - windowMs);
    const out = [];
    const clip = o.clip > 0 ? o.clip : Infinity, hrs = elapsed / 3600_000;
    const nb = dMax - dMin + 1, bn = new Array(nb + 1).fill(0), bs = new Array(nb + 1).fill(0), bc = new Array(nb + 1).fill(0);
    for (const f of sel) {   // a fill at distance x is counted for every d >= x
      let i = Math.ceil(f.dist - dMin - 1e-9); if (i < 0) i = 0; if (i > nb - 1) continue;
      bn[i]++; bs[i] += f.size; bc[i] += Math.min(f.size, clip);
    }
    let n = 0, sz = 0, cz = 0;
    for (let i = 0; i < nb; i++) {
      n += bn[i]; sz += bs[i]; cz += bc[i];
      out.push({ d: dMin + i, events: n, contracts: sz, eventsPerHr: n / hrs, contractsPerHr: sz / hrs, clipContractsPerHr: cz / hrs });
    }
    return { root, pair, side, windowHrs: elapsed / 3600_000, total: sel.length, points: out };
  }

  // Warm start: reload the last day of simulated fills from the jsonl log.
  async function loadHistory() {
    if (coveragePath && fs.existsSync(coveragePath)) {
      const cut0 = now() - KEEP_MS;
      for (const line of fs.readFileSync(coveragePath, 'utf8').split('\n')) { const t = parseInt(line, 10); if (t >= cut0) sweepTimes.push(t); }
    }
    if (!logPath || !fs.existsSync(logPath)) return 0;
    let n = 0; const cut = now() - KEEP_MS;
    const rl = readline.createInterface({ input: fs.createReadStream(logPath, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      try { const r = JSON.parse(line); const tMs = Date.parse(r.t); if (tMs >= cut && (!pairsAllowed || pairsAllowed.has(r.pair))) { pushFill({ ...r, tMs }); n++; } } catch { /* skip */ }
    }
    return n;
  }

  function start() {
    if (timer) return;
    sweep();
    timer = setInterval(() => sweep().catch(() => {}), sweepMs);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return {
    start, stop, sweep, loadHistory, curve, coverage, ring, checker, counters,
    recentFills: (o = {}) => fills.filter(f => (!o.root || f.root === o.root)).slice(-(o.limit || 200)).reverse(),
    allFills: () => fills,
    status: () => ({ ...counters, interval, sweepMs, side: checker.summary(), fillsInMemory: fills.length }),
  };
}

module.exports = { parseTicker, createRing, synthFill, createSideChecker, createTape, LEGS, legIds };
