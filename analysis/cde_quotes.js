'use strict';
// analysis/cde_quotes.js
//
// Shadow "quote sheet": for each token/spread, where we WOULD quote, in spread ticks.
// Pure functions; nothing here talks to the exchange.
//
// For a spread S = A - B (hedge leg = B for A-quotes), working in ticks:
//   c        = fee ticks + slippage ticks + beta ticks          (all-in cost per hedged fill)
//   m        = fair value, from a time-decayed average of the spread's own APY
//              (m = A* x horizon/365 x refPrice, so it shrinks as expiry nears)
//   ceiling  = floor(m - c - e_min + w*p)   highest bid that still earns e_min
//   floor    = ceil (m + c + e_min + w*p)   lowest offer that still earns e_min
//   (p = expected funding in ticks per cycle for the BUY side, w = its weight; w*p is 0 unless kappa > 0)
// Quoted futures price (hedged at the other leg's touch):
//   future bid   = B.bid + S_bid      (we would hit B's bid to hedge)
//   future offer = B.ask + S_ask      (we would lift B's ask to hedge)
// The ladder starts at the best level and steps one tick away per level; no level may cross
// the synthetic market (a bid must stay below the synthetic offer, an offer above the synthetic bid).

const YEAR_MS = 365 * 24 * 3600 * 1000;

const DEFAULTS = {
  feeExchange: 0.03,     // $ per contract per trade, paid to the exchange (every trade, maker or taker)
  feeClearing: 0.02,     // $ per contract per trade, paid to the clearing firm
  feeLegs: 2,            // a hedged fill trades two legs (the quoted future and the hedge)
  feeBasis: 'fill',      // 'fill': charge one hedged fill ($0.10); 'roundtrip': charge open + close ($0.20) on every fill
  pairs: ['FRONT_PERP', 'BACK_PERP'],   // spreads we quote and track (hedged with the perp); FRONT_BACK is opt-in
  eMinTicks: 0.5,        // least profit per fill, after all costs
  betaTicks: 0.5,        // safety buffer for hedge delay / adverse perp move
  slipTicks: 0,          // extra slippage allowance (touch size only, so 0 for a 1-clip hedge)
  levels: 1,             // best bid + best offer only; set CDE_Q_LEVELS=3 to ladder
  clipUsd: 2000,
  limitUsd: 100000,
  halfLifeMin: 360,      // fair-value memory
  warmupMin: 30,         // do not trust fair value before this much history
  kappa: 0,              // weight on predicted funding (0 = ignore)
  fundHorizonH: 1,       // how fast the funding weight fades with time to the payment
  monthlyVolume: null,   // total CDE contracts per month (V), for the volume incentive; null = incentive off
  incentiveUsd: 5000,    // pool paid for incentivePct of monthly volume
  incentivePct: 1,
  minHorizonDays: 1,     // do not quote a contract that expires in less than this (we never hold to expiry)
  minCoverageMin: 30,    // tape must have run this long before its fill rates are trusted
  minFillsForCurve: 8,   // fewer simulated fills than this => fall back to the ceiling
};

// ---- fair value state: EWMA of the spread's mid APY per token/pair ----
function createFairValue(opts = {}) {
  const halfLifeMs = (opts.halfLifeMin ?? DEFAULTS.halfLifeMin) * 60_000;
  const st = new Map();
  return {
    update(key, apy, tMs) {
      if (apy == null || !isFinite(apy)) return;
      let s = st.get(key);
      if (!s) { st.set(key, { apy, n: 1, since: tMs, last: tMs }); return; }
      const dt = Math.max(0, tMs - s.last);
      const a = 1 - Math.pow(2, -dt / halfLifeMs);
      s.apy += a * (apy - s.apy); s.n++; s.last = tMs;
    },
    get(key) { return st.get(key) || null; },
    export() { return Object.fromEntries(st); },
    import(obj) { for (const [k, v] of Object.entries(obj || {})) if (v && isFinite(v.apy) && v.since && v.last) st.set(k, v); },
    _state: st,
  };
}

