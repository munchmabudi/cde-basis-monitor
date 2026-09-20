// analysis/mm_sim_cde.js
// CDE MM SIM — mirrors analysis/mm_sim.js but for Coinbase Derivatives (CDE).
//
// Model (CDE MM SIM — standalone; fee = $0.02 per CDE contract traded, from config.cde.feePerContractUsd):
//   - We post a CDE bid/ask at  refMid ∓ width  around the REFERENCE venue mid
//     (default Hyperliquid, fallback Coinbase spot) and ASSUME we fill the full
//     size at that price. The CDE book itself is never fetched/walked.
//   - We hedge by walking one of several HEDGE venue books (perps + optional
//     futures venue), choosing the cheapest fully-filling venue per leg.
//
// Per-token parameters come from config.cde.assets (width bps, size in CDE
// contracts, CDE contract multiplier = underlying units per contract).
// Notional USD = sizeContracts × multiplier × refMid  (already a whole number
// of CDE contracts, so no further rounding is needed).
//
// Fee sweep: a single fixed width W (each side W/2) at the CDE flat maker fee
// (config.cde.feePerContractUsd per CDE contract traded).
// No 2W stress: the CDE width is fixed and never widened.
//
// No CDE API key or CDE order book is required.

const config = require('../config');
const { walkBook } = require('./mm_sim');

// Pick the best hedge venue for one leg.
//   side 'bid' => we BOUGHT CDE, hedge by SELLING into hedge bids
//   side 'ask' => we SOLD  CDE, hedge by BUYING  hedge asks
function bestHedge(side, refPostPrice, notional, hedgeSnaps, cdeFeeUsdPerContract, cdeContractSize) {
  let best = null;
  for (const h of hedgeSnaps) {
    const levels = side === 'bid' ? h.bids : h.asks;
    const fill = walkBook(levels, notional);
    const takerFee = (config.fees[h.venue] && config.fees[h.venue].taker) || 0;

    const hedgePrice = fill.avgPrice;
    const priceEdgePerUnit = side === 'bid' ? hedgePrice - refPostPrice
                                            : refPostPrice - hedgePrice;
    const priceEdgeBps = (priceEdgePerUnit / refPostPrice) * 1e4;
    const priceEdgeUsd = priceEdgePerUnit * (notional / refPostPrice);

    // CDE flat fee: $feePerContract per CDE contract traded, one side.
    const cdeFeeUsd   = cdeFeeUsdPerContract * cdeContractSize;
    const hedgeFeeUsd = takerFee * notional;
    const netUsd      = priceEdgeUsd - cdeFeeUsd - hedgeFeeUsd;
    const netBps      = priceEdgeBps - (cdeFeeUsd / notional * 1e4) - (takerFee * 1e4);

    const cand = {
      venue: h.venue,
      hedgePrice,
      notionalFilled:   fill.notionalFilled,
      notionalUnfilled: fill.notionalUnfilled,
      fullyFilled:     fill.fullyFilled,
      priceEdgeBps, priceEdgeUsd,
      cdeFeeUsd, hedgeFeeUsd,
      netBps, netUsd,
      profitable: netUsd > 0,
    };

    if (!best) { best = cand; continue; }
    // rank: fully-filled first, then higher net
    if (cand.fullyFilled && !best.fullyFilled) best = cand;
    else if (cand.fullyFilled === best.fullyFilled && cand.netUsd > best.netUsd) best = cand;
  }
  return best;
}

function evaluateScenarioCDE(refSnap, hedgeSnaps, params) {
  const { halfSpreadBps, notional, cdeFeeUsdPerContract, cdeContractSize } = params;
  const refMid     = (refSnap.bestBid + refSnap.bestAsk) / 2;
  const cdeBidPost = refMid * (1 - halfSpreadBps / 1e4);
  const cdeAskPost = refMid * (1 + halfSpreadBps / 1e4);

  // Notional is already an exact whole number of CDE contracts
  // (sizeContracts × multiplier × refMid), so no further rounding needed.
  const actualNotional = notional;

  const bidFill = bestHedge('bid', cdeBidPost, actualNotional, hedgeSnaps, cdeFeeUsdPerContract, cdeContractSize);
  const askFill = bestHedge('ask', cdeAskPost, actualNotional, hedgeSnaps, cdeFeeUsdPerContract, cdeContractSize);

  const noHedge = !bidFill || !askFill;

  return {
    halfSpreadBps, notional, actualNotional, cdeContracts: cdeContractSize, cdeContractSize, cdeFeeUsdPerContract,
    refMid, cdeBidPost, cdeAskPost,
    bidFill, askFill,
    noHedge,
    bothProfitable:   !noHedge && bidFill.profitable && askFill.profitable,
    eitherProfitable: !noHedge && (bidFill.profitable || askFill.profitable),
  };
}

function simulateCDE(refSnap, hedgeSnaps, cdeCfg) {
  const refMid    = (refSnap.bestBid + refSnap.bestAsk) / 2;
  const mult      = cdeCfg.multiplier;
  const contracts = cdeCfg.sizeContracts;
  const W         = cdeCfg.widthBps;
  const feePerCtr = cdeCfg.feePerContractUsd ?? config.cde.feePerContractUsd;
  const size      = mult; // for whole-contract reporting (= multiplier)

  const notional  = contracts * mult * refMid;
  const mk = (halfSpreadBps, feePerContract) => ({ halfSpreadBps, notional, cdeFeeUsdPerContract: feePerContract, cdeContractSize: contracts });

  // Hedge pool = supplied snapshots MINUS coinbase_spot, which is purely a
  // reference-mid FALLBACK with no walkable order book (never a real hedge).
  // NOTE: we do NOT exclude the reference venue — it has a real book and can
  // serve as both the price anchor AND a hedge leg (e.g. HL mid + HL hedge).
  // Excluding it would leave HL-anchored alts with only Lighter, so a single
  // Lighter outage would zero them out despite HL being up.
  const hedge = hedgeSnaps.filter(h => h.venue !== 'coinbase_spot');

  return {
    refVenue:       refSnap.venue,
    refSymbol:      refSnap.symbol || refSnap.venue,
    refMid,
    hedgeVenues:    hedge.map(h => h.venue),
    multiplier:     mult,
    sizeContracts:  contracts,
    notional,
    cdeFullContracts: contracts,
    cdeFullActualNotional: notional,
    timestamp:      new Date().toISOString(),

    // Single scenario: total width W (half W/2), full size, CDE flat fee $/contract.
    scenarioA: evaluateScenarioCDE(refSnap, hedge, mk(W / 2, feePerCtr)),
  };
}

module.exports = { simulateCDE, evaluateScenarioCDE, bestHedge };
