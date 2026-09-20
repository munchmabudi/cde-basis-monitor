// analysis/cde_dated_mm.js
// CDE Dated Futures MM vs Perp Hedge — pure viability sim.
//
// QUESTION THIS ANSWERS:
// For a given token, if we market-make the CDE dated future (front + second
// month) with a synthetic 10bps bid/ask width at $5k notional per side, and
// hedge each fill in the CDE perp at midpoint, is the hedge profitable
// after fees?
//
// MODEL (keyless synthetic-quote — CDE has NO public order book):
//   MM leg:   bid = F × (1 − W/2), ask = F × (1 + W/2), W = 10bps total
//             notional per side = $5,000  →  n = floor(5000 / (cs × F))
//             half-spread earned per fill = (W/2) × actual_notional
//             actual_notional = n × cs × F
//   Hedge leg: keyless at perp midpoint P (no public book to walk)
//              n_perp = n (same contract size for future & perp on CDE)
//   Fees:     $0.07/contract per side ($0.02 clearing + $0.05 exchange)
//             round-trip per fill = 2 × $0.07 × n  (future leg + perp leg)
//   Slippage: 0 (keyless at midpoint — the user explicitly approved this
//             proxy when no order book is available)
//
// EDGE (per fill, one side hit):
//   combined = half_spread_dollars − fees_per_fill
//   bid_hit  = half_spread_dollars − basis_dollars − fees_per_fill
//   ask_hit  = half_spread_dollars + basis_dollars − fees_per_fill
//   (basis_dollars = n × cs × (F − P); cancels in combined)
//
// CARRY (context — what happens if hedge is held to expiry):
//   basisAPY = (F − S) / S × (365/T_years) × 100
//   fundAPY  = funding_rate × 8760 × 100  (hourly funding → 8760/yr)
//   divergence = basisAPY − fundAPY  (positive = future rich → short future/long perp carry)
//
// VERDICT: profitable = combined_per_fill > 0
//   (the half-spread must exceed the round-trip fees)

const DAY_MS = 86_400_000;
const SECS_PER_YEAR = 365 * 24 * 3600;
const FUNDING_SECS_PER_YEAR = SECS_PER_YEAR / 3600; // 8760 for hourly

const DEFAULT_PARAMS = {
  widthBps: 10,        // total bid/ask spread (5bps each side)
  notionalUsd: 5000,   // USD notional per side
  feePerContract: 0.07, // $0.02 clearing + $0.05 exchange
};

// Fallback contract sizes (nano contracts, from CDE exchange product spec sheets).
// Used only if the API doesn't return contract_size for a product. The API
// returns it as a string per product, so this is a safety net.
const SPEC_BY_ROOT = {
  BTC: 0.01,       ETH: 0.1,    SOL: 5,      XRP: 500,
  DOGE: 5000,      SHIB: 10000, ADA: 1000,   AVAX: 10,
  BNB: 1,          BCH: 1,     HYPE: 10,    LINK: 50,
  SUI: 500,        DOT: 100,    XLM: 5000,   HBAR: 5000,
  PEPE: 100_000_000,  // 1kPEPE = 100M PEPE/contract
};

