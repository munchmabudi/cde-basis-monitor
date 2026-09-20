// analysis/edge.js
//
// Pure functions, no I/O. Given two venue snapshots (from venues/*.js,
// all normalized to the same shape), compute whether there's a tradeable
// edge and how big it is.

const config = require('../config');

/**
 * Walk the order book to estimate the average fill price for a given
 * notional size, rather than just using the top-of-book quote. This
 * matters: a $25k order against a book with $3k at the touch will get
 * materially worse fills than the quoted price suggests.
 *
 * @param {Array<{price:number, qty:number}>} levels - bids or asks, best price first
 * @param {number} notionalUsd - dollar size to fill
 * @returns {{avgPrice: number, filledNotional: number, fullyFilled: boolean}}
 */
function estimateAvgFillPrice(levels, notionalUsd) {
  let qtyFilled = 0;
  let filledNotional = 0;
  let remaining = notionalUsd;

  for (const level of levels) {
    const levelNotional = level.price * level.qty;
    const take = Math.min(remaining, levelNotional);
    qtyFilled += take / level.price;
    filledNotional += take;
    remaining -= take;
    if (remaining <= 0) break;
  }

  return {
    avgPrice: qtyFilled > 0 ? filledNotional / qtyFilled : NaN,
    filledNotional,
    fullyFilled: remaining <= 0,
  };
}

/**
 * Normalize a venue's funding rate to an annualized percentage, so
 * venues with different funding intervals (Binance/Kalshi 8h vs
 * Hyperliquid 1h) are directly comparable.
 */
function annualizedFundingPct(snapshot) {
  const periodsPerYear = (365 * 24) / snapshot.fundingIntervalHours;
  return snapshot.fundingRate * periodsPerYear * 100;
}

/**
 * Core comparison: given two venue snapshots, compute the full economics
 * of entering both legs now: go LONG the cheaper venue, SHORT the more
 * expensive venue (classic basis/funding-carry trade), including
 * slippage against real depth and both venues' fees.
 */
function evaluatePair(venueA, venueB, opts = {}) {
  const notional = opts.notionalUsd ?? config.notionalUsd;
  const holdingHours = opts.assumedHoldingHours ?? config.assumedHoldingHours;

  const midA = (venueA.bestBid + venueA.bestAsk) / 2;
  const midB = (venueB.bestBid + venueB.bestAsk) / 2;

  const [longVenue, shortVenue] = midA <= midB ? [venueA, venueB] : [venueB, venueA];

  // Entry costs: buying on longVenue means walking the ASK side;
  // shorting on shortVenue means selling into the BID side.
  const longFill = estimateAvgFillPrice(longVenue.asks, notional);
  const shortFill = estimateAvgFillPrice(shortVenue.bids, notional);

  if (!longFill.fullyFilled || !shortFill.fullyFilled) {
    return {
      tradeable: false,
      reason: 'insufficient_liquidity',
      longVenue: longVenue.venue,
      shortVenue: shortVenue.venue,
      longFill,
      shortFill,
    };
  }

  // Price edge: how much cheaper is the long entry vs the short entry,
  // as a fraction of notional. Positive = you're buying low, selling high.
  const priceEdgeBps = ((shortFill.avgPrice - longFill.avgPrice) / longFill.avgPrice) * 10_000;

  // Fee cost: taker fee on both legs by default (assume you need
  // immediacy to capture the opportunity - if willing to use maker
  // orders, pass opts.feeType per venue, but resting orders risk the
  // edge disappearing before you fill).
  const feeTypeLong = opts.feeType?.[longVenue.venue] ?? 'taker';
  const feeTypeShort = opts.feeType?.[shortVenue.venue] ?? 'taker';
  const longFeeBps = config.fees[longVenue.venue][feeTypeLong] * 10_000;
  const shortFeeBps = config.fees[shortVenue.venue][feeTypeShort] * 10_000;
  const totalEntryFeeBps = longFeeBps + shortFeeBps;

  // Funding edge: as the long, you PAY funding if it's positive; as the
  // short, you RECEIVE funding if it's positive. Net funding P&L per
  // period is (shortVenueFunding - longVenueFunding). Annualize both,
  // then scale to the assumed holding period.
  const longAnnualFundingPct = annualizedFundingPct(longVenue);
  const shortAnnualFundingPct = annualizedFundingPct(shortVenue);
  const netAnnualFundingPct = shortAnnualFundingPct - longAnnualFundingPct;
  const fundingEdgeBpsOverHolding =
    netAnnualFundingPct * 100 * (holdingHours / (365 * 24)); // pct -> bps, scaled to holding window

  // Net edge = entry price discrepancy + expected funding carry over the
  // holding period - round-trip fees (entry + an equivalent estimate for
  // exit, since closing both legs costs roughly the same in fees/slippage).
  const estimatedExitCostBps = totalEntryFeeBps; // conservative floor estimate
  const netEdgeBps =
    priceEdgeBps + fundingEdgeBpsOverHolding - totalEntryFeeBps - estimatedExitCostBps;

  const netEdgeUsd = (netEdgeBps / 10_000) * notional;

  return {
    tradeable: true,
    longVenue: longVenue.venue,
    shortVenue: shortVenue.venue,
    notionalUsd: notional,
    assumedHoldingHours: holdingHours,
    longFill,
    shortFill,
    priceEdgeBps,
    longAnnualFundingPct,
    shortAnnualFundingPct,
    netAnnualFundingPct,
    fundingEdgeBpsOverHolding,
    entryFeeBps: totalEntryFeeBps,
    estimatedExitCostBps,
    netEdgeBps,
    netEdgeUsd,
    aboveThreshold: netEdgeBps >= config.alertThresholdBps,
  };
}

module.exports = { estimateAvgFillPrice, annualizedFundingPct, evaluatePair };