// Pair geometry from a snapshot row (same convention as the Bid/Ask tab).
function pairGeometry(row, pair, nowMs, snapAtMs) {
  const names = { FRONT_PERP: ['FRONT', 'PERP'], BACK_PERP: ['BACK', 'PERP'], FRONT_BACK: ['FRONT', 'BACK'] }[pair];
  const leg = { PERP: row.perp, FRONT: row.dated, BACK: row.back };
  const A = leg[names[0]], B = leg[names[1]];
  if (!A || !B) return null;
  // Tms is time to expiry as of the snapshot; age it forward.
  const aged = (l) => (l && l.Tms != null) ? l.Tms - Math.max(0, nowMs - (snapAtMs || nowMs)) : null;
  let horizonMs;
  if (pair === 'FRONT_BACK') horizonMs = aged(row.back) - aged(row.dated);
  else horizonMs = names[0] === 'FRONT' ? aged(row.dated) : aged(row.back);
  if (!(horizonMs > 0)) return null;
  return { nameA: names[0], nameB: names[1], idA: A.productId, idB: B.productId, horizonMs, contractSize: A.contractSize };
}

// Fair value is remembered per CONTRACT pair (not 'front'/'back'), so when a month expires the new front
// month keeps the history it built up as the back month, and the newly listed month starts fresh.
function fvKey(root, g) { return `${root}|${g.idA}|${g.idB}`; }

function annFactor(horizonMs) { return YEAR_MS / horizonMs * 100; }   // % per unit of (spread/ref)

// Called every tape sweep to keep the fair value current.
function updateFairValues(fv, rows, ring, nowMs, snapAtMs, pairs) {
  for (const row of rows) {
    for (const pair of ['FRONT_PERP', 'BACK_PERP', 'FRONT_BACK']) {
      if (pairs && !pairs.includes(pair)) continue;
      const g = pairGeometry(row, pair, nowMs, snapAtMs); if (!g) continue;
      const qA = ring.latest(g.idA), qB = ring.latest(g.idB);
      if (!qA || !qB || nowMs - qA.t > 120_000 || nowMs - qB.t > 120_000) continue;
      const midA = (qA.bid + qA.ask) / 2, midB = (qB.bid + qB.ask) / 2;
      const ref = g.nameB === 'PERP' ? midB : midA;
      fv.update(fvKey(row.root, g), (midA - midB) / ref * annFactor(g.horizonMs), nowMs);
    }
  }
}

function nextTopOfHourHours(nowMs) { const d = new Date(nowMs); return (60 - d.getUTCMinutes() - d.getUTCSeconds() / 60) / 60; }

// expected profit per hour for a candidate level, using the simulated fill-rate curve
function evalLevel(side, k, ctx) {
  const { tick, mT, c, wp, curve, kSynBid, kSynAsk, dollarsPerTick, contracts } = ctx;
  const edge = side === 'BUY' ? (mT + wp - c - k) : (k - mT - wp - c);
  const dist = side === 'BUY' ? (k - kSynBid) : (kSynAsk - k);
  let rate = null, cph = null;
  if (curve && curve.points) {
    const pt = curve.points.find(p => p.d === Math.round(dist)) || (dist > curve.points[curve.points.length - 1].d ? curve.points[curve.points.length - 1] : null);
    if (pt) { rate = pt.eventsPerHr; cph = pt.clipContractsPerHr != null ? pt.clipContractsPerHr : pt.eventsPerHr * contracts; }
  }
  return { k, dist, edge, rate, contractsPerHr: cph, expUsdPerHr: cph == null ? null : cph * edge * dollarsPerTick };
}