function num(v) {
  if (v === '' || v == null) return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function parseInterval(s) {
  if (!s) return null;
  const m = /(\d+)s/.exec(s);
  return m ? parseInt(m[1], 10) : null;
}

// Parse CDE API product list into per-root structures.
// Returns: Map<root, { perp: prod|null, dated: [prod,prod,...] }>
// Each prod: { productId, code, mid, contractSize, Tms, expiry,
//   fundingRate, fundingSec, index, vol24, oi, isPerp }
function parseProducts(futureProducts) {
  const byRoot = {};
  for (const p of (futureProducts || [])) {
    const fd = p.future_product_details || {};
    const root = fd.contract_root_unit;
    if (!root) continue;

    const isPerp = !!fd.funding_interval;  // "" → dated, "3600s" → perp
    const mid = num(p.mid_market_price);
    const rec = {
      productId:   p.product_id || p.productId,
      code:        fd.contract_code,
      mid:         mid,
      contractSize: num(fd.contract_size),
      Tms:         num(fd.time_to_expiry_ms),
      expiry:      fd.contract_expiry,
      fundingRate: isPerp ? num(fd.funding_rate) : null,
      fundingSec:  isPerp ? parseInterval(fd.funding_interval) : null,
      index:       isPerp ? num(fd.index_price) : null,
      vol24:       num(p.approximate_quote_24h_volume),
      oi:          num(fd.open_interest),
      isPerp,
    };

    if (!byRoot[root]) byRoot[root] = { perp: null, dated: [] };
    if (isPerp) byRoot[root].perp = rec;
    else if (mid > 0 && rec.Tms > 0) byRoot[root].dated.push(rec);
  }

  // Sort dated by time-to-expiry ascending (front = nearest)
  for (const root of Object.keys(byRoot)) {
    byRoot[root].dated.sort((a, b) => a.Tms - b.Tms);
  }
  return byRoot;
}

// Carry calculations: basis APY, funding APY, divergence
function computeCarry(dated, perp) {
  const S = (perp.index && perp.index > 0) ? perp.index : perp.mid;
  const basisAPY = (dated.mid - S) / S * (SECS_PER_YEAR * 1000 / dated.Tms) * 100;
  const fundAPY = (perp.fundingRate != null && perp.fundingSec)
    ? perp.fundingRate * (SECS_PER_YEAR / perp.fundingSec) * 100
    : null;
  const divergence = (fundAPY != null) ? basisAPY - fundAPY : null;
  const gap = (perp.mid - S) / S * 100;
  return {
    basisAPY: isFinite(basisAPY) ? basisAPY : null,
    fundAPY,
    gap,
    divergence,
    spotRef: S,
  };
}

// Simulate MM viability for ONE dated future leg vs the perp hedge
function simulateLeg(dated, perp, params) {
  const { widthBps, notionalUsd, feePerContract } = params;
  const halfSpreadBps = widthBps / 2;

  const F = dated.mid;
  const P = perp.mid;
  const csRaw = dated.contractSize || SPEC_BY_ROOT[dated.code?.replace(/-.*/, '').replace(/['\d]/g, '')] || SPEC_BY_ROOT[dated.root];
  const cs = csRaw || SPEC_BY_ROOT[dated.root];

  if (!F || !P || !cs) return null;

  // Contract count for target notional (floor — can't trade fractional contracts)
  const n = Math.floor(notionalUsd / (cs * F));
  if (n === 0) return null;

  const actualNotional = n * cs * F;
  const halfSpreadDollars = (halfSpreadBps / 1e4) * actualNotional;

  // Round-trip fees: future leg + perp hedge leg (both $0.07/contract)
  const feesPerFill = 2 * feePerContract * n;
  const netPerFill = halfSpreadDollars - feesPerFill;

  // Basis: future vs perp mid (immediate P&L when hedging at perp mid)
  const basisDollars = n * cs * (F - P);
  const basisBps = (F - P) / P * 1e4;

  // Per-side edges (basis doesn't cancel — direction matters)
  const bidHitEdge = halfSpreadDollars - basisDollars - feesPerFill;  // buy future, short perp hedge
  const askHitEdge = halfSpreadDollars + basisDollars - feesPerFill;  // sell future, long perp hedge

  const carry = computeCarry(dated, perp);

  return {
    contracts: n,
    actualNotional,
    halfSpreadDollars,
    feesPerFill,
    netPerFill,
    basisBps,
    basisDollars,
    bidHitEdge,
    askHitEdge,
    profitable: netPerFill > 0,
    carry,
  };
}

// Main entry: simulate for ALL tokens with perp + at least 2 dated contracts
function simulateAllTokens(byRoot, params = DEFAULT_PARAMS) {
  const results = [];

  for (const [root, data] of Object.entries(byRoot)) {
    const { perp, dated } = data;
    if (!perp || dated.length < 2) continue;

    // Skip if any leg has a stale/zero mid
    if (perp.mid <= 0 || dated[0].mid <= 0 || dated[1].mid <= 0) continue;

    // Contract size override: prefer API value, fall back to known spec
    const fixupCs = (rec) => {
      if (rec.contractSize && rec.contractSize > 0) return rec;
      return { ...rec, contractSize: SPEC_BY_ROOT[root] || null };
    };
    const front = fixupCs(dated[0]);
    const back = fixupCs(dated[1]);

    const frontSim = simulateLeg({ ...front, root }, perp, params);
    const backSim  = simulateLeg({ ...back, root }, perp, params);
    if (!frontSim || !backSim) continue;

    results.push({
      root,
      perp: {
        mid: perp.mid,
        fundingRate: perp.fundingRate,
        fundAPY: frontSim.carry.fundAPY,
        gap: frontSim.carry.gap,
        index: perp.index,
        vol24: perp.vol24,
      },
      front: {
        mid: front.mid, Tms: front.Tms, expiry: front.expiry, vol24: front.vol24,
        ...frontSim,
      },
      back: {
        mid: back.mid, Tms: back.Tms, expiry: back.expiry, vol24: back.vol24,
        ...backSim,
      },
    });
  }

  // Sort by combined net (front + back) descending
  results.sort((a, b) =>
    (b.front.netPerFill + b.back.netPerFill) - (a.front.netPerFill + a.back.netPerFill)
  );
  return results;
}

module.exports = {
  DAY_MS, SECS_PER_YEAR, FUNDING_SECS_PER_YEAR,
  DEFAULT_PARAMS, SPEC_BY_ROOT,
  num, parseInterval,
  parseProducts, computeCarry, simulateLeg, simulateAllTokens,
};
