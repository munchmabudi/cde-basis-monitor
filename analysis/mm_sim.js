// analysis/mm_sim.js
// Five scenarios. Notional is asset-specific (passed in from config.assets[x].notionalUsd).
// Scenario C is always half the base notional regardless of asset.
//
// Scenario A: ±4bps,  full notional,  5bps Kalshi maker fee
// Scenario B: ±8bps,  full notional,  5bps Kalshi maker fee
// Scenario C: ±4bps,  half notional,  5bps Kalshi maker fee
// Scenario D: ±4bps,  full notional,  0bps Kalshi maker fee
// Scenario E: ±8bps,  full notional,  0bps Kalshi maker fee

const config = require('../config');

function walkBook(levels, notionalUsd) {
  let remaining=notionalUsd, qtyFilled=0, notionalFilled=0;
  for (const level of levels) {
    const take = Math.min(remaining, level.price * level.qty);
    qtyFilled      += take / level.price;
    notionalFilled += take;
    remaining      -= take;
    if (remaining <= 0) break;
  }
  return {
    avgPrice:         qtyFilled > 0 ? notionalFilled / qtyFilled : NaN,
    notionalFilled,
    notionalUnfilled: Math.max(0, remaining),
    fullyFilled:      remaining <= 0,
  };
}

function evaluateScenario(kalshiSnap, hlSnap, params) {
  const { halfSpreadBps, notional, kalshiMakerFee } = params;
  const hlTakerFee = config.fees.hyperliquid.taker;

  const kalshiMid     = (kalshiSnap.bestBid + kalshiSnap.bestAsk) / 2;
  const kalshiBidPost = kalshiMid * (1 - halfSpreadBps / 10_000);
  const kalshiAskPost = kalshiMid * (1 + halfSpreadBps / 10_000);

  function calcLeg(kalshiFillPrice, hlFill, direction) {
    const hlFillPrice = hlFill.avgPrice;
    const priceEdgePerBtc = direction === 'bid'
      ? hlFillPrice - kalshiFillPrice
      : kalshiFillPrice - hlFillPrice;
    const priceEdgeBps = (priceEdgePerBtc / kalshiFillPrice) * 10_000;
    const priceEdgeUsd = priceEdgePerBtc * (notional / kalshiFillPrice);
    const kalshiFeeUsd = kalshiMakerFee * notional;
    const hlFeeUsd     = hlTakerFee     * notional;
    const totalFeeUsd  = kalshiFeeUsd + hlFeeUsd;
    const netUsd       = priceEdgeUsd - totalFeeUsd;
    const netBps       = priceEdgeBps - (kalshiMakerFee + hlTakerFee) * 10_000;
    return {
      kalshiFillPrice,
      hlAvgFillPrice:     hlFillPrice,
      notionalFilled:     hlFill.notionalFilled,
      notionalUnfilled:   hlFill.notionalUnfilled,
      hlFullyFilled:      hlFill.fullyFilled,
      priceEdgeBps,
      priceEdgeUsd,
      kalshiMakerFeeBps:  kalshiMakerFee * 10_000,
      kalshiMakerFeeUsd:  kalshiFeeUsd,
      hlTakerFeeBps:      hlTakerFee * 10_000,
      hlTakerFeeUsd:      hlFeeUsd,
      netBps,
      netUsd,
      profitable: netUsd > 0,
    };
  }

  const hlBidFill = walkBook(hlSnap.bids, notional);
  const hlAskFill = walkBook(hlSnap.asks, notional);
  const bidFill   = calcLeg(kalshiBidPost, hlBidFill, 'bid');
  const askFill   = calcLeg(kalshiAskPost, hlAskFill, 'ask');

  return {
    halfSpreadBps,
    notional,
    kalshiMakerFeeBps:  kalshiMakerFee * 10_000,
    kalshiMid,
    kalshiBidPost,
    kalshiAskPost,
    bidFill,
    askFill,
    bothProfitable:   bidFill.profitable && askFill.profitable,
    eitherProfitable: bidFill.profitable || askFill.profitable,
  };
}

function simulate(kalshiSnap, hlSnap, assetNotional) {
  // assetNotional: from config.assets[x].notionalUsd (25k for HYPE/XRP, 75k for others)
  const full = assetNotional ?? 75_000;
  const half = full / 2;

  const kalshiMid = (kalshiSnap.bestBid + kalshiSnap.bestAsk) / 2;

  return {
    kalshiMid,
    kalshiCurrentBid: kalshiSnap.bestBid,
    kalshiCurrentAsk: kalshiSnap.bestAsk,
    hlCurrentBid:     hlSnap.bestBid,
    hlCurrentAsk:     hlSnap.bestAsk,
    timestamp:        new Date().toISOString(),

    // A: ±4bps, full size, 5bps maker
    scenarioA: evaluateScenario(kalshiSnap, hlSnap, {
      halfSpreadBps: 4, notional: full, kalshiMakerFee: config.fees.kalshi.maker,
    }),
    // B: ±8bps, full size, 5bps maker
    scenarioB: evaluateScenario(kalshiSnap, hlSnap, {
      halfSpreadBps: 8, notional: full, kalshiMakerFee: config.fees.kalshi.maker,
    }),
    // C: ±4bps, HALF size, 5bps maker
    scenarioC: evaluateScenario(kalshiSnap, hlSnap, {
      halfSpreadBps: 4, notional: half, kalshiMakerFee: config.fees.kalshi.maker,
    }),
    // D: ±4bps, full size, 0bps maker
    scenarioD: evaluateScenario(kalshiSnap, hlSnap, {
      halfSpreadBps: 4, notional: full, kalshiMakerFee: 0,
    }),
    // E: ±8bps, full size, 0bps maker
    scenarioE: evaluateScenario(kalshiSnap, hlSnap, {
      halfSpreadBps: 8, notional: full, kalshiMakerFee: 0,
    }),
    // F: ±10bps, $10k, 5bps maker (LTC/LINK/BCH criteria)
    scenarioF: evaluateScenario(kalshiSnap, hlSnap, {
      halfSpreadBps: 10, notional: 10_000, kalshiMakerFee: config.fees.kalshi.maker,
    }),
    // G: ±10bps, $10k, 0bps maker (LTC/LINK/BCH criteria, fee waiver)
    scenarioG: evaluateScenario(kalshiSnap, hlSnap, {
      halfSpreadBps: 10, notional: 10_000, kalshiMakerFee: 0,
    }),
  };
}

module.exports = { simulate, walkBook, evaluateScenario };