// Build one quote-sheet entry. Returns { error } when we cannot price it.
function buildQuote(row, pair, env) {
  const { params, ring, fv, tapeCurve, tickOf, nowMs, snapAtMs } = env;
  const g = pairGeometry(row, pair, nowMs, snapAtMs);
  if (!g) return { root: row.root, pair, error: 'no horizon / missing leg' };
  if (g.horizonMs < params.minHorizonDays * 86400000) return { root: row.root, pair, error: `expires in under ${params.minHorizonDays} day${params.minHorizonDays === 1 ? '' : 's'}: not quoted` };
  const qA = ring.latest(g.idA), qB = ring.latest(g.idB);
  if (!qA || !qB) return { root: row.root, pair, error: 'no quotes yet' };
  const ageSec = Math.max(nowMs - qA.t, nowMs - qB.t) / 1000;
  if (ageSec > 120) return { root: row.root, pair, error: `quotes ${ageSec.toFixed(0)}s old` };
  const tick = tickOf(row.root, qA, qB);
  if (!(tick > 0)) return { root: row.root, pair, error: 'no tick' };
  if (!(g.contractSize > 0)) return { root: row.root, pair, error: 'no contract size' };

  const midA = (qA.bid + qA.ask) / 2, midB = (qB.bid + qB.ask) / 2;
  const ref = g.nameB === 'PERP' ? midB : midA;
  const ann = annFactor(g.horizonMs);
  const synBid = qA.bid - qB.ask, synAsk = qA.ask - qB.bid;
  const kSynBid = Math.round(synBid / tick), kSynAsk = Math.round(synAsk / tick);
  const dollarsPerTick = tick * g.contractSize;
  const contracts = Math.max(1, Math.round(params.clipUsd / (g.contractSize * midA)));
  const feePerFillUsd = (params.feeExchange + params.feeClearing) * params.feeLegs * (params.feeBasis === 'roundtrip' ? 2 : 1);
  const feeTicks = feePerFillUsd / dollarsPerTick;
  const c = feeTicks + params.slipTicks + params.betaTicks;

  const f = fv.get(fvKey(row.root, g));
  const warm = !!f && (nowMs - f.since) >= params.warmupMin * 60_000;
  const fairApy = f ? f.apy : null;
  const mPx = fairApy == null ? null : fairApy / ann * ref;     // spread price
  const mT = mPx == null ? null : mPx / tick;

  // predicted funding, BUY-spread side, in ticks per cycle (perp pairs only)
  let pT = 0, w = 0;
  if (params.kappa > 0 && g.nameB === 'PERP' && row.perp && row.perp.fundingRate != null) {
    pT = row.perp.fundingRate * midB / tick;
    w = params.kappa * Math.exp(-nextTopOfHourHours(nowMs) / params.fundHorizonH);
  }
  const wp = w * pT;

  const base = {
    root: row.root, pair, tick, dollarsPerTick, contracts, feeTicks, feePerFillUsd, cTicks: c, horizonDays: g.horizonMs / 86400000,
    synBid, synAsk, kSynBid, kSynAsk, synWidthTicks: kSynAsk - kSynBid, midA, midB, ref, fairApy, mPx, mT, warm, fairN: f ? f.n : 0,
    quoteAgeSec: ageSec, wpTicks: wp, bidHedgeBase: qB.bid, askHedgeBase: qB.ask, nameA: g.nameA, nameB: g.nameB,
  };
  if (mT == null) return { ...base, error: 'fair value warming up' };

  const ceil = Math.floor(mT - c - params.eMinTicks + wp + 1e-9);
  const floor = Math.ceil(mT + c + params.eMinTicks + wp - 1e-9);
  const bidTop = Math.min(ceil, kSynAsk - 1);      // cannot cross the synthetic offer
  const askTop = Math.max(floor, kSynBid + 1);     // cannot cross the synthetic bid
  const bidOk = ceil >= kSynBid - 3, askOk = floor <= kSynAsk + 3;   // far behind the market = nothing sensible to post

  const mkSide = (side) => {
    const curve = tapeCurve ? tapeCurve(row.root, pair, side, contracts, g.idA) : null;
    const enough = curve && curve.total >= params.minFillsForCurve && curve.windowHrs * 60 >= params.minCoverageMin;
    const top = side === 'BUY' ? bidTop : askTop;
    const ctx = { tick, mT, c, wp, curve: enough ? curve : null, kSynBid, kSynAsk, dollarsPerTick, contracts };
    // candidates run from the limit back toward the synthetic touch
    const cands = [];
    const lo = side === 'BUY' ? Math.max(kSynBid - 1, top - 12) : top;
    const hi = side === 'BUY' ? top : Math.min(kSynAsk + 1, top + 12);
    for (let k = lo; k <= hi; k++) cands.push(evalLevel(side, k, ctx));
    const valid = cands.filter(x => x.edge >= params.eMinTicks - 1e-9);
    let start = top, pick = 'limit';
    if (enough && valid.length) {
      const best = valid.filter(x => x.expUsdPerHr != null).sort((a, b) => b.expUsdPerHr - a.expUsdPerHr)[0];
      if (best && best.expUsdPerHr > 0) { start = best.k; pick = 'fill-rate'; }
    }
    const levels = [];
    for (let j = 0; j < params.levels; j++) {
      const k = side === 'BUY' ? start - j : start + j;
      const e = evalLevel(side, k, ctx);
      if (side === 'BUY' && k > kSynAsk - 1) continue;
      if (side === 'SELL' && k < kSynBid + 1) continue;
      if (e.edge < params.eMinTicks - 1e-9) continue;
      const spreadPx = k * tick;
      const hedgeTouch = side === 'BUY' ? qB.bidSize : qB.askSize;   // size available on the leg we would hit to hedge
      levels.push({ ...e, spreadPx, hedgeTouch, hedgeShort: hedgeTouch != null && hedgeTouch < contracts, futurePx: side === 'BUY' ? qB.bid + spreadPx : qB.ask + spreadPx,
        edgeUsd: e.edge * dollarsPerTick * contracts });
    }
    return { side, top, pick, curveFills: curve ? curve.total : 0, curveHrs: curve ? curve.windowHrs : 0, levels, candidates: cands };
  };

  const bid = mkSide('BUY'), ask = mkSide('SELL');
  const incPerContract = params.monthlyVolume > 0 ? params.incentiveUsd / (params.incentivePct / 100 * params.monthlyVolume) : null;
  const topOf = (L) => { const l = L.levels[0]; if (!l) return null; const c = L.candidates.find(x => x.k === l.k) || {}; return { ...l, contractsPerHr: c.contractsPerHr ?? null, expUsdPerHr: c.expUsdPerHr ?? null, rate: c.rate ?? null }; };
  const tb = topOf(bid), ta = topOf(ask);
  const sum = (a, b) => (a == null && b == null) ? null : (a || 0) + (b || 0);
  const edgeUsdHr = sum(tb && tb.expUsdPerHr, ta && ta.expUsdPerHr);
  const contractsHr = sum(tb && tb.contractsPerHr, ta && ta.contractsPerHr);
  const incUsdHr = (contractsHr != null && incPerContract != null) ? contractsHr * incPerContract : null;
  const legA = { PERP: row.perp, FRONT: row.dated, BACK: row.back }[g.nameA];
  const summary = { edgeUsdHr, contractsHr, incUsdHr, totalUsdHr: edgeUsdHr == null ? null : edgeUsdHr + (incUsdHr || 0),
    bidEdgeUsd: tb ? tb.edgeUsd : null, askEdgeUsd: ta ? ta.edgeUsd : null, bidEdgeT: tb ? tb.edge : null, askEdgeT: ta ? ta.edge : null,
    bidDist: tb ? tb.dist : null, askDist: ta ? ta.dist : null, bidFillsHr: tb ? tb.rate : null, askFillsHr: ta ? ta.rate : null,
    vol24: legA && legA.vol24 != null ? legA.vol24 : null, incPerContract };
  return { ...base, ceil, floor, bidTop, askTop, bidOk, askOk, bid, ask, summary };
}

function buildQuoteSheet(rows, env) {
  const out = [];
  for (const row of rows) {
    for (const pair of ['FRONT_PERP', 'BACK_PERP', 'FRONT_BACK']) {
      if (env.params.pairs && !env.params.pairs.includes(pair)) continue;
      if (pair === 'FRONT_PERP' && !(row.dated && row.perp)) continue;
      if (pair === 'BACK_PERP' && !(row.back && row.perp)) continue;
      if (pair === 'FRONT_BACK' && !(row.dated && row.back)) continue;
      out.push(buildQuote(row, pair, env));
    }
  }
  return out;
}

module.exports = { DEFAULTS, createFairValue, updateFairValues, buildQuote, buildQuoteSheet, pairGeometry, annFactor, evalLevel };
