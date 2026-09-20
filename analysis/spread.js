// analysis/spread.js
// Tracks bid/ask spread width over time for each venue, compares them,
// and evaluates the core MM + funding carry thesis:
//
//   EARN:  Kalshi spread (you post bid+ask, earn half-spread on each fill)
//   PAY:   HL spread (you hedge each Kalshi fill immediately on HL)
//   EARN:  Funding differential (short HL when HL funding > Kalshi funding)
//   PAY:   HL taker fee (each hedge leg)
//   EARN:  Kalshi maker fee rebate (if any - currently 0.05% maker)
//
// Net edge per round-trip =
//   (kalshi_half_spread - hl_half_spread) + funding_carry - hl_taker_fee - kalshi_maker_fee
//
// We also track spread history so you can see if Kalshi spread is
// consistently wide enough to be worth quoting into.

const config = require('../config');

// Rolling history — keeps last N observations per venue
const HISTORY_SIZE = 60; // 60 minutes of 1-minute polls
const history = {
  kalshi:      [],
  hyperliquid: [],
  kraken:      [],
};

/**
 * Compute spread metrics for a single venue snapshot.
 * Returns spread in both dollar terms and basis points of mid price.
 */
function computeSpread(snap) {
  if (!snap || snap.error) return null;

  const mid = (snap.bestBid + snap.bestAsk) / 2;
  const spreadDollars = snap.bestAsk - snap.bestBid;
  const spreadBps = mid > 0 ? (spreadDollars / mid) * 10_000 : NaN;
  const halfSpreadBps = spreadBps / 2;

  return {
    venue: snap.venue,
    mid,
    bestBid: snap.bestBid,
    bestAsk: snap.bestAsk,
    spreadDollars,
    spreadBps,
    halfSpreadBps,
    timestamp: snap.timestamp ?? new Date().toISOString(),
  };
}

/**
 * Record a new observation into rolling history.
 */
function record(snap) {
  const s = computeSpread(snap);
  if (!s) return null;

  const h = history[snap.venue];
  if (h) {
    h.push(s);
    if (h.length > HISTORY_SIZE) h.shift();
  }

  return s;
}

/**
 * Compute rolling stats for a venue's spread history.
 */
function rollingStats(venue) {
  const h = history[venue];
  if (!h || h.length === 0) return null;

  const spreads = h.map((x) => x.spreadBps).filter((x) => !isNaN(x));
  if (spreads.length === 0) return null;

  const avg = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  const min = Math.min(...spreads);
  const max = Math.max(...spreads);
  const latest = spreads[spreads.length - 1];

  return { venue, avg, min, max, latest, n: spreads.length };
}

/**
 * Core MM thesis evaluation: given Kalshi and HL snapshots,
 * compute whether posting two-sided on Kalshi and hedging on HL is viable.
 *
 * Assumes:
 *   - You post at Kalshi mid ± half_spread (earning the full spread when
 *     both sides fill, or half-spread per one-sided fill)
 *   - Each Kalshi fill is immediately hedged on HL at taker
 *   - You hold the HL hedge until the next funding payment, then close
 *
 * Returns a full breakdown in bps so you can see exactly where money
 * is made and lost.
 */
function evaluateMMThesis(kalshiSnap, hlSnap, opts = {}) {
  const holdingHours = opts.assumedHoldingHours ?? config.assumedHoldingHours;

  const kalshi = computeSpread(kalshiSnap);
  const hl     = computeSpread(hlSnap);

  if (!kalshi || !hl) return { viable: false, reason: 'missing_data' };

  // What you earn quoting Kalshi: half the spread per fill (one side)
  // If both sides fill (full round-trip), you earn the full spread.
  // Use half-spread as the per-leg unit since each fill is independent.
  const kalshiEarnBps = kalshi.halfSpreadBps;

  // What you pay hedging on HL: taker fee + HL half-spread slippage
  const hlTakerFeeBps  = config.fees.hyperliquid.taker * 10_000;
  const hlSlippageBps  = hl.halfSpreadBps; // expected slippage crossing HL spread
  const hlHedgeCostBps = hlTakerFeeBps + hlSlippageBps;

  // Kalshi maker fee (paid on your posted orders when they fill)
  const kalshiMakerFeeBps = config.fees.kalshi.maker * 10_000;

  // Funding carry: you're short HL (to hedge Kalshi long fills) or long HL
  // (to hedge Kalshi short fills). Net carry depends on which side fills.
  // Use the absolute HL funding rate — positive = you collect as short hedge.
  const hlAnnualFundingPct    = hlSnap.fundingRate * (8760 / hlSnap.fundingIntervalHours) * 100;
  const kalshiAnnualFundingPct = kalshiSnap.fundingRate * (8760 / kalshiSnap.fundingIntervalHours) * 100;

  // If HL funding > 0, longs pay shorts → being short HL earns funding
  // Net funding per hedge leg over holding period (in bps)
  const netAnnualFundingPct = hlAnnualFundingPct - kalshiAnnualFundingPct;
  const fundingCarryBps = netAnnualFundingPct * 100 * (holdingHours / (365 * 24));

  // Net edge per Kalshi fill (one leg):
  //   earn: kalshi half-spread + funding carry
  //   pay:  HL hedge cost + kalshi maker fee
  const netEdgePerFillBps = kalshiEarnBps + fundingCarryBps - hlHedgeCostBps - kalshiMakerFeeBps;
  const netEdgePerFillUsd = (netEdgePerFillBps / 10_000) * config.notionalUsd;

  // Minimum Kalshi spread needed to break even (ignoring funding)
  // solve: halfSpread - hlHedgeCost - kalshiMakerFee = 0
  const breakEvenKalshiSpreadBps = 2 * (hlHedgeCostBps + kalshiMakerFeeBps);

  // Spread ratio: how many times wider is Kalshi vs HL?
  const spreadRatio = hl.spreadBps > 0 ? kalshi.spreadBps / hl.spreadBps : NaN;

  return {
    viable: netEdgePerFillBps > 0,
    kalshiSpreadBps:        kalshi.spreadBps,
    kalshiHalfSpreadBps:    kalshi.halfSpreadBps,
    hlSpreadBps:            hl.spreadBps,
    hlHalfSpreadBps:        hl.halfSpreadBps,
    spreadRatio,
    kalshiEarnBps,
    hlTakerFeeBps,
    hlSlippageBps,
    hlHedgeCostBps,
    kalshiMakerFeeBps,
    hlAnnualFundingPct,
    kalshiAnnualFundingPct,
    netAnnualFundingPct,
    fundingCarryBps,
    netEdgePerFillBps,
    netEdgePerFillUsd,
    breakEvenKalshiSpreadBps,
    assumedHoldingHours: holdingHours,
  };
}

module.exports = { computeSpread, record, rollingStats, evaluateMMThesis };
